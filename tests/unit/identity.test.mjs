import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EXIT } from "../../skills/collab/lib/errors.mjs";
import { activeLogin, collabHome, detectTool, isAgentEnv, mintAgentId, pinnedToken, requireOwner, saveAgentFile } from "../../skills/collab/lib/identity.mjs";
import { makeFakeGh } from "../helpers/fake-gh-state.mjs";

// Sets process.env keys (undefined deletes) for the duration of fn, then restores them.
async function withEnv(vars, fn) {
  const prev = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  const apply = (v) => {
    for (const [k, val] of Object.entries(v)) {
      if (val === undefined) delete process.env[k];
      else process.env[k] = val;
    }
  };
  apply(vars);
  try {
    return await fn();
  } finally {
    apply(prev);
  }
}

test("detectTool recognises each agent's env marker", () => {
  const cases = [
    [{ CLAUDECODE: "1" }, "claude"],
    [{ CODEX_THREAD_ID: "t-1" }, "codex"],
    [{ CODEX_SESSION_ID: "s-1" }, "codex"],
    [{ GEMINI_CLI: "1" }, "gemini"],
    [{ GROK_SESSION: "x" }, "grok"],
    [{ GROK_API_KEY: "x" }, "grok"],
    [{ AI_AGENT: "claude-code_2.3.1_agent" }, "claude"],
    [{ AI_AGENT: "codex_0.154" }, "codex"],
    [{ AI_AGENT: "Gemini-cli" }, "gemini"],
    [{ AI_AGENT: "grok-build" }, "grok"],
    [{ AI_AGENT: "cursor" }, null],
    [{ CODEX_CI: "1" }, null], // only the thread/session ids count
    [{ CLAUDECODE: "" }, null],
    [{ PATH: "/usr/bin" }, null],
    [{}, null],
  ];
  for (const [env, want] of cases) assert.equal(detectTool(env), want, JSON.stringify(env));
  // Claude Code sets both; the explicit marker wins.
  assert.equal(detectTool({ CLAUDECODE: "1", AI_AGENT: "codex" }), "claude");
});

test("isAgentEnv is also true under COLLAB_AGENT or COLLAB_RELAYED", () => {
  assert.equal(isAgentEnv({}), false);
  assert.equal(isAgentEnv({ CLAUDECODE: "1" }), true);
  assert.equal(isAgentEnv({ COLLAB_AGENT: "codex-7k2p" }), true);
  assert.equal(isAgentEnv({ COLLAB_RELAYED: "1" }), true);
});

test("requireOwner throws PRECONDITION under CLAUDECODE=1 and passes in a plain terminal", async () => {
  assert.throws(() => requireOwner({ CLAUDECODE: "1" }), (e) => e.code === EXIT.PRECONDITION && e.message === "owner-only command; run it in your own terminal");
  assert.doesNotThrow(() => requireOwner({ PATH: "/bin" }));
  await withEnv({ CLAUDECODE: "1" }, () => {
    assert.throws(() => requireOwner(), (e) => e.code === EXIT.PRECONDITION);
  });
});

test("mintAgentId is <tool>-<4 base36 chars>", () => {
  for (let i = 0; i < 50; i++) assert.match(mintAgentId("codex"), /^codex-[0-9a-z]{4}$/);
  assert.match(mintAgentId(), /^other-[0-9a-z]{4}$/);
});

test("pinnedToken strips GH_TOKEN and GITHUB_TOKEN before asking gh for the login's token", async () => {
  const fake = makeFakeGh({ user: "other", tokens: { zwymer: "tok-z", other: "tok-o" } });
  try {
    await withEnv({ ...fake.env, GH_TOKEN: "tok-o", GITHUB_TOKEN: "tok-o" }, () => {
      assert.equal(pinnedToken("zwymer"), "tok-z");
    });
    const [call] = fake.calls();
    assert.deepEqual(call.argv, ["auth", "token", "--user", "zwymer"]);
    assert.deepEqual(call.env, { GH_TOKEN: null, GITHUB_TOKEN: null });
  } finally {
    fake.cleanup();
  }
});

test("pinnedToken fails with ENV and a next step when gh has no token for the login", async () => {
  const fake = makeFakeGh({ user: "other", tokens: { other: "tok-o" } });
  try {
    await withEnv(fake.env, () => {
      assert.throws(
        () => pinnedToken("zwymer"),
        (e) => e.code === EXIT.ENV && /gh auth login/.test(e.message) && !e.message.includes("tok-o"),
      );
      assert.throws(() => pinnedToken("--hostname"), (e) => e.code === EXIT.ENV);
    });
    assert.equal(fake.calls().length, 1);
  } finally {
    fake.cleanup();
  }
});

test("activeLogin asks gh for the active account without GH_TOKEN", async () => {
  const fake = makeFakeGh({ user: "zwymer", tokens: { zwymer: "tok-z", other: "tok-o" } });
  try {
    await withEnv({ ...fake.env, GH_TOKEN: "tok-o" }, () => {
      assert.equal(activeLogin(), "zwymer");
    });
    assert.equal(fake.calls()[0].env.GH_TOKEN, null);
  } finally {
    fake.cleanup();
  }
  const signedOut = makeFakeGh({ user: null });
  try {
    await withEnv(signedOut.env, () => {
      assert.throws(() => activeLogin(), (e) => e.code === EXIT.ENV && /gh auth login/.test(e.message));
    });
  } finally {
    signedOut.cleanup();
  }
});

test("saveAgentFile writes under COLLAB_HOME and never throws", async () => {
  const home = mkdtempSync(join(tmpdir(), "collab-home-"));
  try {
    await withEnv({ COLLAB_HOME: home }, () => {
      assert.equal(collabHome(), home);
      assert.equal(saveAgentFile("codex-7k2p", { tool: "codex" }), true);
      const file = join(home, "agents", "codex-7k2p.json");
      assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { tool: "codex" });
      assert.equal(saveAgentFile("../escape", {}), false);
      assert.equal(existsSync(join(home, "escape.json")), false);
    });
    const blocker = join(home, "not-a-dir");
    writeFileSync(blocker, "x");
    await withEnv({ COLLAB_HOME: blocker }, () => {
      assert.equal(saveAgentFile("claude-a1f3", { tool: "claude" }), false);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
