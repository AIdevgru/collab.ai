// Use case: tests/use-cases/collab-plan-people.md
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { ok, planSetup } from "../helpers/plan-env.mjs";

let p;
let n;
before(() => {
  p = planSetup({ people: { alice: "write", bob: "write", carol: "admin" } });
  n = p.start("Add SSO login").n;
  p.join("alice", n);
  p.join("bob", n);
});
after(() => p.cleanup());

test("a person leaves and comes back; the owner can't leave", () => {
  ok(p.plan("alice", "leave", n));
  assert.ok(p.ledger(n).people.alice.left);
  const quiet = p.plan("alice", "say", n, ["--body", "still here?"]);
  assert.equal(quiet.code, 4, quiet.out);
  const owner = p.plan("zwymer", "leave", n);
  assert.equal(owner.code, 2, owner.out);
  p.join("alice", n);
  assert.equal(p.ledger(n).people.alice.left, null);
});

test("owner commands are refused inside agent sessions, behind the relay and from another person's clone", () => {
  for (const env of [{ CLAUDECODE: "1" }, { COLLAB_RELAYED: "1" }, { COLLAB_AGENT: p.ids[n].zwymer }]) {
    const r = p.run("zwymer", ["plan", "remove", String(n), "bob"], env);
    assert.equal(r.code, 2, `${JSON.stringify(env)}: ${r.out}`);
  }
  const other = p.run("alice", ["plan", "remove", String(n), "bob"]);
  assert.equal(other.code, 2, other.out);
  assert.match(other.out, /only the session's owner \(zwymer\) or a repo admin/);
  assert.ok(!p.ledger(n).people.bob.removed);
});

test("removing someone who went quiet completes agreement; they can't rejoin", () => {
  ok(p.plan("zwymer", "agree", n, ["--rev", "1"]));
  ok(p.plan("alice", "agree", n, ["--rev", "1"]));
  assert.equal(p.ledger(n).phase, "drafting");
  const r = p.run("zwymer", ["plan", "remove", String(n), "bob", "--reason", "away for a month"]);
  ok(r);
  const l = p.ledger(n);
  assert.ok(l.people.bob.removed);
  assert.equal(l.phase, "agreed");
  const back = p.run("bob", ["plan", "join", String(n), "--tool", "claude"]);
  assert.equal(back.code, 4, back.out);
  assert.match(back.out, /removed/);
  const again = p.run("bob", ["plan", "join", String(n), "--tool", "claude", "--agent", p.ids[n].bob]);
  assert.equal(again.code, 4, again.out);
});

test("closing marks the session closed, closes the issue, and agents stop", () => {
  ok(p.run("zwymer", ["plan", "close", String(n)]));
  assert.equal(p.ledger(n).phase, "closed");
  assert.equal(p.issue(n).state, "closed");
  const next = p.plan("alice", "next", n);
  assert.equal(next.code, 4, next.out);
  assert.match(next.out, /Next: closed/);
  const say = p.plan("alice", "say", n, ["--body", "hello?"]);
  assert.equal(say.code, 4, say.out);
});

test("an issue closed in the browser stops agents too", () => {
  const m = p.start("Second plan").n;
  p.join("alice", m);
  p.s.fake.update((st) => { st.issues[`o/r#${m}`].state = "closed"; });
  const r = p.plan("alice", "next", m);
  assert.equal(r.code, 4, r.out);
  assert.match(r.out, /closed/);
});

test("list finds a session whose label was removed, and hides closed ones unless --all", () => {
  const k = p.start("Third plan").n;
  p.s.fake.update((st) => { st.issues[`o/r#${k}`].labels = []; });
  const r = p.json("alice", ["plan", "list"]);
  ok(r);
  const nums = r.data.sessions.map((x) => x.number);
  assert.ok(nums.includes(k), r.out);
  assert.ok(!nums.includes(n), "closed sessions are hidden");
  const all = p.json("alice", ["plan", "list", "--all"]);
  ok(all);
  assert.ok(all.data.sessions.some((x) => x.number === n));
});

test("a repo admin who never joined can close a session from their own terminal", () => {
  const k = p.start("Fourth plan").n;
  p.s.person("carol");
  ok(p.run("carol", ["plan", "close", String(k)]));
  const l = p.ledger(k);
  assert.equal(l.phase, "closed");
  assert.equal(l.closed.by, "carol");
  assert.ok(!l.people.carol, "carol didn't have to join");
});
