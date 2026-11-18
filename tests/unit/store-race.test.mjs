// Real concurrency: 4 Node processes, each with its own clone, race to increment one ledger.
// Compare-and-swap must serialize them: no lost update and a linear commit chain.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { read, refFor, write } from "../../skills/collab/lib/store.mjs";
import { makeRepo, sh } from "../helpers/bare-remote.mjs";

const WORKERS = 4;
// A write costs about 1s on Windows (8 git spawns), so Windows runs 10 rounds to stay near 60s.
const ROUNDS = Number(process.env.COLLAB_RACE_ROUNDS ?? (process.platform === "win32" ? 10 : 20));
const PR = 77;
const worker = fileURLToPath(new URL("../helpers/race-worker.mjs", import.meta.url));

let repo;
before(() => {
  repo = makeRepo();
});
after(() => repo.cleanup());

function run(clone, agent) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [worker, clone, agent, String(ROUNDS), String(PR)], { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ agent, code, stdout, stderr }));
  });
}

test(`${WORKERS} processes x ${ROUNDS} rounds lose no update`, { timeout: 420_000 }, async () => {
  const agents = Array.from({ length: WORKERS }, (_, i) => `racer${i + 1}`);
  const clones = agents.map((name) => repo.clone(name));
  const setup = clones[0];
  write({ cwd: setup, pr: PR, agent: "setup", mutate: () => ({ ledger: { seq: 0, counter: 0, log: [] }, events: [] }) });
  const started = Date.now();
  const results = await Promise.all(agents.map((agent, i) => run(clones[i], agent)));
  const seconds = (Date.now() - started) / 1000;

  for (const r of results) assert.equal(r.code, 0, `${r.agent} failed:\n${r.stderr}`);
  const stats = results.map((r) => JSON.parse(r.stdout));
  const total = WORKERS * ROUNDS;

  const { ledger } = read({ cwd: setup, pr: PR, agent: "setup" });
  assert.equal(ledger.counter, total);
  assert.equal(ledger.seq, total);
  assert.equal(ledger.log.length, total);
  for (const agent of agents) assert.equal(ledger.log.filter((x) => x === agent).length, ROUNDS, agent);

  const links = sh(["rev-list", "--parents", refFor(PR)], repo.remote).split(/\r?\n/).map((l) => l.split(" "));
  assert.equal(links.length, total + 1, "one commit per update plus the create");
  assert.ok(links.slice(0, -1).every((l) => l.length === 2), "every update has exactly one parent");
  assert.equal(links.at(-1).length, 1, "the create has no parent");

  const attempts = stats.reduce((n, s) => n + s.attempts, 0);
  console.log(`race: ${total} writes, ${attempts - total} lost races, ${seconds.toFixed(1)}s`);
});
