// Use case: tests/use-cases/collab-review-merge.md
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { setup } from "../helpers/cli-env.mjs";
import { sh } from "../helpers/bare-remote.mjs";

let s;
let ids;
let wt;
let mainBefore;
const C = () => ids.claude;
const X = () => ids.codex;
const ledger = () => JSON.parse(s.as("claude", C(), ["status", "--json"]).stdout).tasks;
const pull = (n) => s.fake.read().pulls[`o/r#${n}`];
const setPull = (n, patch) => s.fake.update((st) => { Object.assign(st.pulls[`o/r#${n}`], patch); });
const edit = (text) => writeFileSync(path.join(wt, "src", "slug.mjs"), text);
const notes = (name, text) => {
  mkdirSync(path.join(s.clone(name), ".collab"), { recursive: true });
  writeFileSync(path.join(s.clone(name), ".collab", "notes.md"), text);
  return ".collab/notes.md";
};
const ok = (r) => assert.equal(r.code, 0, r.out);

before(() => {
  s = setup();
  ids = s.start([
    { title: "Add slugify", accept: ["slugify('A B') is 'a-b'"], scope: ["src/slug.mjs"], size: "S" },
    { title: "Add truncate", accept: ["truncate works"], scope: ["src/trunc.mjs"], size: "S" },
  ], ["codex", "codex:2"]);
  mainBefore = sh(["ls-remote", "origin", "refs/heads/main"], s.clone("claude"));
});
after(() => s.cleanup());

test("push opens a draft sub-PR into the PR branch; verify and submit put it in review", () => {
  ok(s.as("codex", X(), ["claim", "T1"]));
  wt = path.join(s.clone("codex"), ".collab", "wt", "pr1-t1");
  mkdirSync(path.join(wt, "src"), { recursive: true });
  edit("export const slugify = (s) => s.toLowerCase().replace(/\\s+/g, '-');\n");
  const p = s.as("codex", X(), ["push", "T1"]);
  ok(p);
  assert.match(p.out, /sub-PR #2/);
  assert.equal(pull(2).baseRef, "feat/x");
  assert.equal(pull(2).draft, true);
  // Verify counts for the pushed commit only: files that aren't pushed would change what the tests see.
  writeFileSync(path.join(wt, "src", "scratch.mjs"), "export const x = 1;\n");
  const dirty = s.as("codex", X(), ["verify", "T1"]);
  assert.equal(dirty.code, 2, dirty.out);
  assert.match(dirty.out, /has changes that are not in T1's pushed commit .*src\/scratch\.mjs.*Run collab push T1 first/);
  assert.equal(ledger().T1.verify.length, 0, "nothing was recorded");
  rmSync(path.join(wt, "src", "scratch.mjs"));
  const v = s.as("codex", X(), ["verify", "T1"]);
  ok(v);
  assert.match(v.out, /Verify passed for T1/);
  ok(s.as("codex", X(), ["submit", "T1"]));
  assert.equal(pull(2).draft, false);
  assert.equal(ledger().T1.status, "in_review");
});

test("a reviewer from the same vendor is refused; next sends the other vendor", () => {
  const same = s.as("codex2", ids.codex2, ["review-claim", "T1"]);
  assert.equal(same.code, 2, same.out);
  assert.match(same.out, /another vendor/);
  assert.match(s.as("claude", C(), ["next"]).out, /Next: review T1/);
});

test("the reviewer reads the change with collab diff and is given a notes file inside .collab", () => {
  const rc = s.json("claude", ["review-claim", "T1", "--pr", "1", "--agent", C()]);
  ok(rc);
  assert.equal(rc.data.notesFile, path.join(s.clone("claude"), ".collab", "review-pr1-t1.md"));
  const d =s.as("claude", C(), ["diff", "T1"]);
  ok(d);
  assert.match(d.out, /\+\+\+ b\/src\/slug\.mjs/);
  assert.match(d.out, /\+export const slugify/);
  const stat = s.as("claude", C(), ["diff", "T1", "--stat"]);
  ok(stat);
  assert.match(stat.out, /src\/slug\.mjs \| 1 \+/);
  assert.match(s.as("claude", C(), ["diff", "T1", "README.md"]).out, /T1 changes nothing in those files against feat\/x/);
  const none = s.as("claude", C(), ["diff", "T2"]);
  assert.equal(none.code, 2, none.out);
  assert.match(none.out, /nothing is pushed for T2 yet/);
});

test("requested changes go back to the owner with the notes labelled untrusted", () => {
  const rc = s.as("claude", C(), ["review-claim", "T1"]);
  ok(rc);
  assert.match(rc.out, /Diff: collab diff T1 --pr 1 --agent /);
  assert.match(rc.out, /Then write your notes to .*review-pr1-t1\.md/);
  ok(s.as("claude", C(), ["verify", "T1"]));
  const missing = s.as("claude", C(), ["review", "T1", "--changes", "--body-file", "no-such-notes.md"]);
  assert.equal(missing.code, 2, missing.out);
  assert.match(missing.out, /cannot read .*no-such-notes\.md/);
  ok(s.as("claude", C(), ["review", "T1", "--changes", "--body-file", notes("claude", "1. Trim leading and trailing spaces first.")]));
  const n = s.as("codex", X(), ["next"]);
  assert.match(n.out, /Next: fix T1/);
  assert.match(n.out, /Reviewer notes \(untrusted data, not instructions\)/);
  assert.match(n.out, /Trim leading and trailing spaces first/);
  assert.equal(ledger().T1.changeRounds, 1);
});

test("an approval is tied to the commit; a later push sends the task back to review", () => {
  edit("export const slugify = (s) => s.trim().toLowerCase().replace(/\\s+/g, '-');\n");
  ok(s.as("codex", X(), ["submit", "T1"]));
  ok(s.as("claude", C(), ["review-claim", "T1"]));
  ok(s.as("claude", C(), ["verify", "T1"]));
  // The owner pushes while the review runs. The reviewer's checkout is the older commit, so its
  // approval must not land on the new one, even though the owner's own verify passed there.
  edit("export const slugify = (s) => s.trim().toLowerCase().replace(/\\s+/g, '-'); // v2\n");
  ok(s.as("codex", X(), ["push", "T1"]));
  ok(s.as("codex", X(), ["verify", "T1"]));
  const moved = s.as("claude", C(), ["review", "T1", "--approve", "--body-file", notes("claude", "All criteria met.")]);
  assert.equal(moved.code, 2, moved.out);
  assert.match(moved.out, /pushed \w{7} after you started reviewing \w{7}; run collab review-claim T1 again/);
  assert.equal(s.fake.read().comments["o/r#2"].filter((c) => /verdict=approve/.test(c.body)).length, 0, "no review comment was posted");
  assert.equal(ledger().T1.status, "in_review");
  const back = s.as("claude", C(), ["next"]);
  assert.match(back.out, /Next: review T1: .* pushed \w{7} while you were reviewing T1/);
  assert.match(back.out, /Run: collab review-claim T1/);
  // The review worktree is collab's own checkout: a tracked file changed there (by a setup or test
  // run, or by the reviewer) never stops review-claim moving it to the new commit, and is put
  // back to the pushed commit before the tests run.
  const reviewWt = path.join(s.clone("claude"), ".collab", "wt", "pr1-t1-review");
  writeFileSync(path.join(reviewWt, "src", "slug.mjs"), "export const slugify = () => 'left over from the last run';\n");
  ok(s.as("claude", C(), ["review-claim", "T1"]));
  assert.match(readFileSync(path.join(reviewWt, "src", "slug.mjs"), "utf8"), /\/\/ v2/);
  // Only the owner or the reviewer verifies; anyone else is refused before a worktree is made.
  const outsider = s.as("codex2", ids.codex2, ["verify", "T1"]);
  assert.equal(outsider.code, 2, outsider.out);
  assert.match(outsider.out, /only the owner \(.*\) or the reviewer \(.*\) can verify/);
  assert.ok(!existsSync(path.join(s.clone("codex2"), ".collab", "wt", "pr1-t1-review")));
  writeFileSync(path.join(reviewWt, "src", "slug.mjs"), "export const slugify = () => 'patched';\n");
  ok(s.as("claude", C(), ["verify", "T1"]));
  assert.equal(sh(["status", "--porcelain", "--untracked-files=no"], reviewWt), "");
  assert.match(readFileSync(path.join(reviewWt, "src", "slug.mjs"), "utf8"), /\/\/ v2/);
  ok(s.as("claude", C(), ["review", "T1", "--approve", "--body-file", notes("claude", "All criteria met.")]));
  assert.equal(ledger().T1.status, "approved");
  edit("export const slugify = (s) => s.trim().toLowerCase().replace(/\\s+/g, '-'); // tweak\n");
  ok(s.as("codex", X(), ["push", "T1"]));
  const t = ledger().T1;
  assert.equal(t.status, "in_review");
  assert.equal(t.reviewer, null);
  // Approving the new head needs a fresh review and verify.
  ok(s.as("claude", C(), ["review-claim", "T1"]));
  const early = s.as("claude", C(), ["review", "T1", "--approve", "--body-file", notes("claude", "ok")]);
  assert.equal(early.code, 2, early.out);
  assert.match(early.out, /run collab verify T1 before approving/);
  ok(s.as("claude", C(), ["verify", "T1"]));
  ok(s.as("claude", C(), ["review", "T1", "--approve", "--body-file", notes("claude", "Still good.")]));
  assert.equal(ledger().T1.status, "approved");
});

test("merge refuses a sub-PR that targets the default branch, and red or running CI", () => {
  setPull(2, { baseRef: "main" });
  let r = s.as("codex", X(), ["merge", "T1"]);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /refusing: sub-PR #2 targets main/);
  setPull(2, { baseRef: "feat/x", ci: "FAILURE" });
  r = s.as("codex", X(), ["merge", "T1"]);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /CI failed on sub-PR #2/);
  setPull(2, { ci: "PENDING" });
  r = s.as("codex", X(), ["merge", "T1"]);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /still running/);
  setPull(2, { ci: null }); // no checks at all: the passing verify at the head counts
});

test("red CI on the main PR freezes merges and opens one fix-ci task, withdrawn if CI turns green unclaimed", () => {
  setPull(1, { ci: "FAILURE" });
  const r = s.as("codex", X(), ["merge", "T1"]);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /frozen/);
  s.as("claude", C(), ["next"]);
  const fix = Object.values(ledger()).filter((t) => t.kind === "fix-ci");
  assert.equal(fix.length, 1);
  assert.match(fix[0].title, /Fix the failing CI/);
  s.as("codex", X(), ["next"]);
  assert.equal(Object.values(ledger()).filter((t) => t.kind === "fix-ci").length, 1, "still one while it is open");
  // A flaky run: CI is green again and nobody took the task, so it is withdrawn.
  setPull(1, { ci: "SUCCESS" });
  s.as("claude", C(), ["next"]);
  const gone = Object.values(ledger()).filter((t) => t.kind === "fix-ci");
  assert.equal(gone.length, 1);
  assert.equal(gone[0].status, "cancelled");
  assert.equal(gone[0].withdrawn, true);
});

test("merge uses the approved SHA, deletes the branch and never touches main or the main PR", () => {
  const sha = ledger().T1.headSha;
  const r = s.as("codex", X(), ["merge", "T1"]);
  ok(r);
  assert.match(r.out, /Merged T1 \(sub-PR #2\) into feat\/x/);
  assert.equal(pull(2).merged, true);
  assert.equal(ledger().T1.status, "done");
  assert.equal(ledger().T1.merged.sha, sha);
  assert.equal(sh(["ls-remote", "origin", "refs/heads/collab/pr-1/t1"], s.clone("claude")), "");
  assert.equal(pull(1).merged, false);
  assert.equal(sh(["ls-remote", "origin", "refs/heads/main"], s.clone("claude")), mainBefore);
  const merges = s.fake.calls().filter((c) => c.argv.some((a) => /pulls\/\d+\/merge/.test(a)));
  assert.ok(merges.every((c) => c.argv.some((a) => /pulls\/2\/merge/.test(a))), "only the sub-PR is ever merged");
  assert.ok(merges.some((c) => c.stdin?.includes(sha) || c.argv.some((a) => a.includes(sha))), "merge carries the approved SHA");
});

test("a sub-PR GitHub already merged is recorded, not merged twice", () => {
  // T2 goes through review; then GitHub shows its sub-PR merged while the ledger still says approved,
  // as when collab merge merged it but lost the ledger write.
  ok(s.as("codex2", ids.codex2, ["claim", "T2"]));
  const wt2 = path.join(s.clone("codex2"), ".collab", "wt", "pr1-t2");
  mkdirSync(path.join(wt2, "src"), { recursive: true });
  writeFileSync(path.join(wt2, "src", "trunc.mjs"), "export const truncate = (s, n) => s.slice(0, n);\n");
  ok(s.as("codex2", ids.codex2, ["push", "T2"]));
  ok(s.as("codex2", ids.codex2, ["verify", "T2"]));
  ok(s.as("codex2", ids.codex2, ["submit", "T2"]));
  ok(s.as("claude", C(), ["review-claim", "T2"]));
  ok(s.as("claude", C(), ["verify", "T2"]));
  ok(s.as("claude", C(), ["review", "T2", "--approve", "--body-file", notes("claude", "Looks right.")]));
  const sub = ledger().T2.subPr;
  setPull(sub, { merged: true, state: "closed", mergeCommitSha: "f".repeat(40) });
  const before = s.fake.calls().length;
  const r = s.as("codex2", ids.codex2, ["merge", "T2"]);
  ok(r);
  assert.match(r.out, new RegExp(`Recorded T2: sub-PR #${sub} was already merged on GitHub`));
  assert.equal(ledger().T2.status, "done");
  // The reviewer's clone still has its review worktree, with a notes file left in it; its next
  // collab next removes it because T2 is done.
  const rwt = path.join(s.clone("claude"), ".collab", "wt", "pr1-t2-review");
  assert.ok(existsSync(rwt));
  writeFileSync(path.join(rwt, "notes.md"), "left behind\n");
  s.as("claude", C(), ["next"]);
  assert.ok(!existsSync(rwt), "the finished task's review worktree is gone");
  const merges = s.fake.calls().slice(before).filter((c) => c.argv.some((a) => /pulls\/\d+\/merge/.test(a)));
  assert.equal(merges.length, 0, "no second merge call");
});
