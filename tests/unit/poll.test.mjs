import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { CEILING_MS, CI_MS, FAST_MS, GITHUB_MAX_MS, GITHUB_MIN_MS, githubEvery, plan } from "../../skills/collab/lib/poll.mjs";

const mid = () => 0.5; // no jitter
const S = 1000;

describe("poll: how long collab wait sleeps", () => {
  test("right after a change it checks the ledger every 5 seconds", () => {
    assert.equal(plan({ sinceChangeMs: 0, rand: mid }).sleepMs, FAST_MS);
    assert.equal(plan({ sinceChangeMs: 8 * S, rand: mid }).sleepMs, FAST_MS);
  });

  test("each quiet check comes 1.5 times later, up to a minute", () => {
    // Follow a quiet wait: sleep, then ask again with the time that has passed.
    const sleeps = [];
    let quiet = 10 * S;
    for (let i = 0; i < 12; i++) {
      const { sleepMs } = plan({ sinceChangeMs: quiet, rand: mid });
      sleeps.push(sleepMs);
      quiet += sleepMs;
    }
    assert.deepEqual(sleeps.slice(0, 4), [5000, 7500, 11250, 16875]);
    assert.equal(sleeps.at(-1), CEILING_MS);
    assert.ok(sleeps.every((s, i) => i === 0 || s >= sleeps[i - 1]), "never gets faster while quiet");
  });

  test("a change makes it fast again", () => {
    assert.equal(plan({ sinceChangeMs: 10 * 60 * S, rand: mid }).sleepMs, CEILING_MS);
    assert.equal(plan({ sinceChangeMs: 0, rand: mid }).sleepMs, FAST_MS);
  });

  test("jitter stays within 20% either way", () => {
    assert.equal(plan({ sinceChangeMs: 10 * 60 * S, rand: () => 0 }).sleepMs, CEILING_MS * 0.8);
    assert.equal(plan({ sinceChangeMs: 10 * 60 * S, rand: () => 1 }).sleepMs, CEILING_MS * 1.2);
    for (let i = 0; i < 50; i++) {
      const { sleepMs } = plan({ sinceChangeMs: 10 * 60 * S });
      assert.ok(sleepMs >= CEILING_MS * 0.8 && sleepMs <= CEILING_MS * 1.2, String(sleepMs));
    }
  });

  test("an agent on its own starts at the ceiling", () => {
    assert.equal(plan({ sinceChangeMs: 0, soloAgent: true, rand: mid }).sleepMs, CEILING_MS);
  });

  test("it wakes when a lease runs out, not a minute later", () => {
    assert.equal(plan({ sinceChangeMs: 10 * 60 * S, untilExpiryMs: 12 * S, rand: mid }).sleepMs, 12 * S + 500);
    // A lease far away, or one already over, changes nothing.
    assert.equal(plan({ sinceChangeMs: 10 * 60 * S, untilExpiryMs: 80 * 60 * S, rand: mid }).sleepMs, CEILING_MS);
    assert.equal(plan({ sinceChangeMs: 10 * 60 * S, untilExpiryMs: -5, rand: mid }).sleepMs, CEILING_MS);
  });

  test("it never sleeps less than a second", () => {
    assert.equal(plan({ sinceChangeMs: 0, untilExpiryMs: 1, rand: mid }).sleepMs, 1000);
  });
});

describe("poll: when collab wait asks GitHub", () => {
  test("every 30 seconds while it waits on CI", () => {
    assert.equal(githubEvery({ sinceChangeMs: 30 * 60 * S, waitingOnCi: true }), CI_MS);
  });

  test("otherwise every minute, growing to three when quiet", () => {
    assert.equal(githubEvery({ sinceChangeMs: 0 }), GITHUB_MIN_MS);
    assert.equal(githubEvery({ sinceChangeMs: 4 * 60 * S }), 2 * 60 * S);
    assert.equal(githubEvery({ sinceChangeMs: 60 * 60 * S }), GITHUB_MAX_MS);
  });

  test("the sleep ends when the GitHub check is due", () => {
    // Quiet for an hour (60 s ledger checks), but GitHub is due in 10 s.
    assert.equal(plan({ sinceChangeMs: 60 * 60 * S, untilGithubMs: 10 * S, rand: mid }).sleepMs, 10 * S);
    // Already due, or no deadline: the ledger clock alone decides.
    assert.equal(plan({ sinceChangeMs: 60 * 60 * S, untilGithubMs: -3, rand: mid }).sleepMs, CEILING_MS);
    assert.equal(plan({ sinceChangeMs: 60 * 60 * S, untilGithubMs: null, rand: mid }).sleepMs, CEILING_MS);
  });

  // The loop collab wait runs: the GitHub deadline is fixed when GitHub is read, each tick costs
  // some time of its own, and the sleep aims at the deadline.
  function quietWait(totalMs, tickCostMs = 300) {
    let t = 0;
    let githubDueAt = githubEvery({ sinceChangeMs: 0 });
    const sleeps = [];
    let githubChecks = 0;
    while (t < totalMs) {
      const { sleepMs } = plan({ sinceChangeMs: t, untilGithubMs: githubDueAt - t, rand: mid });
      sleeps.push(sleepMs);
      t += sleepMs + tickCostMs;
      if (t >= githubDueAt) { githubChecks++; githubDueAt = t + githubEvery({ sinceChangeMs: t }); }
    }
    return { sleeps, githubChecks };
  }

  test("a quiet nine-minute wait reads GitHub a handful of times; the cheap ledger checks stay under twenty", () => {
    const { sleeps, githubChecks } = quietWait(9 * 60 * S);
    // The old fixed 30 s poll made 18 checks, each one a ledger fetch plus two GitHub requests.
    assert.ok(githubChecks >= 2 && githubChecks <= 6, `GitHub checks: ${githubChecks}`);
    assert.ok(sleeps.length <= 20, `ledger checks: ${sleeps.length}`);
  });

  test("it never falls into a run of short sleeps before a GitHub check", () => {
    const { sleeps } = quietWait(30 * 60 * S);
    for (let i = 1; i < sleeps.length; i++) {
      assert.ok(!(sleeps[i] < 3 * S && sleeps[i - 1] < 3 * S), `two short sleeps in a row: ${sleeps.slice(i - 1, i + 1)}`);
    }
  });
});
