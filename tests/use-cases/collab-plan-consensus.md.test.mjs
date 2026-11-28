// Use case: tests/use-cases/collab-plan-consensus.md
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { ok, planSetup } from "../helpers/plan-env.mjs";

let p;
let n;
before(() => {
  p = planSetup({ people: { alice: "write", bob: "read" } });
  n = p.start("Add SSO login").n;
  p.join("alice", n);
  ok(p.revise("zwymer", n, (t) => t.replace("What will be true when this is done?", "Enterprise customers use their identity provider."), "Goal"));
});
after(() => p.cleanup());

test("a person agrees through their agent: bound to the revision's hash and posted from their account", () => {
  const r = p.plan("zwymer", "agree", n, ["--rev", "2"]);
  ok(r);
  const l = p.ledger(n);
  assert.equal(l.agreements.zwymer.rev, 2);
  assert.equal(l.agreements.zwymer.hash, l.revs["2"].hash);
  assert.equal(l.agreements.zwymer.via, `agent:${p.ids[n].zwymer}`);
  const c = p.comments(n).find((x) => x.body.includes("collab:plan-agree login=zwymer rev=2"));
  assert.equal(c?.login, "zwymer");
  assert.match(c.body, /✅ Agrees: zwymer agrees to revision 2/);
  assert.equal(l.phase, "drafting");
  assert.match(r.out, /waiting on alice/);
});

test("agreeing to a revision that isn't current is refused", () => {
  const r = p.plan("alice", "agree", n, ["--rev", "1"]);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /revision 2/);
});

test("a new revision resets every agreement", () => {
  ok(p.revise("zwymer", n, (t) => t.replace("## Risks\n", "## Risks\n\nIdP outages.\n"), "Risks"));
  const l = p.ledger(n);
  assert.equal(l.current, 3);
  assert.deepEqual(l.agreements, {});
  ok(p.plan("zwymer", "agree", n, ["--rev", "3"]));
});

test("comments that don't count are recorded as directives and change nothing", () => {
  const h = p.hash8(n);
  p.s.browserComment("bob", n, `/collab agree r3 ${h}`); // read access only
  p.s.browserComment("carol", n, `/collab agree r3 ${h}`); // not a collaborator
  p.s.browserComment("alice", n, `/collab agree r2 ${h}`); // wrong revision
  p.s.browserComment("alice", n, "/collab agree r3 deadbeef"); // wrong hash
  ok(p.plan("alice", "say", n, ["--body", `I'd write: /collab agree r3 ${h}`])); // an agent's message, not a directive
  ok(p.plan("zwymer", "next", n));
  const l = p.ledger(n);
  assert.equal(l.directives.length, 4, JSON.stringify(l.directives));
  assert.ok(l.directives.every((d) => d.applied === false && d.why), JSON.stringify(l.directives));
  assert.ok(!l.agreements.alice);
  assert.equal(l.phase, "drafting");
});

test("a /collab agree comment from a person completes agreement, with one notice", () => {
  p.s.browserComment("alice", n, `Happy with this.\n/collab agree r3 ${p.hash8(n)}`);
  // status is the command people run to check, so it applies the comment too.
  const r = p.plan("zwymer", "status", n);
  ok(r);
  assert.match(r.out, /✅ Agreed/, r.out);
  assert.doesNotMatch(r.out, /waiting on alice/i, r.out);
  const l = p.ledger(n);
  assert.equal(l.agreements.alice.via, "comment");
  assert.equal(l.phase, "agreed");
  assert.ok(l.agreedAt);
  ok(p.plan("alice", "next", n));
  const notices = p.comments(n).filter((c) => c.body.includes("collab:notice key=agreed:r3"));
  assert.equal(notices.length, 1);
  assert.match(notices[0].body, /✅ Agreed: everyone agreed to revision 3/);
  assert.match(p.issue(n).body, /✅ Agreed/);
});

test("next says agreed and offers the handoff", () => {
  ok(p.plan("zwymer", "show", n));
  const r = p.plan("zwymer", "next", n);
  ok(r);
  assert.match(r.out, /Next: agreed/);
  assert.match(r.out, /plan handoff 2/);
});

test("an agreed plan is frozen until the owner reopens it from their own terminal", () => {
  ok(p.plan("alice", "pull", n, ["--force"]));
  p.writeDraft("alice", n, p.readDraft("alice", n) + "\nOne more line.\n");
  const edit = p.plan("alice", "edit", n, ["--summary", "late"]);
  assert.equal(edit.code, 2, edit.out);
  assert.match(edit.out, /frozen/);
  // Agreeing again changes nothing: it only re-posts an agreement comment that never made it to GitHub.
  const agreeComments = () => p.comments(n).filter((c) => c.login === "alice" && /plan-agree|\/collab agree/.test(c.body)).length;
  const before = agreeComments();
  const again = p.plan("alice", "agree", n, ["--rev", "3"]);
  ok(again);
  assert.match(again.out, /already recorded/);
  assert.equal(agreeComments(), before);

  const inAgent = p.run("zwymer", ["plan", "reopen", String(n)], { CLAUDECODE: "1" });
  assert.equal(inAgent.code, 2, inAgent.out);
  assert.match(inAgent.out, /owner-only command/);
  ok(p.run("zwymer", ["plan", "reopen", String(n)]));
  const l = p.ledger(n);
  assert.equal(l.phase, "drafting");
  assert.deepEqual(l.agreements, {});
  const w = p.plan("zwymer", "next", n);
  ok(w);
  ok(p.plan("zwymer", "show", n));
  const wait = p.plan("zwymer", "next", n);
  assert.match(wait.out, /Next: wait/);
  assert.match(wait.out, /alice/);
});

test("--people sets how many people must agree", () => {
  const pair = p.start("Pair plan").n;
  ok(p.plan("zwymer", "agree", pair, ["--rev", "1"]));
  const lp = p.ledger(pair);
  assert.equal(lp.phase, "drafting");
  const solo = p.start("Solo plan", ["--people", "1"]).n;
  ok(p.plan("zwymer", "agree", solo, ["--rev", "1"]));
  assert.equal(p.ledger(solo).phase, "agreed");
});

test("--rev with no value is refused instead of agreeing to revision 1", () => {
  const m = p.start("Flag check").n;
  p.join("alice", m);
  const r = p.plan("alice", "agree", m, ["--rev"]);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /--rev needs/);
  assert.ok(!p.ledger(m).agreements.alice);
  const people = p.run("zwymer", ["plan", "new", "--title", "No value", "--tool", "claude", "--people"]);
  assert.equal(people.code, 2, people.out);
});

test("inside an agent session, agree without --agent is refused, so it is never recorded as the person's terminal", () => {
  const m = p.start("Via check").n;
  p.join("alice", m);
  const r = p.run("alice", ["plan", "agree", String(m), "--rev", "1"], { CLAUDECODE: "1" });
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /pass --agent/);
  ok(p.plan("alice", "agree", m, ["--rev", "1"]));
  assert.equal(p.ledger(m).agreements.alice.via, `agent:${p.ids[m].alice}`);
});

test("someone who joins an agreed plan only watches: wait keeps waiting instead of returning at once", () => {
  const m = p.start("Observer", ["--people", "1"]).n;
  ok(p.plan("zwymer", "agree", m, ["--rev", "1"]));
  p.join("alice", m);
  assert.equal(p.ledger(m).people.alice.observer, true);
  ok(p.plan("alice", "show", m));
  const t0 = Date.now();
  const w = p.plan("alice", "wait", m, ["--timeout", "1500ms", "--poll", "300"]);
  ok(w);
  assert.match(w.out, /Next: wait/);
  assert.ok(Date.now() - t0 >= 1400, `returned after ${Date.now() - t0} ms`);
});
