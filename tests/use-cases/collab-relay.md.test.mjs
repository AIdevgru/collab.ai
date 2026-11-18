// Use case: tests/use-cases/collab-relay.md
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { setup } from "../helpers/cli-env.mjs";
import { relayDir, request } from "../../skills/collab/lib/relay.mjs";

let s;
let ids;
let relay;
let relay2;
const SANDBOX = { COLLAB_RELAY: "1" };

async function until(fn, ms = 30_000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 100));
  }
}

before(() => {
  s = setup();
  ids = s.start([{ title: "Slugify", accept: ["works"], scope: ["src/slug.mjs"], size: "S" }], ["codex"]);
});
after(async () => {
  for (const r of [relay, relay2]) {
    if (!r) continue;
    r.child.kill();
    await r;
  }
  s.cleanup();
});

test("with no relay running, a sandboxed call fails at once with exit 5", () => {
  const r = s.as("codex", ids.codex, ["next"], SANDBOX);
  assert.equal(r.code, 5, r.out);
  assert.match(r.out, /collab relay/);
});

test("the relay runs allowlisted commands for its agent and returns the same output", async () => {
  relay = s.runAsync("codex", ["relay", "--agent", ids.codex, "--timeout", "5m"]);
  await until(() => existsSync(path.join(relayDir(s.clone("codex")), `alive-${ids.codex}`)));
  const n = s.as("codex", ids.codex, ["next"], SANDBOX);
  assert.equal(n.code, 0, n.out);
  assert.match(n.out, /Next: claim T1/);
  const c = s.as("codex", ids.codex, ["claim", "T1"], SANDBOX);
  assert.equal(c.code, 0, c.out);
  assert.ok(existsSync(path.join(s.clone("codex"), ".collab", "wt", "pr1-t1")));
  const status = JSON.parse(s.run("claude", ["status", "--json", "--pr", "1"]).stdout);
  assert.equal(status.tasks.T1.owner, ids.codex);
});

test("a relay pinned to one agent refuses to act for another", async () => {
  // Another agent's sandboxed call finds no relay of its own and fails at once.
  const r = s.as("codex", ids.claude, ["next"], SANDBOX);
  assert.equal(r.code, 5, r.out);
  assert.match(r.out, new RegExp(`no collab relay is running for ${ids.claude}`));
  // A request that reaches the inbox anyway is refused by the pinned relay.
  const sneaky = await request(s.clone("codex"), { argv: ["next", "--pr", "1", "--agent", ids.claude], cwd: s.clone("codex"), timeoutMs: 60_000 });
  assert.notEqual(sneaky.code, 0);
  assert.match(sneaky.stderr, new RegExp(`only acts for ${ids.codex}`));
});

test("the relay refuses owner commands, other tools and paths outside the repo", async () => {
  const root = s.clone("codex");
  for (const argv of [["resume", "--pr", "1"], ["invite", "codex"], ["relay"], ["doctor"]]) {
    const r = await request(root, { argv, agent: ids.codex, cwd: root, timeoutMs: 30_000 });
    assert.notEqual(r.code, 0, argv.join(" "));
    assert.match(r.stderr, /the relay does not run `collab /, argv.join(" "));
  }
  const outside = await request(root, { argv: ["plan", "--tasks", path.resolve(root, "..", "plan.json"), "--pr", "1"], agent: ids.codex, cwd: root, timeoutMs: 30_000 });
  assert.notEqual(outside.code, 0);
  assert.match(outside.stderr, /inside the repo/i);
});

test("two invited Codex agents in one repo each get answers from their own relay", async () => {
  const root = s.clone("codex");
  // Its relay starts first, as collab invite does; the other relay would refuse its join.
  relay2 = s.runAsync("codex", ["relay", "--agent", "codex-two2", "--timeout", "5m"]);
  await new Promise((r) => setTimeout(r, 1500));
  const j = s.run("codex", ["join", "1", "--tool", "codex", "--agent", "codex-two2"], SANDBOX);
  assert.equal(j.code, 0, j.out);
  for (let i = 0; i < 4; i++) {
    for (const agent of [ids.codex, "codex-two2"]) {
      const r = s.as("codex", agent, ["status"], SANDBOX);
      assert.equal(r.code, 0, `${agent}, round ${i + 1}: ${r.out}`);
    }
  }
  relay.child.kill();
  await relay;
  relay = null;
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(existsSync(path.join(relayDir(root), "alive-codex-two2")), "the second relay's heartbeat survives the first one stopping");
  const r = s.as("codex", "codex-two2", ["status"], SANDBOX);
  assert.equal(r.code, 0, r.out);
});

test("a relay started with a key runs only requests its own agent signed", async () => {
  const root = s.clone("codex");
  const KEY = { COLLAB_RELAY_KEY: "k".repeat(64) };
  // As collab invite codex does: the relay and its one agent share the key in their environments.
  relay = s.runAsync("codex", ["relay", "--agent", "codex-key3", "--timeout", "5m"], KEY);
  await until(() => existsSync(path.join(relayDir(root), "alive-codex-key3")));
  const j = s.run("codex", ["join", "1", "--tool", "codex", "--agent", "codex-key3"], { ...SANDBOX, ...KEY });
  assert.equal(j.code, 0, j.out);
  const mine = s.as("codex", "codex-key3", ["status"], { ...SANDBOX, ...KEY });
  assert.equal(mine.code, 0, mine.out);
  // Another agent drops a request in the inbox naming that id: without the key it is refused.
  const forged = await request(root, { argv: ["status", "--pr", "1"], agent: "codex-key3", cwd: root, timeoutMs: 30_000 });
  assert.notEqual(forged.code, 0);
  assert.match(forged.stderr, /only runs requests signed by the agent it was started for/);
  const wrong = await request(root, { argv: ["status", "--pr", "1"], agent: "codex-key3", cwd: root, timeoutMs: 30_000, key: "x".repeat(64) });
  assert.notEqual(wrong.code, 0);
});
