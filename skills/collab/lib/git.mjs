// Every git child process goes through git(): argument arrays, no shell, stable English output.

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { iso } from "./clock.mjs";
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

// ---------------------------------------------------------------------------
// Text blobs (plan sessions)

const OID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

function checkOid(oid) {
  if (typeof oid !== "string" || !OID_RE.test(oid)) throw new CollabError(EXIT.BUG, `not a git object id: "${oid}"`);
  return oid;
}

// One spelling for every text the plan store keeps: "\n" line ends, no BOM, exactly one final "\n".
export function normText(s) {
  let t = String(s ?? "");
  if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
  if (t === "") return "";
  t = t.replace(/\r\n?/g, "\n");
  // A loop, not /\n+$/: that regex is quadratic on a long run of newlines in untrusted text.
  let end = t.length;
  while (end > 0 && t[end - 1] === "\n") end--;
  return `${t.slice(0, end)}\n`;
}

// Writes normText(text) as a blob and returns its id. Standard input means no attributes or
// filters apply (--no-filters says so explicitly), so every clone gets the same id.
export function hashText(cwd, text) {
  return git(["hash-object", "-w", "--no-filters", "--stdin"], { cwd, input: normText(text) }).stdout.trim();
}

export function blobText(cwd, oid) {
  return git(["cat-file", "blob", checkOid(oid)], { cwd }).stdout;
}

// A unified diff of two blobs with 2 lines of context, starting at the first hunk ("" when equal).
export function diffBlobs(cwd, a, b) {
  checkOid(a);
  checkOid(b);
  if (a.toLowerCase() === b.toLowerCase()) return "";
  const r = git(["diff", "--no-color", "--no-ext-diff", "--no-textconv", "-U2", a, b], { cwd, allowFail: true });
  if (r.code > 1) throw new CollabError(EXIT.ENV, `git diff failed: ${r.stderr.trim().split(/\r?\n/)[0] || `exit ${r.code}`}`, { args: ["diff", a, b], ...r });
  const lines = r.stdout.split("\n");
  const hunk = lines.findIndex((l) => l.startsWith("@@"));
  if (hunk >= 0) return lines.slice(hunk).join("\n");
  // No hunk (for example "Binary files differ"): keep what git said, without the header.
  return lines.filter((l) => !/^(?:diff --git |index |--- |\+\+\+ )/.test(l)).join("\n");
}

const oneLine = (s) => String(s ?? "").replace(/[\r\n]+/g, " ");

// Three-way merge of three blobs. Exit 0 is clean, 1-127 counts the conflicts (text holds the
// markers), 129 means this git doesn't know --object-id (added in 2.43).
export function mergeText(cwd, { ours, base, theirs, labels = ["ours", "base", "theirs"] } = {}) {
  const [lo, lb, lt] = labels;
  const args = ["merge-file", "-p", "--diff3", "--object-id", "-L", oneLine(lo ?? "ours"), "-L", oneLine(lb ?? "base"), "-L", oneLine(lt ?? "theirs"), checkOid(ours), checkOid(base), checkOid(theirs)];
  const r = git(args, { cwd, allowFail: true });
  if (r.code === 129) {
    throw new CollabError(EXIT.ENV, "plan sessions need git 2.43 or newer", { args, ...r, version: gitVersion() });
  }
  if (r.code > 127 || r.code < 0) {
    throw new CollabError(EXIT.ENV, `git merge-file failed: ${r.stderr.trim().split(/\r?\n/)[0] || `exit ${r.code}`}`, { args, ...r });
  }
  return { clean: r.code === 0, text: normText(r.stdout), conflicts: r.code };
}

// A path inside the repo: relative, "/" separators, no empty, "." or ".." segments, no ".git".
function checkRepoPath(p) {
  const s = String(p ?? "");
  const segs = s.split("/");
  if (!s || s.includes("\\") || s.includes("\0") || /^[A-Za-z]:/.test(s) || segs.some((x) => x === "" || x === "." || x === ".." || x.toLowerCase() === ".git")) {
    throw new CollabError(EXIT.PRECONDITION, `"${s}" can't be a file path in the repo: use a relative path with / separators`);
  }
  return s;
}

// A commit on top of `base` whose tree is base's tree plus path := normText(text). It uses a
// temporary index, so the working tree, HEAD and the real index are never touched; nothing
// points at the commit until the caller pushes it.
export function commitFileOnto(cwd, { base, path, text, message, author } = {}) {
  const file = checkRepoPath(path);
  if (typeof base !== "string" || !base || base.startsWith("-")) throw new CollabError(EXIT.BUG, `not a commit: "${base}"`);
  if (!author?.name || !author?.email) throw new CollabError(EXIT.BUG, "commitFileOnto needs author = { name, email }");
  const baseSha = git(["rev-parse", "--verify", "--quiet", `${base}^{commit}`], { cwd, allowFail: true });
  if (baseSha.code !== 0) throw new CollabError(EXIT.PRECONDITION, `${base} is not a commit in this clone (fetch first)`, { base });
  const parent = baseSha.stdout.trim();
  const oid = hashText(cwd, text);
  const index = join(gitCommonDir(cwd), `collab-index-${process.pid}-${randomBytes(4).toString("hex")}`);
  const env = { GIT_INDEX_FILE: index };
  try {
    git(["read-tree", parent], { cwd, env });
    git(["update-index", "--add", "--cacheinfo", `100644,${oid},${file}`], { cwd, env });
    const tree = git(["write-tree"], { cwd, env }).stdout.trim();
    const when = iso();
    const who = {
      GIT_AUTHOR_NAME: author.name,
      GIT_AUTHOR_EMAIL: author.email,
      GIT_AUTHOR_DATE: when,
      GIT_COMMITTER_NAME: author.name,
      GIT_COMMITTER_EMAIL: author.email,
      GIT_COMMITTER_DATE: when,
    };
    const msg = String(message ?? "").endsWith("\n") ? String(message ?? "") : `${message ?? ""}\n`;
    return git(["commit-tree", tree, "-p", parent, "-F", "-"], { cwd, env: who, input: msg }).stdout.trim();
  } finally {
    rmSync(index, { force: true });
    rmSync(`${index}.lock`, { force: true });
  }
}

let versionCache;

// [major, minor, patch] of the git on PATH, or null when it can't be run or read.
export function gitVersion() {
  if (versionCache !== undefined) return versionCache;
  let v = null;
  try {
    const r = git(["--version"], { allowFail: true });
    const m = r.code === 0 ? /(\d+)\.(\d+)(?:\.(\d+))?/.exec(r.stdout) : null;
    v = m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null;
  } catch {
    v = null;
  }
  versionCache = v;
  return v;
}
