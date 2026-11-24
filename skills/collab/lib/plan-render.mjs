// What a plan session shows on GitHub: the status block at the top of the issue body, and the
// comments collab posts (revisions, agreements, notices, agents' messages). Pure: no I/O, and the
// only time it reads is the `now` the CLI passes in.
//
// Every string that comes from people or agents (logins, agent ids, summaries, reasons, URLs)
// goes through the dashboard's escaping rules, so it can't break a table, open a link, notify
// someone, or smuggle in HTML or a collab marker.

import { human } from "./clock.mjs";
import { VENDORS } from "./ledger.mjs";
import { consensus, personStatus } from "./plan-ledger.mjs";

export { lint } from "./dashboard.mjs";

const SUMMARY_MAX = 200;
const REASON_MAX = 200;
const DIFF_MAX = 3000;

const STATUS = Object.freeze({
  drafting: { emoji: "⚪", label: "Drafting" },
  waiting: { emoji: "🟡", label: "Waiting on agreement" },
  agreed: { emoji: "✅", label: "Agreed" },
  "handed-off": { emoji: "🚀", label: "Handed off" },
  closed: { emoji: "⚫", label: "Closed" },
});

// Tool names as the dashboard shows them, and the short ones used in an agent's message prefix.
const TOOL_NAMES = { claude: "Claude Code", codex: "Codex", gemini: "Gemini CLI", grok: "Grok Build", other: "other" };
const SHORT_TOOL = { claude: "Claude", codex: "Codex", gemini: "Gemini", grok: "Grok", other: "agent" };

const PEOPLE_HEAD = "| Person | Agents | Agreed to | How | Last active |\n|---|---|---|---|---|";

// ---------------------------------------------------------------- escaping (same rules as dashboard.mjs)

const ms = (t) => (t instanceof Date ? t.getTime() : typeof t === "number" ? t : Date.parse(t));
const okTime = (t) => t != null && t !== "" && Number.isFinite(ms(t));
// Formats a time it is given; never reads the clock (human() would, given nothing).
const when = (t) => (okTime(t) ? human(new Date(ms(t))) : "an unknown time");
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const own = (o, k) => (o && typeof o === "object" && typeof k === "string" && Object.hasOwn(o, k) ? o[k] : undefined);

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

// Escaped, cut, and with every @mention quieted (the status block is rewritten often, and a
// mention in it would notify someone each time).
const text = (value, n) => quietMentions(md(n ? cut(value, n) : value), []);
const code = (s) => `\`${String(s ?? "").replace(/[`<>\s]/g, "") || "?"}\``;
const safeUrl = (u) => (typeof u === "string" && /^https:\/\/[^\s<>()[\]`"'\\]+$/.test(u) ? u : null);
const hex8 = (hash) => String(hash ?? "").replace(/^sha256:/, "").replace(/[^0-9a-f]/g, "").slice(0, 8) || "?";
const num = (v) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : null);

function toolName(tool) {
  return Object.hasOwn(VENDORS, tool) ? TOOL_NAMES[tool] ?? "other" : "other";
}

// ---------------------------------------------------------------- mentions

// @login or @org/team, not inside a word (so x@y.z is left alone) or a URL path. Backslashes
// right before it are captured: an odd run escapes the @ (`\@x` still renders as a mention).
const MENTION = /(^|[^A-Za-z0-9_/\\])(\\*)@([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)(\/[A-Za-z0-9][A-Za-z0-9_.-]*)?/g;

// Applies fn to the parts of src outside inline code spans. A backtick after a backslash is
// literal; a run of N backticks with no matching run of N later is literal too (CommonMark).
function outsideSpans(src, fn) {
  let out = "";
  let start = 0;
  let i = 0;
  while (i < src.length) {
    if (src[i] === "\\") { i += 2; continue; }
    if (src[i] !== "`") { i++; continue; }
    let j = i;
    while (src[j] === "`") j++;
    const run = j - i;
    let close = -1;
    for (let k = j; k < src.length;) {
      if (src[k] !== "`") { k++; continue; }
      let e = k;
      while (src[e] === "`") e++;
      if (e - k === run) { close = k; break; }
      k = e;
    }
    if (close < 0) { i = j; continue; }
    out += fn(src.slice(start, i)) + src.slice(i, close + run);
    i = start = close + run;
  }
  return out + fn(src.slice(start));
}

// Applies fn to the parts of src outside fenced code blocks and inline code spans.
function outsideCode(src, fn) {
  const lines = src.split(/(?<=\n)/);
  let out = "";
  let buf = "";
  let fence = null;
  for (const line of lines) {
    if (fence) {
      out += line;
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*\r?\n?$/.exec(line);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null;
      continue;
    }
    const open = /^ {0,3}(`{3,}|~{3,})(.*)$/s.exec(line);
    // A backtick fence's info string can't hold a backtick (then it's an inline span instead).
    if (open && !(open[1][0] === "`" && open[2].includes("`"))) {
      out += outsideSpans(buf, fn);
      buf = "";
      fence = open[1];
      out += line;
      continue;
    }
    buf += line;
  }
  return out + outsideSpans(buf, fn);
}

// Puts `@name` in a code span when name (case-insensitive) is not one of `logins`, so GitHub
// doesn't notify them. Team mentions are always quieted. Emails and code are left alone.
export function quietMentions(value, logins = []) {
  const allow = new Set([...(Array.isArray(logins) ? logins : [])].map((l) => String(l).toLowerCase()));
  return outsideCode(String(value ?? ""), (chunk) => chunk.replace(MENTION, (m, pre, slashes, name, team) => {
    if (!team && allow.has(name.toLowerCase())) return m;
    // An escaping backslash would escape the code span's backtick instead: drop it.
    const keep = slashes.length % 2 ? slashes.slice(0, -1) : slashes;
    return `${pre}${keep}\`@${name}${team ?? ""}\``;
  }));
}

// ---------------------------------------------------------------- status

export function status(ledger) {
  const phase = ledger?.phase;
  const key = phase === "closed" || phase === "handed-off" || phase === "agreed" ? phase
    : consensus(ledger).agreedBy.length > 0 ? "waiting" : "drafting";
  return { key, ...STATUS[key] };
}

export function renderStatus(ledger, now, { browserEdit = false } = {}) {
  const L = ledger;
  if (!L || typeof L !== "object") throw new TypeError("renderStatus needs a plan ledger");
  const s = status(L);
  const cur = num(L.current) ?? 1;
  const curRev = own(L.revs, String(L.current)) ?? {};
  const n = num(L.issue?.number) ?? "?";
  const parts = [`## Plan session: ${s.emoji} ${s.label} (revision ${cur}, as of ${when(now)})`];
  if (browserEdit) {
    parts.push(`⚠️ Warning: the plan section below was edited in the browser, so it may not match revision ${cur}. The edit stays until the next revision, but agreements count only for revision ${cur} as collab recorded it (${hex8(curRev.hash)}); read that with \`collab plan show ${n}\`.`);
  }
  parts.push(needs(L, s, cur));
  if (L.handoff) parts.push(handoffLine(L));
  const latest = latestLine(L, cur, curRev);
  if (latest) parts.push(latest);
  parts.push(peopleTable(L, s, cur, curRev));
  if (s.key === "drafting" || s.key === "waiting" || s.key === "agreed") {
    const later = s.key === "agreed" ? " Anyone who joins now watches until the owner reopens the plan." : "";
    parts.push(`**Join:** paste \`/collab plan ${n}\` into Claude Code or \`$collab plan ${n}\` into Codex. For other agents, run \`collab prompt plan ${n}\` and give them what it prints.${later}`);
  }
  if (s.key === "drafting" || s.key === "waiting") {
    parts.push(`**Agree from the browser:** after reading revision ${cur}, comment \`/collab agree r${cur} ${hex8(curRev.hash)}\` on this issue.`);
  }
  if (s.key === "agreed") {
    parts.push(`**Next:** anyone taking part runs \`collab plan handoff ${n}\` to open the build PR, or the owner runs \`collab plan reopen ${n}\` in their own terminal to change the plan.`);
  }
  parts.push(`<sub>Updated ${when(now)} from plan ledger seq ${Number(L.seq) || 0}. Generated by collab: the plan below is replaced by each new revision, and anything between the collab markers is overwritten.</sub>`);
  return parts.join("\n\n");
}

function needs(L, s, cur) {
  const min = num(L.minPeople) ?? 2;
  if (s.key === "closed") {
    const c = L.closed ?? {};
    const reason = c.reason ? ` The reason given: "${text(c.reason, REASON_MAX)}"` : "";
    const agreed = L.agreedAt ? ` Everyone had agreed to revision ${cur} on ${when(L.agreedAt)}.` : "";
    return `${c.by ? text(c.by) : "The owner"} closed the plan session on ${when(c.at)}.${agreed}${reason}`;
  }
  if (s.key === "agreed" || s.key === "handed-off") return `Everyone agreed to revision ${cur} on ${when(L.agreedAt)}.`;
  const cs = consensus(L);
  const who = cs.waitingOn.map((l) => text(l));
  if (cs.needMore > 0) who.push(`${plural(cs.needMore, "more person", "more people")} to join`);
  const rule = `The plan is agreed when every person below agrees to the same revision, with at least ${plural(min, "person", "people")} taking part.`;
  return `${rule} Waiting on: ${listOf(who)}.`;
}

function listOf(items) {
  if (items.length <= 1) return items.join("") || "nobody";
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

function handoffLine(L) {
  const h = L.handoff ?? {};
  const pr = num(h.pr);
  const label = pr ? `PR #${pr}` : "the build PR";
  const url = safeUrl(h.url);
  const link = url ? `[${label}](${url})` : label;
  const where = [];
  if (h.path) where.push(`at ${code(h.path)}`);
  if (h.branch) where.push(`on ${code(h.branch)}`);
  const saved = where.length ? ` The agreed plan is saved ${where.join(" ")}.` : "";
  return `🚀 Handed off: ${link} builds revision ${num(h.rev) ?? num(L.current) ?? "?"} (${hex8(h.hash)}), handed off by ${text(h.by ?? "someone")} on ${when(h.at)}.${saved}`;
}

function latestLine(L, cur, r) {
  if (!r.login && !r.at) return null;
  const through = r.agent ? ` through ${text(r.agent)}` : "";
  const merged = r.merged === true && num(r.base) ? ` (an edit of revision ${num(r.base)}, merged with revision ${cur - 1})` : "";
  const summary = r.summary ? `: ${text(r.summary, SUMMARY_MAX)}` : ".";
  return `Latest: revision ${cur} by ${text(r.login ?? "someone")}${through} on ${when(r.at)}${merged}${summary}`;
}

// Owner first, then the people taking part, then observers, then those who left or were removed.
const ORDER = { active: 0, observer: 1, left: 2, removed: 3 };

function peopleTable(L, s, cur, curRev) {
  const logins = Object.keys(L.people ?? {}).sort((a, b) => {
    if (a === L.owner) return -1;
    if (b === L.owner) return 1;
    const d = (ORDER[personStatus(L, a)] ?? 9) - (ORDER[personStatus(L, b)] ?? 9);
    return d || (a < b ? -1 : a > b ? 1 : 0);
  });
  if (!logins.length) return "No one has joined yet.";
  const rows = logins.map((login) => {
    const p = L.people[login];
    const st = personStatus(L, login);
    const agents = Object.keys(L.agents ?? {}).filter((id) => L.agents[id]?.login === login)
      .map((id) => `${text(id)} (${toolName(L.agents[id].tool)})`).join(", ") || "none";
    const a = own(L.agreements, login);
    const valid = !!a && a.rev === L.current && a.hash === curRev.hash;
    let agreed;
    let how;
    if (st === "removed") {
      agreed = "🚫 Removed";
      const reason = p.removed?.reason ? `: ${text(p.removed.reason, REASON_MAX)}` : "";
      how = `Removed by ${text(p.removed?.by ?? "the owner")} on ${when(p.removed?.at)}${reason}`;
    } else if (st === "left") {
      agreed = "🚪 Left";
      how = `Left on ${when(p.left)}`;
    } else if (st === "observer") {
      agreed = "👀 Watching";
      how = "Joined after the agreement; takes part once the owner reopens the plan";
    } else if (valid) {
      agreed = `✅ Revision ${cur}`;
      how = viaText(a);
    } else {
      agreed = s.key === "closed" ? "Not agreed" : "⏳ Waiting";
      how = "none";
    }
    const name = `${text(login)}${login === L.owner ? " (owner)" : ""}`;
    return `| ${name} | ${agents} | ${agreed} | ${how} | ${when(p.lastSeen)} |`;
  });
  return [PEOPLE_HEAD, ...rows].join("\n");
}

function viaText(a) {
  const via = String(a?.via ?? "");
  if (via.startsWith("agent:")) return `Through their agent ${text(via.slice("agent:".length))}`;
  if (via === "comment") {
    const url = safeUrl(a.url);
    return url ? `[By comment](${url})` : "By comment";
  }
  if (via === "terminal") return "From their terminal";
  return via ? text(via, 40) : "none";
}

// ---------------------------------------------------------------- comments

// One line of prefix markdown (messagePrefix's output, already escaped) that can't hold HTML.
const cleanPrefix = (p) => String(p ?? "").replace(/[\r\n\u2028\u2029]+/g, " ").replace(/</g, "&lt;").trim().replace(/:$/, "");

// The fence for a code block: longer than any backtick run inside it, so none can close it.
function fenceFor(body) {
  const longest = Math.max(0, ...[...body.matchAll(/`+/g)].map((m) => m[0].length));
  return "`".repeat(Math.max(3, longest + 1));
}

// The first `max` characters of a diff, at a line end when there is one, never splitting a pair.
function capDiff(diff, max) {
  if (diff.length <= max) return { body: diff, cut: false };
  let body = diff.slice(0, max);
  const nl = body.lastIndexOf("\n");
  if (nl > 0) body = body.slice(0, nl);
  else if (/[\uD800-\uDBFF]$/.test(body)) body = body.slice(0, -1);
  return { body, cut: true };
}

// "📝 Revision 3 by <prefix or login>: <summary>", then the diff (capped) in a details block.
// `from` names the revision the diff starts from. It defaults to the previous revision, which is
// what collab plan edit diffs against; that is the base too, unless the revision was merged.
export function revisionComment(ledger, rev, diff, { prefix, from } = {}) {
  const L = ledger;
  const r = own(L?.revs, String(rev));
  if (!r) throw new TypeError(`revisionComment: plan ledger has no revision ${rev}`);
  const n = num(rev) ?? "?";
  const people = Object.keys(L.people ?? {}).filter((l) => personStatus(L, l) !== "removed");
  const who = prefix ? cleanPrefix(prefix) : md(r.login ?? "someone");
  const summary = r.summary ? quietMentions(md(cut(r.summary, SUMMARY_MAX)), people) : "";
  const lines = [`📝 Revision ${n} by ${who}${summary ? `: ${summary}` : ""}`];
  if (r.merged === true && num(r.base)) {
    lines.push("", `It merges ${md(r.login ?? "someone")}'s edit of revision ${num(r.base)} with revision ${n - 1}.`);
  }
  lines.push("", `Agreements to earlier revisions no longer count. To agree to this one from the browser, comment \`/collab agree r${n} ${hex8(r.hash)}\`.`);
  const raw = String(diff ?? "").replace(/\r\n?/g, "\n");
  if (raw.trim()) {
    // The diff is plan text: keep it verbatim, except that it can never hold a collab marker
    // (an HTML comment opener) or close its own fence.
    const { body, cut: wasCut } = capDiff(raw.replace(/<!--/g, "&lt;!--"), DIFF_MAX);
    const fence = fenceFor(body);
    const base = num(from ?? (n !== "?" && n > 1 ? n - 1 : r.base)) ?? "?";
    lines.push("", `<details><summary>What changed from revision ${base}</summary>`, "", `${fence}diff`, body.replace(/\n+$/, ""), fence);
    if (wasCut) lines.push("", `(cut) The diff is longer than ${DIFF_MAX} characters; run \`collab plan show ${num(L.issue?.number) ?? "?"}\` to read the whole plan.`);
    lines.push("", "</details>");
  }
  return lines.join("\n");
}

const markerLogin = (login) => String(login ?? "").replace(/[^A-Za-z0-9-]/g, "") || "unknown";
const markerHash = (hash) => {
  const h = String(hash ?? "");
  return /^sha256:[0-9a-f]{64}$/.test(h) ? h : h.replace(/[^A-Za-z0-9:]/g, "") || "unknown";
};

function howAgreed(via) {
  const v = String(via ?? "");
  if (v.startsWith("agent:")) return ` through their agent ${md(v.slice("agent:".length))}`;
  if (v === "comment") return " by comment";
  if (v === "terminal") return " from their terminal";
  return "";
}

// The marker line (which collab reads back) and one line saying who agreed to what, and how.
export function agreeComment(ledger, login, { rev, hash, via } = {}) {
  const n = num(rev) ?? 0;
  const marker = `<!-- collab:plan-agree login=${markerLogin(login)} rev=${n} hash=${markerHash(hash)} -->`;
  return `${marker}\n✅ Agrees: ${md(login)} agrees to revision ${n} (${hex8(hash)})${howAgreed(via)}.`;
}

export function noticeComment(key, body) {
  const k = String(key ?? "").replace(/[^A-Za-z0-9._:@+=/-]/g, "") || "notice";
  return `<!-- collab:notice key=${k} -->\n${String(body ?? "").replace(/<!--/g, "&lt;!--")}`;
}

// "🤖 alice's Claude (claude-x9):" for a message an agent posts for its person.
export function messagePrefix(ledger, agent) {
  const ag = own(ledger?.agents, agent);
  if (!ag) return `🤖 Agent ${md(agent)}:`;
  const tool = Object.hasOwn(SHORT_TOOL, ag.tool) ? SHORT_TOOL[ag.tool] : "agent";
  return `🤖 ${md(ag.login)}'s ${tool} (${md(agent)}):`;
}
