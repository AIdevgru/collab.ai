import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { describe, test } from "node:test";
import {
  CLAUDE, CODEX, PLAN5, REPORT_URL, Story, at, buildFixtures, green, midWork, serialize, sha, spec, sub,
} from "../fixtures/dashboard/build.mjs";
import { lint, render, renderCollapsed, status } from "../../skills/collab/lib/dashboard.mjs";
import { splice } from "../../skills/collab/lib/pr.mjs";
import { apply as applyEvent, newLedger } from "../../skills/collab/lib/ledger.mjs";

// Golden files: tests/fixtures/dashboard/<name>.json is { ledger, live, history, now }, built by
// build.mjs through the real reducer; <name>.md is the expected render.
// UPDATE_GOLDEN=1 rewrites both from build.mjs and the current renderer.

const DIR = new URL("../fixtures/dashboard/", import.meta.url);
const UPDATE = process.env.UPDATE_GOLDEN === "1";
const BUILT = buildFixtures();
const readText = (name) => readFileSync(new URL(name, DIR), "utf8").replace(/\r\n/g, "\n");
const show = (fx, opts = {}) => render(fx.ledger, fx.live, fx.history, fx.now, { prUrl: fx.ledger.pr.url, ...opts });
const keyOf = (fx, live = fx.live, now = fx.now) => status(fx.ledger, live, now).key;

function golden(name, actual) {
  if (UPDATE) writeFileSync(new URL(name, DIR), actual);
  assert.equal(actual, readText(name), `${name} differs; run UPDATE_GOLDEN=1 node --test tests/unit/dashboard.test.mjs if the change is intended`);
}

// Splits a markdown table row on its unescaped pipes.
function cells(row) {
  const out = [];
  let cur = "";
  for (let i = 0; i < row.length; i++) {
    if (row[i] === "\\") { cur += row[i] + (row[i + 1] ?? ""); i++; continue; }
    if (row[i] === "|") { out.push(cur); cur = ""; continue; }
    cur += row[i];
  }
  out.push(cur);
  return out.slice(1, -1).map((c) => c.trim());
}
const tableRows = (md, header) => {
  const lines = md.split("\n");
  const start = lines.findIndex((l) => l.startsWith(header));
  const rows = [];
  for (let i = start + 2; i < lines.length && lines[i].startsWith("|"); i++) rows.push(lines[i]);
  return rows;
};

const EXPECTED_STATUS = {
  planning: "planning", "on-track": "on-track", "at-risk": "at-risk", blocked: "blocked", idle: "idle",
  ready: "ready", paused: "paused", offline: "on-track", "many-tasks": "on-track", injection: "blocked",
};

describe("dashboard: golden files", () => {
  test("the fixture list is the one this suite expects", () => {
    assert.deepEqual(Object.keys(BUILT).sort(), Object.keys(EXPECTED_STATUS).sort());
  });

  for (const [name, built] of Object.entries(BUILT)) {
    test(`${name}: fixture is current, status ${EXPECTED_STATUS[name]}, render matches and lints clean`, () => {
      const file = `${name}.json`;
      if (UPDATE) writeFileSync(new URL(file, DIR), serialize(built));
      const fx = JSON.parse(readText(file));
      assert.deepEqual(fx, JSON.parse(serialize(built)), `${file} no longer matches build.mjs; regenerate with UPDATE_GOLDEN=1`);
      assert.equal(keyOf(fx), EXPECTED_STATUS[name]);
      const md = `${show(fx)}\n`;
      golden(`${name}.md`, md);
      assert.deepEqual(lint(md), []);
    });
  }

  test("ready: the collapsed line", () => {
    const fx = JSON.parse(serialize(BUILT.ready));
    const md = `${renderCollapsed(fx.ledger, REPORT_URL, fx.now)}\n`;
    golden("ready.collapsed.md", md);
    assert.deepEqual(lint(md), []);
  });
});

describe("dashboard: status", () => {
  const ready = BUILT.ready;

  test("returns key, emoji and label", () => {
    assert.deepEqual(status(ready.ledger, ready.live, ready.now), { key: "ready", emoji: "🔵", label: "Ready for owner review" });
    assert.deepEqual(status(BUILT.paused.ledger, BUILT.paused.live, BUILT.paused.now), { key: "paused", emoji: "⏸️", label: "Paused" });
    assert.deepEqual(status(BUILT.idle.ledger, BUILT.idle.live, BUILT.idle.now), { key: "idle", emoji: "⚪", label: "No active agents" });
  });

  test("merged and closed come from the PR state or the phase, before anything else", () => {
    assert.equal(keyOf(ready, { ...ready.live, mainState: "MERGED" }), "merged");
    assert.equal(keyOf(BUILT.blocked, { ...BUILT.blocked.live, mainState: "MERGED" }), "merged");
    assert.equal(keyOf(BUILT.blocked, { ...BUILT.blocked.live, mainState: "CLOSED" }), "closed");
    const closed = midWork("closed").ev("phase.set", "owner", null, { phase: "closed" }, 75).fixture(80, green());
    assert.equal(keyOf(closed), "closed");
    assert.match(show(closed), /^## Agent collaboration: ⚫ Closed \(as of /);
    assert.match(show(closed), /No agent is working right now\./);
  });

  test("ready needs every task done or cancelled, one done, green or no CI, MERGEABLE, the active phase and live data", () => {
    assert.equal(keyOf(ready, { ...ready.live, mainCi: "NONE" }), "ready");
    for (const mainMergeable of ["UNKNOWN", "CONFLICTING", undefined]) assert.notEqual(keyOf(ready, { ...ready.live, mainMergeable }), "ready", String(mainMergeable));
    for (const mainCi of ["PENDING", "FAILURE", "UNKNOWN"]) assert.notEqual(keyOf(ready, { ...ready.live, mainCi }), "ready", mainCi);
    assert.equal(keyOf(ready, null), "on-track");
    assert.equal(keyOf(ready, { ok: false }), "on-track");
    const allCancelled = new Story("all-cancelled").join(CODEX, "codex", 1).plan([spec("one")], 2).cancel(CLAUDE, "T1", 3).fixture(5, green());
    assert.notEqual(keyOf(allCancelled), "ready");
    // github.liveSnapshot's own shape works too.
    assert.equal(keyOf(ready, { ok: true, main: { ci: "SUCCESS", mergeable: "MERGEABLE", state: "OPEN" }, subs: {} }), "ready");
  });

  test("blocked: the owner must decide, the main PR conflicts, or no eligible reviewer", () => {
    assert.equal(keyOf(BUILT.blocked), "blocked");
    const fx = BUILT["on-track"];
    assert.equal(keyOf(fx, { ...fx.live, mainMergeable: "CONFLICTING" }), "blocked");
    assert.match(show({ ...fx, live: { ...fx.live, mainMergeable: "CONFLICTING" } }), /\*\*Owner:\*\* the main PR has conflicts with `main`/);

    const solo = new Story("solo").plan([spec("one")], 1).claim(CLAUDE, "T1", 2).push(CLAUDE, "T1", 3, { sub: 70 }).verify(CLAUDE, "T1", 4).submit(CLAUDE, "T1", 5);
    const fxSolo = solo.fixture(10, green({ subs: { T1: sub(solo, "T1", "SUCCESS") } }));
    assert.equal(keyOf(fxSolo), "blocked");
    const md = show(fxSolo);
    assert.match(md, /no other agent has joined\. Invite one \(an agent from another vendor reviews first\), or run `collab waive-review T1 --pr 42` in your own terminal/);
    // Blocked still wins once every lease has run out.
    assert.equal(keyOf(fxSolo, fxSolo.live, at(600)), "blocked");
  });

  test("blocked: a merge freeze (red main CI) only after its fix-ci task is over an hour old", () => {
    const s = midWork("freeze").ev("task.add", CLAUDE, null, { title: "Fix the failing CI on the main PR", kind: "fix-ci", forSha: sha("main-head"), size: "S" }, 72);
    const red = green({ mainCi: "FAILURE", subs: { T2: sub(s, "T2", "SUCCESS"), T4: sub(s, "T4", "PENDING") } });
    const early = s.fixture(102, red);
    assert.equal(keyOf(early), "on-track");
    assert.match(show(early), /\*\*Any agent:\*\* claim T6 to fix the main PR's failing CI; sub-PR merges are frozen until it passes \(frozen since 2026-11-16 13:12 UTC\)/);
    const late = s.fixture(135, red);
    assert.equal(keyOf(late), "blocked");
    assert.match(show(late), /frozen since 2026-11-16 13:12 UTC, over an hour/);
    // An unfinished fix-ci task keeps counting after the main head moves on.
    assert.equal(keyOf(late, { ...red, mainHeadSha: sha("another head") }), "blocked");
    assert.equal(keyOf(late, { ...red, mainCi: "SUCCESS" }), "on-track");
  });

  test("No active agents: open work and no live lease; it beats At risk", () => {
    assert.equal(keyOf(BUILT.idle), "idle");
    assert.ok(show(BUILT.idle).includes("⏰ stale"), "the idle fixture also has a stale task");
    assert.match(show(BUILT.idle), /\*\*Owner:\*\* no agent is working, and 4 tasks are not finished/);
  });

  test("at risk: a stale task or red sub-PR CI", () => {
    assert.equal(keyOf(BUILT["at-risk"]), "at-risk");
    const fx = BUILT["on-track"];
    assert.equal(keyOf(fx, { ...fx.live, subs: { ...fx.live.subs, T4: { ...fx.live.subs.T4, ci: "FAILURE" } } }), "at-risk");
    // A snapshot taken at another head SHA is ignored.
    assert.equal(keyOf(fx, { ...fx.live, subs: { ...fx.live.subs, T4: { ...fx.live.subs.T4, ci: "FAILURE", headSha: sha("old") } } }), "on-track");
  });

  test("at risk: a review waiting longer than reviewAlertH", () => {
    const s = midWork("slow-review").ev("task.lease", CLAUDE, "T4", { leaseUntil: at(300) }, 150);
    const fx = s.fixture(185, green({ subs: { T2: sub(s, "T2", "SUCCESS"), T4: sub(s, "T4", "SUCCESS") } }));
    assert.equal(keyOf(fx), "at-risk");
    assert.match(show(fx), /\*\*claude-a1f3:\*\* finish the review of T2 \(Add a slugify\(\) helper\)\. It has waited over 2 hours since 2026-11-16 12:55 UTC; the alert is at 2 hours\./);
    const quick = midWork("quick-alert", { reviewAlertH: 0.25 });
    const fxQuick = quick.fixture(80, green({ subs: { T2: sub(quick, "T2", "SUCCESS"), T4: sub(quick, "T4", "SUCCESS") } }));
    assert.equal(keyOf(fxQuick), "at-risk");
    assert.match(show(fxQuick), /It has waited 25 minutes since/);
  });

  test("at risk: three rounds of changes", () => {
    const s = new Story("rounds").join(CODEX, "codex", 1).plan([spec("one")], 2).claim(CLAUDE, "T1", 3);
    let m = 4;
    for (let round = 0; round < 3; round++, m += 5) {
      s.push(CLAUDE, "T1", m, { sub: 80 }).verify(CLAUDE, "T1", m + 1).submit(CLAUDE, "T1", m + 2).reviewClaim(CODEX, "T1", m + 3).verdict(CODEX, "T1", "changes", m + 4);
    }
    const fx = s.fixture(m, green({ subs: { T1: sub(s, "T1", "SUCCESS") } }));
    assert.equal(fx.ledger.tasks.T1.changeRounds, 3);
    assert.equal(keyOf(fx), "at-risk");
    assert.match(show(fx), /has been through 3 rounds of changes/);
    assert.match(show(fx), /✏️ Changes requested/);
  });

  test("at risk: touched files overlap another in-flight task, or the claim recorded an overlap", () => {
    const s = new Story("overlap").join(CODEX, "codex", 1).plan(PLAN5, 2)
      .claim(CLAUDE, "T1", 3).claim(CODEX, "T2", 4)
      .push(CLAUDE, "T1", 10, { sub: 57, touched: ["src/truncate.js", "src/slug.js"] })
      .push(CODEX, "T2", 11, { sub: 58, touched: ["src/slug.js"] });
    const fx = s.fixture(20, green());
    assert.equal(keyOf(fx), "at-risk");
    assert.match(show(fx), /\*\*claude-a1f3 and codex-7k2p:\*\* T1 and T2 both change src\/slug\.js\. Coordinate before merging\./);

    const on = structuredClone(BUILT["on-track"]);
    on.ledger.tasks.T4.overlap = ["T2 (codex-7k2p): src/slug.js"];
    assert.equal(keyOf(on), "at-risk");
    assert.match(show(on), /\*\*claude-a1f3:\*\* T4 \(Add a padStart\(\) wrapper\) was claimed although its scope overlaps work in flight/);
  });

  test("on track otherwise, including while the main PR's CI has been red for under an hour", () => {
    assert.equal(keyOf(BUILT["on-track"]), "on-track");
    assert.equal(keyOf(BUILT.offline), "on-track");
  });
});

describe("dashboard: render", () => {
  test("sections come in order", () => {
    const md = show(BUILT["on-track"]);
    const order = ["## Agent collaboration: 🟢 On track (as of 2026-11-16 13:20 UTC)", "Next update expected by", "**1 of 5 tasks done (20%).**",
      "PR: +412 / −58 lines. Main PR CI: ✅ Passed. Mergeable: yes.", "### Needs attention (0)", "### Tasks", "### Agents",
      "<details><summary>Recent activity (last 10 events)</summary>", "<sub>Updated 2026-11-16 13:20 UTC from ledger seq 16."];
    let last = -1;
    for (const s of order) {
      const i = md.indexOf(s);
      assert.ok(i > last, `${s} comes after the previous section`);
      last = i;
    }
    assert.ok(md.endsWith("in your own terminal.</sub>"));
    assert.ok(!md.includes("<!-- collab:"), "no markers: the caller adds them");
  });

  test("the summary counts each task once and qualifies stale ones", () => {
    assert.match(show(BUILT["at-risk"]), /\*\*1 of 5 tasks done \(20%\)\.\*\* 2 in progress, 2 open, 1 stale\. 2 agents from 2 vendors\./);
    assert.match(show(BUILT.blocked), /1 in progress, 2 open, 1 blocked\./);
    assert.match(show(BUILT.ready), /\*\*2 of 2 tasks done \(100%\)\.\*\* 1 cancelled\./);
    assert.match(show(BUILT.planning), /\*\*No tasks yet\.\*\* claude-a1f3 is writing the plan\. 2 agents from 2 vendors\./);
  });

  test("CI words for the main PR", () => {
    const fx = BUILT["on-track"];
    const words = { SUCCESS: "✅ Passed", FAILURE: "❌ Failed", PENDING: "⏳ Running", NONE: "⚪ No checks", UNKNOWN: "❔ Unknown" };
    for (const [mainCi, word] of Object.entries(words)) assert.ok(show({ ...fx, live: { ...fx.live, mainCi } }).includes(`Main PR CI: ${word}.`), mainCi);
    assert.ok(show({ ...fx, live: { ...fx.live, mainMergeable: "UNKNOWN" } }).includes("Mergeable: unknown (GitHub is still checking)."));
    assert.ok(show(BUILT.offline).includes("Live GitHub data unavailable; showing the ledger only."));
  });

  test("task table: status words, owner with tool, sub-PR, reviewer and CI cells", () => {
    const rows = tableRows(show(BUILT["on-track"]), "| Task |").map(cells);
    assert.deepEqual(rows[0], ["T1", "Add a truncate() helper", "✅ Done", "claude-a1f3 (Claude Code)", "#57, merged", "codex-7k2p (Codex)", "✅ Passed"]);
    assert.deepEqual(rows[1], ["T2", "Add a slugify() helper", "👀 In review", "codex-7k2p (Codex)", "#58", "claude-a1f3 (Claude Code)", "✅ Passed"]);
    assert.deepEqual(rows[2], ["T3", "Document the string helpers", "⚪ Open", "none", "none", "none", "Not run"]);
    assert.deepEqual(rows[3], ["T4", "Add a padStart() wrapper", "🔨 In progress", "claude-a1f3 (Claude Code)", "#59, draft", "none", "⏳ Running"]);

    const s = midWork("no-checks");
    const fx = s.fixture(80, green({ subs: { T2: sub(s, "T2", "NONE"), T4: sub(s, "T4", "NONE") } }));
    const ci = tableRows(show(fx), "| Task |").map((r) => cells(r)[6]);
    assert.equal(ci[1], "✅ Verified locally (no checks)", "T2 has a passing verify at its head");
    assert.equal(ci[3], "No checks", "T4 was never verified");
    assert.deepEqual(tableRows(show(BUILT.offline), "| Task |").map((r) => cells(r)[6]), ["✅ Passed", "Unknown", "Not run", "Unknown", "Not run"]);

    const waived = midWork("waived").ev("review.waive", "owner", "T2", {}, 72).fixture(80, green());
    assert.equal(cells(tableRows(show(waived), "| Task |")[1])[5], "owner (review waived)");
  });

  test("more than 15 tasks: done tasks move into a details block after the table", () => {
    const md = show(BUILT["many-tasks"]);
    assert.match(md, /\n\n<details><summary>Done tasks \(6\)<\/summary>\n\n\| Task \| Title/);
    const main = tableRows(md, "| Task |");
    assert.equal(main.length, 10);
    assert.ok(main.every((r) => !r.includes("✅ Done")));
    assert.ok(md.indexOf("Done tasks (6)") < md.indexOf("### Agents"));
    assert.ok(md.includes("snake\\_case()"), "untrusted titles are escaped");
  });

  test("agents table: tool and vendor names, work, counts and last seen", () => {
    const s = new Story("vendors").join("gemini-q9w2", "gemini", 1).join("grok-x1y2", "grok", 2).join("mystery-0001", "other", 3);
    const rows = tableRows(show(s.fixture(5, green())), "| Agent |").map(cells);
    assert.deepEqual(rows.map((r) => r[1]), ["Claude Code (Anthropic)", "Gemini CLI (Google)", "Grok Build (xAI)", "other (unknown vendor)"]);
    assert.deepEqual(rows[0], ["claude-a1f3", "Claude Code (Anthropic)", "writing the plan", "0", "0", "2026-11-16 12:00 UTC"]);
    const mid = tableRows(show(BUILT["on-track"]), "| Agent |").map(cells);
    assert.deepEqual(mid[0], ["claude-a1f3", "Claude Code (Anthropic)", "T4, reviewing T2", "1", "0", "2026-11-16 13:10 UTC"]);
    assert.deepEqual(mid[1], ["codex-7k2p", "Codex (OpenAI)", "T2", "0", "1", "2026-11-16 12:55 UTC"]);
  });

  test("needs attention: owner decisions quote the reason and give the decide command", () => {
    const md = show(BUILT.blocked);
    assert.match(md, /### Needs attention \(1\)\n\n1\. \*\*Owner:\*\* decide on T2 \(Add a slugify\(\) helper\) by running `collab decide T2 "<answer>" --pr 42` in your own terminal\. codex-7k2p asked on 2026-11-16 12:45 UTC: "Should slugify\(\) keep accented letters/);
    const quiet = show(BUILT["on-track"]);
    assert.match(quiet, /### Needs attention \(0\)\n\nNothing needs attention\./);
  });

  test("needs attention: applied directives link to their comment, newest first", () => {
    const md = show(BUILT.paused);
    assert.match(md, /1\. \*\*Owner:\*\* the collab is paused by a `\/collab pause` comment from zwymer on 2026-11-16 13:15 UTC \(\[comment\]\(https:\/\/github\.com\/o\/r\/pull\/42#issuecomment-2002\)\)\. Resume in your own terminal: `collab resume --pr 42`\./);
    assert.match(md, /2\. \*\*Owner:\*\* a `\/collab cancel T5` comment from zwymer cancelled T5 on 2026-11-16 13:12 UTC \(\[comment\]\(https:\/\/github\.com\/o\/r\/pull\/42#issuecomment-2001\)\)/);
    assert.match(md, /No agent is working right now\./, "paused agents stop");
    // Once resumed, the pause stays visible as a record.
    const resumed = midWork("resumed").directive("pause", 2002, 75).ev("phase.set", "owner", null, { phase: "active" }, 78).fixture(80, green());
    assert.match(show(resumed), /\*\*Owner:\*\* a `\/collab pause` comment from zwymer paused the collab on 2026-11-16 13:15 UTC \(\[comment\]\(https:\/\/github\.com\/o\/r\/pull\/42#issuecomment-2002\)\)\. Check that it was you\./);
  });

  test("needs attention: stale tasks, red sub-PR CI and sub-PR conflicts say who acts", () => {
    const md = show(BUILT["at-risk"]);
    assert.match(md, /1\. \*\*Any agent:\*\* T2 \(Add a slugify\(\) helper\) is stale: codex-7k2p's lease ran out at 2026-11-16 13:40 UTC\./);
    assert.match(md, /2\. \*\*claude-a1f3:\*\* CI is failing on T4's sub-PR #59/);
    const fx = BUILT["on-track"];
    const conflict = show({ ...fx, live: { ...fx.live, subs: { ...fx.live.subs, T4: { ...fx.live.subs.T4, mergeable: "CONFLICTING" } } } });
    assert.match(conflict, /\*\*claude-a1f3:\*\* T4's sub-PR #59 conflicts with `feat\/strings`\. Run `collab sync T4`/);
  });

  test("next update line: the earliest live lease, or no agent working", () => {
    assert.match(show(BUILT["on-track"]), /\n\nNext update expected by 2026-11-16 13:58 UTC\. If that time has passed, the agents have stopped\.\n\n/);
    assert.match(show(BUILT.idle), /\n\nNo agent is working right now\.\n\n/);
    assert.match(show(BUILT.ready), /\n\nNo agent is working right now\.\n\n/);
  });

  test("untrusted text can't break the table, add HTML or links, or close the markers", () => {
    const fx = BUILT.injection;
    const md = show(fx);
    assert.ok(!md.includes("<!--"), "no HTML comment opener survives");
    assert.ok(!/<(script|img)/i.test(md), "no HTML tags from agents");
    assert.ok(!md.includes("](javascript:"), "unsafe directive URLs are not linked");
    assert.ok(!/(?<!\\)\[click here/.test(md), "link syntax in titles is escaped");
    for (const row of tableRows(md, "| Task |")) assert.equal(cells(row).length, 7, row);
    const body = splice("Owner text.\n", md, 5, at(10));
    assert.ok(body.includes("Owner text."));
    assert.equal(body.match(/<!-- collab:dashboard:end -->/g).length, 1, "only the real end marker");
    // The reason is one line, cut to 200 characters.
    const reason = /asked on [^:]+:\d{2} UTC: "(.*)"$/m.exec(md)[1].replace(/\\(.)/g, "$1").replace(/&lt;/g, "<");
    assert.equal([...reason].length, 200);
    assert.ok(reason.endsWith("…"));
  });

  test("titles are cut to 80 characters without splitting an emoji", () => {
    const long = `${"x".repeat(78)}🚀🚀🚀 and more`;
    const fx = new Story("long").join(CODEX, "codex", 1).plan([spec(long)], 2).fixture(5, green());
    const title = cells(tableRows(show(fx), "| Task |")[0])[1];
    assert.equal([...title].length, 80);
    assert.equal(title, `${"x".repeat(78)}🚀…`);
  });

  test("over 10,000 characters: tables fold into details and the activity list is dropped", () => {
    const s = new Story("huge", { config: { maxTasks: 100 } }).join(CODEX, "codex", 1)
      .plan(Array.from({ length: 100 }, (_, i) => spec(`Task number ${i + 1} with a deliberately long title that runs past the eighty character limit`)), 2);
    const md = show(s.fixture(5, green()));
    assert.match(md, /### Tasks\n\n<details><summary>Task table \(100 tasks\)<\/summary>\n\n\| Task \|/);
    assert.match(md, /### Agents\n\n<details><summary>Agent table \(2 agents\)<\/summary>/);
    assert.ok(!md.includes("Recent activity"));
    assert.deepEqual(lint(md), []);
    assert.ok(show(BUILT["on-track"]).length < 10_000);
  });

  test("activity: plain verbs, newest first, housekeeping left out, malformed entries skipped", () => {
    const fx = BUILT["on-track"];
    const ev = (type, task, data = {}, min = 70, agent = CODEX) => ({ sha: sha(type + min), at: at(min), event: { v: 1, type, agent, task, data, at: at(min) } });
    const history = [
      ev("task.merge", "T3", {}, 79), ev("review.verdict", "T3", { verdict: "changes" }, 78), ev("review.verdict", "T3", { verdict: "approve" }, 77),
      ev("comments.seen", null, { lastCommentId: 5 }, 76, "owner"), ev("agent.seen", null, {}, 75), null, {}, { sha: "x", at: at(74) },
      ev("task.submit", "T3", {}, 73), ev("task.claim", "T3", { steal: true }, 72), ev("weird.thing", "T3", {}, 71),
      ev("agent.msg", null, { to: CLAUDE, body: "SECRET BODY" }, 70), ev("agent.msg", null, { to: "all", body: "SECRET BODY" }, 69),
      ev("comment.new", null, { login: "zwymer", pr: 42, body: "SECRET BODY" }, 68, "owner"), ev("comment.new", "T3", { login: "zwymer", pr: 59, body: "SECRET BODY" }, 67, "owner"),
      { sha: "y", at: at(-1500), event: { type: "task.claim", agent: CLAUDE, task: "T1", data: {} } },
    ];
    const md = render(fx.ledger, fx.live, history, fx.now, {});
    const list = /<details><summary>Recent activity \(last (\d+) events\)<\/summary>\n\n([\s\S]*?)\n\n<\/details>/.exec(md);
    assert.equal(list[1], "11");
    assert.ok(!md.includes("SECRET BODY"), "messages and comments are named on the dashboard, not quoted");
    assert.deepEqual(list[2].split("\n"), [
      "- 13:19 UTC: codex-7k2p merged T3",
      "- 13:18 UTC: codex-7k2p requested changes on T3",
      "- 13:17 UTC: codex-7k2p approved T3",
      "- 13:13 UTC: codex-7k2p submitted T3 for review",
      "- 13:12 UTC: codex-7k2p took over T3",
      "- 13:11 UTC: codex-7k2p recorded weird.thing on T3",
      "- 13:10 UTC: codex-7k2p sent a message to claude-a1f3",
      "- 13:09 UTC: codex-7k2p sent a message to every agent",
      "- 13:08 UTC: zwymer commented on the PR",
      "- 13:07 UTC: zwymer commented on T3's sub-PR",
      "- 2026-11-15 11:00 UTC: claude-a1f3 claimed T1",
    ]);
    assert.ok(!render(fx.ledger, fx.live, "not a list", fx.now, {}).includes("Recent activity"));
    assert.ok(!render(fx.ledger, fx.live, [], fx.now, {}).includes("Recent activity"));
  });

  test("collapsed: one headline plus a link to the final report", () => {
    const fx = BUILT.ready;
    assert.equal(renderCollapsed(fx.ledger, REPORT_URL, fx.now),
      "## Agent collaboration: 🔵 Ready for owner review (as of 2026-11-16 12:30 UTC)\n\nAll 2 tasks are done and merged into `feat/strings`. [Final collab report](https://github.com/o/r/pull/42#issuecomment-4242)");
    assert.ok(!renderCollapsed(fx.ledger, "javascript:alert(1)", fx.now).includes("javascript:"));
  });
});

describe("dashboard: lint", () => {
  test("clean markdown has no problems", () => {
    assert.deepEqual(lint("## A\n\n### B\n\n⏸️ Paused, 👨‍💻 Coder, 👍🏽 Good at 16:02 UTC. [Final collab report](https://x)\n\n## C\n\n### D"), []);
  });

  test("an emoji must be followed by a space and a word", () => {
    assert.equal(lint("CI: ✅").length, 1);
    assert.equal(lint("✅Passed").length, 1);
    assert.equal(lint("✅ 3 passed").length, 1);
    assert.match(lint("Status: ⏸️")[0], /line 1: emoji ⏸️ is not followed by a space and a word/);
  });

  test("table headers carry no emoji", () => {
    assert.match(lint("| ✅ Done | Task |\n|---|---|\n| x | y |")[0], /table header contains an emoji/);
    assert.deepEqual(lint("| Task | Status |\n|---|---|\n| T1 | ✅ Done |"), []);
  });

  test("heading levels never skip", () => {
    assert.match(lint("## A\n#### B")[0], /heading level 4 follows level 2/);
    assert.deepEqual(lint("```\n## A\n#### not a heading\n```"), []);
  });

  test("no block-character progress bars", () => {
    assert.match(lint("Progress ████░░ 62%")[0], /block characters/);
  });

  test("every time says UTC", () => {
    assert.match(lint("Updated 16:02.")[0], /time 16:02 without "UTC"/);
    assert.deepEqual(lint("Updated 2026-11-16 16:02 UTC."), []);
  });

  test("link text describes the target", () => {
    for (const bad of ["[here](https://x)", "[Click here](https://x)", "[link](https://x)", "<a href=\"https://x\">here</a>"]) {
      assert.equal(lint(bad).length, 1, bad);
    }
    assert.deepEqual(lint("\\[here\\](https://x)"), [], "escaped brackets are not a link");
  });
});

describe("dashboard: review follow-ups", () => {
  // Built here with the reducer, so these don't touch the golden fixtures.
  const T0 = "2026-11-16T12:00:00.000Z";
  const min = (n) => new Date(Date.parse(T0) + n * 60_000).toISOString();
  const PR = { repo: "o/r", number: 42, url: "https://github.com/o/r/pull/42", headRef: "feat/x", baseRef: "main", defaultBranch: "main", ghLogin: "zwymer" };
  const A = "claude-a1f3";
  const B = "codex-7k2p";
  const G = "gemini-9z9z";
  const e = (type, agent, task, data, n) => ({ type, agent, task, data, at: min(n) });
  const task = (title) => ({ title, desc: "", accept: [], scope: ["src/a.js"], deps: [], size: "S" });
  const base = () => [
    e("agent.join", B, null, { tool: "codex" }, 0),
    e("agent.join", G, null, { tool: "gemini" }, 0),
    e("plan", A, null, { tasks: [task("one"), task("two")] }, 0),
  ].reduce(applyEvent, newLedger({ pr: PR, agent: { id: A, tool: "claude" }, now: T0 }));

  test("a reopened fix-ci task counts the freeze from its reopen, not from when it was first added", () => {
    const red = { mainCi: "FAILURE", mainMergeable: "MERGEABLE", mainHeadSha: "bad1", subs: {} };
    const fix = (n) => e("task.add", B, null, { kind: "fix-ci", forSha: "bad1", scope: [], deps: [], size: "S" }, n);
    const L = [fix(1), e("task.cancel", B, "T3", { reason: "green", withdrawn: true }, 2), fix(200)].reduce(applyEvent, base());
    assert.equal(L.tasks.T3.status, "open");
    assert.notEqual(status(L, red, min(205)).key, "blocked");
    assert.equal(status(L, red, min(262)).key, "blocked");
  });

  test("the claim-overlap warning names the task's current owner", () => {
    const lease = (n) => ({ leaseUntil: min(n + 90) });
    const L = [
      e("task.claim", B, "T1", lease(1), 1),
      e("task.claim", A, "T2", { ...lease(2), overlap: [`T1 (${B}): src/a.js`] }, 2),
      e("task.release", B, "T1", {}, 3),
      e("task.claim", G, "T1", lease(4), 4),
    ].reduce(applyEvent, base());
    const line = render(L, null, [], min(5), { prUrl: PR.url }).split("\n").find((l) => l.includes("was claimed although its scope overlaps"));
    assert.ok(line, "the warning is shown");
    assert.ok(line.includes("gemini"), line);
    assert.ok(!line.includes("codex"), line);
  });
});
