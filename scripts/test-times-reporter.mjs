// A node --test reporter for CI. After the run it prints one line with each test file's time, which
// `node scripts/test-shard.mjs --update` reads back from the job logs into scripts/test-times.json.
// A file's time is the sum of its top-level tests and suites. A private repo's runner has 2 cores, so
// node runs the files one at a time, and that sum is what the file adds to its shard.
import path from "node:path";

export default async function* testTimes(source) {
  const per = {};
  for await (const { type, data } of source) {
    if ((type !== "test:pass" && type !== "test:fail") || data.nesting !== 0 || !data.file) continue;
    const file = path.relative(process.cwd(), data.file).split(path.sep).join("/");
    per[file] = (per[file] ?? 0) + (data.details?.duration_ms ?? 0);
  }
  const rounded = Object.fromEntries(Object.entries(per).map(([f, ms]) => [f, Math.round(ms)]));
  yield `Test times on ${process.platform} (ms): ${JSON.stringify(rounded)}\n`;
}
