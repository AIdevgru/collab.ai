import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { addMinutes } from "../../skills/collab/lib/clock.mjs";
import { apply, newLedger } from "../../skills/collab/lib/ledger.mjs";
import { claimableTasks, nextAction } from "../../skills/collab/lib/next.mjs";
import { sessionPlan, sessionWork } from "../../skills/collab/lib/sessions.mjs";

// ---------------------------------------------------------------- fixtures (time is pinned)

const T0 = "2026-11-16T12:00:00.000Z";
const at = (min) => addMinutes(T0, min);
const PR = { repo: "o/r", number: 42, url: "https://github.com/o/r/pull/42", headRef: "feat/x", baseRef: "main", defaultBranch: "main", ghLogin: "zwymer", mergeMethod: "squash" };
const HOST = "claude-a1f3";
const S1 = "claude-s1s1";
const S2 = "claude-s2s2";
const S3 = "claude-s3s3";

const ev = (type, agent, task, data = {}, min = 1) => ({ type, agent, task, data, at: at(min) });
const run = (L, ...events) => events.reduce(apply, L);
const spec = (title, extra = {}) => ({ title, desc: "", accept: [], scope: [], deps: [], size: "S", ...extra });
const claim = (agent, task, min = 1, lease = 90) => ev("task.claim", agent, task, { leaseUntil: at(min + lease) }, min);
const reserve = (task, agent, min = 1) => ev("task.reserve", "owner", task, { for: agent, until: at(min + 120) }, min);
const join = (agent, tool = "claude") => ev("agent.join", agent, null, { tool });

const fresh = () => newLedger({ pr: PR, agent: { id: HOST, tool: "claude", host: "pc", pid: null }, now: T0 });
// T1, T2, T3 can start at once; T4 and T5 wait on T1. Scopes are disjoint.
const FIVE = [
  spec("core", { scope: ["src/core.mjs"] }), spec("strings", { scope: ["src/strings.mjs"] }), spec("docs", { scope: ["docs/**"] }),
  spec("cli", { scope: ["src/cli.mjs"], deps: ["T1"] }), spec("tests", { scope: ["test/**"], deps: ["T1"] }),
];
const planned = (tasks = FIVE) => run(fresh(), ev("plan", HOST, null, { tasks }));
const tasksOf = (r) => r.start.map((w) => (w.review ? `review ${w.review}` : w.steal ? `${w.task}!` : w.task));

describe("sessionPlan: before the plan", () => {
  test("no collab yet: one session starts it, and only one", () => {
    assert.deepEqual(sessionPlan(null, { target: 4, members: [], now: at(0) }).start, [{ task: null, steal: false }]);
    assert.deepEqual(sessionPlan(null, { target: 4, members: [S1], now: at(0) }).start, []);
  });
  test("planning: nothing starts while the planner's lease lasts", () => {
    const r = sessionPlan(fresh(), { target: 4, members: [], now: at(5) });
    assert.deepEqual(r.start, []);
    assert.match(r.why, new RegExp(`${HOST} is writing the plan`));
  });
  test("planning: a lapsed lease is taken over by one session, unless the planner is the agent that asked", () => {
    const late = at(60);
    assert.deepEqual(sessionPlan(fresh(), { target: 4, members: [], now: late }).start, [{ task: null, steal: false }]);
    assert.deepEqual(sessionPlan(fresh(), { target: 4, members: [S1], now: late }).start, []);
    assert.deepEqual(sessionPlan(fresh(), { target: 4, members: [], host: HOST, now: late }).start, []);
  });
});

describe("sessionPlan: how many start, and on what", () => {
  test("only as many as there are tasks that can start now", () => {
    const r = sessionPlan(planned(), { target: 5, members: [], now: at(5) });
    assert.deepEqual(tasksOf(r), ["T1", "T2", "T3"]);
    assert.equal(r.work, 3);
  });
  test("never more than the target", () => {
    assert.deepEqual(tasksOf(sessionPlan(planned(), { target: 2, members: [], now: at(5) })), ["T1", "T2"]);
  });
  test("the free agent that asked keeps the first task for itself", () => {
    const r = sessionPlan(planned(), { target: 3, members: [], host: HOST, now: at(5) });
    assert.deepEqual(tasksOf(r), ["T2", "T3"]);
    assert.equal(r.free, 1);
    // A busy host leaves nothing aside.
    const busy = run(planned(), claim(HOST, "T1", 2));
    assert.deepEqual(tasksOf(sessionPlan(busy, { target: 3, members: [], host: HOST, now: at(5) })), ["T2", "T3"]);
    assert.equal(sessionPlan(busy, { target: 3, members: [], host: HOST, now: at(5) }).free, 0);
  });
  test("a host that hasn't joined isn't counted", () => {
    assert.deepEqual(tasksOf(sessionPlan(planned(), { target: 3, members: [], host: "claude-zzzz", now: at(5) })), ["T1", "T2", "T3"]);
  });
  test("a running session that is free counts as an agent about to claim", () => {
    // S1 finished its task (it is in review), so it takes the next one through collab next. It
    // can't review its own task, so a session starts to review T1.
    const L = run(planned(), join(S1), claim(S1, "T1", 2));
    const freeS1 = run(L, ev("task.push", S1, "T1", { headSha: "a1", touched: [] }, 3), ev("task.verify", S1, "T1", { sha: "a1", ok: true, summary: "" }, 4), ev("task.submit", S1, "T1", { sha: "a1" }, 5));
    assert.deepEqual(tasksOf(sessionPlan(L, { target: 3, members: [S1], vendor: "anthropic", now: at(6) })), ["T2", "T3"]);
    assert.deepEqual(tasksOf(sessionPlan(freeS1, { target: 3, members: [S1], vendor: "anthropic", now: at(6) })), ["review T1", "T3"]);
  });
  test("reserved tasks are already covered: their session counts as busy, and the task isn't handed out again", () => {
    const L = run(planned(), reserve("T1", S1), reserve("T2", S2));
    const r = sessionPlan(L, { target: 5, members: [S1, S2], now: at(5) });
    assert.deepEqual(tasksOf(r), ["T3"]);
    assert.equal(r.free, 0);
    // A reservation that lapsed frees its task.
    assert.deepEqual(tasksOf(sessionPlan(L, { target: 5, members: [], now: at(200) })), ["T1", "T2", "T3"]);
  });
  test("tasks waiting on dependencies or overlapping work in flight don't start sessions", () => {
    const overlap = [spec("a", { scope: ["src/**"] }), spec("b", { scope: ["src/x.mjs"] }), spec("c", { deps: ["T1"] })];
    const L = run(planned(overlap), join(S1), claim(S1, "T1", 2));
    const r = sessionPlan(L, { target: 4, members: [S1], now: at(5) });
    assert.deepEqual(r.start, []);
    assert.match(r.why, /T2, T3 wait on dependencies or on overlapping work in flight/);
  });
  test("when a dependency is done or cancelled, its dependents start sessions", () => {
    const L = run(planned(), join(S1), join(S2), join(S3), claim(S1, "T1", 2), claim(S2, "T2", 2), claim(S3, "T3", 2));
    assert.deepEqual(sessionPlan(L, { target: 4, members: [S1, S2, S3], now: at(5) }).start, []);
    const cancelled = run(L, ev("task.cancel", S1, "T1", { reason: "not needed" }, 3));
    // S1 is free again and takes one; one more session starts for the other.
    assert.deepEqual(tasksOf(sessionPlan(cancelled, { target: 4, members: [S1, S2, S3], now: at(5) })), ["T5"]);
    assert.deepEqual(tasksOf(sessionPlan(cancelled, { target: 3, members: [S2, S3], now: at(5) })), ["T4"]);
    assert.deepEqual(tasksOf(sessionPlan(cancelled, { target: 4, members: [S2, S3], now: at(5) })), ["T4", "T5"]);
  });
  test("of two open tasks whose scopes overlap, only one starts a session at a time", () => {
    const overlap = [spec("a", { scope: ["src/**"] }), spec("b", { scope: ["src/x.mjs"] }), spec("c", { scope: ["docs/**"] })];
    assert.deepEqual(tasksOf(sessionPlan(planned(overlap), { target: 5, members: [], now: at(5) })), ["T1", "T3"]);
    // T1 reserved for a session that hasn't claimed it yet still counts as work in flight.
    const reserved = run(planned(overlap), reserve("T1", S1));
    assert.deepEqual(tasksOf(sessionPlan(reserved, { target: 5, members: [S1], now: at(5) })), ["T3"]);
  });
  test("an agent that asked but hasn't been seen for 30 minutes no longer holds a task back", () => {
    const one = [spec("a")];
    assert.deepEqual(tasksOf(sessionPlan(planned(one), { target: 3, members: [], host: HOST, now: at(20) })), []);
    assert.deepEqual(tasksOf(sessionPlan(planned(one), { target: 3, members: [], host: HOST, now: at(40) })), ["T1"]);
  });
  test("a review no free agent may take starts a session; one a free agent may take doesn't", () => {
    const L = run(planned(), join(S1), join(S2), claim(S1, "T1", 2), claim(S2, "T2", 2),
      ev("task.push", S1, "T1", { headSha: "a1", touched: [] }, 3), ev("task.verify", S1, "T1", { sha: "a1", ok: true, summary: "" }, 4), ev("task.submit", S1, "T1", { sha: "a1" }, 5));
    // S2 is busy on T2 and S1 owns T1: nobody free may review it.
    assert.deepEqual(tasksOf(sessionPlan(L, { target: 4, members: [S1, S2], vendor: "anthropic", now: at(6) })), ["review T1"]);
    // The free host may: it reviews T1, and S1, free too, takes T3.
    const r = sessionPlan(L, { target: 4, members: [S1, S2], host: HOST, vendor: "anthropic", now: at(6) });
    assert.deepEqual(tasksOf(r), []);
    assert.match(r.why, /the agents already free can take a review of T1, T3/);
    // A session started for the review, and still starting, covers it and isn't free.
    // Only S1 is free; it takes T3.
    const s3 = sessionPlan(L, { target: 4, members: [S1, S2, S3], reviewing: { [S3]: "T1" }, vendor: "anthropic", now: at(6) });
    assert.deepEqual(tasksOf(s3), []);
    assert.equal(s3.free, 1);
    assert.equal(s3.work, 1, "T3 alone: the review is covered");
    // Once S3 holds the review, it is busy until it gives a verdict.
    const held = run(L, join(S3), ev("review.claim", S3, "T1", { leaseUntil: at(66) }, 7));
    const h = sessionPlan(held, { target: 4, members: [S1, S2, S3], vendor: "anthropic", now: at(8) });
    assert.deepEqual(tasksOf(h), []);
    assert.equal(h.free, 1);
    // Without S1, T3 needs a new session.
    assert.deepEqual(tasksOf(sessionPlan(held, { target: 4, members: [S2, S3], vendor: "anthropic", now: at(8) })), ["T3"]);
  });
  test("a review held for another vendor starts no session of the owner's vendor until it opens", () => {
    const CX = "codex-cx01";
    const submitted = [ev("task.push", S1, "T1", { headSha: "a1", touched: [] }, 3), ev("task.verify", S1, "T1", { sha: "a1", ok: true, summary: "" }, 4), ev("task.submit", S1, "T1", { sha: "a1" }, 5)];
    // Codex has joined and holds nothing, so it is free; another Claude agent builds T2.
    const L = run(planned(), join(S1), join(CX, "codex"), claim(S1, "T1", 2), claim(HOST, "T2", 2), ...submitted, claim(S1, "T3", 6));
    // Codex is around and free, so T1's review is Codex's for 10 minutes from the submit.
    assert.deepEqual(tasksOf(sessionPlan(L, { target: 4, members: [S1], vendor: "anthropic", now: at(7) })), []);
    assert.match(sessionPlan(L, { target: 4, members: [S1], vendor: "anthropic", now: at(7) }).why, /the review of T1 goes to an agent from another vendor first/);
    assert.deepEqual(tasksOf(sessionPlan(L, { target: 4, members: [S1], vendor: "anthropic", now: at(16) })), ["review T1"]);
    // A Codex keeper may start a session for it at once.
    assert.deepEqual(tasksOf(sessionPlan(L, { target: 4, members: [], vendor: "openai", now: at(7) })), ["review T1"]);
  });
  test("a review waits for no agent of another vendor that is busy building its own task", () => {
    const CX = "codex-cx01";
    const submitted = [ev("task.push", S1, "T1", { headSha: "a1", touched: [] }, 3), ev("task.verify", S1, "T1", { sha: "a1", ok: true, summary: "" }, 4), ev("task.submit", S1, "T1", { sha: "a1" }, 5)];
    const L = run(planned(), join(S1), join(CX, "codex"), claim(S1, "T1", 2), claim(CX, "T2", 2), ...submitted, claim(S1, "T3", 6));
    // Codex is building T2, and `collab next` has it finish that first: T1's review opens now.
    assert.deepEqual(tasksOf(sessionPlan(L, { target: 4, members: [S1], vendor: "anthropic", now: at(7) })), ["review T1"]);
    // A blocked task doesn't keep its owner busy: Codex is free for the review, so it waits again.
    const blocked = run(L, ev("task.block", CX, "T2", { reason: "which API?", needsOwner: true }, 6));
    assert.deepEqual(tasksOf(sessionPlan(blocked, { target: 4, members: [S1], vendor: "anthropic", now: at(7) })), []);
  });
  test("a fix-ci task goes first", () => {
    const L = run(planned(), ev("task.add", HOST, null, { title: "Fix CI", desc: "", accept: [], scope: [], deps: [], size: "S", kind: "fix-ci", forSha: "abc" }, 2));
    assert.deepEqual(tasksOf(sessionPlan(L, { target: 2, members: [], now: at(5) })), ["T6", "T1"]);
  });
});

describe("sessionPlan: sessions that stop mid-task", () => {
  test("a task whose owner's lease ran out is taken over with --steal", () => {
    const L = run(planned(), join(S1), claim(S1, "T1", 2, 10));
    // S1 is gone (not a running member): its lease ran out at minute 12.
    assert.deepEqual(tasksOf(sessionPlan(L, { target: 5, members: [], now: at(20) })), ["T2", "T3", "T1!"]);
    // While S1 still runs, its task stays with it, even with the lease run out.
    assert.deepEqual(tasksOf(sessionPlan(L, { target: 5, members: [S1], now: at(20) })), ["T2", "T3"]);
  });
  test("a blocked task is not taken over by a new session", () => {
    const L = run(planned([spec("a"), spec("b")]), join(S1), join(S2), claim(S1, "T1", 2, 10), claim(S2, "T2", 2, 10));
    const blocked = run(L, ev("task.block", S1, "T1", { reason: "?", needsOwner: true }, 3));
    assert.deepEqual(tasksOf(sessionPlan(blocked, { target: 5, members: [], now: at(20) })), ["T2!"]);
  });
});

describe("sessionPlan: when to stop", () => {
  test("closed stops the keeper; paused only holds it", () => {
    const C = apply(planned(), ev("phase.set", "owner", null, { phase: "closed" }));
    assert.equal(sessionPlan(C, { target: 3, members: [], now: at(5) }).stop, "closed");
    const P = apply(planned(), ev("directive", "owner", null, { commentId: 3, login: "zwymer", cmd: "pause" }));
    const r = sessionPlan(P, { target: 3, members: [], now: at(5) });
    assert.equal(r.stop, null);
    assert.deepEqual(r.start, []);
    assert.match(r.why, /paused/);
  });
  test("every task done or cancelled stops the keeper", () => {
    const L = run(planned([spec("a"), spec("b")]), ev("task.cancel", HOST, "T1", { reason: "x" }, 2), ev("task.cancel", HOST, "T2", { reason: "x" }, 2));
    assert.equal(sessionPlan(L, { target: 3, members: [], now: at(5) }).stop, "done");
  });
});

describe("claimableTasks", () => {
  test("is what next offers: an agent's own work in flight never blocks it, reservations for others do", () => {
    const L = run(planned([spec("a", { scope: ["src/**"] }), spec("b", { scope: ["src/x.mjs"] }), spec("c")]), join(S1), claim(HOST, "T1", 2), reserve("T3", S1, 2));
    assert.deepEqual(claimableTasks(L, HOST, at(5)).claimable, ["T2"]);
    assert.deepEqual(claimableTasks(L, S1, at(5)).claimable, ["T3"]);
    assert.deepEqual(claimableTasks(L, null, at(5)), { open: ["T2"], claimable: [] });
    // next still picks the same task it did before the helper existed.
    assert.equal(nextAction(L, S1, null, at(5)).task, "T3");
  });
});

// collab status shows what each session works on now. Found by the real-Claude run: a session
// started for T2 went on to T3, and status still said "(T2)".
describe("sessionWork", () => {
  const L = (tasks) => ({ tasks });
  const m = { id: "claude-s1", task: "T2" };
  test("the task it builds now, not the one it was started for", () => {
    const l = L({ T2: { status: "done", owner: "claude-s1" }, T3: { status: "claimed", owner: "claude-s1" } });
    assert.deepEqual(sessionWork(l, m), { task: "T3", steal: false });
  });
  test("a review it holds, then its own task waiting in review", () => {
    const l = L({ T1: { status: "in_review", owner: "claude-x", reviewer: "claude-s1" }, T2: { status: "in_review", owner: "claude-s1", reviewer: null } });
    assert.deepEqual(sessionWork(l, m), { task: null, steal: false, review: "T1" });
    l.tasks.T1.status = "approved";
    assert.deepEqual(sessionWork(l, m), { task: "T2", steal: false });
  });
  test("before it takes anything: what it was started for", () => {
    assert.deepEqual(sessionWork(L({ T2: { status: "open", reserved: { agent: "claude-s1" } } }), m), { task: "T2", steal: false });
    assert.deepEqual(sessionWork(L({ T2: { status: "claimed", owner: "claude-gone" } }), { ...m, steal: true }), { task: "T2", steal: true });
    assert.deepEqual(sessionWork(L({ T1: { status: "in_review", owner: "claude-x", reviewer: null } }), { id: "claude-s1", review: "T1" }), { task: null, steal: false, review: "T1" });
    assert.deepEqual(sessionWork(L({}), { id: "claude-s1" }), { task: null, steal: false }, "the session that writes the plan");
  });
  test("its work merged, it waits for more", () => {
    assert.deepEqual(sessionWork(L({ T2: { status: "done", owner: "claude-s1" } }), m), { task: null, steal: false, idle: true });
    assert.deepEqual(sessionWork(L({ T1: { status: "done", owner: "claude-x" } }), { id: "claude-s1", review: "T1" }), { task: null, steal: false, idle: true });
  });
});
