// The stakeholder dashboard at the top of the main PR (docs/design.md, "Dashboard"). Pure: no
// I/O and no clock. The CLI passes the ledger, the live GitHub snapshot (null when offline), the
// ledger history (newest first) and the time, then wraps render()'s markdown in the collab markers.
//
// Every string that comes from people or agents (titles, reasons, ids, logins) goes through md()
// so it can't break a table, open a link or smuggle in HTML or a collab marker.

import { human } from "./clock.mjs";
import { intersect } from "./glob.mjs";
import { VENDORS, derive, isTerminal, taskIds, vendorOf } from "./ledger.mjs";

const MAX_CHARS = 10_000;
const MANY_TASKS = 15;
const FREEZE_BLOCK_MIN = 60;
const REASON_MAX = 200;
const TITLE_MAX = 80;

const STATUS = Object.freeze({
  planning: { emoji: "⚪", label: "Planning" },
  paused: { emoji: "⏸️", label: "Paused" },
  closed: { emoji: "⚫", label: "Closed" },
  merged: { emoji: "🟣", label: "Merged" },
  ready: { emoji: "🔵", label: "Ready for owner review" },
  blocked: { emoji: "🔴", label: "Blocked" },
  idle: { emoji: "⚪", label: "No active agents" },
  "at-risk": { emoji: "🟡", label: "At risk" },
  "on-track": { emoji: "🟢", label: "On track" },
});

const TOOL_NAMES = { claude: "Claude Code", codex: "Codex", gemini: "Gemini CLI", grok: "Grok Build", other: "other" };
const VENDOR_NAMES = { anthropic: "Anthropic", openai: "OpenAI", google: "Google", xai: "xAI", other: "unknown vendor" };

const TASK_STATUS = {
  open: "⚪ Open",
  claimed: "📌 Claimed",
  progress: "🔨 In progress",
  in_review: "👀 In review",
  changes_requested: "✏️ Changes requested",
  approved: "👍 Approved",
  done: "✅ Done",
  cancelled: "🚫 Cancelled",
};
const BLOCKED_TAG = "⛔ blocked";
const STALE_TAG = "⏰ stale";

const MAIN_CI = { SUCCESS: "✅ Passed", FAILURE: "❌ Failed", PENDING: "⏳ Running", NONE: "⚪ No checks", UNKNOWN: "❔ Unknown" };
const MERGEABLE = { MERGEABLE: "yes", CONFLICTING: "no, it has conflicts", UNKNOWN: "unknown (GitHub is still checking)" };

const IN_FLIGHT = new Set(["claimed", "changes_requested", "in_review", "approved"]);
// Housekeeping events that mean nothing to a stakeholder.
const QUIET = new Set(["agent.seen", "comments.seen", "notice.sent", "task.lease"]);

const TASK_HEAD = "| Task | Title | Status | Owner | Sub-PR | Reviewer | CI |\n|---|---|---|---|---|---|---|";
const AGENT_HEAD = "| Agent | Tool and vendor | Working on | Tasks done | Reviews given | Last seen |\n|---|---|---|---|---|---|";

// ---------------------------------------------------------------- small helpers

const ms = (t) => (t instanceof Date ? t.getTime() : typeof t === "number" ? t : Date.parse(t));
const okTime = (t) => t != null && t !== "" && Number.isFinite(ms(t));
const when = (t) => (okTime(t) ? human(new Date(ms(t))) : "an unknown time");
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const waited = (hours) => (hours >= 1 ? `over ${plural(Math.floor(hours), "hour")}` : plural(Math.floor(hours * 60), "minute"));

// Untrusted text for inline markdown and table cells: one line, no HTML, no links, no table breaks.
function md(value) {
  return String(value ?? "")
    .replace(/[\r\n\t\v\f\u2028\u2029]+/g, " ")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\\`*_[\]|]/g, (c) => `\\${c}`)
    .replace(/</g, "&lt;")
    .replace(/ {2,}/g, " ")
    .trim();
}

// Shortens to n code points (never splitting an emoji) after folding whitespace.
function cut(value, n) {
  const s = String(value ?? "").replace(/\s+/g, " ").trim();
  const cps = [...s];
  return cps.length > n ? `${cps.slice(0, n - 1).join("").trimEnd()}…` : s;
}

const text = (value, n) => md(n ? cut(value, n) : value);
// Task ids and branch names inside code spans, where escapes don't work: drop what could break out.
const safeId = (id) => String(id ?? "").replace(/[^A-Za-z0-9._-]/g, "");
const code = (s) => `\`${String(s ?? "").replace(/[`<>\s]/g, "") || "?"}\``;
const safeUrl = (u) => (typeof u === "string" && /^https:\/\/[^\s<>()[\]`"'\\]+$/.test(u) ? u : null);

function toolName(tool) {
  return Object.hasOwn(VENDORS, tool) ? TOOL_NAMES[tool] ?? "other" : "other";
}
function vendorName(agent) {
  const v = agent?.vendor ?? vendorOf(agent?.tool);
  return VENDOR_NAMES[v] ?? md(v);
}
function agentLabel(L, id) {
  if (!id) return "none";
  if (id === "owner") return "owner";
  const ag = L.agents?.[id];
  return ag ? `${md(id)} (${toolName(ag.tool)})` : md(id);
}

function ciOf(value) {
  switch (value) {
    case "SUCCESS": return "SUCCESS";
    case "FAILURE": case "ERROR": return "FAILURE";
    case "PENDING": case "EXPECTED": return "PENDING";
    case "NONE": return "NONE";
    default: return "UNKNOWN";
  }
}

// Accepts the CLI's flattened snapshot or github.liveSnapshot's shape. null means offline.
function readLive(live) {
  if (!live || live.ok === false) return null;
  const main = live.main ?? {};
  const state = String(live.mainState ?? main.state ?? "").toUpperCase();
  const num = (x) => (x == null || x === "" || !Number.isFinite(Number(x)) ? null : Number(x));
  return {
    mainCi: ciOf(live.mainCi ?? main.ci),
    mainMergeable: live.mainMergeable ?? main.mergeable ?? "UNKNOWN",
    mainState: main.merged === true ? "MERGED" : state || null,
    mainHeadSha: live.mainHeadSha ?? main.headSha ?? null,
    additions: num(live.additions ?? main.additions),
    deletions: num(live.deletions ?? main.deletions),
    subs: live.subs ?? {},
  };
}

// A sub-PR snapshot taken at another head SHA says nothing about the current CI or conflicts.
function subOf(lv, id, t) {
  const s = lv?.subs?.[id];
  if (!s) return null;
  const moved = s.headSha && t.headSha && s.headSha !== t.headSha;
  return {
    state: String(s.state ?? "").toUpperCase() || null,
    merged: s.merged === true,
    draft: s.draft === true,
    ci: moved ? "UNKNOWN" : ciOf(s.ci),
    mergeable: moved ? "UNKNOWN" : s.mergeable ?? "UNKNOWN",
  };
}

const passingVerify = (t, sha) => !!sha && (t.verify ?? []).some((v) => v.ok === true && v.sha === sha);
// What a claim with --allow-overlap accepted ("T1 (codex-ab12): files"), without the tasks that
// have finished since: the warning is only worth showing while both are in flight.
// The owner named is the one who holds that task now, not the one at claim time.
const liveOverlap = (L, t) => (Array.isArray(t.overlap) ? t.overlap : []).map(String).filter((o) => {
  const id = /^(T\d+)\b/.exec(o)?.[1];
  return !id || IN_FLIGHT.has(L.tasks?.[id]?.status);
}).map((o) => o.replace(/^(T\d+) \([^)]*\)/, (m, id) => (L.tasks?.[id]?.owner ? `${id} (${L.tasks[id].owner})` : m)));

// ---------------------------------------------------------------- analysis (shared by status and render)

function analyze(L, live, now) {
  if (!L || typeof L !== "object") throw new TypeError("dashboard needs a ledger");
  const at = ms(now);
  const lv = readLive(live);
  const d = derive(L, now);
  const alertH = Number(L.config?.reviewAlertH ?? 2);
  const T = L.tasks ?? {};

  const rows = taskIds(L).map((id) => {
    const t = T[id];
    const dt = d.tasks[id] ?? {};
    const terminal = isTerminal(t.status);
    const sub = subOf(lv, id, t);
    const submitted = t.times?.submitted;
    const waitH = t.status === "in_review" && okTime(submitted) ? (at - ms(submitted)) / 3_600_000 : null;
    return {
      id, t, terminal, sub,
      inProgress: !!dt.inProgress,
      stale: !terminal && !!dt.stale,
      needsOwner: !terminal && t.blocked?.needsOwner === true,
      agentBlocked: !terminal && !!t.blocked && t.blocked.needsOwner !== true,
      redCi: !terminal && sub?.ci === "FAILURE",
      conflict: !terminal && sub?.mergeable === "CONFLICTING",
      noReviewer: t.status === "in_review" && (dt.eligibleReviewers ?? []).length === 0,
      waitH,
      slowReview: waitH != null && waitH > alertH,
      manyRounds: !terminal && (t.changeRounds ?? 0) >= 3,
      claimOverlap: IN_FLIGHT.has(t.status) && liveOverlap(L, t).length > 0,
    };
  });

  // Files one in-flight task changed that another in-flight task also covers.
  const flight = rows.filter((r) => IN_FLIGHT.has(r.t.status));
  const overlaps = [];
  for (let i = 0; i < flight.length; i++) {
    for (let j = i + 1; j < flight.length; j++) {
      const a = flight[i].t;
      const b = flight[j].t;
      const touched = new Set([...(a.touched ?? []), ...(b.touched ?? [])]);
      if (!touched.size) continue;
      const files = intersect(a.scope ?? [], a.touched ?? [], b.scope ?? [], b.touched ?? [], []).filter((f) => touched.has(f));
      if (files.length) overlaps.push({ a: flight[i], b: flight[j], files });
    }
  }

  // The merge freeze has lasted as long as the oldest fix-ci task still covering the red head.
  let freezeSince = null;
  let fixTask = null;
  if (lv?.mainCi === "FAILURE") {
    const fix = rows.filter((r) => r.t.kind === "fix-ci" && (!r.terminal || (lv.mainHeadSha && r.t.forSha === lv.mainHeadSha)));
    const times = fix.map((r) => ms(r.t.times?.reopened ?? r.t.times?.created)).filter(Number.isFinite);
    if (times.length) freezeSince = Math.min(...times);
    fixTask = fix.find((r) => !r.terminal && lv.mainHeadSha && r.t.forSha === lv.mainHeadSha) ?? fix.find((r) => !r.terminal) ?? null;
  }
  const freezeLong = freezeSince != null && at - freezeSince > FREEZE_BLOCK_MIN * 60_000;

  const a = { L, lv, d, at, rows, overlaps, freezeSince, freezeLong, fixTask, alertH };
  a.key = keyOf(a);
  return a;
}

function keyOf(a) {
  const { L, lv, rows } = a;
  if (lv?.mainState === "MERGED") return "merged";
  if (L.phase === "closed" || lv?.mainState === "CLOSED") return "closed";
  if (L.phase === "paused") return "paused";
  if (L.phase === "planning") return "planning";
  const allTerminal = rows.every((r) => r.terminal);
  const ready = L.phase === "active" && !!lv && rows.length > 0 && allTerminal
    && rows.some((r) => r.t.status === "done")
    && (lv.mainCi === "SUCCESS" || lv.mainCi === "NONE")
    && lv.mainMergeable === "MERGEABLE"
    && !rows.some((r) => r.needsOwner);
  if (ready) return "ready";
  if (rows.some((r) => r.needsOwner || r.noReviewer) || lv?.mainMergeable === "CONFLICTING" || a.freezeLong) return "blocked";
  if (!allTerminal && !a.d.nextLeaseExpiry) return "idle";
  if (rows.some((r) => r.stale || r.redCi || r.slowReview || r.manyRounds || r.claimOverlap) || a.overlaps.length) return "at-risk";
  return "on-track";
}

const statusOf = (key) => ({ key, ...STATUS[key] });

// ---------------------------------------------------------------- public API

export function status(ledger, live, now) {
  return statusOf(analyze(ledger, live, now).key);
}

export function render(ledger, live, history, now, { prUrl } = {}) {
  const a = analyze(ledger, live, now);
  const url = safeUrl(prUrl) ?? safeUrl(ledger.pr?.url);
  const full = compose(a, history, now, url, false);
  return full.length <= MAX_CHARS ? full : compose(a, history, now, url, true);
}

export function renderCollapsed(ledger, reportUrl, now) {
  const s = STATUS.ready;
  const done = Object.values(ledger?.tasks ?? {}).filter((t) => t.status === "done").length;
  const what = done === 1 ? "The only task is" : `All ${done} tasks are`;
  const url = safeUrl(reportUrl);
  const link = url ? `[Final collab report](${url})` : "The final collab report link is unavailable.";
  return `## Agent collaboration: ${s.emoji} ${s.label} (as of ${when(now)})\n\n${what} done and merged into ${code(ledger?.pr?.headRef)}. ${link}`;
}

// ---------------------------------------------------------------- sections

function compose(a, history, now, prUrl, fold) {
  const s = STATUS[a.key];
  const parts = [
    `## Agent collaboration: ${s.emoji} ${s.label} (as of ${when(now)})`,
    nextUpdate(a),
    ...summary(a),
    needsAttention(a, prUrl),
    tasksSection(a, fold),
    agentsSection(a, fold),
  ];
  if (!fold) {
    const act = activity(history, now);
    if (act) parts.push(act);
  }
  parts.push(footer(a.L, now));
  return parts.join("\n\n");
}

function nextUpdate(a) {
  const expiry = a.d.nextLeaseExpiry;
  if (["closed", "merged", "paused"].includes(a.key) || !expiry) return "No agent is working right now.";
  // The earliest live lease: some agent's next collab command, and so a re-render, is due by then.
  return `Next update expected by ${when(expiry)}. If that time has passed, the agents have stopped.`;
}

const BUCKETS = ["approved", "in review", "changes requested", "in progress", "claimed", "open", "blocked"];

function summary(a) {
  const { L, rows, lv } = a;
  const agents = Object.values(L.agents ?? {});
  const vendors = new Set(agents.map((x) => x.vendor ?? vendorOf(x.tool)));
  const who = `${plural(agents.length, "agent")} from ${plural(vendors.size, "vendor")}.`;
  let first;
  if (!rows.length) {
    const p = L.planner;
    first = L.phase === "planning" && p?.agent ? `**No tasks yet.** ${md(p.agent)} is writing the plan. ${who}` : `**No tasks yet.** ${who}`;
  } else {
    const counted = rows.filter((r) => r.t.status !== "cancelled");
    const done = counted.filter((r) => r.t.status === "done").length;
    const pct = counted.length ? Math.floor((done * 100) / counted.length) : 0;
    const count = new Map(BUCKETS.map((b) => [b, 0]));
    for (const r of rows) {
      if (r.terminal) continue;
      const b = r.t.blocked ? "blocked" : r.t.status === "claimed" && r.inProgress ? "in progress" : r.t.status.replace(/_/g, " ");
      count.set(b, (count.get(b) ?? 0) + 1);
    }
    const stale = rows.filter((r) => r.stale).length;
    const cancelled = rows.length - counted.length;
    const parts = [...count].filter(([, n]) => n > 0).map(([b, n]) => `${n} ${md(b)}`);
    if (stale) parts.push(`${stale} stale`);
    if (cancelled) parts.push(`${cancelled} cancelled`);
    first = `**${done} of ${plural(counted.length, "task")} done (${pct}%).** ${parts.length ? `${parts.join(", ")}. ` : ""}${who}`;
  }
  if (!lv) return [first, "Live GitHub data unavailable; showing the ledger only."];
  const second = [];
  if (lv.additions != null && lv.deletions != null) second.push(`PR: +${lv.additions} / −${lv.deletions} lines.`);
  second.push(`Main PR CI: ${MAIN_CI[lv.mainCi]}.`);
  second.push(`Mergeable: ${MERGEABLE[lv.mainMergeable] ?? "unknown"}.`);
  return [first, second.join(" ")];
}

// Most urgent first; each item starts with who acts.
function needsAttention(a, prUrl) {
  const { L, lv, rows, key } = a;
  const n = Number(L.pr?.number) || "<n>";
  const head = code(L.pr?.headRef);
  const base = code(L.pr?.baseRef);
  const items = [];
  const title = (r) => `${safeId(r.id)} (${text(r.t.title, TITLE_MAX)})`;
  const owner = (r) => (r.t.owner ? md(r.t.owner) : "Any agent");
  const act = !["closed", "merged"].includes(key);
  const directives = (L.directives ?? []).filter((x) => x && x.applied !== false);
  const lastPause = L.phase === "paused" ? directives.filter((x) => x.cmd === "pause").at(-1) : null;
  const link = (x) => (safeUrl(x.url) ? ` ([comment](${safeUrl(x.url)}))` : "");

  if (key === "ready") items.push(`**Owner:** every task is merged into ${head}. Review the main PR and merge it when you are happy with it.`);
  if (L.phase === "paused") {
    items.push(lastPause
      ? `**Owner:** the collab is paused by a \`/collab pause\` comment from ${md(lastPause.login ?? "someone")} on ${when(lastPause.at)}${link(lastPause)}. Resume in your own terminal: \`collab resume --pr ${n}\`.`
      : `**Owner:** the collab is paused. Resume in your own terminal: \`collab resume --pr ${n}\`.`);
  }
  if (act && L.phase === "planning" && L.planner?.agent && okTime(L.planner.leaseUntil) && ms(L.planner.leaseUntil) < a.at) {
    items.push(`**Any agent:** ${md(L.planner.agent)}'s planner lease ran out at ${when(L.planner.leaseUntil)}. The next agent to run \`collab next\` takes over the plan.`);
  }
  if (act) {
    for (const r of rows.filter((x) => x.needsOwner)) {
      const b = r.t.blocked;
      items.push(`**Owner:** decide on ${title(r)} by running \`collab decide ${safeId(r.id)} "<answer>" --pr ${n}\` in your own terminal. ${md(b.by ?? "An agent")} asked on ${when(b.since)}: "${text(b.reason, REASON_MAX)}"`);
    }
    if (lv?.mainMergeable === "CONFLICTING") {
      items.push(`**Owner:** the main PR has conflicts with ${base}. Merge ${base} into ${head}, or resolve the conflicts on GitHub.`);
    }
    if (lv?.mainCi === "FAILURE") {
      const since = a.freezeSince != null ? ` (frozen since ${when(a.freezeSince)}${a.freezeLong ? ", over an hour" : ""})` : "";
      const f = a.fixTask;
      if (f?.t.owner) items.push(`**${md(f.t.owner)}:** fix the main PR's failing CI in ${safeId(f.id)}; sub-PR merges are frozen until it passes${since}.`);
      else if (f) items.push(`**Any agent:** claim ${safeId(f.id)} to fix the main PR's failing CI; sub-PR merges are frozen until it passes${since}.`);
      else items.push(`**Any agent:** the main PR's CI is failing, so sub-PR merges are frozen. The next \`collab next\` adds a task to fix it.`);
    }
    for (const r of rows.filter((x) => x.noReviewer)) {
      items.push(`**Owner:** ${title(r)} waits for a review, but no agent from another vendor has joined. Invite an agent from another vendor, or the owner can run \`collab waive-review ${safeId(r.id)} --pr ${n}\` in their own terminal.`);
    }
    if (key === "idle") {
      const left = rows.filter((r) => !r.terminal).length;
      const where = prUrl ?? `#${n}`;
      items.push(`**Owner:** no agent is working, and ${plural(left, "task")} ${left === 1 ? "is" : "are"} not finished. Restart an agent: paste \`/collab ${where}\` into Claude Code or \`$collab ${where}\` into Codex.`);
    }
    for (const r of rows.filter((x) => x.stale)) {
      items.push(`**Any agent:** ${title(r)} is stale: ${owner(r)}'s lease ran out at ${when(r.t.leaseUntil)}. \`collab next\` hands it to another agent.`);
    }
    for (const r of rows.filter((x) => x.redCi)) {
      items.push(`**${owner(r)}:** CI is failing on ${safeId(r.id)}'s sub-PR #${Number(r.t.subPr) || "?"} (${text(r.t.title, TITLE_MAX)}). Fix it and run \`collab push ${safeId(r.id)}\`.`);
    }
    for (const r of rows.filter((x) => x.conflict)) {
      items.push(`**${owner(r)}:** ${safeId(r.id)}'s sub-PR #${Number(r.t.subPr) || "?"} conflicts with ${head}. Run \`collab sync ${safeId(r.id)}\` and resolve the conflicts.`);
    }
    for (const r of rows.filter((x) => x.slowReview && !x.noReviewer)) {
      const actor = r.t.reviewer ? `**${md(r.t.reviewer)}:** finish the review of` : "**An agent from another vendor:** review";
      items.push(`${actor} ${title(r)}. It has waited ${waited(r.waitH)} since ${when(r.t.times.submitted)}; the alert is at ${plural(a.alertH, "hour")}.`);
    }
    for (const r of rows.filter((x) => x.manyRounds)) {
      items.push(`**Owner:** ${title(r)} has been through ${Number(r.t.changeRounds)} rounds of changes. Consider stepping in to settle what the reviewers want.`);
    }
    for (const r of rows.filter((x) => x.claimOverlap)) {
      items.push(`**${owner(r)}:** ${title(r)} was claimed although its scope overlaps work in flight (${text(liveOverlap(a.L, r.t).join("; "), REASON_MAX)}). Coordinate before merging.`);
    }
    for (const o of a.overlaps) {
      const files = o.files.slice(0, 3).map((f) => md(f)).join(", ") + (o.files.length > 3 ? ` and ${o.files.length - 3} more` : "");
      const who = [...new Set([o.a.t.owner, o.b.t.owner].filter(Boolean))].map(md).join(" and ") || "Any agent";
      items.push(`**${who}:** ${safeId(o.a.id)} and ${safeId(o.b.id)} both change ${files}. Coordinate before merging.`);
    }
    for (const r of rows.filter((x) => x.agentBlocked)) {
      items.push(`**${owner(r)}:** ${title(r)} is blocked; unblock it with \`collab unblock ${safeId(r.id)}\` once it can go on. The reason given: "${text(r.t.blocked.reason, REASON_MAX)}"`);
    }
  }
  // Applied directives stay visible (Trust model), newest first.
  for (const x of [...directives].reverse()) {
    if (x === lastPause) continue;
    const by = md(x.login ?? "someone");
    if (x.cmd === "pause") items.push(`**Owner:** a \`/collab pause\` comment from ${by} paused the collab on ${when(x.at)}${link(x)}. Check that it was you.`);
    else items.push(`**Owner:** a \`/collab cancel ${safeId(x.task)}\` comment from ${by} cancelled ${safeId(x.task) || "a task"} on ${when(x.at)}${link(x)}. Check that it was you.`);
  }

  const body = items.length ? items.map((s, i) => `${i + 1}. ${s}`).join("\n") : "Nothing needs attention.";
  return `### Needs attention (${items.length})\n\n${body}`;
}

function taskRow(a, r) {
  const t = r.t;
  return `| ${safeId(r.id)} | ${text(t.title, TITLE_MAX)} | ${statusCell(r)} | ${agentLabel(a.L, t.owner)} | ${subCell(r)} | ${reviewerCell(a.L, t)} | ${ciCell(r)} |`;
}

function statusCell(r) {
  const t = r.t;
  const base = t.status === "claimed" && r.inProgress ? TASK_STATUS.progress : TASK_STATUS[t.status] ?? md(t.status);
  const tags = [];
  if (t.blocked && !r.terminal) tags.push(BLOCKED_TAG);
  if (r.stale) tags.push(STALE_TAG);
  return [base, ...tags].join(", ");
}

function subCell(r) {
  const t = r.t;
  if (!t.subPr) return "none";
  const n = `#${Number(t.subPr) || md(t.subPr)}`;
  if (t.merged || r.sub?.merged || r.sub?.state === "MERGED") return `${n}, merged`;
  if (r.sub?.state === "CLOSED") return `${n}, closed`;
  if (r.sub?.draft) return `${n}, draft`;
  return n;
}

function reviewerCell(L, t) {
  if (t.reviewer) return agentLabel(L, t.reviewer);
  const last = (t.reviews ?? []).at(-1);
  if (!last) return "none";
  return last.agent === "owner" ? "owner (review waived)" : agentLabel(L, last.agent);
}

function ciCell(r) {
  const t = r.t;
  if (t.status === "cancelled") return "Not run";
  switch (r.sub?.ci) {
    case "SUCCESS": return "✅ Passed";
    case "FAILURE": return "❌ Failed";
    case "PENDING": return "⏳ Running";
    case "NONE": return passingVerify(t, t.headSha) ? "✅ Verified locally (no checks)" : "No checks";
    default: break;
  }
  if (t.status === "done") return "✅ Passed"; // a merge needs green CI or a passing verify
  if (!t.headSha || !t.subPr) return "Not run";
  return "Unknown";
}

function folded(summaryText, table) {
  return `<details><summary>${summaryText}</summary>\n\n${table}\n\n</details>`;
}

function tasksSection(a, fold) {
  const { rows } = a;
  if (!rows.length) return "### Tasks\n\nNo tasks yet.";
  const many = rows.length > MANY_TASKS;
  const shown = many ? rows.filter((r) => r.t.status !== "done") : rows;
  const done = many ? rows.filter((r) => r.t.status === "done") : [];
  let out = "### Tasks\n\n";
  if (shown.length) {
    const table = [TASK_HEAD, ...shown.map((r) => taskRow(a, r))].join("\n");
    out += fold ? folded(`Task table (${plural(shown.length, "task")})`, table) : table;
  } else {
    out += "Every task is done.";
  }
  if (done.length) out += `\n\n${folded(`Done tasks (${done.length})`, [TASK_HEAD, ...done.map((r) => taskRow(a, r))].join("\n"))}`;
  return out;
}

function agentsSection(a, fold) {
  const { L, rows } = a;
  const ids = Object.keys(L.agents ?? {});
  if (!ids.length) return "### Agents\n\nNo agent has joined yet.";
  const lines = ids.map((id) => {
    const ag = L.agents[id];
    const work = [];
    if (L.phase === "planning" && L.planner?.agent === id) work.push("writing the plan");
    for (const r of rows) if (r.t.owner === id && !r.terminal) work.push(safeId(r.id));
    for (const r of rows) if (r.t.status === "in_review" && r.t.reviewer === id) work.push(`reviewing ${safeId(r.id)}`);
    const done = rows.filter((r) => r.t.owner === id && r.t.status === "done").length;
    const reviews = rows.reduce((sum, r) => sum + (r.t.reviews ?? []).filter((x) => x.agent === id).length, 0);
    return `| ${md(id)} | ${toolName(ag.tool)} (${vendorName(ag)}) | ${work.join(", ") || "nothing"} | ${done} | ${reviews} | ${when(ag.lastSeen)} |`;
  });
  const table = [AGENT_HEAD, ...lines].join("\n");
  return `### Agents\n\n${fold ? folded(`Agent table (${plural(ids.length, "agent")})`, table) : table}`;
}

// "16:02 UTC" for today (relative to now), the full date otherwise.
function clockOf(t, now) {
  if (!okTime(t)) return "time unknown";
  const full = when(t);
  return okTime(now) && full.slice(0, 10) === when(now).slice(0, 10) ? full.slice(11) : full;
}

// { actor, phrase } for one ledger event, or null to leave it out.
function describe(e) {
  const d = e.data && typeof e.data === "object" ? e.data : {};
  const task = safeId(e.task ?? d.task) || "a task";
  const actor = e.agent === "owner" ? "the owner" : md(e.agent ?? "someone") || "someone";
  const say = (phrase) => ({ actor, phrase });
  switch (e.type) {
    case "init": return say(`started the collab${Number(d.pr) ? ` on PR #${Number(d.pr)}` : ""}`);
    case "agent.join": return say(`joined with ${toolName(d.tool ?? "other")}`);
    case "planner.lease": return say("took the planner lease");
    case "plan": return say(`wrote the plan (${plural(Array.isArray(d.tasks) ? d.tasks.length : 0, "task")})`);
    case "task.add": return say(d.kind === "fix-ci" ? "added a task to fix the main PR's CI" : `added a task: ${text(d.title, TITLE_MAX)}`);
    case "task.claim": return say(d.steal ? `took over ${task}` : `claimed ${task}`);
    case "task.release": return say(`released ${task}`);
    case "task.push": return say(`pushed to ${task}`);
    case "task.verify": return say(`ran the tests on ${task}: ${d.ok === false ? "failed" : "passed"}`);
    case "task.submit": return say(`submitted ${task} for review`);
    case "review.claim": return say(`started reviewing ${task}`);
    case "review.verdict": return say(d.verdict === "changes" ? `requested changes on ${task}` : `approved ${task}`);
    case "task.merge": return say(`merged ${task}`);
    case "task.cancel": return say(`cancelled ${task}`);
    case "task.block": return say(d.needsOwner ? `asked the owner to decide on ${task}` : `marked ${task} blocked`);
    case "task.unblock": return say(d.decision != null ? `recorded a decision on ${task} and unblocked it` : `unblocked ${task}`);
    case "task.note": return say(`added a note to ${task}`);
    case "review.waive": return say(`waived the review of ${task}`);
    case "reviewer.expire": return say(`cleared the expired review lease on ${task}`);
    case "directive": {
      const by = md(d.login ?? "someone") || "someone";
      return { actor: by, phrase: d.cmd === "cancel" ? `cancelled ${task} with a PR comment` : "paused the collab with a PR comment" };
    }
    case "phase.set": {
      const verbs = { active: "resumed the collab", closed: "closed the collab", paused: "paused the collab", planning: "reopened planning" };
      return say(verbs[d.phase] ?? `set the phase to ${md(d.phase)}`);
    }
    default: return say(`recorded ${md(e.type)}${e.task ? ` on ${task}` : ""}`);
  }
}

function activity(history, now) {
  const lines = [];
  for (const h of Array.isArray(history) ? history : []) {
    const e = h?.event;
    if (!e || typeof e !== "object" || typeof e.type !== "string" || QUIET.has(e.type)) continue;
    const { actor, phrase } = describe(e);
    lines.push(`- ${clockOf(okTime(e.at) ? e.at : h.at, now)}: ${actor} ${phrase}`);
  }
  if (!lines.length) return null;
  return folded(`Recent activity (last ${plural(lines.length, "event")})`, lines.join("\n"));
}

function footer(L, now) {
  return `<sub>Updated ${when(now)} from ledger seq ${Number(L.seq) || 0}. Generated by collab; anything between the collab markers is overwritten. Owner: pause or cancel with a PR comment (\`/collab pause\`, \`/collab cancel T<n>\`); resume, decide and waive-review in your own terminal.</sub>`;
}

// ---------------------------------------------------------------- accessibility lint

const PICTO = /\p{Extended_Pictographic}/u;
const MODIFIER = /[\u{1F3FB}-\u{1F3FF}\uFE0E\uFE0F\u20E3]/u;
const LETTER = /\p{L}/u;
const BAD_LINK_TEXT = new Set(["here", "link", "click here"]);

// a11y problems in dashboard markdown; [] when clean.
export function lint(markdown) {
  const problems = [];
  const lines = String(markdown ?? "").replace(/\r\n?/g, "\n").split("\n");
  let level = null;
  let fence = false;
  lines.forEach((line, i) => {
    const at = `line ${i + 1}`;
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; return; }
    if (fence) return;

    // Every emoji (with its modifiers and ZWJ partners) is followed by a space and a word.
    const cps = [...line];
    for (let k = 0; k < cps.length; k++) {
      if (!PICTO.test(cps[k])) continue;
      let j = k + 1;
      for (;;) {
        if (j < cps.length && MODIFIER.test(cps[j])) { j++; continue; }
        if (cps[j] === "\u200D" && j + 1 < cps.length && PICTO.test(cps[j + 1])) { j += 2; continue; }
        break;
      }
      if (!(cps[j] === " " && LETTER.test(cps[j + 1] ?? ""))) problems.push(`${at}: emoji ${cps.slice(k, j).join("")} is not followed by a space and a word`);
      k = j - 1;
    }

    // Table headers carry no emoji.
    const nextLine = lines[i + 1] ?? "";
    if (line.trim().startsWith("|") && /^[\s|:-]+$/.test(nextLine) && nextLine.includes("-") && nextLine.includes("|") && PICTO.test(line)) {
      problems.push(`${at}: a table header contains an emoji`);
    }

    // Heading levels never skip.
    const h = /^(#{1,6})\s/.exec(line);
    if (h) {
      const n = h[1].length;
      if (level != null && n > level + 1) problems.push(`${at}: heading level ${n} follows level ${level}`);
      level = n;
    }

    if (/[\u2580-\u259F]/u.test(line)) problems.push(`${at}: block characters (a text progress bar)`);

    for (const m of line.matchAll(/\d{2}:\d{2}(?! UTC)/g)) problems.push(`${at}: time ${m[0]} without "UTC"`);

    // Markdown links (an escaped \[ is plain text) and HTML anchors.
    for (const m of line.matchAll(/(?<!\\)\[((?:[^\]\\]|\\.)*)\]\([^)]*\)|<a\b[^>]*>(.*?)<\/a>/gi)) {
      const label = (m[1] ?? m[2] ?? "").trim().toLowerCase();
      if (BAD_LINK_TEXT.has(label)) problems.push(`${at}: link text "${label}" does not describe the target`);
    }
  });
  return problems;
}
