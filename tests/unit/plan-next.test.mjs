import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";
import { addMinutes } from "../../skills/collab/lib/clock.mjs";
import { apply, newPlanLedger, stateKey } from "../../skills/collab/lib/plan-ledger.mjs";
import { planNext } from "../../skills/collab/lib/plan-next.mjs";

// ---------------------------------------------------------------- fixtures (time is pinned)

const T0 = "2026-11-16T12:00:00.000Z";
const at = (min) => addMinutes(T0, min);
const ISSUE = { repo: "o/r", number: 57, url: "https://github.com/o/r/issues/57", title: "Cache", defaultBranch: "main" };
const OWNER = "zwymer";
const ALICE = "alice";
const BOB = "bob";
const CAROL = "carol";
const CLAUDE = "claude-a1f3";
const CODEX = "codex-7k2p";
const GEMINI = "gemini-9z9z";
const GROK = "grok-x1y2";

const hash = (label) => `sha256:${createHash("sha256").update(label).digest("hex")}`;
const blob = (label) => createHash("sha1").update(label).digest("hex");
const ev = (type, login, agent, data = {}, min = 1) => (agent ? { type, login, agent, data, at: at(min) } : { type, login, data, at: at(min) });
const run = (L, ...events) => events.reduce(apply, L);
const join = (login, agent, tool, min = 2) => ev("plan.join", login, agent, { tool }, min);
const agree = (L, login, agent, min = 20) => ev("agree", login, agent, { rev: L.current, hash: L.revs[L.current].hash, via: agent ? `agent:${agent}` : "terminal" }, min);

function fresh(minPeople = 2) {
  return newPlanLedger({ issue: ISSUE, owner: OWNER, agent: { id: CLAUDE, tool: "claude" }, minPeople, rev1: { hash: hash("one"), blob: blob("one"), chars: 3, summary: "First" }, now: T0 });
}
// zwymer and alice, at revision 2.
function duo(minPeople) {
  const L = run(fresh(minPeople), join(ALICE, CODEX, "codex"));
  return apply(L, ev("rev.add", ALICE, CODEX, { rev: 2, hash: hash("two"), blob: blob("two"), base: 1, chars: 3, summary: "Second" }, 10));
}
function agreed() {
  const L = duo();
  return run(L, agree(L, OWNER, CLAUDE, 20), agree(L, ALICE, CODEX, 21));
}
function handed() {
  const L = agreed();
  return apply(L, ev("handoff", ALICE, CODEX, { pr: 61, url: "https://github.com/o/r/pull/61", rev: 2, hash: L.revs[2].hash }, 30));
}
const closed = () => apply(duo(), ev("state.set", OWNER, null, { phase: "closed", reason: "done" }, 40));
// The seen state of an agent that read everything just now.
const seenOf = (L) => ({ key: stateKey(L), commentId: 0 });
const cmd = (sub, me, n = "57") => ["collab", "plan", sub, n, "--agent", me];

function deepFreeze(o) {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

// ---------------------------------------------------------------- each action, in priority order

describe("planNext: 1. closed", () => {
  test("a closed session stops everyone, joined or not", () => {
    const C = closed();
    for (const me of [CODEX, "gemini-0000"]) {
      const r = planNext(C, me, seenOf(C));
      assert.deepEqual(r, { action: "closed", why: "plan #57 is closed; stop work on it", cmd: [] });
    }
  });
  test("a closed issue counts too, in either case, and beats everything else", () => {
    const L = duo();
    assert.equal(planNext(L, CODEX, null, { issueState: "CLOSED" }).action, "closed");
    assert.equal(planNext(L, CODEX, null, { issueState: "closed" }).action, "closed");
    assert.equal(planNext(L, "stranger-1", null, { issueState: "CLOSED", newComments: 4 }).action, "closed");
    assert.equal(planNext(L, CODEX, seenOf(L), { issueState: "OPEN" }).action, "wait");
  });
});

describe("planNext: 2. join, removed and left", () => {
  test("an agent that has not joined joins first", () => {
    assert.deepEqual(planNext(duo(), "gemini-0000", null), {
      action: "join", why: "you (gemini-0000) have not joined plan #57; join first", cmd: cmd("join", "gemini-0000"),
    });
  });
  test("join beats read", () => {
    assert.equal(planNext(duo(), "gemini-0000", null, { newComments: 3 }).action, "join");
  });
  test("a removed person's agents stop", () => {
    const L = run(duo(), join(BOB, GEMINI, "gemini", 11), ev("person.remove", OWNER, null, { target: BOB, reason: "spam" }, 12));
    assert.deepEqual(planNext(L, GEMINI, null), { action: "removed", why: "bob was removed from plan #57 by zwymer; stop work on it", cmd: [] });
  });
  test("a person who left: the agent stops rather than rejoining for them", () => {
    const L = run(duo(), join(BOB, GEMINI, "gemini", 11), ev("person.leave", BOB, GEMINI, {}, 12));
    const r = planNext(L, GEMINI, seenOf(L));
    assert.equal(r.action, "left");
    assert.deepEqual(r.cmd, []);
    assert.match(r.why, /^bob left plan #57; stop work on it \(run collab plan join 57 only if bob asks to take part again\)$/);
  });
});

describe("planNext: 3. read", () => {
  test("never read, or the state key moved: show the plan", () => {
    const L = duo();
    assert.deepEqual(planNext(L, CODEX, null), { action: "read", why: "you have not read plan #57 yet: read it", cmd: cmd("show", CODEX) });
    const stale = { key: "r1.drafting.0000000000000000", commentId: 0 };
    assert.deepEqual(planNext(L, CODEX, stale), { action: "read", why: "plan #57 changed since you last read it (revision 2, drafting): read it", cmd: cmd("show", CODEX) });
  });
  test("new comments: read them, even when the state is the same", () => {
    const L = duo();
    assert.equal(planNext(L, CODEX, seenOf(L), { newComments: 1 }).why, "1 new comment on plan #57: read it");
    assert.equal(planNext(L, CODEX, seenOf(L), { newComments: 3 }).why, "3 new comments on plan #57: read it");
    assert.equal(planNext(L, CODEX, null, { newComments: 2 }).why, "you have not read plan #57 yet; 2 new comments on plan #57: read it");
  });
  test("lastSeen alone does not make an agent read again", () => {
    const L = duo();
    const later = apply(L, ev("agent.seen", OWNER, CLAUDE, {}, 50));
    assert.equal(planNext(later, CODEX, seenOf(L)).action, "wait");
  });
  test("an agreement by someone else does", () => {
    const L = duo();
    const after = apply(L, agree(L, OWNER, CLAUDE, 20));
    assert.equal(planNext(after, CODEX, seenOf(L)).action, "read");
  });
  test("read beats handed-off and agreed", () => {
    assert.equal(planNext(handed(), CODEX, null).action, "read");
    assert.equal(planNext(agreed(), CODEX, { key: "old" }).action, "read");
  });
});

describe("planNext: 4. handed-off", () => {
  test("names the build PR and its URL; nothing to run", () => {
    const H = handed();
    assert.deepEqual(planNext(H, CLAUDE, seenOf(H)), {
      action: "handed-off", why: "plan #57 was handed off to PR #61 (https://github.com/o/r/pull/61); the build happens there, so stop work on the plan", cmd: [],
    });
  });
  test("an unsafe URL is left out", () => {
    const H = handed();
    const bad = { ...H, handoff: { ...H.handoff, url: "javascript:alert(1)" } };
    assert.equal(planNext(bad, CLAUDE, seenOf(bad)).why, "plan #57 was handed off to PR #61; the build happens there, so stop work on the plan");
  });
});

describe("planNext: 5. agreed", () => {
  test("an active person's agent hands it off", () => {
    const F = agreed();
    const r = planNext(F, CODEX, seenOf(F));
    assert.equal(r.action, "agreed");
    assert.deepEqual(r.cmd, cmd("handoff", CODEX));
    assert.equal(r.why, `everyone agreed to revision 2 (${hash("two").slice(7, 15)}) of plan #57: hand it off to a build PR`);
  });
  test("an observer (joined after the agreement) only waits, so plan wait keeps polling", () => {
    const F = apply(agreed(), join(CAROL, GROK, "grok", 30));
    const r = planNext(F, GROK, seenOf(F));
    assert.equal(r.action, "wait");
    assert.deepEqual(r.cmd, cmd("wait", GROK));
    assert.equal(r.why, "everyone agreed to revision 2 of plan #57; carol joined after that and only watches until the owner reopens it");
  });
});

describe("planNext: 6. wait", () => {
  test("names who has not agreed yet", () => {
    const L = duo();
    const one = apply(L, agree(L, ALICE, CODEX, 20));
    const r = planNext(one, CODEX, seenOf(one));
    assert.equal(r.action, "wait");
    assert.deepEqual(r.cmd, cmd("wait", CODEX));
    assert.equal(r.why, `waiting for zwymer to agree to revision 2 (${hash("two").slice(7, 15)}) of plan #57`);
  });
  test("when my person is awaited, says to ask them and agree only after their yes", () => {
    const L = duo();
    const r = planNext(L, CODEX, seenOf(L));
    assert.equal(r.why, `waiting for alice (the person you act for) and zwymer to agree to revision 2 (${hash("two").slice(7, 15)}) of plan #57; show alice the plan and ask them; run collab plan agree only after they say yes to this revision`);
  });
  test("lists three or more people with commas", () => {
    const L = run(duo(), join(BOB, GEMINI, "gemini", 11));
    assert.match(planNext(L, CLAUDE, seenOf(L)).why, /^waiting for alice, bob and zwymer \(the person you act for\) to agree/);
  });
  test("says how many more people must join", () => {
    const solo = fresh();
    const mine = apply(solo, agree(solo, OWNER, CLAUDE, 5));
    assert.equal(planNext(mine, CLAUDE, seenOf(mine)).why, `everyone in plan #57 so far agreed to revision 1 (${hash("one").slice(7, 15)}); 1 more person must join (it needs at least 2 people)`);
    const big = fresh(4);
    assert.match(planNext(big, CLAUDE, seenOf(big)).why, /; 3 more people must join \(it needs at least 4 people\)$/);
  });
});

describe("planNext: options and purity", () => {
  test("number overrides the issue number in the command", () => {
    const L = duo();
    assert.deepEqual(planNext(L, CODEX, null, { number: 99 }).cmd, cmd("show", CODEX, "99"));
    assert.deepEqual(planNext(L, "x-1", null, { number: "99" }).cmd, cmd("join", "x-1", "99"));
  });
  test("defaults: an open issue and no new comments", () => {
    const L = duo();
    assert.equal(planNext(L, CODEX, seenOf(L)).action, "wait");
    assert.equal(planNext(L, CODEX, seenOf(L), {}).action, "wait");
  });
  test("never mutates the ledger or the seen state", () => {
    const L = deepFreeze(agreed());
    const seen = deepFreeze(seenOf(L));
    const before = JSON.stringify([L, seen]);
    planNext(L, CODEX, seen);
    planNext(L, CODEX, null, { newComments: 2 });
    assert.equal(JSON.stringify([L, seen]), before);
  });
  test("every result has an action, a why and a cmd array", () => {
    const cases = [
      [closed(), CODEX, null], [duo(), "x-1", null], [duo(), CODEX, null], [handed(), CODEX, seenOf(handed())],
      [agreed(), CODEX, seenOf(agreed())], [duo(), CODEX, seenOf(duo())],
    ];
    const actions = cases.map(([L, me, seen]) => {
      const r = planNext(L, me, seen);
      assert.deepEqual(Object.keys(r), ["action", "why", "cmd"]);
      assert.equal(typeof r.why, "string");
      assert.ok(Array.isArray(r.cmd));
      return r.action;
    });
    assert.deepEqual(actions, ["closed", "join", "read", "handed-off", "agreed", "wait"]);
  });
});
