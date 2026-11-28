// Use case: tests/use-cases/collab-sessions.md
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { setup } from "../helpers/cli-env.mjs";
import { isAlive, killTree, listRuns } from "../../skills/collab/lib/agents.mjs";

const FAKE = fileURLToPath(new URL("../helpers/fake-agent.mjs", import.meta.url));
const CLI = fileURLToPath(new URL("../../skills/collab/bin/collab.mjs", import.meta.url));
// Every fake session joins, then claims the task its startup prompt names (with --steal when told to).
const CLAIMS = [["join", "1", "--tool", "claude", "--agent", "__ID__"], ["claim", "__TASK__", "__STEAL__", "--pr", "1", "--agent", "__ID__"]];
let s;
let ids;
let logDir;
const fakeEnv = (actions = CLAIMS, extra = {}) => ({
  COLLAB_CLAUDE: JSON.stringify([process.execPath, FAKE]),
  COLLAB_CODEX: JSON.stringify([process.execPath, FAKE]),
  FAKE_AGENT_LOG: logDir,
  FAKE_COLLAB_CLI: CLI,
  FAKE_AGENT_ACTIONS: JSON.stringify(actions),
  COLLAB_SESSIONS_EVERY_MS: "300", // the keeper's round, 20 s for real
  ...extra,
});
const runs = () => listRuns({ COLLAB_HOME: s.home });
const runOf = (id) => runs().find((r) => r.id === id);
const record = (agent) => JSON.parse(readFileSync(path.join(logDir, `${agent}.json`), "utf8"));
const status = (pr = 1) => JSON.parse(s.run("owner", ["status", "--json", "--pr", String(pr)]).stdout);
const statusText = (pr = 1) => s.run("owner", ["status", "--pr", String(pr)]).out;
const members = (keeper) => runOf(keeper)?.members ?? [];
const ok = (r) => assert.equal(r.code, 0, r.out);
// Refused with exit 2 and this message.
const refused = (r, re) => { assert.equal(r.code, 2, r.out); assert.match(r.out, re); };

async function until(fn, ms = 60_000, what = "condition") {
  const end = Date.now() + ms;
  for (;;) {
    try { if (fn()) return; } catch { /* not yet */ }
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

let keeper;
before(() => {
  s = setup();
  logDir = path.join(s.home, "fake-agents");
  mkdirSync(logDir, { recursive: true });
  // T1, T2 and T3 can start at once; T4 and T5 wait on T1. Only Claude has joined.
  ids = s.start([
    { title: "Core", accept: ["works"], scope: ["src/core.mjs"], size: "S" },
    { title: "Strings", accept: ["works"], scope: ["src/strings.mjs"], size: "S" },
    { title: "Docs", accept: ["works"], scope: ["docs/**"], size: "S" },
    { title: "CLI", accept: ["works"], scope: ["src/cli.mjs"], deps: ["T1"], size: "S" },
    { title: "Tests", accept: ["works"], scope: ["test/**"], deps: ["T1"], size: "S" },
  ], []);
});
after(async () => {
  for (const r of runs()) for (const p of [r.pid, r.relayPid, r.watchdogPid]) killTree(p);
  await new Promise((r) => setTimeout(r, 500));
  s.cleanup();
});

test("asking for sessions starts only as many as there are tasks for, each on its own task, and leaves one for the agent that asked", async () => {
  // Claude runs this inside its own session for "/collab <PR> --sessions 4": it is the fourth.
  const r = s.run("claude", ["invite", "claude", "--sessions", "3", "--timeout", "10m", "--pr", "1", "--agent", ids.claude], fakeEnv(CLAIMS, { CLAUDECODE: "1", CLAUDE_CODE_OAUTH_TOKEN: "tok-oauth" }));
  ok(r);
  keeper = /Session keeper (sessions-[a-z0-9]{4}) runs up to 3 Claude Code session\(s\) on PR #1 at once/.exec(r.out)?.[1];
  assert.ok(keeper, r.out);
  assert.equal(runOf(keeper).target, 3);
  // T1, T2 and T3 can start; T1 is left for Claude, which is free.
  assert.deepEqual(members(keeper).map((m) => m.task), ["T2", "T3"]);
  const [a, b] = members(keeper).map((m) => m.id);
  assert.match(r.out, new RegExp(`Started 2 now: ${a} \\(T2\\), ${b} \\(T3\\)\\.`));
  assert.match(r.out, new RegExp(`Whenever you \\(${ids.claude}\\) are free, one task is left for you`));
  assert.match(r.out, /The sessions review each other's tasks\. An agent from another vendor would review first: collab invite codex --pr 1/);
  assert.match(r.out, /collab stop --pr 1/);
  await until(() => record(a).results.length === 2 && record(b).results.length === 2, 60_000, "both sessions to join and claim");
  for (const agent of [a, b]) for (const x of record(agent).results) ok(x);
  const l = status();
  assert.equal(l.tasks.T2.owner, a);
  assert.equal(l.tasks.T3.owner, b);
  assert.equal(l.tasks.T1.status, "open");
  assert.ok(!l.tasks.T1.reserved, "the task left for Claude is not reserved for a session");
  // Each session knows it is one of several and gets its own task.
  assert.match(record(a).prompt, /one of up to 3 sessions the owner runs in parallel on this PR, each on its own task/);
  assert.match(record(a).prompt, new RegExp(`claim T2 --pr 1 --agent ${a}`));
  assert.equal(record(a).env.CLAUDECODE, null, "the inviting session's markers don't reach the sessions");
  assert.equal(record(a).env.CLAUDE_CODE_OAUTH_TOKEN, "tok-oauth", "the owner's own sign-in does");
  // The keeper process is running, and Claude's next is the task left for it.
  assert.ok(isAlive(runOf(keeper).pid), "keeper running");
  assert.match(s.as("claude", ids.claude, ["next"]).out, /Next: claim T1/);
  assert.match(statusText(), new RegExp(`Sessions: 2 of up to 3 Claude Code running: ${a} \\(T2\\), ${b} \\(T3\\)\\. Keeper ${keeper} stops by `));
  assert.equal(status().sessions[0].keeper, keeper);
});

test("a second keeper, bad counts and agent sessions are refused", () => {
  refused(s.run("owner", ["invite", "claude", "--sessions", "2", "--pr", "1"], fakeEnv()), new RegExp(`session keeper ${keeper} already runs up to 3 Claude Code session\\(s\\) on PR #1.*collab stop --run ${keeper} --pr 1`));
  for (const n of ["0", "two", "-1"]) refused(s.run("owner", ["invite", "claude", "--sessions", n, "--pr", "1"], fakeEnv()), /--sessions takes a number of sessions, 1 or more/);
  refused(s.run("owner", ["invite", "claude", "--sessions", "2", "--task", "T4", "--pr", "1"], fakeEnv()), /can't be combined with --task or --review/);
  refused(s.run("owner", ["invite", "claude", "--sessions", "2", "--pr", "1", "--agent", "claude-zzzz"], fakeEnv()), /claude-zzzz has not joined PR #1/);
  // An invited session can't start sessions of its own, or run the keeper.
  refused(s.run("claude", ["invite", "claude", "--sessions", "2", "--pr", "1"], { ...fakeEnv(), COLLAB_AGENT: "claude-ab12" }), /collab invite is for the owner's own terminal/);
  refused(s.run("claude", ["keep-sessions", "--run", keeper, "--pr", "1"], { CLAUDECODE: "1" }), /owner-only/);
  refused(s.run("owner", ["keep-sessions", "--run", "sessions-zzzz", "--pr", "1"]), /isn't run by hand/);
});

test("as tasks unlock, the keeper starts more sessions, up to the number asked, leaving one for the free agent that asked", async () => {
  ok(s.as("claude", ids.claude, ["claim", "T1"]));
  // Nothing else can start while T1 is in Claude's hands: T4 and T5 wait on it.
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(members(keeper).length, 2);
  assert.match(statusText(), /no more tasks can start now: T4, T5 wait on dependencies or on overlapping work in flight/);
  // T1 turns out not to be needed. Its dependents unlock, and Claude is free again.
  ok(s.as("claude", ids.claude, ["cancel", "T1", "--reason", "not needed"]));
  await until(() => members(keeper).length === 3, 30_000, "a third session");
  const third = members(keeper)[2];
  assert.equal(third.task, "T5", "T4 is left for Claude");
  await until(() => status().tasks.T5.owner === third.id, 60_000, "the third session to claim T5");
  // The keeper process started this one: it still gets the owner's sign-in, but no session markers.
  assert.equal(record(third.id).env.CLAUDE_CODE_OAUTH_TOKEN, "tok-oauth");
  assert.equal(record(third.id).env.CLAUDECODE, null);
  assert.match(s.as("claude", ids.claude, ["next"]).out, /Next: claim T4/);
  // All three are running: no fourth starts, even with T4 free.
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(members(keeper).length, 3);
});

test("a session that stops mid-task is replaced by one that takes its task over", async () => {
  const first = members(keeper)[0];
  assert.equal(status().tasks[first.task].owner, first.id);
  killTree(record(first.id).pid);
  // Its watchdog expires its lease; the keeper starts a session that steals the task.
  await until(() => members(keeper).some((m) => m.steal && m.task === first.task), 60_000, "a session that takes the task over");
  const taker = members(keeper).find((m) => m.steal && m.task === first.task);
  await until(() => record(taker.id), 30_000, "the new session to start");
  assert.match(record(taker.id).prompt, new RegExp(`take over ${first.task}, whose owner stopped mid-task: node "[^"]+" claim ${first.task} --steal --pr 1 --agent ${taker.id}`));
  await until(() => status().tasks[first.task].owner === taker.id, 60_000, "the new session to steal the task");
  assert.equal(members(keeper).find((m) => m.id === first.id).ok, true, "the session that stopped had done its work, so it doesn't count as a failed start");
  assert.equal(runOf(keeper).failStreak, 0);
});

test("stop --run <keeper> ends only the keeper: its sessions keep working", async () => {
  const live = members(keeper).filter((m) => !m.endedAt);
  assert.ok(live.length >= 3, JSON.stringify(live));
  const r = s.run("owner", ["stop", "--run", keeper, "--pr", "1"]);
  ok(r);
  assert.match(r.out, new RegExp(`Stopped the session keeper ${keeper}\\.`));
  await until(() => !isAlive(runOf(keeper).pid), 20_000, "the keeper to exit");
  // On Windows its sessions are its child processes: they must survive it.
  await new Promise((res) => setTimeout(res, 1000));
  for (const m of live) assert.ok(isAlive(record(m.id).pid), `${m.id} still runs`);
  for (const m of live) assert.ok(!runOf(m.id).stoppedAt, `${m.id}'s run isn't stopped`);
  assert.match(statusText(), new RegExp(`Sessions: keeper ${keeper} stopped .*\\(stopped by the owner\\)\\. Still running: .*${live[0].id}`));
});

test("stop ends the keeper first, then every session, and frees their work", async () => {
  // A new keeper, now that the first one is gone, for the one task still free (T4).
  const k = s.json("owner", ["invite", "claude", "--sessions", "1", "--timeout", "10m", "--pr", "1"], fakeEnv()).data?.keeper;
  assert.ok(k);
  assert.deepEqual(members(k).map((m) => m.task), ["T4"]);
  await until(() => status().tasks.T4.owner === members(k)[0].id, 60_000, "the new session to claim T4");
  const live = [...members(keeper).filter((m) => !m.endedAt), ...members(k)];
  const r = s.run("owner", ["stop", "--pr", "1"]);
  ok(r);
  assert.match(r.out, new RegExp(`Stopped the session keeper ${k} and claude-`));
  for (const m of live) assert.match(r.out, new RegExp(m.id));
  await until(() => !isAlive(runOf(k).pid), 20_000, "the keeper to exit");
  assert.ok(runOf(k).stoppedAt);
  for (const m of live) await until(() => !isAlive(record(m.id).pid), 20_000, `${m.id} to exit`);
  const l = status();
  const now = new Date().toISOString();
  for (const m of live) assert.ok(l.tasks[m.task].leaseUntil < now, `${m.task}'s lease expired so another agent can take it`);
  assert.match(statusText(), new RegExp(`Sessions: keeper ${k} stopped .*\\(stopped by the owner\\)\\. Still running: none\\.`));
});

test("sessions that can't start stop the keeper after two in a row, and status says why", async () => {
  // These sessions exit at once without joining, as a Claude that isn't signed in would.
  const r = s.json("owner", ["invite", "claude", "--sessions", "2", "--timeout", "10m", "--pr", "1"], fakeEnv([], { FAKE_AGENT_EXIT: "1" }));
  ok(r);
  const k = r.data.keeper;
  assert.equal(r.data.started.length, 2);
  await until(() => runOf(k).stoppedAt, 60_000, "the keeper to give up");
  assert.equal(runOf(k).stopReason, "failing");
  assert.ok(runOf(k).launches <= 3, `it doesn't keep starting sessions that fail (${runOf(k).launches})`);
  const text = statusText();
  assert.match(text, new RegExp(`Sessions: keeper ${k} stopped .*\\(failing\\)`));
  assert.ok(runOf(k).why.includes("2 sessions in a row stopped without doing any work") && runOf(k).why.includes("agent.err.log"), runOf(k).why);
  // An agent program that can't be started at all is reported at once.
  const missing = s.run("owner", ["invite", "claude", "--sessions", "2", "--pr", "1"], fakeEnv(CLAIMS, { COLLAB_CLAUDE: JSON.stringify([path.join(s.home, "no-such-claude")]) }));
  assert.equal(missing.code, 5, missing.out);
  assert.match(missing.out, /could not start/);
  assert.ok(Object.values(status().tasks).every((t) => !t.reserved), "nothing stays reserved for sessions that never started");
});

test("close stops the keeper, so a purged collab isn't started again", async () => {
  s.fake.update((st) => { st.pulls["o/r#3"] = { ...st.pulls["o/r#1"], number: 3, title: "Third PR", body: "Third.\n" }; st.comments["o/r#3"] = []; });
  const j = s.run("claude", ["join", "3", "--tool", "claude"]);
  ok(j);
  const planner = s.idOf(j);
  writeFileSync(path.join(s.clone("claude"), ".collab", "plan3.json"), JSON.stringify({ tasks: [{ title: "A", accept: ["works"], scope: ["a/**"], size: "S" }] }));
  ok(s.run("claude", ["plan", "--tasks", ".collab/plan3.json", "--pr", "3", "--agent", planner]));
  const joins = [["join", "3", "--tool", "claude", "--agent", "__ID__"], ["claim", "__TASK__", "--pr", "3", "--agent", "__ID__"]];
  const k = s.json("owner", ["invite", "claude", "--sessions", "2", "--timeout", "10m", "--pr", "3"], fakeEnv(joins)).data?.keeper;
  assert.ok(k);
  await until(() => status(3).tasks.T1.owner === members(k)[0]?.id, 60_000, "the session to claim T1");
  const c = s.run("owner", ["close", "--purge", "--pr", "3"]);
  ok(c);
  assert.match(c.out, new RegExp(`Stopped the session keeper ${k}\\.`));
  assert.equal(runOf(k).stopReason, "the collab was closed");
  assert.ok(!isAlive(runOf(k).pid));
  // Nothing starts the collab again.
  await new Promise((res) => setTimeout(res, 1500));
  assert.equal(s.run("owner", ["status", "--pr", "3"]).code, 2, "PR #3 has no collab");
  assert.equal(members(k).length, 1);
  ok(s.run("owner", ["stop", "--pr", "3"]));
});

test("a task waiting for a review that no free agent may take gets a session that reviews it", async () => {
  s.fake.update((st) => { st.pulls["o/r#4"] = { ...st.pulls["o/r#1"], number: 4, title: "Fourth PR", body: "Fourth.\n" }; st.comments["o/r#4"] = []; });
  const j = s.run("claude", ["join", "4", "--tool", "claude"]);
  ok(j);
  const builder = s.idOf(j);
  const as4 = (argv) => s.run("claude", [...argv, "--pr", "4", "--agent", builder]);
  writeFileSync(path.join(s.clone("claude"), ".collab", "plan4.json"), JSON.stringify({ tasks: [{ title: "A", accept: ["works"], scope: ["a/**"], size: "S" }] }));
  ok(as4(["plan", "--tasks", ".collab/plan4.json"]));
  ok(as4(["claim", "T1"]));
  const wt = path.join(s.clone("claude"), ".collab", "wt", "pr4-t1");
  mkdirSync(path.join(wt, "a"), { recursive: true });
  writeFileSync(path.join(wt, "a", "x.mjs"), "export const x = 1;\n");
  ok(as4(["push", "T1"]));
  ok(as4(["verify", "T1"]));
  ok(as4(["submit", "T1"]));
  // Only Claude agents have joined, so T1's review is open to Claude at once. Its owner can't
  // review it, and nobody else is free: the keeper starts a session to review it.
  const reviews = [["join", "4", "--tool", "claude", "--agent", "__ID__"], ["review-claim", "__REVIEW__", "--pr", "4", "--agent", "__ID__"]];
  const r = s.run("owner", ["invite", "claude", "--sessions", "2", "--timeout", "10m", "--pr", "4"], fakeEnv(reviews));
  ok(r);
  const m = /Started 1 now: (claude-[a-z0-9]{4}) \(reviews T1\)\./.exec(r.out);
  assert.ok(m, r.out);
  assert.match(r.out, /The sessions review each other's tasks/);
  await until(() => status(4).tasks.T1.reviewer === m[1], 60_000, "the session to claim T1's review");
  assert.match(record(m[1]).prompt, /After joining, review T1: .* review-claim T1 --pr 4/);
  assert.match(statusText(4), new RegExp(`Sessions: 1 of up to 2 Claude Code running: ${m[1]} \\(reviews T1\\)`));
  ok(s.run("owner", ["stop", "--pr", "4"]));
});

test("with no collab yet, one session starts it; the rest start once the plan is posted; the keeper ends when the work does", async () => {
  s.fake.update((st) => { st.pulls["o/r#2"] = { ...st.pulls["o/r#1"], number: 2, title: "Second PR", body: "Second.\n" }; st.comments["o/r#2"] = []; });
  const joins = [["join", "2", "--tool", "claude", "--agent", "__ID__"], ["claim", "__TASK__", "--pr", "2", "--agent", "__ID__"]];
  const r = s.json("owner", ["invite", "claude", "--sessions", "3", "--timeout", "10m", "--pr", "2"], fakeEnv(joins));
  ok(r);
  const k = r.data.keeper;
  assert.equal(r.data.target, 3);
  assert.equal(r.data.host, null);
  assert.deepEqual(r.data.started.map((w) => w.task), [null]);
  assert.match(r.data.why, /no collab yet: one session starts it and writes the plan/);
  const planner = r.data.started[0].agent;
  await until(() => status(2).planner?.agent === planner, 60_000, "the session to start the collab");
  assert.match(statusText(2), new RegExp(`Sessions: 1 of up to 3 Claude Code running: ${planner} \\(starts the plan\\)`));
  // No more sessions while it plans.
  await new Promise((res) => setTimeout(res, 1500));
  assert.equal(members(k).length, 1);
  // It posts a plan of two tasks: it takes one, and one more session starts for the other.
  const dir = path.join(s.clone("claude"), ".collab");
  writeFileSync(path.join(dir, "plan2.json"), JSON.stringify({ tasks: [{ title: "A", accept: ["works"], scope: ["a/**"], size: "S" }, { title: "B", accept: ["works"], scope: ["b/**"], size: "S" }] }));
  ok(s.run("claude", ["plan", "--tasks", ".collab/plan2.json", "--pr", "2", "--agent", planner]));
  await until(() => members(k).length === 2, 30_000, "a session for the second task");
  assert.equal(members(k)[1].task, "T2");
  await new Promise((res) => setTimeout(res, 1500));
  assert.equal(members(k).length, 2, "the planner is free, so T1 is left for it");
  // Once every task is done or cancelled, the keeper exits by itself.
  ok(s.run("claude", ["cancel", "T1", "--reason", "done elsewhere", "--pr", "2", "--agent", planner]));
  await until(() => status(2).tasks.T2.owner === members(k)[1].id, 60_000, "the second session to claim T2");
  ok(s.run("claude", ["cancel", "T2", "--reason", "done elsewhere", "--pr", "2", "--agent", members(k)[1].id]));
  await until(() => runOf(k).stoppedAt, 30_000, "the keeper to exit");
  assert.equal(runOf(k).stopReason, "done");
  // The keeper records stoppedAt and then returns, so its process can outlive the record briefly.
  await until(() => !isAlive(runOf(k).pid), 10_000, "the keeper process to end");
  ok(s.run("owner", ["stop", "--pr", "2"]));
});
