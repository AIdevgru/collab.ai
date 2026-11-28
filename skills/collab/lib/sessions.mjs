// Parallel sessions (`collab invite <tool> --sessions N`): how many more invited agents the session
// keeper starts now, and on which tasks. Pure: the CLI passes the ledger, the keeper's running
// sessions and the time. See docs/design.md, "Parallel sessions".
//
// The keeper runs up to N sessions at once, but only as many as there is work for: a session
// starts for work that someone can take now and that nobody free is about to take. That work is
//   - a task waiting for a review that a new session may take (another vendor's at once, its own
//     vendor's once the review is open to it: see derive in ledger.mjs),
//   - an open task whose dependencies are done, that isn't reserved, and whose scope overlaps no
//     task in flight (what `collab claim` would accept), and
//   - a task whose owner's lease ran out while it was claimed or had changes requested (a session
//     that ended mid-task): a new session takes it over with --steal.
// Of two open tasks whose scopes overlap, only the first counts: once one is claimed, `claim`
// refuses the other. A task reserved for a session that hasn't claimed it yet counts as in flight.
// A running session, or the agent that asked for the sessions (while it was seen in the last 30
// minutes), is free when it holds less than the WIP limit, no live reservation and no review: its
// own `collab next` takes the first piece of work it may take, a review before a claim.

import { intersect } from "./glob.mjs";
import { ACTIVE_MIN, derive, isTerminal, reviewTurn, taskIds } from "./ledger.mjs";
import { claimableTasks } from "./next.mjs";

const WIP = new Set(["claimed", "changes_requested"]);
export const HOST_GONE_MIN = ACTIVE_MIN;
const ms = (t) => (t instanceof Date ? t.getTime() : typeof t === "number" ? t : Date.parse(t));

// ledger   the PR's ledger, or null when there is no collab on it yet
// target   the most sessions the keeper runs at once
// members    ids of the keeper's sessions whose process is still running
// reviewing  { session id: task } for running sessions started to review that task
// host       the agent that asked for the sessions and works alongside them, or null
// vendor     the vendor of the sessions' tool, which decides the reviews they may take
// files      files at the PR head, to expand scope globs the way `collab claim` does
// Returns { stop, start: [{ task, steal, review }], why, work, free }: `stop` is a reason to end
// the keeper (or null), `start` the sessions to start now, each for one task to claim (null: no
// task yet, the session starts or takes over the plan) or one to review, `work` how many pieces
// of work there are now and `free` how many agents are already free to take one.
export function sessionPlan(ledger, { target, members = [], reviewing = {}, host = null, vendor = null, now, files = [] } = {}) {
  const slots = Math.max(0, Number(target) - members.length);
  const none = (why, extra = {}) => ({ stop: null, start: [], why, work: 0, free: 0, ...extra });
  if (!ledger) {
    if (members.length) return none("a session is starting the collab");
    return slots ? { ...none("there is no collab yet: one session starts it and writes the plan"), start: [{ task: null, steal: false }] } : none("no session slots");
  }
  const n = ledger.pr?.number;
  if (ledger.phase === "closed") return { ...none(`the collab on PR #${n} is closed`), stop: "closed" };
  if (ledger.phase === "paused") return none(`the owner paused the collab on PR #${n}`);
  const at = ms(now);
  if (ledger.phase === "planning") {
    const p = ledger.planner;
    if (p?.agent && ms(p.leaseUntil) >= at) return none(`${p.agent} is writing the plan`);
    // The planner's lease ran out: one session takes over the plan, unless one is running already
    // or the planner is the agent that asked (it is still at it).
    if (members.length || (p?.agent && p.agent === host)) return none("waiting for the plan");
    return slots ? { ...none(`${p?.agent ?? "the planner"}'s planning lease ran out: one session takes over the plan`), start: [{ task: null, steal: false }] } : none("no session slots");
  }

  const T = ledger.tasks ?? {};
  const ids = taskIds(ledger);
  if (ids.length && ids.every((id) => isTerminal(T[id].status))) return { ...none(`every task on PR #${n} is done or cancelled`), stop: "done" };

  const { claimable } = claimableTasks(ledger, null, now, { files });
  // `collab next` offers a fix-ci task first, then id order.
  const ordered = [...claimable.filter((id) => T[id].kind === "fix-ci"), ...claimable.filter((id) => T[id].kind !== "fix-ci")];
  // Two open tasks whose scopes overlap can't both be built at once: once one is claimed, `claim`
  // refuses the other. A task reserved for a session that hasn't claimed it yet, and a task picked
  // earlier in this round, count as work in flight here.
  const reservedOpen = ids.filter((id) => T[id].status === "open" && T[id].reserved && ms(T[id].reserved.until) >= at);
  const overlaps = (id, others) => others.some((o) => o !== id && intersect(T[id].scope ?? [], [], T[o].scope ?? [], T[o].touched ?? [], files).length > 0);
  const open = [];
  for (const id of ordered) if (!overlaps(id, [...reservedOpen, ...open])) open.push(id);
  // The working agents: the running sessions and the one that asked. A task of theirs whose lease
  // ran out is still in their hands (they haven't pushed in a while), so it isn't work to hand out.
  // The agent that asked counts only while it is around: a free agent's `collab next` marks it seen
  // every 10 minutes, so one not seen for 30 has gone, and its share goes to a session.
  const hostHere = host && !members.includes(host) && ledger.agents?.[host]
    && (at - ms(ledger.agents[host].lastSeen) <= HOST_GONE_MIN * 60_000 || ids.some((id) => T[id].owner === host && WIP.has(T[id].status) && ms(T[id].leaseUntil) >= at));
  const working = [...members, ...(hostHere ? [host] : [])];
  const stale = ids.filter((id) => WIP.has(T[id].status) && !T[id].blocked && T[id].owner && !working.includes(T[id].owner) && !(ms(T[id].leaseUntil) >= at));
  // A review a session was started for, and hasn't claimed yet, is covered: that session takes it.
  const d = derive(ledger, now);
  const startingReview = new Map(Object.entries(reviewing).filter(([a, id]) => members.includes(a) && d.tasks[id]?.waitingReview).map(([a, id]) => [id, a]));
  const reviews = ids.filter((id) => !startingReview.has(id) && reviewTurn(ledger, d, id, null, vendor) !== null);
  const work = [
    ...reviews.map((review) => ({ task: null, steal: false, review })),
    ...open.map((task) => ({ task, steal: false })),
    ...stale.map((task) => ({ task, steal: true })),
  ];

  const wip = ledger.config?.wip ?? 1;
  const reservedFor = new Set(ids.filter((id) => T[id].status === "open" && T[id].reserved && ms(T[id].reserved.until) >= at).map((id) => T[id].reserved.agent));
  const inReview = new Set(ids.filter((id) => T[id].status === "in_review" && T[id].reviewer && ms(T[id].reviewLeaseUntil) >= at).map((id) => T[id].reviewer));
  const capacity = (agent) => {
    if (reservedFor.has(agent)) return 0; // its task is waiting for it
    if (inReview.has(agent) || [...startingReview.values()].includes(agent)) return 0; // it is reviewing, or about to
    const held = ids.filter((id) => T[id].owner === agent && WIP.has(T[id].status)).length;
    return Math.max(0, wip - held);
  };
  // A session that hasn't claimed yet counts as free: it was started for a piece of work.
  const left = new Map(working.map((a) => [a, capacity(a)]));
  const free = [...left.values()].reduce((sum, c) => sum + c, 0);
  // The free agents take work through `collab next`, reviews first, each only what it may take
  // (nobody reviews their own task). New sessions get what no free agent covers.
  const covered = (w) => {
    const a = working.find((x) => left.get(x) > 0 && (!w.review || reviewTurn(ledger, d, w.review, x) !== null));
    if (a) left.set(a, left.get(a) - 1);
    return !!a;
  };
  const uncovered = work.filter((w) => !covered(w));
  const start = uncovered.slice(0, slots);
  const label = (w) => (w.review ? `a review of ${w.review}` : w.task);
  let why;
  if (start.length) why = `${start.length} more session(s) can start: ${start.map(label).join(", ")}`;
  else if (!work.length) why = idleReason(ledger, d, ids, at);
  else if (uncovered.length && !slots) why = `all ${target} session(s) are running`;
  else why = `the agents already free can take ${work.map(label).join(", ")}`;
  return { stop: null, start, why, work: work.length, free };
}

// Why no task can start: what the open tasks, and the reviews held for another vendor, wait for.
function idleReason(ledger, d, ids, at) {
  const T = ledger.tasks;
  const open = ids.filter((id) => T[id].status === "open");
  const reserved = open.filter((id) => T[id].reserved && ms(T[id].reserved.until) >= at);
  const blocked = open.filter((id) => T[id].blocked);
  const waiting = open.filter((id) => !reserved.includes(id) && !blocked.includes(id));
  const parts = [];
  if (reserved.length) parts.push(`${reserved.join(", ")} reserved for invited agents`);
  if (waiting.length) parts.push(`${waiting.join(", ")} wait on dependencies or on overlapping work in flight`);
  if (blocked.length) parts.push(`${blocked.join(", ")} blocked`);
  const held = ids.filter((id) => d.tasks[id].waitingReview && !d.tasks[id].reviewOpen && !T[id].blocked);
  if (held.length) parts.push(`the review of ${held.join(", ")} goes to an agent from another vendor first`);
  return `no more tasks can start now${parts.length ? `: ${parts.join("; ")}` : ""}`;
}
