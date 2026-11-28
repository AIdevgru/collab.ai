// Use case: tests/use-cases/collab-ci-tiers.md
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const CI = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const PKG = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));

// The os line is fromJSON((<condition>) && '<full list>' || '<fast list>'). The condition uses only
// ==, && and ||, which mean the same in a GitHub expression as in JavaScript for these values.
function osTiers() {
  const line = /^\s+os: \$\{\{ (.+) \}\}$/m.exec(CI)?.[1];
  assert.ok(line, "the os matrix is one expression");
  const m = /^fromJSON\(\((.+)\) && '(\[[^']*\])' \|\| '(\[[^']*\])'\)$/.exec(line);
  assert.ok(m, `the os expression has the form fromJSON((cond) && '[…]' || '[…]'): ${line}`);
  const [, cond, full, fast] = m;
  assert.match(cond, /^[\w.\s'=&|]+$/, "the condition holds only contexts, quoted strings, == , && and ||");
  const runs = (github, inputs = {}) => Function("github", "inputs", `return Boolean(${cond});`)(github, inputs);
  return { runs, full: JSON.parse(full), fast: JSON.parse(fast) };
}

const ctx = (event_name, base_ref = "") => ({ event_name, base_ref, event: { repository: { default_branch: "main" } } });

test("CI runs on pushes to main, on every PR, and on a dispatch with a 'full' switch", () => {
  assert.match(CI, /^on:\n  push:\n    branches: \[main\]\n  pull_request:\n/m);
  assert.match(CI, /^  workflow_dispatch:\n    inputs:\n      full:\n[\s\S]*?type: boolean\n\s+default: false\n/m);
});

test("Windows runs only where a change is about to reach the default branch", () => {
  const { runs, full, fast } = osTiers();
  assert.deepEqual(full, ["ubuntu-latest", "windows-latest"]);
  assert.deepEqual(fast, ["ubuntu-latest"]);
  assert.equal(runs(ctx("push")), true, "a push to main");
  assert.equal(runs(ctx("pull_request", "main")), true, "a PR into main");
  assert.equal(runs(ctx("pull_request", "feat/clamp-sum-mean")), false, "a collab sub-PR into its PR branch");
  assert.equal(runs(ctx("workflow_dispatch"), { full: false }), false, "a collab verify dispatch");
  assert.equal(runs(ctx("workflow_dispatch")), false, "a dispatch without inputs");
  assert.equal(runs(ctx("workflow_dispatch"), { full: true }), true, "a dispatch with full checked");
});

test("the shard count agrees in the job name, the shard list and --test-shard", () => {
  const list = /^\s+shard: \[([\d,\s]+)\]$/m.exec(CI)?.[1];
  assert.ok(list, "a shard list");
  const shards = list.split(",").map((s) => Number(s.trim()));
  const n = shards.length;
  assert.deepEqual(shards, Array.from({ length: n }, (_, i) => i + 1), "shards are 1..n");
  assert.match(CI, new RegExp(`^    name: test \\(.*shard \\$\\{\\{ matrix\\.shard \\}\\}/${n}\\)$`, "m"));
  assert.match(CI, new RegExp(`--test-shard=\\$\\{\\{ matrix\\.shard \\}\\}/${n} `));
});

test("CI runs npm test's command, and the oldest node it tests is the one engines names", () => {
  const cmd = PKG.scripts.test;
  assert.match(cmd, /^node --test /, "package.json's test script runs node --test");
  const pattern = cmd.slice("node --test ".length);
  const step = /^\s+- run: (node --test .*)$/m.exec(CI)?.[1];
  assert.ok(step, "a node --test step");
  assert.equal(step, `node --test --test-shard=\${{ matrix.shard }}/${/^\s+shard: \[([\d,\s]+)\]$/m.exec(CI)[1].split(",").length} ${pattern}`);
  const nodes = /^\s+node: \[([\d,\s]+)\]$/m.exec(CI)?.[1].split(",").map((s) => Number(s.trim()));
  assert.ok(nodes?.length, "a node list");
  assert.equal(Math.min(...nodes), Number(/>=\s*(\d+)/.exec(PKG.engines.node)?.[1]), "lowest node in the matrix = engines minimum");
});
