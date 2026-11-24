#!/usr/bin/env node
// A fake `gh` for tests: `gh auth token --user L`, `gh api ...` (the REST paths github.mjs uses,
// issues and labels included) and `gh api graphql` (liveSnapshot's aliased query and
// markPullRequestReadyForReview).
// State lives in the JSON file named by COLLAB_FAKE_GH_STATE; see fake-gh-state.mjs for its shape.
// Use it through makeFakeGh() in fake-gh-state.mjs, which sets COLLAB_GH to run this script.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { updateState } from "./fake-gh-state.mjs";

const res = (stdout, code = 0, stderr = "") => ({ code, stdout, stderr });
const httpFail = (status, message) => res(`${JSON.stringify({ message, status: String(status) })}\n`, 1, `gh: ${message} (HTTP ${status})\n`);
const networkFail = () => res("", 1, "error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com\n");
const fakeSha = (s) => createHash("sha1").update(String(s)).digest("hex");
const nowIso = () => process.env.COLLAB_NOW || new Date().toISOString();

function main() {
  const argv = process.argv.slice(2);
  const file = process.env.COLLAB_FAKE_GH_STATE;
  if (!file) {
    process.stderr.write("fake gh: COLLAB_FAKE_GH_STATE is not set\n");
    return 2;
  }
  const at = argv.indexOf("--input");
  const stdin = at >= 0 && argv[at + 1] === "-" ? readFileSync(0, "utf8") : null;
  let out;
  updateState(file, (state) => {
    state.calls ??= [];
    state.calls.push({ argv, stdin, env: { GH_TOKEN: process.env.GH_TOKEN ?? null, GITHUB_TOKEN: process.env.GITHUB_TOKEN ?? null } });
    try {
      out = run(state, argv, stdin);
    } catch (e) {
      out = res("", 1, `fake gh: ${e?.stack ?? e}\n`);
    }
  });
  if (out.stdout) process.stdout.write(out.stdout);
  if (out.stderr) process.stderr.write(out.stderr);
  return out.code;
}

function run(state, argv, stdin) {
  if (argv[0] === "auth" && argv[1] === "token") {
    const i = argv.findIndex((a) => a === "--user" || a === "-u");
    const user = i >= 0 ? argv[i + 1] : state.user;
    const token = user ? state.tokens?.[user] : null;
    return token ? res(`${token}\n`) : res("", 1, `no oauth token found for github.com${user ? ` account ${user}` : ""}\n`);
  }
  if (argv[0] === "api") return api(state, parseApi(argv.slice(1)), stdin);
  return res("", 1, `fake gh: unsupported command: ${argv.join(" ")}\n`);
}

// ---------------------------------------------------------------------------
// gh api

function parseApi(args) {
  const o = { method: null, path: null, input: false, fields: {}, paginate: false, slurp: false, jq: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-X" || a === "--method") o.method = String(args[++i]).toUpperCase();
    else if (a === "--input") o.input = args[++i] === "-";
    else if (a === "-f" || a === "--raw-field") addField(o.fields, args[++i], false);
    else if (a === "-F" || a === "--field") addField(o.fields, args[++i], true);
    else if (a === "--paginate") o.paginate = true;
    else if (a === "--slurp") o.slurp = true;
    else if (a === "--jq" || a === "-q") o.jq = args[++i];
    else if (["-H", "--header", "--hostname", "-t", "--template", "--cache", "-p", "--preview"].includes(a)) i++;
    else if (!a.startsWith("-") && o.path === null) o.path = a.replace(/^\/+/, "");
  }
  return o;
}

function addField(fields, kv, typed) {
  const eq = kv.indexOf("=");
  const key = kv.slice(0, eq);
  let v = kv.slice(eq + 1);
  if (typed) {
    if (v === "true" || v === "false") v = v === "true";
    else if (v === "null") v = null;
    else if (/^-?\d+$/.test(v)) v = Number(v);
  }
  fields[key] = v;
}

function api(state, o, stdin) {
  if (!o.path) return res("", 1, "fake gh: api needs a path\n");
  const hasBody = o.input || Object.keys(o.fields).length > 0;
  const method = o.method ?? (hasBody ? "POST" : "GET");
  const [path, qs] = o.path.split("?");
  const query = new URLSearchParams(qs ?? "");
  let body = o.input && stdin?.trim() ? JSON.parse(stdin) : {};
  if (method === "GET") for (const [k, v] of Object.entries(o.fields)) query.set(k, String(v));
  else body = { ...body, ...o.fields };

  const failure = takeFailure(state, `${method} ${path}`);
  if (failure) return failure.status == null ? networkFail() : httpFail(failure.status, failure.message ?? "injected failure");

  const who = whoami(state);
  if (who.fail) return who.fail;

  let r;
  if (path === "graphql") return graphql(state, body);
  if (path === "user") r = { data: { login: who.login, id: 1, type: "User" } };
  else {
    const seg = path.split("/").map(decodeURIComponent);
    r = seg[0] === "repos" && seg.length >= 3 ? repos(state, method, seg, body, who.login, query) : httpFail(404, "Not Found");
  }
  return emit(r, o, query);
}

function takeFailure(state, key) {
  const list = state.failures ?? [];
  const i = list.findIndex((f) => key.includes(f.match));
  if (i < 0) return null;
  const f = list[i];
  if (typeof f.times === "number") {
    f.times -= 1;
    if (f.times <= 0) list.splice(i, 1);
  }
  return f;
}

// GH_TOKEN selects the login holding that token; otherwise the active `user`.
function whoami(state) {
  const token = process.env.GH_TOKEN;
  if (token) {
    const login = Object.entries(state.tokens ?? {}).find(([, t]) => t === token)?.[0];
    return login ? { login } : { fail: httpFail(401, "Bad credentials") };
  }
  if (state.user) return { login: state.user };
  return { fail: res("", 4, "To get started with GitHub CLI, please run:  gh auth login\n") };
}

function emit(r, o, query) {
  if (r.list) {
    const per = Number(query.get("per_page")) || 30;
    const pages = [];
    for (let i = 0; i < r.list.length; i += per) pages.push(r.list.slice(i, i + per));
    if (!pages.length) pages.push([]);
    if (o.paginate && o.slurp) return print(pages, o.jq);
    if (o.paginate) return res(`${pages.map((p) => JSON.stringify(p)).join("")}\n`); // gh prints pages back to back
    return print(pages[(Number(query.get("page")) || 1) - 1] ?? [], o.jq);
  }
  if ("data" in r) return r.data === undefined ? res("") : print(r.data, o.jq);
  return r;
}

function print(value, jq) {
  if (!jq) return res(`${JSON.stringify(value)}\n`);
  if (!/^(\.[A-Za-z_][\w]*)+$/.test(jq)) return res("", 1, `fake gh: unsupported --jq expression: ${jq}\n`);
  let v = value;
  for (const k of jq.slice(1).split(".")) v = v?.[k];
  return res(`${typeof v === "string" ? v : JSON.stringify(v ?? null)}\n`);
}

// ---------------------------------------------------------------------------
// State access

function findKey(obj, key) {
  return Object.keys(obj ?? {}).find((k) => k.toLowerCase() === key.toLowerCase());
}

function repoOf(state, repo) {
  const key = findKey(state.repos, repo);
  if (!key) return null;
  state.repos[key] = { defaultBranch: "main", allowSquash: true, allowMerge: true, private: true, protected: [], collaborators: {}, labels: [], ...state.repos[key] };
  return state.repos[key];
}

const ROLE_RANK = { none: 0, read: 1, triage: 2, write: 3, maintain: 4, admin: 5 };

function roleOf(r, login) {
  const who = login ? findKey(r.collaborators, login) : null;
  return who ? r.collaborators[who] : "none";
}

const canPush = (r, login) => (ROLE_RANK[roleOf(r, login)] ?? 0) >= ROLE_RANK.write;

// Issues and PRs share one number space, as on GitHub.
function nextNumber(state, repo) {
  const prefix = `${repo.toLowerCase()}#`;
  const numbers = Object.keys({ ...state.pulls, ...state.issues, ...state.comments })
    .filter((k) => k.toLowerCase().startsWith(prefix))
    .map((k) => Number(k.split("#")[1]))
    .filter(Number.isFinite);
  return Math.max(0, ...numbers) + 1;
}

// An issue (not a PR) with defaults filled in, or null.
function issueOf(state, repo, n) {
  const key = findKey(state.issues, `${repo}#${n}`);
  if (!key) return null;
  const stored = state.issues[key];
  const created = stored.createdAt ?? nowIso();
  const i = { number: n, title: "", body: "", state: "open", stateReason: null, locked: false, labels: [], author: state.user, createdAt: created, updatedAt: stored.updatedAt ?? created, ...stored };
  i.state = String(i.state).toLowerCase() === "closed" ? "closed" : "open";
  state.issues[key] = i;
  return i;
}

const isIssue = (state, repo, n) => Boolean(findKey(state.issues, `${repo}#${n}`)) && !findKey(state.pulls, `${repo}#${n}`);

const labelName = (l) => (typeof l === "string" ? l : l?.name);

function findLabel(r, name) {
  return (r.labels ?? []).find((l) => String(l.name).toLowerCase() === String(name).toLowerCase()) ?? null;
}

// The repo's label with this name, created (GitHub's default grey) when missing.
function ensureRepoLabel(r, name) {
  let l = findLabel(r, name);
  if (!l) {
    l = { name: String(name), color: "ededed", description: "" };
    (r.labels ??= []).push(l);
  }
  return l;
}

function addLabels(r, current, wanted) {
  const out = [...(current ?? [])];
  for (const raw of wanted) {
    const name = ensureRepoLabel(r, raw).name;
    if (!out.some((x) => x.toLowerCase() === name.toLowerCase())) out.push(name);
  }
  return out;
}

const restLabel = (repo, l) => ({
  id: Number.parseInt(fakeSha(`${repo}:${l.name}`).slice(0, 8), 16),
  node_id: `LA_${fakeSha(`${repo}:${l.name}`).slice(0, 16)}`,
  url: `https://api.github.com/repos/${repo}/labels/${encodeURIComponent(l.name)}`,
  name: l.name,
  color: l.color ?? "ededed",
  description: l.description ?? "",
  default: false,
});

const labelObjs = (repo, r, names) => (names ?? []).map((n) => restLabel(repo, findLabel(r, n) ?? { name: n }));

function restIssue(state, repo, r, i) {
  return {
    id: Number.parseInt(fakeSha(`${repo}#${i.number}:issue`).slice(0, 8), 16),
    node_id: `I_${fakeSha(`${repo}#${i.number}`).slice(0, 16)}`,
    number: i.number,
    html_url: `https://github.com/${repo}/issues/${i.number}`,
    url: `https://api.github.com/repos/${repo}/issues/${i.number}`,
    title: i.title,
    body: i.body,
    state: i.state,
    state_reason: i.stateReason ?? null,
    locked: Boolean(i.locked),
    labels: labelObjs(repo, r, i.labels),
    user: { login: i.author ?? state.user },
    comments: (state.comments?.[findKey(state.comments, `${repo}#${i.number}`)] ?? []).length,
    created_at: i.createdAt,
    updated_at: i.updatedAt,
    closed_at: i.state === "closed" ? (i.closedAt ?? i.updatedAt) : null,
  };
}

// A PR as GitHub's issues API shows it: with a pull_request field.
function prAsIssue(state, repo, r, p) {
  return {
    id: Number.parseInt(fakeSha(`${repo}#${p.number}:issue`).slice(0, 8), 16),
    node_id: p.nodeId,
    number: p.number,
    html_url: `https://github.com/${repo}/pull/${p.number}`,
    url: `https://api.github.com/repos/${repo}/issues/${p.number}`,
    title: p.title,
    body: p.body,
    state: p.state,
    state_reason: null,
    locked: false,
    labels: labelObjs(repo, r, p.labels),
    user: { login: p.author ?? state.user },
    comments: (state.comments?.[findKey(state.comments, `${repo}#${p.number}`)] ?? []).length,
    created_at: p.createdAt ?? nowIso(),
    updated_at: p.updatedAt ?? p.createdAt ?? nowIso(),
    closed_at: p.state === "closed" ? (p.mergedAt ?? nowIso()) : null,
    pull_request: {
      url: `https://api.github.com/repos/${repo}/pulls/${p.number}`,
      html_url: `https://github.com/${repo}/pull/${p.number}`,
      merged_at: p.merged ? (p.mergedAt ?? nowIso()) : null,
    },
  };
}

// The issue or PR behind issues/:n in its issue shape, or null.
function anyIssue(state, repo, r, n) {
  const p = pullOf(state, repo, n);
  if (p) return { pr: p, rest: () => prAsIssue(state, repo, r, p) };
  const i = issueOf(state, repo, n);
  return i ? { issue: i, rest: () => restIssue(state, repo, r, i) } : null;
}

// Now, but never before the last update (a pinned clock can lag a browser edit's time).
function touch(prev) {
  const t = Math.max(Date.parse(nowIso()), prev ? Date.parse(prev) || 0 : 0);
  return new Date(t).toISOString();
}

function pullOf(state, repo, n) {
  const key = findKey(state.pulls, `${repo}#${n}`);
  if (!key) return null;
  const r = repoOf(state, repo) ?? {};
  const p = {
    number: n,
    title: "",
    body: "",
    state: "open",
    merged: false,
    draft: false,
    headRef: `feat/pr-${n}`,
    baseRef: r.defaultBranch ?? "main",
    headSha: null,
    isCrossRepository: false,
    mergeable: "MERGEABLE",
    ci: null,
    additions: 0,
    deletions: 0,
    nodeId: `PR_${fakeSha(key).slice(0, 16)}`,
    ...state.pulls[key],
  };
  p.state = String(p.state).toLowerCase();
  if (p.state === "merged") Object.assign(p, { state: "closed", merged: true });
  p.headSha = (r.gitDir && gitRev(r.gitDir, p.headRef)) || p.headSha || fakeSha(`${key}:head`);
  state.pulls[key] = p;
  return p;
}

function restPull(state, repo, p) {
  const name = repo.split("/")[1];
  const headRepo = p.isCrossRepository ? (p.headRepo === null ? null : { full_name: p.headRepo ?? `fork-owner/${name}` }) : { full_name: repo };
  return {
    number: p.number,
    node_id: p.nodeId,
    html_url: `https://github.com/${repo}/pull/${p.number}`,
    url: `https://api.github.com/repos/${repo}/pulls/${p.number}`,
    title: p.title,
    body: p.body,
    state: p.state,
    merged: p.merged,
    merged_at: p.merged ? (p.mergedAt ?? nowIso()) : null,
    merge_commit_sha: p.mergeCommitSha ?? null,
    draft: p.draft,
    mergeable: p.mergeable === "MERGEABLE" ? true : p.mergeable === "CONFLICTING" ? false : null,
    head: { ref: p.headRef, sha: p.headSha, repo: headRepo },
    base: { ref: p.baseRef, repo: { full_name: repo } },
    user: { login: p.author ?? state.user },
  };
}

function gqlPull(p) {
  const rollup = p.ci ? { state: p.ci, contexts: { totalCount: p.checks ?? 1 } } : null;
  return {
    id: p.nodeId,
    number: p.number,
    title: p.title,
    body: p.body,
    state: p.merged ? "MERGED" : p.state === "open" ? "OPEN" : "CLOSED",
    merged: p.merged,
    mergeable: p.mergeable ?? "UNKNOWN",
    isDraft: p.draft,
    isCrossRepository: p.isCrossRepository,
    headRefName: p.headRef,
    baseRefName: p.baseRef,
    headRefOid: p.headSha,
    additions: p.additions,
    deletions: p.deletions,
    commits: { nodes: [{ commit: { oid: p.headSha, statusCheckRollup: rollup } }] },
  };
}

function restComment(state, repo, n, c) {
  const created = c.createdAt ?? c.created_at ?? nowIso();
  return {
    id: c.id,
    node_id: `IC_${c.id}`,
    html_url: `https://github.com/${repo}/${isIssue(state, repo, n) ? "issues" : "pull"}/${n}#issuecomment-${c.id}`,
    body: c.body ?? "",
    user: { login: c.login ?? c.user?.login ?? null },
    created_at: created,
    updated_at: c.updatedAt ?? created,
    author_association: c.authorAssociation ?? "OWNER",
  };
}

// ---------------------------------------------------------------------------
// REST routes under repos/{o}/{r}

function repos(state, method, seg, body, login, query = new URLSearchParams()) {
  const repo = `${seg[1]}/${seg[2]}`;
  const r = repoOf(state, repo);
  if (!r) return httpFail(404, "Not Found");
  const rest = seg.slice(3);
  const route = `${method} ${rest.map((s, i) => (i === 1 && /^\d+$/.test(s) ? ":n" : s)).join("/")}`;
  const n = Number(rest[1]);

  if (route === "GET ") {
    const [owner, name] = repo.split("/");
    return {
      data: {
        full_name: repo,
        name,
        owner: { login: owner },
        default_branch: r.defaultBranch,
        allow_squash_merge: r.allowSquash,
        allow_merge_commit: r.allowMerge,
        private: r.private,
      },
    };
  }
  if (route === "POST pulls") return createPull(state, repo, r, body, login);
  if (route === "GET pulls") {
    const head = (query.get("head") ?? "").split(":").pop();
    const want = query.get("state") ?? "open";
    const list = Object.keys(state.pulls ?? {})
      .filter((k) => k.toLowerCase().startsWith(`${repo.toLowerCase()}#`))
      .map((k) => pullOf(state, repo, Number(k.split("#")[1])))
      .filter((p) => (!head || p.headRef === head) && (want === "all" || p.state === want));
    return { list: list.map((p) => restPull(state, repo, p)) };
  }
  if (route === "GET pulls/:n" || route === "PATCH pulls/:n" || route === "PUT pulls/:n/merge") {
    const p = pullOf(state, repo, n);
    if (!p) return httpFail(404, "Not Found");
    if (method === "GET") return { data: restPull(state, repo, p) };
    if (method === "PATCH") {
      for (const k of ["title", "body"]) if (typeof body[k] === "string") p[k] = body[k];
      if (body.state === "closed" || body.state === "open") p.state = body.state;
      if (typeof body.base === "string") p.baseRef = body.base;
      return { data: restPull(state, repo, p) };
    }
    return mergePull(repo, r, p, body);
  }
  if (route === "GET issues/comments") {
    // Every issue and PR comment in the repo; ids are unique across it.
    const mine = Object.entries(state.comments ?? {}).filter(([k]) => k.toLowerCase().startsWith(`${repo.toLowerCase()}#`));
    const dir = query.get("direction") === "desc" ? -1 : 1;
    return { list: mine.flatMap(([k, l]) => l.map((c) => restComment(state, repo, Number(k.split("#")[1]), c))).sort((a, b) => dir * (a.id - b.id)) };
  }
  if (route === "GET issues/:n/comments" || route === "POST issues/:n/comments") {
    const key = findKey(state.comments, `${repo}#${n}`) ?? `${repo}#${n}`;
    if (!findKey(state.pulls, `${repo}#${n}`) && !findKey(state.issues, `${repo}#${n}`) && !state.comments?.[key]) return httpFail(404, "Not Found");
    state.comments ??= {};
    state.comments[key] ??= [];
    if (method === "GET") {
      // GitHub's `since`: only comments updated at or after that time.
      const since = query.get("since") ? Date.parse(query.get("since")) : null;
      const all = state.comments[key].map((c) => restComment(state, repo, n, c));
      return { list: since == null ? all : all.filter((c) => Date.parse(c.updated_at) >= since) };
    }
    const c = { id: state.nextId ?? 1000, login, body: String(body.body ?? ""), createdAt: nowIso() };
    state.nextId = c.id + 1;
    state.comments[key].push(c);
    const issue = isIssue(state, repo, n) ? issueOf(state, repo, n) : null;
    if (issue) issue.updatedAt = touch(issue.updatedAt); // a comment updates the issue, as on GitHub
    return { data: restComment(state, repo, n, c) };
  }
  if (method === "PATCH" && rest[0] === "issues" && rest[1] === "comments" && rest.length === 3) {
    const id = Number(rest[2]);
    for (const [key, list] of Object.entries(state.comments ?? {})) {
      if (!key.toLowerCase().startsWith(`${repo.toLowerCase()}#`)) continue;
      const c = list.find((x) => Number(x.id) === id);
      if (!c) continue;
      c.body = String(body.body ?? "");
      c.updatedAt = nowIso();
      return { data: restComment(state, repo, Number(key.split("#")[1]), c) };
    }
    return httpFail(404, "Not Found");
  }
  if (route === "POST issues") return createIssue(state, repo, r, body, login);
  if (route === "GET issues") {
    // Issues and PRs (each PR with a pull_request field), newest first, like GitHub's default sort.
    const want = (query.get("state") ?? "open").toLowerCase();
    const labels = (query.get("labels") ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    const prefix = `${repo.toLowerCase()}#`;
    const numbers = (obj) => Object.keys(obj ?? {}).filter((k) => k.toLowerCase().startsWith(prefix)).map((k) => Number(k.split("#")[1]));
    const all = [
      ...numbers(state.pulls).map((k) => prAsIssue(state, repo, r, pullOf(state, repo, k))),
      ...numbers(state.issues).filter((k) => !findKey(state.pulls, `${repo}#${k}`)).map((k) => restIssue(state, repo, r, issueOf(state, repo, k))),
    ];
    const list = all
      .filter((i) => want === "all" || i.state === want)
      .filter((i) => labels.every((l) => i.labels.some((x) => x.name.toLowerCase() === l)))
      .sort((a, b) => b.number - a.number);
    return { list };
  }
  if (route === "GET issues/:n" || route === "PATCH issues/:n") {
    const hit = anyIssue(state, repo, r, n);
    if (!hit) return httpFail(404, "Not Found");
    if (method === "PATCH") {
      const target = hit.pr ?? hit.issue;
      for (const k of ["title", "body"]) if (typeof body[k] === "string") target[k] = body[k];
      if (hit.issue) {
        const was = hit.issue.state;
        if (body.state === "closed" || body.state === "open") hit.issue.state = body.state;
        if ("state_reason" in body) hit.issue.stateReason = body.state_reason;
        else if (hit.issue.state !== was) hit.issue.stateReason = hit.issue.state === "closed" ? "completed" : "reopened";
        if (hit.issue.state === "closed" && was !== "closed") hit.issue.closedAt = nowIso();
        if (Array.isArray(body.labels)) hit.issue.labels = addLabels(r, [], body.labels.map(labelName).filter(Boolean));
        hit.issue.updatedAt = touch(hit.issue.updatedAt);
      } else if (body.state === "closed" || body.state === "open") {
        hit.pr.state = body.state;
      }
    }
    return { data: hit.rest() };
  }
  if (route === "POST issues/:n/labels") {
    const hit = anyIssue(state, repo, r, n);
    if (!hit) return httpFail(404, "Not Found");
    if (!canPush(r, login)) return httpFail(403, "Must have push access to add labels.");
    const target = hit.pr ?? hit.issue;
    target.labels = addLabels(r, target.labels, (Array.isArray(body.labels) ? body.labels : []).map(labelName).filter(Boolean));
    if (hit.issue) hit.issue.updatedAt = touch(hit.issue.updatedAt);
    return { data: labelObjs(repo, r, target.labels) };
  }
  if (method === "GET" && rest[0] === "labels" && rest.length === 2) {
    const l = findLabel(r, rest[1]);
    return l ? { data: restLabel(repo, l) } : httpFail(404, "Not Found");
  }
  if (method === "POST" && rest[0] === "labels" && rest.length === 1) {
    if (!canPush(r, login)) return httpFail(403, "Must have admin rights to Repository.");
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const color = String(body.color ?? "ededed").replace(/^#/, "");
    if (!name || !/^[0-9a-f]{6}$/i.test(color)) return httpFail(422, "Validation Failed");
    if (findLabel(r, name)) return httpFail(422, "Validation Failed");
    const l = { name, color: color.toLowerCase(), description: String(body.description ?? "") };
    (r.labels ??= []).push(l);
    return { data: restLabel(repo, l) };
  }
  if (method === "GET" && rest[0] === "collaborators" && rest[2] === "permission" && rest.length === 3) {
    const who = findKey(r.collaborators, rest[1]);
    const role = who ? r.collaborators[who] : "none";
    const legacy = { maintain: "write", triage: "read" }[role] ?? role;
    return { data: { permission: legacy, role_name: role, user: { login: rest[1] } } };
  }
  if (method === "GET" && rest[0] === "branches" && rest.length >= 2) {
    const branch = rest.slice(1).join("/");
    if (!branchExists(r, branch)) return httpFail(404, "Branch not found");
    return { data: { name: branch, protected: (r.protected ?? []).includes(branch) } };
  }
  if (method === "DELETE" && rest[0] === "git" && rest[1] === "refs" && rest[2] === "heads" && rest.length >= 4) {
    const branch = rest.slice(3).join("/");
    if (!branchExists(r, branch)) return httpFail(422, "Reference does not exist");
    if (r.gitDir) git(r.gitDir, ["update-ref", "-d", `refs/heads/${branch}`]);
    else if (Array.isArray(r.branches)) r.branches = r.branches.filter((b) => b !== branch);
    (r.deletedBranches ??= []).push(branch);
    return { data: undefined };
  }
  return httpFail(404, "Not Found");
}

function branchExists(r, branch) {
  if (r.gitDir) return Boolean(gitRev(r.gitDir, branch));
  if (Array.isArray(r.branches)) return r.branches.includes(branch);
  return !(r.deletedBranches ?? []).includes(branch);
}

function createPull(state, repo, r, body, login) {
  const { head, base, title } = body;
  if (!head || !base || !title) return httpFail(422, "Validation Failed");
  if (r.gitDir && !gitRev(r.gitDir, head)) return httpFail(422, "Validation Failed");
  const prefix = `${repo.toLowerCase()}#`;
  for (const k of Object.keys(state.pulls ?? {})) {
    if (!k.toLowerCase().startsWith(prefix)) continue;
    const p = pullOf(state, repo, Number(k.split("#")[1]));
    if (p.state === "open" && p.headRef === head && p.baseRef === base) {
      return httpFail(422, `A pull request already exists for ${repo.split("/")[0]}:${head}.`);
    }
  }
  const n = nextNumber(state, repo);
  state.pulls ??= {};
  state.pulls[`${repo}#${n}`] = {
    title,
    body: body.body ?? "",
    state: "open",
    draft: Boolean(body.draft),
    headRef: head,
    baseRef: base,
    author: login,
  };
  return { data: restPull(state, repo, pullOf(state, repo, n)) };
}

// Labels stick only for logins with push access (GitHub drops them silently otherwise); a label
// the repo lacks is created.
function createIssue(state, repo, r, body, login) {
  const title = typeof body.title === "string" ? body.title : "";
  if (!title.trim()) return httpFail(422, "Validation Failed");
  const wanted = (Array.isArray(body.labels) ? body.labels : []).map(labelName).filter(Boolean);
  const n = nextNumber(state, repo);
  const at = nowIso();
  state.issues ??= {};
  state.issues[`${repo}#${n}`] = {
    title,
    body: typeof body.body === "string" ? body.body : "",
    state: "open",
    stateReason: null,
    locked: false,
    labels: canPush(r, login) ? addLabels(r, [], wanted) : [],
    author: login,
    createdAt: at,
    updatedAt: at,
  };
  return { data: restIssue(state, repo, r, issueOf(state, repo, n)) };
}

function mergePull(repo, r, p, body) {
  if (p.merged || p.state !== "open") return httpFail(405, "Pull Request is not mergeable");
  if (body.sha && body.sha !== p.headSha) return httpFail(409, "Head branch was modified. Review and try the merge again.");
  if (p.mergeable === "CONFLICTING") return httpFail(405, "Pull Request is not mergeable");
  const method = body.merge_method ?? "merge";
  if (method === "squash" && r.allowSquash === false) return httpFail(405, "Squash merges are not allowed on this repository.");
  if (method === "merge" && r.allowMerge === false) return httpFail(405, "Merge commits are not allowed on this repository.");
  let sha = fakeSha(`${repo}#${p.number}:merged`);
  if (r.gitDir) {
    sha = gitMerge(r.gitDir, p, method);
    if (!sha) return httpFail(405, "Pull Request is not mergeable");
  }
  Object.assign(p, { merged: true, state: "closed", mergedAt: nowIso(), mergeCommitSha: sha, mergeMethod: method });
  return { data: { sha, merged: true, message: "Pull Request successfully merged" } };
}

// ---------------------------------------------------------------------------
// GraphQL (pragmatic: aliases found with a regex, every PR field returned)

function graphql(state, body) {
  const q = String(body.query ?? "");
  const vars = body.variables ?? Object.fromEntries(Object.entries(body).filter(([k]) => k !== "query" && k !== "operationName"));
  const answer = (resp) => {
    const stdout = `${JSON.stringify(resp)}\n`;
    return resp.errors?.length ? res(stdout, 1, `gh: ${resp.errors.map((e) => e.message).join("\n")}\n`) : res(stdout);
  };

  if (/markPullRequestReadyForReview/.test(q)) {
    const id = vars.id ?? vars.pullRequestId ?? /pullRequestId\s*:\s*"([^"]+)"/.exec(q)?.[1];
    for (const key of Object.keys(state.pulls ?? {})) {
      const [repo, n] = key.split("#");
      const p = pullOf(state, repo, Number(n));
      if (p.nodeId !== id) continue;
      p.draft = false;
      return answer({ data: { markPullRequestReadyForReview: { pullRequest: { id, isDraft: false } } } });
    }
    return answer({ data: { markPullRequestReadyForReview: null }, errors: [{ type: "NOT_FOUND", message: `Could not resolve to a node with the global id of '${id}'` }] });
  }

  const owner = vars.owner ?? /repository\(\s*owner\s*:\s*"([^"]+)"/.exec(q)?.[1];
  const name = vars.name ?? /repository\([^)]*name\s*:\s*"([^"]+)"/.exec(q)?.[1];
  const repo = `${owner}/${name}`;
  if (!repoOf(state, repo)) {
    return answer({ data: { repository: null }, errors: [{ type: "NOT_FOUND", path: ["repository"], message: `Could not resolve to a Repository with the name '${repo}'.` }] });
  }
  const repository = {};
  const errors = [];
  const resolve = (v) => Number(v.startsWith("$") ? vars[v.slice(1)] : v);
  const found = [...q.matchAll(/(?:(\w+)\s*:\s*)?pullRequest\(\s*number\s*:\s*(\$?\w+)\s*\)/g)];
  for (const m of found) {
    const alias = m[1] ?? "pullRequest";
    const n = resolve(m[2]);
    const p = pullOf(state, repo, n);
    repository[alias] = p ? gqlPull(p) : null;
    if (!p) errors.push({ type: "NOT_FOUND", path: ["repository", alias], message: `Could not resolve to a PullRequest with the number of ${n}.` });
  }
  return answer(errors.length ? { data: { repository }, errors } : { data: { repository } });
}

// ---------------------------------------------------------------------------
// Optional bare repo behind a fake repo (repos[x].gitDir)

function git(gitDir, args) {
  const who = { GIT_AUTHOR_NAME: "fake-gh", GIT_AUTHOR_EMAIL: "fake-gh@example.test", GIT_COMMITTER_NAME: "fake-gh", GIT_COMMITTER_EMAIL: "fake-gh@example.test" };
  return spawnSync("git", ["--git-dir", gitDir, ...args], { encoding: "utf8", shell: false, windowsHide: true, env: { ...process.env, ...who } });
}

function gitRev(gitDir, branch) {
  const r = git(gitDir, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`]);
  return r.status === 0 ? r.stdout.trim() : null;
}

// Squash (or rebase) makes one commit on base; merge makes a two-parent commit. null on conflict.
function gitMerge(gitDir, p, method) {
  const base = gitRev(gitDir, p.baseRef);
  const head = gitRev(gitDir, p.headRef);
  if (!base || !head) return null;
  const mt = git(gitDir, ["merge-tree", "--write-tree", base, head]);
  if (mt.status !== 0) return null;
  const tree = mt.stdout.split("\n")[0].trim();
  const parents = method === "merge" ? ["-p", base, "-p", head] : ["-p", base];
  const msg = method === "merge" ? `Merge pull request #${p.number} from ${p.headRef}` : `${p.title || p.headRef} (#${p.number})`;
  const ct = git(gitDir, ["commit-tree", tree, ...parents, "-m", msg]);
  if (ct.status !== 0) throw new Error(`commit-tree failed: ${ct.stderr}`);
  const sha = ct.stdout.trim();
  const ur = git(gitDir, ["update-ref", `refs/heads/${p.baseRef}`, sha, base]);
  if (ur.status !== 0) throw new Error(`update-ref failed: ${ur.stderr}`);
  return sha;
}

process.exitCode = main();
