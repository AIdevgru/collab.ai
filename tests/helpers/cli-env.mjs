// End-to-end harness: a real bare remote, clones per agent, the fake gh wired to that remote,
// and a runner for the real CLI (bin/collab.mjs) with agent env vars stripped.

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeRepo, sh } from "./bare-remote.mjs";
import { makeFakeGh } from "./fake-gh-state.mjs";

const CLI = fileURLToPath(new URL("../../skills/collab/bin/collab.mjs", import.meta.url));
const AGENT_ENV = /^(CLAUDECODE|CLAUDE_CODE_|AI_AGENT|CODEX_|GEMINI_CLI|GROK_|COLLAB_)/;

export const REPO = "o/r";

export function setup({ pr = 1, body = "Owner notes.\n\n- [ ] add helpers\n\nHUMAN TEXT SENTINEL\n", headRef = "feat/x", verify = true, prState = {} } = {}) {
  const repo = makeRepo();
  const owner = repo.clone("owner");
  // Give the default branch a test command and a tiny library so collab verify has something to run.
  if (verify) {
    writeFileSync(path.join(owner, ".collab.json"), JSON.stringify({ verifyCmd: ["node", "--test"] }, null, 2));
    mkdirSync(path.join(owner, "test"), { recursive: true });
    writeFileSync(path.join(owner, "test", "ok.test.mjs"), "import { test } from 'node:test';\ntest('ok', () => {});\n");
    sh(["checkout", "-q", "main"], owner);
    sh(["add", "-A"], owner);
    sh(["commit", "-q", "-m", "collab config"], owner);
    sh(["push", "-q", "origin", "main"], owner);
    sh(["checkout", "-q", headRef], owner);
    sh(["merge", "-q", "--no-edit", "main"], owner);
    sh(["push", "-q", "origin", headRef], owner);
  }
  const headSha = sh(["rev-parse", `origin/${headRef}`], owner);
  const fake = makeFakeGh({
    user: "zwymer",
    tokens: { zwymer: "tok-z" },
    repos: { [REPO]: { defaultBranch: "main", allowSquash: true, allowMerge: true, private: true, protected: ["main"], collaborators: { zwymer: "admin", reader: "read" }, gitDir: repo.remote } },
    pulls: { [`${REPO}#${pr}`]: { title: "Add string helpers", body, state: "open", merged: false, draft: false, headRef, baseRef: "main", headSha, isCrossRepository: false, mergeable: "MERGEABLE", ci: "SUCCESS", checks: 2, additions: 10, deletions: 1, ...prState } },
    comments: { [`${REPO}#${pr}`]: [] },
  });
  const home = realpathSync.native(mkdtempSync(path.join(tmpdir(), "collab-home-")));
  const clones = { owner };

  function clone(name) {
    if (!clones[name]) clones[name] = repo.clone(name);
    return clones[name];
  }

  function run(name, argv, extraEnv = {}) {
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !AGENT_ENV.test(k)));
    Object.assign(env, fake.env, { COLLAB_REPO: REPO, COLLAB_HOME: home, GH_TOKEN: "", GITHUB_TOKEN: "" }, extraEnv);
    delete env.GH_TOKEN;
    delete env.GITHUB_TOKEN;
    const cwd = name.includes(path.sep) || path.isAbsolute(name) ? name : clone(name);
    const r = spawnSync(process.execPath, [CLI, ...argv], { cwd, env, encoding: "utf8", shell: false, windowsHide: true, timeout: 120_000 });
    return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  }

  // Same as run, but concurrent: resolves when the process exits.
  function runAsync(name, argv, extraEnv = {}) {
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !AGENT_ENV.test(k)));
    Object.assign(env, fake.env, { COLLAB_REPO: REPO, COLLAB_HOME: home }, extraEnv);
    delete env.GH_TOKEN;
    delete env.GITHUB_TOKEN;
    const cwd = path.isAbsolute(name) ? name : clone(name);
    let p;
    const done = new Promise((resolve) => {
      p = spawn(process.execPath, [CLI, ...argv], { cwd, env, shell: false, windowsHide: true });
      let stdout = "";
      let stderr = "";
      p.stdout.on("data", (d) => (stdout += d));
      p.stderr.on("data", (d) => (stderr += d));
      p.on("close", (code) => resolve({ code, stdout, stderr, out: stdout + stderr }));
    });
    done.child = p;
    return done;
  }

  // Claude joins and posts `tasks`; then each extra tool joins. Returns { claude, <tool>: id, ... }.
  function start(tasks, tools = ["codex"]) {
    const ids = {};
    const j = run("claude", ["join", String(pr), "--tool", "claude"]);
    if (j.code !== 0) throw new Error(j.out);
    ids.claude = idOf(j);
    const dir = path.join(clone("claude"), ".collab");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "plan.json"), JSON.stringify({ tasks }));
    const p = run("claude", ["plan", "--tasks", ".collab/plan.json", "--pr", String(pr), "--agent", ids.claude]);
    if (p.code !== 0) throw new Error(p.out);
    for (const t of tools) {
      const name = ids[t.split(":")[0]] ? t.replace(":", "") : t.split(":")[0];
      const r = run(name, ["join", String(pr), "--tool", t.split(":")[0]]);
      if (r.code !== 0) throw new Error(r.out);
      ids[name] = idOf(r);
    }
    return ids;
  }

  // Run a CLI command as agent `id` from clone `name` on this PR.
  const as = (name, id, argv, extraEnv) => run(name, [...argv, "--pr", String(pr), "--agent", id], extraEnv);

  const idOf = (r) => /You are (\S+) /.exec(r.out)?.[1];

  // Run and parse --json output (last JSON line).
  function json(name, argv, extraEnv) {
    const r = run(name, [...argv, "--json"], extraEnv);
    const line = r.stdout.trim().split(/\r?\n/).filter((l) => l.startsWith("{")).at(-1);
    return { ...r, data: line ? JSON.parse(line) : null };
  }

  function cleanup() {
    fake.cleanup();
    rmSync(home, { recursive: true, force: true });
    repo.cleanup();
  }

  return { repo, owner, fake, home, clone, run, runAsync, json, idOf, start, as, cleanup, pr, headRef };
}
