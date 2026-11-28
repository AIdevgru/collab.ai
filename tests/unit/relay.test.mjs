import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, mkdirSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { isSandboxed, relayAlive, request, serve, validate, writeAtomic, RELAY_ALLOW } from "../../skills/collab/lib/relay.mjs";
import { EXIT } from "../../skills/collab/lib/errors.mjs";

const tmp = () => mkdtempSync(path.join(tmpdir(), "collab-relay-"));

test("validate allows only agent commands", () => {
  const root = tmp();
  try {
    assert.equal(validate(root, { v: 1, argv: ["next", "--pr", "1"], cwd: "." }).ok, true);
    assert.equal(validate(root, { v: 1, argv: ["diff", "T1", "--stat"], cwd: "." }).ok, true, "reviewers read diffs through the relay");
    assert.equal(validate(root, { v: 1, argv: ["msg", "all", "--body", "hi"], cwd: "." }).ok, true, "sandboxed agents can message the others");
    assert.equal(validate(root, { v: 1, argv: ["inbox", "--peek"], cwd: "." }).ok, true);
    assert.equal(validate(root, { v: 1, argv: ["msg", "all", "--body-file", "../outside.md"], cwd: "." }).ok, false, "a message body is read from inside the repo only");
    for (const cmd of ["invite", "relay", "doctor", "resume", "decide", "waive-review", "stop", "close", "rm"]) {
      const v = validate(root, { v: 1, argv: [cmd], cwd: "." });
      assert.equal(v.ok, false, cmd);
      assert.equal(v.code, EXIT.PRECONDITION);
    }
    assert.ok(!RELAY_ALLOW.includes("invite"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("validate runs the agent plan-session subcommands and refuses the owner ones", () => {
  const root = tmp();
  try {
    const run = (argv) => validate(root, { v: 1, argv, cwd: "." });
    for (const sub of ["list", "new", "join", "pull", "show", "edit", "say", "agree", "leave", "next", "wait", "status", "handoff"]) {
      assert.equal(run(["plan", sub, "57"]).ok, true, sub);
    }
    assert.equal(run(["plan"]).ok, true, "no subcommand");
    assert.equal(run(["plan", "--tasks", ".collab/plan.json", "--pr", "1"]).ok, true, "the PR planner's collab plan --tasks");
    assert.equal(run(["plan", "--json", "agree", "57", "--withdraw"]).ok, true, "boolean flags don't swallow the subcommand");
    assert.equal(run(["plan", "--agent", "codex-ab12", "show", "57", "--raw"]).ok, true);
    for (const argv of [["plan", "close", "57"], ["plan", "remove", "57", "bob"], ["plan", "reopen", "57"], ["plan", "frobnicate"], ["plan", "--json", "close", "57"], ["plan", "--all", "reopen", "57"], ["plan", "Close", "57"]]) {
      const v = run(argv);
      assert.equal(v.ok, false, argv.join(" "));
      assert.equal(v.code, EXIT.PRECONDITION);
      assert.match(v.message, /^the relay does not run `collab plan \S+` \(owner commands need the owner's own terminal\)$/, argv.join(" "));
    }
    // An unknown flag takes the next word as its value, the same way the CLI parses it.
    assert.equal(run(["plan", "--mystery", "close", "57"]).ok, false, "the subcommand is then 57");
    assert.equal(run(["plan", "edit", "57", "--body-file", "../outside.md"]).ok, false, "file arguments stay inside the repo");
    assert.match(run(["plan", "edit", "57", "--body-file=../outside.md"]).message, /--body-file must point inside the repo/);
    assert.equal(run(["plan", "edit", "57", "--body-file", ".collab/plans/57/draft.md"]).ok, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("validate keeps cwd and file arguments inside the repo", () => {
  const root = tmp();
  try {
    assert.equal(validate(root, { v: 1, argv: ["next"], cwd: "../elsewhere" }).ok, false);
    assert.equal(validate(root, { v: 1, argv: ["plan", "--tasks", "../../secrets.json"], cwd: "." }).ok, false);
    assert.equal(validate(root, { v: 1, argv: ["plan", "--tasks=../x.json"], cwd: "." }).ok, false);
    assert.equal(validate(root, { v: 1, argv: ["plan", "--tasks", ".collab/plan.json"], cwd: "." }).ok, true);
    assert.equal(validate(root, { v: 1, argv: ["review", "T1", "--body-file", "r.md"], cwd: ".collab/wt/pr1-t1" }).ok, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a relay pinned to one agent refuses to act for another", () => {
  const root = tmp();
  try {
    const fixedAgent = "codex-ab12";
    assert.equal(validate(root, { v: 1, argv: ["next", "--agent", "claude-zz99"], cwd: "." }, { fixedAgent }).ok, false);
    assert.equal(validate(root, { v: 1, argv: ["next"], agent: "claude-zz99", cwd: "." }, { fixedAgent }).ok, false);
    assert.equal(validate(root, { v: 1, argv: ["next", "--agent", fixedAgent], cwd: "." }, { fixedAgent }).ok, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("COLLAB_RELAY forces relay mode, COLLAB_RELAYED never relays again", () => {
  assert.equal(isSandboxed(process.cwd(), { COLLAB_RELAY: "1" }), true);
  assert.equal(isSandboxed(process.cwd(), { COLLAB_RELAY: "1", COLLAB_RELAYED: "1" }), false);
});

test("a request with no live relay fails fast with guidance", async () => {
  const root = tmp();
  try {
    assert.equal(relayAlive(root), false);
    await assert.rejects(request(root, { argv: ["next"], agent: "codex-ab12" }), (e) => e.code === EXIT.ENV && /collab relay/.test(e.message));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("request and serve round-trip, with the agent id and relayed env applied", async () => {
  const root = tmp();
  mkdirSync(path.join(root, ".collab"), { recursive: true });
  const ac = new AbortController();
  const seen = [];
  const relay = serve(root, {
    fixedAgent: "codex-ab12",
    signal: ac.signal,
    pollMs: 50,
    runCollab: (argv, { env, cwd }) => {
      seen.push({ argv, relayed: env.COLLAB_RELAYED, agent: env.COLLAB_AGENT, cwd });
      return { code: 0, stdout: `ran ${argv.join(" ")}\n`, stderr: "" };
    },
  });
  try {
    for (let i = 0; i < 40 && !relayAlive(root); i++) await new Promise((r) => setTimeout(r, 25));
    const res = await request(root, { argv: ["next", "--pr", "7"], agent: "codex-ab12", pollMs: 30, timeoutMs: 5000 });
    assert.equal(res.code, 0);
    assert.match(res.stdout, /ran next --pr 7 --agent codex-ab12/);
    assert.deepEqual(seen[0].argv, ["next", "--pr", "7", "--agent", "codex-ab12"]);
    assert.equal(seen[0].relayed, "1");
    assert.equal(seen[0].agent, "codex-ab12");

    const denied = await request(root, { argv: ["invite", "codex"], agent: "codex-ab12", pollMs: 30, timeoutMs: 5000 });
    assert.equal(denied.code, EXIT.PRECONDITION);
    assert.match(denied.stderr, /does not run `collab invite/);
    assert.equal(seen.length, 1);
  } finally {
    ac.abort();
    await relay;
    rmSync(root, { recursive: true, force: true });
  }
});

test("the heartbeat keeps beating while a slow relayed command runs", async () => {
  const root = tmp();
  mkdirSync(path.join(root, ".collab"), { recursive: true });
  const ac = new AbortController();
  const alive = path.join(root, ".collab", "relay", "alive-codex-ab12");
  const beats = new Set();
  const relay = serve(root, {
    fixedAgent: "codex-ab12",
    signal: ac.signal,
    pollMs: 20,
    beatMs: 50,
    // A slow command, like verify running npm test.
    runCollab: () => new Promise((resolve) => {
      const t = setInterval(() => { try { beats.add(JSON.parse(readFileSync(alive, "utf8")).at); } catch { /* mid-write */ } }, 40);
      setTimeout(() => { clearInterval(t); resolve({ code: 0, stdout: "slow\n", stderr: "" }); }, 1200);
    }),
  });
  try {
    for (let i = 0; i < 40 && !relayAlive(root); i++) await new Promise((r) => setTimeout(r, 25));
    const res = await request(root, { argv: ["verify", "T1", "--pr", "7"], agent: "codex-ab12", pollMs: 20, timeoutMs: 5000 });
    assert.equal(res.code, 0);
    assert.ok(beats.size >= 3, `alive was rewritten ${beats.size} times during a 1.2 s command (about 24 are due)`);
  } finally {
    ac.abort();
    await relay;
    rmSync(root, { recursive: true, force: true });
  }
});

test("writeAtomic retries a rename Windows refuses while the file is open", () => {
  const root = tmp();
  try {
    const file = path.join(root, "alive");
    let calls = 0;
    const flaky = (a, b) => {
      calls++;
      if (calls < 3) throw Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" });
      renameSync(a, b);
    };
    writeAtomic(file, "beat", { rename: flaky });
    assert.equal(calls, 3);
    assert.equal(readFileSync(file, "utf8"), "beat");
    const always = () => { throw Object.assign(new Error("EPERM"), { code: "EPERM" }); };
    assert.throws(() => writeAtomic(file, "next", { rename: always, tries: 3 }), /EPERM/);
    assert.deepEqual(readdirSync(root), ["alive"], "a failed write leaves no temp file behind");
    const other = () => { throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" }); };
    assert.throws(() => writeAtomic(file, "x", { rename: other }), /ENOSPC/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("two pinned relays in one repo each serve their own agent and share the heartbeat", async () => {
  const root = tmp();
  mkdirSync(path.join(root, ".collab"), { recursive: true });
  const acA = new AbortController();
  const acB = new AbortController();
  const ran = { "codex-aaaa": [], "codex-bbbb": [] };
  const relay = (agent, ac) => serve(root, {
    fixedAgent: agent, signal: ac.signal, pollMs: 15, beatMs: 30,
    runCollab: (argv) => { ran[agent].push(argv[0]); return { code: 0, stdout: `${agent} ran ${argv[0]}\n`, stderr: "" }; },
  });
  const a = relay("codex-aaaa", acA);
  const b = relay("codex-bbbb", acB);
  try {
    for (let i = 0; i < 40 && !relayAlive(root); i++) await new Promise((r) => setTimeout(r, 25));
    for (let i = 0; i < 6; i++) {
      for (const agent of ["codex-aaaa", "codex-bbbb"]) {
        const res = await request(root, { argv: ["status"], agent, pollMs: 15, timeoutMs: 5000 });
        assert.equal(res.code, 0, res.stderr);
        assert.match(res.stdout, new RegExp(`^${agent} ran status`));
      }
    }
    assert.equal(ran["codex-aaaa"].length, 6);
    assert.equal(ran["codex-bbbb"].length, 6);
    acA.abort();
    await a;
    await new Promise((r) => setTimeout(r, 80));
    assert.ok(relayAlive(root, { agent: "codex-bbbb" }), "the other relay's heartbeat survives the first relay stopping");
    assert.equal(relayAlive(root, { agent: "codex-aaaa" }), false, "the stopped relay's heartbeat is gone");
  } finally {
    acA.abort();
    acB.abort();
    await Promise.all([a, b]);
    rmSync(root, { recursive: true, force: true });
  }
});

test("a pinned relay refuses another agent's request once nobody else has taken it", async () => {
  const root = tmp();
  mkdirSync(path.join(root, ".collab"), { recursive: true });
  const ac = new AbortController();
  const relay = serve(root, { fixedAgent: "codex-aaaa", signal: ac.signal, pollMs: 15, othersMs: 200, runCollab: () => ({ code: 0, stdout: "ran\n", stderr: "" }) });
  try {
    for (let i = 0; i < 40 && !relayAlive(root); i++) await new Promise((r) => setTimeout(r, 25));
    const started = Date.now();
    // A client for another agent fails fast (no relay of its own); one that names the agent only in
    // --agent still reaches the inbox, and the pinned relay refuses it after the wait.
    await assert.rejects(request(root, { argv: ["status"], agent: "codex-zzzz", pollMs: 15, timeoutMs: 5000 }), (e) => e.code === EXIT.ENV && /for codex-zzzz/.test(e.message));
    const res = await request(root, { argv: ["status", "--agent", "codex-zzzz"], pollMs: 15, timeoutMs: 5000 });
    assert.equal(res.code, EXIT.PRECONDITION);
    assert.ok(Date.now() - started >= 180, "it waited for the other agent's relay first");
  } finally {
    ac.abort();
    await relay;
    rmSync(root, { recursive: true, force: true });
  }
});

test("a relay with a key only runs requests signed with it, each id once", async () => {
  const { sign, newKey } = await import("../../skills/collab/lib/relay.mjs");
  const root = process.cwd();
  const key = newKey();
  const seen = new Set();
  const req = { v: 1, id: "100-aa", argv: ["next", "--pr", "1"], agent: "codex-ab12", cwd: "." };
  const opts = { fixedAgent: "codex-ab12", key, seen };
  // Unsigned, signed with another key, or changed after signing: refused.
  assert.match(validate(root, req, opts).message, /only runs requests signed by the agent/);
  assert.equal(validate(root, { ...req, mac: sign(newKey(), req) }, opts).ok, false);
  const good = { ...req, mac: sign(key, req) };
  assert.equal(validate(root, { ...good, argv: ["review", "T1", "--approve"] }, opts).ok, false);
  assert.equal(validate(root, { ...good, agent: "claude-zz99" }, opts).ok, false);
  assert.equal(validate(root, { ...good, mac: 7 }, opts).ok, false);
  // The real one runs once; a copy of the same file does not run again.
  assert.equal(validate(root, good, opts).ok, true);
  assert.match(validate(root, good, opts).message, /already run/);
  // A relay with no key (the owner's own) takes unsigned requests, as before.
  assert.equal(validate(root, req, { fixedAgent: "codex-ab12" }).ok, true);
});
