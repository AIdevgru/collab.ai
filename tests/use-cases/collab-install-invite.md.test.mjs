// Use case: tests/use-cases/collab-install-invite.md
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { setup } from "../helpers/cli-env.mjs";
import { install, uninstall } from "../../scripts/install.mjs";
import { isAlive, killTree, listRuns } from "../../skills/collab/lib/agents.mjs";

const FAKE = fileURLToPath(new URL("../helpers/fake-agent.mjs", import.meta.url));
const CLI = fileURLToPath(new URL("../../skills/collab/bin/collab.mjs", import.meta.url));
const SKILL_MD = fileURLToPath(new URL("../../skills/collab/SKILL.md", import.meta.url));
let s;
let ids;
let userHome;
let logDir;
const fakeEnv = (actions = []) => ({
  COLLAB_CLAUDE: JSON.stringify([process.execPath, FAKE]),
  COLLAB_CODEX: JSON.stringify([process.execPath, FAKE]),
  FAKE_AGENT_LOG: logDir,
  FAKE_COLLAB_CLI: CLI,
  FAKE_AGENT_ACTIONS: JSON.stringify(actions),
});
const owner = (argv, env = {}) => s.run("owner", [...argv, "--pr", "1"], env);
const record = (agent) => JSON.parse(readFileSync(path.join(logDir, `${agent}.json`), "utf8"));
const runOf = (agent) => listRuns({ COLLAB_HOME: s.home }).find((r) => r.id === agent);

async function until(fn, ms = 60_000) {
  const end = Date.now() + ms;
  for (;;) {
    try { if (fn()) return; } catch { /* not yet */ }
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 200));
  }
}

before(() => {
  userHome = mkdtempSync(path.join(tmpdir(), "collab-user-"));
  mkdirSync(path.join(userHome, ".codex"));
  s = setup();
  logDir = path.join(s.home, "fake-agents");
  mkdirSync(logDir, { recursive: true });
  ids = s.start([
    { title: "Core", accept: ["works"], scope: ["src/core.mjs"], size: "S" },
    { title: "Docs", accept: ["works"], scope: ["docs/**"], deps: ["T1"], size: "S" },
  ], []);
});
after(async () => {
  for (const r of listRuns({ COLLAB_HOME: s.home })) for (const p of [r.pid, r.relayPid, r.watchdogPid]) killTree(p);
  await new Promise((r) => setTimeout(r, 500));
  uninstall({ home: userHome });
  rmSync(userHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  assert.ok(existsSync(SKILL_MD), "the real skill folder survives cleanup");
  s.cleanup();
});

test("install links the skill for Claude, Codex and the launcher, and doctor sees it", () => {
  install({ home: userHome });
  for (const p of [".claude/skills/collab/SKILL.md", ".codex/skills/collab/SKILL.md", ".collab/skill/PROTOCOL.md", ".collab/bin/collab.mjs", ".collab/install.json"]) {
    assert.ok(existsSync(path.join(userHome, p)), p);
  }
  const v = spawnSync(process.execPath, [path.join(userHome, ".collab", "bin", "collab.mjs"), "--version"], { encoding: "utf8" });
  assert.equal(v.status, 0, v.stderr);
  assert.match(v.stdout, /^collab \d+\.\d+\.\d+/);
  const env = { COLLAB_USER_HOME: userHome, COLLAB_HOME: path.join(userHome, ".collab") };
  const d = s.run("owner", ["doctor"], env);
  assert.match(d.out, /OK {4}skill for Claude Code/);
  assert.match(d.out, /OK {4}skill for Codex/);
  assert.match(d.out, /OK {4}launcher/);
  const missing = s.run("owner", ["doctor"], { COLLAB_USER_HOME: mkdtempSync(path.join(tmpdir(), "collab-empty-")), COLLAB_HOME: path.join(tmpdir(), "collab-nohome-x") });
  assert.equal(missing.code, 5, missing.out);
  assert.match(missing.out, /FAIL {2}launcher/);
});

test("invite codex starts a pinned relay and a sandboxed codex that works through it", async () => {
  const r = s.json("owner", ["invite", "codex", "--timeout", "8m", "--pr", "1"], fakeEnv());
  assert.equal(r.code, 0, r.out);
  const agent = r.data.agent;
  assert.match(agent, /^codex-[a-z0-9]{4}$/);
  await until(() => record(agent));
  const rec = record(agent);
  const root = s.clone("owner");
  assert.deepEqual(rec.argv.slice(0, 5), ["exec", "-C", path.join(root, ".collab"), "-s", "workspace-write"]);
  assert.ok(rec.argv.includes("--json") && rec.argv.at(-1) === "-", rec.argv.join(" "));
  assert.equal(rec.env.COLLAB_AGENT, agent);
  assert.equal(rec.env.COLLAB_RELAY, "1");
  assert.match(rec.prompt, new RegExp(`join https://github.com/o/r/pull/1 --tool codex --agent ${agent}`));
  assert.ok(isAlive(runOf(agent).relayPid), "relay running");
  assert.ok(existsSync(path.join(root, ".collab", "relay", `alive-${agent}`)));
  ok(owner(["stop"]));
});

test("invite claude uses the restricted tool lists and passes the task", async () => {
  const r = s.json("owner", ["invite", "claude", "--task", "t1", "--pr", "1"], { ...fakeEnv(), CLAUDECODE: "1" });
  assert.equal(r.code, 0, r.out);
  const agent = r.data.agent;
  await until(() => record(agent));
  const rec = record(agent);
  assert.equal(rec.argv[0], "-p");
  const allowed = rec.argv[rec.argv.indexOf("--allowedTools") + 1];
  const denied = rec.argv[rec.argv.indexOf("--disallowedTools") + 1];
  const launcher = path.join(s.home, "bin", "collab.mjs").replace(/\\/g, "/");
  assert.equal(allowed, `Bash(node "${launcher}":*),Bash(git status:*),Bash(git diff:*),Bash(git log:*),Read,Edit,Write,Glob,Grep`);
  assert.ok(!allowed.includes("Bash(node:*)"), "no blanket node rule: node -e would bypass the deny list");
  assert.ok(rec.prompt.includes(`node "${launcher}" join`), "the prompt uses the allowed launcher path");
  assert.equal(denied, "Bash(git push:*),Bash(git commit:*),Bash(gh pr merge:*),Bash(gh api:*),Bash(gh repo:*)");
  assert.equal(rec.env.CLAUDECODE, null, "the inviting session's markers don't leak");
  assert.equal(rec.env.COLLAB_RELAY, null);
  assert.match(rec.prompt, /claim T1 --pr 1 --agent /);
  assert.ok(isAlive(rec.pid));
  // T1 is set aside for it: another agent is told so and can't claim it first.
  assert.equal(r.data.reserved, "T1");
  const t1 = JSON.parse(s.run("owner", ["status", "--json", "--pr", "1"]).stdout).tasks.T1;
  assert.equal(t1.reserved.agent, agent);
  const n = s.as("claude", ids.claude, ["next"]);
  assert.match(n.out, /Next: wait/);
  assert.match(n.out, new RegExp(`T1 is reserved for ${agent}`));
  const taken = s.as("claude", ids.claude, ["claim", "T1"]);
  assert.equal(taken.code, 2, taken.out);
  assert.match(taken.out, new RegExp(`the owner reserved it for ${agent}`));
});

test("stop is refused inside an agent and stops every invited agent from the owner's terminal", async () => {
  const refused = owner(["stop"], { CODEX_THREAD_ID: "t" });
  assert.equal(refused.code, 2, refused.out);
  assert.match(refused.out, /owner-only/);
  const live = listRuns({ COLLAB_HOME: s.home }).filter((r) => !r.stoppedAt);
  assert.ok(live.length >= 1);
  const r = owner(["stop"]);
  assert.equal(r.code, 0, r.out);
  for (const run of live) {
    assert.match(r.out, new RegExp(run.id));
    await until(() => !isAlive(run.pid), 20_000);
    assert.ok(runOf(run.id).stoppedAt);
  }
  assert.equal(JSON.parse(s.run("owner", ["status", "--json", "--pr", "1"]).stdout).tasks.T1.reserved, null, "stopping it frees the task it was invited for");
});

test("an invited codex works through the relay; at its timeout it is killed and its task freed", async () => {
  const actions = [["join", "1", "--tool", "codex", "--agent", "__ID__"], ["claim", "T1", "--pr", "1", "--agent", "__ID__"]];
  const r = s.json("owner", ["invite", "codex", "--timeout", "75s", "--pr", "1"], fakeEnv(actions));
  assert.equal(r.code, 0, r.out);
  const agent = r.data.agent;
  try {
    await until(() => record(agent).results.length === 2, 120_000);
  } catch (e) {
    const dir = path.join(s.home, "runs", agent);
    const read = (f) => { try { return readFileSync(path.join(dir, f), "utf8"); } catch { return "(none)"; } };
    let got = "(no record)";
    try { got = JSON.stringify(record(agent).results, null, 1); } catch { /* none */ }
    throw new Error(`${e.message}. results: ${got}
relay.out.log:
${read("relay.out.log")}
relay.err.log:
${read("relay.err.log")}`);
  }
  const rec = record(agent);
  for (const x of rec.results) assert.equal(x.code, 0, x.out);
  assert.match(rec.results[0].out, new RegExp(`You are ${agent} `));
  assert.match(rec.results[1].out, /Claimed T1/);
  const owned = JSON.parse(s.run("claude", ["status", "--json", "--pr", "1"]).stdout).tasks.T1;
  assert.equal(owned.owner, agent);
  await until(() => runOf(agent).stoppedAt, 150_000);
  assert.equal(runOf(agent).stopReason, "timeout");
  await until(() => !isAlive(rec.pid), 20_000);
  const n = s.as("claude", ids.claude, ["next"]);
  assert.match(n.out, /Next: reclaim T1/);
});

test("an invited agent whose process exits early is stale at once, so its task can be reclaimed", async () => {
  const actions = [["join", "1", "--tool", "claude", "--agent", "__ID__"], ["claim", "T1", "--steal", "--pr", "1", "--agent", "__ID__"]];
  const r = s.json("owner", ["invite", "claude", "--timeout", "10m", "--pr", "1"], { ...fakeEnv(actions), FAKE_AGENT_EXIT: "1" });
  ok(r);
  const agent = r.data.agent;
  await until(() => record(agent).results.length === 2, 60_000);
  ok({ code: record(agent).results[1].code, out: record(agent).results[1].out });
  await until(() => !isAlive(r.data.pid), 20_000);
  // Its 90-minute lease has barely started, but its process is gone.
  const n = s.as("claude", ids.claude, ["next"]);
  assert.match(n.out, /Next: reclaim T1/);
  assert.match(n.out, new RegExp(`${agent}'s lease on T1 expired`));
  // Its watchdog notices too and closes the run without waiting for the 10-minute timeout.
  await until(() => runOf(agent).stoppedAt, 30_000);
  assert.equal(runOf(agent).stopReason, "exited");
  await until(() => !isAlive(runOf(agent).watchdogPid), 20_000);
});

test("a task reserved for an invited agent is freed once that agent's process exits", async () => {
  const r = s.json("owner", ["invite", "codex", "--task", "T2", "--timeout", "10m", "--pr", "1"], { ...fakeEnv([]), FAKE_AGENT_EXIT: "1" });
  ok(r);
  assert.equal(r.data.reserved, "T2");
  await until(() => !isAlive(r.data.pid), 30_000);
  // The next agent's housekeeping (or the watchdog's stop) releases it.
  await until(() => {
    s.as("claude", ids.claude, ["next"]);
    return JSON.parse(s.run("owner", ["status", "--json", "--pr", "1"]).stdout).tasks.T2.reserved === null;
  }, 30_000);
});

test("invite on a PR with no collab yet: the invited agent starts it and holds the planning lease", async () => {
  // PR #2 has no collab.
  s.fake.update((st) => { st.pulls["o/r#2"] = { ...st.pulls["o/r#1"], number: 2, title: "Second PR", body: "Second.\n" }; st.comments["o/r#2"] = []; });
  const refused = s.json("owner", ["invite", "codex", "--task", "T1", "--pr", "2"], fakeEnv([]));
  assert.equal(refused.code, 2, refused.out);
  assert.match(refused.out, /no collab on PR #2 yet, so no task to give/);
  const r = s.json("owner", ["invite", "codex", "--timeout", "10m", "--pr", "2"], fakeEnv([["join", "2", "--tool", "codex", "--agent", "__ID__"]]));
  ok(r);
  assert.equal(r.data.startsCollab, true);
  const agent = r.data.agent;
  await until(() => record(agent).results.length === 1, 60_000);
  ok({ code: record(agent).results[0].code, out: record(agent).results[0].out });
  const l = JSON.parse(s.run("claude", ["status", "--json", "--pr", "2"]).stdout);
  assert.equal(l.phase, "planning");
  assert.equal(l.planner.agent, agent);
  ok(s.run("owner", ["stop", "--pr", "2"]));
});

function ok(r) {
  assert.equal(r.code, 0, r.out);
}

test("an invited agent keeps the user's own setup but not the inviting session's markers", async () => {
  const { launchSpec } = await import("../../skills/collab/lib/agents.mjs");
  const env = {
    PATH: process.env.PATH ?? "",
    // session markers
    CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_CODE_SSE_PORT: "4123", AI_AGENT: "claude-code",
    CODEX_THREAD_ID: "t-1", CODEX_SESSION_ID: "s-1", CODEX_SANDBOX: "seatbelt", GEMINI_CLI: "1", GEMINI_CLI_IDE_SERVER_PORT: "5000", GROK_SESSION: "x",
    CLAUDE_CODE_SESSION_ACCESS_TOKEN: "session-only", claude_code_entrypoint_lower: "x", COLLAB_AGENT_EXTRA: "x",
    COLLAB_AGENT: "claude-zzzz", COLLAB_RELAY: "1", COLLAB_RELAYED: "1", COLLAB_INVITED_PID: "9",
    // the user's own setup
    CLAUDE_CODE_USE_BEDROCK: "1", CLAUDE_CODE_USE_VERTEX: "1", CLAUDE_CODE_OAUTH_TOKEN: "tok", CLAUDE_CODE_MAX_OUTPUT_TOKENS: "8000",
    CODEX_HOME: "/home/z/.codex-work", CODEX_API_KEY: "key", ANTHROPIC_API_KEY: "key", COLLAB_HOME: "/home/z/.collab",
  };
  // Each tool gets its own vendor's setup only: Claude's token never reaches Codex, or the reverse.
  const own = {
    claude: ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_MAX_OUTPUT_TOKENS"],
    codex: ["CODEX_HOME", "CODEX_API_KEY"],
  };
  const always = ["ANTHROPIC_API_KEY", "COLLAB_HOME"];
  const gone = ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT", "AI_AGENT", "CODEX_THREAD_ID", "CODEX_SESSION_ID", "CODEX_SANDBOX", "GEMINI_CLI", "GEMINI_CLI_IDE_SERVER_PORT", "GROK_SESSION", "CLAUDE_CODE_SESSION_ACCESS_TOKEN", "claude_code_entrypoint_lower", "COLLAB_AGENT_EXTRA", "COLLAB_RELAYED", "COLLAB_INVITED_PID"];
  for (const tool of ["claude", "codex"]) {
    const other = tool === "claude" ? "codex" : "claude";
    const spec = launchSpec(tool, { root: "/repo", runDir: "/runs/x", agent: `${tool}-ab12`, env });
    for (const k of [...own[tool], ...always]) assert.equal(spec.env[k], env[k], `${tool} keeps ${k}`);
    for (const k of [...gone, ...own[other]]) assert.equal(spec.env[k], undefined, `${tool} drops ${k}`);
    assert.equal(spec.env.COLLAB_AGENT, `${tool}-ab12`);
    assert.equal(spec.env.COLLAB_RELAY, tool === "codex" ? "1" : undefined);
  }
});
