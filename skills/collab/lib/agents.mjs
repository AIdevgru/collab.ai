// Opt-in launching of other agents (`collab invite`), stopping them (`collab stop`), and the
// machine check (`collab doctor`). Nothing here runs unless the owner asks for it.

import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CollabError, EXIT } from "./errors.mjs";
import { childEnv as cleanPath } from "./config.mjs";
import { gitVersion } from "./git.mjs";
import { aliveFile, newKey } from "./relay.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CLI = path.resolve(HERE, "..", "bin", "collab.mjs");
const TEMPLATE = path.resolve(HERE, "..", "templates", "join-prompt.md");

// An invited Claude can run the collab launcher (nothing else through node, since `node -e` would
// bypass every other rule), read git, and edit files. It can't push, commit, merge or call the
// GitHub API: collab does those.
export const launcherPath = (env = process.env) => path.join(collabHome(env), "bin", "collab.mjs").replace(/\\/g, "/");
export const claudeAllowed = (launcher) => [`Bash(node "${launcher}":*)`, "Bash(git status:*)", "Bash(git diff:*)", "Bash(git log:*)", "Read", "Edit", "Write", "Glob", "Grep"];
export const CLAUDE_DENIED = Object.freeze(["Bash(git push:*)", "Bash(git commit:*)", "Bash(gh pr merge:*)", "Bash(gh api:*)", "Bash(gh repo:*)"]);

// Agent markers from the inviting session must not leak into the invited one: anything under
// these prefixes goes (a session id, an IDE port, a session token), unless it is on the keep list.
const MARKERS = /^(CLAUDECODE|CLAUDE_CODE_|AI_AGENT|CODEX_|GEMINI_CLI|GROK_|COLLAB_AGENT|COLLAB_RELAY|COLLAB_RELAYED|COLLAB_INVITED_)/i;
// The user's own setup under those prefixes: how the agent signs in, which provider and shell it
// uses, where its config lives. Without these the invited agent can't start.
// Kept per tool: one vendor's credentials never go to another vendor's agent, or to the relay.
const KEEP = {
  claude: /^CLAUDE_CODE_(USE_\w+|OAUTH_TOKEN|SKIP_\w+_AUTH|API_KEY_HELPER_TTL_MS|CLIENT_(CERT|KEY)\w*|GIT_BASH_PATH|SHELL\w*|MAX_OUTPUT_TOKENS|SUBAGENT_MODEL|EFFORT_LEVEL|DISABLE_\w+|ENABLE_TELEMETRY)$/i,
  codex: /^CODEX_(HOME|API_KEY|CA_CERTIFICATE)$/i,
};
export const inherited = (name, tool) => !MARKERS.test(name) || Boolean(tool && KEEP[tool]?.test(name));

export const collabHome = (env = process.env) => env.COLLAB_HOME ?? path.join(homedir(), ".collab");
export const runsDir = (env) => path.join(collabHome(env), "runs");

export function startupPrompt({ url, number, tool, agent, task, review, launcher, template = readFileSync(TEMPLATE, "utf8") }) {
  let base = template.replaceAll("{{url}}", url).replaceAll("{{number}}", String(number)).replaceAll("{{tool}}", tool);
  // An invited Claude is only allowed to run the launcher by its absolute path.
  if (launcher) base = base.replaceAll('"$HOME/.collab/bin/collab.mjs"', `"${launcher}"`);
  const L = launcher ? `"${launcher}"` : '"$HOME/.collab/bin/collab.mjs"';
  const lines = [
    `The owner invited you to this collab. Your agent id is ${agent}: join with`,
    `    node ${L} join ${url} --tool ${tool} --agent ${agent}`,
    `and pass --agent ${agent} on every later call.`,
  ];
  if (task) lines.push(`After joining, claim ${task}: node ${L} claim ${task} --pr ${number} --agent ${agent}. Then follow \`collab next\`.`);
  if (review) lines.push(`After joining, review ${review}: node ${L} review-claim ${review} --pr ${number} --agent ${agent}. Then follow \`collab next\`.`);
  lines.push("You are running without a human watching. Stop when `collab next` says done, paused or closed, or when `collab wait` twice in a row finds nothing to do.");
  return `${base.trimEnd()}\n\n${lines.join("\n")}\n`;
}

// COLLAB_CLAUDE / COLLAB_CODEX may hold a JSON argv prefix (tests use a fake agent).
function binFor(tool, env) {
  const raw = env[`COLLAB_${tool.toUpperCase()}`];
  if (raw) {
    const v = JSON.parse(raw);
    if (!Array.isArray(v) || !v.length) throw new CollabError(EXIT.ENV, `COLLAB_${tool.toUpperCase()} must be a JSON array`);
    return v;
  }
  return [tool];
}

// Pure: exactly what `invite` spawns. The prompt always goes in on stdin, so nothing is quoted.
export function launchSpec(tool, { root, runDir, agent, model, env = process.env }) {
  const [cmd, ...pre] = binFor(tool, env);
  const childEnv = Object.fromEntries(Object.entries(cleanPath(env)).filter(([k]) => inherited(k, tool)));
  childEnv.COLLAB_AGENT = agent;
  if (tool === "claude") {
    return {
      cmd, cwd: root, env: childEnv, relay: false,
      args: [...pre, "-p", "--allowedTools", claudeAllowed(launcherPath(env)).join(","), "--disallowedTools", CLAUDE_DENIED.join(","), "--output-format", "stream-json", "--verbose", ...(model ? ["--model", model] : [])],
    };
  }
  if (tool === "codex") {
    // Codex's default sandbox can't write .git or reach credentials, so its collab calls go through
    // a relay pinned to this agent. Its writable root is .collab/, which holds the task worktrees.
    childEnv.COLLAB_RELAY = "1";
    const work = path.join(root, ".collab");
    return {
      cmd, cwd: work, env: childEnv, relay: true,
      args: [...pre, "exec", "-C", work, "-s", "workspace-write", ...(model ? ["-m", model] : []), "--json", "-o", path.join(runDir, "last.md"), "-"],
    };
  }
  throw new CollabError(EXIT.UNSUPPORTED, `collab invite supports claude and codex. For ${tool}, run \`collab prompt join <pr> --tool ${tool}\` and paste the output into it.`);
}

function spawnDetached(cmd, args, { cwd, env, stdinFile, logBase }) {
  const fds = [stdinFile ? openSync(stdinFile, "r") : "ignore", openSync(`${logBase}.out.log`, "a"), openSync(`${logBase}.err.log`, "a")];
  try {
    const child = spawn(cmd, args, { cwd, env, detached: true, stdio: fds, shell: false, windowsHide: true });
    child.on("error", () => {}); // reported through the missing pid below
    child.unref();
    return child;
  } finally {
    for (const fd of fds) if (typeof fd === "number") closeSync(fd);
  }
}

// Watches one invited agent. When its process exits, or at the timeout (after killing it), it runs
// collab stop for that run: the relay goes too, and any task leases the agent held are freed.
const WATCHDOG = `
const [pid, ms, cli, root, run, pr] = process.argv.slice(1);
const { spawnSync } = require("node:child_process");
const end = Date.now() + Number(ms);
const alive = () => { try { process.kill(Number(pid), 0); return true; } catch (e) { return e.code === "EPERM"; } };
const finish = (reason) => {
  if (reason === "timeout") {
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", pid, "/T", "/F"], { windowsHide: true });
    else { try { process.kill(-Number(pid), "SIGTERM"); } catch { try { process.kill(Number(pid), "SIGTERM"); } catch {} } }
  }
  spawnSync(process.execPath, [cli, "stop", "--run", run, "--pr", pr, "--reason", reason], { cwd: root, windowsHide: true, env: { ...process.env, COLLAB_FROM_WATCHDOG: "1" } });
  process.exit(0);
};
const tick = () => {
  if (!alive()) return finish("exited");
  if (Date.now() >= end) return finish("timeout");
  setTimeout(tick, Math.max(0, Math.min(5000, end - Date.now())));
};
setTimeout(tick, Math.min(5000, Number(ms)));
`;

export async function invite({ tool, root, repo, pr, url, agent, model, task, review, timeoutMs, env = process.env }) {
  const runDir = path.join(runsDir(env), agent);
  mkdirSync(runDir, { recursive: true });
  mkdirSync(path.join(root, ".collab"), { recursive: true });
  const spec = launchSpec(tool, { root, runDir, agent, model, env });
  const promptFile = path.join(runDir, "prompt.md");
  writeFileSync(promptFile, startupPrompt({ url, number: pr, tool, agent, task, review, launcher: tool === "claude" ? launcherPath(env) : undefined }));
  const run = { id: agent, tool, repo, pr, root, startedAt: new Date().toISOString(), deadline: new Date(Date.now() + timeoutMs).toISOString(), cmd: [spec.cmd, ...spec.args] };
  const sanitized = Object.fromEntries(Object.entries(env).filter(([k]) => inherited(k)));
  if (spec.relay) {
    // Only this agent and its relay hold the key, in their environments: the relay then runs
    // nothing another agent drops in the inbox.
    const key = newKey();
    spec.env.COLLAB_RELAY_KEY = key;
    const relay = spawnDetached(process.execPath, [CLI, "relay", "--agent", agent, "--timeout", `${Math.ceil(timeoutMs / 1000) + 60}s`], { cwd: root, env: { ...sanitized, COLLAB_RELAY_KEY: key }, logBase: path.join(runDir, "relay") });
    run.relayPid = relay.pid ?? null;
    // The agent's first collab call must find the relay up.
    const alive = aliveFile(root, agent);
    const until = Date.now() + 15_000;
    while (!existsSync(alive) && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
    if (!existsSync(alive)) {
      killTree(run.relayPid);
      throw new CollabError(EXIT.ENV, `the relay for ${agent} didn't start; see ${path.join(runDir, "relay.err.log")}`);
    }
  }
  const child = spawnDetached(spec.cmd, spec.args, { cwd: spec.cwd, env: spec.env, stdinFile: promptFile, logBase: path.join(runDir, "agent") });
  if (!child.pid) {
    if (run.relayPid) killTree(run.relayPid);
    throw new CollabError(EXIT.ENV, `could not start ${spec.cmd}. Is ${tool} installed and on PATH? Run \`collab doctor\`.`);
  }
  run.pid = child.pid;
  const dog = spawnDetached(process.execPath, ["-e", WATCHDOG, String(child.pid), String(timeoutMs), CLI, root, agent, String(pr)], { cwd: root, env: sanitized, logBase: path.join(runDir, "watchdog") });
  run.watchdogPid = dog.pid ?? null;
  writeFileSync(path.join(runDir, "run.json"), JSON.stringify(run, null, 2));
  return { ...run, runDir };
}

export function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

export function killTree(pid) {
  if (!pid || !isAlive(pid)) return false;
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
  else {
    try { process.kill(-pid, "SIGTERM"); } catch { try { process.kill(pid, "SIGTERM"); } catch { /* gone */ } }
  }
  return true;
}

export function listRuns(env = process.env) {
  const dir = runsDir(env);
  if (!existsSync(dir)) return [];
  const out = [];
  for (const id of readdirSync(dir)) {
    const f = path.join(dir, id, "run.json");
    try { out.push({ ...JSON.parse(readFileSync(f, "utf8")), file: f }); } catch { /* not a run */ }
  }
  return out;
}

// Kill one run's processes (agent, relay, and the watchdog unless it is the caller). Returns the pids killed.
export function killRun(run, reason = "stopped", { fromWatchdog = reason === "timeout" } = {}) {
  const killed = [run.pid, run.relayPid].filter((p) => killTree(p));
  if (!fromWatchdog) killTree(run.watchdogPid);
  return killed;
}

// Record that a run is over. Called last, so "stopped" also means its tasks were released.
export function markStopped(run, reason, killed = []) {
  const done = { ...run, stoppedAt: new Date().toISOString(), stopReason: reason, killed };
  delete done.file;
  writeFileSync(run.file, JSON.stringify(done, null, 2));
  return done;
}

export function stopRun(run, reason = "stopped") {
  return markStopped(run, reason, killRun(run, reason));
}

// ---------------------------------------------------------------- doctor

function probe(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8", shell: false, windowsHide: true, timeout: 20_000 });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim(), error: r.error };
}

export function codexModel(home = homedir()) {
  try {
    const toml = readFileSync(path.join(home, ".codex", "config.toml"), "utf8");
    return /^\s*model\s*=\s*"([^"]+)"/m.exec(toml)?.[1] ?? null;
  } catch { return null; }
}

// Returns [{ name, ok, detail, required }]. `required` failures make doctor exit 5.
export function doctorChecks({ env = process.env, home = homedir(), cwd = process.cwd(), gitProbe, ghLogin } = {}) {
  const checks = [];
  const add = (name, ok, detail, required = true) => checks.push({ name, ok: !!ok, detail, required });
  const major = Number(process.versions.node.split(".")[0]);
  add("Node 22 or newer", major >= 22, `node ${process.versions.node}`);
  const git = probe("git", ["--version"]);
  add("git", git.ok, git.ok ? git.out : "git not found on PATH");
  // Plan sessions merge with `git merge-file --object-id`, which git 2.43 added. PR collabs don't need it.
  const ver = gitVersion();
  const ver243 = !!ver && (ver[0] > 2 || (ver[0] === 2 && ver[1] >= 43));
  add("git 2.43+ (plan sessions)", ver243, ver ? (ver243 ? `git ${ver.join(".")}` : `git ${ver.join(".")}: collab plan needs 2.43 or newer`) : "git version unknown", false);
  let gh;
  try { gh = env.COLLAB_GH ? { ok: true, out: "COLLAB_GH override" } : probe("gh", ["--version"]); } catch { gh = { ok: false }; }
  add("GitHub CLI (gh)", gh.ok, gh.ok ? gh.out.split("\n")[0] : "gh not found; install it and run gh auth login");
  if (ghLogin) add("gh account", ghLogin.ok, ghLogin.detail);
  const launcher = path.join(collabHome(env), "bin", "collab.mjs");
  add("launcher ~/.collab/bin/collab.mjs", existsSync(launcher), existsSync(launcher) ? launcher : "missing: run node scripts/install.mjs");
  for (const [name, p, required] of [
    ["skill for Claude Code", path.join(home, ".claude", "skills", "collab", "SKILL.md"), true],
    ["skill for Codex", path.join(home, ".codex", "skills", "collab", "SKILL.md"), existsSync(path.join(home, ".codex"))],
    ["skill rules ~/.collab/skill", path.join(collabHome(env), "skill", "PROTOCOL.md"), true],
  ]) add(name, existsSync(p), existsSync(p) ? p : "missing: run node scripts/install.mjs", required);
  for (const tool of ["claude", "codex"]) {
    const [cmd, ...pre] = binFor(tool, env);
    const r = probe(cmd, [...pre, "--version"]);
    add(`${tool} CLI (for collab invite ${tool})`, r.ok, r.ok ? r.out.split("\n")[0] : `${tool} not found; invite ${tool} won't work`, false);
  }
  const model = codexModel(home);
  if (model) add("Codex default model", true, `${model}. If invite codex fails with "model is not supported", pass --model <name>.`, false);
  if (gitProbe) for (const c of gitProbe(cwd)) add(c.name, c.ok, c.detail, c.required ?? false);
  return checks;
}
