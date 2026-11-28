import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, test } from "node:test";
import { segment, testsMode } from "../../skills/collab/lib/statusline.mjs";

const CLI = fileURLToPath(new URL("../../skills/collab/bin/collab.mjs", import.meta.url));
const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const g = (cwd, args, input) => {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8", input });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};
const CI = { verify: "ci", ciWorkflows: ["ci.yml"] };
const LOCAL = { verify: "local" };

// A clone whose default branch (origin/main) has this .collab.json.
function clone(repoConfig = CI) {
  const dir = mkdtempSync(path.join(tmpdir(), "collab-sl-"));
  dirs.push(dir);
  g(dir, ["init", "-q", "-b", "main"]);
  writeFileSync(path.join(dir, ".collab.json"), JSON.stringify(repoConfig));
  g(dir, ["add", "."]);
  g(dir, ["commit", "-qm", "init"]);
  g(dir, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  return dir;
}
// A cached ledger (refs/collab-cache/<agent>/pr-<n>), written `age` seconds ago; "tree" puts a
// folder where ledger.json should be.
let clock = Date.now() / 1000 - 10_000;
function cached(dir, n, ledger, agent = "claude-a1f3") {
  let tree;
  if (ledger === "tree") {
    const inner = g(dir, ["mktree"], `100644 blob ${g(dir, ["hash-object", "-w", "--stdin"], "x")}\tx\n`);
    tree = g(dir, ["mktree"], `040000 tree ${inner}\tledger.json\n`);
  } else {
    tree = g(dir, ["mktree"], `100644 blob ${g(dir, ["hash-object", "-w", "--stdin"], JSON.stringify(ledger))}\tledger.json\n`);
  }
  const ref = `refs/collab-cache/${agent}/pr-${n}`;
  g(dir, ["update-ref", ref, g(dir, ["commit-tree", tree, "-m", "ledger"])]);
  clock += 10;
  utimesSync(path.join(dir, ".git", ref), clock, clock);
}
const ledger = (n, config, headRef, ghLogin = "zwymer", phase = "working") => ({ schema: 2, phase, config, pr: { number: n, headRef, ghLogin } });

describe("statusline: which collab's setting it shows", () => {
  test("outside a repo nothing; with no collab, the default branch's .collab.json", () => {
    const none = mkdtempSync(path.join(tmpdir(), "collab-sl-none-"));
    dirs.push(none);
    assert.equal(testsMode(none), null);
    assert.equal(testsMode(clone(CI)), "remote");
    assert.equal(testsMode(clone(LOCAL)), "local");
    assert.equal(segment("remote"), "(tests remote)");
    assert.equal(segment(null), "");
  });
  test("a folder where a ledger should be doesn't throw off what comes after it", () => {
    const dir = clone(CI);
    cached(dir, 3, "tree");
    assert.equal(testsMode(dir), "remote", ".collab.json is read past the tree");
  });
  test("a task branch names its PR, however many collabs are newer", () => {
    const dir = clone(LOCAL);
    cached(dir, 7, ledger(7, CI, "feat/a"));
    for (let n = 10; n < 35; n++) cached(dir, n, ledger(n, LOCAL, `feat/${n}`));
    g(dir, ["checkout", "-q", "-b", "collab/pr-7/t1"]);
    assert.equal(testsMode(dir), "remote");
    g(dir, ["checkout", "-q", "-b", "feat/12"]);
    assert.equal(testsMode(dir), "local");
  });
  test("the PR's head branch picks its collab; any other branch, the newest of this clone's account", () => {
    const dir = clone(LOCAL);
    cached(dir, 7, ledger(7, CI, "feat/a"));
    cached(dir, 8, ledger(8, LOCAL, "feat/b", "someone-else"));
    cached(dir, 9, ledger(9, LOCAL, "feat/c", "zwymer", "closed"));
    g(dir, ["checkout", "-q", "-b", "feat/a"]);
    assert.equal(testsMode(dir), "remote");
    g(dir, ["checkout", "-q", "main"]);
    assert.equal(testsMode(dir), "local", "unpinned: the newest open collab, whoever's");
    g(dir, ["config", "collab.login", "zwymer"]);
    assert.equal(testsMode(dir), "remote", "pinned: this account's newest open collab");
    g(dir, ["config", "collab.login", "nobody"]);
    g(dir, ["config", "collab.tests", "ci"]);
    assert.equal(testsMode(dir), "remote", "none of this account's: the clone's choice");
  });
  test("from a worktree's subfolder too", () => {
    const dir = clone(LOCAL);
    cached(dir, 7, ledger(7, CI, "feat/a"));
    const wt = path.join(dir, ".collab", "wt", "pr7-t1");
    g(dir, ["worktree", "add", "-q", "-b", "collab/pr-7/t1", wt]);
    mkdirSync(path.join(wt, "src"), { recursive: true });
    assert.equal(testsMode(path.join(wt, "src")), "remote");
  });
});

describe("statusline: the command", () => {
  const input = (dir) => JSON.stringify({ session_id: "s", workspace: { current_dir: dir } });
  const USAGE = "let s = ''; process.stdin.on('data', (d) => (s += d)); process.stdin.on('end', () => console.log('usage ' + (JSON.parse(s).workspace ? 'ok' : 'no input')));\n";

  test("stdin left open: it gives up waiting after a second and still prints", async () => {
    const dir = clone(CI);
    const started = Date.now();
    const out = await new Promise((resolve) => {
      const child = spawn(process.execPath, [CLI, "statusline"], { cwd: dir, stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
      let text = "";
      child.stdout.on("data", (d) => { text += d; });
      child.on("close", () => { child.stdin.destroy(); resolve(text); });
    });
    assert.equal(out, "(tests remote)\n");
    assert.ok(Date.now() - started < 8000, `took ${Date.now() - started} ms`);
  });
  test("on Windows a wrapped .cmd (npm's npx, status lines installed with npm) runs through cmd.exe", { skip: process.platform !== "win32" }, () => {
    const dir = clone(CI);
    const bin = path.join(dir, ".bin dir");
    mkdirSync(bin);
    writeFileSync(path.join(bin, "usage.mjs"), USAGE);
    writeFileSync(path.join(bin, "fakeusage.cmd"), '@node "%~dp0usage.mjs" %*\r\n');
    const run = (args, env = process.env) => spawnSync(process.execPath, [CLI, "statusline", "--", ...args], { input: input(dir), encoding: "utf8", env, windowsHide: true }).stdout;
    assert.equal(run([path.join(bin, "fakeusage.cmd")]), "usage ok (tests remote)\n", "a path with a space");
    assert.equal(run(["fakeusage"], { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` }), "usage ok (tests remote)\n", "found on PATH, no extension");
    assert.equal(run(["no-such-command-xyz"]), "(tests remote)\n", "a command that doesn't exist leaves the segment");
  });
});
