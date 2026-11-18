// Use case: tests/use-cases/collab-dashboard.md
// Points 1-6 about rendering and status. The splice itself, "rewritten only when it changed" and
// the sticky-comment fallback are the CLI's and pr.mjs's (tests/unit/pr.test.mjs); the seq guard is
// referenced once here.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CLAUDE, CODEX, PLAN5, REPORT_URL, Story, at, buildFixtures, green, sub } from "../fixtures/dashboard/build.mjs";
import { lint, render, renderCollapsed, status } from "../../skills/collab/lib/dashboard.mjs";
import { splice } from "../../skills/collab/lib/pr.mjs";

const F = buildFixtures();
const show = (fx) => render(fx.ledger, fx.live, fx.history, fx.now, { prUrl: fx.ledger.pr.url });
const keyOf = (fx, live = fx.live, now = fx.now) => status(fx.ledger, live, now).key;

// A ledger with every task merged, ready for the owner; extra events can follow.
const readyStory = (name) => new Story(name).join(CODEX, "codex", 1).plan([PLAN5[0], PLAN5[1]], 2)
  .finish(CLAUDE, CODEX, "T1", 3, 57).finish(CODEX, CLAUDE, "T2", 10, 58);

test("1. the headline has the status and a full-date 'as of' time, then the next-update line", () => {
  const md = show(F["at-risk"]);
  assert.match(md, /^## Agent collaboration: 🟡 At risk \(as of 2026-11-16 13:50 UTC\)\n\n/);
  assert.match(md, /\n\nNext update expected by 2026-11-16 14:40 UTC\. If that time has passed, the agents have stopped\.\n\n/);
  assert.match(show(F.idle), /\n\nNo agent is working right now\.\n\n/);
});

test("2. the status is the first match, and Ready and Blocked win over No active agents", () => {
  // 1: phase-based states win over everything.
  assert.equal(keyOf(F.planning), "planning");
  const pausedReady = readyStory("paused-ready").directive("pause", 900, 20).fixture(25, green());
  assert.equal(keyOf(pausedReady), "paused");
  assert.equal(keyOf(F.blocked, { ...F.blocked.live, mainState: "MERGED" }), "merged");
  assert.equal(keyOf(F.blocked, { ...F.blocked.live, mainState: "CLOSED" }), "closed");
  // 2: Ready, with no live lease left.
  assert.equal(keyOf(F.ready), "ready");
  assert.match(show(F.ready), /No agent is working right now\./);
  // 3: Blocked, even after every lease has run out (which alone would be No active agents).
  const late = at(600);
  assert.equal(keyOf(F.blocked, F.blocked.live, late), "blocked");
  // 4: No active agents beats At risk (the idle fixture also has a stale task).
  assert.equal(keyOf(F.idle), "idle");
  assert.ok(show(F.idle).includes("⏰ stale"));
  // 5 and 6.
  assert.equal(keyOf(F["at-risk"]), "at-risk");
  assert.equal(keyOf(F["on-track"]), "on-track");
  const labels = Object.fromEntries(Object.values(F).map((fx) => { const s = status(fx.ledger, fx.live, fx.now); return [s.key, `${s.emoji} ${s.label}`]; }));
  assert.deepEqual(labels, {
    planning: "⚪ Planning", "on-track": "🟢 On track", "at-risk": "🟡 At risk", blocked: "🔴 Blocked",
    idle: "⚪ No active agents", ready: "🔵 Ready for owner review", paused: "⏸️ Paused",
  });
});

test("3. summary, then Needs attention (who acts), the Tasks and Agents tables, and activity in <details>", () => {
  const md = show(F.blocked);
  const pos = (s) => md.indexOf(s);
  assert.ok(pos("**1 of 5 tasks done (20%).**") > 0);
  assert.ok(pos("**1 of 5 tasks done (20%).**") < pos("### Needs attention (1)"));
  assert.ok(pos("### Needs attention (1)") < pos("### Tasks"));
  assert.ok(pos("### Tasks") < pos("### Agents"));
  assert.ok(pos("### Agents") < pos("<details><summary>Recent activity (last 10 events)</summary>"));
  assert.match(md, /1\. \*\*Owner:\*\* decide on T2 .* `collab decide T2 "<answer>" --pr 42`/);
  assert.ok(md.includes("| Task | Title | Status | Owner | Sub-PR | Reviewer | CI |"));
  assert.ok(md.includes("| Agent | Tool and vendor | Working on | Tasks done | Reviews given | Last seen |"));
});

test("4. emoji are followed by a word, headers have no emoji, times are UTC, no bars: the lint passes every render and catches each fault", () => {
  for (const [name, fx] of Object.entries(F)) assert.deepEqual(lint(show(fx)), [], name);
  assert.deepEqual(lint(renderCollapsed(F.ready.ledger, REPORT_URL, F.ready.now)), []);
  assert.equal(lint("CI ✅").length, 1);
  assert.equal(lint("| ✅ Status |\n|---|").length, 1);
  assert.equal(lint("## A\n#### B").length, 1);
  assert.equal(lint("▓▓▓░░ 60%").length, 1);
  assert.equal(lint("as of 16:02").length, 1);
  assert.equal(lint("[click here](https://example.com)").length, 1);
});

test("5. at Ready the block collapses to one line linking the final report", () => {
  assert.equal(
    renderCollapsed(F.ready.ledger, REPORT_URL, F.ready.now),
    "## Agent collaboration: 🔵 Ready for owner review (as of 2026-11-16 12:30 UTC)\n\nAll 2 tasks are done and merged into `feat/strings`. [Final collab report](https://github.com/o/r/pull/42#issuecomment-4242)",
  );
});

test("5. Ready expands again after red CI, or after a new task's new push (approved goes back to in review)", () => {
  const s = readyStory("re-expand");
  assert.equal(keyOf(s.fixture(20, green())), "ready");
  assert.notEqual(keyOf(s.fixture(20, green({ mainCi: "FAILURE" }))), "ready");

  s.ev("task.add", CLAUDE, null, { title: "Handle empty strings", scope: ["src/empty.js"] }, 21)
    .claim(CLAUDE, "T3", 22).push(CLAUDE, "T3", 23, { sub: 60 }).verify(CLAUDE, "T3", 24).submit(CLAUDE, "T3", 25)
    .reviewClaim(CODEX, "T3", 26).verdict(CODEX, "T3", "approve", 27);
  assert.equal(s.L.tasks.T3.status, "approved");
  s.push(CLAUDE, "T3", 28, { sub: 60 });
  assert.equal(s.L.tasks.T3.status, "in_review", "the approval was for the old head");
  const fx = s.fixture(30, green({ subs: { T3: sub(s, "T3", "PENDING") } }));
  assert.notEqual(keyOf(fx), "ready");
  const md = show(fx);
  assert.match(md, /\| T3 \| Handle empty strings \| 👀 In review \|/);
  assert.match(md, /^## Agent collaboration: 🟢 On track/);
});

test("6. mergeable UNKNOWN never counts as Ready, and an older seq never overwrites a newer render", () => {
  assert.equal(keyOf(F.ready), "ready");
  assert.notEqual(keyOf(F.ready, { ...F.ready.live, mainMergeable: "UNKNOWN" }), "ready");
  assert.notEqual(keyOf(F.ready, null), "ready", "offline is never Ready either");
  const newer = splice("Owner text.", show(F.ready), 17, F.ready.now);
  assert.equal(splice(newer, show(F["on-track"]), 16, F.ready.now), null);
});

test("7. with every task merged, agents wait for the main PR's CI, then the dashboard collapses at Ready", async () => {
  const { setup } = await import("../helpers/cli-env.mjs");
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const path = (await import("node:path")).default;
  const s = setup();
  const ok = (r) => assert.equal(r.code, 0, r.out);
  try {
    const ids = s.start([{ title: "Slugify", accept: ["works"], scope: ["src/slug.mjs"], size: "S" }], ["codex"]);
    ok(s.as("codex", ids.codex, ["claim", "T1"]));
    const wt = path.join(s.clone("codex"), ".collab", "wt", "pr1-t1");
    mkdirSync(path.join(wt, "src"), { recursive: true });
    writeFileSync(path.join(wt, "src", "slug.mjs"), "export const slug = (s) => s.toLowerCase();\n");
    ok(s.as("codex", ids.codex, ["submit", "T1"]));
    mkdirSync(path.join(s.clone("claude"), ".collab"), { recursive: true });
    writeFileSync(path.join(s.clone("claude"), ".collab", "ok.md"), "Meets the criteria.\n");
    ok(s.as("claude", ids.claude, ["review-claim", "T1"]));
    ok(s.as("claude", ids.claude, ["verify", "T1"]));
    ok(s.as("claude", ids.claude, ["review", "T1", "--approve", "--body-file", ".collab/ok.md"]));
    ok(s.as("codex", ids.codex, ["merge", "T1"]));
    // The merge started CI on the main PR.
    s.fake.update((st) => { st.pulls["o/r#1"].ci = "PENDING"; });
    const n = s.as("codex", ids.codex, ["next"]);
    assert.match(n.out, /Next: wait: every task on PR #1 is done; CI on the main PR is still running/);
    assert.doesNotMatch(s.fake.read().pulls["o/r#1"].body, /Ready for owner review/);
    const waiting = s.runAsync("codex", ["wait", "--poll", "1s", "--timeout", "60s", "--pr", "1", "--agent", ids.codex]);
    await new Promise((r) => setTimeout(r, 1500));
    s.fake.update((st) => { st.pulls["o/r#1"].ci = "SUCCESS"; });
    const w = await waiting;
    ok(w);
    assert.match(w.out, /Next: done/);
    assert.match(s.fake.read().pulls["o/r#1"].body, /🔵 Ready for owner review/);
    assert.ok(s.fake.read().comments["o/r#1"].some((c) => c.body.startsWith("<!-- collab:notice key=ready -->")), "the final report comment was posted");
  } finally {
    s.cleanup();
  }
});
