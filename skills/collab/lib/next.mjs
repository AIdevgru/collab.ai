// The single next action for one agent. Pure: the CLI passes the ledger, the agent id, the
// live GitHub snapshot (or null when offline) and the time.
//
// Priority (docs/design.md, "next priority"), with "finish before starting" for work already
// in hand:
//   1. fix     my task: a sub-PR conflict, red sub-PR CI, or changes requested
//   2. merge   my approved task (not while the main PR's CI is red, except a fix-ci task)
//   3. review  a review I already hold
//   4. work    my claimed task: push, verify, submit
//   5. review  a task waiting for a reviewer: another vendor's first; one of my own vendor's
//              once no agent from another vendor is free to take it, or after reviewWaitMin
//   6. claim   the first claimable open task (fix-ci tasks first, then the longest chain of
//              work that waits on it, then id order)
//   7. merge / reclaim  a stale task: merge it if approved and green, otherwise steal it
//   8. done or wait

import { ciAt, ciMode, derive, isTerminal, reviewTurn, taskIds, touchesWorkflows, unmetDeps, verified } from "./ledger.mjs";
import { intersect } from "./glob.mjs";

const IN_FLIGHT = new Set(["claimed", "changes_requested", "in_review", "approved"]);
const WIP_STATUSES = new Set(["claimed", "changes_requested"]);
const WAIT = ["wait", "--timeout", "9m"];

const ms = (t) => (t instanceof Date ? t.getTime() : typeof t === "number" ? t : Date.parse(t));
const short = (sha) => (sha ? String(sha).slice(0, 7) : "?");

function ciOf(value) {
  switch (value) {
    case "SUCCESS": return "SUCCESS";
    case "FAILURE": case "ERROR": return "FAILURE";
    case "PENDING": case "EXPECTED": return "PENDING";
    case "NONE": return "NONE";
    default: return "UNKNOWN";
  }
}

// Accepts github.liveSnapshot output ({ ok, main: { ci }, subs }) or the flattened
// { mainCi, mainMergeable, subs }. null or ok:false means offline: every CI is UNKNOWN.
function readLive(live) {
  if (!live || live.ok === false) return { mainCi: "UNKNOWN", subs: {} };
  return { mainCi: ciOf(live.mainCi ?? live.main?.ci), subs: live.subs ?? {} };
}

// Live data for a task's sub-PR. A snapshot taken at another head SHA says nothing about now.
function subOf(lv, id, t) {
  const s = lv.subs[id];
  if (!s || (s.headSha && t.headSha && s.headSha !== t.headSha)) return { ci: "UNKNOWN", mergeable: "UNKNOWN" };
  return { ci: ciOf(s.ci), mergeable: s.mergeable ?? "UNKNOWN" };
}

// CI's summary is written by whichever agent read it: quoted, so it can't pass for collab's words.
const quoted = (v) => `"${String(v ?? "").replace(/\s+/g, " ").replace(/"/g, "'").slice(0, 300)}"`;
const latest = (t, verdict) => (t.reviews ?? []).filter((r) => r.verdict === verdict).at(-1) ?? null;

// The next command in the push -> verify -> submit chain for a task I own. With CI running the
// tests, a task is submitted as soon as its CI runs: the review goes on alongside it.
function chain(L, t, id, c) {
  if (!t.headSha) return c("push", id);
  if (verified(L, t)) return c("submit", id);
  return ciMode(L) && ciAt(t)?.state === "running" ? c("submit", id) : c("verify", id);
}

// With the tests on CI: CI failed at the head. Tests missing: nothing has verified the head, and
// nothing runs them there yet. With the tests on CI that is a task with no CI at its head; on the
// machines it is an approved task (approved before the owner moved the tests back from CI, or
// waived after a push), since in review its reviewer runs them.
const ciFailed = (L, t) => ciMode(L) && ciAt(t)?.state === "failed" && !verified(L, t);
const testsMissing = (L, t) => !!t.headSha && !verified(L, t)
  && (ciMode(L) ? !ciAt(t) : t.status === "approved");

function mergeable(L, t, sub, frozen) {
  if (t.status !== "approved" || t.blocked) return false;
  if (latest(t, "approve")?.sha !== t.headSha) return false;
  if (frozen && t.kind !== "fix-ci") return false;
  if (sub.mergeable === "CONFLICTING") return false;
  // The tests have to have passed at the head (on CI, or with collab verify on a machine),
  // whatever other checks the sub-PR shows.
  if (!verified(L, t)) return false;
  return sub.ci === "SUCCESS" || sub.ci === "NONE" || sub.ci === "UNKNOWN";
}

export function nextAction(ledger, me, live, now, { files = [] } = {}) {
  const L = ledger;
  const n = L.pr?.number;
  const c = (...args) => ["collab", ...args, "--agent", me];
  const T = L.tasks ?? {};
  const say = (action, task, why, cmd) => (task ? { action, task, why, cmd } : { action, why, cmd });

  if (L.phase === "closed") return say("closed", null, `collab is closed on PR #${n}; stop work on it`, c("status"));
  if (!L.agents?.[me]) return say("join", null, `you (${me}) have not joined PR #${n}; join first`, c("join", String(L.pr?.url ?? n)));
  if (L.phase === "paused") return say("paused", null, `the owner paused collab on PR #${n}; stop and wait until they run collab resume`, c(...WAIT));

  if (L.phase === "planning") {
    const p = L.planner;
    const cap = L.config?.maxTasks ?? 12;
    if (!p || p.agent === me) {
      return say("plan", null, `you hold the planner lease for PR #${n}: run collab context, write tasks.json (at most ${cap} tasks), then run this`, c("plan", "--tasks", "tasks.json"));
    }
    if (ms(p.leaseUntil) < ms(now)) {
      return say("plan", null, `${p.agent}'s planner lease expired; take over: run collab context, write tasks.json (at most ${cap} tasks), then run this`, c("plan", "--tasks", "tasks.json"));
    }
    return say("wait-plan", null, `${p.agent} is planning PR #${n} (lease until ${p.leaseUntil})`, c(...WAIT));
  }

  const d = derive(L, now);
  const lv = readLive(live);
  const frozen = lv.mainCi === "FAILURE";
  const ids = taskIds(L);
  const mine = ids.filter((id) => T[id].owner === me && !isTerminal(T[id].status) && !T[id].blocked);

  // 1. Fix my own tasks.
  for (const id of mine) {
    const t = T[id];
    const sub = subOf(lv, id, t);
    const pr = t.subPr ? `sub-PR #${t.subPr}` : "sub-PR";
    if (sub.mergeable === "CONFLICTING") {
      return say("fix", id, `${id}'s ${pr} conflicts with ${L.pr?.headRef ?? "the PR head"}: run this, resolve the conflicts, then collab push ${id}`, c("sync", id));
    }
    // The CI collab started says more (which workflow, its link, how to rerun) than the sub-PR's
    // checks, which include those same runs; and while it runs again, an older failure there is moot.
    const ci = ciMode(L) ? ciAt(t) : null;
    if (ciFailed(L, t)) {
      return say("fix", id, `CI failed on ${id} at ${short(t.headSha)}: ${quoted(ci.summary)}. Fix it, then run this (if it is only flaky, collab verify ${id} runs it again)`, c("push", id));
    }
    if (sub.ci === "FAILURE" && ci?.state !== "running") {
      return say("fix", id, `CI is failing on ${id}'s ${pr} at ${short(t.headSha)}: fix it, then run this`, c("push", id));
    }
    if (t.status === "changes_requested") {
      const asked = latest(t, "changes");
      const cmd = asked && asked.sha === t.headSha ? c("push", id) : chain(L, t, id, c);
      return say("fix", id, `the reviewer requested changes on ${id}: address them, then collab push / verify / submit`, cmd);
    }
  }

  // 2. Merge my approved tasks.
  for (const id of mine) {
    const t = T[id];
    if (mergeable(L, t, subOf(lv, id, t), frozen)) return say("merge", id, `${id} is approved at ${short(t.headSha)} and green: merge it`, c("merge", id));
  }

  // 3. Finish a review I already hold.
  for (const id of ids) {
    const t = T[id];
    if (t.status !== "in_review" || t.reviewer !== me || t.blocked) continue;
    if (t.reviewSha && t.reviewSha !== t.headSha) {
      return say("review", id, `${t.owner} pushed ${short(t.headSha)} while you were reviewing ${id} at ${short(t.reviewSha)}: run this to check out the new commit, then review it`, c("review-claim", id));
    }
    if (ciFailed(L, t)) {
      return say("review", id, `CI failed on ${id} at ${short(t.headSha)} (${quoted(ciAt(t).summary)}): write review.md with that and anything else you found, then run this so ${t.owner} fixes it`, c("review", id, "--changes", "--body-file", "review.md"));
    }
    return say("review", id, `you are reviewing ${id} at ${short(t.headSha)}: read the diff, write review.md, then run this (or swap --approve for --changes)`, c("review", id, "--approve", "--body-file", "review.md"));
  }

  // 4. Keep working on my claimed task. A task of mine in review or approved whose tests have not
  // run at its head (I pushed after submitting, the owner waived the review, or the owner moved the
  // tests) gets them run: nobody can merge it until they pass there.
  for (const id of mine) {
    if (T[id].status === "claimed") return say("work", id, `keep working on ${id}, then collab push / verify / submit`, chain(L, T[id], id, c));
    const t = T[id];
    if ((t.status === "in_review" || t.status === "approved") && testsMissing(L, t)) {
      const missing = !ciMode(L) ? "its tests have not passed on that commit: run them"
        : touchesWorkflows(t).length ? "its tests have not run on that commit (it changes a workflow, so they run on this machine): run them"
          : "no CI has run on that commit: start it";
      return say("work", id, `${id} is ${t.status === "approved" ? "approved" : "in review"} at ${short(t.headSha)}, and ${missing}`, c("verify", id));
    }
  }

  // 5. Review a task: another vendor's first, then one of my own vendor's that is open to me.
  for (const turn of ["preferred", "open"]) {
    const id = ids.find((k) => reviewTurn(L, d, k, me) === turn);
    if (!id) continue;
    const why = turn === "preferred" ? `${id} by ${T[id].owner} waits for a review, and you are from another vendor: claim it`
      : `${id} by ${T[id].owner} waits for a review${d.tasks[id].preferredReviewers.length ? ", and no agent from another vendor has taken it" : ""}: claim it`;
    return say("review", id, why, c("review-claim", id));
  }

  // 6. Claim a task.
  const held = ids.filter((id) => T[id].owner === me && WIP_STATUSES.has(T[id].status)).length;
  const wipFree = held < (L.config?.wip ?? 1);
  const { open, claimable } = claimableTasks(L, me, now, { files });
  if (wipFree && claimable.length) {
    const id = claimable.find((k) => T[k].reserved?.agent === me) ?? claimable.find((k) => T[k].kind === "fix-ci") ?? claimable[0];
    const why = T[id].reserved?.agent === me ? `the owner reserved ${id} for you: claim it`
      : T[id].kind === "fix-ci" ? `${id} fixes the main PR's red CI: claim it` : `${id} is open and its dependencies are done: claim it`;
    return say("claim", id, why, c("claim", id));
  }

  // 7. A stale task: merge it if it is approved and green, otherwise take it over.
  for (const id of ids) {
    const t = T[id];
    if (!d.tasks[id].stale || t.owner === me || t.blocked) continue;
    const sub = subOf(lv, id, t);
    if (t.status === "approved") {
      if (mergeable(L, t, sub, frozen)) return say("merge", id, `${id} is approved and green, but ${t.owner}'s lease expired: merge it`, c("merge", id));
      // Stealing clears the approval, so only do it when the task needs a fix, or tests only its
      // owner could start.
      if (sub.ci !== "FAILURE" && sub.mergeable !== "CONFLICTING" && !ciFailed(L, t) && !testsMissing(L, t)) continue;
    }
    if (wipFree) return say("reclaim", id, `${t.owner}'s lease on ${id} expired at ${t.leaseUntil}: take it over`, c("claim", id, "--steal"));
  }

  // 8. Done or wait.
  if (ids.every((id) => isTerminal(T[id].status))) {
    // The last word on the dashboard (Ready, or what blocks it) needs CI's result, and a waiting
    // agent re-renders it when CI finishes. Offline (UNKNOWN) is not worth waiting for.
    if (lv.mainCi === "PENDING") return say("wait", null, `every task on PR #${n} is done; CI on the main PR is still running: wait for it so the dashboard shows the result`, c(...WAIT));
    return say("done", null, `every task on PR #${n} is done or cancelled; the owner reviews the main PR`, c("status"));
  }
  return say("wait", null, waitReason(L, me, ids, d, frozen, open, claimable, wipFree, now), c(...WAIT));
}

// The open tasks `me` could claim now. `open`: not blocked, dependencies done, not reserved for
// another agent. `claimable`: of those, the ones whose scope overlaps no other agent's work in
// flight (the rule `collab claim` applies: my own in-flight tasks never block me). In critical-path
// order (see criticalRanks). With `me` null, it is the view of an agent that hasn't joined yet
// (collab invite --sessions): every reservation and every task in flight counts.
export function claimableTasks(ledger, me, now, { files = [] } = {}) {
  const T = ledger.tasks ?? {};
  const ids = taskIds(ledger);
  const inFlight = ids.filter((id) => IN_FLIGHT.has(T[id].status) && (me === null || T[id].owner !== me));
  const overlaps = (id) => inFlight.some((o) => o !== id && intersect(T[id].scope ?? [], [], T[o].scope ?? [], T[o].touched ?? [], files).length > 0);
  const rank = criticalRanks(ledger);
  const order = new Map(ids.map((id, i) => [id, i]));
  const open = ids
    .filter((id) => T[id].status === "open" && !T[id].blocked && unmetDeps(ledger, T[id]).length === 0 && !reservedForOther(T[id], me, now))
    .sort((a, b) => rank.get(b) - rank.get(a) || order.get(a) - order.get(b));
  return { open, claimable: open.filter((id) => !overlaps(id)) };
}

// Critical-path ranks for the unfinished tasks, so the work that holds up the most other work starts
// first (list scheduling). A task weighs its size (S 1, M 2, L 3); its rank is its weight plus the
// highest rank among the unfinished tasks that wait on it. A task that depends on a cancelled one
// waits on that task's own dependencies instead (unmetDeps), and done tasks hold up nothing.
const WEIGHT = { S: 1, M: 2, L: 3 };
export function criticalRanks(ledger) {
  const T = ledger.tasks ?? {};
  const ids = taskIds(ledger).filter((id) => !isTerminal(T[id].status));
  const waiting = new Map(ids.map((id) => [id, []]));
  for (const id of ids) for (const dep of unmetDeps(ledger, T[id])) waiting.get(dep)?.push(id);
  const rank = new Map();
  const visit = (id, path) => {
    if (rank.has(id)) return rank.get(id);
    if (path.has(id)) return 0; // a dependency cycle: plan refuses one, but never loop on it
    path.add(id);
    const r = (WEIGHT[T[id].size] ?? WEIGHT.M) + Math.max(0, ...waiting.get(id).map((w) => visit(w, path)));
    path.delete(id);
    rank.set(id, r);
    return r;
  };
  for (const id of ids) visit(id, new Set());
  return rank;
}

// An open task the owner set aside for another agent they invited (collab invite --task).
function reservedForOther(t, me, now) {
  const r = t.reserved;
  return Boolean(r && r.agent !== me && ms(r.until) >= ms(now));
}

function waitReason(L, me, ids, d, frozen, open, claimable, wipFree, now) {
  const T = L.tasks;
  const parts = [];
  const mine = ids.filter((id) => T[id].owner === me && !isTerminal(T[id].status));
  for (const id of mine) {
    const t = T[id];
    const ciRuns = ciMode(L) && ciAt(t)?.state === "running" ? ` (its CI is running at ${short(t.headSha)})` : "";
    if (t.blocked) parts.push(`${id} is blocked: ${t.blocked.reason}`);
    else if (t.status === "in_review") parts.push((d.tasks[id].eligibleReviewers.length ? `${id} waits for a review` : `${id} needs a reviewer: another agent has to join`) + ciRuns);
    else if (t.status === "approved") parts.push(frozen && t.kind !== "fix-ci" ? `${id} is approved, but merges are frozen while the main PR's CI is red` : `${id} is approved and waits for green CI${ciRuns}`);
  }
  if (!wipFree && open.length) parts.push("you are at the WIP limit");
  else if (open.length > claimable.length) parts.push(`${open.length - claimable.length} open task(s) overlap work in flight`);
  const waitingDeps = ids.filter((id) => T[id].status === "open" && !T[id].blocked && unmetDeps(L, T[id]).length > 0);
  if (waitingDeps.length) parts.push(`${waitingDeps.join(", ")} wait on dependencies`);
  const reserved = ids.filter((id) => T[id].status === "open" && reservedForOther(T[id], me, now));
  if (reserved.length) parts.push(reserved.map((id) => `${id} is reserved for ${T[id].reserved.agent}`).join(", "));
  // Reviews another vendor gets first: say when they open to me, so the wait isn't a mystery.
  const held = ids.filter((id) => d.tasks[id].eligibleReviewers.includes(me) && d.tasks[id].waitingReview && !d.tasks[id].reviewOpen && !T[id].blocked);
  if (held.length) parts.push(held.map((id) => `${id}'s review goes to an agent from another vendor first, until ${d.tasks[id].reviewOpenAt}`).join(", "));
  const others = ids.filter((id) => T[id].owner && T[id].owner !== me && IN_FLIGHT.has(T[id].status));
  if (others.length) parts.push(`${others.length} task(s) in flight with other agents`);
  return `nothing to do right now${parts.length ? ": " + parts.join("; ") : ""}`;
}
