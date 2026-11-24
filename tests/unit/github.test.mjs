import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { EXIT } from "../../skills/collab/lib/errors.mjs";
import * as gh from "../../skills/collab/lib/github.mjs";
import { makeRepo } from "../helpers/bare-remote.mjs";
import { makeFakeGh } from "../helpers/fake-gh-state.mjs";

const REPO = "o/r";
const A = "a".repeat(40);
const B = "b".repeat(40);

function baseState(extra = {}) {
  return {
    user: "zwymer",
    tokens: { zwymer: "tok-z" },
    repos: { [REPO]: { defaultBranch: "main", protected: ["main"], collaborators: { zwymer: "admin", mia: "maintain", rex: "read" } } },
    pulls: {
      "o/r#42": { title: "Main work", body: "Owner text", headRef: "feat/x", baseRef: "main", headSha: A, ci: "SUCCESS", checks: 3, additions: 412, deletions: 58 },
      "o/r#59": { title: "T3", headRef: "collab/pr-42/t3", baseRef: "feat/x", headSha: B, ci: "ERROR", checks: 2, mergeable: "UNKNOWN" },
      "o/r#60": { title: "T4", headRef: "collab/pr-42/t4", baseRef: "feat/x", ci: null },
      "o/r#61": { title: "T5", headRef: "collab/pr-42/t5", baseRef: "feat/x", ci: "SUCCESS", checks: 0 },
      "o/r#62": { title: "T6", headRef: "collab/pr-42/t6", baseRef: "feat/x", ci: "EXPECTED", checks: 1, mergeable: "CONFLICTING" },
    },
    ...extra,
  };
}

// Runs fn with a fresh fake gh in process.env, then restores the env and removes the state.
async function withFake(state, fn) {
  const fake = makeFakeGh(state);
  const restore = fake.use();
  gh.clearPermissionCache();
  try {
    return await fn(fake);
  } finally {
    restore();
    fake.cleanup();
  }
}

const apiCalls = (fake) => fake.calls().filter((c) => c.argv[0] === "api");

test("ghRaw runs the COLLAB_GH command and adds GH_TOKEN from auth", () =>
  withFake(baseState(), (fake) => {
    const r = gh.ghRaw(["api", "user", "--jq", ".login"], { auth: { token: "tok-z" } });
    assert.equal(r.code, 0);
    assert.equal(r.stdout.trim(), "zwymer");
    assert.equal(fake.calls()[0].env.GH_TOKEN, "tok-z");
  }));

test("ghRaw refuses a COLLAB_GH that is not a JSON array", () => {
  const prev = process.env.COLLAB_GH;
  process.env.COLLAB_GH = "gh --fake";
  try {
    assert.throws(() => gh.ghRaw(["--version"]), (e) => e.code === EXIT.ENV && /JSON array/.test(e.message));
  } finally {
    if (prev === undefined) delete process.env.COLLAB_GH;
    else process.env.COLLAB_GH = prev;
  }
});

test("getPr and repoInfo normalise the REST shapes", () =>
  withFake(baseState(), () => {
    const pr = gh.getPr(REPO, 42);
    assert.deepEqual(
      { number: pr.number, state: pr.state, merged: pr.merged, cross: pr.isCrossRepository, headRef: pr.headRef, headSha: pr.headSha, baseRef: pr.baseRef, url: pr.url },
      { number: 42, state: "OPEN", merged: false, cross: false, headRef: "feat/x", headSha: A, baseRef: "main", url: "https://github.com/o/r/pull/42" },
    );
    assert.deepEqual(gh.repoInfo(REPO), { defaultBranch: "main", allowSquash: true, allowMerge: true, private: true });
  }));

test("getPr flags a fork PR as cross-repository", () =>
  withFake(baseState({ pulls: { "o/r#7": { headRef: "patch-1", isCrossRepository: true } } }), () => {
    assert.equal(gh.getPr(REPO, 7).isCrossRepository, true);
  }));

test("merge with a stale SHA maps HTTP 409 to PRECONDITION 'head changed'", () =>
  withFake(baseState(), (fake) => {
    assert.throws(
      () => gh.merge(REPO, 59, { sha: "c".repeat(40), method: "squash" }),
      (e) => e.code === EXIT.PRECONDITION && e.message === "head changed" && e.details.status === 409,
    );
    assert.equal(fake.read().pulls["o/r#59"].merged, false);
  }));

test("merge with the approved SHA sends sha and merge_method through --input -", () =>
  withFake(baseState(), (fake) => {
    const r = gh.merge(REPO, 59, { sha: B, method: "squash" });
    assert.equal(r.merged, true);
    assert.match(r.sha, /^[0-9a-f]{40}$/);
    const call = apiCalls(fake).at(-1);
    assert.deepEqual(call.argv.slice(0, 6), ["api", "-X", "PUT", "repos/o/r/pulls/59/merge", "--input", "-"]);
    assert.deepEqual(JSON.parse(call.stdin), { sha: B, merge_method: "squash" });
  }));

test("HTTP errors map to PRECONDITION or ENV with details.status", () =>
  withFake(
    baseState({
      failures: [
        { match: "GET repos/o/r/pulls/42", status: 403, message: "Resource not accessible by integration", times: 1 },
        { match: "GET repos/o/r/pulls/60", status: null, times: 1 },
        { match: "PATCH repos/o/r/pulls/42", status: 422, message: "Validation Failed", times: 1 },
      ],
    }),
    () => {
      const check = (fn, code, status) => assert.throws(fn, (e) => e.code === code && e.details.status === status);
      check(() => gh.getPr(REPO, 42), EXIT.ENV, 403);
      check(() => gh.getPr(REPO, 999), EXIT.PRECONDITION, 404);
      check(() => gh.getPr(REPO, 42, { auth: { token: "wrong" } }), EXIT.ENV, 401);
      check(() => gh.getPr(REPO, 60), EXIT.ENV, null);
      check(() => gh.setBody(REPO, 42, "x"), EXIT.PRECONDITION, 422);
    },
  ));

test("liveSnapshot normalises CI and mergeable in one batched GraphQL query", () =>
  withFake(baseState(), (fake) => {
    const snap = gh.liveSnapshot(REPO, 42, { T3: 59, T4: 60, T5: 61, T6: 62, T9: 999 });
    assert.equal(snap.ok, true);
    assert.equal(snap.main.ci, "SUCCESS");
    assert.equal(snap.main.mergeable, "MERGEABLE");
    assert.equal(snap.main.headSha, A);
    assert.equal(snap.main.body, "Owner text");
    assert.deepEqual([snap.main.additions, snap.main.deletions], [412, 58]);
    assert.equal(snap.mainCi, "SUCCESS");
    assert.equal(snap.mainMergeable, "MERGEABLE");
    assert.deepEqual(snap.subs.T3, { state: "OPEN", merged: false, mergeable: "UNKNOWN", ci: "FAILURE", headSha: B, additions: 0, deletions: 0, draft: false });
    assert.equal(snap.subs.T4.ci, "NONE"); // no rollup
    assert.equal(snap.subs.T5.ci, "NONE"); // totalCount 0
    assert.equal(snap.subs.T6.ci, "PENDING"); // EXPECTED
    assert.equal(snap.subs.T6.mergeable, "CONFLICTING");
    assert.equal(snap.subs.T9, undefined); // GitHub couldn't find it

    const calls = apiCalls(fake);
    assert.equal(calls.length, 1);
    const { query } = JSON.parse(calls[0].stdin);
    assert.match(query, /main: pullRequest\(number:42\)/);
    assert.match(query, /s_T3: pullRequest\(number:59\)/);
    assert.match(query, /statusCheckRollup\{state contexts\{totalCount\}\}/);
  }));

test("liveSnapshot returns ok:false instead of throwing when gh fails", () =>
  withFake(baseState({ failures: [{ match: "POST graphql", status: 502, message: "Bad Gateway" }] }), () => {
    const snap = gh.liveSnapshot(REPO, 42, { T3: 59 });
    assert.equal(snap.ok, false);
    assert.match(snap.error, /502|Bad Gateway/);
    assert.equal(snap.mainCi, "UNKNOWN");
    assert.deepEqual(snap.subs, {});
  }));

test("liveSnapshot returns ok:false when gh can't even start or the main PR is missing", () =>
  withFake(baseState(), () => {
    assert.equal(gh.liveSnapshot(REPO, 4242, {}).ok, false);
    const prev = process.env.COLLAB_GH;
    process.env.COLLAB_GH = JSON.stringify(["definitely-not-a-gh-binary-xyz"]);
    try {
      const snap = gh.liveSnapshot(REPO, 42, {});
      assert.equal(snap.ok, false);
      assert.match(snap.error, /could not run gh/);
    } finally {
      process.env.COLLAB_GH = prev;
    }
  }));

test("permission is cached per process and maps unknown users to none", () =>
  withFake(baseState(), (fake) => {
    assert.equal(gh.permission(REPO, "zwymer"), "admin");
    assert.equal(gh.permission(REPO, "zwymer"), "admin");
    assert.equal(gh.permission(REPO, "ZWYMER"), "admin");
    assert.equal(apiCalls(fake).length, 1);
    assert.equal(gh.permission(REPO, "mia"), "write"); // REST .permission folds maintain into write
    assert.equal(gh.permission(REPO, "stranger"), "none");
    assert.equal(apiCalls(fake).length, 3);
  }));

test("commentsSince pages through every comment and returns those newer than sinceId, oldest first", () => {
  const comments = Array.from({ length: 130 }, (_, i) => ({ id: 1000 + i, login: i % 2 ? "zwymer" : "rex", body: `c${i}`, createdAt: "2026-11-16T10:00:00Z" }));
  comments.reverse();
  return withFake(baseState({ comments: { "o/r#42": comments } }), (fake) => {
    const got = gh.commentsSince(REPO, 42, 1120);
    assert.deepEqual(
      got.map((c) => c.id),
      Array.from({ length: 9 }, (_, i) => 1121 + i),
    );
    assert.deepEqual(Object.keys(got[0]).sort(), ["body", "createdAt", "id", "login", "url"]);
    assert.equal(got[0].url, "https://github.com/o/r/pull/42#issuecomment-1121");
    const argv = apiCalls(fake)[0].argv;
    assert.ok(argv.includes("--paginate") && argv.includes("--slurp"));
    assert.equal(gh.commentsSince(REPO, 42, 0).length, 130);
  });
});

test("commentsSince with sinceAt asks GitHub only for newer comments, and drops an old one edited later", () => {
  const comments = [
    { id: 1, login: "rex", body: "old", createdAt: "2026-11-16T09:00:00Z" },
    { id: 2, login: "rex", body: "old, edited later", createdAt: "2026-11-16T09:30:00Z", updatedAt: "2026-11-16T11:00:00Z" },
    { id: 3, login: "rex", body: "seen", createdAt: "2026-11-16T10:00:00Z" },
    { id: 4, login: "zwymer", body: "/collab pause", createdAt: "2026-11-16T10:00:00Z" },
    { id: 5, login: "zwymer", body: "new", createdAt: "2026-11-16T10:05:00Z" },
  ];
  return withFake(baseState({ comments: { "o/r#42": comments } }), (fake) => {
    const got = gh.commentsSince(REPO, 42, 3, { sinceAt: "2026-11-16T10:00:00Z" });
    assert.deepEqual(got.map((c) => c.id), [4, 5]);
    assert.match(apiCalls(fake)[0].argv[3], /[?&]since=2026-11-16T10%3A00%3A00\.000Z/);
    // No time, or a bad one: the whole thread, as before.
    assert.equal(gh.commentsSince(REPO, 42, 0, { sinceAt: null }).length, 5);
    assert.equal(gh.commentsSince(REPO, 42, 0, { sinceAt: "not a time" }).length, 5);
    assert.ok(!apiCalls(fake)[1].argv[3].includes("since="));
  });
});

test("newestComment reads the repo's newest comment with one request", () =>
  withFake(baseState({ comments: { "o/r#42": [{ id: 7, login: "rex", body: "a", createdAt: "2026-11-16T09:00:00Z" }], "o/r#43": [{ id: 9, login: "rex", body: "b", createdAt: "2026-11-16T10:00:00Z" }, { id: 8, login: "rex", body: "c" }] } }), (fake) => {
    assert.deepEqual(gh.newestComment(REPO), { id: 9, createdAt: "2026-11-16T10:00:00Z" });
    const calls = apiCalls(fake);
    assert.equal(calls.length, 1);
    assert.match(calls[0].argv[3], /^repos\/o\/r\/issues\/comments\?/);
    assert.match(calls[0].argv[3], /direction=desc/);
    assert.match(calls[0].argv[3], /per_page=1/);
    assert.ok(!calls[0].argv.includes("--paginate"));
  }));

test("newestComment is null on a repo with no comments", () =>
  withFake(baseState({ comments: {} }), () => {
    assert.equal(gh.newestComment(REPO), null);
  }));

test("createPr, comment, editComment, setBody, markReady and closePr round-trip through the fake", () =>
  withFake(baseState(), (fake) => {
    const pr = gh.createPr(REPO, { base: "feat/x", head: "collab/pr-42/t7", title: "T7", body: "Part of #42", draft: true });
    assert.equal(pr.number, 63);
    assert.equal(pr.url, "https://github.com/o/r/pull/63");
    assert.equal(gh.getPr(REPO, 63).draft, true);
    gh.markReady(REPO, 63);
    assert.equal(gh.getPr(REPO, 63).draft, false);
    assert.ok(apiCalls(fake).some((c) => c.stdin?.includes("markPullRequestReadyForReview")));

    const c = gh.comment(REPO, 42, "first");
    gh.editComment(REPO, c.id, "edited");
    assert.equal(gh.commentsSince(REPO, 42, 0).at(-1).body, "edited");

    gh.setBody(REPO, 42, "new body");
    assert.equal(gh.getPr(REPO, 42).body, "new body");
    gh.closePr(REPO, 63);
    assert.equal(gh.getPr(REPO, 63).state, "CLOSED");
    assert.equal(fake.read().pulls["o/r#63"].state, "closed");
  }));

test("deleteBranch ignores a branch that is already gone; branchProtected reads .protected", () =>
  withFake(baseState({ failures: [{ match: "GET repos/o/r/branches/gone", status: 404, message: "Branch not found" }] }), () => {
    assert.equal(gh.deleteBranch(REPO, "collab/pr-42/t3"), true);
    assert.equal(gh.deleteBranch(REPO, "collab/pr-42/t3"), false);
    assert.equal(gh.branchProtected(REPO, "main"), true);
    assert.equal(gh.branchProtected(REPO, "feat/x"), false);
    assert.equal(gh.branchProtected(REPO, "gone"), null);
  }));

test("api flattens --paginate --slurp pages and sends GET fields as a query string", () =>
  withFake(baseState({ comments: { "o/r#42": Array.from({ length: 5 }, (_, i) => ({ id: i + 1, login: "rex", body: "x" })) } }), (fake) => {
    const list = gh.api("GET", "repos/o/r/issues/42/comments", { fields: { per_page: 2 }, paginate: true });
    assert.deepEqual(list.map((c) => c.id), [1, 2, 3, 4, 5]);
    assert.equal(apiCalls(fake)[0].argv[3], "repos/o/r/issues/42/comments?per_page=2");
  }));

// ---------------------------------------------------------------------------
// Issues and labels (plan sessions)

function issueState(extra = {}) {
  const s = baseState({ tokens: { zwymer: "tok-z", rex: "tok-r", mia: "tok-m" }, ...extra });
  s.repos[REPO].labels = [{ name: "collab-plan", color: "5319e7", description: "Plan sessions" }];
  s.issues = {
    "o/r#70": { title: "Plan: caching", body: "the plan", labels: ["collab-plan"], author: "mia", createdAt: "2026-11-20T09:00:00Z", updatedAt: "2026-11-20T09:30:00Z" },
    "o/r#71": { title: "A bug", body: "", author: "rex" },
    "o/r#72": { title: "Old plan", state: "closed", stateReason: "completed", labels: ["collab-plan"], author: "zwymer" },
    ...extra.issues,
  };
  s.pulls["o/r#42"].labels = ["collab-plan"]; // GitHub's issue list holds PRs too
  return s;
}

test("getIssue normalises an issue, and answers for a PR number with isPr", () =>
  withFake(issueState(), () => {
    assert.deepEqual(gh.getIssue(REPO, 70), {
      number: 70,
      state: "OPEN",
      stateReason: null,
      locked: false,
      title: "Plan: caching",
      body: "the plan",
      labels: ["collab-plan"],
      url: "https://github.com/o/r/issues/70",
      isPr: false,
      author: "mia",
    });
    assert.equal(gh.getIssue(REPO, 72).state, "CLOSED");
    assert.equal(gh.getIssue(REPO, 72).stateReason, "completed");
    const pr = gh.getIssue(REPO, 42);
    assert.deepEqual([pr.isPr, pr.state, pr.url, pr.title, pr.labels], [true, "OPEN", "https://github.com/o/r/pull/42", "Main work", ["collab-plan"]]);
    assert.throws(() => gh.getIssue(REPO, 999), (e) => e.code === EXIT.PRECONDITION && e.details.status === 404);
    assert.throws(() => gh.getIssue(REPO, 0), (e) => e.code === EXIT.PRECONDITION);
    assert.throws(() => gh.getIssue("not a repo", 70), (e) => e.code === EXIT.PRECONDITION);
  }));

test("createIssue numbers issues and PRs from one counter and keeps labels only for writers", () =>
  withFake(issueState(), (fake) => {
    const made = gh.createIssue(REPO, { title: "Plan: search", body: "draft", labels: ["collab-plan", "needs-triage"] });
    assert.deepEqual(made, { number: 73, url: "https://github.com/o/r/issues/73" });
    const call = apiCalls(fake).at(-1);
    assert.deepEqual(call.argv.slice(0, 6), ["api", "-X", "POST", "repos/o/r/issues", "--input", "-"]);
    assert.deepEqual(JSON.parse(call.stdin), { title: "Plan: search", body: "draft", labels: ["collab-plan", "needs-triage"] });
    const got = gh.getIssue(REPO, 73);
    assert.deepEqual([got.author, got.labels, got.state], ["zwymer", ["collab-plan", "needs-triage"], "OPEN"]);
    assert.ok(fake.read().repos[REPO].labels.some((l) => l.name === "needs-triage"), "a missing label is created, as GitHub does");

    assert.equal(gh.createPr(REPO, { base: "main", head: "feat/y", title: "Y" }).number, 74, "PRs share the counter");
    const byReader = gh.createIssue(REPO, { title: "From a reader", labels: ["collab-plan"] }, { auth: { token: "tok-r" } });
    assert.equal(byReader.number, 75);
    const r = gh.getIssue(REPO, 75);
    assert.deepEqual([r.author, r.labels], ["rex", []], "GitHub drops labels from logins without push access");
    assert.throws(() => gh.createIssue(REPO, { title: " " }), (e) => e.code === EXIT.PRECONDITION && e.details.status === 422);
  }));

test("patchIssue sends only the keys given; closeIssue sets state_reason", () =>
  withFake(issueState(), (fake) => {
    const after = gh.patchIssue(REPO, 70, { body: "new plan text" });
    assert.deepEqual(JSON.parse(apiCalls(fake).at(-1).stdin), { body: "new plan text" });
    assert.deepEqual(apiCalls(fake).at(-1).argv.slice(0, 4), ["api", "-X", "PATCH", "repos/o/r/issues/70"]);
    assert.equal(after.body, "new plan text");
    assert.equal(after.title, "Plan: caching");
    gh.patchIssue(REPO, 70, { title: "Plan: caching v2" });
    assert.deepEqual(JSON.parse(apiCalls(fake).at(-1).stdin), { title: "Plan: caching v2" });

    gh.closeIssue(REPO, 70, { reason: "not_planned" });
    assert.deepEqual(JSON.parse(apiCalls(fake).at(-1).stdin), { state: "closed", state_reason: "not_planned" });
    assert.deepEqual([gh.getIssue(REPO, 70).state, gh.getIssue(REPO, 70).stateReason], ["CLOSED", "not_planned"]);
    gh.patchIssue(REPO, 70, { state: "OPEN" });
    assert.deepEqual(JSON.parse(apiCalls(fake).at(-1).stdin), { state: "open" });
    assert.deepEqual([gh.getIssue(REPO, 70).state, gh.getIssue(REPO, 70).stateReason], ["OPEN", "reopened"]);
    gh.closeIssue(REPO, 70);
    assert.deepEqual(JSON.parse(apiCalls(fake).at(-1).stdin), { state: "closed", state_reason: "completed" });
    assert.equal(fake.read().issues["o/r#70"].state, "closed");
    assert.throws(() => gh.patchIssue(REPO, 999, { body: "x" }), (e) => e.details.status === 404);
  }));

test("listIssues filters by label and state, pages through everything and drops PRs", () => {
  const many = Object.fromEntries(Array.from({ length: 120 }, (_, i) => [`o/r#${100 + i}`, { title: `p${i}`, labels: ["collab-plan"], author: "zwymer" }]));
  return withFake(issueState(), (fake) => {
    const open = gh.listIssues(REPO, { label: "collab-plan" });
    assert.deepEqual(open, [{ number: 70, title: "Plan: caching", url: "https://github.com/o/r/issues/70", state: "OPEN", updatedAt: "2026-11-20T09:30:00Z", author: "mia" }]);
    const argv = apiCalls(fake).at(-1).argv;
    assert.equal(argv[3], "repos/o/r/issues?state=open&per_page=100&labels=collab-plan");
    assert.ok(argv.includes("--paginate") && argv.includes("--slurp"));
    assert.deepEqual(gh.listIssues(REPO, { label: "collab-plan", state: "all" }).map((i) => i.number), [72, 70]);
    assert.deepEqual(gh.listIssues(REPO, { label: "collab-plan", state: "closed" }).map((i) => [i.number, i.state]), [[72, "CLOSED"]]);
    assert.deepEqual(gh.listIssues(REPO, {}).map((i) => i.number), [71, 70], "no label filter; PRs dropped");
    assert.deepEqual(gh.listIssues(REPO, { label: "COLLAB-PLAN" }).map((i) => i.number), [70], "labels match case-insensitively");
    assert.deepEqual(gh.listIssues(REPO, { label: "nothing-has-this" }), []);
    // The raw route includes PRs with a pull_request field, as GitHub does.
    const raw = gh.api("GET", "repos/o/r/issues", { fields: { labels: "collab-plan", state: "all" }, paginate: true });
    assert.deepEqual(raw.map((i) => [i.number, Boolean(i.pull_request)]), [[72, false], [70, false], [42, true]]);
    fake.update((st) => {
      Object.assign(st.issues, many);
    });
    assert.equal(gh.listIssues(REPO, { label: "collab-plan" }).length, 121, "more than one page of 100");
  });
});

test("ensureLabel: exists, created, raced, or forbidden; names are URL-encoded", () =>
  withFake(issueState(), (fake) => {
    assert.equal(gh.ensureLabel(REPO, "collab-plan"), "exists");
    assert.equal(apiCalls(fake).length, 1, "one GET when it exists");
    assert.equal(gh.ensureLabel(REPO, "Collab-Plan"), "exists", "GitHub matches label names case-insensitively");

    assert.equal(gh.ensureLabel(REPO, "plan session/v2", { color: "#0e8a16", description: "Plans" }), "created");
    const [get, post] = apiCalls(fake).slice(-2);
    assert.equal(get.argv[3], "repos/o/r/labels/plan%20session%2Fv2");
    assert.deepEqual(post.argv.slice(0, 4), ["api", "-X", "POST", "repos/o/r/labels"]);
    assert.deepEqual(JSON.parse(post.stdin), { name: "plan session/v2", color: "0e8a16", description: "Plans" });
    assert.deepEqual(fake.read().repos[REPO].labels.at(-1), { name: "plan session/v2", color: "0e8a16", description: "Plans" });
    assert.equal(gh.ensureLabel(REPO, "plan session/v2"), "exists");
    assert.equal(gh.ensureLabel(REPO, "defaults"), "created");
    assert.deepEqual(JSON.parse(apiCalls(fake).at(-1).stdin), { name: "defaults", color: "5319e7", description: "" });

    assert.equal(gh.ensureLabel(REPO, "new-for-rex", {}, { auth: { token: "tok-r" } }), "forbidden", "a reader can't create labels");
    assert.ok(!fake.read().repos[REPO].labels.some((l) => l.name === "new-for-rex"));
    fake.update((st) => {
      st.failures.push({ match: "POST repos/o/r/labels", status: 422, message: "Validation Failed", times: 1 });
      st.failures.push({ match: "GET repos/o/r/labels/locked-down", status: 403, message: "Resource not accessible by integration", times: 1 });
      st.failures.push({ match: "GET repos/o/r/labels/flaky", status: 502, message: "Bad Gateway", times: 1 });
    });
    assert.equal(gh.ensureLabel(REPO, "raced"), "exists", "422 on POST: someone made it meanwhile");
    assert.equal(gh.ensureLabel(REPO, "locked-down"), "forbidden");
    assert.throws(() => gh.ensureLabel(REPO, "flaky"), (e) => e.code === EXIT.ENV && e.details.status === 502);
    assert.throws(() => gh.ensureLabel(REPO, ""), (e) => e.code === EXIT.PRECONDITION);
  }));

test("comments work on issues, with /issues/ URLs and the same since filter as PRs", () =>
  withFake(issueState({ issues: { "o/r#70": { title: "Plan", labels: ["collab-plan"], author: "mia" } } }), (fake) => {
    const c = gh.comment(REPO, 70, "/collab agree r1 deadbeef", { auth: { token: "tok-m" } });
    assert.match(c.url, /^https:\/\/github\.com\/o\/r\/issues\/70#issuecomment-\d+$/);
    fake.update((st) => {
      st.comments["o/r#70"].push(
        { id: 5000, login: "rex", body: "old", createdAt: "2026-11-16T09:00:00Z" },
        { id: 5001, login: "rex", body: "new", createdAt: "2026-11-16T11:00:00Z" },
      );
    });
    const all = gh.commentsSince(REPO, 70, 0);
    assert.deepEqual(all.map((x) => [x.login, x.body]), [["mia", "/collab agree r1 deadbeef"], ["rex", "old"], ["rex", "new"]]);
    assert.ok(all.every((x) => x.url.includes("/issues/70#issuecomment-")));
    assert.deepEqual(gh.commentsSince(REPO, 70, 5000, { sinceAt: "2026-11-16T10:00:00Z" }).map((x) => x.id), [5001]);
    gh.editComment(REPO, 5001, "edited");
    assert.equal(gh.commentsSince(REPO, 70, 5000).at(-1).body, "edited");
    assert.equal(gh.newestComment(REPO).id, 5001);
    assert.match(gh.comment(REPO, 42, "on the PR").url, /\/pull\/42#issuecomment-/, "PR comments keep /pull/ URLs");
    assert.throws(() => gh.comment(REPO, 404, "nowhere"), (e) => e.details.status === 404);
  }));

test("the fake's gitDir mode reads head SHAs from a bare remote and merges into it", async () => {
  const repo = makeRepo();
  try {
    repo.clone("seed");
    const rev = (ref) => spawnSync("git", ["--git-dir", repo.remote, "rev-parse", ref], { encoding: "utf8" }).stdout.trim();
    const head = rev("refs/heads/feat/x");
    const mainBefore = rev("refs/heads/main");
    await withFake({ user: "zwymer", repos: { [REPO]: { gitDir: repo.remote } }, pulls: { "o/r#1": { title: "X", headRef: "feat/x", baseRef: "main" } } }, () => {
      assert.equal(gh.getPr(REPO, 1).headSha, head);
      assert.throws(() => gh.merge(REPO, 1, { sha: mainBefore, method: "squash" }), (e) => e.message === "head changed");
      const r = gh.merge(REPO, 1, { sha: head, method: "squash" });
      assert.equal(rev("refs/heads/main"), r.sha);
      assert.equal(rev(`${r.sha}^`), mainBefore);
      assert.equal(spawnSync("git", ["--git-dir", repo.remote, "cat-file", "-e", `${r.sha}:src/x.txt`]).status, 0);
      assert.equal(gh.deleteBranch(REPO, "feat/x"), true);
      assert.equal(gh.deleteBranch(REPO, "feat/x"), false);
    });
  } finally {
    repo.cleanup();
  }
});
