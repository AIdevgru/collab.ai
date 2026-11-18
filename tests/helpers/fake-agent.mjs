// Stands in for `claude` or `codex` when `collab invite` launches one (COLLAB_CLAUDE / COLLAB_CODEX).
// It records how it was started, optionally runs some collab commands like a real agent would,
// then idles until it is killed (or exits at once with FAKE_AGENT_EXIT=1).
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const prompt = readFileSync(0, "utf8");
const log = process.env.FAKE_AGENT_LOG;
const record = {
  argv: process.argv.slice(2), cwd: process.cwd(), prompt, pid: process.pid,
  env: Object.fromEntries(["COLLAB_AGENT", "COLLAB_RELAY", "CLAUDECODE", "CODEX_THREAD_ID"].map((k) => [k, process.env[k] ?? null])),
  results: [],
};
const save = () => writeFileSync(path.join(log, `${process.env.COLLAB_AGENT}.json`), JSON.stringify(record, null, 2));
save();
for (const raw of JSON.parse(process.env.FAKE_AGENT_ACTIONS ?? "[]")) {
  const argv = raw.map((a) => a.replaceAll("__ID__", process.env.COLLAB_AGENT));
  const r = spawnSync(process.execPath, [process.env.FAKE_COLLAB_CLI, ...argv], { encoding: "utf8", windowsHide: true });
  record.results.push({ argv, code: r.status, out: `${r.stdout}${r.stderr}` });
  save();
}
if (process.env.FAKE_AGENT_EXIT === "1") process.exit(0);
setTimeout(() => {}, 10 * 60_000);
