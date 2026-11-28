// Use case: tests/use-cases/collab-tests-switch.md
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { setup } from "../helpers/cli-env.mjs";

const CLI = fileURLToPath(new URL("../../skills/collab/bin/collab.mjs", import.meta.url));
const CI_YML = "name: CI\non:\n  pull_request:\n    branches: [main]\n  workflow_dispatch:\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n";
const LINT_YML = "name: Lint\non:\n  pull_request:\njobs:\n  lint:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm run lint\n";
// Started only by hand, with the production secrets: not a workflow to run the agents' code on.
const DEPLOY_YML = "name: Deploy\non:\n  workflow_dispatch:\njobs:\n  deploy:\n    runs-on: ubuntu-latest\n    environment: production\n    steps:\n      - run: ./deploy.sh\n";
// The owner's own Claude Code session, where /collab tests runs.
const CLAUDE_SESSION = { CLAUDECODE: "1" };
// Stands in for the status line Zach already has.
const USAGE = "process.stdin.resume(); let s = ''; process.stdin.on('data', (d) => (s += d)); process.stdin.on('end', () => console.log('usage 20% ' + (JSON.parse(s).workspace ? 'ok' : 'no input')));\n";

let s;
let ids;
let usage;
let outside;
const C = () => ids.claude;
const X = () => ids.codex;
const ok = (r) => assert.equal(r.code, 0, r.out);
const git = (args, cwd, input) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8", input }).stdout.trim();
const ledgerConfig = () => JSON.parse(s.as("claude", C(), ["status", "--json"]).stdout).config;
const tasks = () => JSON.parse(s.as("claude", C(), ["status", "--json"]).stdout).tasks;
const notes = (text) => {
  const dir = path.join(s.clone("claude"), ".collab");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "notes.md"), text);
  return ".collab/notes.md";
};
// Another person's collab on the same repo (PR #6, their GitHub account).
const theirs = () => {
  const owner = s.clone("owner");
  git(["fetch", "-q", "origin", "refs/collab/pr-6"], owner);
  return JSON.parse(git(["show", "FETCH_HEAD:ledger.json"], owner));
};
function theirCollab() {
  const owner = s.clone("owner");
  git(["fetch", "-q", "origin", "refs/collab/pr-1"], owner);
  const l = JSON.parse(git(["show", "FETCH_HEAD:ledger.json"], owner));
  l.pr = { ...l.pr, number: 6, url: "https://github.com/o/r/pull/6", headRef: "feat/theirs", ghLogin: "someone-else" };
  const blob = git(["hash-object", "-w", "--stdin"], owner, JSON.stringify(l));
  const tree = git(["mktree"], owner, `100644 blob ${blob}\tledger.json\n`);
  git(["push", "-q", "origin", `${git(["commit-tree", tree, "-m", "their ledger"], owner)}:refs/collab/pr-6`], owner);
}
const runs = (branch) => (s.fake.read().repos["o/r"].runs ?? []).filter((r) => r.headBranch === branch);
const wt = (name, t) => path.join(s.clone(name), ".collab", "wt", `pr1-${t.toLowerCase()}`);
const write = (name, t, rel, text) => {
  const f = path.join(wt(name, t), rel);
  mkdirSync(path.dirname(f), { recursive: true });
  writeFileSync(f, text);
};
// Claude Code runs the status line with the session's folder in the JSON on stdin.
const statusline = (dir, inner = []) => {
  const r = spawnSync(process.execPath, [CLI, "statusline", ...(inner.length ? ["--", ...inner] : [])], {
    input: JSON.stringify({ session_id: "s", workspace: { current_dir: dir } }), encoding: "utf8", windowsHide: true, cwd: outside,
  });
  return { code: r.status, out: r.stdout };
};

before(() => {
  s = setup({
    files: { ".github/workflows/ci.yml": CI_YML, ".github/workflows/lint.yml": LINT_YML, ".github/workflows/deploy.yml": DEPLOY_YML },
    repoState: { workflows: { "ci.yml": { dispatch: true }, "lint.yml": { dispatch: false }, "deploy.yml": { dispatch: true } } },
  });
  ids = s.start([
    { title: "Add slugify", accept: ["slugify works"], scope: ["src/slug.mjs"], size: "S" },
    { title: "Add truncate", accept: ["truncate works"], scope: ["src/trunc.mjs"], size: "S" },
  ]);
  theirCollab();
  outside = mkdtempSync(path.join(tmpdir(), "collab-outside-"));
  usage = path.join(outside, "usage.mjs");
  writeFileSync(usage, USAGE);
});
after(() => {
  s.cleanup();
  rmSync(outside, { recursive: true, force: true });
});

test("collab tests shows where the tests run, for the open collab and for new ones", () => {
  const r = s.run("owner", ["tests"]);
  ok(r);
  assert.match(r.out, /PR #1: the tests run on the agents' machines \(local\): collab verify runs `node --test` in each task's worktree\./);
  assert.match(r.out, /New collabs here: on the agents' machines \(local\).*\(the default\)\./);
  assert.match(r.out, /Switch with \/collab tests local or \/collab tests remote/);
  assert.match(r.out, /1 more open collab on this repo \(#6\) belongs to other GitHub accounts; collab tests leaves it alone\./);
  const j = JSON.parse(s.run("owner", ["tests", "--json"]).stdout);
  assert.deepEqual(j.collabs, [{ pr: 1, tests: "local", verify: "local", ciWorkflows: null }], "only this clone's account's collabs");
  const mine = s.run("owner", ["tests", "--pr", "6"]);
  assert.equal(mine.code, 2, mine.out);
  assert.match(mine.out, /PR #6's collab belongs to GitHub account someone-else, not \S+; its owner switches it/);
  assert.equal(j.clone.tests, "local");
});

test("the status line ends with (tests local), after the status line it wraps", () => {
  const r = statusline(s.clone("owner"), ["node", usage]);
  assert.equal(r.code, 0);
  assert.equal(r.out, "usage 20% ok (tests local)\n", "the wrapped command got the same input, and the segment ends its line");
  assert.equal(statusline(s.clone("owner")).out, "(tests local)\n");
  assert.equal(statusline(outside, ["node", usage]).out, "usage 20% ok\n", "outside a git repo it adds nothing");
});

test("tests remote asks which workflows run the tests, and refuses ones collab can't start", () => {
  const ask = s.run("owner", ["tests", "remote"]);
  assert.equal(ask.code, 2, ask.out);
  assert.match(ask.out, /name the workflows that run the tests: collab tests remote --workflows ci\.yml\. Workflows on main that collab can start: ci\.yml, deploy\.yml\./);
  const lint = s.run("owner", ["tests", "remote", "--workflows", "lint.yml"]);
  assert.equal(lint.code, 2, lint.out);
  assert.match(lint.out, /lint\.yml has no workflow_dispatch trigger/);
  const missing = s.run("owner", ["tests", "remote", "--workflows", "e2e.yml"]);
  assert.equal(missing.code, 2, missing.out);
  assert.match(missing.out, /e2e\.yml is not in \.github\/workflows on main/);
  // From an agent's session (the owner's own Claude Code), only a workflow that runs on pull
  // requests, or that .collab.json names: not a deploy someone talked the agent into.
  const deploy = s.run("owner", ["tests", "remote", "--workflows", "deploy.yml"], CLAUDE_SESSION);
  assert.equal(deploy.code, 2, deploy.out);
  assert.match(deploy.out, /deploy\.yml doesn't run on pull requests, and \.collab\.json on main doesn't list it as the tests, so collab won't start it on the agents' branches from an agent's session \(it would run the agents' code with its secrets\)\. If it runs the tests, run collab tests remote --workflows deploy\.yml in your own terminal\./);
  assert.equal(ledgerConfig().verify, "local", "nothing changed");
  assert.equal(git(["config", "--get", "collab.tests"], s.clone("owner")), "");
});

test("tests remote moves the open collab to CI; the agents see it and verify starts CI", () => {
  // /collab tests remote, in the owner's Claude Code session: ci.yml runs on pull requests.
  const r = s.run("owner", ["tests", "remote", "--workflows", "ci.yml"], CLAUDE_SESSION);
  ok(r);
  assert.match(r.out, /PR #1: the tests now run on CI \(remote\): collab verify starts ci\.yml on each task's branch\. What already passed stands/);
  assert.match(r.out, /New collabs here: on CI \(remote\).*\(kept in this clone's git config\)/);
  const cfg = ledgerConfig();
  assert.equal(cfg.verify, "ci");
  assert.deepEqual(cfg.ciWorkflows, ["ci.yml"]);
  assert.equal(git(["config", "--get", "collab.tests"], s.clone("owner")), "ci");
  assert.equal(git(["config", "--get", "collab.ciWorkflows"], s.clone("owner")), "ci.yml");
  assert.equal(theirs().config.verify, "local", "the other account's collab is left alone");
  assert.equal(statusline(s.clone("owner"), ["node", usage]).out, "usage 20% ok (tests remote)\n");

  // Codex's next command shows it in the inbox, once.
  const cl = s.as("codex", X(), ["claim", "T1"]);
  ok(cl);
  assert.match(cl.out, /\[the owner\] moved the tests to CI \(ci\.yml\): collab verify starts them on the task's branch now/);
  assert.doesNotMatch(s.as("codex", X(), ["next"]).out, /moved the tests/);
  write("codex", "T1", "src/slug.mjs", "export const slugify = (s) => s.toLowerCase();\n");
  ok(s.as("codex", X(), ["push", "T1"]));
  const v = s.as("codex", X(), ["verify", "T1"]);
  ok(v);
  assert.match(v.out, /Started CI for T1 at [0-9a-f]{7}: ci\.yml on collab\/pr-1\/t1\./);
  assert.equal(runs("collab/pr-1/t1").length, 1);
  assert.equal(statusline(wt("codex", "T1")).out, "(tests remote)\n", "in a task's worktree too");
  // T1 goes to review while CI runs, and Claude approves it before CI is done.
  ok(s.as("codex", X(), ["submit", "T1"]));
  ok(s.as("claude", C(), ["review-claim", "T1"]));
  ok(s.as("claude", C(), ["review", "T1", "--approve", "--body-file", notes("Looks right.")]));
  assert.equal(tasks().T1.status, "approved");
  // Again with the same workflows: nothing to change.
  assert.match(s.run("owner", ["tests", "remote"]).out, /PR #1: the tests already run on CI \(remote\)/);
});

test("an agent's own session can read the setting, but only the owner switches it", () => {
  const read = s.run("codex", ["tests"], { COLLAB_AGENT: X() });
  ok(read);
  assert.match(read.out, /PR #1: the tests run on CI \(remote\)/);
  const flip = s.run("codex", ["tests", "local"], { COLLAB_AGENT: X() });
  assert.equal(flip.code, 2, flip.out);
  assert.match(flip.out, /collab tests local is the owner's switch; this session is the agent codex-/);
  assert.equal(ledgerConfig().verify, "ci");
});

test("tests local moves them back: a task approved while CI ran gets its tests run on the machine", () => {
  const r = s.run("owner", ["tests", "local"]);
  ok(r);
  assert.match(r.out, /PR #1: the tests now run on the agents' machines \(local\)/);
  assert.equal(ledgerConfig().verify, "local");
  assert.equal(statusline(s.clone("owner")).out, "(tests local)\n");
  // T1 was approved while its CI ran, and that CI never finished: nothing has passed at its head.
  const n = s.as("codex", X(), ["next"]);
  assert.match(n.out, /Next: work T1: T1 is approved at [0-9a-f]{7}, and its tests have not passed on that commit: run them/);
  assert.match(n.out, /Run: collab verify T1/);
  const early = s.as("codex", X(), ["merge", "T1"]);
  assert.equal(early.code, 2, early.out);
  assert.match(early.out, /the tests have not passed for T1 at [0-9a-f]{7}; codex-\w+ runs collab verify T1 first/);
  const v = s.as("codex", X(), ["verify", "T1"]);
  ok(v);
  assert.match(v.out, /Verify passed for T1 at [0-9a-f]{7}: node --test exited 0/);
  assert.equal(runs("collab/pr-1/t1").length, 1, "no new CI run");
  // The run collab started while the tests ran on CI still shows among the sub-PR's checks.
  const sub = `o/r#${tasks().T1.subPr}`;
  s.fake.update((st) => { st.pulls[sub].ci = "PENDING"; });
  const pending = s.as("codex", X(), ["merge", "T1"]);
  assert.equal(pending.code, 2, pending.out);
  assert.match(pending.out, /CI on sub-PR #\d+ is still running, including ci\.yml, which collab started at this commit while the tests ran on CI; wait and retry/);
  s.fake.update((st) => { st.pulls[sub].ci = "SUCCESS"; });
  ok(s.as("codex", X(), ["merge", "T1"]));
  assert.equal(tasks().T1.status, "done");
});

test("a collab started later in this clone starts with the owner's choice", () => {
  ok(s.run("owner", ["tests", "remote", "--workflows", "ci.yml"]));
  // A second PR, on its own branch.
  const owner = s.clone("owner");
  git(["push", "-q", "origin", "origin/main:refs/heads/feat/y"], owner);
  const headSha = git(["rev-parse", "origin/main"], owner);
  s.fake.update((st) => {
    st.pulls["o/r#5"] = { ...st.pulls["o/r#1"], title: "Another change", headRef: "feat/y", headSha, body: "Other notes." };
    st.comments["o/r#5"] = [];
  });
  const j = s.run("owner", ["join", "5", "--tool", "claude"]);
  ok(j);
  assert.match(j.out, /collab verify runs the tests on CI: it starts ci\.yml on each task's branch/);
  const five = JSON.parse(s.run("owner", ["status", "--json", "--pr", "5"]).stdout);
  assert.equal(five.config.verify, "ci");
  assert.equal(five.schema, 2, "a collab older than CI mode refuses this ledger");
});
