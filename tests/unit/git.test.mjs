import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { CollabError, EXIT } from "../../skills/collab/lib/errors.mjs";
import {
  addWorktree,
  changedFiles,
  currentBranch,
  ensureExclude,
  git,
  gitCommonDir,
  lsFiles,
  originRepo,
  parseGithubUrl,
  repoRoot,
  showFile,
} from "../../skills/collab/lib/git.mjs";
import { makeRepo, sh } from "../helpers/bare-remote.mjs";

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
