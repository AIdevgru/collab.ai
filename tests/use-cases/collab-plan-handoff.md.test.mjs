// Use case: tests/use-cases/collab-plan-handoff.md
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { sh } from "../helpers/bare-remote.mjs";
import { ok, planSetup, sha } from "../helpers/plan-env.mjs";

let p;
let n;
let pr;
before(() => {
  p = planSetup({ people: { alice: "write" } });
  n = p.start("Add SSO login").n;
  p.join("alice", n);
  ok(p.revise("zwymer", n, (t) => t.replace("What will be true when this is done?", "Enterprise customers use their identity provider."), "Goal"));
});
after(() => p.cleanup());

test("handing off before everyone agreed is refused", () => {
  const r = p.plan("zwymer", "handoff", n);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /isn't agreed yet/);
  assert.match(r.out, /alice/);
});

test("an agreement GitHub has no comment for blocks the handoff", () => {
  ok(p.plan("zwymer", "agree", n, ["--rev", "2"]));
  ok(p.plan("alice", "agree", n, ["--rev", "2"]));
  assert.equal(p.ledger(n).phase, "agreed");
  // As if the ledger had been written by hand: alice's agreement comment is gone.
  p.s.fake.update((st) => { st.comments[`o/r#${n}`] = st.comments[`o/r#${n}`].filter((c) => !c.body.includes("plan-agree login=alice")); });
  const r = p.plan("zwymer", "handoff", n);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /no agreement comment for revision 2 from alice/);
  // Her own /collab agree comment counts as the record.
  p.s.browserComment("alice", n, `/collab agree r2 ${p.hash8(n)}`);
});

test("handoff opens a draft build PR from the default branch holding the agreed plan", () => {
  const head = sh(["rev-parse", "HEAD"], p.s.clone("zwymer"));
  const r = p.planJson("zwymer", "handoff", n);
  ok(r);
  pr = r.data.pr;
  assert.equal(r.data.path, "docs/plans/2-add-sso-login.md");
  assert.equal(r.data.branch, "collab/plan-2-build");
  const pull = p.s.fake.read().pulls[`o/r#${pr}`];
  assert.equal(pull.baseRef, "main");
  assert.equal(pull.headRef, "collab/plan-2-build");
  assert.equal(pull.draft, true);
  assert.equal(pull.title, "Build: Add SSO login");
  const l = p.ledger(n);
  assert.match(pull.body, new RegExp(`<!-- collab:plan-source issue=2 rev=2 sha256=${l.revs["2"].hash.slice(7)} -->`));
  assert.match(pull.body, /Closes #2/);
  const file = sh(["show", "refs/heads/collab/plan-2-build:docs/plans/2-add-sso-login.md"], p.s.repo.remote);
  assert.equal(sha(`${file}\n`), l.revs["2"].hash, "the file is the agreed text, byte for byte");
  assert.equal(sh(["rev-parse", "refs/heads/collab/plan-2-build~1"], p.s.repo.remote), sh(["rev-parse", "refs/heads/main"], p.s.repo.remote));
  assert.equal(l.phase, "handed-off");
  assert.equal(l.handoff.pr, pr);
  assert.equal(p.comments(n).filter((c) => c.body.includes(`key=handed-off:${pr}`)).length, 1);
  assert.equal(sh(["rev-parse", "HEAD"], p.s.clone("zwymer")), head, "the person's checkout is untouched");
  assert.equal(sh(["status", "--porcelain", "--untracked-files=no"], p.s.clone("zwymer")), "");
});

test("running handoff again prints the same PR", () => {
  const r = p.planJson("zwymer", "handoff", n);
  ok(r);
  assert.equal(r.data.pr, pr);
  assert.equal(r.data.existing, true);
});

test("the build PR's planner gets the agreed plan through collab context", () => {
  const j = p.run("zwymer", ["join", String(pr), "--tool", "claude"]);
  ok(j);
  const id = p.s.idOf(j);
  const c = p.run("zwymer", ["context", "--pr", String(pr), "--agent", id]);
  ok(c);
  const out = JSON.parse(c.stdout);
  assert.equal(out.planSource.issue, 2);
  assert.equal(out.planSource.rev, 2);
  assert.equal(out.planSource.path, "docs/plans/2-add-sso-login.md");
  assert.deepEqual(out.planSource.agreedBy, ["alice", "zwymer"]);
  assert.equal(out.planSource.changedOnBranch, false);
  assert.match(out.untrusted.plan.text, /Enterprise customers use their identity provider\./);
});

test("a copied plan-source marker on another PR is ignored", () => {
  // Joining the build PR put the dashboard above it, so find the marker itself.
  const marker = /<!-- collab:plan-source [^>]*-->/.exec(p.s.fake.read().pulls[`o/r#${pr}`].body)?.[0];
  assert.ok(marker);
  p.s.fake.update((st) => { st.pulls["o/r#1"].body = `${marker}\n${st.pulls["o/r#1"].body}`; });
  const j = p.run("alice", ["join", "1", "--tool", "claude"]);
  ok(j);
  const c = p.run("alice", ["context", "--pr", "1", "--agent", p.s.idOf(j)]);
  ok(c);
  const out = JSON.parse(c.stdout);
  assert.equal(out.planSource, null);
  assert.equal(out.untrusted.plan, null);
  assert.match(c.stderr, /doesn't confirm/);
});
