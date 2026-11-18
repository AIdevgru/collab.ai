// Use case: tests/use-cases/collab-owner.md
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { setup } from "../helpers/cli-env.mjs";
import { sh } from "../helpers/bare-remote.mjs";

let s;
let ids;
const ok = (r) => assert.equal(r.code, 0, r.out);
const say = (login, body) => s.fake.update((st) => {
  const id = st.nextId++;
  st.comments["o/r#1"].push({ id, login, body, createdAt: new Date().toISOString() });
});
const ledger = () => JSON.parse(s.as("claude", ids.claude, ["status", "--json"]).stdout);
const comments = () => s.fake.read().comments["o/r#1"];
const owner = (argv, env = {}) => s.run("owner", [...argv, "--pr", "1"], env);

before(() => {
  s = setup();
  ids = s.start([
    { title: "Cache layer", accept: ["works"], scope: ["src/cache.mjs"], size: "S" },
    { title: "Docs", accept: ["works"], scope: ["docs/**"], size: "S" },
  ], ["codex"]);
});
after(() => s.cleanup());

test("a /collab pause comment from someone with read access is ignored", () => {
  say("reader", "/collab pause");
  const r = s.as("codex", ids.codex, ["next"]);
  ok(r);
  assert.equal(ledger().phase, "active");
});

test("a /collab resume comment is ignored: comments can only stop work", () => {
  say("zwymer", "/collab resume please");
  ok(s.as("codex", ids.codex, ["next"]));
  assert.equal(ledger().phase, "active");
});

test("a /collab pause comment from a write-access login pauses every agent", () => {
  say("zwymer", "Hold on.\n/collab pause");
  const a = s.as("codex", ids.codex, ["next"]);
  assert.equal(a.code, 4, a.out);
  assert.match(a.out, /paused/);
  const b = s.as("claude", ids.claude, ["next"]);
  assert.equal(b.code, 4, b.out);
  const claim = s.as("claude", ids.claude, ["claim", "T1"]);
  assert.notEqual(claim.code, 0, claim.out);
});

test("owner-only commands are refused inside an agent session", () => {
  for (const env of [{ CLAUDECODE: "1" }, { CODEX_THREAD_ID: "t-1" }, { COLLAB_AGENT: ids.codex }]) {
    const r = owner(["resume"], env);
    assert.equal(r.code, 2, `${JSON.stringify(env)}: ${r.out}`);
    assert.match(r.out, /owner-only command; run it in your own terminal/);
  }
  assert.equal(ledger().phase, "paused");
});

test("the owner resumes from their own terminal", () => {
  ok(owner(["resume"]));
  assert.equal(ledger().phase, "active");
  ok(s.as("codex", ids.codex, ["next"]));
});

test("block --owner posts one Needs owner notice per question; decide unblocks and next hands the answer to the agent", () => {
  ok(s.as("codex", ids.codex, ["claim", "T1"]));
  ok(s.as("codex", ids.codex, ["block", "T1", "--reason", "LRU or TTL eviction?", "--owner"]));
  ok(s.as("codex", ids.codex, ["next"]));
  const asked = () => comments().filter((c) => c.body.startsWith("<!-- collab:notice key=needs-owner:T1:"));
  const notices = asked();
  assert.equal(notices.length, 1);
  assert.match(notices[0].body, /LRU or TTL eviction\?/);
  assert.match(notices[0].body, /collab decide T1 "<answer>" --pr 1/);
  assert.ok(ledger().tasks.T1.blocked?.needsOwner);
  ok(owner(["decide", "T1", "TTL, 5 minutes"]));
  const t = ledger().tasks.T1;
  assert.equal(t.blocked, null);
  assert.equal(t.decision.text, "TTL, 5 minutes");
  assert.ok(comments().some((c) => /Owner decision on T1:\*\* TTL, 5 minutes/.test(c.body)));
  // The agent can't read the PR: next prints the owner's answer with the task.
  const n = s.json("codex", ["next", "--pr", "1", "--agent", ids.codex]);
  ok(n);
  assert.equal(n.data.task, "T1");
  assert.equal(n.data.decision.text, "TTL, 5 minutes");
  assert.match(s.as("codex", ids.codex, ["next"]).out, /Owner's decision on T1 \(.*\): TTL, 5 minutes/);
  // A second question on the same task gets its own notice.
  const second = s.as("codex", ids.codex, ["block", "T1", "--reason", "Cap the cache at 100 or 1000 entries?", "--owner"]);
  ok(second);
  assert.match(second.out, /the owner has been asked to decide/);
  assert.equal(asked().length, 2);
  assert.match(asked()[1].body, /Cap the cache at 100 or 1000 entries\?/);
  ok(s.as("codex", ids.codex, ["next"]));
  assert.equal(asked().length, 2, "still one notice per question");
  ok(owner(["decide", "T1", "1000"]));
  assert.match(s.as("codex", ids.codex, ["next"]).out, /Owner's decision on T1 \(.*\): 1000/);
});

test("a /collab cancel T2 comment cancels that task", () => {
  say("zwymer", "/collab cancel T2");
  ok(s.as("claude", ids.claude, ["next"]));
  const l = ledger();
  assert.equal(l.tasks.T2.status, "cancelled");
});

test("push while paused is refused before anything reaches GitHub", () => {
  const wt = path.join(s.clone("codex"), ".collab", "wt", "pr1-t1");
  mkdirSync(path.join(wt, "src"), { recursive: true });
  writeFileSync(path.join(wt, "src", "cache.mjs"), "export const cache = new Map();\n");
  say("zwymer", "/collab pause");
  const pulls = Object.keys(s.fake.read().pulls).length;
  const r = s.as("codex", ids.codex, ["push", "T1"]);
  assert.equal(r.code, 4, r.out);
  assert.match(r.out, /paused/);
  assert.equal(Object.keys(s.fake.read().pulls).length, pulls, "no sub-PR was opened");
  assert.equal(sh(["ls-remote", "origin", "refs/heads/collab/pr-1/t1"], s.clone("codex")), "", "the branch was not pushed");
  ok(owner(["resume"]));
});

test("push reuses an open sub-PR the ledger never recorded", () => {
  // As if an earlier push opened sub-PR #40 and then lost its ledger write.
  s.fake.update((st) => {
    st.pulls["o/r#40"] = { title: "[#1 T1] Cache layer", body: "Part of #1", state: "open", draft: true, headRef: "collab/pr-1/t1", baseRef: "feat/x", author: "zwymer" };
  });
  const pulls = Object.keys(s.fake.read().pulls).length;
  const r = s.as("codex", ids.codex, ["push", "T1"]);
  ok(r);
  assert.match(r.out, /sub-PR #40/);
  assert.equal(Object.keys(s.fake.read().pulls).length, pulls, "no duplicate sub-PR");
  assert.equal(ledger().tasks.T1.subPr, 40);
});

test("close keeps the ledger marked closed so agents stop; --purge deletes it", () => {
  const c = s.json("owner", ["close", "--pr", "1"]);
  ok(c);
  const archive = JSON.parse(readFileSync(c.data.archive, "utf8"));
  assert.equal(archive.ledger.phase, "closed");
  assert.equal(archive.history[0].event.type, "phase.set", "the archive's history includes the close itself");
  assert.match(sh(["ls-remote", "origin", "refs/collab/*"], s.clone("claude")), /refs\/collab\/pr-1/);
  const n = s.as("codex", ids.codex, ["next"]);
  assert.equal(n.code, 4, n.out);
  assert.match(n.out, /closed/);
  const j = s.run("gemini", ["join", "1", "--tool", "gemini"]);
  assert.equal(j.code, 4, j.out);
  assert.match(j.out, /closed the collab/);
  ok(owner(["close", "--purge"]));
  assert.equal(sh(["ls-remote", "origin", "refs/collab/*"], s.clone("claude")), "");
});

test("a new collab on the same PR ignores the pause and cancel comments written for the old one", () => {
  // The PR still carries "/collab pause" and "/collab cancel T2" from the collab that was purged.
  assert.ok(comments().some((c) => /^\/collab cancel T2/m.test(c.body)));
  const j = s.run("claude", ["join", "1", "--tool", "claude"]);
  ok(j);
  ids.claude = s.idOf(j);
  ok(s.run("claude", ["plan", "--tasks", ".collab/plan.json", "--pr", "1", "--agent", ids.claude]));
  ok(s.as("claude", ids.claude, ["next"]));
  const l = ledger();
  assert.equal(l.phase, "active");
  assert.equal(l.tasks.T2.status, "open");
  // A comment written after the new collab started still counts.
  say("zwymer", "/collab cancel T2");
  ok(s.as("claude", ids.claude, ["next"]));
  assert.equal(ledger().tasks.T2.status, "cancelled");
});
