// The ledger reducer. Pure: no I/O, no clock. Every shared-state change is an event applied
// here, so the rules in docs/design.md ("Ledger") live in exactly one place.

import { CollabError, EXIT } from "./errors.mjs";
import { addMinutes } from "./clock.mjs";

export const SCHEMA = 1;
export const STATUSES = Object.freeze(["open", "claimed", "in_review", "changes_requested", "approved", "done", "cancelled"]);
export const PHASES = Object.freeze(["planning", "active", "paused", "closed"]);
export const VENDORS = Object.freeze({ claude: "anthropic", codex: "openai", gemini: "google", grok: "xai", other: "other" });
export const SIZES = Object.freeze(["S", "M", "L"]);
export const KINDS = Object.freeze(["work", "fix-ci"]);
export const OWNER = "owner"; // the human owner acting from a terminal or a PR comment

// Same values as DEFAULTS in config.mjs (inlined so the reducer has no I/O imports).
const DEFAULT_CONFIG = Object.freeze({
  leaseMin: 90, reviewLeaseMin: 60, planLeaseMin: 15, reviewAlertH: 2, maxTasks: 12, wip: 1,
  worktreeRoot: ".collab/wt", verifyCmd: null, setupCmd: null,
});

// Events still allowed while the phase is paused or closed.
const PAUSED_OK = new Set(["directive", "phase.set", "comments.seen", "notice.sent", "agent.seen", "agent.join"]);
// The only events allowed while planning.
const PLANNING_OK = new Set(["agent.join", "agent.seen", "planner.lease", "plan", "directive", "comments.seen", "notice.sent", "phase.set"]);
// Statuses an owner holds a lease on, and that a steal can take over.
const STEALABLE = new Set(["claimed", "changes_requested", "approved"]);
// Statuses that count against the WIP limit.
const WIP_STATUSES = new Set(["claimed", "changes_requested"]);
const LIVE_STATUSES = new Set(["claimed", "changes_requested", "in_review", "approved"]);

export function vendorOf(tool) {
  return Object.hasOwn(VENDORS, tool) ? VENDORS[tool] : "other";
}

const idNum = (id) => Number(String(id).replace(/^T/i, ""));
export function taskIds(ledger) {
  return Object.keys(ledger?.tasks ?? {}).sort((a, b) => idNum(a) - idNum(b));
}

export function isTerminal(status) {
  return status === "done" || status === "cancelled";
}

// The dependencies a task still waits on. A cancelled dependency can never be done, so it stops
// counting (or its dependents could never be claimed and the collab could never finish); what it
// waited on itself still counts, so T3 -> T2 (cancelled) -> T1 keeps T3 behind T1.
export function unmetDeps(ledger, task, seen = new Set()) {
  const out = [];
  for (const d of task?.deps ?? []) {
    if (seen.has(d)) continue;
    seen.add(d);
    const dep = ledger.tasks?.[d];
    if (dep?.status === "done") continue;
    if (dep?.status === "cancelled") out.push(...unmetDeps(ledger, dep, seen));
    else out.push(d);
  }
  return [...new Set(out)];
}

// A task's direct dependencies that were cancelled.
export const cancelledDeps = (ledger, task) => (task?.deps ?? []).filter((d) => ledger.tasks?.[d]?.status === "cancelled");

const ms = (t) => (t instanceof Date ? t.getTime() : typeof t === "number" ? t : Date.parse(t));
const isoOf = (t) => new Date(ms(t)).toISOString();
// A lease is expired once its end is strictly before `at`. A missing lease counts as expired.
const expired = (until, at) => !until || ms(until) < ms(at);
const validTime = (t) => typeof t === "string" && !Number.isNaN(Date.parse(t));

export function newLedger({ pr, config, agent, now, lastCommentId = 0, lastCommentAt = null }) {
  if (!pr || pr.number == null) throw new TypeError("newLedger needs pr.number");
  if (!agent?.id || agent.id === OWNER) throw new TypeError("newLedger needs an agent id other than \"owner\"");
  if (now == null || Number.isNaN(ms(now))) throw new TypeError("newLedger needs now");
  const at = isoOf(now);
  const cfg = { ...DEFAULT_CONFIG };
  for (const [k, v] of Object.entries(config ?? {})) if (v !== undefined) cfg[k] = v;
  const tool = agent.tool ?? "other";
  return {
    schema: SCHEMA,
    seq: 0,
    rev: null,
    pr: { ...structuredClone(pr), mergeMethod: pr.mergeMethod ?? "squash" },
    phase: "planning",
    planner: { agent: agent.id, leaseUntil: addMinutes(at, cfg.planLeaseMin) },
    config: cfg,
    agents: {
      [agent.id]: { tool, vendor: vendorOf(tool), host: agent.host ?? null, pid: agent.pid ?? null, joinedAt: at, lastSeen: at },
    },
    tasks: {},
    nextTask: 1,
    directives: [],
    // Comments already on the PR when the collab starts are history, not directives for it.
    lastCommentId: Number(lastCommentId) || 0,
    lastCommentAt: validTime(lastCommentAt) ? isoOf(lastCommentAt) : null,
    notices: {},
  };
}

// ---------------------------------------------------------------- refusals

const VERB = {
  "agent.join": "join", "agent.seen": "check in", "planner.lease": "take the planner lease", plan: "plan",
  "task.add": "add a task", "task.claim": "claim", "task.release": "release", "task.lease": "extend the lease on",
  "task.push": "push", "task.verify": "record a verify for", "task.submit": "submit", "review.claim": "claim the review of",
  "review.verdict": "review", "task.merge": "merge", "task.cancel": "cancel", "task.block": "block",
  "task.unblock": "unblock", "task.note": "add a note to", "review.waive": "waive the review of", "task.reserve": "reserve", directive: "apply a directive to",
  "comments.seen": "mark comments seen on", "phase.set": "change the phase of", "notice.sent": "record a notice on",
  "reviewer.expire": "expire the reviewer of",
};

function refuse(ev, t, why, code = EXIT.PRECONDITION) {
  const who = ev.agent ?? "an unknown agent";
  const what = ev.task ? ` ${ev.task}${t ? ` (${t.status}${t.blocked ? ", blocked" : ""})` : ""}` : "";
  throw new CollabError(code, `${who} can't ${VERB[ev.type] ?? ev.type}${what}: ${why}`, {
    type: ev.type, agent: ev.agent ?? null, task: ev.task ?? null, status: t?.status ?? null,
  });
}

function taskOf(L, ev) {
  if (!ev.task) refuse(ev, null, "no task id given");
  const t = L.tasks[ev.task];
  if (!t) refuse(ev, null, `there is no task ${ev.task}`);
  return t;
}

const needTime = (ev, t, key) => {
  if (!validTime(ev.data[key])) refuse(ev, t, `data.${key} must be an ISO time`);
  return isoOf(ev.data[key]);
};
const needOwner = (ev, t) => {
  if (t.owner !== ev.agent) refuse(ev, t, t.owner ? `it belongs to ${t.owner}` : "nobody owns it");
};
const needStatus = (ev, t, ...ok) => {
  if (!ok.includes(t.status)) refuse(ev, t, `it must be ${ok.join(" or ")}`);
};
const needAgent = (ev, t) => {
  if (ev.agent === OWNER) refuse(ev, t, "this needs an agent id, not the owner");
};
const latestApproveSha = (t) => t.reviews.filter((r) => r.verdict === "approve").at(-1)?.sha ?? null;
const passingVerify = (t, sha) => !!sha && t.verify.some((v) => v.ok === true && v.sha === sha);
const wipHeld = (L, agent, exceptId) =>
  Object.entries(L.tasks).filter(([id, t]) => id !== exceptId && t.owner === agent && WIP_STATUSES.has(t.status)).map(([id]) => id);
const workCount = (L) => Object.values(L.tasks).filter((t) => t.kind !== "fix-ci" && t.status !== "cancelled").length;

// Give the owner a full lease to react when a review lands, so a long review never leaves
// the task stealable the moment it comes back.
function refreshLease(L, t, at) {
  const fresh = addMinutes(at, L.config.leaseMin);
  if (!t.leaseUntil || ms(t.leaseUntil) < ms(fresh)) t.leaseUntil = fresh;
}

function strings(ev, value, name) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.some((x) => typeof x !== "string")) refuse(ev, null, `${name} must be a list of strings`);
  return [...value];
}

function makeTask(L, ev, id, spec, kind, depOk) {
  if (!spec || typeof spec !== "object") refuse(ev, null, `task ${id} must be an object`);
  const title = typeof spec.title === "string" ? spec.title.trim() : "";
  if (!title) refuse(ev, null, `task ${id} needs a title`);
  const size = spec.size ?? "M";
  if (!SIZES.includes(size)) refuse(ev, null, `task ${id} size must be S, M or L, not ${size}`);
  // Store dependencies as canonical ids ("1", "t1" and "T01" all mean T1), or they could never match.
  const deps = strings(ev, spec.deps, `task ${id} deps`).map((d) => (/^T?0*\d+$/i.test(d.trim()) ? `T${idNum(d.trim())}` : d.trim().toUpperCase()));
  for (const d of deps) if (!depOk(d)) refuse(ev, null, `task ${id} depends on ${d}, which is not an earlier task`);
  const task = {
    title,
    desc: typeof spec.desc === "string" ? spec.desc : "",
    accept: strings(ev, spec.accept, `task ${id} accept`),
    scope: strings(ev, spec.scope, `task ${id} scope`),
    deps: [...new Set(deps)],
    size,
    kind,
    status: "open", owner: null, leaseUntil: null,
    branch: `collab/pr-${L.pr.number}/${id.toLowerCase()}`,
    subPr: null, headSha: null, touched: [],
    reviewer: null, reviewLeaseUntil: null, reviews: [], verify: [],
    blocked: null, merged: null, changeRounds: 0,
    times: { created: ev.at, claimed: null, submitted: null, done: null },
  };
  if (kind === "fix-ci") task.forSha = spec.forSha;
  return task;
}

function cancelTask(t) {
  t.status = "cancelled";
  if (t.reserved) t.reserved = null;
  t.leaseUntil = null;
  t.reviewer = null;
  t.reviewLeaseUntil = null;
}

// ---------------------------------------------------------------- handlers

const H = {
  "agent.join"(L, ev) {
    const id = ev.agent;
    if (typeof id !== "string" || !id.trim() || id === OWNER) refuse(ev, null, "an agent id is required and \"owner\" is reserved");
    const tool = ev.data.tool ?? "other";
    const existing = L.agents[id];
    if (existing) {
      if (ev.data.tool && ev.data.tool !== existing.tool) refuse(ev, null, `${id} already joined as ${existing.tool}`);
      return; // joining again only updates lastSeen
    }
    L.agents[id] = { tool, vendor: vendorOf(tool), host: ev.data.host ?? null, pid: ev.data.pid ?? null, joinedAt: ev.at, lastSeen: ev.at };
  },

  "agent.seen"() {},

  "planner.lease"(L, ev) {
    needAgent(ev, null);
    if (L.phase !== "planning") refuse(ev, null, `planning is over (phase ${L.phase})`);
    const leaseUntil = needTime(ev, null, "leaseUntil");
    const p = L.planner;
    if (p && p.agent !== ev.agent && !expired(p.leaseUntil, ev.at)) {
      refuse(ev, null, `${p.agent} holds the planner lease until ${p.leaseUntil}`);
    }
    L.planner = { agent: ev.agent, leaseUntil };
  },

  plan(L, ev) {
    needAgent(ev, null);
    if (L.phase !== "planning") refuse(ev, null, `plan only runs while planning (phase ${L.phase}); use collab add`);
    if (!L.planner || L.planner.agent !== ev.agent) {
      refuse(ev, null, L.planner ? `${L.planner.agent} is the planner` : "nobody holds the planner lease");
    }
    const tasks = ev.data.tasks;
    if (!Array.isArray(tasks) || tasks.length === 0) refuse(ev, null, "the plan has no tasks");
    const cap = L.config.maxTasks;
    if (workCount(L) + tasks.length > cap) refuse(ev, null, `a plan holds at most ${cap} tasks, and this one has ${tasks.length}`);
    const first = L.nextTask;
    tasks.forEach((spec, i) => {
      const id = `T${first + i}`;
      const depOk = (d) => (L.tasks[d] && L.tasks[d].status !== "cancelled") || (idNum(d) >= first && idNum(d) < first + i);
      L.tasks[id] = makeTask(L, ev, id, spec, "work", depOk);
    });
    L.nextTask = first + tasks.length;
    L.phase = "active";
    L.planner = null;
  },

  "task.add"(L, ev) {
    const d = ev.data;
    const kind = d.kind ?? "work";
    if (!KINDS.includes(kind)) refuse(ev, null, `kind must be work or fix-ci, not ${kind}`);
    const id = `T${L.nextTask}`;
    const spec = { ...d };
    if (kind === "fix-ci") {
      if (typeof d.forSha !== "string" || !d.forSha) refuse(ev, null, "a fix-ci task needs forSha");
      // One fix-ci task per red SHA, ever: re-adding after a cancel would loop forever.
      const fixes = taskIds(L).filter((k) => L.tasks[k].kind === "fix-ci");
      const dup = fixes.find((k) => L.tasks[k].forSha === d.forSha);
      if (dup && !L.tasks[dup].withdrawn) refuse(ev, L.tasks[dup], `${dup} already covers the CI failure at ${d.forSha.slice(0, 7)}`);
      // One open fix-ci task at a time: a head that moves while still red is the same failure.
      const live = fixes.find((k) => !isTerminal(L.tasks[k].status));
      if (live) refuse(ev, L.tasks[live], `${live} is already open for the red CI`);
      // Its task was withdrawn when CI went green unclaimed, and CI is red at that commit again:
      // reopen the same task. A CI that flaps there toggles one task instead of minting new ones,
      // and a red CI is never left frozen with nothing to claim.
      if (dup) {
        const t = L.tasks[dup];
        t.status = "open";
        t.withdrawn = false;
        t.times.reopened = ev.at; // the freeze it covers starts now, not when it was first added
        return;
      }
      if (!spec.title) spec.title = `Fix the failing CI at ${d.forSha.slice(0, 7)}`;
    } else if (workCount(L) + 1 > L.config.maxTasks) {
      refuse(ev, null, `the plan already holds ${L.config.maxTasks} tasks, the most allowed`);
    }
    const depOk = (dep) => !!L.tasks[dep] && L.tasks[dep].status !== "cancelled";
    L.tasks[id] = makeTask(L, ev, id, spec, kind, depOk);
    L.nextTask += 1;
  },

  "task.claim"(L, ev) {
    needAgent(ev, null);
    const t = taskOf(L, ev);
    const leaseUntil = needTime(ev, t, "leaseUntil");
    if (t.blocked) refuse(ev, t, `it is blocked: ${t.blocked.reason}`);
    const steal = ev.data.steal === true;
    if (steal) {
      if (!STEALABLE.has(t.status)) refuse(ev, t, "only a claimed, changes_requested or approved task can be stolen");
      if (t.owner === ev.agent) refuse(ev, t, "you already own it; extend the lease instead");
      if (!expired(t.leaseUntil, ev.at)) refuse(ev, t, `${t.owner}'s lease runs until ${t.leaseUntil}`);
    } else {
      if (t.status !== "open") {
        const hint = STEALABLE.has(t.status) && expired(t.leaseUntil, ev.at) ? "; its lease expired, so use --steal" : "";
        refuse(ev, t, `it must be open${t.owner ? ` (owner ${t.owner})` : ""}${hint}`);
      }
      const notDone = unmetDeps(L, t);
      if (notDone.length) refuse(ev, t, `its dependencies are not done: ${notDone.join(", ")}`);
      const r = t.reserved;
      if (r && r.agent !== ev.agent && !expired(r.until, ev.at)) refuse(ev, t, `the owner reserved it for ${r.agent} until ${r.until}`);
    }
    const held = wipHeld(L, ev.agent, ev.task);
    if (held.length >= (L.config.wip ?? 1)) refuse(ev, t, `the WIP limit is ${L.config.wip ?? 1} and you hold ${held.join(", ")}`);
    // A steal keeps the branch, sub-PR, head and history. From approved it drops back to
    // claimed: the approval no longer counts, and the task needs a new submit and review.
    t.status = "claimed";
    t.owner = ev.agent;
    t.leaseUntil = leaseUntil;
    t.reviewer = null;
    t.reviewLeaseUntil = null;
    t.times.claimed = ev.at;
    delete t.allowProtected; // the owner allowed it for the agent that asked, not for whoever holds the task next
    // What --allow-overlap accepted: the dashboard warns about it while the task is in flight.
    const overlap = strings(ev, ev.data.overlap, "overlap");
    if (overlap.length) t.overlap = overlap;
    else delete t.overlap;
    if (t.reserved) t.reserved = null;
  },

  // The owner sets an open task aside for an agent they invite (collab invite --task), so no other
  // agent claims it first. It lapses at `until`. A reservation with a past `until` releases it; the
  // owner or the agent it was for can do that (housekeeping does, once that agent's process exits).
  "task.reserve"(L, ev) {
    const t = taskOf(L, ev);
    const until = needTime(ev, t, "until");
    if (expired(until, ev.at)) {
      if (!t.reserved) refuse(ev, t, "it is not reserved");
      if (ev.agent !== OWNER && ev.agent !== t.reserved.agent) refuse(ev, t, "only the owner or the agent it is reserved for can release it");
      t.reserved = null;
      return;
    }
    if (ev.agent !== OWNER) refuse(ev, t, "only the owner can reserve a task (collab invite --task)");
    needStatus(ev, t, "open");
    const agent = ev.data.for;
    if (typeof agent !== "string" || !/^[a-z]+-[a-z0-9]{4}$/.test(agent)) refuse(ev, t, "a reservation needs the id of the agent it is for");
    t.reserved = { agent, until };
  },

  "task.release"(L, ev) {
    const t = taskOf(L, ev);
    needOwner(ev, t);
    needStatus(ev, t, "claimed");
    t.status = "open";
    t.owner = null;
    t.leaseUntil = null;
    delete t.overlap;
    delete t.allowProtected;
  },

  "task.lease"(L, ev) {
    const t = taskOf(L, ev);
    needOwner(ev, t);
    needStatus(ev, t, ...LIVE_STATUSES);
    t.leaseUntil = needTime(ev, t, "leaseUntil");
  },

  "task.push"(L, ev) {
    const t = taskOf(L, ev);
    needOwner(ev, t);
    needStatus(ev, t, ...LIVE_STATUSES);
    const sha = ev.data.headSha;
    if (typeof sha !== "string" || !sha) refuse(ev, t, "data.headSha is required");
    const approved = latestApproveSha(t);
    t.headSha = sha;
    if (ev.data.touched !== undefined) t.touched = [...new Set(strings(ev, ev.data.touched, "touched"))].sort();
    if (ev.data.subPr != null) t.subPr = ev.data.subPr;
    if (ev.data.leaseUntil !== undefined) t.leaseUntil = needTime(ev, t, "leaseUntil");
    if (t.status === "approved" && sha !== approved) {
      t.status = "in_review"; // the approval was for another SHA
      t.reviewer = null;
      t.reviewLeaseUntil = null;
    }
  },

  "task.verify"(L, ev) {
    const t = taskOf(L, ev);
    if (t.owner !== ev.agent && t.reviewer !== ev.agent) refuse(ev, t, `only the owner (${t.owner ?? "none"}) or the reviewer (${t.reviewer ?? "none"}) can verify`);
    needStatus(ev, t, ...LIVE_STATUSES);
    const { sha, ok, summary } = ev.data;
    if (typeof sha !== "string" || !sha) refuse(ev, t, "data.sha is required");
    if (typeof ok !== "boolean") refuse(ev, t, "data.ok must be true or false");
    t.verify.push({ sha, by: ev.agent, ok, summary: summary == null ? "" : String(summary), at: ev.at });
  },

  "task.submit"(L, ev) {
    const t = taskOf(L, ev);
    needOwner(ev, t);
    needStatus(ev, t, "claimed", "changes_requested");
    const sha = ev.data.sha;
    if (!t.headSha) refuse(ev, t, "nothing is pushed yet; run collab push first");
    if (sha !== t.headSha) refuse(ev, t, `the head is ${t.headSha}, not ${sha}`);
    if (!passingVerify(t, sha)) refuse(ev, t, `no passing collab verify at ${sha.slice(0, 7)}`);
    t.status = "in_review";
    t.reviewer = null;
    t.reviewLeaseUntil = null;
    t.times.submitted = ev.at;
  },

  "review.claim"(L, ev) {
    needAgent(ev, null);
    const t = taskOf(L, ev);
    needStatus(ev, t, "in_review");
    if (t.owner === ev.agent) refuse(ev, t, "you can't review your own task");
    const mine = L.agents[ev.agent].vendor;
    const theirs = L.agents[t.owner]?.vendor;
    if (mine === theirs) refuse(ev, t, `the reviewer must come from another vendor than ${t.owner} (${theirs})`);
    if (t.reviewer && t.reviewer !== ev.agent && !expired(t.reviewLeaseUntil, ev.at)) {
      refuse(ev, t, `${t.reviewer} is reviewing it until ${t.reviewLeaseUntil}`);
    }
    t.reviewer = ev.agent;
    t.reviewLeaseUntil = needTime(ev, t, "leaseUntil");
    t.reviewSha = t.headSha; // the commit the reviewer checks out; a verdict counts only for it
  },

  "review.verdict"(L, ev) {
    const t = taskOf(L, ev);
    needStatus(ev, t, "in_review");
    if (t.reviewer !== ev.agent) refuse(ev, t, t.reviewer ? `${t.reviewer} is the reviewer` : "claim the review first");
    const vendor = L.agents[ev.agent]?.vendor;
    if (vendor === L.agents[t.owner]?.vendor) refuse(ev, t, "the reviewer must come from another vendor than the owner");
    const { verdict, sha, commentId } = ev.data;
    if (verdict !== "approve" && verdict !== "changes") refuse(ev, t, "verdict must be approve or changes");
    if (sha !== t.headSha) refuse(ev, t, `the head is ${t.headSha}, not ${sha}; review the current head`);
    // The owner may push while the review runs. The reviewer then holds the old commit, so a verdict
    // now would be on code they never read: they claim the review again to check out the new head.
    if (t.reviewSha && t.reviewSha !== t.headSha) {
      refuse(ev, t, `${t.owner} pushed ${String(t.headSha).slice(0, 7)} after you started reviewing ${String(t.reviewSha).slice(0, 7)}; run collab review-claim ${ev.task} again and review the new commit`);
    }
    t.reviews.push({ agent: ev.agent, vendor, verdict, sha, commentId: commentId ?? null, at: ev.at });
    if (verdict === "approve") t.status = "approved";
    else {
      t.status = "changes_requested";
      t.changeRounds += 1;
    }
    t.reviewer = null;
    t.reviewLeaseUntil = null;
    refreshLease(L, t, ev.at);
  },

  "task.merge"(L, ev) {
    const t = taskOf(L, ev);
    needStatus(ev, t, "approved");
    if (t.blocked) refuse(ev, t, `it is blocked: ${t.blocked.reason}`);
    const approved = latestApproveSha(t);
    if (approved !== t.headSha) refuse(ev, t, `the approval is for ${approved}, but the head is ${t.headSha}`);
    if (ev.data.sha !== t.headSha) refuse(ev, t, `the head is ${t.headSha}, not ${ev.data.sha}`);
    t.status = "done";
    t.merged = { sha: t.headSha, at: ev.at, by: ev.agent };
    if (ev.data.mergeSha) t.merged.mergeSha = ev.data.mergeSha;
    t.leaseUntil = null;
    t.times.done = ev.at;
  },

  "task.cancel"(L, ev) {
    const t = taskOf(L, ev);
    if (isTerminal(t.status)) refuse(ev, t, `it is already ${t.status}`);
    if (ev.agent !== OWNER && t.status !== "open" && t.owner !== ev.agent) {
      refuse(ev, t, `only its owner (${t.owner}) or the PR owner can cancel it`);
    }
    if (ev.data.withdrawn === true) {
      if (t.kind !== "fix-ci" || t.status !== "open") refuse(ev, t, "only an open fix-ci task can be withdrawn");
      t.withdrawn = true;
    }
    cancelTask(t);
  },

  "task.block"(L, ev) {
    const t = taskOf(L, ev);
    if (ev.agent !== OWNER) needOwner(ev, t);
    if (isTerminal(t.status)) refuse(ev, t, `it is already ${t.status}`);
    const reason = typeof ev.data.reason === "string" && ev.data.reason.trim() ? ev.data.reason.trim() : null;
    if (!reason) refuse(ev, t, "a reason is required");
    const needsOwner = ev.data.needsOwner === true;
    // Asking the owner the same question again changes nothing: it keeps its time (so its one
    // notice) and who first asked, which is who that notice names.
    const asked = t.blocked?.needsOwner && needsOwner && t.blocked.reason === reason;
    t.blocked = asked ? { ...t.blocked } : { reason, needsOwner, by: ev.agent, since: ev.at };
    // A new question for the owner makes their last answer history: it must not read as the answer
    // to this one. Any other block keeps it, for whoever works on the task next.
    if (t.blocked.needsOwner) delete t.decision;
  },

  "task.unblock"(L, ev) {
    const t = taskOf(L, ev);
    if (ev.agent !== OWNER) needOwner(ev, t);
    if (!t.blocked) refuse(ev, t, "it isn't blocked");
    t.blocked = null;
    if (ev.data.decision != null) t.decision = { text: String(ev.data.decision), by: ev.agent, at: ev.at };
    // The owner lets this task change protected files (CI workflows, .collab.json): collab decide --allow-protected.
    if (ev.data.allowProtected === true) {
      if (ev.agent !== OWNER) refuse(ev, t, "only the owner can allow changes to protected files, from a terminal");
      t.allowProtected = true;
    }
  },

  "task.note"(L, ev) {
    if (ev.task) taskOf(L, ev); // the note itself lives in the commit trailer
  },

  "review.waive"(L, ev) {
    const t = taskOf(L, ev);
    if (ev.agent !== OWNER) refuse(ev, t, "only the owner can waive a review, from a terminal");
    needStatus(ev, t, "in_review", "changes_requested");
    if (!t.headSha) refuse(ev, t, "nothing is pushed yet");
    t.reviews.push({ agent: OWNER, vendor: OWNER, verdict: "approve", sha: t.headSha, commentId: null, at: ev.at });
    t.status = "approved";
    t.reviewer = null;
    t.reviewLeaseUntil = null;
    refreshLease(L, t, ev.at);
  },

  // A write-access comment: `/collab pause` or `/collab cancel T<n>`. It is always recorded
  // (so lastCommentId moves on); `applied` says whether it changed anything.
  directive(L, ev) {
    const d = ev.data;
    const commentId = Number(d.commentId);
    if (!Number.isFinite(commentId)) refuse(ev, null, "data.commentId is required");
    if (commentId <= L.lastCommentId) refuse(ev, null, `comment ${commentId} was already seen (last ${L.lastCommentId})`);
    if (d.cmd !== "pause" && d.cmd !== "cancel") refuse(ev, null, "a directive is pause or cancel");
    const taskId = ev.task ?? d.task ?? null;
    let applied = false;
    if (d.cmd === "pause") {
      if (L.phase !== "closed") { L.phase = "paused"; applied = true; }
    } else {
      const t = taskId ? L.tasks[taskId] : null;
      if (t && !isTerminal(t.status)) { cancelTask(t); applied = true; }
    }
    const entry = { commentId, login: d.login ?? null, cmd: d.cmd, at: ev.at, applied };
    if (taskId) entry.task = taskId;
    if (d.url) entry.url = d.url;
    L.directives.push(entry);
    L.lastCommentId = commentId;
    if (validTime(d.commentAt)) L.lastCommentAt = isoOf(d.commentAt);
  },

  "comments.seen"(L, ev) {
    const id = Number(ev.data.lastCommentId);
    if (!Number.isFinite(id)) refuse(ev, null, "data.lastCommentId is required");
    if (id >= L.lastCommentId && validTime(ev.data.lastCommentAt)) L.lastCommentAt = isoOf(ev.data.lastCommentAt);
    L.lastCommentId = Math.max(L.lastCommentId, id);
  },

  "phase.set"(L, ev) {
    if (ev.agent !== OWNER) refuse(ev, null, "only the owner can change the phase, from a terminal");
    let phase = ev.data.phase;
    if (!PHASES.includes(phase)) refuse(ev, null, `phase must be one of ${PHASES.join(", ")}`);
    if (L.phase === "closed") refuse(ev, null, "the collab is closed");
    // Resuming a collab that was paused before its plan landed goes back to planning.
    if (phase === "active" && L.planner) phase = "planning";
    L.phase = phase;
  },

  "notice.sent"(L, ev) {
    const key = ev.data.key;
    if (typeof key !== "string" || !key) refuse(ev, null, "data.key is required");
    L.notices[key] = ev.data.commentId ?? null;
  },

  "reviewer.expire"(L, ev) {
    const t = taskOf(L, ev);
    needStatus(ev, t, "in_review");
    if (!t.reviewer) refuse(ev, t, "it has no reviewer");
    if (!expired(t.reviewLeaseUntil, ev.at)) refuse(ev, t, `${t.reviewer}'s review lease runs until ${t.reviewLeaseUntil}`);
    t.reviewer = null;
    t.reviewLeaseUntil = null;
  },
};

export const EVENT_TYPES = Object.freeze(Object.keys(H));

// ---------------------------------------------------------------- apply

export function apply(ledger, event) {
  if (!ledger || typeof ledger !== "object") throw new TypeError("apply needs a ledger");
  if (ledger.schema !== SCHEMA) {
    throw new CollabError(EXIT.ENV, `this ledger is schema ${ledger.schema}, but this collab understands schema ${SCHEMA}; update collab`);
  }
  if (!event || typeof event.type !== "string") throw new CollabError(EXIT.BUG, "malformed event: no type");
  if (!validTime(event.at)) throw new CollabError(EXIT.BUG, `malformed ${event.type} event: no valid "at" time`);
  const ev = { ...event, data: structuredClone(event.data ?? {}) };
  const handler = Object.hasOwn(H, ev.type) ? H[ev.type] : null;
  if (!handler) refuse(ev, null, `unknown event type ${ev.type}`);

  if (ev.type !== "agent.join" && ev.agent !== OWNER && !Object.hasOwn(ledger.agents, ev.agent)) {
    refuse(ev, null, `${ev.agent ?? "(no agent)"} has not joined; run collab join first`);
  }
  if ((ledger.phase === "paused" || ledger.phase === "closed") && !PAUSED_OK.has(ev.type)) {
    refuse(ev, ev.task ? ledger.tasks[ev.task] : null, `PR #${ledger.pr?.number} is ${ledger.phase}${ledger.phase === "paused" ? "; the owner must run collab resume" : ""}`, EXIT.UNSUPPORTED);
  }
  if (ledger.phase === "planning" && !PLANNING_OK.has(ev.type)) {
    refuse(ev, ev.task ? ledger.tasks[ev.task] : null, `PR #${ledger.pr?.number} is still planning; wait for the plan`);
  }

  const L = structuredClone(ledger);
  handler(L, ev);
  L.seq = ledger.seq + 1;
  if (ev.agent !== OWNER && Object.hasOwn(L.agents, ev.agent)) L.agents[ev.agent].lastSeen = ev.at;
  return L;
}

// ---------------------------------------------------------------- derived state

export function derive(ledger, now) {
  const at = ms(now);
  const live = (until) => !!until && ms(until) >= at;
  const tasks = {};
  const liveAgents = new Set();
  const expiries = [];
  const agentIds = Object.keys(ledger.agents ?? {});

  for (const id of taskIds(ledger)) {
    const t = ledger.tasks[id];
    const terminal = isTerminal(t.status);
    const reviewStale = t.status === "in_review" && !!t.reviewer && !live(t.reviewLeaseUntil);
    const ownerVendor = t.owner ? ledger.agents[t.owner]?.vendor : undefined;
    tasks[id] = {
      inProgress: t.status === "claimed" && !!t.headSha,
      stale: STEALABLE.has(t.status) && !live(t.leaseUntil),
      reviewStale,
      waitingReview: t.status === "in_review" && (!t.reviewer || reviewStale),
      eligibleReviewers: t.owner ? agentIds.filter((a) => a !== t.owner && ledger.agents[a].vendor !== ownerVendor) : [],
    };
    if (terminal) continue;
    if (t.owner && live(t.leaseUntil)) { liveAgents.add(t.owner); expiries.push(ms(t.leaseUntil)); }
    if (t.status === "in_review" && t.reviewer && live(t.reviewLeaseUntil)) { liveAgents.add(t.reviewer); expiries.push(ms(t.reviewLeaseUntil)); }
  }
  const p = ledger.planner;
  if (p?.agent && live(p.leaseUntil)) { liveAgents.add(p.agent); expiries.push(ms(p.leaseUntil)); }

  return {
    tasks,
    liveAgents: [...liveAgents],
    nextLeaseExpiry: expiries.length ? new Date(Math.min(...expiries)).toISOString() : null,
  };
}
