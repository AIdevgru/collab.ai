// Use case: tests/use-cases/collab-races.md
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { setup } from "../helpers/cli-env.mjs";
import { sh } from "../helpers/bare-remote.mjs";

let s;
const ids = {};
before(() => { s = setup(); });
after(() => s.cleanup());

test("two agents joining a fresh PR at the same moment: exactly one planner", async () => {
  s.clone("claude");
  s.clone("codex");
  const [a, b] = await Promise.all([
    s.runAsync("claude", ["join", "1", "--tool", "claude"]),
    s.runAsync("codex", ["join", "1", "--tool", "codex"]),
  ]);
  assert.equal(a.code, 0, a.out);
  assert.equal(b.code, 0, b.out);
  ids.claude = s.idOf(a);
  ids.codex = s.idOf(b);
  const planners = [a, b].filter((r) => /You hold the planning lease/.test(r.out));
  assert.equal(planners.length, 1, `${a.out}\n---\n${b.out}`);
  const status = JSON.parse(s.run("claude", ["status", "--json", "--pr", "1"]).stdout);
  assert.deepEqual(Object.keys(status.agents).sort(), [ids.claude, ids.codex].sort());
  ids.planner = planners[0] === a ? "claude" : "codex";
});

test("four agents claim T1 at once: one wins, the rest get exit 2", async () => {
  const name = ids.planner;
  const dir = path.join(s.clone(name), ".collab");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "plan.json"), JSON.stringify({ tasks: [
    { title: "One", accept: ["a"], scope: ["src/one.mjs"], size: "S" },
    { title: "Two", accept: ["b"], scope: ["src/two.mjs"], size: "S" },
  ] }));
  const p = s.run(name, ["plan", "--tasks", ".collab/plan.json", "--pr", "1", "--agent", ids[name]]);
  assert.equal(p.code, 0, p.out);
  for (const tool of ["gemini", "grok"]) {
    const r = s.run(tool, ["join", "1", "--tool", tool]);
    assert.equal(r.code, 0, r.out);
    ids[tool] = s.idOf(r);
  }
  const names = ["claude", "codex", "gemini", "grok"];
  const results = await Promise.all(names.map((n) => s.runAsync(n, ["claim", "T1", "--pr", "1", "--agent", ids[n], "--no-dashboard"])));
  const winners = results.filter((r) => r.code === 0);
  assert.equal(winners.length, 1, results.map((r) => `[${r.code}] ${r.out}`).join("\n---\n"));
  for (const r of results.filter((x) => x.code !== 0)) {
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /claimed|belongs to/);
  }
  const status = JSON.parse(s.run("claude", ["status", "--json", "--pr", "1"]).stdout);
  const owner = names.find((n, i) => results[i].code === 0);
  assert.equal(status.tasks.T1.owner, ids[owner]);
});

test("the ledger's history stays a straight line", () => {
  const cwd = s.clone("claude");
  sh(["fetch", "-q", "origin", "+refs/collab/pr-1:refs/collab-check/pr-1"], cwd);
  const lines = sh(["rev-list", "--parents", "refs/collab-check/pr-1"], cwd).split("\n");
  assert.ok(lines.length >= 6, `${lines.length} ledger commits`);
  for (const l of lines) assert.ok(l.split(" ").length <= 2, `one parent at most: ${l}`);
  const status = JSON.parse(s.run("claude", ["status", "--json", "--pr", "1"]).stdout);
  assert.equal(status.seq, lines.length, "every write landed exactly once");
});
