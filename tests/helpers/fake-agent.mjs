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
  env: Object.fromEntries(["COLLAB_AGENT", "COLLAB_RELAY", "CLAUDECODE", "CODEX_THREAD_ID", "CLAUDE_CODE_OAUTH_TOKEN"].map((k) => [k, process.env[k] ?? null])),
  results: [],
};
const save = () => writeFileSync(path.join(log, `${process.env.COLLAB_AGENT}.json`), JSON.stringify(record, null, 2));
save();
// The task its startup prompt gives it (collab invite --task, or a session keeper), as __TASK__, and
// "--steal" as __STEAL__ when it is told to take the task over, and the task it is told to review
// as __REVIEW__. An action that names __TASK__ or __REVIEW__ is skipped when the prompt gives none;
// an empty __STEAL__ is dropped.
const given = /After joining, (?:claim|take over) (T\d+)/.exec(prompt)?.[1] ?? null;
const steal = new RegExp(`claim ${given} --steal`).test(prompt) ? "--steal" : "";
const toReview = /After joining, review (T\d+)/.exec(prompt)?.[1] ?? null;
for (const raw of JSON.parse(process.env.FAKE_AGENT_ACTIONS ?? "[]")) {
  if ((!given && raw.includes("__TASK__")) || (!toReview && raw.includes("__REVIEW__"))) continue;
  const argv = raw.map((a) => a.replaceAll("__ID__", process.env.COLLAB_AGENT).replaceAll("__TASK__", given ?? "").replaceAll("__STEAL__", steal).replaceAll("__REVIEW__", toReview ?? "")).filter((a) => a !== "");
  const r = spawnSync(process.execPath, [process.env.FAKE_COLLAB_CLI, ...argv], { encoding: "utf8", windowsHide: true });
  record.results.push({ argv, code: r.status, out: `${r.stdout}${r.stderr}` });
  save();
}
if (process.env.FAKE_AGENT_EXIT === "1") process.exit(0);
setTimeout(() => {}, 10 * 60_000);
