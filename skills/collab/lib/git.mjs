// Every git child process goes through git(): argument arrays, no shell, stable English output.

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { CollabError, EXIT } from "./errors.mjs";

const MAX_BUFFER = 64 * 1024 * 1024;

// The credential helper reads GH_TOKEN, so the pinned account is used no matter
// which gh account is active. The empty helper first clears any configured ones.
const AUTH_ARGS = ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential"];

export function git(args, { cwd, env, input, allowFail = false, auth } = {}) {
  const fullArgs = auth ? [...AUTH_ARGS, ...args] : args;
  const childEnv = { ...process.env, ...env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" };
  if (auth?.token) childEnv.GH_TOKEN = auth.token;
  const r = spawnSync("git", fullArgs, {
    cwd,
    env: childEnv,
    input,
    shell: false,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: MAX_BUFFER,
  });
  if (r.error) {
    throw new CollabError(EXIT.ENV, `could not run git: ${r.error.message}`, { args, cwd });
  }
  const res = { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  if (res.code !== 0 && !allowFail) {
    const first = res.stderr.trim().split(/\r?\n/)[0] || `exit ${res.code}`;
    throw new CollabError(EXIT.ENV, `git ${args[0]} failed: ${first}`, { args, cwd, ...res });
  }
  return res;
}

const out = (args, cwd) => git(args, { cwd }).stdout.trim();

// Both return absolute paths with the platform's separators.
export function repoRoot(cwd) {
  return resolve(out(["rev-parse", "--path-format=absolute", "--show-toplevel"], cwd));
}

export function gitCommonDir(cwd) {
  return resolve(out(["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd));
}

// The branch checked out at cwd, or null when HEAD is detached.
export function currentBranch(cwd) {
  const r = git(["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd, allowFail: true });
  return r.code === 0 ? r.stdout.trim() : null;
}

// "owner/name" from a GitHub remote URL, or null when the URL isn't a GitHub repo.
export function parseGithubUrl(url) {
  const u = String(url ?? "").trim();
  const m =
    u.match(/^(?:https?|git):\/\/(?:[^@/]+@)?(?:www\.)?github\.com(?::\d+)?\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i) ||
    u.match(/^ssh:\/\/(?:[^@/]+@)?(?:ssh\.)?github\.com(?::\d+)?\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i) ||
    u.match(/^(?:[^@/:]+@)?github\.com:\/?([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  return m ? `${m[1]}/${m[2]}` : null;
}

export function originRepo(cwd) {
  const override = process.env.COLLAB_REPO?.trim();
  if (override) {
    if (!/^[^/\s]+\/[^/\s]+$/.test(override)) {
      throw new CollabError(EXIT.ENV, `COLLAB_REPO must look like owner/name, got "${override}"`);
    }
    return override;
  }
  const r = git(["remote", "get-url", "origin"], { cwd, allowFail: true });
  if (r.code !== 0) throw new CollabError(EXIT.ENV, "this clone has no origin remote", { stderr: r.stderr });
  const repo = parseGithubUrl(r.stdout);
  if (!repo) throw new CollabError(EXIT.ENV, `origin is not a GitHub repo: ${r.stdout.trim()}`);
  return repo;
}

const splitZ = (s) => s.split("\0").filter(Boolean);

export function lsFiles(cwd, ref) {
  return splitZ(git(["ls-tree", "-r", "-z", "--name-only", ref], { cwd }).stdout);
}

// The file's text at ref, or null when the ref or the path doesn't exist.
export function showFile(cwd, ref, path) {
  const r = git(["cat-file", "blob", `${ref}:${path}`], { cwd, allowFail: true });
  return r.code === 0 ? r.stdout : null;
}

export function changedFiles(cwd, baseRef, headRef) {
  // --no-renames: a moved file counts at both paths, so moving a file away is seen as changing it.
  return splitZ(git(["diff", "--name-only", "--no-renames", "-z", `${baseRef}...${headRef}`], { cwd }).stdout);
}

export function ensureExclude(cwd, pattern) {
  const rel = out(["rev-parse", "--git-path", "info/exclude"], cwd);
  const file = resolve(cwd ?? process.cwd(), rel);
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (text.split(/\r?\n/).some((line) => line.trim() === pattern)) return false;
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${text && !text.endsWith("\n") ? "\n" : ""}${pattern}\n`);
  return true;
}

const samePath = (a, b) => {
  const norm = (p) => {
    let r = resolve(p);
    try {
      r = realpathSync.native(r);
    } catch {
      // not on disk (a pruned worktree); compare the resolved path
    }
    return process.platform === "win32" ? r.toLowerCase() : r;
  };
  return norm(a) === norm(b);
};

function worktrees(cwd) {
  const list = [];
  let cur = null;
  for (const line of git(["worktree", "list", "--porcelain"], { cwd }).stdout.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) list.push((cur = { path: line.slice(9), branch: null }));
    else if (cur && line.startsWith("branch refs/heads/")) cur.branch = line.slice(18);
  }
  return list;
}

const hasRef = (cwd, ref) => git(["show-ref", "--verify", "--quiet", ref], { cwd, allowFail: true }).code === 0;

// Puts `branch` in a worktree at `path` without touching the main checkout's HEAD.
// "On origin" means refs/remotes/origin/<branch>, so fetch first.
export function addWorktree(cwd, path, branch, startPoint) {
  const target = resolve(cwd ?? process.cwd(), path);
  const all = worktrees(cwd);
  const here = all.find((w) => samePath(w.path, target));
  if (here) {
    if (here.branch === branch) return { path: target, branch, created: false };
    throw new CollabError(EXIT.PRECONDITION, `${target} is already a worktree for ${here.branch ?? "a detached HEAD"}, not ${branch}`);
  }
  const elsewhere = all.find((w) => w.branch === branch);
  if (elsewhere) {
    throw new CollabError(EXIT.PRECONDITION, `${branch} is already checked out in ${elsewhere.path}`);
  }
  if (hasRef(cwd, `refs/heads/${branch}`)) {
    git(["worktree", "add", target, branch], { cwd });
  } else if (hasRef(cwd, `refs/remotes/origin/${branch}`)) {
    git(["worktree", "add", "--track", "-b", branch, target, `origin/${branch}`], { cwd });
  } else {
    // --no-track: the task branch must not inherit the start point (the main PR branch) as upstream.
    git(["worktree", "add", "--no-track", "-b", branch, target, startPoint], { cwd });
  }
  return { path: target, branch, created: true };
}
