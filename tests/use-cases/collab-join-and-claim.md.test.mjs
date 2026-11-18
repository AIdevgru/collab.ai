// Use case: tests/use-cases/collab-join-and-claim.md
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { setup } from "../helpers/cli-env.mjs";
import { sh } from "../helpers/bare-remote.mjs";

let s;
let claude;
let codex;
before(() => {
  s = setup();
  claude = s.idOf(s.run("claude", ["join", "1", "--tool", "claude"]));
  const dir = path.join(s.clone("claude"), ".collab");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "plan.json"), JSON.stringify({ tasks: [
    { title: "Core", accept: ["a"], scope: ["src/a.mjs"], size: "S" },
    { title: "Docs", accept: ["b"], scope: ["docs/**"], size: "S" },
    { title: "Uses core", accept: ["c"], scope: ["src/c.mjs"], deps: ["T1"], size: "S" },
    { title: "Touches core too", accept: ["d"], scope: ["src/a.mjs", "src/d.mjs"], size: "S" },
  ] }));
  const r = s.run("claude", ["plan", "--tasks", ".collab/plan.json", "--pr", "1", "--agent", claude]);
  assert.equal(r.code, 0, r.out);
});
after(() => s.cleanup());

test("a second vendor joins with its own id and a best-effort agent note", () => {
  const r = s.run("codex", ["join", "1", "--tool", "codex"]);
  assert.equal(r.code, 0, r.out);
  codex = s.idOf(r);
  assert.match(codex, /^codex-[a-z0-9]{4}$/);
  assert.match(r.out, /vendor openai/);
  assert.ok(existsSync(path.join(s.home, "agents", `${codex}.json`)));
});

test("next says claim T1, and claim makes an in-repo worktree that git ignores", () => {
  const n = s.run("codex", ["next", "--pr", "1", "--agent", codex]);
  assert.match(n.out, /Next: claim T1/);
  const r = s.run("codex", ["claim", "T1", "--pr", "1", "--agent", codex]);
  assert.equal(r.code, 0, r.out);
  const wt = path.join(s.clone("codex"), ".collab", "wt", "pr1-t1");
  assert.ok(existsSync(wt), r.out);
  assert.equal(sh(["branch", "--show-current"], wt), "collab/pr-1/t1");
  const exclude = readFileSync(path.join(s.clone("codex"), ".git", "info", "exclude"), "utf8");
  assert.match(exclude, /^\.collab\/$/m);
  assert.equal(sh(["status", "--porcelain"], s.clone("codex")), "");
});

test("one task at a time, and dependencies must be done first", () => {
  const wip = s.run("codex", ["claim", "T2", "--pr", "1", "--agent", codex]);
  assert.equal(wip.code, 2, wip.out);
  const dep = s.run("claude", ["claim", "T3", "--pr", "1", "--agent", claude]);
  assert.equal(dep.code, 2, dep.out);
  assert.match(dep.out, /T1/);
});

test("a claim whose scope overlaps work in flight is refused unless --allow-overlap", () => {
  const r = s.run("claude", ["claim", "T4", "--pr", "1", "--agent", claude]);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /overlaps work in flight: T1/);
  assert.match(r.out, /src\/a\.mjs/);
  const ok = s.run("claude", ["claim", "T4", "--allow-overlap", "--pr", "1", "--agent", claude]);
  assert.equal(ok.code, 0, ok.out);
  // The accepted overlap is on record, and the dashboard warns while T4 is in flight.
  const t4 = JSON.parse(s.run("claude", ["status", "--json", "--pr", "1"]).stdout).tasks.T4;
  assert.equal(t4.overlap.length, 1);
  assert.match(t4.overlap[0], /^T1 \(codex-\w+\): src\/a\.mjs/);
  const board = s.run("claude", ["dashboard", "--print", "--pr", "1"]);
  assert.equal(board.code, 0, board.out);
  assert.match(board.stdout, /was claimed although its scope overlaps work in flight/);
});

test("next never offers a claim that claim would refuse for overlapping globs", () => {
  const ok = (r) => assert.equal(r.code, 0, r.out);
  const gemini = s.idOf(s.run("gemini", ["join", "1", "--tool", "gemini"]));
  const grok = s.idOf(s.run("grok", ["join", "1", "--tool", "grok"]));
  ok(s.run("gemini", ["cancel", "T2", "--reason", "not needed", "--pr", "1", "--agent", gemini]));
  ok(s.run("gemini", ["add", "--title", "Text fixtures", "--accept", "e", "--scope", "**/*.txt", "--size", "S", "--pr", "1", "--agent", gemini]));
  ok(s.run("gemini", ["add", "--title", "Rename x", "--accept", "f", "--scope", "src/x.*", "--size", "S", "--pr", "1", "--agent", gemini]));
  ok(s.run("gemini", ["claim", "T5", "--pr", "1", "--agent", gemini]));
  // T6 (src/x.*) and T5 (**/*.txt) are both globs; they meet only at src/x.txt, a file at the PR head.
  const n = s.run("grok", ["next", "--pr", "1", "--agent", grok]);
  assert.doesNotMatch(n.out, /claim T6/);
  const c = s.run("grok", ["claim", "T6", "--pr", "1", "--agent", grok]);
  assert.equal(c.code, 2, c.out);
  assert.match(c.out, /overlaps work in flight: T5/);
  assert.match(c.out, /src\/x\.txt/);
});

test("join outside a clone of the PR's repo exits 5", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "collab-notrepo-"));
  try {
    const r = s.run(dir, ["join", "1", "--tool", "codex"]);
    assert.equal(r.code, 5, r.out);
    assert.match(r.out, /clone/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cancelling a task frees the tasks that waited on it", () => {
  const tasks = () => JSON.parse(s.run("claude", ["status", "--json", "--pr", "1"]).stdout).tasks;
  assert.deepEqual(tasks().T3.deps, ["T1"]);
  const c = s.run("codex", ["cancel", "T1", "--reason", "not needed after all", "--pr", "1", "--agent", codex]);
  assert.equal(c.code, 0, c.out);
  assert.deepEqual(tasks().T3.deps, ["T1"], "the plan is left as written");
  const r = s.run("codex", ["claim", "T3", "--pr", "1", "--agent", codex]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Note: T1 was cancelled, so T3 no longer waits on it/);
  // T1 is no longer in flight, so the dashboard stops warning about T4's overlap with it.
  const board = s.run("claude", ["dashboard", "--print", "--pr", "1"]);
  assert.equal(board.code, 0, board.out);
  assert.doesNotMatch(board.stdout, /was claimed although its scope overlaps work in flight/);
});
