import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { describe, test } from "node:test";
import {
  ALICE, BOB, CLAUDE, CODEX, GEMINI, GROK, ISSUE, OWNER, PLAN2, Story, at, buildFixtures, hashOf, oneAgreed, serialize,
} from "../fixtures/plan/build.mjs";
import {
  agreeComment, lint, messagePrefix, noticeComment, quietMentions, renderStatus, revisionComment, status,
} from "../../skills/collab/lib/plan-render.mjs";
import { lint as dashboardLint } from "../../skills/collab/lib/dashboard.mjs";

// Golden files: tests/fixtures/plan/<name>.json is { ledger, now, options }, built by build.mjs
// through the real reducer; <name>.md is the expected status block.
// UPDATE_GOLDEN=1 rewrites both from build.mjs and the current renderer.

const DIR = new URL("../fixtures/plan/", import.meta.url);
const UPDATE = process.env.UPDATE_GOLDEN === "1";
const BUILT = buildFixtures();
const readText = (name) => readFileSync(new URL(name, DIR), "utf8").replace(/\r\n/g, "\n");
const show = (fx, opts = fx.options) => renderStatus(fx.ledger, fx.now, opts);

function golden(name, actual) {
  if (UPDATE) writeFileSync(new URL(name, DIR), actual);
  assert.equal(actual, readText(name), `${name} differs; run UPDATE_GOLDEN=1 node --test tests/unit/plan-render.test.mjs if the change is intended`);
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
const tableRows = (md) => {
  const lines = md.split("\n");
  const start = lines.findIndex((l) => l.startsWith("| Person |"));
  const rows = [];
  for (let i = start + 2; i < lines.length && lines[i].startsWith("|"); i++) rows.push(lines[i]);
  return rows;
};
// Text outside inline code spans.
const outsideCode = (md) => md.replace(/(?<!\\)`[^`]*`/g, "");

const EXPECTED_STATUS = {
  drafting: "drafting", waiting: "waiting", agreed: "agreed", "handed-off": "handed-off", closed: "closed",
  "browser-edit": "waiting", injection: "waiting",
};

describe("plan render: golden files", () => {
  test("the fixture list is the one this suite expects", () => {
    assert.deepEqual(Object.keys(BUILT).sort(), Object.keys(EXPECTED_STATUS).sort());
  });

  for (const [name, built] of Object.entries(BUILT)) {
    test(`${name}: fixture is current, status ${EXPECTED_STATUS[name]}, render matches and lints clean`, () => {
      const file = `${name}.json`;
      if (UPDATE) writeFileSync(new URL(file, DIR), serialize(built));
      const fx = JSON.parse(readText(file));
      assert.deepEqual(fx, JSON.parse(serialize(built)), `${file} no longer matches build.mjs; regenerate with UPDATE_GOLDEN=1`);
      assert.equal(status(fx.ledger).key, EXPECTED_STATUS[name]);
      const md = `${show(fx)}\n`;
      golden(`${name}.md`, md);
      assert.deepEqual(lint(md), []);
    });
  }
});

describe("plan render: status", () => {
  test("key, emoji and label for each state", () => {
    assert.deepEqual(status(BUILT.drafting.ledger), { key: "drafting", emoji: "⚪", label: "Drafting" });
    assert.deepEqual(status(BUILT.waiting.ledger), { key: "waiting", emoji: "🟡", label: "Waiting on agreement" });
    assert.deepEqual(status(BUILT.agreed.ledger), { key: "agreed", emoji: "✅", label: "Agreed" });
    assert.deepEqual(status(BUILT["handed-off"].ledger), { key: "handed-off", emoji: "🚀", label: "Handed off" });
    assert.deepEqual(status(BUILT.closed.ledger), { key: "closed", emoji: "⚫", label: "Closed" });
  });
  test("lint is the dashboard's", () => {
    assert.equal(lint, dashboardLint);
  });
});

describe("plan render: renderStatus", () => {
  test("the heading names the status, the revision and the time", () => {
    assert.ok(show(BUILT.waiting).startsWith("## Plan session: 🟡 Waiting on agreement (revision 2, as of 2026-11-16 12:30 UTC)\n\n"));
    assert.ok(show(BUILT.closed).startsWith("## Plan session: ⚫ Closed (revision 1, as of 2026-11-16 12:25 UTC)\n\n"));
  });
  test("what is needed: the rule and who is awaited, or when everyone agreed", () => {
    assert.match(show(BUILT.drafting), /\n\nThe plan is agreed when every person below agrees to the same revision, with at least 2 people taking part\. Waiting on: alice and zwymer\.\n\n/);
    assert.match(show(BUILT.waiting), /Waiting on: alice\.\n\n/);
    assert.match(show(BUILT.agreed), /\n\nEveryone agreed to revision 2 on 2026-11-16 12:28 UTC\.\n\n/);
    const solo = new Story("solo", { minPeople: 3 });
    assert.match(show(solo.fixture(5)), /with at least 3 people taking part\. Waiting on: zwymer and 2 more people to join\./);
    const one = new Story("one", { minPeople: 1 });
    assert.match(show(one.fixture(5)), /with at least 1 person taking part\. Waiting on: zwymer\./);
  });
  test("the people table: agents, agreement, how and last active", () => {
    const rows = tableRows(show(BUILT.agreed)).map(cells);
    assert.deepEqual(rows, [
      [`${OWNER} (owner)`, `${CLAUDE} (Claude Code)`, "✅ Revision 2", `Through their agent ${CLAUDE}`, "2026-11-16 12:25 UTC"],
      [ALICE, `${CODEX} (Codex), ${GEMINI} (Gemini CLI)`, "✅ Revision 2", "[By comment](https://github.com/o/r/issues/57#issuecomment-3001)", "2026-11-16 12:28 UTC"],
      ["carol", `${GROK} (Grok Build)`, "👀 Watching", "Joined after the agreement; takes part once the owner reopens the plan", "2026-11-16 12:29 UTC"],
    ]);
    const closed = tableRows(show(BUILT.closed)).map(cells);
    assert.deepEqual(closed.map((r) => r[2]), ["Not agreed", "🚪 Left", "🚫 Removed"]);
    assert.equal(closed[2][3], "Removed by zwymer on 2026-11-16 12:18 UTC: Joined the wrong plan");
    assert.deepEqual(tableRows(show(BUILT.waiting)).map((r) => cells(r)[2]), ["✅ Revision 2", "⏳ Waiting"]);
  });
  test("an agreement from the terminal says so", () => {
    const s = oneAgreed("terminal").agree(ALICE, null, 28);
    assert.equal(cells(tableRows(show(s.fixture(30)))[1])[3], "From their terminal");
  });
  test("the latest revision: who, through which agent, when, and the summary", () => {
    assert.match(show(BUILT.waiting), /\n\nLatest: revision 2 by alice through codex-7k2p on 2026-11-16 12:20 UTC: Use Redis, and evict the least recently used entry\n\n/);
    const merged = oneAgreed("merged").rev(OWNER, CLAUDE, PLAN2, "", 26, { base: 1, merged: true });
    assert.match(show(merged.fixture(30)), /Latest: revision 3 by zwymer through claude-a1f3 on 2026-11-16 12:26 UTC \(an edit of revision 1, merged with revision 2\)\./);
  });
  test("join and browser-agree lines while drafting; join only while agreed; neither once handed off or closed", () => {
    const join = "**Join:** paste `/collab plan 57` into Claude Code or `$collab plan 57` into Codex. For other agents, run `collab prompt plan 57` and give them what it prints.";
    const agreeLine = `**Agree from the browser:** after reading revision 2, comment \`/collab agree r2 ${hashOf(PLAN2).slice(7, 15)}\` on this issue.`;
    assert.ok(show(BUILT.drafting).includes(join));
    assert.ok(show(BUILT.drafting).includes(agreeLine));
    assert.ok(show(BUILT.agreed).includes(`${join} Anyone who joins now watches until the owner reopens the plan.`));
    assert.ok(!show(BUILT.agreed).includes("Agree from the browser"));
    assert.match(show(BUILT.agreed), /\*\*Next:\*\* anyone taking part runs `collab plan handoff 57` to open the build PR, or the owner runs `collab plan reopen 57` in their own terminal/);
    for (const name of ["handed-off", "closed"]) {
      assert.ok(!show(BUILT[name]).includes("**Join:**"), name);
      assert.ok(!show(BUILT[name]).includes("Agree from the browser"), name);
    }
  });
  test("a browser edit warns, only when asked", () => {
    const warn = /\n\n⚠️ Warning: the plan section below was edited in the browser, so it may not match revision 2\. The edit stays until the next revision/;
    assert.match(show(BUILT["browser-edit"]), warn);
    assert.doesNotMatch(show(BUILT.waiting), /Warning/);
    assert.doesNotMatch(renderStatus(BUILT.waiting.ledger, BUILT.waiting.now), /Warning/);
  });
  test("handed off: a link to the build PR, only when its URL is https", () => {
    const fx = BUILT["handed-off"];
    assert.match(show(fx), /\n\n🚀 Handed off: \[PR #61\]\(https:\/\/github\.com\/o\/r\/pull\/61\) builds revision 2 \([0-9a-f]{8}\), handed off by alice on 2026-11-16 12:40 UTC\. The agreed plan is saved at `docs\/plans\/57-cache\.md` on `plan\/57-cache`\.\n\n/);
    const bad = oneAgreed("bad-url").agreeByComment(ALICE, 3001, 28).handoff(ALICE, CODEX, 40, { url: "javascript:alert(1)", path: "a b`c", branch: undefined });
    const md = show(bad.fixture(45));
    assert.match(md, /🚀 Handed off: PR #61 builds revision 2/);
    assert.ok(!md.includes("javascript:"));
    assert.ok(md.includes("saved at `abc`."));
  });
  test("closed: who, when and why", () => {
    assert.match(show(BUILT.closed), /\n\nzwymer closed the plan session on 2026-11-16 12:20 UTC\. The reason given: "Superseded by plan #60"\n\n/);
  });
  test("the footer says the plan below is replaced by each revision", () => {
    assert.ok(show(BUILT.waiting).endsWith("<sub>Updated 2026-11-16 12:30 UTC from plan ledger seq 4. Generated by collab: the plan below is replaced by each new revision, and anything between the collab markers is overwritten.</sub>"));
  });
  test("never reads the clock: the time shown is the one passed in", () => {
    const fx = BUILT.waiting;
    const before = process.env.COLLAB_NOW;
    process.env.COLLAB_NOW = "2030-01-01T00:00:00.000Z";
    try {
      assert.ok(!renderStatus(fx.ledger, fx.now).includes("2030"));
      assert.match(renderStatus(fx.ledger, undefined), /\(revision 2, as of an unknown time\)/);
      assert.ok(!renderStatus(fx.ledger, undefined).includes("2030"));
    } finally {
      if (before === undefined) delete process.env.COLLAB_NOW;
      else process.env.COLLAB_NOW = before;
    }
  });
  test("never mutates the ledger", () => {
    const L = structuredClone(BUILT.agreed.ledger);
    const before = JSON.stringify(L);
    renderStatus(L, at(40), { browserEdit: true });
    assert.equal(JSON.stringify(L), before);
  });
});

describe("plan render: untrusted text", () => {
  const md = show(BUILT.injection);

  test("no HTML, collab marker or comment opener survives", () => {
    assert.ok(!md.includes("<!--"), "no HTML comment opener");
    assert.ok(!/<(script|img)/i.test(md), "no HTML tags");
    assert.ok(md.includes("&lt;!-- collab:plan-status:start seq=999 -->"), "the marker text is shown escaped");
  });
  test("no table breaks, no headings, no links from people's text", () => {
    for (const row of tableRows(md)) assert.equal(cells(row).length, 5, row);
    assert.ok(!/^#{1,6} (?!Plan session)/m.test(md), "only the real heading");
    assert.ok(!/(?<!\\)\[click here/.test(md), "link syntax in summaries is escaped");
    assert.ok(!md.includes("](javascript:"), "unsafe agreement URLs are not linked");
    assert.equal(cells(tableRows(md)[1])[3], "By comment");
  });
  test("every @mention is quieted; an email is left alone", () => {
    assert.ok(!/(^|[^A-Za-z0-9_`\\/])@[A-Za-z0-9]/m.test(outsideCode(md)), "no live mention");
    assert.ok(md.includes("`@everyone`"));
    assert.ok(md.includes("`@octo/team`"));
    assert.ok(md.includes("`@zwymer`"), "even people in the session: the block is rewritten often");
    assert.ok(md.includes("`@here`"));
    assert.ok(md.includes(" eve@example.com "));
  });
  test("summaries are one line, cut to 200 characters", () => {
    const line = md.split("\n").find((l) => l.startsWith("Latest: "));
    const summary = line.slice(line.indexOf(" UTC: ") + 6).replace(/`(@[^`]+)`/g, "$1").replace(/\\(.)/g, "$1").replace(/&lt;/g, "<");
    assert.equal([...summary].length, 200);
    assert.ok(summary.endsWith("…"));
  });
  test("logins and agent ids are escaped", () => {
    const rows = tableRows(md).map(cells);
    assert.equal(rows[1][0], "eve\\_\\|\\*\\`x\\`\\[y\\](z)");
    assert.equal(rows[2][0], "mallory&lt;img src=x onerror=alert(1)>");
    assert.equal(rows[2][1], "gemini-\\|x\\| (Gemini CLI)");
  });
});

// ---------------------------------------------------------------- comments

describe("plan render: revisionComment", () => {
  const L = BUILT.waiting.ledger;
  const diff = "@@ -1,2 +1,3 @@\n # Cache the API responses\n-1. Add an in-memory cache.\n+1. Add a Redis cache.\n+2. Expire entries.\n";

  test("first line: the revision, who and the summary; then the diff in a details block", () => {
    const out = revisionComment(L, 2, diff, {});
    const lines = out.split("\n");
    assert.equal(lines[0], "📝 Revision 2 by alice: Use Redis, and evict the least recently used entry");
    assert.ok(out.includes(`To agree to this one from the browser, comment \`/collab agree r2 ${L.revs[2].hash.slice(7, 15)}\`.`));
    assert.ok(out.includes(`<details><summary>What changed from revision 1</summary>\n\n\`\`\`diff\n${diff.trimEnd()}\n\`\`\`\n\n</details>`));
    assert.ok(out.endsWith("</details>"));
  });
  test("the prefix replaces the login (without its trailing colon)", () => {
    const out = revisionComment(L, 2, "", { prefix: messagePrefix(L, CODEX) });
    assert.equal(out.split("\n")[0], "📝 Revision 2 by 🤖 alice's Codex (codex-7k2p): Use Redis, and evict the least recently used entry");
    assert.ok(!revisionComment(L, 2, "", { prefix: "<!-- collab:x -->\nhi" }).includes("<!--"));
  });
  test("no diff, no details block", () => {
    assert.ok(!revisionComment(L, 2, "", {}).includes("<details>"));
    assert.ok(!revisionComment(L, 2, "  \n", {}).includes("<details>"));
    assert.ok(!revisionComment(L, 2, null).includes("<details>"));
  });
  test("from overrides the revision the diff starts at", () => {
    assert.ok(revisionComment(L, 2, diff, { from: 7 }).includes("What changed from revision 7"));
  });
  test("a merged revision says what it merged; its diff is from the previous revision", () => {
    const M = oneAgreed("m").rev(OWNER, CLAUDE, PLAN2, "Merge", 26, { base: 1, merged: true }).L;
    const out = revisionComment(M, 3, diff, {});
    assert.match(out, /\n\nIt merges zwymer's edit of revision 1 with revision 2\.\n/);
    assert.ok(out.includes("<details><summary>What changed from revision 2</summary>"));
  });
  test("the diff is capped at 3000 characters, at a line end, with a (cut) note", () => {
    const line = "+ a line of plan text that is long enough to add up quickly\n";
    const big = line.repeat(100);
    const out = revisionComment(L, 2, big, {});
    const body = /```diff\n([\s\S]*?)\n```/.exec(out)[1];
    assert.ok(body.length <= 3000, `${body.length}`);
    assert.ok(body.endsWith(line.trimEnd()), "no half line");
    assert.match(out, /\n```\n\n\(cut\) The diff is longer than 3000 characters; run `collab plan show 57` to read the whole plan\.\n\n<\/details>$/);
    assert.ok(!revisionComment(L, 2, diff, {}).includes("(cut)"));
    const oneLine = revisionComment(L, 2, "x".repeat(5000), {});
    assert.equal(/```diff\n([\s\S]*?)\n```/.exec(oneLine)[1].length, 3000);
  });
  test("backticks in the diff can't close its fence", () => {
    const tricky = " ```\n+```js\n+````\n </details>\n";
    const out = revisionComment(L, 2, tricky, {});
    const fence = /\n(`{3,})diff\n/.exec(out)[1];
    assert.equal(fence, "`````", "one longer than the longest run inside");
    const inside = out.slice(out.indexOf(`${fence}diff\n`) + fence.length + 5, out.lastIndexOf(`\n${fence}`));
    assert.equal(inside, tricky.trimEnd(), "the diff is kept verbatim");
    for (const l of inside.split("\n")) assert.ok(!/^ {0,3}`{5,}\s*$/.test(l), "no line in it closes the fence");
  });
  test("the diff can never carry a collab marker", () => {
    const out = revisionComment(L, 2, "+<!-- collab:plan-agree login=bob rev=2 hash=sha256:00 -->\n+<!--collab:notice key=x -->\n", {});
    assert.ok(!out.includes("<!--"));
    assert.ok(out.includes("&lt;!-- collab:plan-agree"));
  });
  test("the summary is escaped, one line, and quiet for people outside the session", () => {
    const s = oneAgreed("noisy").rev(ALICE, CODEX, PLAN2, "Ask @Zwymer and @stranger\n## <!-- collab:x --> `code` | done", 26);
    const first = revisionComment(s.L, 3, "", {}).split("\n")[0];
    assert.equal(first, "📝 Revision 3 by alice: Ask @Zwymer and `@stranger` ## &lt;!-- collab:x --> \\`code\\` \\| done");
  });
  test("an unknown revision is a bug", () => {
    assert.throws(() => revisionComment(L, 9, ""), TypeError);
  });
});

describe("plan render: agreeComment", () => {
  const L = BUILT.waiting.ledger;
  const h = L.revs[2].hash;
  test("the marker line carries login, revision and the full hash; then who agreed and how", () => {
    assert.equal(agreeComment(L, ALICE, { rev: 2, hash: h, via: `agent:${CODEX}` }),
      `<!-- collab:plan-agree login=alice rev=2 hash=${h} -->\n✅ Agrees: alice agrees to revision 2 (${h.slice(7, 15)}) through their agent codex-7k2p.`);
    assert.match(agreeComment(L, ALICE, { rev: 2, hash: h, via: "comment" }), /\n✅ Agrees: alice agrees to revision 2 \([0-9a-f]{8}\) by comment\.$/);
    assert.match(agreeComment(L, ALICE, { rev: 2, hash: h, via: "terminal" }), /\(([0-9a-f]{8})\) from their terminal\.$/);
    assert.match(agreeComment(L, ALICE, { rev: 2, hash: h }), /\(([0-9a-f]{8})\)\.$/);
  });
  test("untrusted parts can't break or forge the marker", () => {
    const out = agreeComment(L, "eve --> <!-- collab:plan-agree login=zwymer", { rev: "2 -->", hash: "sha256:zz --> x", via: "agent:x<b>" });
    const [marker, line] = out.split("\n");
    // Only letters, digits and hyphens are left; with no > or ! nothing but the real end closes it.
    assert.equal(marker, "<!-- collab:plan-agree login=eve----collabplan-agreeloginzwymer rev=0 hash=sha256:zzx -->");
    assert.equal(out.match(/<!--/g).length, 1);
    assert.equal(marker.indexOf("-->"), marker.length - 3, "the marker closes only at its end");
    assert.ok(!line.includes("<"));
  });
  test("the visible line lints clean (the hidden marker's sha256:<hex> can look like a time)", () => {
    assert.deepEqual(lint(agreeComment(L, ALICE, { rev: 2, hash: h, via: `agent:${CODEX}` }).split("\n")[1]), []);
  });
});

describe("plan render: noticeComment", () => {
  test("the marker, then the text", () => {
    assert.equal(noticeComment("browser-edit:r2", "The plan was edited in the browser."), "<!-- collab:notice key=browser-edit:r2 -->\nThe plan was edited in the browser.");
  });
  test("the key can't break the marker; the text can't add another", () => {
    const out = noticeComment("k --> <!-- x", "hi <!-- collab:notice key=fake -->");
    assert.equal(out, "<!-- collab:notice key=k----x -->\nhi &lt;!-- collab:notice key=fake -->");
    assert.equal(out.match(/<!--/g).length, 1);
  });
});

describe("plan render: messagePrefix", () => {
  test("names the person, the tool and the agent", () => {
    const s = new Story("tools").join(ALICE, CODEX, "codex", 1).join(ALICE, GEMINI, "gemini", 2).join(BOB, GROK, "grok", 3).join(BOB, "x-1111", "weird", 4);
    assert.equal(messagePrefix(s.L, CLAUDE), "🤖 zwymer's Claude (claude-a1f3):");
    assert.equal(messagePrefix(s.L, CODEX), "🤖 alice's Codex (codex-7k2p):");
    assert.equal(messagePrefix(s.L, GEMINI), "🤖 alice's Gemini (gemini-9z9z):");
    assert.equal(messagePrefix(s.L, GROK), "🤖 bob's Grok (grok-x1y2):");
    assert.equal(messagePrefix(s.L, "x-1111"), "🤖 bob's agent (x-1111):");
    assert.equal(messagePrefix(s.L, "nobody-1"), "🤖 Agent nobody-1:");
  });
  test("escapes the login and id", () => {
    const L = BUILT.injection.ledger;
    const out = messagePrefix(L, "codex-<!-- collab:plan-status:end -->");
    assert.equal(out, "🤖 eve\\_\\|\\*\\`x\\`\\[y\\](z)'s Codex (codex-&lt;!-- collab:plan-status:end -->):");
  });
});

describe("plan render: quietMentions", () => {
  const people = ["alice", "Bob"];
  const CASES = [
    ["wraps a login that is not in the session", "ask @stranger", "ask `@stranger`"],
    ["keeps people, case-insensitively", "ask @Alice and @bob", "ask @Alice and @bob"],
    ["at the very start, and several", "@x @y,@alice", "`@x` `@y`,@alice"],
    ["team mentions, always", "@octo/team and @alice/devs", "`@octo/team` and `@alice/devs`"],
    ["a trailing hyphen is not part of the login", "@stranger- yes", "`@stranger`- yes"],
    ["emails are not mentions", "mail eve@example.com or a.b@c.io", "mail eve@example.com or a.b@c.io"],
    ["URL paths are left alone", "https://medium.com/@stranger", "https://medium.com/@stranger"],
    ["inline code is left alone", "run `npm i @scope/pkg` then @x", "run `npm i @scope/pkg` then `@x`"],
    ["a double-backtick span is left alone", "``a ` @x`` and @y", "``a ` @x`` and `@y`"],
    ["an escaped backtick does not open a span", "\\`@x\\`", "\\``@x`\\`"],
    ["right after a literal backtick", "a`@x", "a``@x`"],
    ["an escaped @ still renders as a mention: the escape is dropped", "\\@x", "`@x`"],
    ["an escaped backslash stays", "\\\\@x", "\\\\`@x`"],
    ["an unmatched backtick is literal", "a ` @x", "a ` `@x`"],
    ["fenced blocks are left alone", "before @x\n```js\nimport x from \"@x/y\"; // @x\n```\nafter @x", "before `@x`\n```js\nimport x from \"@x/y\"; // @x\n```\nafter `@x`"],
    ["tilde fences too", "~~~\n@x\n~~~\n@x", "~~~\n@x\n~~~\n`@x`"],
    ["an unclosed fence runs to the end", "```\n@x", "```\n@x"],
    ["a lone @ is not a mention", "a @ b", "a @ b"],
    ["empty", "", ""],
  ];
  for (const [name, input, expected] of CASES) test(name, () => assert.equal(quietMentions(input, people), expected));
  test("no logins means every mention is quieted", () => {
    assert.equal(quietMentions("@alice"), "`@alice`");
    assert.equal(quietMentions(null, null), "");
  });
});

describe("plan render: comments lint clean", () => {
  test("revision and notice comments", () => {
    const L = BUILT.waiting.ledger;
    assert.deepEqual(lint(revisionComment(L, 2, "@@ -1 +1 @@\n-a\n+b\n", { prefix: messagePrefix(L, CODEX) })), []);
    assert.deepEqual(lint(noticeComment("k", "The plan was edited in the browser.")), []);
    assert.equal(ISSUE.number, 57);
  });
});
