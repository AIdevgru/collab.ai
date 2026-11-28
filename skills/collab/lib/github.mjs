// All GitHub access goes through `gh api` (REST and GraphQL). Nothing else talks to GitHub.
// `identity.mjs` also uses ghRaw for `gh auth token`.

import { spawnSync } from "node:child_process";
import { CollabError, EXIT } from "./errors.mjs";

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ALIAS_RE = /^[A-Za-z0-9_]+$/;
const PERMISSIONS = new Set(["admin", "maintain", "write", "triage", "read", "none"]);

// ---------------------------------------------------------------------------
// Process layer

function ghCommand(env) {
  const raw = env.COLLAB_GH;
  if (!raw) return ["gh"];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every((s) => typeof s === "string" && s)) {
    throw new CollabError(EXIT.ENV, 'COLLAB_GH must be a JSON array of strings, for example ["gh"] or ["node","/abs/fake-gh.mjs"].');
  }
  return parsed;
}

// Runs gh (or the COLLAB_GH override) with an argument array; never a shell string.
// `env` replaces the child's environment when given; `auth.token` adds GH_TOKEN on top.
export function ghRaw(args, { env, input, auth } = {}) {
  const base = env ?? process.env;
  const [cmd, ...lead] = ghCommand({ ...process.env, ...base });
  const childEnv = { ...base, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" };
  if (auth?.token) childEnv.GH_TOKEN = auth.token;
  const r = spawnSync(cmd, [...lead, ...args], {
    shell: false,
    encoding: "utf8",
    windowsHide: true,
    env: childEnv,
    input: input ?? "",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) {
    const hint = r.error.code === "ENOENT" ? "Install the GitHub CLI (https://cli.github.com) and run `gh auth login`." : r.error.message;
    throw new CollabError(EXIT.ENV, `could not run gh (${cmd}): ${hint}`, { cause: r.error.code });
  }
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

// ---------------------------------------------------------------------------
// Error mapping

function firstLine(s) {
  return String(s ?? "").trim().split(/\r?\n/)[0].replace(/^gh:\s*/, "");
}

export function httpStatusOf(stderr) {
  const m = /\(HTTP (\d{3})\)/.exec(stderr ?? "");
  return m ? Number(m[1]) : null;
}

function apiError(method, path, r) {
  const status = httpStatusOf(r.stderr);
  const what = `${method} ${path}`;
  const said = firstLine(r.stderr) || `gh exited ${r.code}`;
  const details = { status, method, path, stderr: r.stderr.trim() };
  if (status === 401) {
    return new CollabError(EXIT.ENV, `GitHub rejected the gh credentials for ${what} (HTTP 401). Run \`gh auth status\` and sign in again.`, details);
  }
  if (status === 403) {
    return new CollabError(EXIT.ENV, `GitHub refused ${what} (HTTP 403): ${said}. Check that the pinned account can access the repo, or wait out a rate limit.`, details);
  }
  if (status === 404) {
    return new CollabError(EXIT.PRECONDITION, `GitHub found nothing at ${what} (HTTP 404). Check the repo and number, and that the pinned account can see the repo.`, details);
  }
  if (status !== null && status >= 400 && status < 500) {
    return new CollabError(EXIT.PRECONDITION, `GitHub rejected ${what}: ${said}`, details);
  }
  return new CollabError(EXIT.ENV, `gh api ${what} failed: ${said}. Check your network and \`gh auth status\`.`, details);
}

function parseJson(text) {
  const t = (text ?? "").trim();
  if (!t) return null;
  return JSON.parse(t);
}

// ---------------------------------------------------------------------------
// REST + GraphQL

// gh api -X METHOD path [--input -]. `fields` become the query string for GET/DELETE
// and are merged into the JSON body otherwise (never -F, which reads files for "@...").
// `paginate` adds --paginate --slurp and flattens the pages of a list endpoint.
export function api(method, path, { fields, body, auth, paginate = false } = {}) {
  const M = String(method).toUpperCase();
  let p = String(path).replace(/^\/+/, "");
  let payload = body;
  if (fields && Object.keys(fields).length) {
    if (M === "GET" || M === "DELETE") {
      const qs = new URLSearchParams(Object.entries(fields).map(([k, v]) => [k, String(v)])).toString();
      p += (p.includes("?") ? "&" : "?") + qs;
    } else {
      payload = { ...(payload ?? {}), ...fields };
    }
  }
  const args = ["api", "-X", M, p];
  if (paginate) args.push("--paginate", "--slurp");
  let input;
  if (payload !== undefined && payload !== null) {
    args.push("--input", "-");
    input = JSON.stringify(payload);
  }
  const r = ghRaw(args, { input, auth });
  if (r.code !== 0) throw apiError(M, p, r);
  let out;
  try {
    out = parseJson(r.stdout);
  } catch {
    throw new CollabError(EXIT.ENV, `gh api ${M} ${p} returned output that is not JSON.`, { stdout: r.stdout.slice(0, 500) });
  }
  if (paginate && Array.isArray(out)) return out.flatMap((page) => (Array.isArray(page) ? page : [page]));
  return out;
}

// Low level: returns { data, errors } and throws only when gh itself failed with no JSON body.
function graphqlRaw(query, variables, { auth } = {}) {
  const r = ghRaw(["api", "graphql", "-X", "POST", "--input", "-"], { input: JSON.stringify({ query, variables: variables ?? {} }), auth });
  let out = null;
  try {
    out = parseJson(r.stdout);
  } catch {
    out = null;
  }
  if (out && typeof out === "object" && ("data" in out || "errors" in out)) {
    return { data: out.data ?? null, errors: out.errors ?? null, code: r.code };
  }
  if (r.code !== 0) throw apiError("POST", "graphql", r);
  throw new CollabError(EXIT.ENV, "gh api graphql returned output that is not a GraphQL response.", { stdout: r.stdout.slice(0, 500) });
}

export function graphql(query, vars, { auth } = {}) {
  const { data, errors } = graphqlRaw(query, vars, { auth });
  if (errors?.length) {
    const notFound = errors.some((e) => e?.type === "NOT_FOUND");
    const forbidden = errors.some((e) => e?.type === "FORBIDDEN" || e?.type === "INSUFFICIENT_SCOPES");
    const code = forbidden ? EXIT.ENV : EXIT.PRECONDITION;
    throw new CollabError(code, `GitHub GraphQL error: ${errors.map((e) => e?.message).filter(Boolean).join("; ") || "unknown error"}`, {
      errors,
      status: notFound ? 404 : null,
    });
  }
  return data;
}

// ---------------------------------------------------------------------------
// Helpers

function checkRepo(repo) {
  if (typeof repo !== "string" || !REPO_RE.test(repo)) {
    throw new CollabError(EXIT.PRECONDITION, `not a GitHub repo name: "${repo}". Use owner/name.`);
  }
  return repo;
}

function checkNumber(n) {
  const v = Number(n);
  if (!Number.isInteger(v) || v <= 0) throw new CollabError(EXIT.PRECONDITION, `not a PR, issue or comment number: "${n}"`);
  return v;
}

const encodeBranch = (b) => String(b).split("/").map(encodeURIComponent).join("/");

function stateOf(pr) {
  if (pr.merged || pr.merged_at) return "MERGED";
  return String(pr.state ?? "").toUpperCase() === "OPEN" ? "OPEN" : "CLOSED";
}

// ---------------------------------------------------------------------------
// Pull requests and repos

// state is normalised to OPEN | CLOSED | MERGED (the GraphQL spelling).
export function getPr(repo, n, { auth } = {}) {
  const pr = api("GET", `repos/${checkRepo(repo)}/pulls/${checkNumber(n)}`, { auth });
  const headRepo = pr.head?.repo?.full_name ?? null;
  const baseRepo = pr.base?.repo?.full_name ?? repo;
  return {
    number: pr.number,
    state: stateOf(pr),
    merged: Boolean(pr.merged || pr.merged_at),
    isCrossRepository: headRepo === null || headRepo.toLowerCase() !== String(baseRepo).toLowerCase(),
    headRef: pr.head?.ref ?? null,
    headSha: pr.head?.sha ?? null,
    baseRef: pr.base?.ref ?? null,
    body: pr.body ?? "",
    draft: Boolean(pr.draft),
    url: pr.html_url ?? null,
    title: pr.title ?? "",
    nodeId: pr.node_id ?? null,
  };
}

export function repoInfo(repo, { auth } = {}) {
  const r = api("GET", `repos/${checkRepo(repo)}`, { auth });
  return {
    defaultBranch: r.default_branch,
    allowSquash: r.allow_squash_merge !== false,
    allowMerge: r.allow_merge_commit !== false,
    private: Boolean(r.private),
  };
}

const CI_FIELDS = "commits(last:1){nodes{commit{statusCheckRollup{state contexts{totalCount}}}}}";
const SUB_FIELDS = `number state merged mergeable isDraft headRefOid additions deletions ${CI_FIELDS}`;
const MAIN_FIELDS = `number state merged mergeable isDraft isCrossRepository headRefOid additions deletions body ${CI_FIELDS}`;

// SUCCESS | FAILURE | PENDING | NONE | UNKNOWN
export function ciOf(node) {
  const rollup = node?.commits?.nodes?.[0]?.commit?.statusCheckRollup;
  if (!rollup || !rollup.contexts?.totalCount) return "NONE";
  switch (rollup.state) {
    case "SUCCESS":
      return "SUCCESS";
    case "FAILURE":
    case "ERROR":
      return "FAILURE";
    case "PENDING":
    case "EXPECTED":
      return "PENDING";
    default:
      return "UNKNOWN";
  }
}

function snapOf(node) {
  return {
    state: node.state ?? "UNKNOWN",
    merged: Boolean(node.merged),
    mergeable: node.mergeable ?? "UNKNOWN",
    ci: ciOf(node),
    headSha: node.headRefOid ?? null,
    additions: node.additions ?? 0,
    deletions: node.deletions ?? 0,
    draft: Boolean(node.isDraft),
  };
}

function failedSnapshot(error) {
  return { ok: false, error: String(error), main: null, mainCi: "UNKNOWN", mainMergeable: "UNKNOWN", subs: {} };
}

// One batched GraphQL query with aliases (main + s_T3 ...). Never throws.
// Returns mainCi/mainMergeable at the top level too, which is the shape next.mjs reads.
// A sub-PR GitHub can't find is left out of `subs`.
export function liveSnapshot(repo, mainN, subs = {}, { auth } = {}) {
  try {
    const [owner, name] = checkRepo(repo).split("/");
    const parts = [`main: pullRequest(number:${checkNumber(mainN)}){${MAIN_FIELDS}}`];
    const aliases = {};
    for (const [task, n] of Object.entries(subs ?? {})) {
      if (n === null || n === undefined) continue;
      if (!ALIAS_RE.test(task)) throw new Error(`bad task id "${task}"`);
      aliases[task] = `s_${task}`;
      parts.push(`s_${task}: pullRequest(number:${checkNumber(n)}){${SUB_FIELDS}}`);
    }
    const query = `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){${parts.join(" ")}}}`;
    const { data, errors } = graphqlRaw(query, { owner, name }, { auth });
    const repoNode = data?.repository;
    if (!repoNode?.main) {
      return failedSnapshot(errors?.map((e) => e?.message).filter(Boolean).join("; ") || "GitHub returned no data for the main PR");
    }
    const mainSnap = { ...snapOf(repoNode.main), isCrossRepository: Boolean(repoNode.main.isCrossRepository), body: repoNode.main.body ?? "" };
    const out = { ok: true, main: mainSnap, mainCi: mainSnap.ci, mainMergeable: mainSnap.mergeable, subs: {} };
    for (const [task, alias] of Object.entries(aliases)) {
      if (repoNode[alias]) out.subs[task] = snapOf(repoNode[alias]);
    }
    return out;
  } catch (e) {
    return failedSnapshot(e?.message ?? e);
  }
}

// ---------------------------------------------------------------------------
// Actions: the workflows `collab verify` runs on a task's branch ("verify": "ci" in .collab.json)

const WORKFLOW_FILE_RE = /^[A-Za-z0-9_.-]+\.ya?ml$/;
const SHA_RE = /^[0-9a-f]{7,40}$/i;

function checkWorkflow(workflow) {
  if (typeof workflow !== "string" || !WORKFLOW_FILE_RE.test(workflow)) throw new CollabError(EXIT.PRECONDITION, `not a workflow file name: "${workflow}"`);
  return workflow;
}

// Starts a workflow_dispatch run of `workflow` on branch `ref`. GitHub runs the workflow file as
// it is on that branch, and answers with no run id: find the run with workflowRuns.
export function dispatchWorkflow(repo, workflow, ref, { auth } = {}) {
  const at = `repos/${checkRepo(repo)}/actions/workflows/${checkWorkflow(workflow)}/dispatches`;
  try {
    api("POST", at, { body: { ref: String(ref) }, auth });
  } catch (e) {
    const status = e instanceof CollabError ? e.details?.status : null;
    if (status === 404) throw new CollabError(EXIT.PRECONDITION, `GitHub has no workflow ${workflow} in ${repo}. ciWorkflows in .collab.json names files in .github/workflows on the default branch.`, e.details);
    if (status === 422) throw new CollabError(EXIT.PRECONDITION, `GitHub can't start ${workflow} on ${ref} (${firstLine(e.details?.stderr) || "HTTP 422"}). Its on: block on the default branch needs a workflow_dispatch: trigger with no required inputs, and the branch must exist on GitHub.`, e.details);
    throw e;
  }
}

// The runs of `workflow` at commit `sha`, newest first: { id, url, status, conclusion, event, createdAt }.
// status is queued | in_progress | waiting | requested | pending | completed.
export function workflowRuns(repo, workflow, sha, { auth } = {}) {
  if (typeof sha !== "string" || !SHA_RE.test(sha)) throw new CollabError(EXIT.PRECONDITION, `not a commit SHA: "${sha}"`);
  const r = api("GET", `repos/${checkRepo(repo)}/actions/workflows/${checkWorkflow(workflow)}/runs`, { fields: { head_sha: sha, per_page: 20 }, auth });
  return (Array.isArray(r?.workflow_runs) ? r.workflow_runs : [])
    .map((x) => ({
      id: Number(x.id), url: x.html_url ?? null, status: x.status ?? null, conclusion: x.conclusion ?? null,
      event: x.event ?? null, createdAt: x.created_at ?? null, sha: x.head_sha ?? null,
    }))
    .filter((x) => !x.sha || x.sha === sha)
    .sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0) || b.id - a.id);
}

export function createPr(repo, { base, head, title, body, draft = false }, { auth } = {}) {
  const r = api("POST", `repos/${checkRepo(repo)}/pulls`, { body: { base, head, title, body: body ?? "", draft: Boolean(draft) }, auth });
  return { number: r.number, url: r.html_url };
}

// The open PR whose head is `branch` in this repo, or null. Lets push recover a sub-PR the ledger missed.
export function findOpenPr(repo, branch, { auth } = {}) {
  const owner = checkRepo(repo).split("/")[0];
  const list = api("GET", `repos/${checkRepo(repo)}/pulls`, { fields: { head: `${owner}:${branch}`, state: "open", per_page: 10 }, auth }) ?? [];
  const hit = list.find((p) => p.head?.ref === branch);
  return hit ? { number: hit.number, url: hit.html_url } : null;
}

export function markReady(repo, n, { auth } = {}) {
  const pr = api("GET", `repos/${checkRepo(repo)}/pulls/${checkNumber(n)}`, { auth });
  if (!pr.draft) return { draft: false };
  if (!pr.node_id) throw new CollabError(EXIT.ENV, `GitHub returned no node id for PR #${n}.`);
  graphql("mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){pullRequest{isDraft}}}", { id: pr.node_id }, { auth });
  return { draft: false };
}

export function setBody(repo, n, body, { auth } = {}) {
  api("PATCH", `repos/${checkRepo(repo)}/pulls/${checkNumber(n)}`, { body: { body }, auth });
}

export function comment(repo, n, body, { auth } = {}) {
  const r = api("POST", `repos/${checkRepo(repo)}/issues/${checkNumber(n)}/comments`, { body: { body }, auth });
  return { id: r.id, url: r.html_url };
}

export function editComment(repo, id, body, { auth } = {}) {
  api("PATCH", `repos/${checkRepo(repo)}/issues/comments/${checkNumber(id)}`, { body: { body }, auth });
}

// Issue comments with id > sinceId, oldest first. `sinceAt` (when the comment with sinceId was
// written) lets GitHub leave out older comments, so a poll doesn't download the whole thread.
// GitHub's `since` goes by update time, so an old comment edited later still comes back; the id
// filter drops it.
export function commentsSince(repo, n, sinceId, { auth, sinceAt } = {}) {
  const fields = { per_page: 100 };
  if (sinceAt && !Number.isNaN(Date.parse(sinceAt))) fields.since = new Date(sinceAt).toISOString();
  const list = api("GET", `repos/${checkRepo(repo)}/issues/${checkNumber(n)}/comments`, { fields, auth, paginate: true }) ?? [];
  const since = Number(sinceId) || 0;
  return list
    .filter((c) => Number(c.id) > since)
    .sort((a, b) => Number(a.id) - Number(b.id))
    .map((c) => ({ id: c.id, login: c.user?.login ?? null, body: c.body ?? "", createdAt: c.created_at ?? null, url: c.html_url ?? null }));
}

// Every issue and PR comment in the repo with id > sinceId, oldest first, each with the number of
// the issue or PR it is on. One request covers the main PR and all its sub-PRs; comment ids grow
// across a repo, so one cursor serves them all. Pass sinceAt: without it GitHub sends every
// comment the repo has.
export function repoCommentsSince(repo, sinceId, { auth, sinceAt } = {}) {
  const fields = { sort: "created", direction: "asc", per_page: 100 };
  if (sinceAt && !Number.isNaN(Date.parse(sinceAt))) fields.since = new Date(sinceAt).toISOString();
  const list = api("GET", `repos/${checkRepo(repo)}/issues/comments`, { fields, auth, paginate: true }) ?? [];
  const since = Number(sinceId) || 0;
  return list
    .filter((c) => Number(c.id) > since)
    .sort((a, b) => Number(a.id) - Number(b.id))
    .map((c) => ({
      id: c.id, pr: Number(/\/issues\/(\d+)$/.exec(c.issue_url ?? "")?.[1]) || null,
      login: c.user?.login ?? null, body: c.body ?? "", createdAt: c.created_at ?? null, url: c.html_url ?? null,
    }));
}

// The newest issue or PR comment in the whole repo, { id, createdAt }, or null. Comment ids grow
// across a repo, so this one request bounds every comment already on a PR.
export function newestComment(repo, { auth } = {}) {
  const list = api("GET", `repos/${checkRepo(repo)}/issues/comments`, { fields: { sort: "created", direction: "desc", per_page: 1 }, auth }) ?? [];
  const c = list[0];
  return c ? { id: c.id, createdAt: c.created_at ?? null } : null;
}

const permissionCache = new Map();

export function clearPermissionCache() {
  permissionCache.clear();
}

// admin | maintain | write | triage | read | none, cached per process. Unknown user (404) is "none".
export function permission(repo, login, { auth } = {}) {
  const key = `${checkRepo(repo).toLowerCase()}#${String(login).toLowerCase()}`;
  if (permissionCache.has(key)) return permissionCache.get(key);
  let perm;
  try {
    const r = api("GET", `repos/${repo}/collaborators/${encodeURIComponent(login)}/permission`, { auth });
    perm = PERMISSIONS.has(r?.permission) ? r.permission : "none";
  } catch (e) {
    if (e?.details?.status !== 404) throw e;
    perm = "none";
  }
  permissionCache.set(key, perm);
  return perm;
}

// PUT pulls/n/merge with a sha guard. 409 means the head moved after approval.
export function merge(repo, n, { sha, method = "squash" } = {}, { auth } = {}) {
  if (!sha) throw new CollabError(EXIT.PRECONDITION, "merge needs the approved head SHA.");
  try {
    const r = api("PUT", `repos/${checkRepo(repo)}/pulls/${checkNumber(n)}/merge`, { body: { sha, merge_method: method }, auth });
    return { merged: Boolean(r?.merged), sha: r?.sha ?? null };
  } catch (e) {
    if (e?.details?.status === 409) {
      throw new CollabError(EXIT.PRECONDITION, "head changed", { ...e.details, hint: `PR #${n} has commits newer than the approved SHA; it needs a new review.` });
    }
    if (e?.details?.status === 405) {
      throw new CollabError(EXIT.PRECONDITION, `GitHub says PR #${n} can't be merged yet: ${firstLine(e.details.stderr)}`, e.details);
    }
    throw e;
  }
}

export function closePr(repo, n, { auth } = {}) {
  api("PATCH", `repos/${checkRepo(repo)}/pulls/${checkNumber(n)}`, { body: { state: "closed" }, auth });
}

// DELETE git/refs/heads/<branch>; a branch that's already gone (404/422) is fine.
export function deleteBranch(repo, branch, { auth } = {}) {
  try {
    api("DELETE", `repos/${checkRepo(repo)}/git/refs/heads/${encodeBranch(branch)}`, { auth });
    return true;
  } catch (e) {
    if (e?.details?.status === 404 || e?.details?.status === 422) return false;
    throw e;
  }
}

// true/false from branches/<b>.protected; null when GitHub can't tell us.
export function branchProtected(repo, branch, { auth } = {}) {
  try {
    const r = api("GET", `repos/${checkRepo(repo)}/branches/${encodeBranch(branch)}`, { auth });
    return typeof r?.protected === "boolean" ? r.protected : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Issues and labels (plan sessions)

const labelNames = (labels) => (Array.isArray(labels) ? labels : []).map((l) => (typeof l === "string" ? l : l?.name)).filter((l) => typeof l === "string" && l);
const openOrClosed = (state) => (String(state ?? "").toUpperCase() === "OPEN" ? "OPEN" : "CLOSED");

function checkLabel(name) {
  if (typeof name !== "string" || !name.trim()) throw new CollabError(EXIT.PRECONDITION, `not a label name: "${name}"`);
  return name;
}

function issueOf(i) {
  return {
    number: i.number,
    state: openOrClosed(i.state),
    stateReason: i.state_reason ?? null,
    locked: Boolean(i.locked),
    title: i.title ?? "",
    body: i.body ?? "",
    labels: labelNames(i.labels),
    url: i.html_url ?? null,
    isPr: Boolean(i.pull_request),
    author: i.user?.login ?? null,
  };
}

// GitHub's issues API answers for PRs too; isPr says which one this is.
export function getIssue(repo, n, { auth } = {}) {
  return issueOf(api("GET", `repos/${checkRepo(repo)}/issues/${checkNumber(n)}`, { auth }));
}

export function createIssue(repo, { title, body, labels = [] } = {}, { auth } = {}) {
  const r = api("POST", `repos/${checkRepo(repo)}/issues`, { body: { title: String(title ?? ""), body: body ?? "", labels: labelNames(labels) }, auth });
  return { number: r.number, url: r.html_url };
}

// Sends only the keys given (stateReason as state_reason) and returns the issue as getIssue does.
export function patchIssue(repo, n, { title, body, state, stateReason } = {}, { auth } = {}) {
  const payload = {};
  if (title !== undefined) payload.title = title;
  if (body !== undefined) payload.body = body;
  if (state !== undefined) payload.state = String(state).toLowerCase();
  if (stateReason !== undefined) payload.state_reason = stateReason;
  return issueOf(api("PATCH", `repos/${checkRepo(repo)}/issues/${checkNumber(n)}`, { body: payload, auth }));
}

// reason: "completed" or "not_planned".
export function closeIssue(repo, n, { reason = "completed" } = {}, { auth } = {}) {
  return patchIssue(repo, n, { state: "closed", stateReason: reason }, { auth });
}

// Issues (not PRs: the REST list holds both) with `label`, oldest page first as GitHub sends them.
export function listIssues(repo, { label, state = "open" } = {}, { auth } = {}) {
  const fields = { state, per_page: 100 };
  if (label !== undefined && label !== null) fields.labels = checkLabel(label);
  const list = api("GET", `repos/${checkRepo(repo)}/issues`, { fields, auth, paginate: true }) ?? [];
  return list
    .filter((i) => !i.pull_request)
    .map((i) => ({ number: i.number, title: i.title ?? "", url: i.html_url ?? null, state: openOrClosed(i.state), updatedAt: i.updated_at ?? null, author: i.user?.login ?? null }));
}

// "exists", "created" (it was missing and this login made it) or "forbidden" (missing, and this
// login can't make labels). Never throws for HTTP 403.
export function ensureLabel(repo, name, { color = "5319e7", description = "" } = {}, { auth } = {}) {
  const path = `repos/${checkRepo(repo)}/labels`;
  try {
    api("GET", `${path}/${encodeURIComponent(checkLabel(name))}`, { auth });
    return "exists";
  } catch (e) {
    if (e?.details?.status === 403) return "forbidden";
    if (e?.details?.status !== 404) throw e;
  }
  try {
    api("POST", path, { body: { name, color: String(color).replace(/^#/, ""), description: String(description ?? "") }, auth });
    return "created";
  } catch (e) {
    if (e?.details?.status === 422) return "exists"; // someone made it meanwhile
    if (e?.details?.status === 403) return "forbidden";
    throw e;
  }
}
