// Use case: tests/use-cases/collab-plan-start.md
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ok, planSetup } from "../helpers/plan-env.mjs";

let p;
let n;
before(() => { p = planSetup({ people: { alice: "write", bob: "read" } }); });
after(() => p.cleanup());

test("plan new opens a labelled issue, the ledger on refs/collab/plan-<n> and revision 1", () => {
  const { n: num, r } = p.start("Add SSO login for enterprise customers");
  n = num;
  assert.equal(n, 2, "issues share the number counter with PR #1");
  assert.match(r.out, /You are claude-[a-z0-9]{4} \(Claude Code\) for zwymer/);
  assert.match(r.out, /Claude Code: {2}\/collab plan 2/);
  assert.match(r.out, /Codex: {8}\$collab plan 2/);
  assert.match(r.out, /collab prompt plan 2/);

  const issue = p.issue(n);
  assert.equal(issue.title, "Plan: Add SSO login for enterprise customers");
  assert.deepEqual(issue.labels, ["collab-plan"]);
  assert.ok(p.s.fake.read().repos["o/r"].labels.some((l) => l.name === "collab-plan"), "the label exists");
  const status = issue.body.indexOf("<!-- collab:plan-status:start");
  const doc = issue.body.indexOf("<!-- collab:plan-doc:start seq=1");
  assert.ok(status >= 0 && doc > status, issue.body);
  assert.match(issue.body, /## Request\s+Add SSO login for enterprise customers/);
  assert.match(issue.body, /## Plan session: /);

  assert.deepEqual(p.tree(n), ["ledger.json", "plan.md", "r1.md"]);
  const l = p.ledger(n);
  assert.equal(l.kind, "plan");
  assert.equal(l.owner, "zwymer");
  assert.equal(l.current, 1);
  assert.equal(l.minPeople, 2);
  assert.deepEqual(Object.keys(l.people), ["zwymer"]);
});

test("--body-file seeds revision 1 with a draft the person already wrote", () => {
  const dir = path.join(p.s.clone("zwymer"), ".collab");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "plan-draft.md"), "## Goal\n\nShip the slugify helper.\n");
  const { n: m } = p.start("Slugify helper", ["--body-file", ".collab/plan-draft.md"]);
  assert.equal(p.raw("zwymer", m), "## Goal\n\nShip the slugify helper.\n");
});

test("plan text that is too long, empty or holds collab's markers is refused before any issue is opened", () => {
  const dir = path.join(p.s.clone("zwymer"), ".collab");
  const before = Object.keys(p.s.fake.read().issues).length;
  for (const [name, text, why] of [
    ["long.md", `${"x".repeat(50_001)}\n`, /at most 50000/],
    ["marker.md", "## Goal\n<!-- collab:plan-doc:end -->\n", /<!-- collab:/],
    ["empty.md", "\n\n", /empty/],
  ]) {
    writeFileSync(path.join(dir, name), text);
    const r = p.run("zwymer", ["plan", "new", "--title", "Bad", "--tool", "claude", "--body-file", `.collab/${name}`]);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, why);
  }
  assert.equal(Object.keys(p.s.fake.read().issues).length, before);
});

test("plan files are read only from the repo's .collab/ folder, since their text is published", () => {
  const r = p.run("zwymer", ["plan", "new", "--title", "Leak", "--tool", "claude", "--body-file", "test/ok.test.mjs"]);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /\.collab\/ folder/);
});

test("someone else lists the open sessions and joins one from their own account", () => {
  const list = p.json("alice", ["plan", "list"]);
  ok(list);
  const row = list.data.sessions.find((x) => x.number === n);
  assert.ok(row, list.out);
  assert.equal(row.rev, 1);
  assert.deepEqual(row.people, ["zwymer"]);

  const id = p.join("alice", n);
  assert.match(id, /^claude-/);
  const joined = p.comments(n).find((c) => c.body.includes("collab:plan-join login=alice"));
  assert.equal(joined?.login, "alice", "the join comment comes from alice's own account");
  assert.match(joined.body, /👋 Joined: alice joined/);
  const l = p.ledger(n);
  assert.deepEqual(Object.keys(l.people).sort(), ["alice", "zwymer"]);
  assert.equal(l.agents[id].login, "alice");
});

test("a login with only read access can't join", () => {
  const r = p.run("bob", ["plan", "join", String(n), "--tool", "claude"]);
  assert.equal(r.code, 5, r.out);
  assert.match(r.out, /write access/);
  assert.ok(!p.ledger(n).people.bob);
});

test("an agent can't act for another person", () => {
  const zid = p.ids[n].zwymer;
  const r = p.run("alice", ["plan", "next", String(n), "--agent", zid]);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /belongs to zwymer/);
});

test("a pull request number is not a plan session", () => {
  const r = p.run("alice", ["plan", "join", "1", "--tool", "claude"]);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /pull request/);
});

test("collab plan --tasks still posts a PR collab's task split", () => {
  const ids = p.s.start([{ title: "Helpers", accept: ["works"], scope: ["src/h.mjs"], size: "S" }], []);
  assert.match(ids.claude, /^claude-/);
});
