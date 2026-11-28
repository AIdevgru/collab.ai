// Who is running collab: which agent tool (if any), which gh login, and the pinned token.
// Env markers come from docs/spikes.md row 6.

import { randomInt } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CollabError, EXIT } from "./errors.mjs";
import { ghRaw } from "./github.mjs";
import { writeAtomic } from "./relay.mjs";

const TOOLS = ["claude", "codex", "gemini", "grok"];
const LOGIN_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const TOKEN_VARS = new Set(["GH_TOKEN", "GITHUB_TOKEN"]);

const set = (v) => v !== undefined && v !== null && v !== "";

export function detectTool(env = process.env) {
  if (set(env.CLAUDECODE)) return "claude";
  if (set(env.CODEX_THREAD_ID) || set(env.CODEX_SESSION_ID)) return "codex";
  if (set(env.GEMINI_CLI)) return "gemini";
  if (Object.keys(env).some((k) => k.toUpperCase().startsWith("GROK_") && set(env[k]))) return "grok";
  const agent = String(env.AI_AGENT ?? "").toLowerCase();
  return TOOLS.find((t) => agent.startsWith(t)) ?? null;
}

export function isAgentEnv(env = process.env) {
  return detectTool(env) !== null || set(env.COLLAB_AGENT) || set(env.COLLAB_RELAYED);
}

export function mintAgentId(tool) {
  const suffix = randomInt(36 ** 4).toString(36).padStart(4, "0");
  return `${tool || "other"}-${suffix}`;
}

// A copy of process.env without the variables that would override `gh auth token --user`.
function envWithoutTokens() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (TOKEN_VARS.has(k.toUpperCase())) delete env[k];
  return env;
}

// The pinned account's token, read without GH_TOKEN/GITHUB_TOKEN in the env so the stored
// credential is what comes back. The token is never logged or put in an error.
export function pinnedToken(login) {
  if (typeof login !== "string" || !LOGIN_RE.test(login)) {
    throw new CollabError(EXIT.ENV, `not a GitHub login: "${login}".`);
  }
  const r = ghRaw(["auth", "token", "--user", login], { env: envWithoutTokens() });
  const token = r.code === 0 ? r.stdout.trim() : "";
  if (!token) {
    throw new CollabError(
      EXIT.ENV,
      `gh has no token for "${login}". Run \`gh auth login\` and sign in as ${login} (it doesn't need to be the active account), then try again.`,
      { login },
    );
  }
  return token;
}

export function activeLogin() {
  const r = ghRaw(["api", "user", "--jq", ".login"], { env: envWithoutTokens() });
  const login = r.code === 0 ? r.stdout.trim() : "";
  if (!login) throw new CollabError(EXIT.ENV, "gh is not signed in to GitHub. Run `gh auth login`, then try again.");
  return login;
}

export function collabHome(env = process.env) {
  return set(env.COLLAB_HOME) ? env.COLLAB_HOME : join(homedir(), ".collab");
}

// Best effort: a sandbox may block the write, and the ledger is the record anyway.
// Returns true when the file was written. Never throws.
export function saveAgentFile(id, data) {
  try {
    if (typeof id !== "string" || !ID_RE.test(id)) return false;
    // The inbox cursor is saved here after most commands: writeAtomic retries a rename that
    // Windows refuses while another process has the file open, and leaves no temp file behind.
    writeAtomic(join(collabHome(), "agents", `${id}.json`), `${JSON.stringify(data ?? {}, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

// What saveAgentFile wrote for this id: {} when there is no file, null when there is one that
// can't be read right now (a caller that rewrites the file must not replace it with less).
export function loadAgentFile(id) {
  if (typeof id !== "string" || !ID_RE.test(id)) return {};
  let text;
  try {
    text = readFileSync(join(collabHome(), "agents", `${id}.json`), "utf8");
  } catch (e) {
    return e?.code === "ENOENT" ? {} : null;
  }
  try {
    const data = JSON.parse(text);
    return data && typeof data === "object" && !Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

// The same, with {} for a file that can't be read. For reading only.
export const readAgentFile = (id) => loadAgentFile(id) ?? {};

export function requireOwner(env = process.env) {
  if (isAgentEnv(env)) {
    throw new CollabError(EXIT.PRECONDITION, "owner-only command; run it in your own terminal", { tool: detectTool(env) });
  }
}
