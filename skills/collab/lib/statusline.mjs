// Where the tests run, for Claude Code's status line: "(tests local)" or "(tests remote)" for the
// repo the session is in.
//
//   collab statusline [-- <another status line command…>]
//
// With a command after --, that command runs first with the same input (the JSON Claude Code
// sends), and the segment goes at the end of its last line. Fast and offline: it reads only this
// clone's git data (the ledgers collab caches under refs/collab-cache/, and git config), never
// GitHub, and it loads nothing else of collab. It never fails: whatever goes wrong, it prints what
// it has.

import { spawn, spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const GIT_TIMEOUT_MS = 3000;
const INNER_TIMEOUT_MS = 10_000;
// Claude Code writes its JSON and closes stdin at once; by hand, stdin may stay open.
const STDIN_TIMEOUT_MS = 1000;
// The newest cached ledgers read to find the one for this checkout's branch.
const MAX_LEDGERS = 20;

// A git call costs ~100 ms on Windows, and the status line redraws often: two calls at most, and
// refs and config are read from their files.
function git(args, cwd, input) {
  // With input, the output is a Buffer: cat-file counts sizes in bytes.
  const r = spawnSync("git", args, { cwd, input: input == null ? undefined : Buffer.from(input, "utf8"), encoding: input == null ? "utf8" : "buffer", windowsHide: true, timeout: GIT_TIMEOUT_MS });
  return r.status === 0 ? r.stdout : null;
}

const json = (text) => { try { return JSON.parse(text); } catch { return null; } };
const read = (file) => { try { return readFileSync(file, "utf8"); } catch { return null; } };

// Several blobs in one call: { "<rev>:<path>": text | null }.
function blobs(root, names) {
  const out = Object.fromEntries(names.map((n) => [n, null]));
  const buf = names.length ? git(["cat-file", "--batch"], root, names.join("\n") + "\n") : null;
  if (!buf) return out;
  let at = 0;
  for (const name of names) {
    const nl = buf.indexOf(10, at);
    if (nl < 0) break;
    const header = buf.subarray(at, nl).toString("utf8");
    at = nl + 1;
    const m = /^[0-9a-f]+ (\S+) (\d+)$/.exec(header);
    if (!m) continue; // "<name> missing": a header line and nothing else
    const size = Number(m[2]);
    if (m[1] === "blob") out[name] = buf.subarray(at, at + size).toString("utf8");
    at += size + 1; // a tree or another object has a body too
  }
  return out;
}

// The cached ledger ref of each PR (refs/collab-cache/<agent>/pr-<n>), the newest write first:
// several agents may cache the same PR, and the newest copy wins.
function cacheRefs(common) {
  const best = new Map();
  const base = path.join(common, "refs", "collab-cache");
  let agents = [];
  try { agents = readdirSync(base); } catch { /* none yet */ }
  for (const agent of agents) {
    let files = [];
    try { files = readdirSync(path.join(base, agent)); } catch { continue; }
    for (const f of files) {
      const n = /^pr-(\d+)$/.exec(f)?.[1];
      if (!n) continue;
      let t = 0;
      try { t = statSync(path.join(base, agent, f)).mtimeMs; } catch { continue; }
      if (!best.has(n) || best.get(n).t < t) best.set(n, { ref: `refs/collab-cache/${agent}/${f}`, t });
    }
  }
  for (const line of (read(path.join(common, "packed-refs")) ?? "").split(/\r?\n/)) {
    const m = /^[0-9a-f]{40,64} (refs\/collab-cache\/[^/\s]+\/pr-(\d+))$/.exec(line);
    if (m && !best.has(m[2])) best.set(m[2], { ref: m[1], t: 0 });
  }
  return [...best.entries()].sort((a, b) => b[1].t - a[1].t).map(([n, { ref }]) => ({ n, ref }));
}

// The [collab] section of the clone's git config: tests = local|ci (collab tests writes it with
// --local) and login = <the GitHub account this clone is pinned to>.
function cloneConfig(common) {
  const section = /^\s*\[collab\]\s*$([\s\S]*?)(?=^\s*\[|(?![\s\S]))/im.exec(read(path.join(common, "config")) ?? "")?.[1] ?? "";
  return {
    tests: /^\s*tests\s*=\s*"?(local|ci)"?\s*$/im.exec(section)?.[1] ?? null,
    login: /^\s*login\s*=\s*"?([\w-]+)"?\s*$/im.exec(section)?.[1] ?? null,
  };
}

// The mode a collab's ledger or a .collab.json says: "remote" for the tests on CI, else "local".
const modeOf = (config) => (config?.verify === "ci" && Array.isArray(config.ciWorkflows) && config.ciWorkflows.length ? "remote" : "local");

// "local" | "remote" for the clone at cwd, or null outside a git repo. In order:
// 1. the open collab this checkout works on (a task branch collab/pr-<n>/…, or the PR's head
//    branch), else the newest open collab in the clone, as last cached;
// 2. the owner's choice for new collabs in this clone (git config collab.tests);
// 3. .collab.json on origin's default branch; else local.
export function testsMode(cwd) {
  const top = git(["rev-parse", "--show-toplevel", "--abbrev-ref", "HEAD", "--git-common-dir"], cwd);
  if (!top) return null;
  const [root, branch = "", commonDir = ".git"] = top.trim().split(/\r?\n/);
  const common = path.resolve(cwd, commonDir);
  const fromBranch = /^collab\/pr-(\d+)\//.exec(branch)?.[1] ?? null;

  // A task branch names its PR; for any other branch, the newest cached ledgers are read to find
  // the PR whose head branch it is.
  const refs = cacheRefs(common);
  const mine = refs.findIndex((r) => r.n === fromBranch);
  const ledgers = mine >= 0 ? [refs[mine]] : refs.slice(0, MAX_LEDGERS);
  const originHead = /^ref:\s*refs\/remotes\/(origin\/\S+)/.exec(read(path.join(common, "refs", "remotes", "origin", "HEAD")) ?? "")?.[1] ?? "origin/main";
  const repoFile = `${originHead}:.collab.json`;
  const got = blobs(root, [...ledgers.map((r) => `${r.ref}:ledger.json`), repoFile]);

  // The clone caches every collab on the repo: with no branch to go by, only its own account's.
  const clone = cloneConfig(common);
  let newestOpen = null;
  for (const { n, ref } of ledgers) {
    const ledger = json(got[`${ref}:ledger.json`]);
    if (!ledger || ledger.phase === "closed") continue;
    if (n === fromBranch || (branch && ledger.pr?.headRef === branch)) return modeOf(ledger.config);
    if (!clone.login || ledger.pr?.ghLogin === clone.login) newestOpen ??= ledger;
  }
  if (newestOpen) return modeOf(newestOpen.config);
  if (clone.tests) return clone.tests === "ci" ? "remote" : "local";
  return modeOf(json(got[repoFile]));
}

export const segment = (mode) => (mode ? `(tests ${mode})` : "");

function readStdin() {
  if (process.stdin.isTTY) return Promise.resolve("");
  return new Promise((resolve) => {
    let text = "";
    const done = () => { clearTimeout(timer); process.stdin.destroy(); resolve(text); };
    const timer = setTimeout(done, STDIN_TIMEOUT_MS);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => { text += d; });
    process.stdin.on("end", done);
    process.stdin.on("error", done);
  });
}

// One argument for cmd.exe, quoted the way programs on Windows split their command line.
const winArg = (a) => (/^[\w\-.:\\/=@+,%]+$/.test(a) ? a : `"${a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`);

// The other status line's output, or what it printed before it failed or timed out.
function runInner(argv, input, env) {
  return new Promise((resolve) => {
    let out = "";
    let child;
    const opts = { env, windowsHide: true, stdio: ["pipe", "pipe", "ignore"] };
    try {
      // node runs directly. On Windows anything else goes through cmd.exe, as the status line
      // command would: npm's npx, and status lines installed with npm, are .cmd files.
      if (/^node(\.exe)?$/i.test(argv[0])) child = spawn(process.execPath, argv.slice(1), opts);
      else if (process.platform === "win32") child = spawn(argv.map(winArg).join(" "), { ...opts, shell: true });
      else child = spawn(argv[0], argv.slice(1), opts);
    } catch { resolve(""); return; }
    const timer = setTimeout(() => { child.kill(); child.stdout.destroy(); child.unref(); resolve(out); }, INNER_TIMEOUT_MS);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d) => { out += d; });
    child.on("error", () => { clearTimeout(timer); resolve(out); });
    child.on("close", () => { clearTimeout(timer); resolve(out); });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

export async function main(argv, io = {}) {
  const stdout = io.stdout ?? ((s) => process.stdout.write(s));
  const input = io.stdin ?? await readStdin();
  const sep = argv.indexOf("--");
  const inner = sep >= 0 ? argv.slice(sep + 1) : [];
  const info = json(input);
  const cwd = info?.workspace?.current_dir || info?.cwd || io.cwd || process.cwd();

  // The other status line runs while this one reads git.
  const pending = inner.length ? runInner(inner, input, io.env ?? process.env) : Promise.resolve("");
  let seg = "";
  try { seg = segment(testsMode(cwd)); } catch { /* the status line must still print */ }
  const out = String(await pending).replace(/\s+$/, "");
  const line = out && seg ? `${out} ${seg}` : out || seg;
  if (line) stdout(`${line}\n`);
  return 0;
}
