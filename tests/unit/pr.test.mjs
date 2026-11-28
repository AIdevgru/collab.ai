import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { EXIT } from "../../skills/collab/lib/errors.mjs";
import { MARK_END, MARK_START, checkSupported, ciFilteredToDefault, ciWorkflowProblems, hasDispatchTrigger, hasPullRequestTrigger, markedBlock, parseIssueRef, parsePrRef, readBlock, readMarker, splice, workflowFiltersToDefault } from "../../skills/collab/lib/pr.mjs";
import { makeRepo, sh } from "../helpers/bare-remote.mjs";

// ---------------------------------------------------------------------------
// parsePrRef

test("parsePrRef accepts URLs, owner/repo#n, #n and n", () => {
  const want = { repo: "o/r", number: 42 };
  for (const arg of [
    "https://github.com/o/r/pull/42",
    "https://github.com/o/r/pull/42/files",
    "https://github.com/o/r/pull/42#issuecomment-1",
    "http://www.github.com/o/r/pull/42?x=1",
    "github.com/o/r/pull/42",
    "o/r#42",
    " o/r#42 ",
  ]) {
    assert.deepEqual(parsePrRef(arg, "x/y"), want, arg);
  }
  assert.deepEqual(parsePrRef("#42", "o/r"), want);
  assert.deepEqual(parsePrRef("42", "o/r"), want);
  assert.deepEqual(parsePrRef(42, "o/r"), want);
  assert.deepEqual(parsePrRef("https://github.com/My-Org/repo.js/pull/7"), { repo: "My-Org/repo.js", number: 7 });
});

test("parsePrRef refuses junk and a bare number with no repo", () => {
  for (const arg of ["", "abc", "o/r#", "o/r#0", "0", "https://github.com/o/r/issues/42", "https://gitlab.com/o/r/pull/42", "-1"]) {
    assert.throws(() => parsePrRef(arg, "o/r"), (e) => e.code === EXIT.PRECONDITION && /Use a PR URL/.test(e.message), arg);
  }
  assert.throws(() => parsePrRef("42"), (e) => e.code === EXIT.PRECONDITION && /names no repo/.test(e.message));
});

// ---------------------------------------------------------------------------
// checkSupported

const okPr = { number: 42, state: "OPEN", merged: false, isCrossRepository: false, headRef: "feat/x" };
const info = { defaultBranch: "main" };

test("checkSupported passes an open same-repo PR from a feature branch", () => {
  assert.equal(checkSupported(okPr, info), true);
});

test("checkSupported refuses fork, closed, merged, default-branch-head and collab sub-PRs with exit 4 and a next step", () => {
  const cases = [
    [{ isCrossRepository: true }, /fork.*push the branch here/],
    [{ state: "CLOSED" }, /closed\. Reopen it/],
    [{ state: "closed" }, /closed\. Reopen it/],
    [{ state: "MERGED", merged: true }, /already merged\. Open a new PR/],
    [{ state: "CLOSED", merged: true }, /already merged/],
    [{ headRef: "main" }, /default branch \(main\).*Create a feature branch/],
    [{ headRef: "collab/pr-16/t1" }, /sub-PR for task T1 of the collab on PR #16\. Join that PR instead: collab join 16/],
  ];
  for (const [patch, msg] of cases) {
    assert.throws(
      () => checkSupported({ ...okPr, ...patch }, info),
      (e) => e.code === EXIT.UNSUPPORTED && msg.test(e.message) && e.message.includes("PR #42"),
      JSON.stringify(patch),
    );
  }
});

// ---------------------------------------------------------------------------
// readMarker / splice

const AT1 = "2026-11-16T16:00:00.000Z";
const AT2 = "2026-11-16T16:10:00.000Z";
const block = "## Agent collaboration: On track\n\n5 of 8 tasks done.";

test("readMarker reads seq and at, and null without a marker", () => {
  assert.deepEqual(readMarker(`x\n<!-- collab:dashboard:start seq=7 at=${AT1} -->\n…\n${MARK_END}`), { seq: 7, at: AT1 });
  assert.deepEqual(readMarker("<!-- collab:dashboard:start seq=3 -->"), { seq: 3, at: null });
  assert.equal(readMarker("plain body"), null);
  assert.equal(readMarker(null), null);
});

test("splice inserts the block plus a blank line at the very top when markers are absent", () => {
  const human = "## Summary\nOwner wrote this.\n";
  const out = splice(human, block, 1, AT1);
  assert.equal(out, `<!-- collab:dashboard:start seq=1 at=${AT1} -->\n${block}\n${MARK_END}\n\n${human}`);
  assert.ok(out.endsWith(human));
  assert.equal(splice("", block, 1, AT1), `<!-- collab:dashboard:start seq=1 at=${AT1} -->\n${block}\n${MARK_END}\n`);
  assert.equal(splice(null, block, 1, AT1), splice("", block, 1, AT1));
});

test("splice replaces only the text between the markers and leaves the human text untouched", () => {
  const before = "Intro by the owner.\n\n";
  const after = "\n\n## Notes\n- keep me\n";
  const body = `${before}<!-- collab:dashboard:start seq=4 at=${AT1} -->\nold block\n${MARK_END}${after}`;
  const out = splice(body, block, 5, AT2);
  assert.equal(out, `${before}<!-- collab:dashboard:start seq=5 at=${AT2} -->\n${block}\n${MARK_END}${after}`);
  assert.ok(out.startsWith(before) && out.endsWith(after));
  assert.deepEqual(readMarker(out), { seq: 5, at: AT2 });
});

test("splice refuses an older render (seq guard) but allows the same seq with new content", () => {
  const body = `<!-- collab:dashboard:start seq=9 at=${AT2} -->\nnewer\n${MARK_END}\n\nowner`;
  assert.equal(splice(body, block, 8, AT1), null);
  assert.equal(splice(body, block, 9, AT1), `<!-- collab:dashboard:start seq=9 at=${AT1} -->\n${block}\n${MARK_END}\n\nowner`);
});

test("splice returns null when the block is unchanged, even across line endings", () => {
  const body = `<!-- collab:dashboard:start seq=2 at=${AT1} -->\n${block}\n${MARK_END}\n\nowner`;
  assert.equal(splice(body, block, 3, AT2), null);
  assert.equal(splice(body.replace(/\n/g, "\r\n"), block, 3, AT2), null);
});

test("splice preserves CRLF human text byte-for-byte", () => {
  const before = "Owner line 1\r\nOwner line 2\r\n\r\n";
  const after = "\r\n\r\nTrailing\r\ntext  \r\n";
  const body = `${before}<!-- collab:dashboard:start seq=1 at=${AT1} -->\r\nold\r\n${MARK_END}${after}`;
  const out = splice(body, "line a\nline b", 2, AT2);
  assert.equal(out, `${before}<!-- collab:dashboard:start seq=2 at=${AT2} -->\r\nline a\r\nline b\r\n${MARK_END}${after}`);
  const fresh = splice("Para one\r\nPara two", "blk", 1, AT1);
  assert.ok(fresh.endsWith("\r\n\r\nPara one\r\nPara two"));
});

test("splice treats a start marker without an end marker as absent", () => {
  const body = "<!-- collab:dashboard:start seq=99 -->\nowner deleted the end marker";
  const out = splice(body, block, 1, AT1);
  assert.ok(out.endsWith(`\n\n${body}`));
  assert.deepEqual(readMarker(out), { seq: 1, at: AT1 });
});

test("splice refuses a block that itself holds collab markers", () => {
  assert.throws(() => splice("", `x ${MARK_END}`, 1, AT1));
});

// ---------------------------------------------------------------------------
// parseIssueRef

test("parseIssueRef accepts issue and PR URLs, owner/repo#n, #n and n", () => {
  const want = { repo: "o/r", number: 57 };
  for (const arg of [
    "https://github.com/o/r/issues/57",
    "https://github.com/o/r/issues/57#issuecomment-9",
    "https://github.com/o/r/issues/57?q=1",
    "https://github.com/o/r/pull/57",
    "https://github.com/o/r/pull/57/files",
    "github.com/o/r/issues/57",
    "http://www.github.com/o/r/issues/57",
    "o/r#57",
    " o/r#57 ",
  ]) {
    assert.deepEqual(parseIssueRef(arg, "x/y"), want, arg);
  }
  assert.deepEqual(parseIssueRef("#57", "o/r"), want);
  assert.deepEqual(parseIssueRef("57", "o/r"), want);
  assert.deepEqual(parseIssueRef(57, "o/r"), want);
  assert.deepEqual(parseIssueRef("https://github.com/My-Org/repo.js/issues/7"), { repo: "My-Org/repo.js", number: 7 });
});

test("parseIssueRef refuses junk and a bare number with no repo", () => {
  for (const arg of ["", "abc", "o/r#", "o/r#0", "0", "-1", "https://github.com/o/r/discussions/57", "https://gitlab.com/o/r/issues/57", "https://github.com/o/r/issues/", "https://github.com/o/r/issues/x"]) {
    assert.throws(() => parseIssueRef(arg, "o/r"), (e) => e.code === EXIT.PRECONDITION && /Use an issue URL/.test(e.message), arg);
  }
  assert.throws(() => parseIssueRef("57"), (e) => e.code === EXIT.PRECONDITION && /names no repo/.test(e.message));
  assert.throws(() => parsePrRef("https://github.com/o/r/issues/57", "o/r"), (e) => e.code === EXIT.PRECONDITION, "parsePrRef still wants a PR URL");
});

// ---------------------------------------------------------------------------
// Named blocks (plan-status and plan-doc in one issue body)

const STATUS = "## Plan session: ⚪ Drafting (revision 2)";
const DOC = "# Plan\n\n1. Cache the index\n2. Ship it";

test("markedBlock and readMarker use the block's own name", () => {
  assert.equal(markedBlock("plan-doc", 2, AT1, DOC), `<!-- collab:plan-doc:start seq=2 at=${AT1} -->\n${DOC}\n<!-- collab:plan-doc:end -->`);
  assert.equal(markedBlock("plan-status", 0, null, "x"), "<!-- collab:plan-status:start seq=0 -->\nx\n<!-- collab:plan-status:end -->");
  const body = `${markedBlock("plan-status", 7, AT2, STATUS)}\n\n${markedBlock("plan-doc", 2, AT1, DOC)}\n`;
  assert.deepEqual(readMarker(body, { name: "plan-status" }), { seq: 7, at: AT2 });
  assert.deepEqual(readMarker(body, { name: "plan-doc" }), { seq: 2, at: AT1 });
  assert.equal(readMarker(body), null, "no dashboard here");
  assert.equal(readMarker(body, { name: "plan" }), null, "plan is not a prefix match for plan-doc");
  assert.throws(() => markedBlock("plan-doc", 1, AT1, "x <!-- collab:plan-doc:end -->"));
  assert.throws(() => markedBlock("bad name", 1, AT1, "x"));
  assert.throws(() => readMarker(body, { name: "a.*" }));
});

test("splice of one named block leaves the other block and the human text byte-for-byte", () => {
  const before = "Owner intro.\n\n";
  const between = "\n\n";
  const after = "\n\nTrailing human notes\n";
  const statusOld = markedBlock("plan-status", 3, AT1, "old status");
  const docOld = markedBlock("plan-doc", 1, AT1, "old doc");
  const body = `${before}${statusOld}${between}${docOld}${after}`;

  const s1 = splice(body, STATUS, 4, AT2, { name: "plan-status" });
  assert.equal(s1, `${before}${markedBlock("plan-status", 4, AT2, STATUS)}${between}${docOld}${after}`);
  const s2 = splice(s1, DOC, 2, AT2, { name: "plan-doc" });
  assert.equal(s2, `${before}${markedBlock("plan-status", 4, AT2, STATUS)}${between}${markedBlock("plan-doc", 2, AT2, DOC)}${after}`);

  // Each block has its own seq guard and unchanged check.
  assert.equal(splice(s2, "older doc", 1, AT2, { name: "plan-doc" }), null);
  assert.equal(splice(s2, DOC, 3, AT2, { name: "plan-doc" }), null, "same content");
  assert.notEqual(splice(s2, "status 5", 5, AT2, { name: "plan-status" }), null);
  assert.equal(splice(s2, STATUS, 1, AT2, { name: "plan-status" }), null, "the status block has seq 4");

  // CRLF bodies (a browser edit) keep their line endings, outside and inside both blocks.
  const crlf = s2.replace(/\n/g, "\r\n");
  const s3 = splice(crlf, "new\nstatus", 9, AT2, { name: "plan-status" });
  assert.equal(s3, crlf.replace(/<!-- collab:plan-status:start[\s\S]*?<!-- collab:plan-status:end -->/, `<!-- collab:plan-status:start seq=9 at=${AT2} -->\r\nnew\r\nstatus\r\n<!-- collab:plan-status:end -->`));
  assert.ok(s3.includes(markedBlock("plan-doc", 2, AT2, DOC).replace(/\n/g, "\r\n")));

  // A missing block goes at the very top; the other block stays where it was.
  const onlyDoc = `${docOld}${after}`;
  assert.equal(splice(onlyDoc, STATUS, 1, AT1, { name: "plan-status" }), `${markedBlock("plan-status", 1, AT1, STATUS)}\n\n${onlyDoc}`);
  // A block may not hold its own markers.
  assert.throws(() => splice(body, "x <!-- collab:plan-doc:start seq=1 -->", 2, AT2, { name: "plan-doc" }));
});

test("readBlock returns seq, at and the text between the markers, normalised", () => {
  const body = `intro\r\n\r\n<!-- collab:plan-doc:start seq=3 at=${AT1} -->\r\n\r\n# Plan\r\n\r\n  - indented\r\nlast line  \r\n \r\n\r\n<!-- collab:plan-doc:end -->\r\nafter`;
  assert.deepEqual(readBlock(body, { name: "plan-doc" }), { seq: 3, at: AT1, text: "# Plan\n\n  - indented\nlast line  " });
  assert.deepEqual(readBlock(markedBlock("plan-doc", 1, null, DOC), { name: "plan-doc" }), { seq: 1, at: null, text: DOC });
  assert.deepEqual(readBlock(markedBlock("plan-doc", 1, null, ""), { name: "plan-doc" }), { seq: 1, at: null, text: "" });
  assert.deepEqual(readBlock(markedBlock("plan-doc", 1, null, "\n  \n"), { name: "plan-doc" }), { seq: 1, at: null, text: "" });
  assert.equal(readBlock("<!-- collab:plan-doc:start seq=3 -->\nno end marker", { name: "plan-doc" }), null);
  assert.equal(readBlock(body, { name: "plan-status" }), null);
  assert.equal(readBlock(null, { name: "plan-doc" }), null);
  // The dashboard is a named block too.
  assert.deepEqual(readBlock(splice("owner", block, 4, AT1), { name: "dashboard" }), { seq: 4, at: AT1, text: block });
});

test("long runs of blank lines stay fast (block text can come from a browser edit)", () => {
  const blanks = "\n".repeat(60_000);
  const body = markedBlock("plan-doc", 1, AT1, `a${blanks}b${blanks}`);
  const t = Date.now();
  assert.equal(readBlock(body, { name: "plan-doc" }).text, `a${blanks}b`);
  assert.equal(splice(body, `a${blanks}b`, 1, AT1, { name: "plan-doc" }), null);
  assert.ok(Date.now() - t < 1000, `took ${Date.now() - t} ms`);
});

test("the dashboard splice is unchanged: name defaults to dashboard and the exports stay", () => {
  assert.equal(MARK_END, "<!-- collab:dashboard:end -->");
  assert.equal(String(MARK_START), String(/<!-- collab:dashboard:start seq=(\d+)(?: at=([^ ]+))? -->/));
  const bodies = [
    "",
    "## Summary\nOwner wrote this.\n",
    `Intro\n\n<!-- collab:dashboard:start seq=4 at=${AT1} -->\nold\n${MARK_END}\n\nNotes\n`,
    `Owner\r\n\r\n<!-- collab:dashboard:start seq=1 at=${AT1} -->\r\nold\r\n${MARK_END}\r\n`,
    `<!-- collab:dashboard:start seq=9 at=${AT2} -->\nnewer\n${MARK_END}`,
    "<!-- collab:dashboard:start seq=99 -->\nno end",
  ];
  for (const b of bodies) {
    assert.equal(splice(b, block, 5, AT2, { name: "dashboard" }), splice(b, block, 5, AT2), JSON.stringify(b));
    assert.deepEqual(readMarker(b, { name: "dashboard" }), readMarker(b));
  }
  assert.equal(splice("", block, 3, AT1), `${markedBlock("dashboard", 3, AT1, block)}\n`);
  assert.throws(() => splice("", "x <!-- collab:dashboard:start seq=1 -->", 1, AT1), /dashboard block must not contain collab markers/);
  // A dashboard and a plan block in one body don't disturb each other.
  const both = splice(splice("human", block, 2, AT1), STATUS, 1, AT1, { name: "plan-status" });
  assert.deepEqual(readMarker(both), { seq: 2, at: AT1 });
  assert.equal(readBlock(both, { name: "dashboard" }).text, block);
  assert.ok(both.endsWith(`${markedBlock("dashboard", 2, AT1, block)}\n\nhuman`));
});

// ---------------------------------------------------------------------------
// ciFilteredToDefault

const filtered = [
  ["block list", "on:\n  pull_request:\n    branches:\n      - main\n  push:\n    branches: [main]\njobs:\n  t:\n    runs-on: ubuntu-latest\n"],
  ["flow list", "name: CI\non:\n  push:\n  pull_request:\n    branches: [ main ]\n"],
  ["quoted, comments, types", "'on':\n  pull_request: # PRs\n    types: [opened, synchronize]\n    branches:\n      - \"main\" # only main\n"],
  ["sequence at key indent", "on:\n  pull_request_target:\n    branches:\n    - main\n    paths:\n    - src/**\n"],
  ["inline flow mapping", "on:\n  pull_request: { branches: [main] }\n"],
  ["scalar", "on:\n  pull_request:\n    branches: main\n"],
  ["CRLF", "on:\r\n  pull_request:\r\n    branches:\r\n      - main\r\n"],
];
const unfiltered = [
  ["scalar trigger", "on: pull_request\n"],
  ["list trigger", "on: [push, pull_request]\n"],
  ["block sequence trigger", "on:\n  - push\n  - pull_request\n"],
  ["no branches", "on:\n  pull_request:\n    types: [opened]\n"],
  ["two branches", "on:\n  pull_request:\n    branches: [main, 'release/**']\n"],
  ["other branch", "on:\n  pull_request:\n    branches:\n      - develop\n"],
  ["branches-ignore", "on:\n  pull_request:\n    branches-ignore: [main]\n"],
  ["push only", "on:\n  push:\n    branches: [main]\n"],
  ["one PR trigger unfiltered", "on:\n  pull_request:\n    branches: [main]\n  pull_request_target:\n"],
  ["empty", ""],
];

test("workflowFiltersToDefault spots pull_request filtered to the default branch", () => {
  for (const [name, yaml] of filtered) assert.equal(workflowFiltersToDefault(yaml, "main"), true, name);
  assert.equal(workflowFiltersToDefault(filtered[0][1], "trunk"), false);
});

test("workflowFiltersToDefault ignores unfiltered or wider triggers", () => {
  for (const [name, yaml] of unfiltered) assert.equal(workflowFiltersToDefault(yaml, "main"), false, name);
});

test("ciFilteredToDefault reads .github/workflows at origin/<default> through git", () => {
  const repo = makeRepo();
  try {
    const a = repo.clone("a");
    assert.equal(ciFilteredToDefault(a, "main"), false);
    mkdirSync(join(a, ".github", "workflows"), { recursive: true });
    writeFileSync(join(a, ".github", "workflows", "lint.yml"), "on: [push, pull_request]\n");
    writeFileSync(join(a, ".github", "workflows", "ci.yaml"), filtered[0][1]);
    writeFileSync(join(a, "not-a-workflow.yml"), filtered[0][1]);
    sh(["add", "-A"], a);
    sh(["commit", "--quiet", "-m", "ci"], a);
    // Committed but not pushed: origin/main doesn't have it yet.
    assert.equal(ciFilteredToDefault(a, "main"), false);
    sh(["push", "--quiet", "origin", "main"], a);
    sh(["fetch", "--quiet", "origin"], a);
    assert.equal(ciFilteredToDefault(a, "main"), true);
  } finally {
    repo.cleanup();
  }
});

// ---------------------------------------------------------------------------
// ciWorkflowProblems ("verify": "ci")

test("hasDispatchTrigger finds workflow_dispatch as a key, in a list, or as the only event", () => {
  for (const [name, text] of [
    ["key", "on:\n  push:\n  workflow_dispatch:\njobs: {}\n"],
    ["key with inputs", "on:\n  workflow_dispatch:\n    inputs:\n      x:\n        type: string\n"],
    ["flow list", "on: [push, workflow_dispatch]\n"],
    ["scalar", "on: workflow_dispatch\n"],
    ["block sequence", "on:\n  - push\n  - workflow_dispatch\n"],
    ["quoted, CRLF", "'on':\r\n  \"workflow_dispatch\":\r\n"],
  ]) assert.equal(hasDispatchTrigger(text), true, name);
  for (const [name, text] of [
    ["none", "on:\n  pull_request:\n    branches: [main]\n"],
    ["commented out", "on:\n  push:\n  # workflow_dispatch:\n"],
    ["only in an if", "on: push\njobs:\n  t:\n    if: github.event_name == 'workflow_dispatch'\n"],
  ]) assert.equal(hasDispatchTrigger(text), false, name);
});

test("hasPullRequestTrigger: a workflow GitHub runs on pull requests, with any branch filter", () => {
  for (const [name, text] of [
    ["key with branches", "on:\n  pull_request:\n    branches: [main]\n  workflow_dispatch:\n"],
    ["bare key", "on:\n  push:\n  pull_request:\n"],
    ["flow list", "on: [push, pull_request, workflow_dispatch]\n"],
    ["scalar", "on: pull_request\n"],
    ["block sequence", "on:\n  - workflow_dispatch\n  - pull_request\n"],
    ["quoted, CRLF", "'on':\r\n  \"pull_request\":\r\n    types: [opened]\r\n"],
  ]) assert.equal(hasPullRequestTrigger(text), true, name);
  for (const [name, text] of [
    ["dispatch only (a deploy)", "on:\n  workflow_dispatch:\n    inputs: {}\njobs: {}\n"],
    ["push to main", "on:\n  push:\n    branches: [main]\n  workflow_dispatch:\n"],
    ["pull_request_target", "on:\n  pull_request_target:\n  workflow_dispatch:\n"],
    ["pull_request_target in a list", "on: [pull_request_target, workflow_dispatch]\n"],
    ["commented out", "on:\n  workflow_dispatch:\n  # pull_request:\n"],
    ["only deeper down", "on:\n  workflow_dispatch:\njobs:\n  pull_request:\n    runs-on: x\n"],
    ["no on", "name: x\n"],
  ]) assert.equal(hasPullRequestTrigger(text), false, name);
});

test("ciWorkflowProblems names workflows the default branch lacks or can't start", () => {
  const repo = makeRepo();
  try {
    const a = repo.clone("a");
    mkdirSync(join(a, ".github", "workflows"), { recursive: true });
    writeFileSync(join(a, ".github", "workflows", "ci.yml"), "on:\n  pull_request:\n    branches: [main]\n  workflow_dispatch:\n");
    writeFileSync(join(a, ".github", "workflows", "lint.yml"), "on: [push, pull_request]\n");
    sh(["add", "-A"], a);
    sh(["commit", "--quiet", "-m", "ci"], a);
    sh(["push", "--quiet", "origin", "main"], a);
    sh(["fetch", "--quiet", "origin"], a);
    assert.deepEqual(ciWorkflowProblems(a, "main", ["ci.yml"]), []);
    const p = ciWorkflowProblems(a, "main", ["ci.yml", "lint.yml", "e2e.yml"]);
    assert.equal(p.length, 2);
    assert.match(p[0], /^lint\.yml has no workflow_dispatch trigger, so collab can't start it/);
    assert.match(p[1], /^e2e\.yml is not in \.github\/workflows on main/);
  } finally {
    repo.cleanup();
  }
});
