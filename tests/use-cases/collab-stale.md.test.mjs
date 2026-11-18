// Use case: tests/use-cases/collab-stale.md
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { setup } from "../helpers/cli-env.mjs";

let s;
let ids;
const base = Date.now();
const at = (min) => ({ COLLAB_NOW: new Date(base + min * 60_000).toISOString() });
const tasks = (env) => JSON.parse(s.as("claude", ids.claude, ["status", "--json"], env).stdout).tasks;
const ok = (r) => assert.equal(r.code, 0, r.out);

before(() => {
  s = setup();
  ids = s.start([
    { title: "Core", accept: ["works"], scope: ["src/core.mjs"], size: "S" },
    { title: "Uses core", accept: ["works"], scope: ["src/use.mjs"], deps: ["T1"], size: "S" },
  ], ["codex"]);
  // Claude claims T1 and pushes some work, then its session dies.
  ok(s.as("claude", ids.claude, ["claim", "T1"], at(1)));
  const wt = path.join(s.clone("claude"), ".collab", "wt", "pr1-t1");
  mkdirSync(path.join(wt, "src"), { recursive: true });
  writeFileSync(path.join(wt, "src", "core.mjs"), "export const core = 1; // by claude\n");
  ok(s.as("claude", ids.claude, ["push", "T1"], at(2)));
});
after(() => s.cleanup());

test("after the 90-minute lease runs out, next offers the task to another agent", () => {
  const live = s.as("codex", ids.codex, ["next"], at(30));
  assert.match(live.out, /Next: wait/);
  const n = s.as("codex", ids.codex, ["next"], at(95));
  assert.match(n.out, /Next: reclaim T1/);
  assert.match(n.out, /--steal/);
});

test("a steal keeps the same branch and sub-PR and continues from the pushed work", () => {
  const before = tasks(at(95)).T1;
  const r = s.as("codex", ids.codex, ["claim", "T1", "--steal"], at(96));
  ok(r);
  assert.match(r.out, /taken over from a stale owner/);
  const t = tasks(at(96)).T1;
  assert.equal(t.owner, ids.codex);
  assert.equal(t.branch, before.branch);
  assert.equal(t.subPr, before.subPr);
  const wt = path.join(s.clone("codex"), ".collab", "wt", "pr1-t1");
  assert.ok(existsSync(path.join(wt, "src", "core.mjs")), "the new owner sees the old owner's commits");
  assert.match(readFileSync(path.join(wt, "src", "core.mjs"), "utf8"), /by claude/);
});

test("the old owner coming back gets exit 2 instead of overwriting the task", () => {
  const r = s.as("claude", ids.claude, ["push", "T1"], at(97));
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, new RegExp(`T1 belongs to ${ids.codex}`));
});

test("a reviewer who vanishes loses the review when the review lease runs out", () => {
  ok(s.as("codex", ids.codex, ["submit", "T1"], at(98)));
  ok(s.as("claude", ids.claude, ["review-claim", "T1"], at(99)));
  assert.equal(tasks(at(100)).T1.reviewer, ids.claude);
  s.as("codex", ids.codex, ["next"], at(99 + 61));
  const t = tasks(at(99 + 61)).T1;
  assert.equal(t.status, "in_review");
  assert.equal(t.reviewer, null);
});

test("a planner that vanishes is replaced once its planning lease runs out", () => {
  const p = setup();
  try {
    const claude = p.idOf(p.run("claude", ["join", "1", "--tool", "claude"], at(0)));
    const codex = p.idOf(p.run("codex", ["join", "1", "--tool", "codex"], at(1)));
    const dir = path.join(p.clone("codex"), ".collab");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "plan.json"), JSON.stringify({ tasks: [
      { title: "Only task", accept: ["works"], scope: ["src/only.mjs"], deps: [], size: "S" },
      { title: "After it", accept: ["works"], scope: ["src/after.mjs"], deps: ["1"], size: "S" },
    ] }));
    const early = p.as("codex", codex, ["plan", "--tasks", ".collab/plan.json"], at(5));
    assert.equal(early.code, 2, early.out);
    assert.match(early.out, new RegExp(`${claude} holds the planner lease`));
    assert.match(p.as("codex", codex, ["next"], at(20)).out, /planner lease expired; take over/);
    const late = p.as("codex", codex, ["plan", "--tasks", ".collab/plan.json"], at(20));
    assert.equal(late.code, 0, late.out);
    const l = JSON.parse(p.as("codex", codex, ["status", "--json"], at(20)).stdout);
    assert.equal(l.phase, "active");
    assert.deepEqual(l.tasks.T2.deps, ["T1"], "a dependency written as \"1\" is stored as T1");
  } finally {
    p.cleanup();
  }
});
