import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { EXIT } from "../../skills/collab/lib/errors.mjs";
import { MARK_END, checkSupported, ciFilteredToDefault, parsePrRef, readMarker, splice, workflowFiltersToDefault } from "../../skills/collab/lib/pr.mjs";
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
