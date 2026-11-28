// Use case: tests/use-cases/collab-ci-verify.md
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { setup } from "../helpers/cli-env.mjs";

// Runs only for PRs into main, like the workflows that prompted this; workflow_dispatch lets collab start it.
const CI_YML = "name: CI\non:\n  pull_request:\n    branches: [main]\n  workflow_dispatch:\njobs:\n  test:\n    runs-on: [self-hosted, local]\n    steps:\n      - run: npm test\n";

let s;
let ids;
const C = () => ids.claude;
const X = () => ids.codex;
const ok = (r) => assert.equal(r.code, 0, r.out);
const tasks = () => JSON.parse(s.as("claude", C(), ["status", "--json"]).stdout).tasks;
const runs = (branch) => (s.fake.read().repos["o/r"].runs ?? []).filter((r) => !branch || r.headBranch === branch);
// Every run still queued or running ends with this conclusion, as GitHub reports it.
const finish = (conclusion) => s.fake.update((st) => {
  for (const r of st.repos["o/r"].runs ?? []) if (r.status !== "completed") Object.assign(r, { status: "completed", conclusion });
});
const wt = (t) => path.join(s.clone("codex"), ".collab", "wt", `pr1-${t.toLowerCase()}`);
const write = (t, rel, text) => {
  const f = path.join(wt(t), rel);
  mkdirSync(path.dirname(f), { recursive: true });
  writeFileSync(f, text);
};
const notes = (text) => {
  const dir = path.join(s.clone("claude"), ".collab");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "notes.md"), text);
  return ".collab/notes.md";
};
const lastComment = (n) => (s.fake.read().comments[`o/r#${n}`] ?? []).at(-1)?.body ?? "";

before(() => {
  s = setup({
    config: { verify: "ci", ciWorkflows: ["ci.yml"] },
    files: { ".github/workflows/ci.yml": CI_YML },
    repoState: { workflows: { "ci.yml": { dispatch: true } } },
  });
  ids = s.start([
    { title: "Add slugify", accept: ["slugify('A B') is 'a-b'"], scope: ["src/slug.mjs"], size: "S" },
    { title: "Add truncate", accept: ["truncate works"], scope: ["src/trunc.mjs"], size: "S" },
    { title: "Run CI on Node 24 too", accept: ["ci.yml tests Node 24"], scope: [".github/workflows/ci.yml"], size: "S" },
    { title: "Add pad", accept: ["pad works"], scope: ["src/pad.mjs"], size: "S" },
    { title: "Add trim", accept: ["trim works"], scope: ["src/trim.mjs"], size: "S" },
  ]);
});
after(() => s.cleanup());

test("join says the tests run on CI, and leaves out the warning that sub-PRs get no checks", () => {
  const j = s.run("codex", ["join", "1", "--tool", "codex", "--agent", X()]);
  ok(j);
  assert.match(j.out, /collab verify runs the tests on CI: it starts ci\.yml on each task's branch/);
  assert.doesNotMatch(j.out, /sub-PRs get no checks/);
  assert.doesNotMatch(j.out, /Warning: ci\.yml/);
});

test("verify starts the workflow on the task's branch instead of running the tests here", () => {
  ok(s.as("codex", X(), ["claim", "T1"]));
  write("T1", "src/slug.mjs", "export const slugify = (s) => s.toLowerCase().replace(/\\s+/g, '-');\n");
  ok(s.as("codex", X(), ["push", "T1"]));
  const v = s.as("codex", X(), ["verify", "T1"]);
  ok(v);
  assert.match(v.out, /Started CI for T1 at [0-9a-f]{7}: ci\.yml on collab\/pr-1\/t1\./);
  assert.match(v.out, /You don't have to wait for it: run collab submit T1/);
  assert.doesNotMatch(v.out, /Test output/, "no tests ran on this machine");
  const t1 = tasks().T1;
  assert.equal(t1.ci.state, "running");
  assert.equal(t1.ci.sha, t1.headSha);
  const [run] = runs("collab/pr-1/t1");
  assert.equal(run.event, "workflow_dispatch");
  assert.equal(run.headSha, t1.headSha);
  // Again while it runs: how far it is, and no second run.
  const again = s.as("codex", X(), ["verify", "T1"]);
  ok(again);
  assert.match(again.out, /CI is running for T1 at [0-9a-f]{7}: ci\.yml queued/);
  assert.equal(runs("collab/pr-1/t1").length, 1);
});

test("next says submit while CI runs, and the task goes to review at once", () => {
  const n = s.as("codex", X(), ["next"]);
  assert.match(n.out, /Next: work T1/);
  assert.match(n.out, /Run: collab submit T1/);
  const sub = s.as("codex", X(), ["submit", "T1"]);
  ok(sub);
  assert.match(sub.out, /T1 is in review \(sub-PR #2\)/);
  assert.match(sub.out, /CI is still running at [0-9a-f]{7} \(ci\.yml\): the review runs alongside it, merging waits for it to pass/);
  assert.equal(tasks().T1.status, "in_review");
  assert.equal(runs("collab/pr-1/t1").length, 1, "submit didn't start CI again");
});

test("the reviewer runs no tests and may approve while CI runs", () => {
  const rc = s.as("claude", C(), ["review-claim", "T1"]);
  ok(rc);
  assert.match(rc.out, /CI runs the tests, so you don't/);
  const v = s.as("claude", C(), ["verify", "T1"]);
  ok(v);
  assert.match(v.out, /CI is running for T1 at [0-9a-f]{7}.*You may approve while it runs/);
  ok(s.as("claude", C(), ["review", "T1", "--approve", "--body-file", notes("Looks right.")]));
  assert.equal(tasks().T1.status, "approved");
  assert.match(lastComment(2), /Verify: CI is still running/);
});

test("the merge waits for CI, and goes ahead once GitHub says it passed", () => {
  const early = s.as("codex", X(), ["merge", "T1"]);
  assert.equal(early.code, 2, early.out);
  assert.match(early.out, /CI is still running for T1 at [0-9a-f]{7}/);
  const st = s.as("claude", C(), ["status"]);
  assert.match(st.out, /SUB-PR\s+CI\s+TITLE/);
  assert.match(st.out, /T1\s+approved\s+\S+\s+-\s+#2\s+running\s+Add slugify/);
  assert.match(st.out, /Tests run on CI \(remote\): collab verify starts ci\.yml on each task's branch\./);
  // A run a PR event started at the same commit, and failed: not the one collab started.
  const head = tasks().T1.headSha;
  s.fake.update((st2) => { const id = st2.nextRunId ?? 5000; st2.nextRunId = id + 1; st2.repos["o/r"].runs.push({ id, workflow: "ci.yml", headSha: head, headBranch: "collab/pr-1/t1", event: "pull_request", status: "completed", conclusion: "failure", createdAt: new Date().toISOString() }); });
  assert.doesNotMatch(s.as("codex", X(), ["next"]).out, /Next: fix T1/);
  assert.equal(tasks().T1.ci.state, "running");
  finish("success");
  const n = s.as("codex", X(), ["next"]);
  assert.match(n.out, /Next: merge T1/);
  const t1 = tasks().T1;
  assert.equal(t1.ci.state, "passed");
  assert.ok(t1.verify.some((x) => x.via === "ci" && x.ok && x.sha === t1.headSha), "CI's pass counts as a verify");
  // Someone reruns the workflow on GitHub (the same run, queued again), two hours after CI
  // started: merge waits for it, and the hour's limit on a queued run doesn't apply.
  const rerun = (fields) => s.fake.update((st2) => { for (const r of st2.repos["o/r"].runs) if (r.event === "workflow_dispatch" && r.headSha === head) Object.assign(r, fields); });
  rerun({ status: "queued", conclusion: null });
  const later = new Date(Date.parse(t1.ci.at) + 120 * 60_000).toISOString();
  const queued = s.as("codex", X(), ["merge", "T1"], { COLLAB_NOW: later });
  assert.equal(queued.code, 2, queued.out);
  assert.match(queued.out, /the ledger says CI passed for T1 at [0-9a-f]{7}, but it is running again on GitHub \("ci\.yml queued": someone reran it\); wait for it, then retry/);
  assert.equal(tasks().T1.ci.state, "passed", "nothing recorded");
  // This time it fails: merge checks GitHub again.
  rerun({ status: "completed", conclusion: "failure" });
  const stale = s.as("codex", X(), ["merge", "T1"]);
  assert.equal(stale.code, 2, stale.out);
  assert.match(stale.out, /the ledger said CI passed for T1 at [0-9a-f]{7}, but GitHub now says "ci\.yml failure .*"\. Recorded that, so collab next sends T1 back/);
  assert.equal(tasks().T1.status, "approved");
  assert.match(s.as("codex", X(), ["next"]).out, /Next: fix T1: CI failed on T1/, "no merge offered again and again");
  assert.match(s.as("codex", X(), ["verify", "T1"]).out, /started it again/);
  finish("success");
  assert.match(s.as("codex", X(), ["next"]).out, /Next: merge T1/);
  ok(s.as("codex", X(), ["merge", "T1"]));
  assert.equal(tasks().T1.status, "done");
});

test("CI that fails sends the task back to its owner; a rerun or a fix starts it again", () => {
  ok(s.as("codex", X(), ["claim", "T2"]));
  write("T2", "src/trunc.mjs", "export const truncate = (s, n) => s.slice(0, n);\n");
  ok(s.as("codex", X(), ["push", "T2"]));
  // GitHub can't start a workflow without a workflow_dispatch trigger: nothing is recorded.
  s.fake.update((st) => { st.repos["o/r"].workflows["ci.yml"].dispatch = false; });
  const bad = s.as("codex", X(), ["verify", "T2"]);
  assert.equal(bad.code, 2, bad.out);
  assert.match(bad.out, /GitHub can't start ci\.yml on collab\/pr-1\/t2 .*Its on: block on the default branch needs a workflow_dispatch: trigger with no required inputs/);
  assert.equal(tasks().T2.ci, undefined);
  s.fake.update((st) => { st.repos["o/r"].workflows["ci.yml"].dispatch = true; });
  // Submit starts CI itself.
  const sub = s.as("codex", X(), ["submit", "T2"]);
  ok(sub);
  assert.match(sub.out, /CI started at [0-9a-f]{7}/);
  ok(s.as("claude", C(), ["review-claim", "T2"]));
  finish("failure");
  const fix = s.as("codex", X(), ["next"]);
  assert.match(fix.out, /Next: fix T2: CI failed on T2 at [0-9a-f]{7}: "ci\.yml failure \(https:\/\/github\.com\/o\/r\/actions\/runs\/\d+\)"/);
  assert.match(fix.out, /Run: collab push T2/);
  const rv = s.as("claude", C(), ["next"]);
  assert.match(rv.out, /Next: review T2: CI failed on T2/);
  assert.match(rv.out, /--changes/);
  const approve = s.as("claude", C(), ["review", "T2", "--approve", "--body-file", notes("Fine.")]);
  assert.equal(approve.code, 2, approve.out);
  assert.match(approve.out, /CI failed for T2 at [0-9a-f]{7}: .*Request changes instead/);
  assert.match(s.run("claude", ["dashboard", "--print", "--pr", "1"]).out, /❌ Failed/);
  // Flaky? verify at the same commit runs it again.
  const rerun = s.as("codex", X(), ["verify", "T2"]);
  ok(rerun);
  assert.match(rerun.out, /CI failed at [0-9a-f]{7} last time \("ci\.yml failure .*"\); started it again/);
  assert.equal(runs("collab/pr-1/t2").length, 2);
  finish("failure");
  // A real failure: Codex pushes a fix while T2 is in review, then starts CI on the new commit.
  write("T2", "src/trunc.mjs", "export const truncate = (s, n) => String(s).slice(0, n);\n");
  ok(s.as("codex", X(), ["push", "T2"]));
  assert.equal(tasks().T2.status, "in_review");
  const start = s.as("codex", X(), ["next"]);
  assert.match(start.out, /Next: work T2: T2 is in review at [0-9a-f]{7}, and no CI has run on that commit: start it/);
  assert.match(start.out, /Run: collab verify T2/);
  ok(s.as("codex", X(), ["verify", "T2"]));
  finish("success");
  assert.match(s.as("claude", C(), ["next"]).out, /Next: review T2: codex-\w+ pushed [0-9a-f]{7} while you were reviewing/);
  ok(s.as("claude", C(), ["review-claim", "T2"]));
  ok(s.as("claude", C(), ["review", "T2", "--approve", "--body-file", notes("Fixed.")]));
  assert.match(lastComment(3), /Verify: passed on CI/);
  ok(s.as("codex", X(), ["merge", "T2"]));
});

// Found by the run on real GitHub: the fix flow (push, verify, submit) ended with submit refusing.
test("CI that fails after the approval: the fix goes back to review, and submit says so", () => {
  ok(s.as("codex", X(), ["claim", "T5"]));
  write("T5", "src/trim.mjs", "export const trim = (s) => s;\n");
  ok(s.as("codex", X(), ["push", "T5"]));
  ok(s.as("codex", X(), ["verify", "T5"]));
  ok(s.as("codex", X(), ["submit", "T5"]));
  ok(s.as("claude", C(), ["review-claim", "T5"]));
  ok(s.as("claude", C(), ["review", "T5", "--approve", "--body-file", notes("Looks right.")]));
  finish("failure");
  assert.match(s.as("codex", X(), ["next"]).out, /Next: fix T5: CI failed on T5/);
  write("T5", "src/trim.mjs", "export const trim = (s) => String(s).trim();\n");
  ok(s.as("codex", X(), ["push", "T5"]));
  assert.equal(tasks().T5.status, "in_review", "the approval was for the old commit");
  ok(s.as("codex", X(), ["verify", "T5"]));
  const sub = s.as("codex", X(), ["submit", "T5"]);
  ok(sub);
  assert.match(sub.out, /T5 is already in review, now at [0-9a-f]{7}; another agent reviews this commit \(sub-PR #\d+\), so there is nothing to submit\. CI is still running at [0-9a-f]{7}/);
  finish("success");
  assert.match(s.as("claude", C(), ["next"]).out, /Next: review T5/);
  ok(s.as("claude", C(), ["review-claim", "T5"]));
  ok(s.as("claude", C(), ["review", "T5", "--approve", "--body-file", notes("Fixed.")]));
  ok(s.as("codex", X(), ["merge", "T5"]));
  assert.equal(tasks().T5.status, "done");
});

test("a task that changes a workflow is verified on the machine, not on CI", () => {
  ok(s.as("codex", X(), ["claim", "T3"]));
  write("T3", ".github/workflows/ci.yml", CI_YML.replace("npm test", "npm test && npm run test:node24"));
  assert.equal(s.as("codex", X(), ["push", "T3"]).code, 2);
  ok(s.as("codex", X(), ["block", "T3", "--reason", "T3 changes ci.yml. Allow?", "--owner"]));
  ok(s.run("owner", ["decide", "T3", "Yes.", "--allow-protected", "--pr", "1"]));
  ok(s.as("codex", X(), ["push", "T3"]));
  const nx = s.as("codex", X(), ["next"]).out;
  assert.match(nx, /Run: collab verify T3/);
  assert.doesNotMatch(nx, /--local/);
  const v = s.as("codex", X(), ["verify", "T3"]);
  ok(v);
  assert.match(v.out, /T3 changes \.github\/workflows\/ci\.yml, and CI on its branch would run that changed version, so its tests run on this machine\./);
  assert.match(v.out, /Verify passed for T3 at [0-9a-f]{7}: node --test exited 0/);
  assert.equal(runs("collab/pr-1/t3").length, 0);
  assert.match(s.as("claude", C(), ["status"]).out, /T3\s+claimed\s+\S+\s+-\s+#\d+\s+passed here/);
  ok(s.as("codex", X(), ["submit", "T3"]));
  assert.equal(runs("collab/pr-1/t3").length, 0, "submit used the verify on the machine");
  // Found by the run on real GitHub: review-claim told the reviewer that CI runs T3's tests.
  // Codex's run on the machine passed at this very commit, so the reviewer doesn't run them again.
  const rc = s.as("claude", C(), ["review-claim", "T3"]);
  ok(rc);
  assert.match(rc.out, new RegExp(`The tests already passed at [0-9a-f]{7}, the commit you review \\(${X()}, .*so don't run them again\\.`));
  assert.equal(s.json("claude", ["review-claim", "T3", "--pr", "1", "--agent", C()]).data.testsPassed.by, X());
  assert.doesNotMatch(rc.out, /CI runs the tests, so you don't/);
  // Codex pushes again without running them: nothing passed at the new head, so the reviewer runs
  // them on the machine before approving.
  write("T3", ".github/workflows/ci.yml", CI_YML.replace("npm test", "npm test && npm run test:node24 # v2"));
  ok(s.as("codex", X(), ["push", "T3"]));
  const again = s.as("claude", C(), ["review-claim", "T3"]);
  ok(again);
  assert.match(again.out, /T3 changes a workflow \(\.github\/workflows\/ci\.yml\), so its tests run on this machine, not on CI: collab verify T3 .*, before you approve\./);
  assert.doesNotMatch(again.out, /already passed|CI runs the tests, so you don't/);
});

test("a workflow with no run after 15 minutes, or no runner after an hour, counts as failed", () => {
  ok(s.as("codex", X(), ["claim", "T4"]));
  write("T4", "src/pad.mjs", "export const pad = (s, n) => String(s).padStart(n);\n");
  ok(s.as("codex", X(), ["push", "T4"]));
  ok(s.as("codex", X(), ["verify", "T4"]));
  // No runner picked it up and GitHub shows no run.
  s.fake.update((st) => { st.repos["o/r"].runs = st.repos["o/r"].runs.filter((r) => r.headBranch !== "collab/pr-1/t4"); });
  const at = Date.parse(tasks().T4.ci.at);
  const soon = s.as("codex", X(), ["next"], { COLLAB_NOW: new Date(at + 5 * 60_000).toISOString() });
  assert.doesNotMatch(soon.out, /Next: fix T4/);
  const late = s.as("codex", X(), ["next"], { COLLAB_NOW: new Date(at + 16 * 60_000).toISOString() });
  assert.match(late.out, /Next: fix T4: CI failed on T4 at [0-9a-f]{7}: "ci\.yml did not start within 15 minutes \(GitHub has no run for it\); run collab verify again"/);
  // Run again: this time GitHub has the run, but no runner takes it (it stays queued).
  const again = s.as("codex", X(), ["verify", "T4"], { COLLAB_NOW: new Date(at + 17 * 60_000).toISOString() });
  ok(again);
  assert.match(again.out, /started it again/);
  const restart = Date.parse(tasks().T4.ci.at);
  const queued = s.as("codex", X(), ["next"], { COLLAB_NOW: new Date(restart + 30 * 60_000).toISOString() });
  assert.doesNotMatch(queued.out, /Next: fix T4/, "half an hour in the queue is busy runners, not broken ones");
  const stuck = s.as("codex", X(), ["next"], { COLLAB_NOW: new Date(restart + 61 * 60_000).toISOString() });
  assert.match(stuck.out, /Next: fix T4: CI failed on T4 at [0-9a-f]{7}: "ci\.yml \(https:\/\/github\.com\/o\/r\/actions\/runs\/\d+\) waited 60 minutes for a runner or an approval; check the runners/);
});
