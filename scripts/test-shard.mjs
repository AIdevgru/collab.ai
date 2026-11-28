#!/usr/bin/env node
// Runs one CI shard of the test suite, with the test files split by how long each one takes.
//   node scripts/test-shard.mjs <i>/<n>          run shard i of n (CI's test step)
//   node scripts/test-shard.mjs --update [log…]  refresh scripts/test-times.json from CI job logs,
//                                                 or from stdin: gh run view <id> --log | node scripts/test-shard.mjs --update
//
// node's own --test-shard deals the sorted files out in turn, so where the slow ones land is luck.
// It put three of the slowest in shard 2, which took 11 minutes on Windows while shard 1 took 4.
// Here the files go slowest first, each to the shard with the least time so far, by the times last
// measured on this OS. A file with no time yet counts as the median file, so adding a test file
// needs no edit here; --update records its time once CI has run it.
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TIMES = fileURLToPath(new URL("test-times.json", import.meta.url));
const REPORTER = new URL("test-times-reporter.mjs", import.meta.url).href;
const OSES = ["linux", "win32"];
export const osKey = (platform = process.platform) => (platform === "win32" ? "win32" : "linux");

// The files npm test's glob ("tests/**/*.test.mjs") matches, as sorted repo-relative paths.
export function testFiles(root = ROOT) {
  return readdirSync(path.join(root, "tests"), { recursive: true })
    .map((f) => `tests/${String(f).split(path.sep).join("/")}`)
    .filter((f) => f.endsWith(".test.mjs"))
    .sort();
}

// Splits files into n shards: slowest first, each to the shard with the least time so far (the
// lower shard on a tie, sorted order between equal times), so every runner computes the same split.
export function assign(files, times, n) {
  const known = files.filter((f) => Object.hasOwn(times, f)).map((f) => times[f]).sort((a, b) => a - b);
  const median = known.length ? known[Math.floor(known.length / 2)] : 1;
  const cost = (f) => (Object.hasOwn(times, f) ? times[f] : median);
  const shards = Array.from({ length: n }, () => ({ files: [], ms: 0 }));
  for (const f of [...files].sort((a, b) => cost(b) - cost(a) || (a < b ? -1 : 1))) {
    const s = shards.reduce((least, x) => (x.ms < least.ms ? x : least));
    s.files.push(f);
    s.ms += cost(f);
  }
  return shards.map((s) => ({ files: s.files.sort(), ms: s.ms }));
}

// New times from job logs, for the files that exist. For each OS the logs cover, a file takes its
// slowest logged time (node 22 or 24); a file the logs miss, as from a cancelled shard, keeps its
// old time. An OS the logs don't cover keeps all its times.
export function mergeTimes(old, logText, files) {
  const found = Object.fromEntries(OSES.map((os) => [os, {}]));
  for (const m of logText.matchAll(/Test times on (\w+) \(ms\): (\{.*\})/g)) {
    const seen = found[osKey(m[1])];
    for (const [f, ms] of Object.entries(JSON.parse(m[2]))) seen[f] = Math.max(seen[f] ?? 0, ms);
  }
  const next = { _: old._ };
  for (const os of OSES) {
    const now = { ...(old[os] ?? {}), ...found[os] };
    next[os] = Object.fromEntries(files.filter((f) => Object.hasOwn(now, f)).map((f) => [f, now[f]]));
  }
  return next;
}

function run(i, n) {
  const os = osKey();
  const times = JSON.parse(readFileSync(TIMES, "utf8"))[os] ?? {};
  const shard = assign(testFiles(), times, n)[i - 1];
  console.log(`Shard ${i}/${n} on ${os}: ${shard.files.length} test files, about ${Math.round(shard.ms / 1000)} s by the last measured times.`);
  if (!shard.files.length) return 0;
  const r = spawnSync(process.execPath, [
    "--test",
    "--test-reporter=tap", "--test-reporter-destination=stdout",
    `--test-reporter=${REPORTER}`, "--test-reporter-destination=stdout",
    ...shard.files,
  ], { cwd: ROOT, stdio: "inherit" });
  return r.status ?? 1;
}

function update(logs) {
  const text = logs.length ? logs.map((f) => readFileSync(f, "utf8")).join("\n") : readFileSync(0, "utf8");
  if (!/Test times on \w+ \(ms\): \{/.test(text)) {
    console.error("no 'Test times on …' lines in the input: pass logs of a CI run that ran scripts/test-shard.mjs");
    return 2;
  }
  const files = testFiles();
  const next = mergeTimes(JSON.parse(readFileSync(TIMES, "utf8")), text, files);
  writeFileSync(TIMES, JSON.stringify(next, null, 2) + "\n");
  for (const os of OSES) {
    const split = assign(files, next[os], 3).map((s) => `${Math.round(s.ms / 1000)} s`).join(" / ");
    console.log(`${os}: ${Object.keys(next[os]).length} of ${files.length} files timed; 3 shards: ${split}`);
  }
  return 0;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const [arg, ...rest] = process.argv.slice(2);
  const m = /^(\d+)\/(\d+)$/.exec(arg ?? "");
  if (arg === "--update") process.exit(update(rest));
  if (!m || Number(m[1]) < 1 || Number(m[1]) > Number(m[2])) {
    console.error("usage: node scripts/test-shard.mjs <i>/<n> | --update [log…]");
    process.exit(2);
  }
  process.exit(run(Number(m[1]), Number(m[2])));
}
