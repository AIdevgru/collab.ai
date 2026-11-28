# Spike results (2026-11-16, throwaway repo `AIdevgru/collab-e2e-20261116`)

| # | Check | Result | Decision |
|---|---|---|---|
| 1 | Push/fetch/`--force-with-lease` on `refs/collab/pr-1` | ✅ Works. With an empty expected value (`--force-with-lease=<ref>:`), the first create succeeds and a second create is rejected `[rejected] (stale info)`. Compare-and-swap with the correct old value fast-forwards; with a stale old value it is rejected `(stale info)`. A fetch into `refs/collab-cache/<agent>/pr-1` works. | Use the custom ref as designed. Detect a lost race with `--porcelain`: the line starts with `!` and contains `stale info`, `fetch first` or `non-fast-forward`. |
| 1b | Actions triggered by ref pushes | ✅ None. `gh run list` shows only the `push main` run, even though the workflow has an unfiltered `on: push`. | Confirmed: ledger writes cost no CI. |
| 2 | REST merge with a `sha` guard into a non-default base | ✅ A stale SHA returns HTTP 409 "Head branch was modified". The correct SHA squash-merges into `feat/strings`. | `github.merge` maps 409 to `CollabError(PRECONDITION, "head changed")`. |
| 3 | Pinned token via env | ✅ `GH_TOKEN=$(gh auth token --user zwymer)` makes `gh api user` return `zwymer`. `git -c credential.helper= -c 'credential.helper=!gh auth git-credential' ls-remote` authenticates with `GH_TOKEN`. The override case (the *other* account active) was **not run**: using the second account's token was blocked by the session's safety classifier. It moves to e2e scenario F, which needs Zach's go-ahead. | Ship as designed. |
| 4 | Batched GraphQL | ✅ One query with aliases returns `mergeable`, `isCrossRepository`, `additions`, the `statusCheckRollup` state and contexts, comments, and review threads for the main PR plus each sub-PR. `viewerPermission` is available too. | Ship as designed. |
| 4b | Collaborator permission API | ✅ `GET repos/{o}/{r}/collaborators/{login}/permission` returns `.permission` = `admin`. | Ship as designed. |
| 5 | Codex `exec -s workspace-write --add-dir <.git> -c sandbox_workspace_write.network_access=true` from an in-repo worktree | ❌ Codex can **edit files**, but: `git add` fails with `index.lock: Permission denied` (Codex keeps `.git` read-only even under `--add-dir`); `git push` fails with `schannel: SEC_E_NO_CREDENTIALS` (the sandbox user has no Windows credential store); `gh` fails with `config.yml: Access is denied`. | **Relay** (see design.md, "Sandboxed agents: relay"). No full-access mode: launching Codex with `danger-full-access` was refused by the safety classifier, and a relay is the better design anyway. |
| 5b | Codex default model | ⚠️ `~/.codex/config.toml` sets `model = "gpt-6.1-sol"`, which a ChatGPT-account login rejects (`model_not_found`). `gpt-5.6-sol` works. | `invite codex --model <m>` passes `-m`. `doctor` reports a model that fails. Zach's config is left untouched. |
| 6 | Agent env markers | Claude Code: `CLAUDECODE=1`, `AI_AGENT=claude-code_<ver>_agent`, `CLAUDE_CODE_SESSION_ID`. Codex 0.154: `AI_AGENT`, `CODEX_CI`, `CODEX_SESSION_ID`, `CODEX_THREAD_ID`, `CODEX_VERSION`. Codex sets `HOME=C:\Users\<you>`. | `identity.detectTool` checks: `CLAUDECODE` means claude; `CODEX_THREAD_ID` or `CODEX_SESSION_ID` means codex; otherwise it matches the `AI_AGENT` prefix. |
| 7 | `claude -p` with the invite tool lists | ✅ With the exact `--allowedTools`/`--disallowedTools` that `invite claude` passes, `node "C:/Users/<you>/.collab/bin/collab.mjs" --version` ran (`collab 0.1.0`), and `node -e "console.log(41+1)"` was blocked ("This command requires approval") before Node started. A full `/collab` run by an invited Claude is e2e A3, still open. | The allow list names the launcher by its absolute path; a blanket `Bash(node:*)` would let `node -e` bypass the deny list. |
| 8 | Codex reads a junctioned `~/.codex/skills/collab` | ✅ Both invited Codex agents in scenario A read `C:Users<you>.codexskillscollabSKILL.md` (and `PROTOCOL.md`) through the junction. | Link mode is fine for Codex; `--copy` stays as an option. |
| 9 | Interactive Codex paste (A2) | Pending (needs Zach). Expected to hit the same sandbox limits as #5, so the paste path also uses the relay. | |

## End-to-end scenario A (2026-11-16, PR #3 of `AIdevgru/collab-e2e-20261116`)

Claude (this session, `claude-aqzd`) planned 4 tasks and invited Codex (`codex-8w95`, `gpt-5.6-sol`). Codex built T2 and reviewed T1 and T3; Claude built T1, T3 and T4 and reviewed T2. A second invited Codex (`codex-apye`) reviewed T4 after the first had exited.

| Check | Result |
|---|---|
| `refs/collab/pr-3` exists; ledger pushes trigger no runs | ✅ 45 ledger writes, no workflow runs from the ref |
| `main` unchanged; owner text and `HUMAN TEXT SENTINEL` intact | ✅ |
| Sub-PR bases are the PR branch | ✅ #4–#7 all into `feat/helpers`, all merged by REST with the approved SHA |
| Reviews from two vendors | ✅ every task reviewed by the other vendor |
| The dashboard collapses at Ready | ✅ after a fix (below); final report comment posted |
| Codex works through the relay | ✅ join, claim, push, verify, submit, review-claim, review, wait |

Bugs the run found, all fixed with tests:
1. **Verify failed from Git Bash:** "'npm.cmd' is not recognized". A machine PATH entry ending in a stray `"` makes cmd.exe misread every later entry. Child processes now get PATH entries with quotes removed.
2. **The relay died on Windows:** renaming its heartbeat file over `alive` failed with `EPERM` while another process had it open. Writes now retry, and a failed heartbeat is logged, never fatal.
3. **An exited invited agent kept its lease for 90 minutes.** The ledger's `pid` was never set and never checked. Housekeeping now expires the leases of an agent invited from this machine whose process has exited, so its approved task was merged at once (not stolen, which would have cleared the approval).
4. **The final dashboard was stale:** merging the last sub-PR started main-PR CI, `next` said "done", and nobody re-rendered once CI went green. `next` now says `wait` while main-PR CI runs with every task done.
5. **Two relays in one repo** (a second invited Codex) would answer each other's requests with a refusal and delete each other's heartbeat. Each relay now has its own heartbeat file (`alive-<agent>`), and a pinned relay leaves other agents' requests for 20 s before refusing them.

CI on the GitHub Windows runners also found that the temp folder there is an 8.3 short path (`C:\Users\RUNNER~1`) while git reports the long one. The relay's "inside the repo" check now compares long paths, and the test helpers create temp folders by their long names. They also set `core.autocrlf=true` globally, which checked the test clones out with CRLF; the clones now turn it off at clone time.

## End-to-end scenario A3 (2026-11-17, PRs #8 and #11 of `AIdevgru/collab-e2e-20261116`)

Codex plans and an invited Claude (`claude -p` on Sonnet with the invite's tool lists) builds and reviews.

**First run, PR #8.** `collab invite codex --pr 8` on a PR with no collab: Codex (`codex-u6hu`) started it, planned two tasks (T2 depends on T1) and built T1. Claude (`claude-tdst`, invited with `--task T2`) reviewed T1. When T1 merged, Codex claimed T2 before Claude could, so Claude only reviewed. Both reviews approved, both sub-PRs merged, and both agents exited on their own; their watchdogs recorded "exited".

Problems found, all fixed with tests:
6. **`invite` refused a PR with no collab yet.** An invited agent (without `--task` or `--review`) now starts the collab and writes the plan.
7. **`plan --tasks .collab/plan-8.json` failed from Codex's working folder** (`<repo>/.collab`), which looked for `.collab/.collab/plan-8.json`. Codex retried with the bare name. `--tasks` and `--body-file` now fall back to the repo root, and a missing file is exit 2, not a collab bug.
8. **`invite --task T2` didn't hold T2.** Invite now reserves an open task for the new agent until its timeout (`task.reserve`). Other agents skip it and can't claim it. `stop`, or the agent's process exiting, frees it.
9. **The reviewer couldn't read the diff.** `review-claim` printed `git -C <wt> diff …`, which doesn't match the invite's `Bash(git diff:*)` rule, so Claude approved T1 saying it "could not run the git diff". It also couldn't write its notes to `/tmp`. That was 4 permission denials in all. New read-only `collab diff T [--stat] [file…]` (also through the relay), and `review-claim` names a notes file inside `.collab/`.

**Rerun, PR #11, with those fixes.** Codex (`codex-96d8`) planned two independent tasks. `plan --tasks .collab/plan-11.json` worked the first time. The moment the plan was posted, Claude (`claude-rg5x`) was invited with `--task T2`, and T2 was reserved for it. Then:
- Codex built T1 and Claude built T2, in parallel.
- Each reviewed the other's task: Claude used `collab diff T1` and wrote `.collab/review-t1.md`, and its review names the behavior and tests it checked.
- Sub-PRs #12 and #13 merged into `feat/num-words`.

| Check | Result |
|---|---|
| Codex plans; the invited Claude builds a task | ✅ T2, reserved for it, built and merged |
| Cross-vendor reviews | ✅ Claude reviewed T1, Codex reviewed T2 |
| `main` unchanged; owner text and `HUMAN TEXT SENTINEL` intact | ✅ `main` still `ba77aff` |
| No workflow runs from the ledger ref | ✅ runs come only from sub-PR `pull_request` events |
| Dashboard collapses at Ready | ✅ |
| No permission denials | ⚠️ 3, all from the model's own shell habits: a heredoc after `cd`, then `printf` to write a file, and the launcher wrapped in a shell variable. It recovered each time with the Write tool and the plain command. The join prompt now asks for one plain collab command per call and file tools for files. |
| Finished worktrees cleaned up | ✅ the agents' last `next` pruned them |

## End-to-end scenario A2 (2026-11-17, PR #16 of `AIdevgru/collab-e2e-20261116`)

Claude (this session, `claude-r814`) planned two tasks and built T1. Zach opened the e2e clone in **Codex Desktop** (Codex 0.169, `gpt-6.1-sol`) and typed `$collab`. A relay was running in the repo for a sandboxed Codex, but nothing used it: this Codex session ran in **Full access** (approval policy `never`, sandbox `danger-full-access`), so it ran collab's git and gh calls directly.

What happened:
- Codex Desktop loaded the skill through the `~/.codex/skills/collab` link. `$collab` worked in the app, not only in the CLI.
- Zach typed `$collab 17`, the newest PR on GitHub, which was the T1 sub-PR. **collab joined it and started a second collab on the sub-PR**: a `refs/collab/pr-17` ledger and a dashboard in #17's description. Codex noticed #17 was a sub-PR of #16 and asked Zach which to join; he chose #16.
- Codex joined #16 as `codex-zlrs` and reviewed T1. It read the change with `collab diff` and ran `collab verify`. Then it ran `join` again, which minted a second id, `codex-elws`; with that one it noted the switch on T1, built T2 (sub-PR #18) and later merged it. Both ids are Codex, so the cross-vendor rule held.
- Claude merged T1 and reviewed T2. Both sub-PRs merged into `feat/palindrome-title`, CI on the main PR passed, and the dashboard collapsed at Ready. `main` (`ba77aff`) and the owner's text were unchanged.

Fixed with tests:
10. **`join` on a task's sub-PR** (head `collab/pr-<n>/t<k>`) is now exit 4: "PR #17 is the sub-PR for task T1 of the collab on PR #16. Join that PR instead: collab join 16".
11. **Review notes files could collide.** `review-claim` named the file `review-t2.md`, which overwrote the one left from PR #3's T2. It is now `review-pr<n>-t<k>.md`.

Zach removed the stray PR #17 collab with `collab close --purge --pr 17`. He first typed it into Codex, where collab refused it as owner-only and purged nothing. Codex didn't work around the refusal: it told him to run it in his own terminal, and he did.

**Sandboxed rerun, PR #19.** Zach switched Codex Desktop out of Full access and pasted `$collab <PR #19 link>` into the same thread. That turn ran with sandbox `workspace-write`, network on and approval policy `never`. Claude (`claude-wf8m`) planned two tasks and built T1. A relay was running in the repo, and every one of Codex's (`codex-x8j0`) collab calls went through it: join, next, review-claim, diff, context, verify and review of T1; then claim, push, verify, diff, submit and merge of T2. Codex wrote its notes to `.collab/review-pr19-t1.md` and its code inside its task worktree. Claude merged T1 and reviewed T2. Both sub-PRs (#20, #21) merged, CI passed and the dashboard reached Ready.

| Check | Result |
|---|---|
| Sandboxed Codex reaches git and GitHub only through the relay | ✅ every collab call in the relay log, exit 0 |
| Permission prompts or blocked commands | ✅ none in 40 tool calls (approval policy `never`: Codex Desktop's default mode doesn't ask) |
| Cross-vendor reviews; `main` and owner text unchanged | ✅ |
| Owner-only commands refused inside Codex | ✅ `close` was refused in the earlier turn |

Codex Desktop's "ask before running" mode (approval `on-request`) is untested. With the relay it should need no git or gh approvals.

Still open: F (account switch) needs Zach; G (NVDA pass over the dashboard).


## End-to-end plan sessions (2026-11-24, issue #1 and PR #2 of `AIdevgru/collab-e2e-20261124`)

Two clones on one machine, pinned with `git config collab.login` to `zwymer` (the active gh account) and `mercuryreach` (a second account in gh's keyring, added as an outside collaborator with write access). The CLI was driven directly, as each person's agent (`claude-k0s4` for zwymer, `codex-0esi` for mercuryreach), from the installed collab, with plan sessions in. No `gh auth switch`: each clone's writes used `gh auth token --user <login>`, which also closes spike 3's open case (the other account active).

| Scenario | Result |
|---|---|
| **A.** `plan new --title "Add a slugify helper"` | ✅ Issue #1 by zwymer, labelled `collab-plan` (the label was created). The ref `refs/collab/plan-1` holds `ledger.json`, `plan.md` and `r1.md`. No workflow runs from the ref, with an unfiltered `on: push` workflow in the repo. |
| **B.** mercuryreach runs `plan list`, then `plan join 1 --tool codex` | ✅ The list shows #1 waiting on zwymer. The 👋 join comment comes from mercuryreach's own account. |
| **C.** Edits to different sections, then to the same line | ✅ r2 (zwymer, Goal) and r3 (mercuryreach's draft from r1, Approach) merged cleanly. A clashing edit of the Context line from r3 exited 2 with `draft.conflict.md` and published nothing. Publishing the file with its markers still in was refused. Once resolved, it published as r5, and the conflict file was removed. |
| **D.** Messages and `wait` | ✅ `plan say` posted "🤖 zwymer's Claude (claude-k0s4): …" from zwymer's account. `@mercuryreach` (a participant) stayed a mention, and `@octocat` became `` `@octocat` ``. mercuryreach's `plan wait --timeout 4m` returned 29 s after the message was posted. mercuryreach got a notification for the issue and is subscribed to it. |
| **E.** zwymer agrees through his agent; mercuryreach comments `/collab agree r5 8b79ac6c` | ✅ ✅ Agreed with one notice. The header shows `agent:claude-k0s4` and `comment`. A later `plan edit` is refused: "plan #1 is agreed, so it is frozen". |
| **F.** `plan handoff 1`, then `/collab` on the PR | ✅ Draft PR #2 "Build: Add a slugify helper" into `main` from `collab/plan-1-build`, with one file, `docs/plans/1-add-a-slugify-helper.md`, whose sha256 is the agreed hash. `collab join 2` then `collab context --pr 2` returned `planSource` (issue 1, rev 5, agreed by both, `changedOnBranch: false`) and the text under `untrusted.plan`. A task split was then posted as usual. |
| **G.** NVDA pass over the plan issue | Not run: the machine was low on memory. |

Facts about GitHub the design relies on:
- **Labels:** a collaborator with write access can create labels, so `ensureLabel` works for anyone who may join.
- **Locked issues:** they can also comment on a locked issue, so a lock doesn't stop a session.
- **Line endings:** bodies written through the REST API come back with `\n` line endings. Whether a browser edit turns them into CRLF wasn't checked; collab normalises line endings either way.

Bug the run found, fixed with a test:
1. **`plan status` showed stale agreement.** Run right after mercuryreach's `/collab agree` comment, it still said "waiting on mercuryreach". Unlike every other read, `status` didn't apply new comment directives, so the next command did. It now applies them first, like `show` and `next`.

## End-to-end tests on CI (2026-11-27, PR #25 of `AIdevgru/collab-e2e-20261116`)

The setup was one clone pinned to `zwymer`, with the CLI from the change that added it, driven directly as two agents: `claude-zdgm` and `codex-yj4x`. CI was the sandbox's own `ci.yml`, a test job on GitHub's `ubuntu-latest` and `windows-latest`. A commit on `main` (`bbe4fe7`) gave it a `workflow_dispatch:` trigger and added `manual.yml`, a dispatch-only workflow standing in for a deploy. Each dispatched run took about 30 s. The plan had four tasks:
- T1 clamp;
- T2 sum, first with a bug, then with a test that fails only on a re-run attempt (`GITHUB_RUN_ATTEMPT` > 1);
- T3 mean, whose test waits 3 minutes on GitHub's runners only;
- T4, which changes `ci.yml` itself.

| Check | Result |
|---|---|
| `collab tests` before the switch; status line | ✅ It listed the 7 open collabs left from earlier runs, plus "New collabs here: … (the default)". `statusline -- node …` printed `usage 42% (tests local)` in 0.3 s. |
| `/collab tests remote` from this Claude session | ✅ With no workflow named, it listed `ci.yml, manual.yml` and asked. `manual.yml` was refused ("doesn't run on pull requests … run collab tests remote --workflows manual.yml in your own terminal"), and so was a missing `nope.yml`, each before anything changed. `--workflows ci.yml` switched all 8 open collabs (schema 2), then wrote `collab.tests=ci` and `collab.ciWorkflows=ci.yml`. The status line said `(tests remote)`. |
| `join` after the switch | ✅ "collab verify runs the tests on CI: it starts ci.yml on each task's branch, and a task goes to review while they run." Agents already in the collab got an inbox line. |
| `verify` dispatches; matching runs | ✅ `workflow_dispatch` on `collab/pr-25/t1` returned in 9.6 s, with no tests run on the machine. The baseline (`since`) was the sub-PR's own `pull_request` run id, so only the dispatched run, with a higher id, counted. Both ran at the same commit. |
| Overlap | ✅ T2 and T3 were submitted while CI ran, and T3 was approved while CI ran (its review comment says "Verify: CI is still running"). `next` said `wait` ("waits for green CI"), `merge` refused while CI ran, and `collab wait` returned once T3 could merge. |
| CI failure | ✅ T2's bug failed CI. Codex's `next` said `fix T2` and quoted `"ci.yml failure (https://github.com/…/actions/runs/46066439963)"`, and `submit` was refused. |
| Merge-time recheck against a real re-run | ✅ After T2 passed and was approved, its dispatched run was re-run with `gh run rerun` (attempt 2). `next` still said merge: GitHub hadn't yet attached the new attempt's checks to the commit. `merge` asked GitHub again and refused: "the ledger says CI passed … but it is running again on GitHub ("ci.yml running": someone reran it)". Once the attempt failed, `merge` recorded it ("GitHub now says "ci.yml failure (…/runs/46066589645)". Recorded that"). It refused again on retry, and `next` sent T2 back to Codex. A rerun keeps its run id, so `since` still matches it. |
| Back to the machines while CI runs | ✅ `/collab tests local` took 25 s for the 8 collabs. T3 had been approved with its CI running, so Codex's `next` said "its tests have not passed on that commit: run them", and `merge` refused. `verify` ran `npm test` in the worktree, and the slow test didn't wait off the runners. `merge` then waited: "CI on sub-PR #28 is still running, …, which collab started at this commit". A dispatched run's checks do count among the sub-PR's checks. `wait` returned when they finished, and T3 merged. |
| A task that changes a workflow | ✅ T4's push was refused as protected. T4 was blocked with `--owner`, and `decide` was refused in this Claude session ("owner-only command; run it in your own terminal"). Zach ran `decide T4 … --allow-protected` in his own terminal. With the collab on CI, `verify T4` ran `npm test` on the machine and said why ("CI on its branch would run that changed version"). It started no dispatched run; only the sub-PR's own `pull_request` run ran. The reviewer's `verify` ran on the machine too, and T4 merged. Every task done, main-PR CI passed, and the dashboard reached "Ready for owner review". |
| No ledger writes start runs; `main`; owner text | ✅ Since setup, 9 `pull_request` runs (all sub-PRs and the main PR) and 5 `workflow_dispatch` runs, none from the ledger ref. `main` is still `bbe4fe7`, and `HUMAN TEXT SENTINEL` is intact. |

Bugs the run found, fixed with tests:
1. **The fix flow ended with `submit` refusing.** T2 had been approved when its re-run failed. Codex followed `next` (fix, then push, verify, submit). The push sent T2 back to review, since the approval was for the old commit, so `submit` failed: "can't submit T2 (in_review): it must be claimed or changes_requested". A fix pushed while a task is still in review hit the same error. Now `submit` on a task already in review (or approved) at its head says so and exits 0: "T2 is already in review, now at 30d2a78; another agent reviews this commit …". Use-case test: "CI that fails after the approval".
2. **Wording:** "CI on sub-PR #28 is still running (they include ci.yml, …)" now reads "…is still running, including ci.yml, which collab started at this commit while the tests ran on CI".
3. **`review-claim` misled the reviewer of a task that changes a workflow.** For T4 it said "CI runs the tests, so you don't … You may approve while it runs". The tests of such a task run on the machine, and approving needs that pass. It now says "T4 changes a workflow (.github/workflows/ci.yml), so its tests run on this machine, not on CI: collab verify T4 …, before you approve." Covered in the use-case test "a task that changes a workflow".

Not changed (none come from this PR):
- **Duplicate push lines in the inbox.** `submit` pushes first and records `task.push` even when the commit is unchanged, so the inbox can say "pushed to T2" several times for one change. dev's `main` does the same.
- **No `--allow-protected` in the dashboard hint.** For a block about a protected file, the dashboard's "Needs attention" line says `collab decide T4 "<answer>" --pr 25` without `--allow-protected`. Only the push error names it.
- **The dashboard doesn't change after a switch.** `collab tests` doesn't re-render the dashboard, so the move shows up there at the next write.

## End-to-end parallel sessions with real Claude (2026-11-28, PR #30 of `AIdevgru/collab-e2e-20261116`)

This used the installed collab, with parallel sessions and the tests on CI in. Claude, in this session (`claude-8dmm`), planned three tasks: T1 repeat, T2 reverse, and T3 an index that depends on both. Then it ran `collab invite claude --sessions 1 --model sonnet --pr 30 --agent claude-8dmm`. Only one session was started because the machine had 2 GB of memory free. The tests ran on the agents' machines.

| Check | Result |
|---|---|
| The keeper starts as many sessions as there is work for, and leaves one task for the agent that asked | ✅ `Started 1 now: claude-2m29 (T2)`, with T1 left for `claude-8dmm`. |
| A real headless session builds, reviews and merges | ✅ `claude-2m29` (Sonnet, through the invite's tool lists) joined, claimed T2, wrote it, then ran `note`, `push`, `verify` and `submit`. About a minute later it reviewed T1 with `collab diff` and `verify`, wrote `.collab/review-pr30-t1.md` and approved it. It merged its own T2 once `claude-8dmm` approved it. |
| More work starts as tasks unlock | ✅ When T1 and T2 merged, the session claimed T3 within about 10 s, built it, and merged it after review. |
| The session and the keeper end by themselves | ✅ The session's last `next` said `done`, and it stopped without touching the main PR: 47 turns, $0.41. The keeper stopped as `done` 6 min 47 s after the invite. The session's watchdog recorded `exited` 50 s later, and `status` then said `Still running: none`. |
| Dashboard, `main`, owner text | ✅ "Ready for owner review"; `main` still `bbe4fe7`; `HUMAN TEXT SENTINEL` intact. |
| Permission denials | ⚠️ One: an `ls` of several worktree paths. The session went on with Glob. |

What the run showed:
- **Owners' own rules reach the sessions.** The session read the owner's global `CLAUDE.md`, which asks for a use-case story and test with every feature. So it added `tests/use-cases/reverse.md` (and `index.md`) with their tests, outside the task's scope. It said so with `collab note T2` before pushing, as PROTOCOL rule 5 asks, and the reviewer saw the note. No other task owned those files. collab doesn't stop such files at push; only scopes that overlap between tasks, and protected files, are checked.
- **Bug, fixed with a test: `collab status` named a session's first task.** It said `claude-2m29 (T2)` while the session was building T3, because the keeper records the task it started each session for. `status` now reads the ledger (`sessionWork` in `sessions.mjs`): the task a session builds, else the review it holds, else its task in review, else what it was started for if it hasn't taken that yet. A session whose work is all merged shows `(waits for work)`. The keeper's reason line (`the agents already free can take T3`) is from its last round, so it can lag a claim by up to 20 s.
