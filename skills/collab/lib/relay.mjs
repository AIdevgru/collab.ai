// Relay: lets a sandboxed agent (Codex under workspace-write) use collab without git or gh access.
// The sandboxed client drops a request file; a relay running outside the sandbox runs the allowlisted
// collab command for it and drops the result. See docs/design.md "Sandboxed agents: relay".

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parseArgs } from "./args.mjs";
import { CollabError, EXIT } from "./errors.mjs";

export const RELAY_ALLOW = Object.freeze([
  "join", "context", "plan", "prompt", "next", "wait", "status", "claim", "push", "sync", "verify",
  "submit", "release", "review-claim", "review", "diff", "merge", "add", "cancel", "note", "block", "unblock", "dashboard",
]);
// `collab plan <sub>` (plan sessions) the relay runs. No subcommand is the PR planner's
// `collab plan --tasks`. Owner commands (close, remove, reopen) need the owner's own terminal.
export const RELAY_PLAN_ALLOW = Object.freeze([
  "list", "new", "join", "pull", "show", "edit", "say", "agree", "leave", "next", "wait", "status", "handoff",
]);
// Flags whose value is a file path the relay will read, so it must stay inside the repo.
const PATH_FLAGS = new Set(["--tasks", "--body-file", "--message-file"]);
const ALIVE_MS = 15_000;

export const relayDir = (repoRoot) => path.join(repoRoot, ".collab", "relay");

// A relay started by `collab invite` shares a key with the one agent it serves (both get it in
// their environment, never on disk). Requests are signed with it, so another agent on the machine
// can't drop a file in the inbox and have the relay act as that agent.
export const newKey = () => randomBytes(32).toString("hex");
export const sign = (key, req) => createHmac("sha256", String(key)).update(JSON.stringify([req.id ?? null, req.agent ?? null, req.cwd ?? null, req.argv ?? null])).digest("hex");
function signed(key, req) {
  if (typeof req?.mac !== "string" || typeof req.id !== "string") return false;
  const a = Buffer.from(req.mac);
  const b = Buffer.from(sign(key, req));
  return a.length === b.length && timingSafeEqual(a, b);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// On Windows, renaming over a file fails (EPERM, EACCES, EBUSY) while another process has it open,
// such as a virus scanner. Retry briefly; on failure remove the temp file and throw.
const BUSY = new Set(["EPERM", "EACCES", "EBUSY"]);
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function writeAtomic(file, data, { tries = 8, rename = renameSync } = {}) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
  writeFileSync(tmp, data);
  for (let i = 1; ; i++) {
    try {
      rename(tmp, file);
      return;
    } catch (e) {
      if (!BUSY.has(e.code) || i >= tries) {
        try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
        throw e;
      }
      pause(20 * i);
    }
  }
}

// True when this process cannot write git metadata: the signature of Codex's workspace-write sandbox.
export function isSandboxed(cwd, env = process.env) {
  if (env.COLLAB_RELAYED === "1") return false; // we are the relay's child: never loop
  if (env.COLLAB_RELAY === "1") return true;
  const r = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, encoding: "utf8", shell: false, windowsHide: true });
  if (r.status !== 0) return false; // not a repo: let the normal path report it
  const probe = path.join(r.stdout.trim(), `collab-probe-${process.pid}`);
  try {
    writeFileSync(probe, "");
    unlinkSync(probe);
    return false;
  } catch (e) {
    return e.code === "EPERM" || e.code === "EACCES" || e.code === "EROFS";
  }
}

// Each relay beats in its own file: alive-<agent> when pinned to one agent, alive when it serves
// any agent (the owner's own collab relay). Several relays can then serve one repo.
export function aliveFile(repoRoot, agent = null) {
  return path.join(relayDir(repoRoot), agent ? `alive-${String(agent).replace(/[^A-Za-z0-9-]/g, "_")}` : "alive");
}

// Is a relay up that will answer this agent: its own pinned relay, or one that serves anyone?
// Without an agent, any live relay counts.
export function relayAlive(repoRoot, { agent = null, nowMs = Date.now() } = {}) {
  const fresh = (file) => {
    try { return nowMs - statSync(file).mtimeMs < ALIVE_MS; } catch { return false; }
  };
  if (agent) return fresh(aliveFile(repoRoot, agent)) || fresh(aliveFile(repoRoot));
  let names = [];
  try { names = readdirSync(relayDir(repoRoot)).filter((n) => n === "alive" || n.startsWith("alive-")).filter((n) => !n.endsWith(".tmp")); } catch { /* no relay folder */ }
  return names.some((n) => fresh(path.join(relayDir(repoRoot), n)));
}

// Client: send argv to the relay and wait for its answer.
export async function request(repoRoot, { argv, agent, cwd = repoRoot, timeoutMs = 15 * 60_000, pollMs = 300, key = null }) {
  if (!relayAlive(repoRoot, { agent })) {
    throw new CollabError(EXIT.ENV,
      `Your sandbox blocks git and gh, and no collab relay is running for ${agent ? `${agent} in ` : ""}this repo. ` +
      "Ask the owner to run `collab relay` in a terminal in this repo (or start you with `collab invite codex`), then retry.");
  }
  const id = `${Date.now()}-${randomBytes(4).toString("hex")}`;
  const dir = relayDir(repoRoot);
  const rel = path.relative(longPath(repoRoot), longPath(cwd)) || ".";
  const req = { v: 1, id, argv, agent: agent ?? null, cwd: rel, at: new Date().toISOString() };
  if (key) req.mac = sign(key, req);
  writeAtomic(path.join(dir, "inbox", `${id}.json`), JSON.stringify(req));
  const out = path.join(dir, "outbox", `${id}.json`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(out)) {
      const res = JSON.parse(readFileSync(out, "utf8"));
      try { unlinkSync(out); } catch { /* the relay cleans up eventually */ }
      return res;
    }
    await sleep(pollMs);
  }
  throw new CollabError(EXIT.ENV, `The collab relay did not answer within ${Math.round(timeoutMs / 1000)}s.`);
}

// A path in its long, real form. Windows can name one folder two ways (an 8.3 short name such as
// RUNNER~1, or the long name), and git always reports the long one. A missing tail is kept as given.
export function longPath(p) {
  const abs = path.resolve(p);
  try {
    return realpathSync.native(abs);
  } catch {
    const parent = path.dirname(abs);
    return parent === abs ? abs : path.join(longPath(parent), path.basename(abs));
  }
}

export function inside(root, p) {
  const rel = path.relative(longPath(root), longPath(path.resolve(root, p)));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

// Relay: is this request one we will run?
export function validate(repoRoot, req, { fixedAgent = null, key = null, seen = null } = {}) {
  const bad = (message) => ({ ok: false, code: EXIT.PRECONDITION, message });
  if (!req || req.v !== 1 || !Array.isArray(req.argv) || req.argv.some((a) => typeof a !== "string")) return bad("malformed relay request");
  if (key) {
    if (!signed(key, req)) return bad("this relay only runs requests signed by the agent it was started for");
    if (seen?.has(req.id)) return bad("this relay request was already run");
    seen?.add(req.id);
  }
  const cmd = req.argv[0];
  if (!RELAY_ALLOW.includes(cmd)) return bad(`the relay does not run \`collab ${cmd ?? ""}\` (owner and setup commands need a real terminal)`);
  if (cmd === "plan") {
    // The same parser the CLI uses, so the relay and the CLI agree on which word is the subcommand.
    const sub = parseArgs(req.argv).pos[0];
    if (sub !== undefined && !RELAY_PLAN_ALLOW.includes(sub)) {
      return bad(`the relay does not run \`collab plan ${sub}\` (owner commands need the owner's own terminal)`);
    }
  }
  if (typeof req.cwd !== "string" || !inside(repoRoot, req.cwd)) return bad("relay request cwd is outside the repo");
  const cwdAbs = longPath(path.resolve(repoRoot, req.cwd));
  for (let i = 0; i < req.argv.length; i++) {
    const a = req.argv[i];
    const [flag, inline] = a.startsWith("--") && a.includes("=") ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a, null];
    if (PATH_FLAGS.has(flag)) {
      const v = inline ?? req.argv[i + 1];
      if (typeof v !== "string" || !inside(repoRoot, path.relative(repoRoot, path.resolve(cwdAbs, v)))) return bad(`${flag} must point inside the repo`);
    }
    if (flag === "--agent" && fixedAgent) {
      const v = inline ?? req.argv[i + 1];
      if (v !== fixedAgent) return bad(`this relay only acts for ${fixedAgent}`);
    }
  }
  if (fixedAgent && req.agent && req.agent !== fixedAgent) return bad(`this relay only acts for ${fixedAgent}`);
  return { ok: true, cwd: cwdAbs };
}

// Relay loop. runCollab(argv, { cwd, env }) -> { code, stdout, stderr } (sync or async).
export async function serve(repoRoot, { fixedAgent = null, key = null, runCollab, signal, pollMs = 500, beatMs = 5000, othersMs = OTHERS_MS, log = () => {} }) {
  const seen = new Set(); // ids of signed requests already run: a copied request file can't be replayed
  const dir = relayDir(repoRoot);
  for (const d of ["inbox", "outbox", "work"]) mkdirSync(path.join(dir, d), { recursive: true });
  const alive = aliveFile(repoRoot, fixedAgent);
  // The heartbeat runs on its own timer, so it keeps beating while a long command (verify, wait)
  // runs. runCollab must be asynchronous for that; a synchronous one blocks the timer.
  // A missed beat is logged, never fatal: a dead relay strands the agent that depends on it.
  const beat = () => {
    try { writeAtomic(alive, JSON.stringify({ pid: process.pid, fixedAgent, at: new Date().toISOString() })); } catch (e) { log(`heartbeat skipped: ${e.message}`); }
  };
  beat();
  const timer = setInterval(beat, beatMs);
  try {
    while (!signal?.aborted) {
      try {
        await servePending(repoRoot, dir, { fixedAgent, key, seen, runCollab, log, othersMs });
      } catch (e) {
        log(`relay error (continuing): ${e.message}`);
      }
      await sleep(pollMs);
    }
  } finally {
    clearInterval(timer);
    // Remove the heartbeat only if this relay wrote it (two unpinned relays would share one).
    try { if (JSON.parse(readFileSync(alive, "utf8")).pid === process.pid) rmSync(alive, { force: true }); } catch { /* ignore */ }
  }
}

// The agent a request acts for: its agent field, or its --agent flag.
function requestAgent(req) {
  if (req?.agent) return req.agent;
  const argv = Array.isArray(req?.argv) ? req.argv : [];
  const i = argv.indexOf("--agent");
  if (i >= 0) return argv[i + 1] ?? null;
  return argv.find((a) => typeof a === "string" && a.startsWith("--agent="))?.slice(8) ?? null;
}

// Two invited Codex agents in one repo share the inbox, each with a relay pinned to it. A pinned
// relay leaves another agent's request for that agent's relay, and refuses it only once it has
// waited this long unclaimed.
const OTHERS_MS = 20_000;

// Runs every request waiting in the inbox, in order, and writes each answer to the outbox.
async function servePending(repoRoot, dir, { fixedAgent, key = null, seen = null, runCollab, log, othersMs = OTHERS_MS }) {
  const files = readdirSync(path.join(dir, "inbox")).filter((f) => f.endsWith(".json")).sort();
  for (const f of files) {
    if (fixedAgent) {
      let peek = null;
      try { peek = JSON.parse(readFileSync(path.join(dir, "inbox", f), "utf8")); } catch { /* claim it and report it malformed */ }
      const who = requestAgent(peek);
      if (who && who !== fixedAgent && Date.now() - Date.parse(peek.at ?? 0) < othersMs) continue;
    }
    const claimed = path.join(dir, "work", f);
    try { renameSync(path.join(dir, "inbox", f), claimed); } catch { continue; } // another relay took it
    let req;
    try { req = JSON.parse(readFileSync(claimed, "utf8")); } catch { req = null; }
    const v = validate(repoRoot, req, { fixedAgent, key, seen });
    let res;
    if (!v.ok) {
      res = { code: v.code, stdout: "", stderr: `collab relay: ${v.message}
` };
    } else {
      const argv = [...req.argv];
      const agent = fixedAgent ?? req.agent;
      if (agent && !argv.includes("--agent") && !argv.some((x) => x.startsWith("--agent="))) argv.push("--agent", agent);
      const env = { ...process.env, COLLAB_RELAYED: "1", ...(agent ? { COLLAB_AGENT: agent } : {}) };
      delete env.COLLAB_RELAY;
      delete env.COLLAB_RELAY_KEY;
      try {
        res = await runCollab(argv, { cwd: v.cwd, env });
      } catch (e) {
        res = { code: EXIT.BUG, stdout: "", stderr: `collab relay: ${e.message}
` };
      }
      log(`${req.agent ?? "?"}: collab ${req.argv.join(" ")} -> ${res.code}`);
    }
    try {
      writeAtomic(path.join(dir, "outbox", f), JSON.stringify({ id: req?.id ?? f.replace(/.json$/, ""), ...res }));
    } catch (e) {
      log(`could not write the answer to ${f}: ${e.message}`);
    }
    try { rmSync(claimed, { force: true }); } catch { /* ignore */ }
  }
}
