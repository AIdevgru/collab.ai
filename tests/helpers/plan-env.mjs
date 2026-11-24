// Helpers for the plan-session use-case tests: several people, each with their own pinned clone,
// on top of cli-env's bare remote and fake gh.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { sh } from "./bare-remote.mjs";
import { setup } from "./cli-env.mjs";

export const ok = (r) => assert.equal(r.code, 0, r.out);
export const sha = (text) => `sha256:${createHash("sha256").update(String(text).replace(/\r\n?/g, "\n")).digest("hex")}`;

export function planSetup({ people = { alice: "write", bob: "read" }, ...rest } = {}) {
  const s = setup({ people, ...rest });
  s.person("zwymer");
  for (const login of Object.keys(people)) s.person(login);
  const ids = {}; // login -> agent id, per session: ids[n][login]

  const run = (login, argv, env) => s.run(login, argv, env);
  // Last JSON line of a --json run.
  const json = (login, argv, env) => s.json(login, argv, env);

  function start(title, extra = [], login = "zwymer") {
    const r = run(login, ["plan", "new", "--title", title, "--tool", "claude", ...extra]);
    ok(r);
    const n = Number(/Plan session #(\d+) is open/.exec(r.out)?.[1]);
    assert.ok(n > 0, r.out);
    (ids[n] ??= {})[login] = s.idOf(r);
    return { n, id: ids[n][login], r };
  }

  function join(login, n, tool = "claude") {
    const r = run(login, ["plan", "join", String(n), "--tool", tool]);
    ok(r);
    (ids[n] ??= {})[login] = s.idOf(r);
    return ids[n][login];
  }

  // `collab plan <sub> <n> …` as that person's agent.
  const plan = (login, sub, n, args = [], env) => run(login, ["plan", sub, String(n), ...args, "--agent", ids[n][login]], env);
  const planJson = (login, sub, n, args = [], env) => json(login, ["plan", sub, String(n), ...args, "--agent", ids[n][login]], env);

  // The ledger as the remote holds it.
  const ledger = (n) => JSON.parse(sh(["show", `refs/collab/plan-${n}:ledger.json`], s.repo.remote));
  const tree = (n) => sh(["ls-tree", "--name-only", `refs/collab/plan-${n}`], s.repo.remote).split(/\r?\n/).filter(Boolean).sort();
  const issue = (n) => s.fake.read().issues[`o/r#${n}`];
  const comments = (n) => s.fake.read().comments?.[`o/r#${n}`] ?? [];
  const hash8 = (n) => { const l = ledger(n); return l.revs[l.current].hash.replace(/^sha256:/, "").slice(0, 8); };

  const draftPath = (login, n, name = "draft.md") => path.join(s.clone(login), ".collab", "plans", String(n), name);
  const readDraft = (login, n, name) => readFileSync(draftPath(login, n, name), "utf8");
  function writeDraft(login, n, text, name) {
    mkdirSync(path.dirname(draftPath(login, n, name)), { recursive: true });
    writeFileSync(draftPath(login, n, name), text);
  }
  // Pull the current revision, change it with fn, publish it.
  function revise(login, n, fn, summary = "a change", extra = []) {
    ok(plan(login, "pull", n, ["--force"]));
    writeDraft(login, n, fn(readDraft(login, n)));
    return planJson(login, "edit", n, ["--summary", summary, ...extra]);
  }
  const raw = (login, n) => plan(login, "show", n, ["--raw"]).stdout;

  return { s, ids, run, json, start, join, plan, planJson, ledger, tree, issue, comments, hash8, draftPath, readDraft, writeDraft, revise, raw, cleanup: () => s.cleanup() };
}
