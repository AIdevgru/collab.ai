// Use case: tests/use-cases/collab-ci-tiers.md
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { assign, mergeTimes, testFiles } from "../../scripts/test-shard.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CI = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const PKG = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
const TIMES = JSON.parse(readFileSync(new URL("../../scripts/test-times.json", import.meta.url), "utf8"));
const REPORTER = new URL("../../scripts/test-times-reporter.mjs", import.meta.url).href;

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

function shardCount() {
  const list = /^\s+shard: \[([\d,\s]+)\]$/m.exec(CI)?.[1];
  assert.ok(list, "a shard list");
  const shards = list.split(",").map((s) => Number(s.trim()));
  assert.deepEqual(shards, Array.from({ length: shards.length }, (_, i) => i + 1), "shards are 1..n");
  return shards.length;
}

test("the shard count agrees in the job name, the shard list and the shard script's argument", () => {
  const n = shardCount();
  assert.match(CI, new RegExp(`^    name: test \\(.*shard \\$\\{\\{ matrix\\.shard \\}\\}/${n}\\)$`, "m"));
  assert.match(CI, new RegExp(`^      - run: node scripts/test-shard\\.mjs \\$\\{\\{ matrix\\.shard \\}\\}/${n}$`, "m"));
  assert.doesNotMatch(CI, /^\s+- run: .*--test-shard/m, "node's own sharding deals files out in turn, not by time");
});

test("every test file npm test runs is in exactly one shard, on each OS", () => {
  // testFiles walks tests/ for *.test.mjs: the files npm test's glob matches.
  assert.equal(PKG.scripts.test, 'node --test "tests/**/*.test.mjs"');
  const files = testFiles();
  assert.ok(files.length > 30, `found ${files.length} test files`);
  assert.ok(files.includes("tests/use-cases/collab-ci-tiers.md.test.mjs"));
  const n = shardCount();
  for (const os of ["linux", "win32"]) {
    const placed = assign(files, TIMES[os], n).flatMap((s) => s.files);
    assert.deepEqual([...placed].sort(), files, `${os}: each file once`);
  }
});

test("the recorded times split the suite evenly, and a new file counts as the median one", () => {
  const files = testFiles();
  const n = shardCount();
  for (const os of ["linux", "win32"]) {
    const times = TIMES[os];
    const timed = files.filter((f) => Object.hasOwn(times, f));
    assert.ok(timed.length >= files.length * 0.8, `${os}: ${timed.length} of ${files.length} files have a time; run --update`);
    const shards = assign(files, times, n);
    const total = shards.reduce((a, s) => a + s.ms, 0);
    const slowest = Math.max(...shards.map((s) => s.ms));
    const biggest = Math.max(...files.map((f) => times[f] ?? 0));
    // Round-robin by name gave 220 / 619 / 338 s on Windows; by time it is within a few percent.
    assert.ok(slowest <= Math.max(1.1 * total / n, biggest), `${os}: shards ${shards.map((s) => Math.round(s.ms / 1000)).join(" / ")} s`);
  }
  // A file with no time yet takes the median of the others, and the split stays the same everywhere.
  const times = { "a.test.mjs": 100, "b.test.mjs": 10, "c.test.mjs": 1 };
  const withNew = assign(["a.test.mjs", "b.test.mjs", "c.test.mjs", "new.test.mjs"], times, 2);
  assert.deepEqual(withNew, [{ files: ["a.test.mjs"], ms: 100 }, { files: ["b.test.mjs", "c.test.mjs", "new.test.mjs"], ms: 21 }]);
  assert.deepEqual(assign(["x.test.mjs", "y.test.mjs"], {}, 3).map((s) => s.files.length), [1, 1, 0]);
});

test("CI logs each file's time, and --update reads it back into test-times.json", () => {
  // The reporter, on two small test files. NODE_TEST_CONTEXT would make the inner node --test report
  // to this run instead of to its reporter.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, ["--test", `--test-reporter=${REPORTER}`, "tests/unit/glob.test.mjs", "tests/unit/identity.test.mjs"],
    { cwd: ROOT, encoding: "utf8", env });
  assert.equal(r.status, 0, r.stderr);
  const line = new RegExp(`^Test times on ${process.platform} \\(ms\\): (\\{.*\\})$`, "m").exec(r.stdout);
  assert.ok(line, r.stdout);
  assert.deepEqual(Object.keys(JSON.parse(line[1])).sort(), ["tests/unit/glob.test.mjs", "tests/unit/identity.test.mjs"]);
  // Logs as `gh run view --log` prints them: job, step, timestamp, then the line.
  const log = [
    "test (ubuntu-latest, node 22, shard 1/3)\tRun node scripts/test-shard.mjs 1/3\t2026-11-28T00:03:11Z Test times on linux (ms): {\"tests/a.test.mjs\":500,\"tests/gone.test.mjs\":9}",
    "test (ubuntu-latest, node 24, shard 1/3)\tRun node scripts/test-shard.mjs 1/3\t2026-11-28T00:03:12Z Test times on linux (ms): {\"tests/a.test.mjs\":700}",
  ].join("\n");
  const old = { _: "note", linux: { "tests/a.test.mjs": 1, "tests/b.test.mjs": 40 }, win32: { "tests/a.test.mjs": 3000 } };
  assert.deepEqual(mergeTimes(old, log, ["tests/a.test.mjs", "tests/b.test.mjs"]), {
    _: "note",
    linux: { "tests/a.test.mjs": 700, "tests/b.test.mjs": 40 }, // slowest node; b missed by the logs keeps its time; gone is dropped
    win32: { "tests/a.test.mjs": 3000 }, // no Windows jobs in these logs
  });
  // The script refuses input without such lines, and a shard outside 1..n.
  const none = spawnSync(process.execPath, ["scripts/test-shard.mjs", "--update"], { cwd: ROOT, input: "no times here\n", encoding: "utf8" });
  assert.equal(none.status, 2);
  assert.match(none.stderr, /no 'Test times on …' lines/);
  assert.equal(spawnSync(process.execPath, ["scripts/test-shard.mjs", "4/3"], { cwd: ROOT, encoding: "utf8" }).status, 2);
});

test("the oldest node CI tests is the one engines names", () => {
  const nodes = /^\s+node: \[([\d,\s]+)\]$/m.exec(CI)?.[1].split(",").map((s) => Number(s.trim()));
  assert.ok(nodes?.length, "a node list");
  assert.equal(Math.min(...nodes), Number(/>=\s*(\d+)/.exec(PKG.engines.node)?.[1]), "lowest node in the matrix = engines minimum");
});
