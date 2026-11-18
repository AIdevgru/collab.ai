import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { after, before, describe, test } from "node:test";
import { CollabError, EXIT } from "../../skills/collab/lib/errors.mjs";
import {
  cacheRefFor,
  classifyPush,
  commitMessage,
  history,
  read,
  refFor,
  remove,
  write,
} from "../../skills/collab/lib/store.mjs";
import { makeRepo, sh } from "../helpers/bare-remote.mjs";
import { withNow } from "../helpers/clock.mjs";

let repo;
let a; // alice's clone
let b; // bob's clone
before(() => {
  repo = makeRepo();
  a = repo.clone("a");
  b = repo.clone("b");
});
after(() => repo.cleanup());

const tryRev = (cwd, ref) => {
  const r = spawnSync("git", ["rev-parse", "--verify", "--quiet", ref], { cwd, encoding: "utf8", windowsHide: true });
  return r.status === 0 ? r.stdout.trim() : null;
};
const remoteRev = (pr) => tryRev(repo.remote, refFor(pr));
const chain = (pr) => sh(["rev-list", "--parents", refFor(pr)], repo.remote).split(/\r?\n/).map((l) => l.split(" "));

const ev = (agent, type, extra = {}) => ({ v: 1, at: "2026-11-16T12:00:00.000Z", agent, type, data: {}, ...extra });

// mutate that creates { seq, counter, log } or increments it.
const bump = (agent) => (cur) => {
  const l = cur ?? { seq: 0, counter: 0, log: [] };
  return { ledger: { seq: l.seq + 1, counter: l.counter + 1, log: [...l.log, agent] }, events: [ev(agent, "test.inc")] };
};

describe("read and write", () => {
  test("read is null when the PR has no ledger", () => {
    assert.equal(read({ cwd: a, pr: 1, agent: "alice" }), null);
    assert.equal(tryRev(a, cacheRefFor("alice", 1)), null);
  });

  test("write creates one pretty ledger.json, authored by collab (<agent>) at clock time", async () => {
    const res = await withNow("2026-11-16T17:01:02.345Z", () =>
      write({ cwd: a, pr: 2, agent: "alice", mutate: () => ({ ledger: { seq: 1, n: "é" }, events: [ev("alice", "test.create")] }) }),
    );
    assert.equal(res.rev, remoteRev(2));
    assert.equal(tryRev(a, cacheRefFor("alice", 2)), res.rev);
    assert.deepEqual(res.ledger, { seq: 1, n: "é" });
    assert.equal(res.events.length, 1);

    const tree = sh(["ls-tree", res.rev], repo.remote);
    assert.match(tree, /^100644 blob [0-9a-f]{40}\tledger\.json$/);
    assert.equal(sh(["cat-file", "blob", `${res.rev}:ledger.json`], repo.remote), JSON.stringify({ seq: 1, n: "é" }, null, 2));
    const raw = spawnSync("git", ["cat-file", "blob", `${res.rev}:ledger.json`], { cwd: repo.remote, encoding: "utf8" }).stdout;
    assert.ok(raw.endsWith("}\n"));

    const meta = sh(["log", "-1", "--format=%an <%ae>|%cn <%ce>|%aI|%cI|%P", res.rev], repo.remote).split("|");
    assert.deepEqual(meta, [
      "collab (alice) <collab@users.noreply.github.com>",
      "collab (alice) <collab@users.noreply.github.com>",
      "2026-11-16T17:01:02Z",
      "2026-11-16T17:01:02Z",
      "",
    ]);

    assert.deepEqual(read({ cwd: b, pr: 2, agent: "bob" }), { ledger: { seq: 1, n: "é" }, rev: res.rev });
  });

  test("create-only: of two creators exactly one wins, and the other sees the winner on retry", () => {
    const seen = [];
    let bobWon = null;
    const res = write({
      cwd: a,
      pr: 3,
      agent: "alice",
      mutate(cur, rev) {
        seen.push({ cur, rev });
        if (cur) return null; // someone else created it: nothing to do
        // Bob creates the ledger between Alice's read and her push.
        bobWon = write({ cwd: b, pr: 3, agent: "bob", mutate: () => ({ ledger: { creator: "bob" }, events: [ev("bob", "test.create")] }) });
        return { ledger: { creator: "alice" }, events: [ev("alice", "test.create")] };
      },
    });
    assert.equal(seen.length, 2);
    assert.deepEqual(seen[0], { cur: null, rev: null });
    assert.deepEqual(seen[1], { cur: { creator: "bob" }, rev: bobWon.rev });
    assert.deepEqual(res, { ledger: { creator: "bob" }, rev: bobWon.rev, events: [] });
    assert.equal(remoteRev(3), bobWon.rev);
    assert.equal(chain(3).length, 1);
  });

  test("compare-and-swap: a stale update retries on top of the newer ledger", () => {
    write({ cwd: a, pr: 4, agent: "alice", mutate: bump("alice") });
    const revs = [];
    let alice2 = null;
    const res = write({
      cwd: b,
      pr: 4,
      agent: "bob",
      mutate(cur, rev) {
        revs.push(rev);
        if (!alice2) alice2 = write({ cwd: a, pr: 4, agent: "alice", mutate: bump("alice") });
        return bump("bob")(cur);
      },
    });
    assert.equal(revs.length, 2);
    assert.equal(revs[1], alice2.rev);
    assert.deepEqual(res.ledger, { seq: 3, counter: 3, log: ["alice", "alice", "bob"] });
    assert.equal(remoteRev(4), res.rev);
    const links = chain(4);
    assert.equal(links.length, 3);
    assert.ok(links.every((l) => l.length <= 2), "every commit has at most one parent");
    assert.deepEqual(links[0], [res.rev, alice2.rev]);
  });

  test("gives up with CONTENTION after maxTries lost races", () => {
    write({ cwd: a, pr: 5, agent: "alice", mutate: bump("alice") });
    let calls = 0;
    assert.throws(
      () =>
        write({
          cwd: b,
          pr: 5,
          agent: "bob",
          maxTries: 2,
          mutate(cur) {
            calls += 1;
            write({ cwd: a, pr: 5, agent: "alice", mutate: bump("alice") }); // always beat bob
            return bump("bob")(cur);
          },
        }),
      (e) => e instanceof CollabError && e.code === EXIT.CONTENTION,
    );
    assert.equal(calls, 2);
    assert.deepEqual(read({ cwd: a, pr: 5, agent: "alice" }).ledger.log, ["alice", "alice", "alice"]);
  });

  test("an error thrown by mutate propagates without retrying or writing", () => {
    const first = write({ cwd: a, pr: 6, agent: "alice", mutate: bump("alice") });
    let calls = 0;
    const precondition = new CollabError(EXIT.PRECONDITION, "not owner");
    assert.throws(
      () =>
        write({
          cwd: b,
          pr: 6,
          agent: "bob",
          mutate() {
            calls += 1;
            throw precondition;
          },
        }),
      (e) => e === precondition,
    );
    assert.equal(calls, 1);
    assert.throws(
      () =>
        write({
          cwd: b,
          pr: 6,
          agent: "bob",
          mutate() {
            throw new TypeError("a bug");
          },
        }),
      TypeError,
    );
    assert.equal(remoteRev(6), first.rev);
  });

  test("mutate returning null writes nothing", () => {
    assert.deepEqual(write({ cwd: a, pr: 7, agent: "alice", mutate: () => null }), { ledger: null, rev: null, events: [] });
    assert.equal(remoteRev(7), null);

    const first = write({ cwd: a, pr: 7, agent: "alice", mutate: bump("alice") });
    const again = write({ cwd: b, pr: 7, agent: "bob", mutate: () => null });
    assert.deepEqual(again, { ledger: first.ledger, rev: first.rev, events: [] });
    assert.equal(remoteRev(7), first.rev);
    assert.equal(chain(7).length, 1);
  });

  test("two agents can share one clone because each has its own cache ref", () => {
    write({ cwd: a, pr: 8, agent: "alice", mutate: bump("alice") });
    const res = write({ cwd: a, pr: 8, agent: "carol", mutate: bump("carol") });
    assert.deepEqual(res.ledger.log, ["alice", "carol"]);
    assert.equal(tryRev(a, cacheRefFor("carol", 8)), res.rev);
    assert.notEqual(tryRev(a, cacheRefFor("alice", 8)), res.rev); // alice's copy refreshes on her next read
    assert.equal(cacheRefFor(undefined, 8), "refs/collab-cache/anon/pr-8");
  });
});

describe("failures", () => {
  test("read and write throw ENV when origin can't be reached", () => {
    const c = repo.clone("broken");
    sh(["remote", "set-url", "origin", `${repo.dir}/no-such-remote.git`], c);
    assert.throws(
      () => read({ cwd: c, pr: 1, agent: "x" }),
      (e) => e instanceof CollabError && e.code === EXIT.ENV && e.details.network === true,
    );
    let calls = 0;
    assert.throws(
      () =>
        write({
          cwd: c,
          pr: 1,
          agent: "x",
          mutate: () => {
            calls += 1;
            return { ledger: {}, events: [] };
          },
        }),
      (e) => e instanceof CollabError && e.code === EXIT.ENV,
    );
    assert.equal(calls, 0);
  });

  test("an agent id that can't be part of a ref name is a precondition error", () => {
    for (const agent of ["bad id", "a/b", "../x", "x.lock", "-x", "x."]) {
      assert.throws(() => read({ cwd: a, pr: 1, agent }), (e) => e.code === EXIT.PRECONDITION, agent);
    }
    assert.throws(() => write({ cwd: a, pr: 1, agent: "a b", mutate: () => null }), (e) => e.code === EXIT.PRECONDITION);
    assert.equal(read({ cwd: a, pr: 1, agent: "codex-7k2p" }), null);
    assert.equal(read({ cwd: a, pr: 1 }), null); // anon
  });

  test("classifyPush sorts porcelain results", () => {
    const ref = "refs/collab/pr-1";
    const r = (code, stdout, stderr = "") => classifyPush({ code, stdout, stderr }, ref);
    const line = (flag, summary) => `To origin\n${flag}\tabc:${ref}\t${summary}\nDone\n`;
    assert.equal(r(0, line("*", "[new reference]")), "ok");
    assert.equal(r(0, line(" ", "abc..def")), "ok");
    assert.equal(r(0, line("=", "[up to date]")), "ok");
    assert.equal(r(1, line("!", "[rejected] (stale info)")), "race");
    assert.equal(r(1, line("!", "[rejected] (fetch first)")), "race");
    assert.equal(r(1, line("!", "[rejected] (non-fast-forward)")), "race");
    assert.equal(r(1, line("!", "[remote rejected] (cannot lock ref 'refs/collab/pr-1')")), "race");
    assert.equal(r(1, line("!", "[remote rejected] (pre-receive hook declined)")), "error");
    assert.equal(r(1, line("!", "[remote rejected] (permission denied)")), "error");
    assert.equal(r(128, "", "fatal: unable to access 'https://github.com/o/r/': Could not resolve host: github.com"), "network");
    assert.equal(r(128, "", "ssh: connect to host github.com port 22: Connection timed out"), "network");
    assert.equal(r(128, "", "fatal: something odd"), "network");
    assert.equal(r(1, "To origin\nDone\n", "error: src refspec abc does not match any"), "error");
  });
});

describe("history", () => {
  test("commit messages carry a summary line and one trailer per event", () => {
    const e1 = ev("alice", "task.claim", { task: "T1" });
    const e2 = ev("alice", "task.note", { task: "T1", data: { body: "line one\nline two" } });
    assert.equal(
      commitMessage([e1, e2], "alice"),
      `collab: alice task.claim T1\n\nCollab-Event: ${JSON.stringify(e1)}\nCollab-Event: ${JSON.stringify(e2)}\n`,
    );
    assert.match(commitMessage([ev("bob", "plan", { data: { summary: "bob planned\n5 tasks" } })], "bob"), /^collab: bob planned 5 tasks\n\n/);
    assert.equal(commitMessage([], "bob"), "collab: bob update\n");
  });

  test("history returns events newest first from the cache ref", async () => {
    const pr = 20;
    const e1 = ev("alice", "agent.join");
    const e2 = ev("alice", "task.claim", { task: "T1" });
    const e3 = ev("alice", "task.lease", { task: "T1" });
    const e4 = ev("alice", "task.note", { task: "T1", data: { summary: "alice noted T1", body: "Collab-Event: not a trailer\nx" } });
    const step = (events) => (cur) => ({ ledger: { seq: (cur?.seq ?? 0) + 1 }, events });
    const w1 = await withNow("2026-11-16T10:00:00.000Z", () => write({ cwd: a, pr, agent: "alice", mutate: step([e1]) }));
    const w2 = await withNow("2026-11-16T10:05:00.000Z", () => write({ cwd: a, pr, agent: "alice", mutate: step([e2, e3]) }));
    const w3 = await withNow("2026-11-16T10:10:00.000Z", () => write({ cwd: a, pr, agent: "alice", mutate: step([e4]) }));

    assert.equal(sh(["log", "-1", "--format=%s", w3.rev], a), "collab: alice noted T1");
    assert.equal(sh(["log", "-1", "--format=%s", w2.rev], a), "collab: alice task.claim T1");

    const h = history({ cwd: a, pr, agent: "alice" });
    assert.deepEqual(h, [
      { sha: w3.rev, at: "2026-11-16T10:10:00.000Z", event: e4 },
      { sha: w2.rev, at: "2026-11-16T10:05:00.000Z", event: e3 },
      { sha: w2.rev, at: "2026-11-16T10:05:00.000Z", event: e2 },
      { sha: w1.rev, at: "2026-11-16T10:00:00.000Z", event: e1 },
    ]);
    assert.deepEqual(history({ cwd: a, pr, agent: "alice", limit: 2 }).map((x) => x.event), [e4, e3]);

    assert.deepEqual(history({ cwd: b, pr, agent: "bob" }), []); // bob hasn't read it yet
    read({ cwd: b, pr, agent: "bob" });
    assert.equal(history({ cwd: b, pr, agent: "bob" }).length, 4);
  });
});

describe("remove", () => {
  test("deletes the remote ledger and this clone's cached copies", () => {
    write({ cwd: a, pr: 30, agent: "alice", mutate: bump("alice") });
    write({ cwd: a, pr: 30, agent: "carol", mutate: bump("carol") });
    write({ cwd: a, pr: 31, agent: "alice", mutate: bump("alice") });
    read({ cwd: b, pr: 30, agent: "bob" });

    remove({ cwd: a, pr: 30 });
    assert.equal(remoteRev(30), null);
    assert.equal(tryRev(a, cacheRefFor("alice", 30)), null);
    assert.equal(tryRev(a, cacheRefFor("carol", 30)), null);
    assert.notEqual(tryRev(a, cacheRefFor("alice", 31)), null, "other PRs are untouched");
    assert.notEqual(remoteRev(31), null);

    // Bob's clone still has a stale copy until his next read, which drops it.
    assert.equal(history({ cwd: b, pr: 30, agent: "bob" }).length, 2);
    assert.equal(read({ cwd: b, pr: 30, agent: "bob" }), null);
    assert.deepEqual(history({ cwd: b, pr: 30, agent: "bob" }), []);

    remove({ cwd: a, pr: 30 }); // already gone: no error
    const again = write({ cwd: b, pr: 30, agent: "bob", mutate: bump("bob") });
    assert.deepEqual(again.ledger, { seq: 1, counter: 1, log: ["bob"] });
  });
});
