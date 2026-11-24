import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";
import { addMinutes } from "../../skills/collab/lib/clock.mjs";
import { CollabError, EXIT } from "../../skills/collab/lib/errors.mjs";
import {
  EVENT_TYPES, MAX_CHARS, PHASES, SCHEMA, activePeople, apply, consensus, isOwner, newPlanLedger, personOf, personStatus, stateKey,
} from "../../skills/collab/lib/plan-ledger.mjs";

// ---------------------------------------------------------------- fixtures (time is pinned)

const T0 = "2026-11-16T12:00:00.000Z";
const at = (min) => addMinutes(T0, min);
const ISSUE = { repo: "o/r", number: 57, url: "https://github.com/o/r/issues/57", title: "Cache the API responses", defaultBranch: "main" };
const OWNER = "zwymer";
const ALICE = "alice";
const BOB = "bob";
const CAROL = "carol";
const CLAUDE = "claude-a1f3";
const CODEX = "codex-7k2p";
const GEMINI = "gemini-9z9z";
const GROK = "grok-x1y2";
const CLAUDE2 = "claude-b2c4";

const hash = (label) => `sha256:${createHash("sha256").update(label).digest("hex")}`;
const blob = (label) => createHash("sha1").update(label).digest("hex");
const REV1 = { hash: hash("one"), blob: blob("one"), chars: 120, summary: "First draft" };

const ev = (type, login, agent, data = {}, min = 1) => (agent ? { type, login, agent, data, at: at(min) } : { type, login, data, at: at(min) });
const run = (L, ...events) => events.reduce(apply, L);

function fresh({ minPeople } = {}) {
  return newPlanLedger({ issue: ISSUE, owner: OWNER, agent: { id: CLAUDE, tool: "claude", host: "pc" }, ...(minPeople ? { minPeople } : {}), rev1: REV1, now: T0 });
}
const join = (login, agent, tool, min = 2) => ev("plan.join", login, agent, { tool, host: "pc" }, min);
// The next revision of L, by `login` through `agent`.
const revAdd = (L, login, agent, label, min = 10, extra = {}) =>
  ev("rev.add", login, agent, { rev: L.current + 1, hash: hash(label), blob: blob(label), base: L.current, merged: false, summary: label, chars: 200, ...extra }, min);
const agree = (L, login, agent, min = 20, extra = {}) =>
  ev("agree", login, agent, { rev: L.current, hash: L.revs[L.current].hash, via: agent ? `agent:${agent}` : "terminal", ...extra }, min);
const close = (min = 40, login = OWNER, extra = {}) => ev("state.set", login, null, { phase: "closed", reason: "done", ...extra }, min);

// zwymer (owner, Claude) and alice (Codex), at revision 2 by alice.
function duo(opts) {
  const L = run(fresh(opts), join(ALICE, CODEX, "codex", 2));
  return apply(L, revAdd(L, ALICE, CODEX, "two", 10));
}
// duo, plus bob (Gemini).
function trio(opts) {
  return apply(duo(opts), join(BOB, GEMINI, "gemini", 11));
}
// duo, with both agreed: phase agreed.
function agreed() {
  const L = duo();
  return run(L, agree(L, OWNER, CLAUDE, 20), agree(L, ALICE, CODEX, 21));
}
const handed = (L = agreed()) => apply(L, ev("handoff", ALICE, CODEX, { pr: 61, url: "https://github.com/o/r/pull/61", branch: "plan/57", path: "docs/plans/57.md", rev: L.current, hash: L.revs[L.current].hash }, 30));

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

// ---------------------------------------------------------------- constants and the constructor

describe("plan ledger: exports", () => {
  test("constants", () => {
    assert.equal(SCHEMA, 1);
    assert.deepEqual([...PHASES], ["drafting", "agreed", "handed-off", "closed"]);
    assert.equal(MAX_CHARS, 50000);
    assert.deepEqual([...EVENT_TYPES].sort(), [
      "agent.seen", "agree", "agree.withdraw", "comments.seen", "directive", "handoff", "notice.sent", "person.leave",
      "person.remove", "plan.join", "reopen", "rev.add", "state.set",
    ]);
  });
});

describe("newPlanLedger", () => {
  test("starts drafting at revision 1, with the owner as a person and their agent registered", () => {
    assert.deepEqual(fresh(), {
      schema: 1, kind: "plan", seq: 0, rev: null,
      issue: ISSUE,
      owner: OWNER, phase: "drafting", current: 1, minPeople: 2, maxChars: 50000,
      revs: { 1: { hash: REV1.hash, blob: REV1.blob, base: 0, merged: false, agent: CLAUDE, login: OWNER, summary: "First draft", chars: 120, at: T0 } },
      people: { [OWNER]: { joinedAt: T0, lastSeen: T0, observer: false, left: null, removed: null } },
      agents: { [CLAUDE]: { tool: "claude", vendor: "anthropic", login: OWNER, host: "pc", joinedAt: T0, lastSeen: T0 } },
      agreements: {}, directives: [], lastCommentId: 0, lastCommentAt: null, notices: {},
      handoff: null, agreedAt: null, closed: null,
    });
  });
  test("minPeople, the comment watermark and a Date for now", () => {
    const L = newPlanLedger({ issue: ISSUE, owner: OWNER, agent: { id: "x-1" }, minPeople: 3, rev1: REV1, now: new Date(T0), lastCommentId: 99, lastCommentAt: at(-5) });
    assert.equal(L.minPeople, 3);
    assert.equal(L.lastCommentId, 99);
    assert.equal(L.lastCommentAt, at(-5));
    assert.equal(L.people[OWNER].joinedAt, T0);
    assert.deepEqual(L.agents["x-1"], { tool: "other", vendor: "other", login: OWNER, host: null, joinedAt: T0, lastSeen: T0 });
  });
  const BAD = [
    ["no issue number", { issue: { repo: "o/r" } }],
    ["no owner", { owner: "" }],
    ["no agent id", { agent: { tool: "claude" } }],
    ["no now", { now: undefined }],
    ["minPeople 0", { minPeople: 0 }],
    ["a malformed hash", { rev1: { ...REV1, hash: "abc" } }],
    ["a malformed blob", { rev1: { ...REV1, blob: "xyz" } }],
    ["no chars", { rev1: { ...REV1, chars: undefined } }],
  ];
  for (const [name, over] of BAD) {
    test(`refuses ${name} (a bug)`, () => {
      const args = { issue: ISSUE, owner: OWNER, agent: { id: CLAUDE, tool: "claude" }, rev1: REV1, now: T0, ...over };
      assert.throws(() => newPlanLedger(args), TypeError);
    });
  }
  test("a plan over MAX_CHARS is the user's to fix", () => {
    assert.equal(newPlanLedger({ issue: ISSUE, owner: OWNER, agent: { id: CLAUDE }, rev1: { ...REV1, chars: MAX_CHARS }, now: T0 }).revs[1].chars, MAX_CHARS);
    refused(() => newPlanLedger({ issue: ISSUE, owner: OWNER, agent: { id: CLAUDE }, rev1: { ...REV1, chars: MAX_CHARS + 1 }, now: T0 }), EXIT.PRECONDITION, /zwymer can't start plan #57: the plan is 50001 characters, and the most is 50000/);
  });
});

// ---------------------------------------------------------------- apply: general rules

describe("plan apply: general", () => {
  test("never mutates its input, even a deeply frozen one", () => {
    const cases = [
      [duo(), (L) => agree(L, ALICE, CODEX, 20)],
      [(() => { const L = duo(); return apply(L, agree(L, OWNER, CLAUDE, 20)); })(), (L) => agree(L, ALICE, CODEX, 21)],
      [trio(), () => ev("person.remove", OWNER, CLAUDE, { target: BOB, reason: "x" }, 30)],
      [agreed(), () => ev("reopen", OWNER, null, {}, 30)],
      [agreed(), () => join(CAROL, GROK, "grok", 30)],
      [duo(), (L) => revAdd(L, OWNER, CLAUDE, "three", 30)],
    ];
    for (const [ledger, make] of cases) {
      const L = deepFreeze(ledger);
      const before = JSON.stringify(L);
      const event = deepFreeze(make(L));
      const out = apply(L, event);
      assert.equal(JSON.stringify(L), before, event.type);
      assert.notEqual(out, L);
      out.people[OWNER].lastSeen = "x";
      out.agents[CLAUDE].tool = "y";
      assert.equal(JSON.stringify(L), before, event.type);
    }
  });
  test("does not keep references to event data", () => {
    const L = agreed();
    const data = { pr: 61, url: "https://github.com/o/r/pull/61", rev: 2, hash: L.revs[2].hash, extra: { list: [1] } };
    const out = apply(L, { type: "handoff", login: ALICE, data, at: at(30) });
    data.extra.list.push(2);
    assert.deepEqual(out.handoff.extra, { list: [1] });
  });
  test("bumps seq by one and updates the actor's and their agent's lastSeen", () => {
    const L = trio();
    const out = apply(L, ev("agent.seen", BOB, GEMINI, {}, 77));
    assert.equal(out.seq, L.seq + 1);
    assert.equal(out.people[BOB].lastSeen, at(77));
    assert.equal(out.agents[GEMINI].lastSeen, at(77));
    assert.equal(out.people[ALICE].lastSeen, L.people[ALICE].lastSeen);
    assert.equal(out.agents[CODEX].lastSeen, L.agents[CODEX].lastSeen);
  });
  test("a directive (someone's comment, processed later) touches nobody's lastSeen", () => {
    const L = duo();
    const out = apply(L, ev("directive", ALICE, CLAUDE, { commentId: 5, cmd: "agree", applied: false }, 77));
    assert.deepEqual(out.people, L.people);
    assert.deepEqual(out.agents, L.agents);
  });
  test("times are stored as ISO strings ending in Z", () => {
    const out = apply(duo(), { type: "agent.seen", login: ALICE, agent: CODEX, data: {}, at: "2026-11-16T13:00:00+01:00" });
    assert.equal(out.people[ALICE].lastSeen, "2026-11-16T12:00:00.000Z");
  });
});

describe("plan apply: refusal order and exit codes", () => {
  test("a schema mismatch comes first (ENV), even for a malformed event", () => {
    refused(() => apply({ ...duo(), schema: 2 }, {}), EXIT.ENV, /schema 2/);
  });
  test("a PR ledger is not a plan ledger (ENV)", () => {
    const { kind, ...noKind } = duo();
    assert.equal(kind, "plan");
    refused(() => apply(noKind, ev("agent.seen", ALICE, CODEX)), EXIT.ENV, /not a plan ledger \(kind pr\)/);
    refused(() => apply({ ...duo(), kind: "pr" }, ev("agent.seen", ALICE, CODEX)), EXIT.ENV);
  });
  const MALFORMED = [
    ["no type", { login: ALICE, at: T0, data: {} }],
    ["an empty type", { type: "", login: ALICE, at: T0 }],
    ["no at", { type: "agent.seen", login: ALICE, data: {} }],
    ["an invalid at", { type: "agent.seen", login: ALICE, at: "soon" }],
    ["no login", { type: "agent.seen", agent: CODEX, at: T0 }],
    ["an empty login", { type: "agent.seen", login: " ", at: T0 }],
  ];
  for (const [name, event] of MALFORMED) test(`${name} is a bug`, () => refused(() => apply(duo(), event), EXIT.BUG));
  test("a malformed event is a bug before its type is looked up", () => {
    refused(() => apply(duo(), { type: "task.explode", at: T0 }), EXIT.BUG, /no login/);
  });
  test("an unknown type is refused before membership is checked", () => {
    refused(() => apply(duo(), ev("task.explode", "ghost")), EXIT.PRECONDITION, /ghost can't task.explode: unknown event type task.explode/);
  });
  test("every type but plan.join, directive, comments.seen and notice.sent needs a person", () => {
    const L = duo();
    for (const make of [
      () => ev("agent.seen", "ghost", null), (l) => revAdd(l, "ghost", null, "x"), (l) => agree(l, "ghost", null),
      () => ev("agree.withdraw", "ghost"), () => ev("person.leave", "ghost"), () => ev("reopen", "ghost", null, { asAdmin: true }),
      () => close(30, "ghost", { asAdmin: true }),
    ]) {
      const e = make(L);
      refused(() => apply(L, e), EXIT.PRECONDITION, /ghost has not joined plan #57; run collab plan join 57/);
    }
    for (const e of [
      join("ghost", "x-1", "other"), ev("directive", "ghost", null, { commentId: 9, cmd: "agree" }),
      ev("comments.seen", "ghost", null, { lastCommentId: 9 }), ev("notice.sent", "ghost", null, { key: "k", commentId: 1 }),
    ]) {
      assert.doesNotThrow(() => apply(L, e), e.type);
    }
  });
  test("an agent, when given, must be registered under that login", () => {
    const L = duo();
    refused(() => apply(L, ev("agent.seen", ALICE, "codex-0000")), EXIT.PRECONDITION, /agent codex-0000 has not joined plan #57/);
    refused(() => apply(L, agree(L, ALICE, CLAUDE)), EXIT.PRECONDITION, /alice can't agree to revision 2: agent claude-a1f3 acts for zwymer/);
    refused(() => apply(L, revAdd(L, OWNER, CODEX, "x")), EXIT.PRECONDITION, /acts for alice/);
  });
  test("a closed plan is UNSUPPORTED, but only after membership", () => {
    const C = apply(duo(), close());
    refused(() => apply(C, revAdd(C, ALICE, CODEX, "x")), EXIT.UNSUPPORTED, /alice can't add revision 3: plan #57 is closed/);
    refused(() => apply(C, revAdd(C, "ghost", null, "x")), EXIT.PRECONDITION, /has not joined/);
  });
  test("frozen (agreed or handed-off) refuses changes to the text and to who takes part", () => {
    for (const [name, F] of [["agreed", agreed()], ["handed-off", handed()]]) {
      const events = [
        revAdd(F, ALICE, CODEX, "x"), agree(F, ALICE, CODEX), ev("agree.withdraw", ALICE, CODEX), ev("person.leave", ALICE, CODEX),
        ev("person.remove", OWNER, CLAUDE, { target: ALICE, reason: "x" }),
      ];
      for (const e of events) refused(() => apply(F, e), EXIT.PRECONDITION, /so the plan is frozen/);
      assert.match(F.phase, new RegExp(name));
    }
    refused(() => apply(agreed(), ev("person.leave", ALICE, CODEX)), EXIT.PRECONDITION, /until the owner runs collab plan reopen 57/);
    refused(() => apply(handed(), ev("person.leave", ALICE, CODEX)), EXIT.PRECONDITION, /handed off to PR #61/);
  });
  test("refusals name the actor and why; details hold type, login and agent", () => {
    const L = apply(duo(), revAdd(duo(), OWNER, CLAUDE, "three"));
    const e = { type: "agree", login: ALICE, agent: CODEX, data: { rev: 2, hash: L.revs[2].hash }, at: at(30) };
    refused(() => apply(L, e), EXIT.PRECONDITION, /^alice can't agree to revision 2: revision 3 is current$/);
    try {
      apply(L, e);
    } catch (err) {
      assert.deepEqual(err.details, { type: "agree", login: ALICE, agent: CODEX });
    }
  });
});

// ---------------------------------------------------------------- people and agents

describe("plan.join", () => {
  test("a new login becomes a person, with its agent and vendor", () => {
    const L = apply(fresh(), join(ALICE, CODEX, "codex", 3));
    assert.deepEqual(L.people[ALICE], { joinedAt: at(3), lastSeen: at(3), observer: false, left: null, removed: null });
    assert.deepEqual(L.agents[CODEX], { tool: "codex", vendor: "openai", login: ALICE, host: "pc", joinedAt: at(3), lastSeen: at(3) });
    assert.deepEqual(activePeople(L), [ALICE, OWNER]);
  });
  test("a second agent for the same login joins the same person", () => {
    const L = run(fresh(), join(ALICE, CODEX, "codex", 3), join(ALICE, GEMINI, "gemini", 4));
    assert.deepEqual(Object.keys(L.people).sort(), [ALICE, OWNER]);
    assert.equal(L.people[ALICE].joinedAt, at(3));
    assert.equal(L.agents[GEMINI].login, ALICE);
    assert.equal(L.agents[GEMINI].vendor, "google");
    assert.equal(personOf(L, GEMINI), ALICE);
  });
  test("joining again only updates lastSeen", () => {
    const L = duo();
    const out = apply(L, join(ALICE, CODEX, "codex", 50));
    assert.deepEqual(out.agents[CODEX], { ...L.agents[CODEX], lastSeen: at(50) });
    assert.deepEqual(out.people[ALICE], { ...L.people[ALICE], lastSeen: at(50) });
    assert.equal(stateKey(out), stateKey(L));
  });
  test("an agent bound to another login is refused", () => {
    refused(() => apply(duo(), join(BOB, CODEX, "codex")), EXIT.PRECONDITION, /bob can't join the plan: agent codex-7k2p acts for alice/);
    refused(() => apply(duo(), join(ALICE, CLAUDE, "claude")), EXIT.PRECONDITION, /acts for zwymer/);
  });
  test("an agent can't rejoin with another tool", () => {
    refused(() => apply(duo(), join(ALICE, CODEX, "claude")), EXIT.PRECONDITION, /codex-7k2p already joined as codex/);
  });
  test("an agent id is required; an unknown tool is vendor other", () => {
    refused(() => apply(fresh(), ev("plan.join", ALICE, null, { tool: "codex" })), EXIT.PRECONDITION, /an agent id is required/);
    const L = apply(fresh(), ev("plan.join", ALICE, "x-1", {}));
    assert.deepEqual([L.agents["x-1"].tool, L.agents["x-1"].vendor], ["other", "other"]);
    assert.equal(apply(fresh(), join(ALICE, "w-1", "weird")).agents["w-1"].vendor, "other");
  });
  test("rejoining after leaving clears left", () => {
    const L = run(duo(), ev("person.leave", ALICE, CODEX, {}, 20));
    assert.equal(personStatus(L, ALICE), "left");
    const out = apply(L, join(ALICE, CODEX, "codex", 30));
    assert.equal(out.people[ALICE].left, null);
    assert.equal(personStatus(out, ALICE), "active");
    assert.equal(out.people[ALICE].joinedAt, at(2), "joinedAt is kept");
  });
  test("a removed person can't rejoin, with any agent", () => {
    const L = apply(trio(), ev("person.remove", OWNER, CLAUDE, { target: BOB, reason: "spam" }, 20));
    refused(() => apply(L, join(BOB, GEMINI, "gemini", 30)), EXIT.PRECONDITION, /bob can't join the plan: bob was removed from the plan by zwymer: spam/);
    refused(() => apply(L, join(BOB, "codex-bbbb", "codex", 30)), EXIT.PRECONDITION, /was removed/);
  });
  test("a new login joins a frozen plan as an observer", () => {
    for (const F of [agreed(), handed()]) {
      const L = apply(F, join(CAROL, GROK, "grok", 40));
      assert.equal(L.people[CAROL].observer, true);
      assert.equal(personStatus(L, CAROL), "observer");
      assert.deepEqual(activePeople(L), [ALICE, OWNER]);
      assert.equal(L.phase, F.phase, "joining never breaks the agreement");
    }
  });
  test("someone who left and rejoins a frozen plan only watches", () => {
    const L = trio();
    const F = run(L, ev("person.leave", BOB, GEMINI, {}, 15), agree(L, OWNER, CLAUDE, 20), agree(L, ALICE, CODEX, 21));
    assert.equal(F.phase, "agreed");
    const out = apply(F, join(BOB, GEMINI, "gemini", 30));
    assert.equal(personStatus(out, BOB), "observer");
    assert.equal(consensus(out).agreed, true);
  });
  test("a closed plan takes no one", () => {
    refused(() => apply(apply(duo(), close()), join(CAROL, GROK, "grok", 50)), EXIT.UNSUPPORTED, /is closed/);
  });
});

describe("agent.seen", () => {
  test("only updates the agent's and the person's lastSeen", () => {
    const L = duo();
    const out = apply(L, ev("agent.seen", ALICE, CODEX, {}, 77));
    assert.deepEqual({ ...out, seq: 0, agents: null, people: null }, { ...L, seq: 0, agents: null, people: null });
    assert.equal(out.agents[CODEX].lastSeen, at(77));
    assert.equal(out.people[ALICE].lastSeen, at(77));
  });
  test("works without an agent, and while closed", () => {
    assert.equal(apply(duo(), ev("agent.seen", ALICE, null, {}, 77)).people[ALICE].lastSeen, at(77));
    assert.equal(apply(apply(duo(), close()), ev("agent.seen", ALICE, CODEX, {}, 77)).agents[CODEX].lastSeen, at(77));
  });
});

// ---------------------------------------------------------------- revisions and agreements

describe("rev.add", () => {
  test("adds the next revision, makes it current and clears agreements", () => {
    let L = duo();
    L = apply(L, agree(L, OWNER, CLAUDE, 20));
    assert.deepEqual(Object.keys(L.agreements), [OWNER]);
    const out = apply(L, revAdd(L, OWNER, CLAUDE, "three", 25, { base: 1, merged: true, summary: "Merge alice's edit" }));
    assert.equal(out.current, 3);
    assert.deepEqual(out.revs[3], { hash: hash("three"), blob: blob("three"), base: 1, merged: true, agent: CLAUDE, login: OWNER, summary: "Merge alice's edit", chars: 200, at: at(25) });
    assert.deepEqual(out.agreements, {});
    assert.equal(out.people[OWNER].lastSeen, at(25));
    assert.deepEqual(out.revs[2], L.revs[2], "earlier revisions stay");
  });
  test("from a terminal (no agent) the revision has agent null", () => {
    const L = duo();
    assert.equal(apply(L, revAdd(L, ALICE, null, "three")).revs[3].agent, null);
  });
  test("a 64-hex blob (SHA-256 repos) is fine", () => {
    const L = duo();
    assert.equal(apply(L, revAdd(L, ALICE, CODEX, "three", 20, { blob: "a".repeat(64) })).revs[3].blob, "a".repeat(64));
  });
  const BAD = [
    ["a skipped number", { rev: 4 }, /alice can't add revision 4: revision 2 is current, so the next one is 3/],
    ["a number already taken", { rev: 2 }, /revision 2 already exists \(by alice\); the next one is 3/],
    ["no number", { rev: undefined }, /the next one is 3/],
    ["base 0", { base: 0 }, /the base must be a revision from 1 to 2/],
    ["a base after current", { base: 3 }, /the base must be a revision from 1 to 2/],
    ["chars over the cap", { chars: MAX_CHARS + 1 }, /the plan is 50001 characters, and the most is 50000/],
    ["negative chars", { chars: -1 }, /chars must be a whole number/],
    ["a hash without the sha256: prefix", { hash: "a".repeat(64) }, /the hash must be/],
    ["an upper-case hash", { hash: `sha256:${"A".repeat(64)}` }, /the hash must be/],
    ["a short hash", { hash: "sha256:abc" }, /the hash must be/],
    ["a 39-hex blob", { blob: "a".repeat(39) }, /the blob id must be 40 or 64/],
    ["a non-hex blob", { blob: "g".repeat(40) }, /the blob id must be/],
    ["the same text as the current revision", { hash: hash("two") }, /the text is the same as revision 2/],
  ];
  for (const [name, over, re] of BAD) {
    test(`refuses ${name}`, () => {
      const L = duo();
      refused(() => apply(L, revAdd(L, ALICE, CODEX, "three", 20, over)), EXIT.PRECONDITION, re);
    });
  }
  test("chars at the cap is fine; a ledger's maxChars is the cap", () => {
    const L = duo();
    assert.equal(apply(L, revAdd(L, ALICE, CODEX, "three", 20, { chars: MAX_CHARS })).revs[3].chars, MAX_CHARS);
    refused(() => apply({ ...L, maxChars: 100 }, revAdd(L, ALICE, CODEX, "three", 20)), EXIT.PRECONDITION, /the most is 100/);
  });
  test("numbers may come as digit strings", () => {
    const L = duo();
    const out = apply(L, revAdd(L, ALICE, CODEX, "three", 20, { rev: "3", base: "2", chars: "200" }));
    assert.deepEqual([out.current, out.revs[3].base, out.revs[3].chars], [3, 2, 200]);
  });
  test("only an active person adds revisions", () => {
    const L = duo();
    refused(() => apply(L, revAdd(L, "ghost", null, "x")), EXIT.PRECONDITION, /has not joined/);
    const left = apply(trio(), ev("person.leave", BOB, GEMINI, {}, 15));
    refused(() => apply(left, revAdd(left, BOB, GEMINI, "x")), EXIT.PRECONDITION, /bob left the plan; join again first/);
    const removed = apply(trio(), ev("person.remove", OWNER, CLAUDE, { target: BOB }, 15));
    refused(() => apply(removed, revAdd(removed, BOB, GEMINI, "x")), EXIT.PRECONDITION, /bob was removed from the plan/);
  });
  test("an observer can't add one while frozen, and takes part once the owner reopens", () => {
    const F = apply(agreed(), join(CAROL, GROK, "grok", 30));
    refused(() => apply(F, revAdd(F, CAROL, GROK, "three", 31)), EXIT.PRECONDITION, /frozen/);
    const R = apply(F, ev("reopen", OWNER, null, {}, 31));
    assert.equal(personStatus(R, CAROL), "active");
    assert.equal(apply(R, revAdd(R, CAROL, GROK, "three", 32)).revs[3].login, CAROL);
  });
  test("refused while frozen (PRECONDITION) or closed (UNSUPPORTED)", () => {
    const F = agreed();
    refused(() => apply(F, revAdd(F, ALICE, CODEX, "x")), EXIT.PRECONDITION, /frozen/);
    const C = apply(duo(), close());
    refused(() => apply(C, revAdd(C, ALICE, CODEX, "x")), EXIT.UNSUPPORTED, /closed/);
  });
});

describe("agree", () => {
  test("records the agreement for the current revision", () => {
    const L = duo();
    const out = apply(L, agree(L, ALICE, CODEX, 20));
    assert.deepEqual(out.agreements[ALICE], { rev: 2, hash: L.revs[2].hash, at: at(20), via: `agent:${CODEX}`, commentId: 0, url: null });
    assert.equal(out.phase, "drafting");
  });
  test("by comment keeps the comment id and URL", () => {
    const L = duo();
    const url = "https://github.com/o/r/issues/57#issuecomment-3001";
    const out = apply(L, ev("agree", ALICE, null, { rev: 2, hash: L.revs[2].hash, via: "comment", commentId: 3001, url }, 20));
    assert.deepEqual(out.agreements[ALICE], { rev: 2, hash: L.revs[2].hash, at: at(20), via: "comment", commentId: 3001, url });
  });
  test("without via: the event's agent, else the terminal", () => {
    const L = duo();
    assert.equal(apply(L, ev("agree", ALICE, CODEX, { rev: 2, hash: L.revs[2].hash })).agreements[ALICE].via, `agent:${CODEX}`);
    assert.equal(apply(L, ev("agree", ALICE, null, { rev: 2, hash: L.revs[2].hash })).agreements[ALICE].via, "terminal");
  });
  test("via agent:<id> must name an agent acting for that person", () => {
    const L = duo();
    refused(() => apply(L, agree(L, ALICE, null, 20, { via: `agent:${CLAUDE}` })), EXIT.PRECONDITION, /agent claude-a1f3 acts for zwymer, not alice/);
    refused(() => apply(L, agree(L, ALICE, null, 20, { via: "agent:nobody-1" })), EXIT.PRECONDITION, /agent nobody-1 has not joined/);
  });
  test("the wrong revision or hash is refused", () => {
    const L = duo();
    refused(() => apply(L, agree(L, ALICE, CODEX, 20, { rev: 1 })), EXIT.PRECONDITION, /^alice can't agree to revision 1: revision 2 is current$/);
    refused(() => apply(L, agree(L, ALICE, CODEX, 20, { hash: hash("one") })), EXIT.PRECONDITION, /revision 2 is [0-9a-f]{8}, not [0-9a-f]{8}; read it again before agreeing/);
  });
  test("only an active person agrees", () => {
    const L = duo();
    refused(() => apply(L, agree(L, "ghost", null)), EXIT.PRECONDITION, /ghost has not joined/);
    const left = apply(trio(), ev("person.leave", BOB, GEMINI, {}, 15));
    refused(() => apply(left, agree(left, BOB, GEMINI)), EXIT.PRECONDITION, /bob left the plan/);
  });
  test("an agent of another login is refused", () => {
    const L = duo();
    refused(() => apply(L, agree(L, OWNER, CODEX)), EXIT.PRECONDITION, /zwymer can't agree to revision 2: agent codex-7k2p acts for alice/);
  });
  test("when every active person agrees and there are enough of them, the plan is agreed", () => {
    const L = duo();
    const one = apply(L, agree(L, OWNER, CLAUDE, 20));
    assert.equal(one.phase, "drafting");
    assert.equal(one.agreedAt, null);
    const both = apply(one, agree(L, ALICE, CODEX, 21));
    assert.equal(both.phase, "agreed");
    assert.equal(both.agreedAt, at(21));
    assert.deepEqual(consensus(both), { agreed: true, waitingOn: [], agreedBy: [ALICE, OWNER], needMore: 0 });
  });
  test("below minPeople the plan stays drafting", () => {
    const solo = fresh();
    const out = apply(solo, agree(solo, OWNER, CLAUDE, 5));
    assert.equal(out.phase, "drafting");
    assert.deepEqual(consensus(out), { agreed: false, waitingOn: [], agreedBy: [OWNER], needMore: 1 });
    const three = duo({ minPeople: 3 });
    const both = run(three, agree(three, OWNER, CLAUDE, 20), agree(three, ALICE, CODEX, 21));
    assert.equal(both.phase, "drafting");
    assert.equal(consensus(both).needMore, 1);
    const solo1 = fresh({ minPeople: 1 });
    assert.equal(apply(solo1, agree(solo1, OWNER, CLAUDE, 5)).phase, "agreed");
  });
  test("agreeing again updates the time", () => {
    const L = duo();
    const out = run(L, agree(L, ALICE, CODEX, 20), agree(L, ALICE, CODEX, 25));
    assert.equal(out.agreements[ALICE].at, at(25));
  });
});

describe("agree.withdraw", () => {
  test("deletes the agreement", () => {
    const L = duo();
    const out = run(L, agree(L, ALICE, CODEX, 20), ev("agree.withdraw", ALICE, CODEX, {}, 21));
    assert.deepEqual(out.agreements, {});
  });
  test("refused when there is none, or while frozen", () => {
    refused(() => apply(duo(), ev("agree.withdraw", ALICE, CODEX)), EXIT.PRECONDITION, /alice can't withdraw their agreement: alice has not agreed to revision 2/);
    refused(() => apply(agreed(), ev("agree.withdraw", ALICE, CODEX)), EXIT.PRECONDITION, /frozen/);
  });
});

describe("person.leave", () => {
  test("sets left and deletes the agreement", () => {
    const L = trio();
    const out = run(L, agree(L, BOB, GEMINI, 20), ev("person.leave", BOB, GEMINI, {}, 21));
    assert.equal(out.people[BOB].left, at(21));
    assert.equal(out.agreements[BOB], undefined);
    assert.deepEqual(activePeople(out), [ALICE, OWNER]);
  });
  test("the owner can't leave; no one leaves twice", () => {
    refused(() => apply(duo(), ev("person.leave", OWNER, CLAUDE)), EXIT.PRECONDITION, /zwymer owns the plan; the owner can close it instead/);
    const L = apply(trio(), ev("person.leave", BOB, GEMINI, {}, 15));
    refused(() => apply(L, ev("person.leave", BOB, GEMINI, {}, 16)), EXIT.PRECONDITION, /bob already left/);
  });
  test("the last holdout leaving completes the agreement", () => {
    const L = trio();
    const two = run(L, agree(L, OWNER, CLAUDE, 20), agree(L, ALICE, CODEX, 21));
    assert.equal(two.phase, "drafting");
    assert.deepEqual(consensus(two).waitingOn, [BOB]);
    const out = apply(two, ev("person.leave", BOB, GEMINI, {}, 30));
    assert.equal(out.phase, "agreed");
    assert.equal(out.agreedAt, at(30));
  });
  test("leaving below minPeople does not agree", () => {
    const L = duo();
    const out = run(L, agree(L, OWNER, CLAUDE, 20), ev("person.leave", ALICE, CODEX, {}, 21));
    assert.equal(out.phase, "drafting");
    assert.equal(consensus(out).needMore, 1);
  });
});

describe("person.remove", () => {
  const remove = (login, target, data = {}, min = 30) => ev("person.remove", login, null, { target, reason: "off topic", ...data }, min);
  test("the owner removes a person: removed is set and the agreement deleted", () => {
    const L = trio();
    const out = run(L, agree(L, BOB, GEMINI, 20), remove(OWNER, BOB));
    assert.deepEqual(out.people[BOB].removed, { by: OWNER, at: at(30), reason: "off topic" });
    assert.equal(out.agreements[BOB], undefined);
    assert.equal(personStatus(out, BOB), "removed");
  });
  test("only the owner, or a repo admin (asAdmin)", () => {
    refused(() => apply(trio(), remove(ALICE, BOB)), EXIT.PRECONDITION, /alice can't remove bob: only the owner \(zwymer\) or a repo admin can do that/);
    assert.equal(apply(trio(), remove(ALICE, BOB, { asAdmin: true })).people[BOB].removed.by, ALICE);
    refused(() => apply(trio(), remove(ALICE, BOB, { asAdmin: "yes" })), EXIT.PRECONDITION, /only the owner/);
  });
  test("the target must be a person who is not the owner and not already removed", () => {
    refused(() => apply(trio(), remove(OWNER, "ghost")), EXIT.PRECONDITION, /ghost is not in the plan/);
    refused(() => apply(trio(), remove(OWNER, undefined)), EXIT.PRECONDITION, /the target is not in the plan/);
    refused(() => apply(trio(), remove(ALICE, OWNER, { asAdmin: true })), EXIT.PRECONDITION, /zwymer owns the plan and can't be removed/);
    const L = apply(trio(), remove(OWNER, BOB));
    refused(() => apply(L, remove(OWNER, BOB, {}, 31)), EXIT.PRECONDITION, /bob was already removed/);
  });
  test("someone who left can still be removed (so they can't come back)", () => {
    const L = run(trio(), ev("person.leave", BOB, GEMINI, {}, 15), remove(OWNER, BOB));
    assert.equal(personStatus(L, BOB), "removed");
  });
  test("removing the last holdout completes the agreement", () => {
    const L = trio();
    const out = run(L, agree(L, OWNER, CLAUDE, 20), agree(L, ALICE, CODEX, 21), remove(OWNER, BOB));
    assert.equal(out.phase, "agreed");
    assert.equal(out.agreedAt, at(30));
  });
  test("a reason is optional", () => {
    assert.equal(apply(trio(), remove(OWNER, BOB, { reason: undefined })).people[BOB].removed.reason, null);
  });
});

// ---------------------------------------------------------------- phases

describe("reopen", () => {
  test("from agreed: back to drafting, agreements and agreedAt cleared, observers take part", () => {
    const F = apply(agreed(), join(CAROL, GROK, "grok", 30));
    const out = apply(F, ev("reopen", OWNER, null, {}, 31));
    assert.equal(out.phase, "drafting");
    assert.deepEqual(out.agreements, {});
    assert.equal(out.agreedAt, null);
    assert.equal(out.people[CAROL].observer, false);
    assert.deepEqual(activePeople(out), [ALICE, CAROL, OWNER]);
    assert.deepEqual(consensus(out).waitingOn, [ALICE, CAROL, OWNER]);
  });
  test("only from agreed", () => {
    refused(() => apply(duo(), ev("reopen", OWNER)), EXIT.PRECONDITION, /zwymer can't reopen the plan: only an agreed plan can be reopened/);
    refused(() => apply(handed(), ev("reopen", OWNER)), EXIT.PRECONDITION, /already handed off to a build PR/);
    refused(() => apply(apply(agreed(), close()), ev("reopen", OWNER)), EXIT.UNSUPPORTED, /closed/);
  });
  test("an owner operation", () => {
    refused(() => apply(agreed(), ev("reopen", ALICE, CODEX)), EXIT.PRECONDITION, /only the owner \(zwymer\) or a repo admin/);
    assert.equal(apply(agreed(), ev("reopen", ALICE, CODEX, { asAdmin: true })).phase, "drafting");
  });
});

describe("handoff", () => {
  test("from agreed: handed-off, with the data, who and when", () => {
    const out = handed();
    assert.equal(out.phase, "handed-off");
    assert.deepEqual(out.handoff, { pr: 61, url: "https://github.com/o/r/pull/61", branch: "plan/57", path: "docs/plans/57.md", rev: 2, hash: out.revs[2].hash, by: ALICE, at: at(30) });
  });
  test("only from agreed, and only once", () => {
    const L = duo();
    const data = { pr: 61, url: "u", rev: 2, hash: L.revs[2].hash };
    refused(() => apply(L, ev("handoff", ALICE, CODEX, data)), EXIT.PRECONDITION, /only an agreed plan can be handed off/);
    refused(() => apply(handed(), ev("handoff", ALICE, CODEX, data)), EXIT.PRECONDITION, /already handed off/);
  });
  test("the revision and hash must be the agreed ones; pr is required", () => {
    const F = agreed();
    const ok = { pr: 61, url: "u", rev: 2, hash: F.revs[2].hash };
    refused(() => apply(F, ev("handoff", ALICE, CODEX, { ...ok, rev: 1 })), EXIT.PRECONDITION, /alice can't hand off revision 1: revision 2 is the agreed one/);
    refused(() => apply(F, ev("handoff", ALICE, CODEX, { ...ok, hash: hash("one") })), EXIT.PRECONDITION, /revision 2 is [0-9a-f]{8}, not/);
    refused(() => apply(F, ev("handoff", ALICE, CODEX, { ...ok, pr: undefined })), EXIT.PRECONDITION, /data.pr must be the build PR's number/);
  });
  test("any active person, but not an observer", () => {
    const F = apply(agreed(), join(CAROL, GROK, "grok", 25));
    const data = { pr: 61, url: "u", rev: 2, hash: F.revs[2].hash };
    refused(() => apply(F, ev("handoff", CAROL, GROK, data)), EXIT.PRECONDITION, /carol joined after revision 2 was agreed and only watches/);
    assert.equal(apply(F, ev("handoff", OWNER, null, data)).handoff.by, OWNER);
  });
});

describe("state.set", () => {
  test("the owner closes the plan", () => {
    const out = apply(duo(), close(40));
    assert.equal(out.phase, "closed");
    assert.deepEqual(out.closed, { by: OWNER, at: at(40), reason: "done" });
  });
  test("from any open phase", () => {
    for (const L of [duo(), agreed(), handed()]) assert.equal(apply(L, close(50)).phase, "closed");
  });
  test("an owner operation (or asAdmin); closed is the only state", () => {
    refused(() => apply(duo(), close(40, ALICE)), EXIT.PRECONDITION, /alice can't close the plan: only the owner/);
    assert.equal(apply(duo(), close(40, ALICE, { asAdmin: true })).closed.by, ALICE);
    refused(() => apply(duo(), ev("state.set", OWNER, null, { phase: "agreed" })), EXIT.PRECONDITION, /zwymer can't change the plan's state: closed is the only state to set/);
  });
  test("closed is final; only housekeeping applies afterwards", () => {
    const C = apply(duo(), close(40));
    const UNSUPPORTED = [
      close(41), join(CAROL, GROK, "grok", 41), join(ALICE, CODEX, "codex", 41), revAdd(C, ALICE, CODEX, "x", 41), agree(C, ALICE, CODEX, 41),
      ev("agree.withdraw", ALICE, CODEX), ev("person.leave", ALICE, CODEX), ev("person.remove", OWNER, null, { target: ALICE }),
      ev("reopen", OWNER), ev("handoff", ALICE, CODEX, { pr: 1, rev: 2, hash: C.revs[2].hash }),
    ];
    for (const e of UNSUPPORTED) refused(() => apply(C, e), EXIT.UNSUPPORTED, /plan #57 is closed/);
    const ALLOWED = [
      ev("comments.seen", ALICE, CODEX, { lastCommentId: 9 }), ev("notice.sent", ALICE, CODEX, { key: "k", commentId: 2 }),
      ev("agent.seen", ALICE, CODEX), ev("directive", BOB, null, { commentId: 10, cmd: "agree", applied: false }),
    ];
    for (const e of ALLOWED) assert.equal(apply(C, e).phase, "closed", e.type);
  });
});

// ---------------------------------------------------------------- comments and notices

describe("directive", () => {
  test("is appended, and moves lastCommentId and lastCommentAt", () => {
    const L = duo();
    const out = apply(L, ev("directive", BOB, CLAUDE, { commentId: 3001, commentAt: at(9), cmd: "agree", rev: 2, hashPrefix: "abcd1234", url: "https://x/1", applied: false, why: "bob has not joined" }, 12));
    assert.deepEqual(out.directives, [{ commentId: 3001, login: BOB, cmd: "agree", at: at(12), applied: false, rev: 2, hashPrefix: "abcd1234", url: "https://x/1", why: "bob has not joined" }]);
    assert.equal(out.lastCommentId, 3001);
    assert.equal(out.lastCommentAt, at(9));
  });
  test("the optional fields are left out when absent; applied is a boolean", () => {
    const out = apply(duo(), ev("directive", ALICE, null, { commentId: 5, cmd: "withdraw", applied: true }));
    assert.deepEqual(out.directives[0], { commentId: 5, login: ALICE, cmd: "withdraw", at: at(1), applied: true });
    assert.equal(out.lastCommentAt, null);
  });
  test("the comment id must grow; cmd and commentId are required", () => {
    const L = apply(duo(), ev("directive", ALICE, null, { commentId: 5, cmd: "agree" }));
    refused(() => apply(L, ev("directive", ALICE, null, { commentId: 5, cmd: "agree" })), EXIT.PRECONDITION, /comment 5 was already seen \(last 5\)/);
    refused(() => apply(L, ev("directive", ALICE, null, { commentId: 4, cmd: "agree" })), EXIT.PRECONDITION, /already seen/);
    refused(() => apply(L, ev("directive", ALICE, null, { cmd: "agree" })), EXIT.PRECONDITION, /data.commentId is required/);
    refused(() => apply(L, ev("directive", ALICE, null, { commentId: 6 })), EXIT.PRECONDITION, /data.cmd is required/);
    const watermark = newPlanLedger({ issue: ISSUE, owner: OWNER, agent: { id: CLAUDE }, rev1: REV1, now: T0, lastCommentId: 100 });
    refused(() => apply(watermark, ev("directive", ALICE, null, { commentId: 99, cmd: "agree" })), EXIT.PRECONDITION, /already seen/);
  });
  test("allowed while frozen and closed", () => {
    for (const L of [agreed(), handed(), apply(duo(), close())]) {
      assert.equal(apply(L, ev("directive", ALICE, null, { commentId: 7, cmd: "agree" })).directives.length, 1);
    }
  });
});

describe("comments.seen", () => {
  test("only moves forward", () => {
    const L = run(duo(), ev("comments.seen", ALICE, CODEX, { lastCommentId: 10, lastCommentAt: at(5) }));
    assert.equal(L.lastCommentId, 10);
    assert.equal(L.lastCommentAt, at(5));
    const back = apply(L, ev("comments.seen", ALICE, CODEX, { lastCommentId: 4, lastCommentAt: at(1) }));
    assert.equal(back.lastCommentId, 10);
    assert.equal(back.lastCommentAt, at(5));
    assert.equal(apply(L, ev("comments.seen", ALICE, CODEX, { lastCommentId: 12, lastCommentAt: at(7) })).lastCommentAt, at(7));
    refused(() => apply(L, ev("comments.seen", ALICE, CODEX, {})), EXIT.PRECONDITION, /data.lastCommentId is required/);
  });
});

describe("notice.sent", () => {
  test("records the notice; a key is required", () => {
    assert.deepEqual(apply(duo(), ev("notice.sent", ALICE, CODEX, { key: "browser-edit:r2", commentId: 77 })).notices, { "browser-edit:r2": 77 });
    refused(() => apply(duo(), ev("notice.sent", ALICE, CODEX, { commentId: 1 })), EXIT.PRECONDITION, /data.key is required/);
    refused(() => apply(duo(), ev("notice.sent", ALICE, CODEX, { key: "__proto__", commentId: 1 })), EXIT.PRECONDITION);
  });
});

// ---------------------------------------------------------------- helpers

describe("helpers", () => {
  test("personStatus, activePeople, personOf and isOwner", () => {
    const L = run(trio(), join(CAROL, GROK, "grok", 12), ev("person.leave", BOB, GEMINI, {}, 13));
    const F = run(L, ev("person.remove", OWNER, null, { target: CAROL }, 14));
    assert.deepEqual([OWNER, ALICE, BOB, CAROL, "ghost"].map((l) => personStatus(F, l)), ["active", "active", "left", "removed", null]);
    assert.deepEqual(activePeople(F), [ALICE, OWNER]);
    assert.equal(personOf(F, GEMINI), BOB);
    assert.equal(personOf(F, "nobody-1"), null);
    assert.equal(personOf(F, "toString"), null);
    assert.equal(isOwner(F, OWNER), true);
    assert.equal(isOwner(F, ALICE), false);
    assert.equal(isOwner(F, undefined), false);
    assert.equal(personStatus(F, "constructor"), null);
  });
  test("consensus names who agreed, who is awaited and how many more must join", () => {
    const L = trio({ minPeople: 4 });
    const one = apply(L, agree(L, ALICE, CODEX, 20));
    assert.deepEqual(consensus(one), { agreed: false, waitingOn: [BOB, OWNER], agreedBy: [ALICE], needMore: 1 });
  });
  test("an agreement for another hash does not count", () => {
    const L = duo();
    const out = apply(L, agree(L, ALICE, CODEX, 20));
    const forged = { ...out, agreements: { [ALICE]: { ...out.agreements[ALICE], hash: hash("other") } } };
    assert.deepEqual(consensus(forged).agreedBy, []);
  });
});

describe("stateKey", () => {
  test("is stable and readable", () => {
    assert.equal(stateKey(duo()), stateKey(duo()));
    assert.match(stateKey(duo()), /^r2\.drafting\.[0-9a-f]{16}$/);
  });
  test("changes with the revision, the phase, an agreement or a person's status", () => {
    const L = trio();
    const CHANGES = [
      ["a revision", revAdd(L, ALICE, CODEX, "three", 20)],
      ["an agreement", agree(L, ALICE, CODEX, 20)],
      ["a person joining", join(CAROL, GROK, "grok", 20)],
      ["a person leaving", ev("person.leave", BOB, GEMINI, {}, 20)],
      ["a person removed", ev("person.remove", OWNER, null, { target: BOB }, 20)],
      ["the phase", close(20)],
    ];
    for (const [name, e] of CHANGES) assert.notEqual(stateKey(apply(L, e)), stateKey(L), name);
    const withAgreement = apply(L, agree(L, ALICE, CODEX, 20));
    assert.notEqual(stateKey(apply(withAgreement, ev("agree.withdraw", ALICE, CODEX, {}, 21))), stateKey(withAgreement), "a withdrawal");
    const F = apply(agreed(), join(CAROL, GROK, "grok", 30));
    assert.notEqual(stateKey(apply(F, ev("reopen", OWNER, null, {}, 31))), stateKey(F), "reopen");
    assert.notEqual(stateKey(handed(agreed())), stateKey(agreed()), "handoff");
    assert.notEqual(stateKey(F), stateKey(agreed()), "an observer joining");
  });
  test("does not change with lastSeen or housekeeping", () => {
    const L = trio();
    const SAME = [
      ev("agent.seen", BOB, GEMINI, {}, 30),
      join(ALICE, "claude-cccc", "claude", 30),
      ev("comments.seen", ALICE, CODEX, { lastCommentId: 50 }, 30),
      ev("notice.sent", ALICE, CODEX, { key: "k", commentId: 1 }, 30),
      ev("directive", ALICE, null, { commentId: 51, cmd: "agree", applied: false }, 30),
    ];
    for (const e of SAME) assert.equal(stateKey(apply(L, e)), stateKey(L), e.type);
    const re = run(L, agree(L, ALICE, CODEX, 20));
    assert.equal(stateKey(apply(re, agree(L, ALICE, CODEX, 25))), stateKey(re), "agreeing again to the same revision");
  });
  test("a second agent of the same person does not change it; CLAUDE2 is just another agent", () => {
    const L = duo();
    assert.equal(stateKey(apply(L, join(OWNER, CLAUDE2, "claude", 30))), stateKey(L));
  });
});
