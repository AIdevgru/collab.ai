import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { addMinutes } from "../../skills/collab/lib/clock.mjs";
import { CollabError, EXIT } from "../../skills/collab/lib/errors.mjs";
import {
  PHASES, SCHEMA, STATUSES, VENDORS, apply, cancelledDeps, ciAt, ciMode, derive, isTerminal, newLedger, taskIds, touchesWorkflows, unmetDeps, vendorOf, verified,
} from "../../skills/collab/lib/ledger.mjs";

// ---------------------------------------------------------------- fixtures (time is pinned)

const T0 = "2026-11-16T12:00:00.000Z";
const at = (min) => addMinutes(T0, min);
const PR = { repo: "o/r", number: 42, url: "https://github.com/o/r/pull/42", headRef: "feat/x", baseRef: "main", defaultBranch: "main", ghLogin: "zwymer", mergeMethod: "squash" };
const CLAUDE = "claude-a1f3";
const CODEX = "codex-7k2p";
const CLAUDE2 = "claude-b2c4";
const GEMINI = "gemini-9z9z";

const ev = (type, agent, task, data = {}, min = 1) => ({ type, agent, task, data, at: at(min) });
const run = (L, ...events) => events.reduce(apply, L);
const spec = (title, extra = {}) => ({ title, desc: "", accept: [], scope: [], deps: [], size: "S", ...extra });
const DEFAULT_TASKS = [spec("one"), spec("two"), spec("three", { deps: ["T1"] }), spec("four")];

const claim = (agent, task, min = 1, extra = {}) => ev("task.claim", agent, task, { leaseUntil: at(min + 90), ...extra }, min);
const steal = (agent, task, min) => claim(agent, task, min, { steal: true });
const push = (agent, task, sha, min = 2, extra = {}) => ev("task.push", agent, task, { headSha: sha, touched: [], ...extra }, min);
const verify = (agent, task, sha, ok = true, min = 3) => ev("task.verify", agent, task, { sha, ok, summary: ok ? "1 passed" : "1 failed" }, min);
const submit = (agent, task, sha, min = 4) => ev("task.submit", agent, task, { sha }, min);
const rclaim = (agent, task, min = 5) => ev("review.claim", agent, task, { leaseUntil: at(min + 60) }, min);
const verdict = (agent, task, v, sha, min = 6) => ev("review.verdict", agent, task, { verdict: v, sha, commentId: 900 + min }, min);
const merge = (agent, task, sha, min = 7) => ev("task.merge", agent, task, { sha }, min);

function fresh(config) {
  return newLedger({ pr: PR, config, agent: { id: CLAUDE, tool: "claude", host: "pc", pid: null }, now: T0 });
}
function planned(tasks = DEFAULT_TASKS, config) {
  return run(
    fresh(config),
    ev("agent.join", CODEX, null, { tool: "codex", host: "pc", pid: 7 }),
    ev("agent.join", CLAUDE2, null, { tool: "claude" }),
    ev("plan", CLAUDE, null, { tasks }),
  );
}

// T1 owned by CLAUDE (and reviewed by CODEX) in the given state.
function state(status, L = planned()) {
  if (status === "open") return L;
  if (status === "cancelled") return run(L, ev("task.cancel", CLAUDE, "T1", { reason: "x" }));
  L = run(L, claim(CLAUDE, "T1", 1));
  if (status === "claimed") return L;
  L = run(L, push(CLAUDE, "T1", "sha1", 2), verify(CLAUDE, "T1", "sha1", true, 3), submit(CLAUDE, "T1", "sha1", 4));
  if (status === "in_review") return L;
  L = run(L, rclaim(CODEX, "T1", 5));
  if (status === "reviewing") return L;
  if (status === "changes_requested") return run(L, verdict(CODEX, "T1", "changes", "sha1", 6));
  L = run(L, verdict(CODEX, "T1", "approve", "sha1", 6));
  if (status === "approved") return L;
  if (status === "done") return run(L, merge(CLAUDE, "T1", "sha1", 7));
  throw new Error(`no fixture for ${status}`);
}

function refused(fn, code = EXIT.PRECONDITION, re) {
  assert.throws(fn, (e) => {
    assert.ok(e instanceof CollabError, `expected CollabError, got ${e}`);
    assert.equal(e.code, code, `wrong exit code for: ${e.message}`);
    if (re) assert.match(e.message, re);
    return true;
  });
}

function deepFreeze(o) {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

// ---------------------------------------------------------------- constants and helpers

describe("exports", () => {
  test("constants", () => {
    assert.equal(SCHEMA, 2, "the newest schema understood; 2 runs the tests on CI");
    assert.deepEqual([...STATUSES], ["open", "claimed", "in_review", "changes_requested", "approved", "done", "cancelled"]);
    assert.deepEqual([...PHASES], ["planning", "active", "paused", "closed"]);
    assert.deepEqual({ ...VENDORS }, { claude: "anthropic", codex: "openai", gemini: "google", grok: "xai", other: "other" });
  });
  test("vendorOf", () => {
    for (const [tool, vendor] of Object.entries(VENDORS)) assert.equal(vendorOf(tool), vendor);
    assert.equal(vendorOf("mystery"), "other");
    assert.equal(vendorOf("toString"), "other");
  });
  test("taskIds sorts numerically", () => {
    assert.deepEqual(taskIds({ tasks: { T10: {}, T2: {}, T1: {} } }), ["T1", "T2", "T10"]);
    assert.deepEqual(taskIds({}), []);
  });
  test("isTerminal", () => {
    for (const s of STATUSES) assert.equal(isTerminal(s), s === "done" || s === "cancelled", s);
  });
});

describe("newLedger", () => {
  test("starts in planning with the planner lease and the agent registered", () => {
    const L = fresh();
    assert.equal(L.schema, 1);
    assert.equal(L.seq, 0);
    assert.equal(L.rev, null);
    assert.equal(L.phase, "planning");
    assert.deepEqual(L.planner, { agent: CLAUDE, leaseUntil: at(15) });
    assert.deepEqual(L.agents[CLAUDE], { tool: "claude", vendor: "anthropic", host: "pc", pid: null, joinedAt: T0, lastSeen: T0 });
    assert.deepEqual(L.pr, PR);
    assert.deepEqual(L.tasks, {});
    assert.equal(L.nextTask, 1);
    assert.deepEqual(L.directives, []);
    assert.equal(L.lastCommentId, 0);
    assert.deepEqual(L.notices, {});
  });
  test("default config, overridable", () => {
    assert.deepEqual(fresh().config, { leaseMin: 90, reviewLeaseMin: 60, planLeaseMin: 15, reviewAlertH: 2, reviewWaitMin: 10, maxTasks: 12, wip: 1, worktreeRoot: ".collab/wt", verify: "local", verifyCmd: null, setupCmd: null });
    const L = fresh({ leaseMin: 2, planLeaseMin: 5, verifyCmd: ["npm", "test"], wip: undefined });
    assert.equal(L.config.leaseMin, 2);
    assert.equal(L.config.wip, 1);
    assert.deepEqual(L.config.verifyCmd, ["npm", "test"]);
    assert.equal(L.planner.leaseUntil, at(5));
  });
  test("accepts a Date for now", () => {
    const L = newLedger({ pr: PR, agent: { id: CLAUDE, tool: "claude" }, now: new Date(T0) });
    assert.equal(L.agents[CLAUDE].joinedAt, T0);
  });
  test("refuses a missing or reserved agent id", () => {
    assert.throws(() => newLedger({ pr: PR, agent: {}, now: T0 }), TypeError);
    assert.throws(() => newLedger({ pr: PR, agent: { id: "owner", tool: "claude" }, now: T0 }), TypeError);
  });
});

// ---------------------------------------------------------------- apply: general rules

describe("apply: general", () => {
  test("never mutates its input, even a deeply frozen one", () => {
    const L = deepFreeze(state("reviewing"));
    const before = JSON.stringify(L);
    const event = deepFreeze(verdict(CODEX, "T1", "approve", "sha1", 6));
    const out = apply(L, event);
    assert.equal(JSON.stringify(L), before);
    assert.notEqual(out, L);
    assert.equal(out.tasks.T1.status, "approved");
    assert.equal(L.tasks.T1.status, "in_review");
    out.tasks.T1.reviews.push("x");
    out.agents[CODEX].tool = "y";
    assert.equal(JSON.stringify(L), before);
  });
  test("does not keep references to event data", () => {
    const data = { tasks: [spec("a", { scope: ["src/**"] })] };
    const L = apply(fresh(), { type: "plan", agent: CLAUDE, data, at: at(1) });
    data.tasks[0].scope.push("lib/**");
    assert.deepEqual(L.tasks.T1.scope, ["src/**"]);
  });
  test("bumps seq by one and updates the actor's lastSeen", () => {
    const L = planned();
    const out = apply(L, claim(CODEX, "T2", 30));
    assert.equal(out.seq, L.seq + 1);
    assert.equal(out.agents[CODEX].lastSeen, at(30));
    assert.equal(out.agents[CLAUDE].lastSeen, L.agents[CLAUDE].lastSeen);
  });
  test("an owner event touches no agent", () => {
    const L = state("in_review");
    const out = apply(L, ev("review.waive", "owner", "T1", {}, 9));
    assert.deepEqual(out.agents, L.agents);
  });
  test("every event but agent.join needs a known agent", () => {
    refused(() => apply(planned(), claim("ghost-0000", "T1")), EXIT.PRECONDITION, /ghost-0000 .*has not joined/);
    refused(() => apply(planned(), ev("agent.seen", undefined, null)), EXIT.PRECONDITION, /has not joined/);
    assert.equal(apply(planned(), ev("agent.join", GEMINI, null, { tool: "gemini" })).agents[GEMINI].vendor, "google");
  });
  test("unknown event type", () => {
    refused(() => apply(planned(), ev("task.explode", CLAUDE, "T1")), EXIT.PRECONDITION, /unknown event type/);
  });
  test("malformed events are bugs", () => {
    refused(() => apply(planned(), { type: "agent.seen", agent: CLAUDE, data: {} }), EXIT.BUG);
    refused(() => apply(planned(), { agent: CLAUDE, at: T0 }), EXIT.BUG);
  });
  test("a newer schema is refused", () => {
    refused(() => apply({ ...planned(), schema: 3 }, ev("agent.seen", CLAUDE, null)), EXIT.ENV, /schema 3, but this collab understands schema 1 and 2/);
    assert.equal(apply({ ...planned(), schema: 2 }, ev("agent.seen", CLAUDE, null)).schema, 2);
  });
  test("refusals name the actor, the task and its status", () => {
    refused(() => apply(state("in_review"), submit(CLAUDE, "T1", "sha1", 9)), EXIT.PRECONDITION, /claude-a1f3 can't submit T1 \(in_review\)/);
    try {
      apply(state("in_review"), submit(CLAUDE, "T1", "sha1", 9));
    } catch (e) {
      assert.deepEqual(e.details, { type: "task.submit", agent: CLAUDE, task: "T1", status: "in_review" });
    }
  });
});

// ---------------------------------------------------------------- agents and planning

describe("agent.join and agent.seen", () => {
  test("join adds an agent with its vendor", () => {
    const L = apply(fresh(), ev("agent.join", CODEX, null, { tool: "codex", host: "box", pid: 12 }, 3));
    assert.deepEqual(L.agents[CODEX], { tool: "codex", vendor: "openai", host: "box", pid: 12, joinedAt: at(3), lastSeen: at(3) });
  });
  test("joining again only updates lastSeen", () => {
    const L = planned();
    const out = apply(L, ev("agent.join", CODEX, null, { tool: "codex", host: "other", pid: 99 }, 50));
    assert.deepEqual(out.agents[CODEX], { ...L.agents[CODEX], lastSeen: at(50) });
  });
  test("an id can't change vendor by rejoining", () => {
    refused(() => apply(planned(), ev("agent.join", CODEX, null, { tool: "claude" })), EXIT.PRECONDITION, /already joined as codex/);
  });
  test("owner is a reserved id; an unknown tool is vendor other", () => {
    refused(() => apply(fresh(), ev("agent.join", "owner", null, { tool: "claude" })));
    assert.equal(apply(fresh(), ev("agent.join", "x-1", null, { tool: "weird" })).agents["x-1"].vendor, "other");
  });
  test("agent.seen only updates lastSeen", () => {
    const L = planned();
    const out = apply(L, ev("agent.seen", CODEX, null, {}, 77));
    assert.deepEqual({ ...out, seq: 0, agents: null }, { ...L, seq: 0, agents: null });
    assert.equal(out.agents[CODEX].lastSeen, at(77));
  });
});

describe("planner lease", () => {
  const base = () => run(fresh(), ev("agent.join", CODEX, null, { tool: "codex" }));
  test("the planner renews it", () => {
    assert.equal(apply(base(), ev("planner.lease", CLAUDE, null, { leaseUntil: at(30) }, 10)).planner.leaseUntil, at(30));
  });
  test("nobody else takes it while it is live", () => {
    refused(() => apply(base(), ev("planner.lease", CODEX, null, { leaseUntil: at(30) }, 14)), EXIT.PRECONDITION, /claude-a1f3 holds the planner lease/);
    refused(() => apply(base(), ev("planner.lease", CODEX, null, { leaseUntil: at(30) }, 15)), EXIT.PRECONDITION);
  });
  test("anyone takes it over once it has expired, and then plans", () => {
    const L = apply(base(), ev("planner.lease", CODEX, null, { leaseUntil: at(31) }, 16));
    assert.deepEqual(L.planner, { agent: CODEX, leaseUntil: at(31) });
    refused(() => apply(L, ev("plan", CLAUDE, null, { tasks: [spec("a")] }, 17)), EXIT.PRECONDITION, /codex-7k2p is the planner/);
    const P = apply(L, ev("plan", CODEX, null, { tasks: [spec("a")] }, 17));
    assert.equal(P.phase, "active");
  });
  test("the owner can't hold it, and it is gone after planning", () => {
    refused(() => apply(base(), ev("planner.lease", "owner", null, { leaseUntil: at(30) })));
    refused(() => apply(planned(), ev("planner.lease", CLAUDE, null, { leaseUntil: at(30) })), EXIT.PRECONDITION, /planning is over/);
  });
  test("needs a valid time", () => {
    refused(() => apply(base(), ev("planner.lease", CLAUDE, null, { leaseUntil: "soon" })));
  });
});

describe("planning phase", () => {
  const ALLOWED = [
    ["agent.seen", () => ev("agent.seen", CLAUDE, null)],
    ["agent.join", () => ev("agent.join", CODEX, null, { tool: "codex" })],
    ["comments.seen", () => ev("comments.seen", "owner", null, { lastCommentId: 5 })],
    ["notice.sent", () => ev("notice.sent", CLAUDE, null, { key: "k", commentId: 1 })],
    ["directive", () => ev("directive", "owner", null, { commentId: 3, login: "zwymer", cmd: "pause" })],
    ["phase.set", () => ev("phase.set", "owner", null, { phase: "paused" })],
  ];
  for (const [name, make] of ALLOWED) test(`allows ${name}`, () => assert.doesNotThrow(() => apply(fresh(), make())));

  const REFUSED = [
    ["task.add", () => ev("task.add", CLAUDE, null, spec("x"))],
    ["task.claim", () => claim(CLAUDE, "T1")],
    ["task.note", () => ev("task.note", CLAUDE, null, { body: "hi" })],
    ["reviewer.expire", () => ev("reviewer.expire", CLAUDE, "T1")],
  ];
  for (const [name, make] of REFUSED) {
    test(`refuses ${name}`, () => refused(() => apply(fresh(), make()), EXIT.PRECONDITION, /still planning/));
  }
});

describe("plan", () => {
  test("assigns T1..Tn in order, opens them and ends planning", () => {
    const L = planned();
    assert.deepEqual(taskIds(L), ["T1", "T2", "T3", "T4"]);
    assert.equal(L.phase, "active");
    assert.equal(L.planner, null);
    assert.equal(L.nextTask, 5);
    assert.deepEqual(L.tasks.T3, {
      title: "three", desc: "", accept: [], scope: [], deps: ["T1"], size: "S", kind: "work",
      status: "open", owner: null, leaseUntil: null, branch: "collab/pr-42/t3", subPr: null, headSha: null, touched: [],
      reviewer: null, reviewLeaseUntil: null, reviews: [], verify: [], blocked: null, merged: null, changeRounds: 0,
      times: { created: at(1), claimed: null, submitted: null, done: null },
    });
  });
  test("size defaults to M and lower-case dep ids are accepted", () => {
    const L = planned([spec("a", { size: undefined }), spec("b", { deps: ["t1"] })]);
    assert.equal(L.tasks.T1.size, "M");
    assert.deepEqual(L.tasks.T2.deps, ["T1"]);
  });
  test("caps a plan at 12 tasks", () => {
    const twelve = Array.from({ length: 12 }, (_, i) => spec(`t${i + 1}`));
    assert.equal(taskIds(planned(twelve)).length, 12);
    refused(() => planned([...twelve, spec("t13")]), EXIT.PRECONDITION, /at most 12 tasks/);
  });
  test("the cap follows config.maxTasks", () => {
    refused(() => planned([spec("a"), spec("b"), spec("c")], { maxTasks: 2 }), EXIT.PRECONDITION, /at most 2/);
  });
  const BAD = [
    ["no tasks", []],
    ["not a list", "T1"],
    ["a forward dependency", [spec("a", { deps: ["T2"] }), spec("b")]],
    ["a self dependency", [spec("a", { deps: ["T1"] })]],
    ["an unknown dependency", [spec("a", { deps: ["T9"] })]],
    ["a missing title", [spec("")]],
    ["a bad size", [spec("a", { size: "XL" })]],
    ["a scope that isn't a list", [spec("a", { scope: "src/**" })]],
  ];
  for (const [name, tasks] of BAD) {
    test(`refuses ${name}`, () => refused(() => apply(fresh(), ev("plan", CLAUDE, null, { tasks }))));
  }
  test("only the planner plans, and only once", () => {
    const L = run(fresh(), ev("agent.join", CODEX, null, { tool: "codex" }));
    refused(() => apply(L, ev("plan", CODEX, null, { tasks: [spec("a")] })), EXIT.PRECONDITION, /claude-a1f3 is the planner/);
    refused(() => apply(planned(), ev("plan", CLAUDE, null, { tasks: [spec("a")] })), EXIT.PRECONDITION, /only runs while planning/);
  });
});

describe("task.add", () => {
  test("adds the next id as an open work task", () => {
    const L = apply(planned(), ev("task.add", CODEX, null, spec("five", { deps: ["T2"] }), 9));
    assert.equal(L.nextTask, 6);
    assert.equal(L.tasks.T5.status, "open");
    assert.equal(L.tasks.T5.kind, "work");
    assert.equal(L.tasks.T5.branch, "collab/pr-42/t5");
    assert.deepEqual(L.tasks.T5.deps, ["T2"]);
  });
  test("deps must exist and not be cancelled", () => {
    refused(() => apply(planned(), ev("task.add", CODEX, null, spec("x", { deps: ["T9"] }))));
    const L = apply(planned(), ev("task.cancel", CODEX, "T2", { reason: "dup" }));
    refused(() => apply(L, ev("task.add", CODEX, null, spec("x", { deps: ["T2"] }))));
  });
  test("work tasks stay within maxTasks; cancelled ones don't count", () => {
    const twelve = Array.from({ length: 12 }, (_, i) => spec(`t${i + 1}`));
    const full = planned(twelve);
    refused(() => apply(full, ev("task.add", CODEX, null, spec("t13"))), EXIT.PRECONDITION, /holds 12 tasks/);
    const L = run(full, ev("task.cancel", CODEX, "T4", { reason: "x" }), ev("task.add", CODEX, null, spec("t13")));
    assert.equal(L.tasks.T13.title, "t13");
  });
  test("fix-ci tasks bypass the cap and dedupe on forSha, even after a cancel", () => {
    const twelve = Array.from({ length: 12 }, (_, i) => spec(`t${i + 1}`));
    const fix = (sha) => ev("task.add", CODEX, null, { kind: "fix-ci", forSha: sha, scope: [], deps: [], size: "S" });
    let L = apply(planned(twelve), fix("abcdef1234"));
    assert.equal(L.tasks.T13.kind, "fix-ci");
    assert.equal(L.tasks.T13.forSha, "abcdef1234");
    assert.match(L.tasks.T13.title, /abcdef1/);
    refused(() => apply(L, fix("abcdef1234")), EXIT.PRECONDITION, /T13 already covers the CI failure at abcdef1/);
    L = apply(L, ev("task.cancel", "owner", "T13", {}));
    refused(() => apply(L, fix("abcdef1234")), EXIT.PRECONDITION, /already covers/);
    assert.equal(apply(L, fix("9999999")).tasks.T14.forSha, "9999999");
  });
  test("a fix-ci task needs forSha, and kind must be known", () => {
    refused(() => apply(planned(), ev("task.add", CODEX, null, { kind: "fix-ci" })), EXIT.PRECONDITION, /forSha/);
    refused(() => apply(planned(), ev("task.add", CODEX, null, spec("x", { kind: "chore" }))));
  });
});

// ---------------------------------------------------------------- the transition table

describe("legal transitions", () => {
  const LATE = 300; // every lease in the fixtures has expired by now
  const ROWS = [
    // [from, event, to, extra check]
    ["open", () => claim(CODEX, "T1", 10), "claimed", (L) => assert.equal(L.tasks.T1.owner, CODEX)],
    ["claimed", () => ev("task.release", CLAUDE, "T1", {}, 10), "open", (L) => { assert.equal(L.tasks.T1.owner, null); assert.equal(L.tasks.T1.leaseUntil, null); }],
    ["claimed", () => steal(CODEX, "T1", LATE), "claimed", (L) => assert.equal(L.tasks.T1.owner, CODEX)],
    ["changes_requested", () => steal(CLAUDE2, "T1", LATE), "claimed", (L) => assert.equal(L.tasks.T1.owner, CLAUDE2)],
    ["approved", () => steal(CODEX, "T1", LATE), "claimed", (L) => assert.equal(L.tasks.T1.owner, CODEX)],
    ["reviewing", () => ev("reviewer.expire", CLAUDE2, "T1", {}, 66), "in_review", (L) => { assert.equal(L.tasks.T1.reviewer, null); assert.equal(L.tasks.T1.reviewLeaseUntil, null); }],
    ["claimed", () => submit(CLAUDE, "T1", "sha1", 9), "in_review", (L) => assert.equal(L.tasks.T1.times.submitted, at(9)), (L) => run(L, push(CLAUDE, "T1", "sha1", 2), verify(CLAUDE, "T1", "sha1", true, 3))],
    ["changes_requested", () => submit(CLAUDE, "T1", "sha2", 9), "in_review", null, (L) => run(L, push(CLAUDE, "T1", "sha2", 7), verify(CLAUDE, "T1", "sha2", true, 8))],
    ["reviewing", () => verdict(CODEX, "T1", "approve", "sha1", 6), "approved", (L) => assert.equal(L.tasks.T1.changeRounds, 0)],
    ["reviewing", () => verdict(CODEX, "T1", "changes", "sha1", 6), "changes_requested", (L) => assert.equal(L.tasks.T1.changeRounds, 1)],
    ["approved", () => push(CLAUDE, "T1", "sha2", 8), "in_review", (L) => assert.equal(L.tasks.T1.headSha, "sha2")],
    ["approved", () => merge(CODEX, "T1", "sha1", 8), "done", (L) => assert.deepEqual(L.tasks.T1.merged, { sha: "sha1", at: at(8), by: CODEX })],
    ["open", () => ev("task.cancel", CODEX, "T1", { reason: "x" }, 9), "cancelled"],
    ["claimed", () => ev("task.cancel", CLAUDE, "T1", { reason: "x" }, 9), "cancelled"],
    ["in_review", () => ev("task.cancel", CLAUDE, "T1", { reason: "x" }, 9), "cancelled"],
    ["changes_requested", () => ev("task.cancel", CLAUDE, "T1", { reason: "x" }, 9), "cancelled"],
    ["approved", () => ev("task.cancel", "owner", "T1", {}, 9), "cancelled", (L) => assert.equal(L.tasks.T1.leaseUntil, null)],
  ];
  for (const [from, make, to, check, prep] of ROWS) {
    const e = make();
    test(`${from} --${e.type}${e.data.steal ? " --steal" : ""}${e.data.verdict ? " " + e.data.verdict : ""} (${e.agent})--> ${to}`, () => {
      const L = apply(prep ? prep(state(from)) : state(from), e);
      assert.equal(L.tasks.T1.status, to);
      check?.(L);
    });
  }
});

describe("illegal transitions", () => {
  const ROWS = [
    // [from, event, message pattern]
    ["claimed", () => claim(CODEX, "T1", 10), /must be open \(owner claude-a1f3\)/],
    ["claimed", () => ev("task.release", CODEX, "T1", {}, 10), /belongs to claude-a1f3/],
    ["open", () => ev("task.release", CLAUDE, "T1", {}, 10), /nobody owns it/],
    ["in_review", () => ev("task.release", CLAUDE, "T1", {}, 10), /must be claimed/],
    ["approved", () => ev("task.release", CLAUDE, "T1", {}, 10), /must be claimed/],
    ["open", () => submit(CLAUDE, "T1", "sha1", 10), /nobody owns it/],
    ["in_review", () => submit(CLAUDE, "T1", "sha1", 10), /must be claimed or changes_requested/],
    ["approved", () => submit(CLAUDE, "T1", "sha1", 10), /must be claimed or changes_requested/],
    ["claimed", () => verdict(CODEX, "T1", "approve", "sha1", 10), /must be in_review/],
    ["in_review", () => merge(CLAUDE, "T1", "sha1", 10), /must be approved/],
    ["changes_requested", () => merge(CLAUDE, "T1", "sha1", 10), /must be approved/],
    ["done", () => ev("task.cancel", "owner", "T1", {}, 10), /already done/],
    ["cancelled", () => ev("task.cancel", "owner", "T1", {}, 10), /already cancelled/],
    ["done", () => claim(CODEX, "T1", 10), /must be open/],
    ["cancelled", () => claim(CODEX, "T1", 10), /must be open/],
    ["done", () => push(CLAUDE, "T1", "sha9", 10), /must be claimed or changes_requested or in_review or approved/],
    ["in_review", () => steal(CODEX, "T1", 300), /only a claimed, changes_requested or approved task can be stolen/],
    ["open", () => steal(CODEX, "T1", 300), /can be stolen/],
    ["claimed", () => ev("task.cancel", CODEX, "T1", {}, 10), /only its owner/],
    ["open", () => ev("task.lease", CLAUDE, "T1", { leaseUntil: at(200) }, 10), /nobody owns it/],
  ];
  for (const [from, make, re] of ROWS) {
    const e = make();
    test(`${from} refuses ${e.type}${e.data.steal ? " --steal" : ""} by ${e.agent}`, () => refused(() => apply(state(from), e), EXIT.PRECONDITION, re));
  }
});

// ---------------------------------------------------------------- claim rules

describe("claim: WIP limit and dependencies", () => {
  test("a claim records the owner, lease and time", () => {
    const L = apply(planned(), claim(CODEX, "T2", 10));
    assert.equal(L.tasks.T2.owner, CODEX);
    assert.equal(L.tasks.T2.leaseUntil, at(100));
    assert.equal(L.tasks.T2.times.claimed, at(10));
  });
  test("one claimed task at a time", () => {
    refused(() => run(planned(), claim(CLAUDE, "T1"), claim(CLAUDE, "T2", 2)), EXIT.PRECONDITION, /WIP limit is 1 and you hold T1/);
  });
  test("a changes_requested task counts against WIP", () => {
    refused(() => apply(state("changes_requested"), claim(CLAUDE, "T2", 10)), EXIT.PRECONDITION, /you hold T1/);
  });
  test("in_review and approved tasks don't count", () => {
    assert.equal(apply(state("in_review"), claim(CLAUDE, "T2", 10)).tasks.T2.owner, CLAUDE);
    assert.equal(apply(state("approved"), claim(CLAUDE, "T2", 10)).tasks.T2.owner, CLAUDE);
  });
  test("config.wip raises the limit", () => {
    const L = run(planned(DEFAULT_TASKS, { wip: 2 }), claim(CLAUDE, "T1"), claim(CLAUDE, "T2", 2));
    assert.equal(L.tasks.T2.owner, CLAUDE);
    refused(() => apply(L, claim(CLAUDE, "T4", 3)), EXIT.PRECONDITION, /WIP limit is 2/);
  });
  test("deps must be done", () => {
    refused(() => apply(planned(), claim(CODEX, "T3", 10)), EXIT.PRECONDITION, /dependencies are not done: T1/);
    refused(() => apply(state("approved"), claim(CODEX, "T3", 10)), EXIT.PRECONDITION, /T1/);
    assert.equal(apply(state("done"), claim(CODEX, "T3", 10)).tasks.T3.status, "claimed");
  });
  test("a blocked task can't be claimed", () => {
    const L = apply(planned(), ev("task.block", "owner", "T2", { reason: "decide the API", needsOwner: true }));
    refused(() => apply(L, claim(CODEX, "T2", 10)), EXIT.PRECONDITION, /blocked: decide the API/);
  });
  test("the owner can't claim; unknown tasks are refused", () => {
    refused(() => apply(planned(), claim("owner", "T1")), EXIT.PRECONDITION, /needs an agent id/);
    refused(() => apply(planned(), claim(CODEX, "T99")), EXIT.PRECONDITION, /there is no task T99/);
  });
  test("the lease time must be valid", () => {
    refused(() => apply(planned(), ev("task.claim", CODEX, "T1", {}, 1)), EXIT.PRECONDITION, /leaseUntil/);
  });
  test("an overlap list is stored for the dashboard, and a release clears it", () => {
    const L = apply(planned(), claim(CODEX, "T2", 1, { overlap: ["T1 (claude): src/a.js"] }));
    assert.deepEqual(L.tasks.T2.overlap, ["T1 (claude): src/a.js"]);
    assert.equal(apply(L, ev("task.release", CODEX, "T2", {}, 2)).tasks.T2.overlap, undefined);
    assert.equal(apply(planned(), claim(CODEX, "T2", 1, { overlap: [] })).tasks.T2.overlap, undefined);
    refused(() => apply(planned(), claim(CODEX, "T2", 1, { overlap: "T1" })), EXIT.PRECONDITION, /overlap must be a list/);
  });
});

describe("claim --steal", () => {
  test("only after the lease expires", () => {
    refused(() => apply(state("claimed"), steal(CODEX, "T1", 90)), EXIT.PRECONDITION, /lease runs until/);
    assert.equal(apply(state("claimed"), steal(CODEX, "T1", 92)).tasks.T1.owner, CODEX);
  });
  test("a plain claim of an expired task points at --steal", () => {
    refused(() => apply(state("claimed"), claim(CODEX, "T1", 200)), EXIT.PRECONDITION, /use --steal/);
  });
  test("keeps the branch, sub-PR, head and history", () => {
    const L0 = run(state("claimed"), push(CLAUDE, "T1", "sha1", 2, { subPr: 59, touched: ["src/a.js"] }));
    const L = apply(L0, steal(CODEX, "T1", 200));
    for (const k of ["branch", "subPr", "headSha", "touched", "verify", "reviews"]) assert.deepEqual(L.tasks.T1[k], L0.tasks.T1[k], k);
    assert.equal(L.tasks.T1.leaseUntil, at(290));
    assert.equal(L.tasks.T1.times.claimed, at(200));
  });
  test("from approved, the approval no longer counts", () => {
    const L = apply(state("approved"), steal(CODEX, "T1", 300));
    assert.equal(L.tasks.T1.status, "claimed");
    refused(() => apply(L, merge(CODEX, "T1", "sha1", 301)), EXIT.PRECONDITION, /must be approved/);
    // It must be submitted and reviewed again, by a vendor other than the new owner's.
    const S = apply(L, submit(CODEX, "T1", "sha1", 302));
    assert.equal(S.tasks.T1.status, "in_review");
    refused(() => apply(S, rclaim(CODEX, "T1", 303)), EXIT.PRECONDITION, /your own task/);
    const R = run(S, rclaim(CLAUDE2, "T1", 303), verdict(CLAUDE2, "T1", "approve", "sha1", 304), merge(CODEX, "T1", "sha1", 305));
    assert.equal(R.tasks.T1.status, "done");
  });
  test("the zombie owner gets 'not owner'", () => {
    const L = apply(state("claimed"), steal(CODEX, "T1", 200));
    refused(() => apply(L, push(CLAUDE, "T1", "sha9", 201)), EXIT.PRECONDITION, /belongs to codex-7k2p/);
    refused(() => apply(L, ev("task.release", CLAUDE, "T1", {}, 201)), EXIT.PRECONDITION, /belongs to codex-7k2p/);
  });
  test("you can't steal your own task, and WIP still applies", () => {
    refused(() => apply(state("claimed"), steal(CLAUDE, "T1", 200)), EXIT.PRECONDITION, /already own it/);
    const L = apply(state("claimed"), claim(CODEX, "T2", 150));
    refused(() => apply(L, steal(CODEX, "T1", 200)), EXIT.PRECONDITION, /WIP limit/);
  });
  test("a review lands with a fresh owner lease, so it isn't instantly stealable", () => {
    const L = run(state("in_review"), rclaim(CODEX, "T1", 150), verdict(CODEX, "T1", "changes", "sha1", 160));
    assert.equal(L.tasks.T1.leaseUntil, at(250));
    refused(() => apply(L, steal(CLAUDE2, "T1", 200)), EXIT.PRECONDITION, /lease runs until/);
  });
});

describe("release, lease, push, verify", () => {
  test("release keeps the branch work for the next owner", () => {
    const L = run(state("claimed"), push(CLAUDE, "T1", "sha1"), ev("task.release", CLAUDE, "T1", {}, 5));
    assert.equal(L.tasks.T1.status, "open");
    assert.equal(L.tasks.T1.headSha, "sha1");
  });
  test("the owner extends the lease; nobody else can", () => {
    assert.equal(apply(state("claimed"), ev("task.lease", CLAUDE, "T1", { leaseUntil: at(500) }, 10)).tasks.T1.leaseUntil, at(500));
    refused(() => apply(state("claimed"), ev("task.lease", CODEX, "T1", { leaseUntil: at(500) }, 10)), EXIT.PRECONDITION, /belongs to/);
  });
  test("push records head, touched (sorted, unique), sub-PR and lease", () => {
    const L = apply(state("claimed"), push(CLAUDE, "T1", "abc", 5, { touched: ["src/b.js", "src/a.js", "src/b.js"], subPr: 59, leaseUntil: at(95) }));
    assert.equal(L.tasks.T1.headSha, "abc");
    assert.deepEqual(L.tasks.T1.touched, ["src/a.js", "src/b.js"]);
    assert.equal(L.tasks.T1.subPr, 59);
    assert.equal(L.tasks.T1.leaseUntil, at(95));
  });
  test("push needs a head SHA and the owner", () => {
    refused(() => apply(state("claimed"), ev("task.push", CLAUDE, "T1", {}, 5)), EXIT.PRECONDITION, /headSha/);
    refused(() => apply(state("claimed"), push(CODEX, "T1", "x")), EXIT.PRECONDITION, /belongs to/);
  });
  test("SHA binding: a push after approve sends the task back to review", () => {
    const L = apply(state("approved"), push(CLAUDE, "T1", "sha2", 8));
    assert.equal(L.tasks.T1.status, "in_review");
    assert.equal(L.tasks.T1.reviewer, null);
    refused(() => apply(L, merge(CLAUDE, "T1", "sha2", 9)), EXIT.PRECONDITION, /must be approved/);
    refused(() => apply(L, merge(CLAUDE, "T1", "sha1", 9)), EXIT.PRECONDITION, /must be approved/);
  });
  test("a push of the same SHA keeps the approval", () => {
    assert.equal(apply(state("approved"), push(CLAUDE, "T1", "sha1", 8)).tasks.T1.status, "approved");
  });
  test("a push during review keeps the reviewer, who must claim again before judging the new SHA", () => {
    assert.equal(state("reviewing").tasks.T1.reviewSha, "sha1");
    const L = apply(state("reviewing"), push(CLAUDE, "T1", "sha2", 6));
    assert.equal(L.tasks.T1.reviewer, CODEX);
    refused(() => apply(L, verdict(CODEX, "T1", "approve", "sha1", 7)), EXIT.PRECONDITION, /head is sha2, not sha1/);
    // The reviewer still holds sha1: neither verdict counts for a commit they never checked out.
    refused(() => apply(L, verdict(CODEX, "T1", "approve", "sha2", 7)), EXIT.PRECONDITION, /pushed sha2 after you started reviewing sha1; run collab review-claim T1 again/);
    refused(() => apply(L, verdict(CODEX, "T1", "changes", "sha2", 7)), EXIT.PRECONDITION, /review-claim T1 again/);
    const again = apply(L, rclaim(CODEX, "T1", 7));
    assert.equal(again.tasks.T1.reviewSha, "sha2");
    assert.equal(apply(again, verdict(CODEX, "T1", "approve", "sha2", 8)).tasks.T1.status, "approved");
  });
  test("verify: the owner or the reviewer, with a boolean result", () => {
    const L = apply(state("reviewing"), verify(CODEX, "T1", "sha1", false, 6));
    assert.deepEqual(L.tasks.T1.verify.at(-1), { sha: "sha1", by: CODEX, ok: false, summary: "1 failed", at: at(6) });
    refused(() => apply(state("reviewing"), verify(CLAUDE2, "T1", "sha1", true, 6)), EXIT.PRECONDITION, /only the owner/);
    refused(() => apply(state("claimed"), ev("task.verify", CLAUDE, "T1", { sha: "s", ok: "yes" })), EXIT.PRECONDITION, /true or false/);
  });
});

describe("submit", () => {
  const pushed = () => run(state("claimed"), push(CLAUDE, "T1", "sha1", 2));
  test("needs a passing verify at the head SHA", () => {
    refused(() => apply(pushed(), submit(CLAUDE, "T1", "sha1")), EXIT.PRECONDITION, /no passing collab verify at sha1/);
    refused(() => run(pushed(), verify(CLAUDE, "T1", "sha1", false), submit(CLAUDE, "T1", "sha1")), EXIT.PRECONDITION, /no passing/);
    refused(() => run(pushed(), verify(CLAUDE, "T1", "sha0", true), submit(CLAUDE, "T1", "sha1")), EXIT.PRECONDITION, /no passing/);
    assert.equal(run(pushed(), verify(CLAUDE, "T1", "sha1", true), submit(CLAUDE, "T1", "sha1")).tasks.T1.status, "in_review");
  });
  test("the SHA must be the head", () => {
    const L = run(pushed(), verify(CLAUDE, "T1", "sha1", true), push(CLAUDE, "T1", "sha2", 4));
    refused(() => apply(L, submit(CLAUDE, "T1", "sha1", 5)), EXIT.PRECONDITION, /head is sha2, not sha1/);
  });
  test("nothing pushed yet", () => {
    refused(() => apply(state("claimed"), submit(CLAUDE, "T1", "x")), EXIT.PRECONDITION, /nothing is pushed/);
  });
  test("only the owner submits", () => {
    refused(() => run(pushed(), verify(CLAUDE, "T1", "sha1"), submit(CODEX, "T1", "sha1")), EXIT.PRECONDITION, /belongs to/);
  });
});

describe("review", () => {
  test("a reviewer from the owner's vendor may review: the preference for another vendor is next's", () => {
    const L = apply(state("in_review"), rclaim(CLAUDE2, "T1", 5));
    assert.equal(L.tasks.T1.reviewer, CLAUDE2);
    const V = apply(L, verdict(CLAUDE2, "T1", "approve", "sha1", 6));
    assert.equal(V.tasks.T1.status, "approved");
    assert.deepEqual(V.tasks.T1.reviews.map((r) => [r.agent, r.vendor]), [[CLAUDE2, "anthropic"]]);
  });
  test("the owner can't review their own task", () => {
    refused(() => apply(state("in_review"), rclaim(CLAUDE, "T1", 5)), EXIT.PRECONDITION, /your own task/);
  });
  test("another vendor claims the review", () => {
    const L = apply(state("in_review"), rclaim(CODEX, "T1", 5));
    assert.equal(L.tasks.T1.reviewer, CODEX);
    assert.equal(L.tasks.T1.reviewLeaseUntil, at(65));
  });
  test("a live review lease holds off others; the holder can renew", () => {
    const L = run(state("in_review"), ev("agent.join", GEMINI, null, { tool: "gemini" }), rclaim(CODEX, "T1", 5));
    refused(() => apply(L, rclaim(GEMINI, "T1", 30)), EXIT.PRECONDITION, /codex-7k2p is reviewing it/);
    assert.equal(apply(L, rclaim(CODEX, "T1", 30)).tasks.T1.reviewLeaseUntil, at(90));
    assert.equal(apply(L, rclaim(GEMINI, "T1", 66)).tasks.T1.reviewer, GEMINI);
  });
  test("review needs in_review", () => {
    refused(() => apply(state("claimed"), rclaim(CODEX, "T1", 5)), EXIT.PRECONDITION, /must be in_review/);
  });
  test("a verdict records vendor, SHA and comment, and clears the reviewer", () => {
    const L = apply(state("reviewing"), verdict(CODEX, "T1", "approve", "sha1", 6));
    assert.deepEqual(L.tasks.T1.reviews, [{ agent: CODEX, vendor: "openai", verdict: "approve", sha: "sha1", commentId: 906, at: at(6) }]);
    assert.equal(L.tasks.T1.reviewer, null);
    assert.equal(L.tasks.T1.reviewLeaseUntil, null);
  });
  test("only the current reviewer gives a verdict", () => {
    refused(() => apply(state("in_review"), verdict(CODEX, "T1", "approve", "sha1")), EXIT.PRECONDITION, /claim the review first/);
    const L = apply(state("reviewing"), ev("agent.join", GEMINI, null, { tool: "gemini" }, 5));
    refused(() => apply(L, verdict(GEMINI, "T1", "approve", "sha1")), EXIT.PRECONDITION, /codex-7k2p is the reviewer/);
  });
  test("a verdict must be approve or changes", () => {
    refused(() => apply(state("reviewing"), verdict(CODEX, "T1", "lgtm", "sha1")), EXIT.PRECONDITION, /approve or changes/);
  });
  test("change rounds add up", () => {
    let L = state("changes_requested");
    L = run(L, push(CLAUDE, "T1", "sha2", 7), verify(CLAUDE, "T1", "sha2", true, 8), submit(CLAUDE, "T1", "sha2", 9),
      rclaim(CODEX, "T1", 10), verdict(CODEX, "T1", "changes", "sha2", 11));
    assert.equal(L.tasks.T1.changeRounds, 2);
  });
  test("reviewer.expire only after the review lease ends", () => {
    refused(() => apply(state("reviewing"), ev("reviewer.expire", CLAUDE2, "T1", {}, 64)), EXIT.PRECONDITION, /review lease runs until/);
    refused(() => apply(state("in_review"), ev("reviewer.expire", CLAUDE2, "T1", {}, 64)), EXIT.PRECONDITION, /no reviewer/);
    refused(() => apply(state("claimed"), ev("reviewer.expire", CLAUDE2, "T1", {}, 64)), EXIT.PRECONDITION, /must be in_review/);
  });
});

describe("merge", () => {
  test("any agent merges an approved task at the approved head", () => {
    const L = apply(state("approved"), merge(CLAUDE2, "T1", "sha1", 8));
    assert.equal(L.tasks.T1.status, "done");
    assert.equal(L.tasks.T1.leaseUntil, null);
    assert.equal(L.tasks.T1.times.done, at(8));
    assert.equal(L.tasks.T1.merged.by, CLAUDE2);
  });
  test("records the merge commit when given", () => {
    const L = apply(state("approved"), ev("task.merge", CLAUDE, "T1", { sha: "sha1", mergeSha: "m1" }, 8));
    assert.deepEqual(L.tasks.T1.merged, { sha: "sha1", at: at(8), by: CLAUDE, mergeSha: "m1" });
  });
  test("the SHA must be the approved head", () => {
    refused(() => apply(state("approved"), merge(CLAUDE, "T1", "other", 8)), EXIT.PRECONDITION, /head is sha1, not other/);
  });
  test("a blocked task doesn't merge", () => {
    const L = apply(state("approved"), ev("task.block", CLAUDE, "T1", { reason: "wait", needsOwner: true }, 7));
    refused(() => apply(L, merge(CLAUDE, "T1", "sha1", 8)), EXIT.PRECONDITION, /blocked: wait/);
  });
});

describe("cancel, block, unblock, note", () => {
  test("anyone cancels an open task; the owner any of theirs; the PR owner anything not done", () => {
    assert.equal(apply(planned(), ev("task.cancel", CLAUDE2, "T2", {})).tasks.T2.status, "cancelled");
    assert.equal(apply(state("reviewing"), ev("task.cancel", CLAUDE, "T1", {}, 6)).tasks.T1.reviewer, null);
    refused(() => apply(state("in_review"), ev("task.cancel", CODEX, "T1", {}, 6)), EXIT.PRECONDITION, /only its owner \(claude-a1f3\)/);
    assert.equal(apply(state("claimed"), ev("task.cancel", "owner", "T1", {}, 6)).tasks.T1.status, "cancelled");
  });
  test("block and unblock by the task owner, with the owner's decision kept", () => {
    const B = apply(state("claimed"), ev("task.block", CLAUDE, "T1", { reason: "which API?", needsOwner: true }, 5));
    assert.deepEqual(B.tasks.T1.blocked, { reason: "which API?", needsOwner: true, by: CLAUDE, since: at(5) });
    assert.equal(B.tasks.T1.status, "claimed");
    refused(() => apply(B, ev("task.unblock", CODEX, "T1", {}, 6)), EXIT.PRECONDITION, /belongs to/);
    const U = apply(B, ev("task.unblock", "owner", "T1", { decision: "use v2" }, 6));
    assert.equal(U.tasks.T1.blocked, null);
    assert.deepEqual(U.tasks.T1.decision, { text: "use v2", by: "owner", at: at(6) });
    refused(() => apply(U, ev("task.unblock", CLAUDE, "T1", {}, 7)), EXIT.PRECONDITION, /isn't blocked/);
  });
  test("block needs a reason and a live task", () => {
    refused(() => apply(state("claimed"), ev("task.block", CLAUDE, "T1", {}, 5)), EXIT.PRECONDITION, /reason/);
    refused(() => apply(state("done"), ev("task.block", "owner", "T1", { reason: "x" }, 9)), EXIT.PRECONDITION, /already done/);
    refused(() => apply(planned(), ev("task.block", CODEX, "T1", { reason: "x" })), EXIT.PRECONDITION, /nobody owns it/);
  });
  test("a note changes nothing but seq and lastSeen", () => {
    const L = state("claimed");
    const N = apply(L, ev("task.note", CODEX, "T1", { body: "fyi" }, 9));
    assert.deepEqual(N.tasks, L.tasks);
    assert.equal(N.seq, L.seq + 1);
    refused(() => apply(L, ev("task.note", CODEX, "T9", { body: "x" })), EXIT.PRECONDITION, /no task T9/);
  });
});

describe("review.waive", () => {
  test("the owner approves at the current head", () => {
    const L = apply(state("in_review"), ev("review.waive", "owner", "T1", {}, 9));
    assert.equal(L.tasks.T1.status, "approved");
    assert.deepEqual(L.tasks.T1.reviews.at(-1), { agent: "owner", vendor: "owner", verdict: "approve", sha: "sha1", commentId: null, at: at(9) });
    assert.equal(apply(L, merge(CLAUDE, "T1", "sha1", 10)).tasks.T1.status, "done");
  });
  test("also overrides changes requested", () => {
    assert.equal(apply(state("changes_requested"), ev("review.waive", "owner", "T1", {}, 9)).tasks.T1.status, "approved");
  });
  test("agents can't waive, and an unsubmitted task can't be waived", () => {
    refused(() => apply(state("in_review"), ev("review.waive", CODEX, "T1", {}, 9)), EXIT.PRECONDITION, /only the owner/);
    refused(() => apply(state("claimed"), ev("review.waive", "owner", "T1", {}, 9)), EXIT.PRECONDITION, /must be in_review or changes_requested/);
  });
});

// ---------------------------------------------------------------- owner controls

describe("directives and comments", () => {
  const dir = (cmd, commentId, task, min = 9) => ev("directive", "owner", task, { commentId, login: "zwymer", cmd, url: `https://x/${commentId}` }, min);
  test("pause sets the phase and records the directive", () => {
    const L = apply(planned(), dir("pause", 101));
    assert.equal(L.phase, "paused");
    assert.equal(L.lastCommentId, 101);
    assert.deepEqual(L.directives, [{ commentId: 101, login: "zwymer", cmd: "pause", at: at(9), applied: true, url: "https://x/101" }]);
  });
  test("cancel cancels the named task", () => {
    const L = apply(state("claimed"), dir("cancel", 102, "T1"));
    assert.equal(L.tasks.T1.status, "cancelled");
    assert.equal(L.directives[0].task, "T1");
    assert.equal(L.directives[0].applied, true);
  });
  test("a cancel that can't apply is still recorded, so the comment is not re-read", () => {
    const L = apply(state("done"), dir("cancel", 103, "T1"));
    assert.equal(L.tasks.T1.status, "done");
    assert.equal(L.directives[0].applied, false);
    assert.equal(L.lastCommentId, 103);
    assert.equal(apply(planned(), dir("cancel", 104, "T77")).directives[0].applied, false);
  });
  test("an already-seen comment and an unknown command are refused", () => {
    const L = apply(planned(), dir("pause", 101));
    refused(() => apply(L, dir("pause", 101)), EXIT.PRECONDITION, /already seen/);
    refused(() => apply(L, dir("pause", 50)), EXIT.PRECONDITION, /already seen/);
    refused(() => apply(planned(), dir("resume", 105)), EXIT.PRECONDITION, /pause or cancel/);
  });
  test("an agent may record a directive it fetched", () => {
    const L = apply(planned(), ev("directive", CODEX, null, { commentId: 7, login: "zwymer", cmd: "pause" }));
    assert.equal(L.phase, "paused");
  });
  test("comments.seen only moves forward", () => {
    const L = apply(planned(), ev("comments.seen", "owner", null, { lastCommentId: 500 }));
    assert.equal(L.lastCommentId, 500);
    assert.equal(apply(L, ev("comments.seen", "owner", null, { lastCommentId: 20 })).lastCommentId, 500);
    refused(() => apply(L, ev("comments.seen", "owner", null, {})), EXIT.PRECONDITION, /lastCommentId/);
  });
  test("notice.sent records the comment id", () => {
    const L = apply(planned(), ev("notice.sent", CLAUDE, "T2", { key: "needs-owner:T2", commentId: 77 }));
    assert.equal(L.notices["needs-owner:T2"], 77);
    refused(() => apply(planned(), ev("notice.sent", CLAUDE, null, { commentId: 1 })), EXIT.PRECONDITION, /key/);
  });
});

describe("phase.set", () => {
  test("resume and close are owner-only", () => {
    const P = apply(planned(), ev("phase.set", "owner", null, { phase: "paused" }));
    assert.equal(P.phase, "paused");
    refused(() => apply(P, ev("phase.set", CLAUDE, null, { phase: "active" })), EXIT.PRECONDITION, /only the owner/);
    assert.equal(apply(P, ev("phase.set", "owner", null, { phase: "active" })).phase, "active");
  });
  test("resuming a pause from before the plan goes back to planning", () => {
    const P = apply(fresh(), ev("directive", "owner", null, { commentId: 1, login: "zwymer", cmd: "pause" }));
    assert.equal(P.phase, "paused");
    assert.equal(apply(P, ev("phase.set", "owner", null, { phase: "active" })).phase, "planning");
  });
  test("closed is final; the phase must be known", () => {
    const C = apply(planned(), ev("phase.set", "owner", null, { phase: "closed" }));
    refused(() => apply(C, ev("phase.set", "owner", null, { phase: "active" })), EXIT.PRECONDITION, /closed/);
    refused(() => apply(planned(), ev("phase.set", "owner", null, { phase: "done" })), EXIT.PRECONDITION, /phase must be one of/);
  });
  test("pausing a closed collab leaves it closed", () => {
    const C = apply(planned(), ev("phase.set", "owner", null, { phase: "closed" }));
    const D = apply(C, ev("directive", "owner", null, { commentId: 9, login: "zwymer", cmd: "pause" }));
    assert.equal(D.phase, "closed");
    assert.equal(D.directives[0].applied, false);
  });
});

describe("paused and closed refuse mutations (exit 4)", () => {
  const MUTATIONS = [
    ["task.claim", () => claim(CODEX, "T2", 10)],
    ["task.add", () => ev("task.add", CODEX, null, spec("x"), 10)],
    ["task.push", () => push(CLAUDE, "T1", "sha2", 10)],
    ["task.submit", () => submit(CLAUDE, "T1", "sha1", 10)],
    ["task.release", () => ev("task.release", CLAUDE, "T1", {}, 10)],
    ["task.cancel", () => ev("task.cancel", "owner", "T2", {}, 10)],
    ["task.note", () => ev("task.note", CLAUDE, "T1", { body: "x" }, 10)],
    ["review.waive", () => ev("review.waive", "owner", "T1", {}, 10)],
    ["reviewer.expire", () => ev("reviewer.expire", CLAUDE, "T1", {}, 10)],
    ["planner.lease", () => ev("planner.lease", CLAUDE, null, { leaseUntil: at(30) }, 10)],
  ];
  const STILL_OK = [
    ["agent.seen", () => ev("agent.seen", CODEX, null, {}, 10)],
    ["agent.join", () => ev("agent.join", GEMINI, null, { tool: "gemini" }, 10)],
    ["notice.sent", () => ev("notice.sent", CODEX, null, { key: "sticky", commentId: 3 }, 10)],
    ["comments.seen", () => ev("comments.seen", "owner", null, { lastCommentId: 900 }, 10)],
    ["directive", () => ev("directive", "owner", "T2", { commentId: 901, login: "zwymer", cmd: "cancel" }, 10)],
  ];
  for (const phase of ["paused", "closed"]) {
    const L = () => apply(state("claimed"), ev("phase.set", "owner", null, { phase }, 9));
    for (const [name, make] of MUTATIONS) {
      test(`${phase} refuses ${name}`, () => refused(() => apply(L(), make()), EXIT.UNSUPPORTED, new RegExp(`is ${phase}`)));
    }
    for (const [name, make] of STILL_OK) {
      test(`${phase} still allows ${name}`, () => assert.doesNotThrow(() => apply(L(), make())));
    }
  }
  test("paused says how to resume", () => {
    const L = apply(state("claimed"), ev("phase.set", "owner", null, { phase: "paused" }, 9));
    refused(() => apply(L, claim(CODEX, "T2", 10)), EXIT.UNSUPPORTED, /codex-7k2p can't claim T2 \(open\): PR #42 is paused; the owner must run collab resume/);
  });
});

// ---------------------------------------------------------------- derive

describe("derive", () => {
  test("stale: claimed, changes_requested or approved past the lease; never in_review", () => {
    for (const [s, live] of [["claimed", 91], ["changes_requested", 96], ["approved", 96]]) {
      assert.equal(derive(state(s), at(live - 1)).tasks.T1.stale, false, `${s} live`);
      assert.equal(derive(state(s), at(live)).tasks.T1.stale, false, `${s} at the edge`);
      assert.equal(derive(state(s), at(live + 1)).tasks.T1.stale, true, `${s} expired`);
    }
    assert.equal(derive(state("in_review"), at(999)).tasks.T1.stale, false);
    assert.equal(derive(state("open"), at(999)).tasks.T1.stale, false);
    assert.equal(derive(state("done"), at(999)).tasks.T1.stale, false);
  });
  test("inProgress: claimed with a pushed head", () => {
    assert.equal(derive(state("claimed"), at(5)).tasks.T1.inProgress, false);
    assert.equal(derive(apply(state("claimed"), push(CLAUDE, "T1", "s")), at(5)).tasks.T1.inProgress, true);
    assert.equal(derive(state("in_review"), at(5)).tasks.T1.inProgress, false);
  });
  test("waitingReview and reviewStale", () => {
    assert.equal(derive(state("in_review"), at(5)).tasks.T1.waitingReview, true);
    const R = state("reviewing"); // review lease until minute 65
    assert.deepEqual([derive(R, at(30)).tasks.T1.waitingReview, derive(R, at(30)).tasks.T1.reviewStale], [false, false]);
    assert.deepEqual([derive(R, at(66)).tasks.T1.waitingReview, derive(R, at(66)).tasks.T1.reviewStale], [true, true]);
    assert.equal(derive(state("approved"), at(5)).tasks.T1.waitingReview, false);
  });
  test("eligibleReviewers: every agent but the owner; preferredReviewers: those of another vendor", () => {
    const d = derive(state("in_review"), at(5)).tasks.T1;
    assert.deepEqual(d.eligibleReviewers.sort(), [CODEX, CLAUDE2].sort());
    assert.deepEqual(d.preferredReviewers, [CODEX]);
    const G = apply(state("in_review"), ev("agent.join", GEMINI, null, { tool: "gemini" }, 5));
    assert.deepEqual(derive(G, at(5)).tasks.T1.preferredReviewers.sort(), [CODEX, GEMINI].sort());
    const C = run(planned(), claim(CODEX, "T2", 1));
    assert.deepEqual(derive(C, at(5)).tasks.T2.eligibleReviewers.sort(), [CLAUDE, CLAUDE2].sort());
    assert.deepEqual(derive(C, at(5)).tasks.T4.eligibleReviewers, []);
  });
  test("a review opens to the owner's vendor reviewWaitMin after the submit while another vendor is around, at once otherwise", () => {
    // T1 was submitted at minute 4; CODEX joined at minute 1, so it is around.
    const L = state("in_review");
    assert.equal(derive(L, at(5)).tasks.T1.reviewOpenAt, at(14));
    assert.equal(derive(L, at(5)).tasks.T1.reviewOpen, false);
    assert.equal(derive(L, at(5)).nextReviewOpen, at(14));
    assert.equal(derive(L, at(14)).tasks.T1.reviewOpen, true);
    assert.equal(derive(L, at(14)).nextReviewOpen, null);
    // reviewWaitMin comes from the ledger's config (.collab.json).
    const short = structuredClone(L);
    short.config.reviewWaitMin = 3;
    assert.equal(derive(short, at(5)).tasks.T1.reviewOpenAt, at(7));
    // Submitted at 50, CODEX last seen at 1: not around, so it is open at once.
    const late = run(planned(), claim(CLAUDE, "T1", 40), push(CLAUDE, "T1", "sha1", 41), verify(CLAUDE, "T1", "sha1", true, 42), submit(CLAUDE, "T1", "sha1", 50));
    assert.equal(derive(late, at(51)).tasks.T1.reviewOpenAt, at(50));
    assert.equal(derive(late, at(51)).tasks.T1.reviewOpen, true);
    // Not waiting for a reviewer: no opening time.
    assert.equal(derive(state("reviewing"), at(6)).tasks.T1.reviewOpenAt, null);
    assert.equal(derive(state("claimed"), at(6)).tasks.T1.reviewOpenAt, null);
  });
  test("liveAgents and nextLeaseExpiry", () => {
    // Planning: only the planner.
    assert.deepEqual(derive(fresh(), at(1)), { tasks: {}, liveAgents: [CLAUDE], nextLeaseExpiry: at(15), nextReviewOpen: null });
    assert.deepEqual(derive(fresh(), at(16)), { tasks: {}, liveAgents: [], nextLeaseExpiry: null, nextReviewOpen: null });
    // CLAUDE owns T1 in review (lease to 91), CODEX reviews it (to 65), CLAUDE2 claims T2 (lease to 110).
    const L = run(state("reviewing"), claim(CLAUDE2, "T2", 20));
    const d = derive(L, at(30));
    assert.deepEqual(d.liveAgents.sort(), [CLAUDE, CLAUDE2, CODEX].sort());
    assert.equal(d.nextLeaseExpiry, at(65));
    const later = derive(L, at(70));
    assert.deepEqual(later.liveAgents.sort(), [CLAUDE, CLAUDE2].sort());
    assert.equal(later.nextLeaseExpiry, at(91));
    assert.deepEqual(derive(L, at(200)), { ...derive(L, at(200)), liveAgents: [], nextLeaseExpiry: null });
  });
  test("done tasks hold no lease", () => {
    assert.deepEqual(derive(state("done"), at(8)).liveAgents, []);
  });
  test("accepts a Date for now", () => {
    assert.equal(derive(state("claimed"), new Date(at(200))).tasks.T1.stale, true);
  });
});

test("plan stores dependencies as canonical task ids", async () => {
  const L = await import("../../skills/collab/lib/ledger.mjs");
  const at = "2026-11-16T10:00:00.000Z";
  let l = L.newLedger({ pr: { repo: "o/r", number: 1, headRef: "feat/x", baseRef: "main", defaultBranch: "main", ghLogin: "z" }, config: {}, agent: { id: "claude-aaaa", tool: "claude" }, now: new Date(at) });
  const t = (title, deps) => ({ title, accept: ["a"], scope: [], deps, size: "S" });
  l = L.apply(l, { v: 1, seq: l.seq + 1, type: "plan", agent: "claude-aaaa", at, data: { tasks: [t("a", []), t("b", ["1"]), t("c", ["t01", "T2"])] } });
  assert.deepEqual(l.tasks.T2.deps, ["T1"]);
  assert.deepEqual(l.tasks.T3.deps, ["T1", "T2"]);
});

test("another agent takes over planning once the planner's lease has expired", async () => {
  const L = await import("../../skills/collab/lib/ledger.mjs");
  const t0 = "2026-11-16T10:00:00.000Z";
  const late = "2026-11-16T10:20:00.000Z";
  let l = L.newLedger({ pr: { repo: "o/r", number: 1, headRef: "feat/x", baseRef: "main", defaultBranch: "main", ghLogin: "z" }, config: {}, agent: { id: "claude-aaaa", tool: "claude" }, now: new Date(t0) });
  l = L.apply(l, { v: 1, seq: l.seq + 1, type: "agent.join", agent: "codex-bbbb", at: t0, data: { tool: "codex" } });
  assert.throws(() => L.apply(l, { v: 1, seq: l.seq + 1, type: "planner.lease", agent: "codex-bbbb", at: t0, data: { leaseUntil: late } }), /holds the planner lease/);
  l = L.apply(l, { v: 1, seq: l.seq + 1, type: "planner.lease", agent: "codex-bbbb", at: late, data: { leaseUntil: "2026-11-16T10:35:00.000Z" } });
  l = L.apply(l, { v: 1, seq: l.seq + 1, type: "plan", agent: "codex-bbbb", at: late, data: { tasks: [{ title: "x", accept: ["a"], scope: [], deps: [], size: "S" }] } });
  assert.equal(l.phase, "active");
});

describe("the owner reserves a task for an invited agent", () => {
  const reserve = (task, agentFor, untilMin, by = "owner", min = 1) => ev("task.reserve", by, task, { for: agentFor, until: at(untilMin) }, min);
  test("only that agent can claim it until the reservation lapses", () => {
    const L = run(planned(), reserve("T1", CODEX, 60));
    assert.deepEqual(L.tasks.T1.reserved, { agent: CODEX, until: at(60) });
    assert.throws(() => run(L, claim(CLAUDE, "T1", 2)), (e) => e instanceof CollabError && e.code === EXIT.PRECONDITION && /reserved it for codex-7k2p/.test(e.message));
    const mine = run(L, claim(CODEX, "T1", 2));
    assert.equal(mine.tasks.T1.owner, CODEX);
    assert.equal(mine.tasks.T1.reserved, null, "claiming clears the reservation");
    assert.equal(run(L, claim(CLAUDE, "T1", 61)).tasks.T1.owner, CLAUDE, "a lapsed reservation no longer holds");
  });
  test("a task that waits on dependencies can be reserved; one in flight can't", () => {
    assert.equal(run(planned(), reserve("T3", CODEX, 60)).tasks.T3.reserved.agent, CODEX);
    assert.throws(() => run(planned(), claim(CLAUDE, "T1"), reserve("T1", CODEX, 60, "owner", 2)), /must be open/);
  });
  test("only the owner reserves; the owner or that agent releases", () => {
    assert.throws(() => run(planned(), reserve("T1", CODEX, 60, CLAUDE)), /only the owner can reserve/);
    assert.throws(() => run(planned(), reserve("T1", "Codex", 60)), /id of the agent/);
    const L = run(planned(), reserve("T1", CODEX, 60));
    const release = (by) => ev("task.reserve", by, "T1", { until: at(0) }, 2);
    assert.throws(() => run(L, release(CLAUDE)), /only the owner or the agent it is reserved for/);
    assert.equal(run(L, release(CODEX)).tasks.T1.reserved, null);
    assert.equal(run(L, release("owner")).tasks.T1.reserved, null);
    assert.throws(() => run(planned(), release("owner")), /not reserved/);
  });
  test("cancelling a reserved task drops the reservation", () => {
    const L = run(planned(), reserve("T1", CODEX, 60), ev("task.cancel", "owner", "T1", {}, 2));
    assert.equal(L.tasks.T1.status, "cancelled");
    assert.equal(L.tasks.T1.reserved, null);
  });
});

describe("a new ledger and the comments already on the PR", () => {
  const start = (extra) => newLedger({ pr: PR, agent: { id: CLAUDE, tool: "claude" }, now: T0, ...extra });
  test("starts after the newest comment, so older directives are refused", () => {
    const L = start({ lastCommentId: 500, lastCommentAt: "2026-11-16T11:00:00Z" });
    assert.equal(L.lastCommentId, 500);
    assert.equal(L.lastCommentAt, "2026-11-16T11:00:00.000Z");
    refused(() => apply(L, ev("directive", "owner", null, { commentId: 499, login: "zwymer", cmd: "pause" })), EXIT.PRECONDITION, /already seen/);
    assert.equal(apply(L, ev("directive", "owner", null, { commentId: 501, login: "zwymer", cmd: "pause" })).phase, "paused");
  });
  test("defaults to 0 with no time", () => {
    assert.equal(start().lastCommentId, 0);
    assert.equal(start().lastCommentAt, null);
  });
  test("directive and comments.seen record when the newest seen comment was written", () => {
    let L = apply(planned(), ev("directive", "owner", null, { commentId: 10, commentAt: "2026-11-16T12:01:00Z", login: "zwymer", cmd: "pause" }));
    assert.equal(L.lastCommentAt, "2026-11-16T12:01:00.000Z");
    L = apply(L, ev("comments.seen", "owner", null, { lastCommentId: 12, lastCommentAt: "2026-11-16T12:02:00Z" }));
    assert.deepEqual([L.lastCommentId, L.lastCommentAt], [12, "2026-11-16T12:02:00.000Z"]);
    // An older id never moves either value back.
    L = apply(L, ev("comments.seen", "owner", null, { lastCommentId: 11, lastCommentAt: "2026-11-16T12:01:30Z" }));
    assert.deepEqual([L.lastCommentId, L.lastCommentAt], [12, "2026-11-16T12:02:00.000Z"]);
  });
});

describe("a cancelled dependency no longer holds its dependents back", () => {
  test("the dependent can be claimed, and its deps are left as planned", () => {
    refused(() => apply(planned(), claim(CODEX, "T3", 1)), EXIT.PRECONDITION, /dependencies are not done: T1/);
    const L = apply(planned(), ev("task.cancel", CLAUDE, "T1", { reason: "not needed" }));
    assert.deepEqual(L.tasks.T3.deps, ["T1"]);
    assert.deepEqual(unmetDeps(L, L.tasks.T3), []);
    assert.deepEqual(cancelledDeps(L, L.tasks.T3), ["T1"]);
    assert.equal(apply(L, claim(CODEX, "T3", 2)).tasks.T3.owner, CODEX);
  });
  test("a /collab cancel directive does the same", () => {
    const L = apply(planned(), ev("directive", "owner", "T1", { commentId: 5, login: "zwymer", cmd: "cancel" }));
    assert.equal(L.tasks.T1.status, "cancelled");
    assert.equal(apply(L, claim(CODEX, "T3", 2)).tasks.T3.owner, CODEX);
  });
  test("what the cancelled task waited on still counts: T3 -> T2 (cancelled) -> T1", () => {
    const chain = [spec("one"), spec("two", { deps: ["T1"] }), spec("three", { deps: ["T2"] })];
    const L = apply(planned(chain), ev("task.cancel", CLAUDE, "T2", { reason: "x" }));
    assert.deepEqual(unmetDeps(L, L.tasks.T3), ["T1"]);
    refused(() => apply(L, claim(CODEX, "T3", 2)), EXIT.PRECONDITION, /dependencies are not done: T1/);
    const done = run(L, claim(CLAUDE, "T1", 2), push(CLAUDE, "T1", "s1", 3), verify(CLAUDE, "T1", "s1", true, 4), submit(CLAUDE, "T1", "s1", 5),
      rclaim(CODEX, "T1", 6), verdict(CODEX, "T1", "approve", "s1", 7), merge(CLAUDE, "T1", "s1", 8));
    assert.deepEqual(unmetDeps(done, done.tasks.T3), []);
    assert.equal(apply(done, claim(CODEX, "T3", 9)).tasks.T3.owner, CODEX);
  });
});

describe("fix-ci tasks: one at a time, withdrawn when CI is green again", () => {
  const fix = (sha, min = 1) => ev("task.add", CODEX, null, { kind: "fix-ci", forSha: sha, scope: [], deps: [], size: "S" }, min);
  const withdraw = (task, min = 2) => ev("task.cancel", CODEX, task, { reason: "green", withdrawn: true }, min);
  test("a second fix-ci task is refused while one is unfinished, even for a new head", () => {
    const L = apply(planned(), fix("bad1"));
    refused(() => apply(L, fix("bad2", 2)), EXIT.PRECONDITION, /T5 is already open for the red CI/);
    const done = apply(L, ev("task.cancel", CODEX, "T5", { reason: "x" }, 2));
    assert.equal(apply(done, fix("bad2", 3)).tasks.T6.forSha, "bad2");
  });
  test("red again at a withdrawn task's commit reopens that task instead of adding one", () => {
    const W = apply(apply(planned(), fix("bad1")), withdraw("T5"));
    assert.equal(W.tasks.T5.status, "cancelled");
    assert.equal(W.tasks.T5.withdrawn, true);
    const R = apply(W, fix("bad1", 3));
    assert.equal(R.tasks.T5.status, "open");
    assert.equal(R.tasks.T5.withdrawn, false);
    assert.equal(R.tasks.T6, undefined);
    assert.equal(R.nextTask, W.nextTask);
    // The freeze it covers starts at the reopen, and created is left alone.
    assert.equal(R.tasks.T5.times.reopened, at(3));
    assert.equal(R.tasks.T5.times.created, at(1));
    // It can flap again, and a new head while it is open is still the same failure.
    assert.equal(apply(apply(R, withdraw("T5", 4)), fix("bad1", 5)).tasks.T5.status, "open");
    refused(() => apply(R, fix("bad2", 4)), EXIT.PRECONDITION, /T5 is already open/);
    // A task someone cancelled on purpose is not reopened.
    const C = apply(apply(planned(), fix("bad1")), ev("task.cancel", CODEX, "T5", { reason: "x" }, 2));
    refused(() => apply(C, fix("bad1", 3)), EXIT.PRECONDITION, /T5 already covers/);
  });
  test("a reopened task keeps the link to its sub-PR, so close and cancel can still find it", () => {
    const L = run(apply(planned(), fix("bad1")), claim(CODEX, "T5", 2), push(CODEX, "T5", "f1", 3, { subPr: 77 }), ev("task.release", CODEX, "T5", {}, 4), withdraw("T5", 5));
    assert.equal(L.tasks.T5.subPr, 77, "the withdrawn task keeps its link");
    assert.equal(apply(L, fix("bad1", 6)).tasks.T5.subPr, 77);
  });
  test("only an open fix-ci task can be withdrawn", () => {
    refused(() => apply(planned(), withdraw("T2")), EXIT.PRECONDITION, /only an open fix-ci task can be withdrawn/);
    const claimed = apply(apply(planned(), fix("bad1")), claim(CODEX, "T5", 2));
    refused(() => apply(claimed, withdraw("T5", 3)), EXIT.PRECONDITION, /only an open fix-ci task can be withdrawn/);
  });
});

describe("owner questions and decisions", () => {
  const block = (min, needsOwner = true) => ev("task.block", CLAUDE, "T1", { reason: "which?", needsOwner }, min);
  const decide = (text, min) => ev("task.unblock", "owner", "T1", { decision: text }, min);
  test("a new block clears the last decision, so it can't read as the answer to the new question", () => {
    let L = run(state("claimed"), block(2), decide("A", 3));
    assert.equal(L.tasks.T1.decision.text, "A");
    L = apply(L, block(4));
    assert.equal(L.tasks.T1.decision, undefined);
    assert.equal(apply(L, decide("B", 5)).tasks.T1.decision.text, "B");
  });
  test("asking the same question again keeps its time; a different question is a new one", () => {
    const L = run(state("claimed"), block(2));
    assert.equal(apply(L, block(5)).tasks.T1.blocked.since, at(2));
    // Repeated by someone else (the PR owner): still the first asker, who the notice names.
    const again = apply(L, ev("task.block", "owner", "T1", { reason: "which?", needsOwner: true }, 6));
    assert.deepEqual(again.tasks.T1.blocked, L.tasks.T1.blocked);
    const other = apply(L, ev("task.block", CLAUDE, "T1", { reason: "something else?", needsOwner: true }, 5));
    assert.equal(other.tasks.T1.blocked.since, at(5));
    // A peer block turned into an owner question is new too.
    const peer = run(state("claimed"), block(2, false));
    assert.equal(apply(peer, block(5)).tasks.T1.blocked.since, at(5));
  });
  test("only the owner can allow a task to change protected files", () => {
    const L = run(state("claimed"), block(2));
    refused(() => apply(L, ev("task.unblock", CLAUDE, "T1", { allowProtected: true }, 3)), EXIT.PRECONDITION, /only the owner can allow changes to protected files/);
    assert.equal(apply(L, decide("ok", 3)).tasks.T1.allowProtected, undefined);
    const allowed = apply(L, ev("task.unblock", "owner", "T1", { decision: "ok", allowProtected: true }, 3));
    assert.equal(allowed.tasks.T1.allowProtected, true);
    assert.equal(allowed.tasks.T1.blocked, null);
    // It was for the agent that asked: a release, or a steal by another agent, ends it.
    assert.equal(apply(allowed, ev("task.release", CLAUDE, "T1", {}, 4)).tasks.T1.allowProtected, undefined);
    assert.equal(apply(allowed, steal(CODEX, "T1", 200)).tasks.T1.allowProtected, undefined);
  });
  test("a block that isn't a question for the owner keeps the decision", () => {
    let L = run(state("claimed"), block(2), decide("A", 3), block(4, false));
    assert.equal(L.tasks.T1.decision.text, "A");
    L = apply(L, ev("task.unblock", CLAUDE, "T1", {}, 5));
    assert.equal(L.tasks.T1.decision.text, "A");
  });
});

describe("CI runs the tests (\"verify\": \"ci\")", () => {
  const CI = { verify: "ci", ciWorkflows: ["ci.yml"] };
  const URL = (id) => `https://github.com/o/r/actions/runs/${id}`;
  const started = (agent = CLAUDE, sha = "sha1", min = 3, since = { "ci.yml": 40 }) => ev("task.ci", agent, "T1", { sha, state: "started", runs: [{ workflow: "ci.yml" }], since }, min);
  const result = (state, agent = CLAUDE, sha = "sha1", min = 5, extra = {}) => ev("task.ci", agent, "T1", { sha, state, runs: [{ workflow: "ci.yml", id: 77, url: URL(77), status: "completed", conclusion: state === "passed" ? "success" : "failure" }], summary: `ci.yml ${state}`, ...extra }, min);
  const pushedCi = (extra) => run(state("claimed", planned(DEFAULT_TASKS, CI)), push(CLAUDE, "T1", "sha1", 2, extra));
  const WF = { touched: [".github/workflows/ci.yml"] };

  test("ciMode reads the config; ciAt only answers for the head; a ledger on CI is schema 2", () => {
    assert.equal(ciMode(fresh()), false);
    assert.equal(ciMode(fresh(CI)), true);
    assert.equal(fresh().schema, 1);
    assert.equal(fresh(CI).schema, 2, "a collab from before CI mode refuses it instead of merging without CI");
    const L = apply(pushedCi(), started());
    assert.equal(ciAt(L.tasks.T1).state, "running");
    assert.equal(ciAt(apply(L, push(CLAUDE, "T1", "sha2", 4)).tasks.T1), null);
  });
  test("the owner or the reviewer starts it at the head, once while it runs, keeping the run baseline", () => {
    const L = pushedCi();
    refused(() => apply(L, started(CODEX)), EXIT.PRECONDITION, /only the owner \(claude-a1f3\) or the reviewer \(none\) can start CI/);
    refused(() => apply(L, started(CLAUDE, "sha0")), EXIT.PRECONDITION, /the head is sha1, not sha0/);
    const s1 = apply(L, started(CLAUDE, "sha1", 3, { "ci.yml": 40, "../x.yml": 1, "lint.yml": -1 }));
    assert.deepEqual(s1.tasks.T1.ci, { sha: "sha1", state: "running", by: CLAUDE, at: at(3), runs: [{ workflow: "ci.yml", id: null, url: null, status: null, conclusion: null }], summary: "", since: { "ci.yml": 40 } });
    refused(() => apply(s1, started(CLAUDE, "sha1", 4)), EXIT.PRECONDITION, /CI is already running at sha1/);
  });
  test("CI isn't started for a task that changes a workflow, nor when the tests run on the machines", () => {
    refused(() => apply(pushedCi(WF), started()), EXIT.PRECONDITION, /it changes a workflow, so its tests run on the machine/);
    assert.deepEqual(touchesWorkflows(pushedCi(WF).tasks.T1), [".github/workflows/ci.yml"]);
    assert.deepEqual(touchesWorkflows({ touched: ["src\\a.mjs", ".github\\actions\\setup\\action.yml"] }), [".github\\actions\\setup\\action.yml"]);
    const local = run(state("claimed"), push(CLAUDE, "T1", "sha1", 2));
    refused(() => apply(local, started()), EXIT.PRECONDITION, /runs the tests on the agents' machines, not on CI/);
  });
  test("with the tests on CI, a verify from a machine counts only for a task that changes a workflow", () => {
    refused(() => apply(pushedCi(), verify(CLAUDE, "T1", "sha1", true)), EXIT.PRECONDITION, /this collab runs the tests on CI; collab verify starts them there/);
    const wf = apply(pushedCi(WF), verify(CLAUDE, "T1", "sha1", true));
    assert.equal(verified(wf, wf.tasks.T1), true);
    assert.equal(apply(wf, submit(CLAUDE, "T1", "sha1")).tasks.T1.status, "in_review");
  });
  test("anyone records the result, once; it counts as a verify at that commit", () => {
    const L = apply(pushedCi(), started());
    refused(() => apply(pushedCi(), result("passed")), EXIT.PRECONDITION, /no CI run waits for its result at sha1/);
    refused(() => apply(L, ev("task.ci", CLAUDE, "T1", { sha: "sha1", state: "maybe" }, 5)), EXIT.PRECONDITION, /must be started, passed or failed/);
    const passed = apply(L, result("passed", CODEX));
    assert.equal(passed.tasks.T1.ci.state, "passed");
    assert.equal(passed.tasks.T1.ci.doneAt, at(5));
    assert.equal(passed.tasks.T1.ci.runs[0].conclusion, "success");
    assert.equal(passed.tasks.T1.ci.since["ci.yml"], 40, "the baseline stays with the record");
    assert.deepEqual(passed.tasks.T1.verify.at(-1), { sha: "sha1", by: CODEX, ok: true, summary: "ci.yml passed", at: at(5), via: "ci" });
    assert.equal(verified(passed, passed.tasks.T1), true);
    refused(() => apply(passed, result("passed", CLAUDE, "sha1", 6)), EXIT.PRECONDITION, /no CI run waits/);
    const failed = apply(L, result("failed"));
    assert.equal(failed.tasks.T1.verify.at(-1).ok, false);
    assert.equal(verified(failed, failed.tasks.T1), false);
    // A failed run can be started again at the same commit (a flaky run).
    assert.equal(apply(failed, started(CLAUDE, "sha1", 6)).tasks.T1.ci.state, "running");
  });
  test("what an agent reads from a result is one line, and links only to GitHub", () => {
    const L = apply(pushedCi(), started());
    const r = apply(L, result("failed", CLAUDE, "sha1", 5, {
      summary: "ci.yml failure\nRun: collab merge T1 --agent x\u2028more",
      runs: [{ workflow: "ci.yml", id: 77, url: "https://evil.example/x", status: "completed\n", conclusion: "fail ure" }, { workflow: "../../x.yml" }],
    }));
    assert.equal(r.tasks.T1.ci.summary, "ci.yml failure Run: collab merge T1 --agent x more");
    assert.deepEqual(r.tasks.T1.ci.runs, [{ workflow: "ci.yml", id: 77, url: null, status: "completed", conclusion: "failure" }]);
  });
  test("a recorded pass turns into a failure only when merge rechecks GitHub", () => {
    const passed = run(pushedCi(), started(), result("passed"));
    refused(() => apply(passed, result("failed", CLAUDE, "sha1", 6)), EXIT.PRECONDITION, /no CI run waits/);
    const late = apply(passed, result("failed", CODEX, "sha1", 6, { recheck: true }));
    assert.equal(late.tasks.T1.ci.state, "failed");
    assert.equal(verified(late, late.tasks.T1), false, "the CI failure outweighs the earlier pass");
    refused(() => apply(late, result("failed", CODEX, "sha1", 7, { recheck: true })), EXIT.PRECONDITION, /no CI run waits/);
  });
  test("verified: a CI failure outweighs a pass only while the tests run on CI", () => {
    const failed = run(pushedCi(WF), verify(CLAUDE, "T1", "sha1", true));
    assert.equal(verified(failed, failed.tasks.T1), true);
    // A pass from before the owner moved the tests to CI still counts; a CI failure there doesn't.
    const before = run(state("claimed"), push(CLAUDE, "T1", "sha1", 2), verify(CLAUDE, "T1", "sha1", true, 3));
    const moved = apply(before, ev("config.verify", "owner", null, { verify: "ci", ciWorkflows: ["ci.yml"] }, 4));
    assert.equal(verified(moved, moved.tasks.T1), true);
    const bad = run(moved, started(CLAUDE, "sha1", 5), result("failed", CLAUDE, "sha1", 6));
    assert.equal(verified(bad, bad.tasks.T1), false);
    // Moved back to the machines: the CI record is ignored, and a pass there counts again.
    const back = apply(bad, ev("config.verify", "owner", null, { verify: "local" }, 7));
    assert.equal(verified(back, back.tasks.T1), true);
  });
  test("submit goes ahead while CI runs, but not before it starts or after it failed", () => {
    refused(() => apply(pushedCi(), submit(CLAUDE, "T1", "sha1")), EXIT.PRECONDITION, /CI has neither passed nor started at sha1; run collab verify T1/);
    const running = apply(pushedCi(), started());
    assert.equal(apply(running, submit(CLAUDE, "T1", "sha1")).tasks.T1.status, "in_review");
    refused(() => run(running, result("failed"), submit(CLAUDE, "T1", "sha1", 6)), EXIT.PRECONDITION, /CI failed at sha1; fix it first/);
    // Without CI mode a started CI does not let a submit through.
    const local = run(state("claimed"), push(CLAUDE, "T1", "sha1", 2));
    refused(() => apply(local, submit(CLAUDE, "T1", "sha1")), EXIT.PRECONDITION, /no passing collab verify at sha1/);
  });
  test("the result can come in after the approval", () => {
    const L = run(pushedCi(), started(), submit(CLAUDE, "T1", "sha1"), rclaim(CODEX, "T1", 5), verdict(CODEX, "T1", "approve", "sha1", 6));
    assert.equal(L.tasks.T1.status, "approved");
    assert.equal(apply(L, result("passed", CLAUDE, "sha1", 7)).tasks.T1.ci.state, "passed");
  });
  test("only the owner moves the tests, to CI only with workflows, also while planning or paused", () => {
    const L = planned();
    refused(() => apply(L, ev("config.verify", CLAUDE, null, { verify: "ci", ciWorkflows: ["ci.yml"] })), EXIT.PRECONDITION, /only the owner can say where the tests run/);
    refused(() => apply(L, ev("config.verify", "owner", null, { verify: "ci" })), EXIT.PRECONDITION, /needs ciWorkflows/);
    refused(() => apply(L, ev("config.verify", "owner", null, { verify: "ci", ciWorkflows: ["../x.yml"] })), EXIT.PRECONDITION, /must list workflow file names/);
    refused(() => apply(L, ev("config.verify", "owner", null, { verify: "remote" })), EXIT.PRECONDITION, /must be "local" or "ci"/);
    const ci = apply(L, ev("config.verify", "owner", null, { verify: "ci", ciWorkflows: ["ci.yml", "ci.yml"] }));
    assert.equal(ci.config.verify, "ci");
    assert.deepEqual(ci.config.ciWorkflows, ["ci.yml"]);
    assert.equal(ci.schema, 2);
    const back = apply(ci, ev("config.verify", "owner", null, { verify: "local" }, 2));
    assert.equal(back.config.verify, "local");
    assert.equal(back.schema, 2, "the schema never goes back");
    assert.equal(apply(back, ev("config.verify", "owner", null, { verify: "ci" }, 3)).config.verify, "ci", "the workflows set before still count");
    assert.equal(apply(fresh(), ev("config.verify", "owner", null, { verify: "local" })).config.verify, "local", "while planning");
    const paused = apply(state("claimed"), ev("phase.set", "owner", null, { phase: "paused" }, 5));
    assert.equal(apply(paused, ev("config.verify", "owner", null, { verify: "ci", ciWorkflows: ["ci.yml"] }, 6)).config.verify, "ci", "while paused");
  });
});
