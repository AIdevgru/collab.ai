# Module contract (v1)

Every module lives in `skills/collab/lib/`, is an ES module and uses only Node built-ins. Node is version 22 or newer, and there are zero dependencies. `docs/design.md` explains what the system does; this file pins down how the modules talk to each other. If you change a signature, update this file in the same change.

## Conventions
- **Child processes:** run them with `spawnSync(cmd, argsArray, { shell: false, encoding: "utf8", windowsHide: true })`. Never pass a shell string.
- **Errors:** throw `CollabError` from `errors.mjs`. Every other exception is treated as a bug (exit 1).
- **Time:** always comes from `now()` in `clock.mjs`, which reads `COLLAB_NOW` (an ISO string) in tests. Store times as ISO strings ending in `Z`.
- **Purity:** `ledger.mjs`, `next.mjs`, `glob.mjs` and `dashboard.mjs` do no I/O, so they are easy to unit test.
- **Repo override:** in tests, origin is a local bare repo. Set `COLLAB_REPO=owner/name` to skip parsing the origin URL.
- **gh override:** set `COLLAB_GH` to a JSON array, for example `["node","/abs/tests/helpers/fake-gh.mjs"]`, to replace `gh`. Prepend it to the gh arguments.

## errors.mjs (shared, written first)
```js
export const EXIT = { OK: 0, BUG: 1, PRECONDITION: 2, CONTENTION: 3, UNSUPPORTED: 4, ENV: 5 };
export class CollabError extends Error { constructor(code, message, details = {}) }  // .code, .details
export const fail = (code, msg, details) => { throw new CollabError(code, msg, details); };
```

## clock.mjs
```js
export function now(): Date                // COLLAB_NOW env or new Date()
export function iso(d = now()): string      // d.toISOString()
export function addMinutes(isoOrDate, min): string
export function minutesBetween(aIso, bIso): number
```

## glob.mjs (pure)
```js
export function globToRegExp(glob): RegExp  // supports **, *, ?, {a,b}, character classes [..]; '/' separators; anchored
export function matchAny(globs, path): boolean
export function expand(globs, files): string[]          // files = git ls-files output (posix paths)
export function intersect(aGlobs, aFiles, bGlobs, bFiles, allFiles): string[]  // overlapping concrete files
```
Two scopes overlap when their expanded file sets intersect. A glob that matches no existing file is compared against the other side's globs by testing each concrete path that side lists, for example new files a task will create. Each module's tests must cover the edge cases.
- A side's files are its globs expanded against `allFiles`, its `touched` files, and the literal paths its globs name (after brace expansion, so `src/{a,b}.js` names two new files). The result is sorted and unique. Two globs that share no concrete file (say `new/*.ts` and `new/**` with nothing under `new/`) don't count as overlapping.
- `**` is zero or more segments; `dir/**` also matches `dir`. A `**` that isn't a whole segment (`a**b`) acts like `*`. A trailing `/` means `/**`, a leading `./` or `/` is dropped, `\x` escapes. `*` and `?` match dotfiles. `{a}`, an unclosed `{` and an unclosed `[` are literal.

## ledger.mjs (pure reducer)
- **Exports:** `SCHEMA = 1`, `STATUSES`, `PHASES`, `VENDORS = { claude: "anthropic", codex: "openai", gemini: "google", grok: "xai", other: "other" }`.
- **Constructor:** `newLedger({ pr, config, agent: { id, tool, host, pid }, now })` returns a ledger in `planning`, holding the planner lease, with the agent registered. Here `pr = { repo, number, url, headRef, baseRef, defaultBranch, ghLogin, mergeMethod }`.
- **Reducer:** `apply(ledger, event)` returns a new ledger. It never mutates its input. It sets `seq = ledger.seq + 1` and throws `CollabError(PRECONDITION)` on an illegal event. `event = { type, agent, task?, data, at }`.
- **Derived state:** `derive(ledger, now)` returns `{ tasks: { T1: { inProgress, stale, reviewStale, waitingReview, eligibleReviewers[] } }, liveAgents[], nextLeaseExpiry }`.
- **Helpers:** `vendorOf(tool)`, `taskIds(ledger)` (in numeric order), `isTerminal(status)`.
- **Ledger shape:** exactly as in design.md, section "Ledger", plus: `tasks[T].forSha` and `tasks[T].withdrawn` (fix-ci only), `tasks[T].reviewSha` (the head when the reviewer claimed the review), `tasks[T].overlap` (what a claim with `--allow-overlap` accepted; absent otherwise), `lastCommentAt` (when the comment `lastCommentId` names was written), `tasks[T].decision = { text, by, at }` (set by `task.unblock` with a decision), `merged.mergeSha` (when `task.merge` passes it), and `directives[i].applied` (false when the directive could not act, for example cancelling a done task), `.task` and `.url`. `newLedger` returns `seq: 0, rev: null`.
- **Refusal order:** schema mismatch → `CollabError(ENV)`; an event with no type or no valid `at` → `CollabError(BUG)`; unknown type or unknown agent (every type but `agent.join`, unless `agent === "owner"`) → `PRECONDITION`; phase `paused` or `closed` → `UNSUPPORTED` except `directive`, `phase.set`, `comments.seen`, `notice.sent`, `agent.seen`, `agent.join`; phase `planning` → `PRECONDITION` except `agent.join`, `agent.seen`, `planner.lease`, `plan`, `directive`, `comments.seen`, `notice.sent`, `phase.set`. Messages name the actor, the task and its status: `codex-7k2p can't claim T3 (in_review): it must be open`. `details = { type, agent, task, status }`.
- **Time:** every lease check compares against `event.at`. A lease has expired once its end is strictly before that time.
- **Blocked tasks** can't be claimed (nor stolen) or merged; other events still apply.
- **Owner lease refresh:** `review.verdict` and `review.waive` extend the task owner's lease to at least `at + config.leaseMin`, so a long review never leaves the task stealable the moment it returns.

**Event types** (`data` fields listed). Each enforces the transition table in design.md:

| Type | `data` fields | Notes |
|---|---|---|
| `agent.join` | `{ tool, host, pid }` | Adds an agent and sets its vendor. Joining again only updates `lastSeen`; rejoining with a different `tool` is refused. `owner` is a reserved id. |
| `agent.seen` | `{}` | Updates `lastSeen`. |
| `planner.lease` | `{ leaseUntil }` | Only the planner, or anyone once the lease has expired, which makes them the planner. |
| `plan` | `{ tasks: [{ title, desc, accept, scope, deps, size }] }` | Planner only, and only in `planning`. Assigns `T1..Tn` in order. Deps must name earlier tasks or existing ids. Refuses more than `config.maxTasks`. Sets phase to `active` and clears the planner. |
| `task.add` | `{ title, desc, accept, scope, deps, size, kind = "work", forSha? }` | Active phase only. Work tasks that aren't cancelled stay within `config.maxTasks`; fix-ci tasks don't count. A `fix-ci` task needs `forSha` and is refused (`PRECONDITION`, so the CLI's housekeeping skips it) when another fix-ci task is still unfinished (a head that moves while red is the same failure), or when any fix-ci task, in any status, already has that `forSha`: re-adding one after a cancel would loop. When the task for that `forSha` was `withdrawn`, it is reopened instead (no new id; `times.reopened` is set; `subPr` is kept, and `collab push` on a reopened task replaces it when that sub-PR is no longer open), so a CI that flaps on one commit toggles one task and a red CI always has a task to claim. Deps must be existing, uncancelled ids. |
| `task.claim` | `{ leaseUntil, steal = false }` | WIP limit `config.wip` (1): the agent can hold no other `claimed` or `changes_requested` task. Deps must be `done`, or cancelled with their own deps done (`unmetDeps`). A steal requires the lease to have expired; stealing an approved task sends it back to `claimed` and clears the approval. A scope overlap check needs the file list, so the CLI does it before writing; the event carries `data.overlap` (an array of what `--allow-overlap` accepted), stored as `tasks[T].overlap` so the dashboard can warn while the tasks it names are still in flight; `task.release` clears it. |
| `task.release` | | Owner only. Status becomes `open`; owner and lease are cleared. |
| `task.lease` | `{ leaseUntil }` | Owner only. |
| `task.push` | `{ headSha, touched, subPr?, leaseUntil? }` | Owner only, in `claimed`, `changes_requested`, `in_review` or `approved`. `touched` replaces the list (sorted, unique). If the status is `approved` and `headSha` differs from the approved SHA, the status goes back to `in_review`. |
| `task.verify` | `{ sha, ok, summary }` | Owner or reviewer. |
| `task.submit` | `{ sha }` | Owner. From `claimed` or `changes_requested`. Requires a passing `verify` with this `sha` and `sha === headSha`. Status becomes `in_review`. |
| `review.claim` | `{ leaseUntil }` | The task must be `in_review` with no live reviewer. The reviewer's vendor must differ from the owner's vendor, and the reviewer can't be the owner. Sets `reviewSha` to the current `headSha`; the same reviewer claiming again moves it to the new head. |
| `review.verdict` | `{ verdict: "approve" \| "changes", sha, commentId }` | The current reviewer only, with `sha === headSha`, and `reviewSha === headSha`: after the owner pushes during a review, the reviewer must run `review-claim` again (which checks out the new head) before any verdict. `approve` makes it `approved`; `changes` makes it `changes_requested` and adds one to `changeRounds`. In both cases `reviewer` is cleared. |
| `task.merge` | `{ sha }` | Any agent. The task must be `approved`, the latest approve review's `sha === headSha === data.sha`. Status becomes `done` and `merged` is set. CI conditions are checked by the CLI before writing. |
| `task.cancel` | `{ reason, withdrawn? }` | The task's owner (any status but done), anyone for an `open` task, or `agent: "owner"` (a directive or terminal owner). Not allowed on `done` or `cancelled`. Tasks that depend on the cancelled one stop waiting on it (`unmetDeps` looks through a cancelled dependency to what it waited on itself), so they stay claimable; `deps` is left as planned. `withdrawn: true` (housekeeping, when CI is green again) is only for an `open` fix-ci task and sets `tasks[T].withdrawn`. |
| `task.block` | `{ reason, needsOwner }` | Owner, or `agent: "owner"`. `blocked.since` is the time of the block, except that asking the owner the same question again changes nothing: it keeps the first time (and so its one notice) and the first asker. With `needsOwner`, clears `decision`: the last answer is not the answer to a new question. |
| `task.unblock` | `{ decision?, allowProtected? }` | Owner, or `agent: "owner"`. `allowProtected: true` (only from `agent: "owner"`) sets `tasks[T].allowProtected`, which lets `collab push` take changes to CI workflows and `.collab.json`. |
| `task.note` | `{ body }` | No state change besides `lastSeen`. The note itself lives in the commit trailer. |
| `review.waive` | | `agent: "owner"` only, from `in_review` or `changes_requested`. The task becomes `approved`, bound to the current `headSha`, with a review entry `{ agent: "owner", vendor: "owner", verdict: "approve", sha }`. |
| `directive` | `{ commentId, commentAt?, login, cmd: "pause" \| "cancel", task?, url? }` | The task id comes from `event.task` or `data.task`. Refused when `commentId <= lastCommentId`. Otherwise always appended to `directives` and sets `lastCommentId` (and `lastCommentAt` from `commentAt`). `pause` sets the phase to `paused` (a closed collab stays closed); `cancel` cancels the task when it isn't done or cancelled. |
| `comments.seen` | `{ lastCommentId, lastCommentAt? }` | Only moves forward (`max`). `lastCommentAt` is when that comment was written. |
| `phase.set` | `{ phase }` | `agent: "owner"`. Used for resume (`active`) and close (`closed`). `closed` is final. Resuming (`active`) while a planner is still set (paused before the plan landed) goes back to `planning`. |
| `notice.sent` | `{ key, commentId }` | Sets `notices[key] = commentId`. |
| `reviewer.expire` | | Anyone, once `reviewLeaseUntil` has passed. Clears the reviewer. |

## next.mjs (pure)
```js
export function nextAction(ledger, me, live, now, { files = [] } = {}) -> {
  action: "plan"|"wait-plan"|"fix"|"merge"|"review"|"work"|"claim"|"reclaim"|"wait"|"done"|"paused"|"closed"|"join",
  task?: "T3", why: "human sentence", cmd: ["collab", ...args, "--agent", me]   // the exact next command to run
}
```
- `live` is `github.liveSnapshot`'s result (`{ ok, main: { ci, mergeable }, subs }`) or the flattened `{ mainCi, mainMergeable, subs: { T3: { ci, mergeable, state, headSha } } }`. `ci` is one of `SUCCESS`, `FAILURE` (or `ERROR`), `PENDING` (or `EXPECTED`), `NONE` or `UNKNOWN`. `live = null` or `ok: false` means offline: every CI is `UNKNOWN`. A sub-PR snapshot whose `headSha` differs from the ledger's head is ignored (treated as `UNKNOWN`).
- `files` (optional, `git ls-files` at the PR head) widens the claim-time overlap check; without it only literal paths and touched files are compared.
- Order (first match wins): `closed` → `join` (me not in `ledger.agents`) → `paused` → planning: `plan` (I'm the planner, or the planner lease expired) or `wait-plan` → then, for the active phase:
  1. `fix` my task (not blocked): a conflicting sub-PR (`sync`), red sub-PR CI (`push`), or `changes_requested` (`push` until a new head exists, then `verify`, then `submit`).
  2. `merge` my approved task: the approval's SHA is the head; not frozen (`mainCi === "FAILURE"`) unless it's a `fix-ci` task; sub-PR CI `SUCCESS`, or `NONE`/`UNKNOWN` plus a passing verify at the head. Never on `PENDING` or a conflict.
  3. `review` a task whose review I already hold (cmd `review T --approve --body-file review.md`; or `review-claim T` when the owner pushed since I claimed it, so `reviewSha` is no longer the head).
  4. `work` on my `claimed` task: why `keep working on T3, then collab push / verify / submit`; cmd is the next of `push T` (nothing pushed), `verify T` (no passing verify at the head) or `submit T`.
  5. `review` an `in_review` task by another vendor with no live reviewer (cmd `review-claim T`).
  6. `claim` the first open, unblocked task whose deps are done and whose scope doesn't overlap another agent's in-flight scope or touched files; `fix-ci` tasks first, then id order. Only below the WIP limit.
  7. A stale task of someone else's: `merge` it if it is approved and mergeable as in 2; otherwise `reclaim` (`claim T --steal`), but an approved task is stolen only when its CI is red or it conflicts, since stealing clears the approval.
  8. `done` when every task is `done` or `cancelled`; otherwise `wait` (cmd `wait --timeout 9m`) with a reason.
- Task commands take the task id as a positional argument: `push T3`, `verify T3`, `submit T3`, `sync T3`, `claim T3 [--steal]`, `review-claim T3`, `review T3 …`, `merge T3`. `join` gets the PR URL. `plan` uses `--tasks tasks.json`, a file the planner writes.

## git.mjs
```js
export function git(args, { cwd, env, input, allowFail = false, auth }) -> { code, stdout, stderr }
   // always sets GIT_TERMINAL_PROMPT=0 and LC_ALL=C (stable English output); maxBuffer 64 MB
   // auth = { token } -> prepend ['-c','credential.helper=','-c','credential.helper=!gh auth git-credential'], env GH_TOKEN=token
   // throws CollabError(ENV) on non-zero (details: args, code, stdout, stderr) unless allowFail
export function repoRoot(cwd) ; gitCommonDir(cwd)  // absolute paths with platform separators
export function currentBranch(cwd) -> string|null  // null on a detached HEAD
export function parseGithubUrl(url) -> "owner/name"|null   // https://github.com/o/r(.git), git@github.com:o/r(.git), ssh://git@github.com/o/r
export function originRepo(cwd) -> "owner/name"   // COLLAB_REPO override; CollabError(ENV) for no origin or a non-GitHub origin
export function lsFiles(cwd, ref) -> string[]      // git ls-tree -r -z --name-only <ref>
export function ensureExclude(cwd, pattern) -> boolean  // appends to `git rev-parse --git-path info/exclude` (resolved from cwd, folder created) if missing; true when it appended
export function addWorktree(cwd, path, branch, startPoint) -> { path, branch, created }
   // path already a worktree for branch -> reuse (created: false). Branch exists locally -> `worktree add <path> <branch>`;
   // only as refs/remotes/origin/<branch> -> tracks it (so fetch first); else `worktree add --no-track -b <branch> <path> <startPoint>`.
   // CollabError(PRECONDITION) when path holds another branch or branch is checked out elsewhere. Never touches the main checkout's HEAD.
export function showFile(cwd, ref, path) -> string|null  // null when the ref or path is missing
export function changedFiles(cwd, baseRef, headRef) -> string[]  // git diff --name-only -z base...head
```

## store.mjs (the ledger on a custom ref)
```js
export const refFor = (n) => `refs/collab/pr-${n}`;
export const cacheRefFor = (agent, n) => `refs/collab-cache/${agent ?? "anon"}/pr-${n}`;
export function read({ cwd, pr, agent, auth }) -> { ledger, rev } | null
   // git fetch --no-tags --no-write-fetch-head origin +<ref>:<cacheRef>, then the blob at the cache ref.
   // "couldn't find remote ref" -> null (and the stale cache ref is deleted); any other fetch failure -> CollabError(ENV, details.network)
export function write({ cwd, pr, agent, auth, mutate, maxTries = 6 }) -> { ledger, rev, events }
   // loop: read -> const { ledger, events } = mutate(current /* null if absent */, rev /* null if absent */) (any throw propagates, no retry)
   //       -> hash-object / mktree / commit-tree (parent = rev if any) with commitMessage(events, agent):
   //          "collab: <data.summary of first event, or '<agent> <type> <task>'>\n\n" + one "Collab-Event: <json>" line per event
   //       -> git push --porcelain origin <commit>:<ref> --force-with-lease=<ref>:<rev or ''>
   //       -> classifyPush: '!' + "stale info"/"fetch first"/"non-fast-forward"/"rejected" = lost race -> jittered backoff
   //          (50-400ms * try) and retry; after maxTries lost races -> CollabError(CONTENTION).
   //          A '!' line saying "declined", "denied" or "protected" is permanent -> CollabError(ENV).
   //       -> network error (fetch or push: "Could not resolve host"/"unable to access"/"Connection", or exit 128 with empty stdout):
   //          up to 3 retries with backoff; exhausted -> CollabError(ENV, details.network = true)
   //       -> success: git update-ref <cacheRef> <commit>; return
   // mutate returning null => nothing to write: returns { ledger: current or null, rev: rev or null, events: [] }
   // agent ids must match [A-Za-z0-9][A-Za-z0-9._-]* (they become ref names), else CollabError(PRECONDITION)
export function history({ cwd, pr, agent, limit = 10 }) -> [{ sha, at, event }]
   // newest first (events within one commit reversed), from Collab-Event trailers on the CACHE ref (read() first to refresh);
   // at = commit time as ISO Z; at most `limit` events; [] when the cache ref is missing
export function remove({ cwd, pr, auth })        // git push origin :<ref> (already gone is fine), then deletes this clone's refs/collab-cache/*/pr-<n>
export function commitMessage(events, agent) -> string ; classifyPush({ code, stdout, stderr }, ref) -> "ok"|"race"|"network"|"error"   // exported for tests
```
- The commit author and committer are `collab (<agent>)` with the email `collab@users.noreply.github.com`, set through the `GIT_AUTHOR_*` and `GIT_COMMITTER_*` env vars. Both dates are `clock.iso()`.
- The tree holds exactly one file, `ledger.json`, written as pretty JSON with two-space indents and a trailing newline.
- The store treats the ledger as opaque JSON.

## identity.mjs
```js
export function detectTool(env = process.env) -> "claude"|"codex"|"gemini"|"grok"|null
   // in order: CLAUDECODE; CODEX_THREAD_ID or CODEX_SESSION_ID; GEMINI_CLI; any GROK_* var; else the AI_AGENT prefix
export function isAgentEnv(env = process.env) -> boolean   // detectTool !== null || COLLAB_AGENT || COLLAB_RELAYED set
export function mintAgentId(tool) -> `${tool}-${4 base36 chars}`   // tool falsy -> "other"
export function pinnedToken(login) -> string     // `gh auth token --user <login>` via github.ghRaw WITHOUT GH_TOKEN/GITHUB_TOKEN in env; CollabError(ENV) if missing
export function activeLogin() -> string          // `gh api user --jq .login` (no GH_TOKEN)
export function collabHome(env = process.env) -> string   // COLLAB_HOME or ~/.collab
export function saveAgentFile(id, data) -> boolean   // best effort: <collabHome>/agents/<id>.json; false on failure; never throws
export function requireOwner(env = process.env)  // CollabError(PRECONDITION, "owner-only command; run it in your own terminal") if isAgentEnv
```

## github.mjs (all GitHub access goes through `gh api`; nothing else)
```js
export function ghRaw(args, { env, input, auth }) -> { code, stdout, stderr }   // COLLAB_GH override; env replaces the child env; auth.token adds GH_TOKEN; CollabError(ENV) if gh can't start
export function api(method, path, { fields, body, auth, paginate }) -> parsed JSON  // gh api -X METHOD path [--input -]
   // fields: query string for GET/DELETE, merged into the JSON body otherwise (never -F, which reads "@file")
   // paginate: --paginate --slurp, pages flattened into one array
   // errors: details.status parsed from "(HTTP nnn)"; 401/403 -> ENV; 404/409/422 and other 4xx -> PRECONDITION; 5xx/network -> ENV
export function graphql(query, vars, { auth }) -> data      // GraphQL errors -> CollabError(PRECONDITION, or ENV for FORBIDDEN), details.errors
export function getPr(repo, n, { auth }) -> { number, state, merged, isCrossRepository, headRef, headSha, baseRef, body, draft, url, title, nodeId }
   // state is normalised to "OPEN" | "CLOSED" | "MERGED"
export function repoInfo(repo, { auth }) -> { defaultBranch, allowSquash, allowMerge, private }
export function liveSnapshot(repo, mainN, subs /* {T3: 59} */, { auth }) -> {
  ok: true|false, error?, mainCi, mainMergeable,        // mainCi/mainMergeable repeat main.ci/main.mergeable: the shape next.mjs reads
  main: { state, merged, mergeable, ci, additions, deletions, headSha, draft, isCrossRepository, body },
  subs: { T3: { state, merged, ci, mergeable, headSha, additions, deletions, draft } } }
   // one batched GraphQL query with aliases (main, s_T3); a sub-PR GitHub can't find is left out of subs
   // ok:false (never throws) -> { ok:false, error, main:null, mainCi:"UNKNOWN", mainMergeable:"UNKNOWN", subs:{} }
export function createPr(repo, { base, head, title, body, draft }, { auth }) -> { number, url }
export function markReady(repo, n, { auth })               // REST node_id, then GraphQL markPullRequestReadyForReview; no-op if not a draft
export function setBody(repo, n, body, { auth })
export function comment(repo, n, body, { auth }) -> { id, url }
export function editComment(repo, id, body, { auth })
export function newestComment(repo, { auth }) -> { id, createdAt } | null   // the repo's newest issue/PR comment; ids grow across a repo
export function commentsSince(repo, n, sinceId, { auth, sinceAt }) -> [{ id, login, body, createdAt, url }]   // issue comments with id > sinceId, oldest first; sinceAt (ISO) is sent as GitHub's `since` so older comments aren't downloaded
export function permission(repo, login, { auth }) -> "admin"|"maintain"|"write"|"triage"|"read"|"none"
   // REST .permission (GitHub folds maintain into write, triage into read); 404 -> "none"; cached per process (repo+login, case-insensitive)
export function clearPermissionCache()                     // tests only
export function merge(repo, n, { sha, method }, { auth }) -> { merged, sha }   // PUT pulls/n/merge; 409 -> CollabError(PRECONDITION,"head changed"); 405 -> PRECONDITION
export function closePr(repo, n, { auth })
export function deleteBranch(repo, branch, { auth }) -> boolean   // DELETE git/refs/heads/<branch>; false when 422/404 (already gone)
export function branchProtected(repo, branch, { auth }) -> boolean|null   // GET branches/<b> .protected; null on any error
export function ciOf(prNode) -> "SUCCESS"|"FAILURE"|"PENDING"|"NONE"|"UNKNOWN"   // pure, used by liveSnapshot
```
- `ci` comes from `statusCheckRollup.state`: `SUCCESS`, `FAILURE`/`ERROR`, or `PENDING`/`EXPECTED`. `NONE` means there's no rollup or `totalCount === 0`.
- `mergeable` is passed through as-is: `MERGEABLE`, `CONFLICTING` or `UNKNOWN` (null becomes `UNKNOWN`).

## pr.mjs
```js
export function parsePrRef(arg, defaultRepo) -> { repo, number }    // URL https://github.com/o/r/pull/42, "o/r#42", "#42", "42"
export function checkSupported(pr, repoInfo) // throws CollabError(UNSUPPORTED) for fork (isCrossRepository), closed/merged, head == default branch
export const MARK_START = /<!-- collab:dashboard:start seq=(\d+)(?: at=([^ ]+))? -->/;  MARK_END = "<!-- collab:dashboard:end -->"
export function readMarker(body) -> { seq, at } | null
export function splice(body, block, seq, at) -> string | null   // null when existing seq > seq or the block is unchanged; inserts at top when markers absent
   // only text between the markers changes; the owner's text stays byte-for-byte (CRLF kept; the block uses the body's line ending)
   // a start marker with no end marker counts as absent; a block containing collab markers throws (bug)
export function ciFilteredToDefault(cwd, defaultBranch) -> boolean   // scans .github/workflows/*.yml|yaml at origin/<default> (git.lsFiles/showFile)
export function workflowFiltersToDefault(yamlText, defaultBranch) -> boolean   // pure, line-based: every pull_request(_target) trigger has branches == [default]
```
- `checkSupported` messages say what to do next (push the branch here, reopen, open a new PR, use a feature branch). `details.reason` is `fork`, `merged`, `closed` or `default-head`. It accepts `state` in either case.

## config.mjs
```js
export const DEFAULTS = { leaseMin: 90, reviewLeaseMin: 60, planLeaseMin: 15, reviewAlertH: 2, maxTasks: 12, wip: 1, worktreeRoot: ".collab/wt" };
export function loadRepoConfig(cwd, defaultBranch, io = { showFile, lsFiles }) -> { ...DEFAULTS, verifyCmd, setupCmd, warnings[] }
   // .collab.json at origin/<default> (git.showFile), merged over DEFAULTS; io is injectable for tests
   // keys outside DEFAULTS (apart from verifyCmd/setupCmd), or of the wrong type, are ignored with a line in warnings[]
   // invalid JSON or a non-object .collab.json -> CollabError(ENV)
   // verifyCmd auto = package.json scripts.test (not npm's "no test specified" placeholder) ? ["npm","test"] : null;
   // setupCmd auto (root lockfile via git.lsFiles) = package-lock.json ? npm ci : pnpm-lock.yaml ? pnpm install --frozen-lockfile : yarn.lock ? yarn install --frozen-lockfile : null
   // verifyCmd / setupCmd are argv arrays after parsing: a string splits on whitespace (quotes not supported), an array is used as-is, null switches it off
export function parseCmd(value) -> string[] | null | undefined   // undefined = invalid type
export function resolveCmd(argv, platform = process.platform, env = process.env) -> { cmd, args, shell: false } | null
   // win32: npm/npx/pnpm/yarn (-> <name>.cmd) and any .cmd/.bat run as ComSpec /d /s /c <file> ...args, because Node refuses
   // to spawn .cmd without a shell; args holding & | < > ^ % " are refused (CollabError PRECONDITION), not escaped
```

## dashboard.mjs (pure)
```js
export function status(ledger, live, now) -> { key, emoji, label }   // order per design.md
export function render(ledger, live, history, now, { prUrl }) -> markdown   // full block WITHOUT markers
export function renderCollapsed(ledger, reportUrl, now) -> markdown           // one line for Ready
export function lint(markdown) -> string[]   // a11y problems; [] when clean
```
- `key` is `planning`, `paused`, `closed`, `merged`, `ready`, `blocked`, `idle` (No active agents), `at-risk` or `on-track`. The phase-based keys go first, in the order merged (`live.mainState`), closed (phase or `live.mainState`), paused, planning.
- `live` is the CLI's flattened snapshot `{ mainCi, mainMergeable, mainState, mainHeadSha, additions, deletions, subs }` or `github.liveSnapshot`'s shape; `null` or `ok: false` means offline, which is never `ready`. A sub-PR snapshot at another head SHA counts as `UNKNOWN` CI.
- A merge freeze blocks once the oldest fix-ci task that is unfinished, or that covers `live.mainHeadSha`, is over 60 minutes old, counted from `times.reopened` when the task was withdrawn and reopened.
- The claim-overlap warning shows `tasks[T].overlap` entries whose task is still in flight, naming that task's current owner.
- Every string from people or agents is escaped (`\`, `|`, `` ` ``, `*`, `_`, `[`, `]`, `<` becomes `&lt;`, newlines become spaces), so the block never holds raw HTML or a collab marker. Titles are cut to 80 characters, owner-decision reasons to 200, and only `https://` URLs are linked.
- Recent activity leaves out `agent.seen`, `comments.seen`, `notice.sent` and `task.lease`. Over 10,000 characters, the Tasks and Agents tables fold into `<details>` and the activity list is dropped.
- Golden files live in `tests/fixtures/dashboard/` (built by `build.mjs` through `newLedger` and `apply`); `UPDATE_GOLDEN=1` regenerates them.

## relay.mjs (see design.md "Sandboxed agents: relay")
```js
export const RELAY_ALLOW = ["join","context","plan","prompt","next","wait","status","claim","push","sync","verify","submit","release","review-claim","review","diff","merge","add","cancel","note","block","unblock","dashboard"];
export function relayDir(repoRoot) -> `${repoRoot}/.collab/relay`
export function isSandboxed(cwd, env) -> boolean           // COLLAB_RELAY=1, or the write probe in the git common dir fails with EPERM/EACCES
export async function request(repoRoot, { argv, agent, cwd, timeoutMs }) -> { code, stdout, stderr }   // client
export function validate(repoRoot, req, { fixedAgent }) -> { ok, code?, message? }   // allowlist + paths inside repoRoot + agent match
export async function serve(repoRoot, { fixedAgent, runCollab, signal })   // relay loop; runCollab(argv, { cwd, env }) -> { code, stdout, stderr }
```

## agents.mjs (invite, stop, doctor; see design.md "Merge-to-main protection for invited agents")
```js
export function claudeAllowed(launcher), CLAUDE_DENIED, launcherPath(env)   // the invited Claude may run only the launcher (absolute path), read-only git and file tools
export function startupPrompt({ url, number, tool, agent, task, review }) -> string   // join-prompt.md + id, task, stop rule
export function launchSpec(tool, { root, runDir, agent, model, env }) -> { cmd, args, cwd, env, relay }   // pure; COLLAB_CLAUDE / COLLAB_CODEX JSON argv override the binary
export async function invite({ tool, root, repo, pr, url, agent, model, task, review, timeoutMs, env }) -> run   // detached agent (+ relay for codex) + watchdog; writes ~/.collab/runs/<id>/run.json
export function listRuns(env) -> run[]  ·  killRun(run, reason) -> pids  ·  markStopped(run, reason, pids) -> run  ·  stopRun = both  ·  killTree(pid)  ·  isAlive(pid)
export function doctorChecks({ env, home, cwd, gitProbe, ghLogin }) -> [{ name, ok, detail, required }]
export function codexModel(home) -> string | null          // `model` from ~/.codex/config.toml
```

## version.mjs
`export const VERSION`: kept in the skill folder so copied installs know it; `tests/unit/package.test.mjs` keeps it equal to package.json.

## cli.mjs
`main(argv, { env, cwd, stdout, stderr }) -> exit code`. One handler per command. Every mutation is `commit(ctx, build)`, where `build(ledger) -> events[]` runs inside `store.write`'s compare-and-swap. GitHub side effects come after the ledger write, and the dashboard comes last (best effort).
- **Account pinning:** `git config collab.login` holds the pinned account. A clone that isn't pinned adopts the ledger's account, and a clone pinned to another account refuses. `join` reads the ledger before it calls GitHub.
- **Housekeeping** (`next`, `wait` and most mutations) applies `/collab pause|cancel` comments from write-access logins, expires reviewer leases, adds the fix-ci task when main CI is red and no fix-ci task is unfinished, withdraws an unclaimed fix-ci task (unless a reservation on it is still running) when main CI is green again and closes its sub-PR if it has one, and records `agent.seen` at most every 10 minutes. It drops events the fresher ledger no longer accepts, and ignores contention.
- **Join:** a new ledger starts with `lastCommentId` / `lastCommentAt` at the repo's newest comment (`newestComment`, one request; best effort with a warning), so directives from an earlier collab on the same PR (before `close --purge`) are not replayed.
- **Agent binding:** with `COLLAB_AGENT` set, `--agent` must equal it; `join` refuses a new id whose prefix is not its `--tool`; `relay` and `invite` are refused when `COLLAB_AGENT`, `COLLAB_RELAY` or `COLLAB_RELAYED` is set. `invite` gives a Codex agent and its relay a shared `COLLAB_RELAY_KEY`; `relay.request` signs with it (`sign(key, req)`) and `relay.validate` refuses unsigned or repeated requests when the relay has a key.
- **Push guard:** `pushTask` refuses, before `git push`, a change to `.github/workflows/**`, `.github/actions/**` or `.collab.json` unless `tasks[T].allowProtected` (cleared by `task.release` and `task.claim`). `changedFiles` uses `--no-renames`, so a moved file counts at both paths.
- **File arguments:** `--tasks` and `--body-file` must resolve inside the main checkout, the worktree collab runs from, or `config.worktreeRoot` (`relay.inside`).
- **Command environment:** `commandEnv(env, passEnv)` removes variables whose names look like secrets before `verifyCmd` and `setupCmd` run; `passEnv` (an array of names in `.collab.json` on the default branch) keeps the ones listed.
- **Verify:** `collab verify` runs the tests on the pushed commit only and prints their output under an "untrusted data" label. The task owner's worktree is refused when it holds an uncommitted or untracked file (`collab push` first). A review worktree is collab's own checkout, so its tracked files are reset to the pushed commit before the tests run, and `review-claim` moves it with `checkout --force`. Untracked files a test run left there are not removed. An agent that is neither the owner nor the reviewer is refused before any worktree is touched.
- **Decisions:** `next`, `wait` and `claim` print the owner's `decide` answer for the agent's own task (`decision` in `--json`), since agents can't read the PR.
- **Review:** `collab review` applies the `review.verdict` event to the ledger in memory before posting the review comment, so a verdict the reducer would refuse never reaches GitHub.
- **Notices:** `needs-owner:T<n>:<blocked.since>` (one per question), `ready` and `sticky` comments carry `<!-- collab:notice key=… -->`. They are deduped through `ledger.notices` plus a search for the marker. Needs-owner notices go out even when the renderer is broken.

## Plan sessions (`collab plan <sub>`; see design.md "Plan sessions")
A plan session is a GitHub issue labelled `collab-plan` plus the ledger on `refs/collab/plan-<issue#>`. Each person acts as their own pinned GitHub login. Text written by people or agents (plan text, summaries, comments, diffs) is untrusted data everywhere.

### store.mjs: ref kinds and extra tree files
```js
export const KINDS = ["pr", "plan"];
export const refFor = (n, kind = "pr") => `refs/collab/${kind}-${n}`;
export const cacheRefFor = (agent, n, kind = "pr") => `refs/collab-cache/${agent ?? "anon"}/${kind}-${n}`;
// read, write, history and remove take kind = "pr" (an unknown kind -> CollabError(BUG)). Messages say "PR 42" or "plan 57".
// write's mutate may return { ledger, events, files }: files = { [name]: blobOid } adds one `100644 blob <oid>\t<name>` line
//   per entry to mktree, next to ledger.json. Names match /^[A-Za-z0-9][A-Za-z0-9._-]*$/ and are not "ledger.json",
//   else CollabError(BUG). Nothing is carried over from the parent tree: the caller passes the full map each write.
//   Without files the tree is exactly { ledger.json }, as before.
export function list({ cwd, agent, auth, kind }) -> [{ n, ledger, rev }]   // numeric order
//   git fetch --prune --no-tags --no-write-fetch-head origin +refs/collab/<kind>-*:refs/collab-cache/<agent>/<kind>-*,
//   then each cache ref's ledger.json. A ref whose ledger can't be parsed is skipped.
```
`remove` deletes this clone's `refs/collab-cache/*/<kind>-<n>`.

### git.mjs additions
```js
export function normText(s) -> string           // "\r\n" and "\r" -> "\n", a leading BOM dropped, exactly one trailing "\n" ("" stays "")
export function hashText(cwd, text) -> oid       // hash-object -w --stdin of normText(text); no filters
export function blobText(cwd, oid) -> string     // cat-file blob <oid>
export function diffBlobs(cwd, a, b) -> string   // unified diff of two blob ids (git diff --no-color --no-ext-diff -U2 a b), header lines up to the first @@ dropped; "" when equal
export function mergeText(cwd, { ours, base, theirs, labels: [ours, base, theirs] }) -> { clean, text, conflicts }
   // git merge-file -p --diff3 --object-id -L … -L … -L … <ours> <base> <theirs>; exit 0 clean; 1-127 = conflict count
   // (text holds the markers); 129 -> CollabError(ENV, "plan sessions need git 2.43 or newer"); any other code > 127 -> ENV.
   // Returned text is normText()ed.
export function commitFileOnto(cwd, { base, path, text, message, author }) -> commit sha
   // base = a commit-ish; builds a tree = base's tree + path:=text with a temporary GIT_INDEX_FILE (read-tree, update-index
   // --add --cacheinfo 100644,<oid>,<path>, write-tree), then commit-tree -p <base>. author = { name, email }; date = clock.iso().
   // Never touches the working tree, HEAD or the real index.
export function gitVersion() -> [major, minor, patch] | null
```

### github.mjs additions (all through `api()`)
```js
export function getIssue(repo, n, { auth }) -> { number, state: "OPEN"|"CLOSED", stateReason, locked, title, body, labels: [names], url, isPr, author }
   // isPr = the REST issue has a pull_request field
export function createIssue(repo, { title, body, labels = [] }, { auth }) -> { number, url }
export function patchIssue(repo, n, { title, body, state, stateReason }, { auth })   // only the given keys are sent (state_reason)
export function closeIssue(repo, n, { reason = "completed" } = {}, { auth })
export function listIssues(repo, { label, state = "open" }, { auth }) -> [{ number, title, url, state, updatedAt, author }]
   // GET issues?labels=&state=&per_page=100 --paginate; entries with pull_request are dropped
export function ensureLabel(repo, name, { color = "5319e7", description = "" } = {}, { auth }) -> "exists"|"created"|"forbidden"
   // GET labels/<name>; 404 -> POST labels; 422 on POST (created meanwhile) -> "exists"; 403 -> "forbidden" (never throws for 403)
```

### pr.mjs additions
```js
export function parseIssueRef(arg, defaultRepo) -> { repo, number }   // https://github.com/o/r/issues/57 (and /pull/57), o/r#57, #57, 57
export function splice(body, block, seq, at, { name = "dashboard" } = {})   // markers <!-- collab:<name>:start seq=N at=… --> / <!-- collab:<name>:end -->
export function readMarker(body, { name = "dashboard" } = {}) -> { seq, at } | null
export function readBlock(body, { name }) -> { seq, at, text } | null   // text between the markers, line endings normalised to \n, outer blank lines trimmed
export function markedBlock(name, seq, at, content) -> string            // start marker + \n + content + \n + end marker
```
The `name` default keeps every dashboard caller unchanged. The block-holds-markers check refuses any `<!-- collab:<name>:` inside the block.

### plan-ledger.mjs (pure reducer)
- **Exports:** `SCHEMA = 1`, `PHASES = ["drafting", "agreed", "handed-off", "closed"]`, `MAX_CHARS = 50000`, `newPlanLedger`, `apply`, `activePeople`, `consensus`, `personOf`, `isOwner`, `stateKey`, `EVENT_TYPES`.
- **Constructor:** `newPlanLedger({ issue, owner, agent: { id, tool, host }, minPeople = 2, rev1: { hash, blob, chars, summary }, now, lastCommentId = 0, lastCommentAt = null })` returns `seq: 0, rev: null`, `phase: "drafting"`, `current: 1`, `revs: { "1": { …rev1, base: 0, merged: false, agent, login: owner, at } }`, the owner registered as a person and the agent registered under the owner's login. `issue = { repo, number, url, title, defaultBranch }`.
- **Shape:**
```jsonc
{ "schema": 1, "kind": "plan", "seq": 0, "rev": null,
  "issue": { "repo", "number", "url", "title", "defaultBranch" },
  "owner": "zwymer", "phase": "drafting", "current": 1, "minPeople": 2, "maxChars": 50000,
  "revs": { "1": { "hash": "sha256:<hex>", "blob": "<oid>", "base": 0, "merged": false, "agent": "claude-a1f3", "login": "zwymer", "summary": "…", "chars": 0, "at": "…" } },
  "people": { "zwymer": { "joinedAt": "…", "lastSeen": "…", "observer": false, "left": null, "removed": null } },
  "agents": { "claude-a1f3": { "tool": "claude", "vendor": "anthropic", "login": "zwymer", "host": "…", "joinedAt": "…", "lastSeen": "…" } },
  "agreements": { "zwymer": { "rev": 1, "hash": "…", "at": "…", "via": "agent:claude-a1f3", "commentId": 0, "url": null } },
  "directives": [], "lastCommentId": 0, "lastCommentAt": null, "notices": {},
  "handoff": null, "agreedAt": null, "closed": null }
```
- **Reducer:** `apply(ledger, event)` returns a new ledger and never mutates its input; `seq = ledger.seq + 1`. `event = { type, login, agent?, data, at }`.
- **Active person:** in `people`, not `observer`, `left` and `removed` both null. `activePeople(ledger)` returns them sorted.
- **Owner operations** (`person.remove`, `reopen`, `state.set`) are allowed when `event.login === ledger.owner`, or `event.data.asAdmin === true` (the CLI sets it after checking admin permission).
- **Refusal order:** schema mismatch → ENV; no type, no valid `at` or no `login` → BUG; unknown type → PRECONDITION; for every type except `plan.join`, `directive`, `comments.seen` and `notice.sent`, the login must be in `people` and an `agent`, when given, must be registered under that login → PRECONDITION; phase `closed` → UNSUPPORTED except `comments.seen`, `notice.sent`, `agent.seen`, `directive`; phase `agreed`/`handed-off` (frozen) → PRECONDITION for `rev.add`, `agree`, `agree.withdraw`, `person.leave`, `person.remove`. Messages name the actor and why: `alice can't agree to revision 2: revision 3 is current`. `details = { type, login, agent }`.
- **Consensus:** after `agree`, `person.leave` and `person.remove`: when `activePeople.length >= minPeople` and every active person has an agreement whose `rev === current` and `hash === revs[current].hash`, `phase = "agreed"` and `agreedAt = event.at`. `consensus(ledger)` returns `{ agreed, waitingOn: [login], agreedBy: [login], needMore }` (`needMore` = people still to join to reach `minPeople`).
- **`stateKey(ledger)`** returns a string that changes whenever `current`, `phase`, any agreement, or any person's status changes (not `lastSeen`). Agents compare it with their local seen state.

| Type | `data` fields | Rule |
|---|---|---|
| `plan.join` | `{ tool, host }` | `event.agent` is required. A new login becomes a person (`observer: true` while frozen). A known agent with another login, or another tool, is refused. Rejoining clears `left`; a `removed` person is refused. The agent's vendor comes from `VENDORS` in ledger.mjs. |
| `agent.seen` | `{}` | Updates the agent's and person's `lastSeen`. |
| `rev.add` | `{ rev, hash, blob, base, merged, summary, chars }` | Drafting only; an active person; `rev === current + 1`; `1 <= base <= current`; `chars <= maxChars`; `hash` matches `/^sha256:[0-9a-f]{64}$/`; `blob` is 40 or 64 hex. Sets `revs[rev]`, `current = rev`, clears `agreements`, updates `lastSeen`. |
| `agree` | `{ rev, hash, via, commentId?, url? }` | Drafting; an active person; `rev === current`; `hash === revs[current].hash`. Sets `agreements[login]`. |
| `agree.withdraw` | `{}` | Drafting; deletes `agreements[login]` (refused when there is none). |
| `person.leave` | `{}` | Drafting; not the owner; sets `left = at` and deletes the agreement. |
| `person.remove` | `{ target, reason, asAdmin? }` | Drafting; owner operation; `target` is a person, not the owner and not already removed. Sets `removed = { by, at, reason }`, deletes the agreement. |
| `reopen` | `{ asAdmin? }` | Owner operation; only from `agreed`. Back to `drafting`; clears `agreements` and `agreedAt`; observers become active. |
| `handoff` | `{ pr, url, branch, path, rev, hash }` | Any active person; only from `agreed`; `rev === current`, `hash` matches. `phase = "handed-off"`, sets `handoff = { …data, by: login, at }`. |
| `state.set` | `{ phase: "closed", reason, asAdmin? }` | Owner operation; `closed` is final; sets `closed = { by, at, reason }`. |
| `directive` | `{ commentId, commentAt?, cmd, rev?, hashPrefix?, url?, applied, why? }` | Audit record of a `/collab` comment by `event.login`. Refused when `commentId <= lastCommentId`. Appended to `directives`; sets `lastCommentId` (and `lastCommentAt`). |
| `comments.seen` | `{ lastCommentId, lastCommentAt? }` | Only moves forward. |
| `notice.sent` | `{ key, commentId }` | Sets `notices[key]`. |

### plan-next.mjs (pure)
```js
export function planNext(ledger, me, seen, { issueState = "OPEN", newComments = 0, number } = {}) -> {
  action: "closed"|"join"|"removed"|"read"|"agreed"|"handed-off"|"wait", why, cmd: ["collab", "plan", sub, "<n>", "--agent", me] | [] }
```
`seen` is the agent's local `{ key, commentId }` (or null). First match wins:
1. `closed`: `phase === "closed"` or `issueState === "CLOSED"`. `cmd: []`.
2. `join` (me not in `agents`); `removed` (my person was removed); `cmd` is `plan join <n>` or `[]`.
3. `read`: `seen` is null, `seen.key !== stateKey(ledger)`, or `newComments > 0`. `cmd: plan show <n>`.
4. `handed-off`: why names the PR URL. `cmd: []`.
5. `agreed`: why says everyone agreed to revision N; `cmd: plan handoff <n>`.
6. `wait`: why names who hasn't agreed yet (or how many people are still needed). `cmd: plan wait <n>`.

### plan-render.mjs (pure)
```js
export function status(ledger) -> { key, emoji, label }   // drafting ⚪ Drafting | waiting 🟡 Waiting on agreement (someone agreed) |
                                                          // agreed ✅ Agreed | handed-off 🚀 Handed off | closed ⚫ Closed
export function renderStatus(ledger, now, { browserEdit = false } = {}) -> markdown   // the issue's status block, without markers
export function revisionComment(ledger, rev, diff, { prefix }) -> markdown              // "📝 Revision 3 by …: <summary>" + capped diff in <details>
export function agreeComment(ledger, login, { rev, hash, via }) -> markdown             // carries <!-- collab:plan-agree login=… rev=… hash=… -->
export function noticeComment(key, text) -> markdown                                    // "<!-- collab:notice key=… -->\n" + text
export function messagePrefix(ledger, agent) -> string                                  // "🤖 alice's Claude (claude-x9):"
export function quietMentions(text, logins) -> string    // `@x` for logins that aren't people in the session, so they aren't notified
export { lint } from "./dashboard.mjs";
```
- **Status block:** `## Plan session: <emoji> <label> (revision N, as of <UTC>)`. Then a sentence on what's needed (every person below agrees to the same revision, at least `minPeople`), "Waiting on: …" or "Everyone agreed to revision N on <UTC>." Then a people table (Person, Agents, Agreed to, How, Last active), the join line (`/collab plan <n>` in Claude Code, `$collab plan <n>` in Codex, `collab prompt plan <n>` for other agents), and the browser agree line `` `/collab agree r<N> <first 8 hex of the hash>` ``. When `browserEdit`, a "⚠️ Warning:" line says the plan section was edited in the browser and stays until the next revision. When handed off, a link to the PR. A footer says the plan below is replaced by each new revision.
- Every string from people or agents goes through the dashboard's escaping rules (one line, `\`, `` ` ``, `*`, `_`, `[`, `]`, `|` escaped, `<` → `&lt;`); only `https://` URLs are linked; `lint(renderStatus(…))` is `[]`.
- Golden files live in `tests/fixtures/plan/`; `UPDATE_GOLDEN=1` regenerates them.

### plan-cli.mjs
`planSession(ctx, helpers)` handles `collab plan <sub>`; `cli.mjs` passes `{ auth, pin, inputPath, readTextFile, ev, mainRoot }` so there is no import cycle. `loadPlan` / `commitPlan` replace `load` / `commit` (which read `ledger.pr`). `auth(ctx)` is called without a ledger login: each clone acts as its own login.
- **Local files** (the CLI picks every path; all under `<root>/.collab/plans/<n>/`): `draft.md` and `draft.base` (from `pull`), `draft.conflict.md`, `seen-<agent>.json` (`{ key, commentId }`).
- **Issue body:** a `plan-status` block (seq = ledger seq) then a `plan-doc` block (seq = revision). The doc block is rewritten only when its marker's seq is older than `current`; when its text differs from `r<current>` at the same seq (a browser edit), it stays, a `browser-edit:r<N>` notice goes out once, and the status block warns.
- **Relay:** `relay.validate` allows `plan` with no subcommand or with `list new join pull show edit say agree leave next wait status handoff`; `close`, `remove`, `reopen` and anything else get exit 2.

## Fakes for tests (`tests/helpers/`)
- `bare-remote.mjs`: `makeRepo()` returns `{ dir, remote, clone(name) -> path, cleanup() }` in a temp folder. Each clone sets `user.name`/`user.email`, `core.autocrlf=false` and no auto gc. The first clone pushes an initial commit (`README.md`) to `main` and a `feat/x` branch with one more commit (`src/x.txt`). Also exports `sh(args, cwd)`, a throwing git runner for assertions.
- `race-worker.mjs`: `node race-worker.mjs <clone> <agent> <rounds> <pr>` increments a `{ seq, counter, log }` ledger `rounds` times through `store.write`; used by `tests/unit/store-race.test.mjs`.
- `fake-gh.mjs`: implements `gh api` (REST paths used above, `-X`, `--input -`, `-f/-F`, `--paginate --slurp`, `--jq .a.b`) and `gh api graphql` (aliased `pullRequest(number:N)` found by regex, and `markPullRequestReadyForReview`), plus `gh auth token --user <login>`. It reads its state from the JSON file named in `COLLAB_FAKE_GH_STATE` and writes every call (`{ argv, stdin, env: { GH_TOKEN, GITHUB_TOKEN } }`) to that state's `calls[]`, under a lock file with atomic rename.
  - `GH_TOKEN` acts as the login that owns it in `tokens` (unknown token -> HTTP 401); without it, `user` is the active login.
  - A merge with a stale `sha` fails like gh: `gh: Head branch was modified. Review and try the merge again. (HTTP 409)`, exit 1.
  - `failures: [{ match, status, message, times }]` injects errors (`match` is a substring of `"<METHOD> <path>"`, `"POST graphql"` for GraphQL; `status: null` is a network error).
  - `repos[x].gitDir` (a bare remote, e.g. from `bare-remote.mjs`) makes head SHAs, merges (`git merge-tree` + `commit-tree`) and branch deletes real.
- `fake-gh-state.mjs`: `makeFakeGh(initialState)` -> `{ env: { COLLAB_GH, COLLAB_FAKE_GH_STATE }, file, read(), update(fn), calls(), use() /* sets process.env, returns restore */, cleanup() }`. The state shape is documented at the top of the file.
- `clock.mjs`: `withNow(iso, fn)`.
- `cli-env.mjs`: `setup()` builds a bare remote, clones, the fake gh pointed at that remote, and a temp `COLLAB_HOME`. It returns `run(clone, argv, env)` / `runAsync` / `json` / `as(clone, agentId, argv)` / `start(tasks, tools)` / `idOf(result)`, which drive the real CLI with agent env vars stripped. The use-case tests use it.
- `fake-agent.mjs`: stands in for `claude`/`codex` under `invite`. It records argv, env and the stdin prompt to `FAKE_AGENT_LOG/<id>.json`, runs the `FAKE_AGENT_ACTIONS` collab commands (with `__ID__` replaced by its id), then idles until killed.
- **Plan sessions in the fakes:**
  - `fake-gh` keeps issues in `issues: { "o/r#57": { title, body, state: "open"|"closed", stateReason, locked, labels: [names], author, updatedAt } }` and labels in `repos[x].labels: [{ name, color, description }]`.
  - Routes: `POST issues`, `GET issues` (PRs included, as GitHub does, each with a `pull_request` field), `GET/PATCH issues/:n`, `POST issues/:n/labels`, `GET labels/:name`, `POST labels`.
  - Issue and PR numbers come from one counter, comments work on issues, and comment URLs use `/issues/` for an issue.
- `cli-env.setup({ people })` (for example `{ alice: "write", bob: "read" }`) adds collaborators and tokens (`tok-<login>`).
  - `person(login)` returns a clone named after the login, with `collab.login` pinned.
  - `browserComment(login, n, body)` posts a comment as that login straight into the fake state.
  - `browserEdit(n, fn)` replaces an issue body with `fn(body)`, the way a browser edit would (CRLF line endings).
