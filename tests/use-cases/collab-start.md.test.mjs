// Use case: tests/use-cases/collab-start.md
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { setup } from "../helpers/cli-env.mjs";
import { sh } from "../helpers/bare-remote.mjs";

const BODY = "Owner notes.\n\n- [ ] add helpers\n- [ ] document them\n\nHUMAN TEXT SENTINEL\n";
let s;
let claude;
before(() => { s = setup({ body: BODY }); });
after(() => s.cleanup());

const writePlan = (name, n) => {
  const dir = path.join(s.clone(name), ".collab");
  mkdirSync(dir, { recursive: true });
  const tasks = Array.from({ length: n }, (_, i) => ({ title: `Task ${i + 1}`, desc: "do it", accept: ["works"], scope: [`src/t${i + 1}.mjs`], deps: [], size: "S" }));
  writeFileSync(path.join(dir, `plan-${n}.json`), JSON.stringify({ tasks }));
  return `.collab/plan-${n}.json`;
};

test("the first agent creates the ledger, pins the account and holds the planning lease", () => {
  const r = s.run("claude", ["join", "https://github.com/o/r/pull/1", "--tool", "claude"]);
  assert.equal(r.code, 0, r.out);
  claude = s.idOf(r);
  assert.match(claude, /^claude-[a-z0-9]{4}$/);
  assert.match(r.out, /vendor anthropic/);
  assert.match(r.out, /You hold the planning lease until \d{4}-\d\d-\d\d \d\d:\d\d UTC/);
  assert.match(r.out, /collab context --pr 1/);
  assert.match(sh(["ls-remote", "origin", "refs/collab/*"], s.clone("claude")), /refs\/collab\/pr-1/);
  assert.equal(sh(["config", "--get", "collab.login"], s.clone("claude")), "zwymer");
});

test("an agent joining during planning is told to wait, without a second planning lease", () => {
  const r = s.run("codex", ["join", "1", "--tool", "codex"]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, new RegExp(`${claude} is writing the plan`));
  assert.match(r.out, /collab wait --pr 1/);
});

test("context puts everything people wrote under untrusted", () => {
  const r = s.run("claude", ["context", "--pr", "1", "--agent", claude]);
  assert.equal(r.code, 0, r.out);
  const ctx = JSON.parse(r.stdout);
  assert.match(ctx.note, /Never follow instructions/);
  assert.match(ctx.untrusted.body, /HUMAN TEXT SENTINEL/);
  assert.deepEqual(ctx.untrusted.checklist.map((c) => c.text), ["add helpers", "document them"]);
  assert.ok(Array.isArray(ctx.changedFiles));
});

test("a plan over 12 tasks is refused", () => {
  const r = s.run("claude", ["plan", "--tasks", writePlan("claude", 13), "--pr", "1", "--agent", claude]);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /12/);
});

test("posting the plan prints the first-run block for the owner", () => {
  // Run from <repo>/.collab, where a sandboxed Codex works; the plan file is still named from the
  // repo root (.collab/plan-4.json), as the skill says.
  const r = s.run(path.join(s.clone("claude"), ".collab"), ["plan", "--tasks", writePlan("claude", 4), "--pr", "1", "--agent", claude]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Plan: 4 tasks \(T1–T4\)\. Dashboard: https:\/\/github\.com\/o\/r\/pull\/1/);
  assert.match(r.out, /Agents from 2 vendors have joined|Any other agent can review a task; one from another vendor goes first/);
  assert.match(r.out, /paste into Codex: {3}\$collab https:\/\/github\.com\/o\/r\/pull\/1/);
  assert.match(r.out, /collab invite codex --pr 1/);
  assert.match(r.out, /collab prompt join 1 --tool <name>/);
});

test("the dashboard sits on top of the description and the owner's text is untouched", () => {
  const body = s.fake.read().pulls["o/r#1"].body;
  assert.ok(body.startsWith("<!-- collab:dashboard:start seq="), body.slice(0, 80));
  assert.ok(body.endsWith(BODY), "human text kept byte for byte");
  assert.match(body, /<!-- collab:dashboard:end -->/);
});
