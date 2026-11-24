import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { CollabError, EXIT } from "../../skills/collab/lib/errors.mjs";
import {
  addWorktree,
  blobText,
  changedFiles,
  commitFileOnto,
  currentBranch,
  diffBlobs,
  ensureExclude,
  git,
  gitCommonDir,
  gitVersion,
  hashText,
  lsFiles,
  mergeText,
  normText,
  originRepo,
  parseGithubUrl,
  repoRoot,
  showFile,
} from "../../skills/collab/lib/git.mjs";
import { makeRepo, sh } from "../helpers/bare-remote.mjs";
import { withNow } from "../helpers/clock.mjs";

let repo;
let main;
before(() => {
  repo = makeRepo();
  main = repo.clone("main");
});
after(() => repo.cleanup());

const samePath = (a, b) => assert.equal(a.replaceAll("\\", "/").toLowerCase(), b.replaceAll("\\", "/").toLowerCase());

describe("git()", () => {
  test("returns code, stdout and stderr", () => {
    const r = git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: main });
    assert.deepEqual({ code: r.code, out: r.stdout.trim() }, { code: 0, out: "main" });
  });

  test("throws CollabError(ENV) on failure, with stderr in details", () => {
    assert.throws(
      () => git(["rev-parse", "--verify", "no-such-ref"], { cwd: main }),
      (e) => e instanceof CollabError && e.code === EXIT.ENV && /fatal/.test(e.details.stderr),
    );
  });

  test("allowFail returns the non-zero code instead of throwing", () => {
    const r = git(["rev-parse", "--verify", "--quiet", "no-such-ref"], { cwd: main, allowFail: true });
    assert.equal(r.code, 1);
  });

  test("auth clears credential helpers, then uses gh", () => {
    const r = git(["config", "--get-all", "credential.helper"], { cwd: main, auth: { token: "t0k" } });
    // System or global config may list its own helper first; the empty value resets the list.
    assert.deepEqual(r.stdout.split(/\r?\n/).slice(-3, -1), ["", "!gh auth git-credential"]);
  });

  test("passes input on stdin and extra env", () => {
    const sha = git(["hash-object", "--stdin"], { cwd: main, input: "hi\n" }).stdout.trim();
    assert.equal(sha, "45b983be36b73c0788dc9cbcb76cbb80fc7bb057");
    const id = git(["var", "GIT_AUTHOR_IDENT"], { cwd: main, env: { GIT_AUTHOR_NAME: "Someone Else" } }).stdout;
    assert.match(id, /^Someone Else </);
  });
});

describe("repo facts", () => {
  test("repoRoot, gitCommonDir and currentBranch", () => {
    mkdirSync(join(main, "sub"), { recursive: true });
    samePath(repoRoot(join(main, "sub")), main);
    samePath(gitCommonDir(join(main, "sub")), join(main, ".git"));
    assert.equal(currentBranch(main), "main");
  });

  test("currentBranch is null on a detached HEAD", () => {
    const wt = join(repo.dir, "detached");
    sh(["worktree", "add", "--quiet", "--detach", wt, "main"], main);
    assert.equal(currentBranch(wt), null);
  });
});

describe("originRepo", () => {
  test("parses GitHub https, scp-style and ssh URLs", () => {
    const cases = {
      "https://github.com/acme/widgets": "acme/widgets",
      "https://github.com/acme/widgets.git": "acme/widgets",
      "https://github.com/acme/widgets/": "acme/widgets",
      "https://user@github.com/acme/widgets.git": "acme/widgets",
      "git@github.com:acme/widgets.git": "acme/widgets",
      "git@github.com:acme/widgets": "acme/widgets",
      "ssh://git@github.com/acme/widgets": "acme/widgets",
      "ssh://git@github.com/acme/widgets.git": "acme/widgets",
      "ssh://git@github.com:22/acme/my.lib.git": "acme/my.lib",
      "https://gitlab.com/acme/widgets.git": null,
      "C:/tmp/remote.git": null,
      "https://github.com/acme": null,
      "": null,
    };
    for (const [url, want] of Object.entries(cases)) assert.equal(parseGithubUrl(url), want, url);
  });

  test("reads origin, honours COLLAB_REPO and rejects non-GitHub origins", () => {
    const dir = join(repo.dir, "origin-test");
    sh(["init", "--quiet", dir]);
    assert.throws(() => originRepo(dir), (e) => e.code === EXIT.ENV && /no origin/.test(e.message));
    sh(["remote", "add", "origin", "git@github.com:acme/widgets.git"], dir);
    assert.equal(originRepo(dir), "acme/widgets");
    sh(["remote", "set-url", "origin", "ssh://git@github.com/acme/gadgets"], dir);
    assert.equal(originRepo(dir), "acme/gadgets");
    sh(["remote", "set-url", "origin", "https://example.com/acme/widgets.git"], dir);
    assert.throws(() => originRepo(dir), (e) => e.code === EXIT.ENV);

    const prev = process.env.COLLAB_REPO;
    process.env.COLLAB_REPO = "o/r";
    try {
      assert.equal(originRepo(dir), "o/r");
      assert.equal(originRepo(main), "o/r"); // a local bare origin is fine when overridden
    } finally {
      if (prev === undefined) delete process.env.COLLAB_REPO;
      else process.env.COLLAB_REPO = prev;
    }
  });
});

describe("ensureExclude", () => {
  const excludeLines = (cwd) =>
    readFileSync(join(cwd, ".git", "info", "exclude"), "utf8").split(/\r?\n/).filter((l) => l === ".collab/");

  test("creates the info folder, then appends once", () => {
    const c = repo.clone("exclude");
    rmSync(join(c, ".git", "info"), { recursive: true, force: true });
    assert.equal(ensureExclude(c, ".collab/"), true);
    assert.equal(ensureExclude(c, ".collab/"), false);
    assert.deepEqual(excludeLines(c), [".collab/"]);
    assert.equal(sh(["check-ignore", ".collab/wt/x"], c), ".collab/wt/x");
  });

  test("from a linked worktree it writes the shared exclude file", () => {
    const c = repo.clone("exclude-wt");
    const wt = join(c, ".collab", "wt", "pr1-t1");
    sh(["worktree", "add", "--quiet", "-b", "w1", wt, "main"], c);
    mkdirSync(join(wt, "src"), { recursive: true });
    ensureExclude(wt, ".collab/");
    ensureExclude(c, ".collab/");
    ensureExclude(join(wt, "src"), ".collab/");
    assert.deepEqual(excludeLines(c), [".collab/"]);
    assert.equal(existsSync(join(wt, ".git", "info")), false); // .git in a worktree is a file
  });

  test("adds a newline before appending to a file that lacks one", () => {
    const c = repo.clone("exclude-nl");
    const file = join(c, ".git", "info", "exclude");
    mkdirSync(join(c, ".git", "info"), { recursive: true });
    writeFileSync(file, "a.txt");
    ensureExclude(c, "a.txt");
    ensureExclude(c, "b.txt");
    assert.equal(readFileSync(file, "utf8"), "a.txt\nb.txt\n");
  });
});

describe("addWorktree", () => {
  const head = (cwd) => [sh(["symbolic-ref", "HEAD"], cwd), sh(["rev-parse", "HEAD"], cwd)].join(" ");

  test("creates a branch from the start point, then reuses the worktree", () => {
    const c = repo.clone("wt-new");
    const before = head(c);
    const path = join(c, ".collab", "wt", "pr1-t1");
    const first = addWorktree(c, path, "collab/pr-1/t1", "origin/feat/x");
    assert.equal(first.created, true);
    assert.equal(sh(["rev-parse", "HEAD"], path), sh(["rev-parse", "origin/feat/x"], c));
    assert.equal(currentBranch(path), "collab/pr-1/t1");
    // no upstream: the task branch must not track the main PR branch
    assert.equal(git(["rev-parse", "--abbrev-ref", "collab/pr-1/t1@{upstream}"], { cwd: c, allowFail: true }).code, 128);

    const again = addWorktree(c, path, "collab/pr-1/t1", "origin/feat/x");
    assert.equal(again.created, false);
    const relative = addWorktree(c, ".collab/wt/pr1-t1", "collab/pr-1/t1", "origin/feat/x");
    assert.equal(relative.created, false);
    assert.equal(head(c), before);
  });

  test("checks out an existing local branch without -b", () => {
    const c = repo.clone("wt-local");
    sh(["branch", "collab/pr-1/t2", "origin/feat/x"], c);
    const path = join(c, ".collab", "wt", "pr1-t2");
    addWorktree(c, path, "collab/pr-1/t2", "main");
    assert.equal(sh(["rev-parse", "HEAD"], path), sh(["rev-parse", "origin/feat/x"], c));
    assert.equal(sh(["symbolic-ref", "HEAD"], c), "refs/heads/main");
  });

  test("a branch only on origin is checked out tracking origin", () => {
    const c = repo.clone("wt-remote");
    assert.equal(git(["show-ref", "--verify", "--quiet", "refs/heads/feat/x"], { cwd: c, allowFail: true }).code, 1);
    const before = head(c);
    const path = join(c, ".collab", "wt", "featx");
    addWorktree(c, path, "feat/x", "main");
    assert.equal(sh(["rev-parse", "--abbrev-ref", "feat/x@{upstream}"], c), "origin/feat/x");
    assert.equal(sh(["rev-parse", "HEAD"], path), sh(["rev-parse", "origin/feat/x"], c));
    assert.equal(head(c), before);
  });

  test("refuses a path that holds another branch, or a branch checked out elsewhere", () => {
    const c = repo.clone("wt-clash");
    const path = join(c, ".collab", "wt", "a");
    addWorktree(c, path, "collab/pr-2/t1", "main");
    assert.throws(() => addWorktree(c, path, "collab/pr-2/t9", "main"), (e) => e.code === EXIT.PRECONDITION);
    assert.throws(
      () => addWorktree(c, join(c, ".collab", "wt", "b"), "collab/pr-2/t1", "main"),
      (e) => e.code === EXIT.PRECONDITION,
    );
    assert.throws(() => addWorktree(c, join(c, ".collab", "wt", "c"), "main", "main"), (e) => e.code === EXIT.PRECONDITION);
  });
});

describe("files", () => {
  test("lsFiles lists every path at a ref", () => {
    assert.deepEqual(lsFiles(main, "main"), ["README.md"]);
    assert.deepEqual(lsFiles(main, "origin/feat/x").sort(), ["README.md", "src/x.txt"]);
  });

  test("showFile returns text, or null for a missing path or ref", () => {
    assert.equal(showFile(main, "origin/feat/x", "src/x.txt"), "x\n");
    assert.equal(showFile(main, "main", "src/x.txt"), null);
    assert.equal(showFile(main, "no-such-ref", "README.md"), null);
  });

  test("changedFiles uses the merge base", () => {
    assert.deepEqual(changedFiles(main, "main", "origin/feat/x"), ["src/x.txt"]);
    assert.deepEqual(changedFiles(main, "origin/feat/x", "main"), []);
  });
});

describe("text blobs (plan sessions)", () => {
  test("normText: LF line ends, no BOM, exactly one final newline", () => {
    const cases = [
      ["", ""],
      [null, ""],
      ["\uFEFF", ""],
      ["a", "a\n"],
      ["a\n", "a\n"],
      ["a\n\n\n", "a\n"],
      ["a\r\nb\r\n", "a\nb\n"],
      ["a\r\n\r\n", "a\n"],
      ["a\rb\r", "a\nb\n"],
      ["\uFEFFa\r\nb", "a\nb\n"],
      ["a\uFEFF", "a\uFEFF\n"],
      ["\n", "\n"],
      ["  x  \n\n  y  ", "  x  \n\n  y  \n"],
    ];
    for (const [input, want] of cases) assert.equal(normText(input), want, JSON.stringify(input));
    for (const [input] of cases) assert.equal(normText(normText(input)), normText(input), "idempotent");
    const blanks = "\n".repeat(60_000);
    const t = Date.now();
    assert.equal(normText(`a${blanks}b${blanks}`), `a${blanks}b\n`);
    assert.ok(Date.now() - t < 1000, `a long run of newlines took ${Date.now() - t} ms`);
  });

  test("hashText and blobText round-trip, and CRLF input gets the LF blob id", () => {
    const lf = hashText(main, "one\ntwo\n");
    assert.match(lf, /^[0-9a-f]{40}$/);
    assert.equal(hashText(main, "one\r\ntwo\r\n"), lf);
    assert.equal(hashText(main, "\uFEFFone\ntwo"), lf);
    assert.equal(lf, git(["hash-object", "--stdin"], { cwd: main, input: "one\ntwo\n" }).stdout.trim(), "the plain git id");
    assert.equal(blobText(main, lf), "one\ntwo\n");
    const uni = hashText(main, "é ✓ 漢字\r\n");
    assert.equal(blobText(main, uni), "é ✓ 漢字\n");
    // core.autocrlf in the clone changes nothing: stdin has no path, so no filter applies.
    sh(["config", "core.autocrlf", "true"], main);
    try {
      assert.equal(hashText(main, "one\ntwo\n"), lf);
    } finally {
      sh(["config", "core.autocrlf", "false"], main);
    }
    assert.throws(() => blobText(main, "HEAD"), (e) => e.code === EXIT.BUG);
    assert.throws(() => blobText(main, "--output=x"), (e) => e.code === EXIT.BUG);
    assert.throws(() => blobText(main, "0".repeat(40)), (e) => e.code === EXIT.ENV);
  });

  test("diffBlobs gives the hunks only, with 2 lines of context, and '' when equal", () => {
    const a = hashText(main, "l1\nl2\nl3\nl4\nl5\nl6\nl7\n");
    const b = hashText(main, "l1\nl2\nl3\nL4\nl5\nl6\nl7\n");
    // git puts the nearest earlier line that starts with a letter after the range (here "l1").
    assert.equal(diffBlobs(main, a, b), "@@ -2,5 +2,5 @@ l1\n l2\n l3\n-l4\n+L4\n l5\n l6\n");
    assert.equal(diffBlobs(main, b, a), "@@ -2,5 +2,5 @@ l1\n l2\n l3\n-L4\n+l4\n l5\n l6\n");
    assert.equal(diffBlobs(main, a, a), "");
    assert.equal(diffBlobs(main, a, hashText(main, "l1\r\nl2\r\nl3\r\nl4\r\nl5\r\nl6\r\nl7")), "");
    const two = diffBlobs(main, hashText(main, "a\nb\nc\nd\ne\nf\ng\nh\n"), hashText(main, "A\nb\nc\nd\ne\nf\ng\nH\n"));
    assert.equal(two.match(/^@@/gm).length, 2, "two separate hunks");
    assert.ok(!/^(diff --git|index |--- |\+\+\+ )/m.test(two), "no header lines");
    assert.throws(() => diffBlobs(main, "HEAD", a), (e) => e.code === EXIT.BUG);
  });

  const v = gitVersion();
  const has243 = Boolean(v) && (v[0] > 2 || (v[0] === 2 && v[1] >= 43));

  test("gitVersion reads the installed git", () => {
    assert.ok(Array.isArray(v) && v.length === 3 && v.every(Number.isInteger), JSON.stringify(v));
    assert.equal(git(["--version"]).stdout.includes(`${v[0]}.${v[1]}`), true);
  });

  describe("mergeText", { skip: has243 ? false : `git ${v?.join(".")} has no merge-file --object-id (needs 2.43)` }, () => {
    const blob = (t) => hashText(main, t);
    const labels = ["r3 (yours)", "r2", "r4 (theirs)"];

    test("edits to different lines merge cleanly", () => {
      const base = blob("a\nb\nc\nd\ne\n");
      const r = mergeText(main, { ours: blob("A\nb\nc\nd\ne\n"), base, theirs: blob("a\nb\nc\nd\nE\n"), labels });
      assert.deepEqual(r, { clean: true, text: "A\nb\nc\nd\nE\n", conflicts: 0 });
    });

    test("edits to the same line conflict, and the text holds diff3 markers with the labels", () => {
      const r = mergeText(main, { ours: blob("a\nB1\nc\n"), base: blob("a\nb\nc\n"), theirs: blob("a\nB2\nc\n"), labels });
      assert.equal(r.clean, false);
      assert.equal(r.conflicts, 1);
      assert.equal(r.text, "a\n<<<<<<< r3 (yours)\nB1\n||||||| r2\nb\n=======\nB2\n>>>>>>> r4 (theirs)\nc\n");
      const two = mergeText(main, { ours: blob("1\nx\n2\n3\n4\n5\ny\n6\n"), base: blob("1\n-\n2\n3\n4\n5\n-\n6\n"), theirs: blob("1\nX\n2\n3\n4\n5\nY\n6\n"), labels });
      assert.equal(two.conflicts, 2);
    });

    test("identical edits, or nothing changed, are clean", () => {
      const base = blob("a\nb\n");
      const same = blob("a\nB\n");
      assert.deepEqual(mergeText(main, { ours: same, base, theirs: same, labels }), { clean: true, text: "a\nB\n", conflicts: 0 });
      assert.deepEqual(mergeText(main, { ours: base, base, theirs: base, labels }), { clean: true, text: "a\nb\n", conflicts: 0 });
      assert.deepEqual(mergeText(main, { ours: base, base, theirs: same }), { clean: true, text: "a\nB\n", conflicts: 0 }, "default labels");
    });

    test("a newline in a label can't break the markers; a missing blob is ENV", () => {
      const r = mergeText(main, { ours: blob("x\n"), base: blob("o\n"), theirs: blob("y\n"), labels: ["mine\n=======", "base", "theirs"] });
      assert.match(r.text, /^<<<<<<< mine =======\n/);
      // (git reads the all-zero id as an empty blob, so use another id nobody has.)
      assert.throws(() => mergeText(main, { ours: blob("x\n"), base: "1".repeat(40), theirs: blob("y\n"), labels }), (e) => e.code === EXIT.ENV);
      assert.throws(() => mergeText(main, { ours: "HEAD", base: blob("x\n"), theirs: blob("y\n"), labels }), (e) => e.code === EXIT.BUG);
    });
  });

  test("commitFileOnto adds a file on top of a base commit without touching the working tree, HEAD or index", async () => {
    const c = repo.clone("commit-onto");
    const headBefore = sh(["rev-parse", "HEAD"], c);
    const refBefore = sh(["symbolic-ref", "HEAD"], c);
    assert.equal(sh(["status", "--porcelain"], c), "");
    const base = sh(["rev-parse", "origin/feat/x"], c);

    const sha = await withNow("2026-11-20T10:00:00.000Z", () =>
      commitFileOnto(c, { base: "origin/feat/x", path: "docs/plans/57.md", text: "# Plan\r\nline\r\n", message: "plan 57: revision 3", author: { name: "alice", email: "alice@example.test" } }),
    );
    assert.match(sha, /^[0-9a-f]{40}$/);
    assert.equal(sh(["rev-parse", `${sha}^`], c), base);
    assert.equal(git(["rev-parse", "--verify", "--quiet", `${sha}^2`], { cwd: c, allowFail: true }).code, 1, "one parent");
    assert.deepEqual(lsFiles(c, sha).sort(), ["README.md", "docs/plans/57.md", "src/x.txt"]);
    assert.equal(showFile(c, sha, "docs/plans/57.md"), "# Plan\nline\n");
    assert.equal(showFile(c, sha, "src/x.txt"), "x\n");
    const meta = sh(["log", "-1", "--format=%an <%ae>|%cn <%ce>|%aI|%cI|%B", sha], c).split("|");
    assert.deepEqual(meta, ["alice <alice@example.test>", "alice <alice@example.test>", "2026-11-20T10:00:00Z", "2026-11-20T10:00:00Z", "plan 57: revision 3"]);

    assert.equal(sh(["status", "--porcelain"], c), "", "working tree and index stay clean");
    assert.equal(sh(["rev-parse", "HEAD"], c), headBefore);
    assert.equal(sh(["symbolic-ref", "HEAD"], c), refBefore);
    assert.equal(existsSync(join(c, "docs")), false);
    assert.deepEqual(readdirSync(join(c, ".git")).filter((f) => f.startsWith("collab-index-")), [], "the temporary index is gone");

    // A staged change in the real index survives, and an existing file can be replaced.
    writeFileSync(join(c, "staged.txt"), "staged\n");
    sh(["add", "staged.txt"], c);
    const staged = sh(["ls-files", "--stage"], c);
    const again = commitFileOnto(c, { base: sha, path: "README.md", text: "replaced", message: "m", author: { name: "bob", email: "bob@example.test" } });
    assert.equal(showFile(c, again, "README.md"), "replaced\n");
    assert.equal(sh(["rev-parse", `${again}^`], c), sha);
    assert.equal(sh(["ls-files", "--stage"], c), staged);
    assert.equal(sh(["status", "--porcelain"], c), "A  staged.txt");

    // From a linked worktree too (the temporary index goes in the common git dir).
    const wt = join(repo.dir, "commit-onto-wt");
    sh(["worktree", "add", "--quiet", "--detach", wt, "main"], c);
    const fromWt = commitFileOnto(wt, { base: "main", path: "p.md", text: "p", message: "m", author: { name: "a", email: "a@x" } });
    assert.equal(showFile(wt, fromWt, "p.md"), "p\n");
    assert.equal(sh(["status", "--porcelain"], wt), "");
  });

  test("commitFileOnto refuses paths outside the repo and a missing base", () => {
    const author = { name: "a", email: "a@x" };
    for (const path of ["", "/abs.md", "../x.md", "a/../b.md", "a//b.md", "./a.md", "a\\b.md", ".git/config", "x/.GIT/y", "C:/x.md"]) {
      assert.throws(() => commitFileOnto(main, { base: "main", path, text: "t", message: "m", author }), (e) => e.code === EXIT.PRECONDITION, path);
    }
    assert.throws(() => commitFileOnto(main, { base: "no-such-branch", path: "a.md", text: "t", message: "m", author }), (e) => e.code === EXIT.PRECONDITION);
    assert.throws(() => commitFileOnto(main, { base: "--all", path: "a.md", text: "t", message: "m", author }), (e) => e.code === EXIT.BUG);
    assert.throws(() => commitFileOnto(main, { base: "main", path: "a.md", text: "t", message: "m" }), (e) => e.code === EXIT.BUG);
  });
});
