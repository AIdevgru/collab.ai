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

