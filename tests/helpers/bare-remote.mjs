// A throwaway bare "origin" plus clones of it, all under os.tmpdir().
// The first clone seeds main (README.md) and feat/x (one more commit adding src/x.txt).

import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function sh(args, cwd) {
  const r = spawnSync("git", args, {
    cwd,
    shell: false,
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed (${r.status}): ${r.stderr || r.error?.message}`);
  return r.stdout.trim();
}

export function makeRepo() {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "collab-test-")));
  const remote = join(dir, "remote.git");
  sh(["init", "--quiet", "--bare", "--initial-branch=main", remote]);
  // No background gc: it can hold files open on Windows and break cleanup.
  sh(["config", "receive.autogc", "false"], remote);
  sh(["config", "gc.auto", "0"], remote);
  let seeded = false;

  function clone(name) {
    const path = join(dir, name);
    // Set at clone time: a global core.autocrlf=true (as on GitHub's Windows runners) would otherwise
    // check files out with CRLF before the per-repo setting below applies.
    sh(["clone", "--quiet", "-c", "core.autocrlf=false", remote, path]);
    for (const [k, v] of [
      ["user.name", name],
      ["user.email", `${name}@example.test`],
      ["core.autocrlf", "false"],
      ["commit.gpgsign", "false"],
      ["gc.auto", "0"],
      ["maintenance.auto", "false"],
    ]) {
      sh(["config", k, v], path);
    }
    if (!seeded) {
      sh(["symbolic-ref", "HEAD", "refs/heads/main"], path);
      writeFileSync(join(path, "README.md"), "# test repo\n");
      sh(["add", "README.md"], path);
      sh(["commit", "--quiet", "-m", "initial commit"], path);
      sh(["push", "--quiet", "-u", "origin", "main"], path);
      sh(["checkout", "--quiet", "-b", "feat/x"], path);
      mkdirSync(join(path, "src"), { recursive: true });
      writeFileSync(join(path, "src", "x.txt"), "x\n");
      sh(["add", "src/x.txt"], path);
      sh(["commit", "--quiet", "-m", "add x"], path);
      sh(["push", "--quiet", "-u", "origin", "feat/x"], path);
      sh(["checkout", "--quiet", "main"], path);
      seeded = true;
    }
    return path;
  }

  function cleanup() {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }

  return { dir, remote, clone, cleanup };
}
