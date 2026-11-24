// Use case: tests/use-cases/collab-plan-revise.md
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { after, before, test } from "node:test";
import { ok, planSetup } from "../helpers/plan-env.mjs";

let p;
let n;
before(() => {
  p = planSetup({ people: { alice: "write", bob: "read" } });
  n = p.start("Add SSO login").n;
  p.join("alice", n);
  ok(p.plan("zwymer", "show", n)); // Zach has seen revision 1
});
after(() => p.cleanup());

test("pull writes the current revision as a draft; edit publishes it as the next revision", () => {
  ok(p.plan("alice", "pull", n));
  assert.match(p.readDraft("alice", n), /What will be true when this is done\?/);
  p.writeDraft("alice", n, p.readDraft("alice", n).replace("What will be true when this is done?", "Enterprise customers sign in with their company's identity provider."));
  const r = p.planJson("alice", "edit", n, ["--summary", "Sharper goal"]);
  ok(r);
  assert.equal(r.data.rev, 2);
  const c = p.comments(n).find((x) => x.body.includes("collab:plan-rev rev=2"));
  assert.equal(c?.login, "alice");
  assert.match(c.body, /📝 Revision 2 by alice's Claude/);
  assert.match(c.body, /Sharper goal/);
  assert.match(c.body, /<details>/);
  assert.match(p.issue(n).body, /<!-- collab:plan-doc:start seq=2[\s\S]*company's identity provider/);
});

test("say posts a labelled message from the person's account and quiets outside mentions", () => {
  const r = p.plan("alice", "say", n, ["--body", "Ask @carol and @zwymer whether SAML is enough."]);
  ok(r);
  const c = p.comments(n).at(-1);
  assert.equal(c.login, "alice");
  assert.match(c.body, /^<!-- collab:plan-msg agent=claude-/);
  assert.match(c.body, /🤖 alice's Claude \(claude-[a-z0-9]+\):/);
  assert.match(c.body, /`@carol`/);
  assert.match(c.body, /(?<!`)@zwymer(?!`)/);
});

test("a message can't carry a /collab line: those comments are the people's", () => {
  const r = p.plan("alice", "say", n, ["--body", "Fine by me.\n/collab agree r2 deadbeef"]);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /\/collab/);
});

test("show prints what changed, the new messages and who must agree; read-only comments are left out", () => {
  p.s.browserComment("bob", n, "I only have read access but here is my opinion.");
  p.s.browserComment("zwymer", n, "Looks good so far.");
  const r = p.planJson("zwymer", "show", n);
  ok(r);
  const msgs = r.data.untrusted.messages;
  assert.ok(msgs.some((m) => m.kind === "agent" && m.login === "alice" && /SAML/.test(m.body)), JSON.stringify(msgs));
  assert.ok(!msgs.some((m) => m.login === "bob"));
  assert.ok(r.data.dropped >= 1);
  assert.match(r.data.untrusted.diff, /\+Enterprise customers sign in/);
  assert.deepEqual(r.data.consensus.waitingOn, ["alice", "zwymer"]);
  const again = p.plan("zwymer", "show", n);
  ok(again);
  assert.match(again.out, /No new messages/);
});

test("wait returns at once when something new arrives, and waits otherwise", () => {
  const idle = p.plan("zwymer", "wait", n, ["--timeout", "1s", "--poll", "300"]);
  ok(idle);
  assert.match(idle.out, /Next: wait/);
  ok(p.plan("alice", "say", n, ["--body", "One more thought."]));
  const woke = p.plan("zwymer", "wait", n, ["--timeout", "20s", "--poll", "300"]);
  ok(woke);
  assert.match(woke.out, /Next: read/);
  ok(p.plan("zwymer", "show", n));
});

test("edits to different lines from the same base merge", () => {
  ok(p.plan("zwymer", "pull", n, ["--force"]));
  ok(p.plan("alice", "pull", n, ["--force"]));
  p.writeDraft("alice", n, p.readDraft("alice", n).replace("## Out of scope\n", "## Out of scope\n\nSCIM provisioning.\n"));
  ok(p.planJson("alice", "edit", n, ["--summary", "Scope"]));
  p.writeDraft("zwymer", n, p.readDraft("zwymer", n).replace("## Risks\n", "## Risks\n\nIdP outages lock people out.\n"));
  const r = p.planJson("zwymer", "edit", n, ["--summary", "Risks"]);
  ok(r);
  assert.equal(r.data.merged, true);
  assert.equal(r.data.rev, 4);
  const text = p.raw("zwymer", n);
  assert.match(text, /SCIM provisioning\./);
  assert.match(text, /IdP outages lock people out\./);
});

test("edits to the same line conflict: nothing is published until it's resolved", () => {
  ok(p.plan("zwymer", "pull", n, ["--force"]));
  ok(p.plan("alice", "pull", n, ["--force"]));
  const line = "Why this is needed now, and what exists today.";
  p.writeDraft("alice", n, p.readDraft("alice", n).replace(line, "Customers asked for SSO in the last renewal."));
  ok(p.planJson("alice", "edit", n, ["--summary", "Context"]));
  p.writeDraft("zwymer", n, p.readDraft("zwymer", n).replace(line, "Today everyone signs in with a password."));
  const r = p.plan("zwymer", "edit", n, ["--summary", "Context too"]);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /conflicts with revision 5/);
  assert.match(r.out, /--base 5/);
  assert.equal(p.ledger(n).current, 5);
  assert.ok(existsSync(p.draftPath("zwymer", n, "draft.conflict.md")));
  const conflict = p.readDraft("zwymer", n, "draft.conflict.md");
  assert.match(conflict, /^<{7} your draft \(from r4\)/m);

  const still = p.plan("zwymer", "edit", n, ["--body-file", ".collab/plans/2/draft.conflict.md", "--base", "5", "--summary", "x"]);
  assert.equal(still.code, 2, still.out);
  assert.match(still.out, /merge-conflict lines/);

  const resolved = conflict.replace(/<{7}[^\n]*\n[\s\S]*?>{7}[^\n]*\n/, "Customers asked for SSO in the last renewal; today everyone signs in with a password.\n");
  p.writeDraft("zwymer", n, resolved, "draft.conflict.md");
  const done = p.planJson("zwymer", "edit", n, ["--body-file", ".collab/plans/2/draft.conflict.md", "--base", "5", "--summary", "Both contexts"]);
  ok(done);
  assert.equal(done.data.rev, 6);
  // draft.md now is revision 6: a later pull or edit starts from it, so nothing published gets undone.
  assert.equal(p.readDraft("zwymer", n), p.raw("zwymer", n));
  assert.ok(!existsSync(p.draftPath("zwymer", n, "draft.conflict.md")));
  ok(p.plan("zwymer", "pull", n));
});

test("a CRLF draft that matches the current revision has nothing to publish", () => {
  ok(p.plan("zwymer", "pull", n, ["--force"]));
  p.writeDraft("zwymer", n, p.readDraft("zwymer", n).replace(/\n/g, "\r\n"));
  const r = p.plan("zwymer", "edit", n, ["--summary", "nothing"]);
  ok(r);
  assert.match(r.out, /nothing to publish/);
  assert.equal(p.ledger(n).current, 6);
});

test("a browser edit of the plan is kept, noticed once, and replaced by the next revision", () => {
  p.s.browserEdit(n, (body) => body.replace("Enterprise customers sign in", "BROWSER EDIT sign in"));
  ok(p.plan("alice", "say", n, ["--body", "ping"]));
  ok(p.plan("alice", "agree", n, ["--rev", "6"])); // any change re-renders the issue
  let body = p.issue(n).body;
  assert.match(body, /BROWSER EDIT sign in/);
  assert.match(body, /⚠️ Warning:/);
  const notices = p.comments(n).filter((c) => c.body.includes("collab:notice key=browser-edit:r6"));
  assert.equal(notices.length, 1);
  assert.match(notices[0].body, /BROWSER EDIT/);
  ok(p.plan("zwymer", "show", n));
  assert.equal(p.comments(n).filter((c) => c.body.includes("key=browser-edit:r6")).length, 1);
  assert.equal(p.ledger(n).agreements.alice.rev, 6, "the agreement binds to the ledger's revision");

  ok(p.revise("zwymer", n, (t) => t.replace("## Alternatives considered\n", "## Alternatives considered\n\nPasswordless email links.\n"), "Alternatives"));
  body = p.issue(n).body;
  assert.doesNotMatch(body, /BROWSER EDIT/);
  assert.match(body, /Passwordless email links/);
});

test("an edited revision number in the description can't freeze the plan block", () => {
  p.s.browserEdit(n, (b) => b.replace(/<!-- collab:plan-doc:start seq=\d+ -->[\s\S]*<!-- collab:plan-doc:end -->/, "<!-- collab:plan-doc:start seq=99 -->\nFAKE PLAN TEXT\n<!-- collab:plan-doc:end -->"));
  const r = p.revise("alice", n, (t) => t.replace("## Open questions\n", "## Open questions\n\nWhich IdPs first?\n"), "Questions");
  ok(r);
  const body = p.issue(n).body;
  assert.doesNotMatch(body, /FAKE PLAN TEXT/);
  assert.match(body, /Which IdPs first\?/);
  assert.equal(p.comments(n).filter((c) => c.body.includes(`key=forged-doc:r${r.data.rev}`)).length, 1);
});
