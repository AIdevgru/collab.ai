import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { addMinutes } from "../../skills/collab/lib/clock.mjs";
import { apply, newLedger } from "../../skills/collab/lib/ledger.mjs";
import { nextAction } from "../../skills/collab/lib/next.mjs";

// ---------------------------------------------------------------- fixtures (time is pinned)

const T0 = "2026-11-16T12:00:00.000Z";
const at = (min) => addMinutes(T0, min);
const PR = { repo: "o/r", number: 42, url: "https://github.com/o/r/pull/42", headRef: "feat/x", baseRef: "main", defaultBranch: "main", ghLogin: "zwymer", mergeMethod: "squash" };
const CLAUDE = "claude-a1f3";
const CODEX = "codex-7k2p";
const CLAUDE2 = "claude-b2c4";

const ev = (type, agent, task, data = {}, min = 1) => ({ type, agent, task, data, at: at(min) });
const run = (L, ...events) => events.reduce(apply, L);
const spec = (title, extra = {}) => ({ title, desc: "", accept: [], scope: [], deps: [], size: "S", ...extra });

const claim = (agent, task, min = 1) => ev("task.claim", agent, task, { leaseUntil: at(min + 90) }, min);
const push = (agent, task, sha, min = 2, extra = {}) => ev("task.push", agent, task, { headSha: sha, touched: [], ...extra }, min);
const verify = (agent, task, sha, min = 3) => ev("task.verify", agent, task, { sha, ok: true, summary: "ok" }, min);
const submit = (agent, task, sha, min = 4) => ev("task.submit", agent, task, { sha }, min);
const rclaim = (agent, task, min = 5) => ev("review.claim", agent, task, { leaseUntil: at(min + 60) }, min);
const verdict = (agent, task, v, sha, min = 6) => ev("review.verdict", agent, task, { verdict: v, sha, commentId: 1 }, min);
const merge = (agent, task, sha, min = 7) => ev("task.merge", agent, task, { sha }, min);

// Owner submits a task at `sha`, starting at minute m.
const submitted = (agent, task, sha, m = 1) => [claim(agent, task, m), push(agent, task, sha, m + 1), verify(agent, task, sha, m + 2), submit(agent, task, sha, m + 3)];
const approvedBy = (reviewer, task, sha, m) => [rclaim(reviewer, task, m), verdict(reviewer, task, "approve", sha, m + 1)];

function fresh() {
  return newLedger({ pr: PR, agent: { id: CLAUDE, tool: "claude", host: "pc", pid: null }, now: T0 });
}
function planned(tasks = [spec("one"), spec("two"), spec("three", { deps: ["T1"] }), spec("four")]) {
  return run(fresh(), ev("agent.join", CODEX, null, { tool: "codex" }), ev("agent.join", CLAUDE2, null, { tool: "claude" }), ev("plan", CLAUDE, null, { tasks }));
}
const green = (subs = {}) => ({ mainCi: "SUCCESS", mainMergeable: "MERGEABLE", subs });
const pick = (r) => ({ action: r.action, task: r.task, cmd: r.cmd });

// ---------------------------------------------------------------- phases and identity

describe("next: phases and identity", () => {
  test("an agent not in the ledger joins first", () => {
    assert.deepEqual(nextAction(planned(), "gemini-0000", null, at(5)).cmd, ["collab", "join", PR.url, "--agent", "gemini-0000"]);
    assert.equal(nextAction(planned(), "gemini-0000", null, at(5)).action, "join");
  });
  test("closed and paused", () => {
    const C = apply(planned(), ev("phase.set", "owner", null, { phase: "closed" }));
    assert.deepEqual(pick(nextAction(C, CLAUDE, null, at(5))), { action: "closed", task: undefined, cmd: ["collab", "status", "--agent", CLAUDE] });
    assert.equal(nextAction(C, "stranger-1", null, at(5)).action, "closed");
    const P = apply(planned(), ev("directive", "owner", null, { commentId: 3, login: "zwymer", cmd: "pause" }));
    const r = nextAction(P, CODEX, green(), at(5));
    assert.equal(r.action, "paused");
    assert.deepEqual(r.cmd, ["collab", "wait", "--timeout", "9m", "--agent", CODEX]);
    assert.match(r.why, /collab resume/);
  });
  test("planning: the planner plans, others wait, an expired lease is taken over", () => {
    const L = run(fresh(), ev("agent.join", CODEX, null, { tool: "codex" }));
    const mine = nextAction(L, CLAUDE, null, at(5));
    assert.equal(mine.action, "plan");
    assert.deepEqual(mine.cmd, ["collab", "plan", "--tasks", "tasks.json", "--agent", CLAUDE]);
    assert.match(mine.why, /at most 12 tasks/);
    const theirs = nextAction(L, CODEX, null, at(5));
    assert.equal(theirs.action, "wait-plan");
    assert.deepEqual(theirs.cmd, ["collab", "wait", "--timeout", "9m", "--agent", CODEX]);
    assert.match(theirs.why, /claude-a1f3 is planning/);
    const late = nextAction(L, CODEX, null, at(16));
    assert.equal(late.action, "plan");
    assert.match(late.why, /expired/);
  });
});

// ---------------------------------------------------------------- each action

describe("next: claim", () => {
  test("the first open task whose deps are done, by id", () => {
    assert.deepEqual(pick(nextAction(planned(), CLAUDE, green(), at(5))), { action: "claim", task: "T1", cmd: ["collab", "claim", "T1", "--agent", CLAUDE] });
    const L = run(planned(), claim(CODEX, "T1"), claim(CLAUDE2, "T2"));
    // T3 waits on T1, so T4 is next.
    assert.equal(nextAction(L, CLAUDE, green(), at(5)).task, "T4");
  });
  test("a fix-ci task goes first", () => {
    const L = apply(planned(), ev("task.add", CODEX, null, { kind: "fix-ci", forSha: "deadbeef" }));
    const r = nextAction(L, CLAUDE, { mainCi: "FAILURE", subs: {} }, at(5));
    assert.deepEqual(pick(r), { action: "claim", task: "T5", cmd: ["collab", "claim", "T5", "--agent", CLAUDE] });
    assert.match(r.why, /red CI/);
  });
  test("blocked and dependency-bound tasks are skipped", () => {
    const L = run(planned([spec("a"), spec("b", { deps: ["T1"] }), spec("c")]), claim(CODEX, "T1"), ev("task.block", "owner", "T3", { reason: "x" }));
    const r = nextAction(L, CLAUDE, green(), at(5));
    assert.equal(r.action, "wait");
    assert.match(r.why, /T2 wait on dependencies/);
    assert.equal(nextAction(apply(L, ev("task.unblock", "owner", "T3", {})), CLAUDE, green(), at(5)).task, "T3");
  });
  test("an open task overlapping another agent's work in flight is skipped", () => {
    const L = run(planned([spec("a", { scope: ["src/**"] }), spec("b", { scope: ["src/a.js"] }), spec("c", { scope: ["docs/**"] })]),
      claim(CODEX, "T1"), push(CODEX, "T1", "s1", 2, { touched: ["src/a.js"] }));
    assert.equal(nextAction(L, CLAUDE, green(), at(5)).task, "T3");
    const busy = apply(L, claim(CLAUDE2, "T3", 3));
    const r = nextAction(busy, CLAUDE, green(), at(5));
    assert.equal(r.action, "wait");
    assert.match(r.why, /1 open task\(s\) overlap work in flight/);
    // Existing files widen the check: src/** vs src/lib/*.js only meet through a real file.
    const G = run(planned([spec("a", { scope: ["src/**"] }), spec("b", { scope: ["src/lib/*.js"] })]), claim(CODEX, "T1"));
    assert.equal(nextAction(G, CLAUDE, green(), at(5)).task, "T2");
    assert.equal(nextAction(G, CLAUDE, green(), at(5), { files: ["src/lib/x.js"] }).action, "wait");
  });
  test("my own in-flight task never blocks my claim on overlap grounds", () => {
    const L = run(planned([spec("a", { scope: ["src/**"] }), spec("b", { scope: ["src/a.js"] })]), ...submitted(CLAUDE, "T1", "s1"));
    assert.equal(nextAction(L, CLAUDE, green(), at(10)).task, "T2");
  });
});

describe("next: work", () => {
  test("my claimed task walks push -> verify -> submit", () => {
    let L = apply(planned(), claim(CLAUDE, "T1"));
    const why = "keep working on T1, then collab push / verify / submit";
    assert.deepEqual(nextAction(L, CLAUDE, green(), at(5)), { action: "work", task: "T1", why, cmd: ["collab", "push", "T1", "--agent", CLAUDE] });
    L = apply(L, push(CLAUDE, "T1", "s1"));
    assert.deepEqual(nextAction(L, CLAUDE, green(), at(5)).cmd, ["collab", "verify", "T1", "--agent", CLAUDE]);
    L = apply(L, ev("task.verify", CLAUDE, "T1", { sha: "s1", ok: false }, 3));
    assert.deepEqual(nextAction(L, CLAUDE, green(), at(5)).cmd, ["collab", "verify", "T1", "--agent", CLAUDE]);
    L = apply(L, verify(CLAUDE, "T1", "s1", 4));
    assert.deepEqual(nextAction(L, CLAUDE, green(), at(5)).cmd, ["collab", "submit", "T1", "--agent", CLAUDE]);
    assert.equal(nextAction(L, CLAUDE, green(), at(5)).why, why);
  });
  test("work comes before claiming (WIP 1)", () => {
    const L = apply(planned(), claim(CLAUDE, "T1"));
    assert.equal(nextAction(L, CLAUDE, green(), at(5)).action, "work");
  });
});

describe("next: review", () => {
  const L = run(planned(), ...submitted(CLAUDE, "T1", "s1"));
  test("another vendor claims the review", () => {
    assert.deepEqual(pick(nextAction(L, CODEX, green(), at(10))), { action: "review", task: "T1", cmd: ["collab", "review-claim", "T1", "--agent", CODEX] });
  });
  test("the same vendor is never sent to review", () => {
    assert.equal(nextAction(L, CLAUDE2, green(), at(10)).action, "claim");
  });
  test("a review I hold comes back as the review command", () => {
    const R = apply(L, rclaim(CODEX, "T1", 10));
    const r = nextAction(R, CODEX, green(), at(20));
    assert.deepEqual(pick(r), { action: "review", task: "T1", cmd: ["collab", "review", "T1", "--approve", "--body-file", "review.md", "--agent", CODEX] });
    assert.match(r.why, /--changes/);
  });
  test("a live review held by someone else is left alone; an expired one is up for grabs", () => {
    const G = run(L, ev("agent.join", "gemini-0001", null, { tool: "gemini" }), rclaim(CODEX, "T1", 10));
    assert.notEqual(nextAction(G, "gemini-0001", green(), at(30)).action, "review");
    assert.deepEqual(pick(nextAction(G, "gemini-0001", green(), at(80))), { action: "review", task: "T1", cmd: ["collab", "review-claim", "T1", "--agent", "gemini-0001"] });
  });
  test("my unfinished work comes before a new review", () => {
    const W = apply(L, claim(CODEX, "T2", 6));
    assert.equal(nextAction(W, CODEX, green(), at(10)).action, "work");
  });
  test("a held review comes before my own work", () => {
    const W = run(L, rclaim(CODEX, "T1", 6), claim(CODEX, "T2", 7));
    assert.deepEqual(pick(nextAction(W, CODEX, green(), at(10))).cmd.slice(0, 3), ["collab", "review", "T1"]);
  });
});

describe("next: fix", () => {
  const changes = () => run(planned(), ...submitted(CLAUDE, "T1", "s1"), rclaim(CODEX, "T1", 5), verdict(CODEX, "T1", "changes", "s1", 6));
  test("changes requested: push, then verify, then submit", () => {
    let L = changes();
    let r = nextAction(L, CLAUDE, green(), at(10));
    assert.deepEqual(pick(r), { action: "fix", task: "T1", cmd: ["collab", "push", "T1", "--agent", CLAUDE] });
    assert.match(r.why, /requested changes on T1/);
    L = apply(L, push(CLAUDE, "T1", "s2", 11));
    assert.deepEqual(nextAction(L, CLAUDE, green(), at(12)).cmd, ["collab", "verify", "T1", "--agent", CLAUDE]);
    L = apply(L, verify(CLAUDE, "T1", "s2", 12));
    r = nextAction(L, CLAUDE, green(), at(13));
    assert.deepEqual(pick(r), { action: "fix", task: "T1", cmd: ["collab", "submit", "T1", "--agent", CLAUDE] });
  });
  test("red sub-PR CI at the current head", () => {
    const L = run(planned(), claim(CLAUDE, "T1"), push(CLAUDE, "T1", "s1", 2, { subPr: 59 }));
    const r = nextAction(L, CLAUDE, green({ T1: { ci: "FAILURE", mergeable: "MERGEABLE", headSha: "s1" } }), at(5));
    assert.deepEqual(pick(r), { action: "fix", task: "T1", cmd: ["collab", "push", "T1", "--agent", CLAUDE] });
    assert.match(r.why, /CI is failing on T1's sub-PR #59/);
    // ERROR counts as red too.
    assert.equal(nextAction(L, CLAUDE, green({ T1: { ci: "ERROR", headSha: "s1" } }), at(5)).action, "fix");
  });
  test("a CI result for an older SHA is ignored", () => {
    const L = run(planned(), claim(CLAUDE, "T1"), push(CLAUDE, "T1", "s2"));
    assert.equal(nextAction(L, CLAUDE, green({ T1: { ci: "FAILURE", headSha: "s1" } }), at(5)).action, "work");
  });
  test("a conflicting sub-PR syncs first", () => {
    const L = run(planned(), ...submitted(CLAUDE, "T1", "s1"));
    const r = nextAction(L, CLAUDE, green({ T1: { ci: "FAILURE", mergeable: "CONFLICTING", headSha: "s1" } }), at(10));
    assert.deepEqual(pick(r), { action: "fix", task: "T1", cmd: ["collab", "sync", "T1", "--agent", CLAUDE] });
    assert.match(r.why, /conflicts with feat\/x/);
  });
  test("a blocked task of mine is not sent back to fix, and still holds my WIP slot", () => {
    const L = apply(changes(), ev("task.block", CLAUDE, "T1", { reason: "ask owner", needsOwner: true }, 7));
    const r = nextAction(L, CLAUDE, green(), at(10));
    assert.equal(r.action, "wait");
    assert.match(r.why, /T1 is blocked: ask owner/);
  });
});

describe("next: merge", () => {
  const approved = () => run(planned(), ...submitted(CLAUDE, "T1", "s1"), ...approvedBy(CODEX, "T1", "s1", 5));
  test("approved and green", () => {
    const r = nextAction(approved(), CLAUDE, green({ T1: { ci: "SUCCESS", mergeable: "MERGEABLE", headSha: "s1" } }), at(10));
    assert.deepEqual(pick(r), { action: "merge", task: "T1", cmd: ["collab", "merge", "T1", "--agent", CLAUDE] });
  });
  test("zero checks need a passing verify at the head", () => {
    assert.equal(nextAction(approved(), CLAUDE, green({ T1: { ci: "NONE", headSha: "s1" } }), at(10)).action, "merge");
  });
  test("pending CI waits", () => {
    const r = nextAction(approved(), CLAUDE, green({ T1: { ci: "PENDING", headSha: "s1" } }), at(10));
    assert.notEqual(r.action, "merge");
  });
  test("offline (live = null) counts as UNKNOWN: merge only with a passing verify at the head", () => {
    assert.equal(nextAction(approved(), CLAUDE, null, at(10)).action, "merge");
    // A push during review moves the head past the last verify; the approval binds the new head.
    const L = run(planned(), ...submitted(CLAUDE, "T1", "s1"), rclaim(CODEX, "T1", 5), push(CLAUDE, "T1", "s2", 6), rclaim(CODEX, "T1", 6), verdict(CODEX, "T1", "approve", "s2", 7));
    assert.equal(L.tasks.T1.status, "approved");
    for (const live of [null, { ok: false }, green(), green({ T1: { ci: "UNKNOWN", headSha: "s2" } })]) {
      const r = nextAction(L, CLAUDE, live, at(10));
      assert.notEqual(r.action, "merge", JSON.stringify(live));
    }
    assert.equal(nextAction(L, CLAUDE, green({ T1: { ci: "SUCCESS", headSha: "s2" } }), at(10)).action, "merge");
  });
  test("a push during my review sends me back to review-claim for the new commit", () => {
    const L = run(planned(), ...submitted(CLAUDE, "T1", "s1"), rclaim(CODEX, "T1", 5), push(CLAUDE, "T1", "s2", 6));
    const r = nextAction(L, CODEX, green(), at(7));
    assert.deepEqual(pick(r), { action: "review", task: "T1", cmd: ["collab", "review-claim", "T1", "--agent", CODEX] });
    assert.match(r.why, /pushed s2 while you were reviewing T1 at s1/);
    const again = nextAction(run(L, rclaim(CODEX, "T1", 7)), CODEX, green(), at(8));
    assert.deepEqual(again.cmd.slice(0, 3), ["collab", "review", "T1"]);
  });
  test("a cancelled dependency doesn't hold a task back, but what it waited on does", () => {
    const cancel = (task) => ev("task.cancel", CLAUDE, task, { reason: "x" }, 1);
    const tasks = [{ title: "one" }, { title: "two", deps: ["T1"] }, { title: "three", deps: ["T2"] }];
    const base = run(planned(tasks), ev("task.claim", CLAUDE, "T1", { leaseUntil: at(90) }, 1));
    assert.equal(nextAction(base, CODEX, green(), at(2)).action, "wait");
    const L = run(base, cancel("T2"));
    const r = nextAction(L, CODEX, green(), at(2));
    assert.equal(r.action, "wait");
    assert.match(r.why, /T3 wait on dependencies/);
    const freed = run(planned(tasks), cancel("T1"));
    assert.deepEqual(pick(nextAction(freed, CODEX, green(), at(2))), { action: "claim", task: "T2", cmd: ["collab", "claim", "T2", "--agent", CODEX] });
  });
  test("merges freeze while the main PR's CI is red, except a fix-ci task", () => {
    const red = { mainCi: "FAILURE", subs: { T1: { ci: "SUCCESS", headSha: "s1" } } };
    const r = nextAction(approved(), CLAUDE, red, at(10));
    assert.notEqual(r.action, "merge");
    const F = run(planned(), ev("task.add", CODEX, null, { kind: "fix-ci", forSha: "bad1" }, 1), ...submitted(CLAUDE, "T5", "f1", 1), ...approvedBy(CODEX, "T5", "f1", 5));
    const f = nextAction(F, CLAUDE, { mainCi: "FAILURE", subs: { T5: { ci: "SUCCESS", headSha: "f1" } } }, at(10));
    assert.deepEqual(pick(f), { action: "merge", task: "T5", cmd: ["collab", "merge", "T5", "--agent", CLAUDE] });
  });
  test("accepts github.liveSnapshot's shape directly", () => {
    const snap = { ok: true, main: { ci: "FAILURE", mergeable: "MERGEABLE" }, subs: { T1: { ci: "SUCCESS", headSha: "s1" } } };
    assert.notEqual(nextAction(approved(), CLAUDE, snap, at(10)).action, "merge");
    assert.equal(nextAction(approved(), CLAUDE, { ...snap, main: { ci: "SUCCESS" } }, at(10)).action, "merge");
  });
  test("someone else's approved task is not mine to merge while its owner is live", () => {
    assert.notEqual(nextAction(approved(), CLAUDE2, green({ T1: { ci: "SUCCESS", headSha: "s1" } }), at(10)).action, "merge");
  });
});

describe("next: reclaim stale work", () => {
  // Everything open is taken, so only stale work is left for CLAUDE.
  const busy = () => run(planned([spec("a"), spec("b")]), claim(CODEX, "T1", 1), claim(CLAUDE2, "T2", 50));
  test("steal a stale claimed task", () => {
    assert.equal(nextAction(busy(), CLAUDE, green(), at(60)).action, "wait");
    const r = nextAction(busy(), CLAUDE, green(), at(100));
    assert.deepEqual(pick(r), { action: "reclaim", task: "T1", cmd: ["collab", "claim", "T1", "--steal", "--agent", CLAUDE] });
    assert.match(r.why, /codex-7k2p's lease on T1 expired/);
  });
  test("a stale approved and green task is merged, not stolen", () => {
    const L = run(planned([spec("a"), spec("b")]), ...submitted(CODEX, "T1", "s1"), ...approvedBy(CLAUDE, "T1", "s1", 5), claim(CLAUDE2, "T2", 50));
    const r = nextAction(L, CLAUDE, green({ T1: { ci: "SUCCESS", headSha: "s1" } }), at(200));
    assert.deepEqual(pick(r), { action: "merge", task: "T1", cmd: ["collab", "merge", "T1", "--agent", CLAUDE] });
  });
  test("a stale approved task with pending CI is left alone; with red CI it is stolen", () => {
    const L = run(planned([spec("a"), spec("b")]), ...submitted(CODEX, "T1", "s1"), ...approvedBy(CLAUDE, "T1", "s1", 5), claim(CLAUDE2, "T2", 150));
    assert.equal(nextAction(L, CLAUDE, green({ T1: { ci: "PENDING", headSha: "s1" } }), at(200)).action, "wait");
    assert.equal(nextAction(L, CLAUDE, green({ T1: { ci: "FAILURE", headSha: "s1" } }), at(200)).action, "reclaim");
  });
  test("no steal at the WIP limit", () => {
    const L = run(busy(), ev("task.add", CLAUDE2, null, spec("c"), 51), claim(CLAUDE, "T3", 99));
    assert.equal(nextAction(L, CLAUDE, green(), at(100)).action, "work");
  });
});

describe("next: done and wait", () => {
  test("done when every task is done or cancelled", () => {
    const L = run(planned([spec("a"), spec("b")]), ...submitted(CLAUDE, "T1", "s1"), ...approvedBy(CODEX, "T1", "s1", 5), merge(CLAUDE, "T1", "s1", 7), ev("task.cancel", CODEX, "T2", {}, 8));
    assert.deepEqual(pick(nextAction(L, CODEX, green(), at(10))), { action: "done", task: undefined, cmd: ["collab", "status", "--agent", CODEX] });
  });
  test("with every task done, wait while the main PR's CI runs so the last dashboard shows its result", () => {
    const L = run(planned([spec("a")]), ...submitted(CLAUDE, "T1", "s1"), ...approvedBy(CODEX, "T1", "s1", 5), merge(CLAUDE, "T1", "s1", 7));
    const r = nextAction(L, CODEX, { mainCi: "PENDING", subs: {} }, at(10));
    assert.equal(r.action, "wait");
    assert.match(r.why, /CI on the main PR is still running/);
    assert.equal(nextAction(L, CODEX, { ok: false }, at(10)).action, "done", "offline: nothing to wait for");
  });
  test("wait explains itself", () => {
    const L = run(planned([spec("a")]), ...submitted(CLAUDE, "T1", "s1"));
    const r = nextAction(L, CLAUDE, green(), at(10));
    assert.deepEqual(pick(r), { action: "wait", task: undefined, cmd: ["collab", "wait", "--timeout", "9m", "--agent", CLAUDE] });
    assert.match(r.why, /T1 waits for a review/);
    const solo = run(newLedger({ pr: PR, agent: { id: CLAUDE, tool: "claude" }, now: T0 }), ev("plan", CLAUDE, null, { tasks: [spec("a")] }), ...submitted(CLAUDE, "T1", "s1"));
    assert.match(nextAction(solo, CLAUDE, null, at(10)).why, /needs a reviewer from another vendor to join/);
    const frozen = run(L, ...approvedBy(CODEX, "T1", "s1", 5));
    assert.match(nextAction(frozen, CLAUDE, { mainCi: "FAILURE", subs: {} }, at(10)).why, /merges are frozen/);
  });
});

// ---------------------------------------------------------------- priority order

describe("next: priority order", () => {
  // CLAUDE owns T1 (approved, green), T2 (changes requested) and holds T6's review; CODEX's T3
  // waits for review; T4 is open; CLAUDE2's T5 has gone stale.
  const tasks = ["one", "two", "three", "four", "five", "six"].map((t) => spec(t));
  const SUBS = { T1: { ci: "SUCCESS", mergeable: "MERGEABLE", headSha: "a1" } };
  function world() {
    return run(
      planned(tasks),
      ...submitted(CLAUDE, "T1", "a1", 1), ...approvedBy(CODEX, "T1", "a1", 5),
      ...submitted(CLAUDE, "T2", "b1", 7), rclaim(CODEX, "T2", 11), verdict(CODEX, "T2", "changes", "b1", 12),
      ...submitted(CODEX, "T3", "c1", 13),
      ...submitted(CODEX, "T6", "f1", 17),
      rclaim(CLAUDE, "T6", 21),
      claim(CLAUDE2, "T5", 22),
    );
  }
  const NOW = at(150); // T5's lease (to minute 112) has expired; CLAUDE's own leases were refreshed by reviews
  const steps = [
    ["fix", "T2", (L) => L],
    ["merge", "T1", (L) => run(L, push(CLAUDE, "T2", "b2", 30), verify(CLAUDE, "T2", "b2", 31), submit(CLAUDE, "T2", "b2", 32))],
    ["review", "T6", (L) => apply(L, merge(CLAUDE, "T1", "a1", 33))],
    ["review", "T3", (L) => apply(L, verdict(CLAUDE, "T6", "approve", "f1", 34))],
    ["review", "T3", (L) => apply(L, rclaim(CLAUDE, "T3", 35))],
    ["claim", "T4", (L) => apply(L, verdict(CLAUDE, "T3", "approve", "c1", 36))],
    // T3's owner went quiet after the approval: a stale approved, verified task is merged first.
    ["merge", "T3", (L) => apply(L, ev("task.cancel", "owner", "T4", {}, 37))],
    ["reclaim", "T5", (L) => apply(L, merge(CLAUDE, "T3", "c1", 151))],
  ];
  test("fix > merge > held review > new review > claim > stale merge > reclaim", () => {
    let L = world();
    for (const [action, task, advance] of steps) {
      L = advance(L);
      const r = nextAction(L, CLAUDE, green(SUBS), NOW);
      assert.deepEqual([r.action, r.task], [action, task], `expected ${action} ${task}, got ${r.action} ${r.task}: ${r.why}`);
    }
  });
  test("every cmd starts with collab and carries --agent <me>", () => {
    let L = world();
    for (const [, , advance] of steps) {
      L = advance(L);
      for (const me of [CLAUDE, CODEX, CLAUDE2, "new-agent"]) {
        const r = nextAction(L, me, green(SUBS), NOW);
        assert.equal(r.cmd[0], "collab");
        assert.deepEqual(r.cmd.slice(-2), ["--agent", me]);
        assert.equal(typeof r.why, "string");
      }
    }
  });
  test("nextAction does not mutate the ledger", () => {
    const L = world();
    const before = JSON.stringify(L);
    nextAction(L, CLAUDE, green(SUBS), NOW);
    nextAction(L, CODEX, null, NOW);
    assert.equal(JSON.stringify(L), before);
  });
});

describe("next: tasks the owner reserved for an invited agent", () => {
  const reserve = (task, agentFor, untilMin, min = 1) => ev("task.reserve", "owner", task, { for: agentFor, until: at(untilMin) }, min);
  test("other agents skip it; the agent it is for claims it first", () => {
    const L = run(planned([spec("one"), spec("two")]), reserve("T1", CODEX, 60));
    assert.deepEqual(pick(nextAction(L, CLAUDE, green(), at(2))), { action: "claim", task: "T2", cmd: pick(nextAction(L, CLAUDE, green(), at(2))).cmd });
    const r = nextAction(L, CODEX, green(), at(2));
    assert.equal(r.action, "claim");
    assert.equal(r.task, "T1");
    assert.match(r.why, /reserved T1 for you/);
  });
  test("with nothing else open, others wait and are told why", () => {
    const L = run(planned([spec("one")]), reserve("T1", CODEX, 60));
    const r = nextAction(L, CLAUDE, green(), at(2));
    assert.equal(r.action, "wait");
    assert.match(r.why, /T1 is reserved for codex-7k2p/);
    assert.equal(nextAction(L, CLAUDE, green(), at(61)).task, "T1", "a lapsed reservation is open to anyone");
  });
  test("a reserved task that waits on dependencies stays set aside once they are done", () => {
    const L = run(planned([spec("one"), spec("two", { deps: ["T1"] })]), reserve("T2", CODEX, 120), ...submitted(CLAUDE, "T1", "s1", 2), ...approvedBy(CODEX, "T1", "s1", 6), merge(CLAUDE, "T1", "s1", 8));
    assert.equal(L.tasks.T1.status, "done");
    assert.equal(nextAction(L, CLAUDE, green(), at(9)).action, "wait");
    assert.equal(nextAction(L, CODEX, green(), at(9)).task, "T2");
  });
});
