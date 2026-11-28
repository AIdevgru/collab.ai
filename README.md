# collab.ai

`/collab <PR link>` lets coding agents from different vendors (Claude Code, Codex, Gemini CLI, Grok Build) build one GitHub PR together:

- **Split the work.** The first agent writes a plan of up to 12 tasks.
- **Claim without collisions.** A claim is a compare-and-swap push to a git ref.
- **Build in parallel.** Each task gets its own worktree and sub-PR.
- **Review each other.** Any agent but a task's builder can review it. An agent from another vendor goes first, and one of the same vendor steps in when none is around or after 10 minutes, so work keeps moving.
- **Show a live dashboard.** Status, blockers and stats appear at the top of the PR for stakeholders.

GitHub (git, `gh` and the PR thread) is the only channel between agents. There is no server, Slack or Discord.

## Install

You need Node 22+, git, and the GitHub CLI signed in (`gh auth login`).

```sh
git clone https://github.com/AIdevgru/collab.ai && node collab.ai/scripts/install.mjs && node "$HOME/.collab/bin/collab.mjs" doctor
```

This works in bash, zsh, Git Bash and PowerShell 7. In Windows PowerShell 5.1, replace each `&&` with `;`. Keep the `collab.ai` folder: the skill is linked to it. Add `--copy` to the install step where links aren't followed, or `--uninstall` to remove it.

The installer:
- links the skill into `~/.claude/skills/collab`, and into `~/.codex/skills/collab` when Codex is installed;
- writes the launcher `~/.collab/bin/collab.mjs`, which every agent runs, plus `collab` / `collab.cmd` shims for you;
- records everything in `~/.collab/install.json`.

To type plain `collab`, add `~/.collab/bin` to your PATH.

## Use it

In Claude Code, inside a clone of the repo:

```
/collab https://github.com/owner/repo/pull/42
```

Claude joins, writes the plan, and prints how to bring in another vendor:

```
Plan: 5 tasks (T1–T5). Dashboard: https://github.com/owner/repo/pull/42
Any other agent can review a task; one from another vendor goes first, so add one if you can.
To add Codex, paste into Codex:   $collab https://github.com/owner/repo/pull/42
Or run: collab invite codex --pr 42       (launches it headless now)
Other agents (Gemini, Grok…): run `collab prompt join 42 --tool <name>` and paste its output.
```

From then on every agent loops on `collab next`, which names the one thing to do next: fix, merge, review, claim, or wait. When everything is merged into the PR branch, the dashboard turns 🔵 Ready for owner review. **You merge the main PR. collab never does.**

### Steering it

| You want to | Do this |
|---|---|
| Pause every agent | Comment `/collab pause` on the PR, from an account with write access |
| Cancel a task | Comment `/collab cancel T3` |
| Resume | Run `collab resume --pr 42` in your own terminal |
| Answer a question an agent escalated | Run `collab decide T3 "use TTL" --pr 42` |
| Skip the review for one task | Run `collab waive-review T3 --pr 42` |
| Run several Claude sessions in parallel | `/collab <PR link> --sessions 4`, or run `collab invite claude --sessions 4 --pr 42` (see [Parallel sessions](#parallel-sessions)) |
| Stop invited agents | Run `collab stop --pr 42` |
| End the collab | Run `collab close --pr 42`. It archives the ledger to `~/.collab/archive/` and stops agents still in their loop. `--purge` also deletes the ledger ref |

PR comments can only stop work, never authorize it. The owner commands in the table refuse to run inside an agent session.

### Inviting agents (opt-in)

`collab invite codex|claude --pr 42 [--task T2|--review T2] [--timeout 2h] [--model m]` launches a headless agent with a fresh id.

- **Codex** runs under its default `workspace-write` sandbox, rooted at `.collab/`. It reaches git and GitHub only through a relay pinned to its id, which runs allowlisted `collab` commands.
- **Claude** runs `claude -p` with only the collab launcher, read-only git and file tools allowed. It can't push, commit, merge or call `gh api` itself. Within the trust model below this is a guard against mistakes, not a sandbox.
- **`--task T`** reserves T for the invited agent until its timeout, so no other agent claims it first.
- **Starting a collab:** on a PR with no collab yet, an invited agent (without `--task` or `--review`) starts one and writes the plan.
- **Timeout:** each invite stops itself at its timeout, or as soon as the agent exits. Its tasks then become free to reclaim at once.
- **Model:** if Codex fails with "model is not supported" on your account, pass `--model` (for example `--model gpt-5.6-sol`). `collab doctor` shows Codex's default model.

To join an interactive Codex yourself, paste `$collab <PR link>`. Its sandbox can't run git or gh, so start a relay first with `collab relay` in a terminal in the repo.

### Parallel sessions

To build faster with several sessions of one agent, ask for them in Claude Code:

```
/collab https://github.com/owner/repo/pull/42 --sessions 4
```

Claude is one of the four. After it writes the plan, it runs `collab invite claude --sessions 3 --pr 42 --agent <its id>`. You can run the same from your own terminal, without `--agent`, at any time.

- **As many as there is work for.** A session keeper starts only as many headless sessions as there are tasks they can take now, at most N, and reserves one task for each. A task whose dependencies aren't done, or whose scope overlaps work in flight, doesn't start a session. With `--agent`, one task is always left for that agent while it is free.
- **More as work unlocks.** About every 20 seconds the keeper checks again. As tasks unlock it starts more sessions, up to N at once. When a session stops mid-task, a new one takes over its task with `claim --steal`, keeping the branch and commits.
- **Limits.** N is capped at `maxTasks` (12), and one keeper runs per PR. If two sessions in a row stop without doing any work (say the agent isn't signed in), the keeper stops starting them, and `collab status` says why.
- **Status and stopping.** `collab status --pr 42` lists the running sessions and their tasks. The keeper exits by itself when every task is done or cancelled, when the collab is closed (`collab close` stops it), or at its `--timeout` (2 h). `collab stop --pr 42` stops the keeper first, then every session. `collab stop --run <keeper id> --pr 42` stops only the keeper, and its sessions finish their tasks.
- **Reviews.** The sessions review each other's tasks, and when a task waits for a review that no free agent may take, the keeper starts a session to review it. An agent from another vendor still reviews first when one is around, so inviting Codex too (`collab invite codex --pr 42`) adds a second view. `--sessions` works for `codex` too: each Codex session gets its own relay.

## Plan together

Before anything is built, people can agree on what to build. Each person uses their own GitHub account and their own agent, on their own machine.

```
/collab plan Add SSO login for enterprise customers
```

That opens a GitHub issue labelled `collab-plan`: the plan is in its description, and its comments are the conversation. collab prints the line the others use to join:

```
You are claude-x9k2 (Claude Code) for zwymer. Plan session #57 is open: https://github.com/owner/repo/issues/57
Share this with the people who should agree:
  Claude Code:  /collab plan 57
  Codex:        $collab plan 57
  Other agents: collab prompt plan 57   (prints a prompt to paste)
```

`/collab plan` on its own lists the open sessions to pick from.

- **Revising:**
  - Each agent pulls the current revision into `.collab/plans/<n>/draft.md` and shapes it with its human. In Claude Code that can be a round in native plan mode.
  - The agent publishes it with `collab plan edit`. Edits to different lines from different people merge; overlapping ones come back as a conflict file to resolve together.
  - Every revision posts a comment with its diff, so everyone is notified.
- **Talking:** agents post messages labelled with whose agent they are, and people simply comment on the issue.
- **Agreeing:**
  - The plan is agreed once every person who joined (at least two, or `--people N`) agrees to the same revision.
  - Each agreement comes from that person's own account, either through their agent after they say yes, or with a comment like `/collab agree r3 1a2b3c4d`.
  - A new revision resets every agreement. Agents can draft and argue, but only people agree.
- **Building:** once the plan is agreed it is frozen. `collab plan handoff 57` opens a draft PR that holds it in `docs/plans/57-<slug>.md`, and `/collab <that PR>` builds it: its planner splits the agreed plan into tasks.

| You want to | Do this |
|---|---|
| Withdraw your agreement, or leave | Comment `/collab withdraw` or `/collab leave`, or ask your agent |
| Change an agreed plan | The owner runs `collab plan reopen 57` in their own terminal. Everyone agrees again |
| Stop counting someone who went quiet | The owner runs `collab plan remove 57 <login>` |
| End the session | The owner runs `collab plan close 57` |

Joining needs write access to the repository, and plan sessions need Git 2.43 or newer, which `collab doctor` checks. State and every revision live on `refs/collab/plan-<n>`; see `skills/collab/PLAN.md` for what agents do.

## How it works

- **Ledger:** the shared state is one `ledger.json` on the custom ref `refs/collab/pr-<n>`. That ref triggers no Actions and never shows up in the PR diff.
  - Every change is a commit whose parent is the previous ledger, pushed with `--force-with-lease`, which makes it a compare-and-swap.
  - The commit chain doubles as the event log.
- **Account pinning:** every `gh` and `git` call uses the token of the GitHub account pinned for this clone (`git config collab.login`). If another session switches gh's active account, collab is unaffected, and it never runs `gh auth switch`.
- **Tasks:**
  - Each task gets a worktree under `.collab/wt/` on `collab/pr-<n>/t<k>`, and a sub-PR into the main PR's head branch.
  - `.collab/` is added to the clone's `info/exclude`, not to `.gitignore`.
  - **Note:** tools that scan the whole checkout (Jest, tsc, ESLint, file watchers) may also see the worktrees under `.collab/wt/`. To move them, set `worktreeRoot` in `.collab.json` on the default branch.
- **Merges:**
  - Approvals are tied to the reviewed commit, and merges send that SHA, so a later push cancels the approval.
  - collab merges only sub-PRs into the PR branch, never into the default branch.
  - A sub-PR with no CI checks needs a passing `collab verify` at that commit.
  - With the tests on CI (below), a merge needs CI passed at the approved commit, and collab asks GitHub again before merging.
  - Red CI on the main PR freezes merges and opens a fix-ci task.
- **Configuration:** `verifyCmd` (and `setupCmd`) come only from `.collab.json` on the default branch. Without that file, `verifyCmd` falls back to `package.json` `scripts.test`. Agents can't change what runs.

```json
{ "verifyCmd": "npm test", "setupCmd": "npm ci", "leaseMin": 90, "reviewWaitMin": 10, "maxTasks": 12, "worktreeRoot": ".collab/wt" }
```

- **Tests on CI:** if the suite is slow on the agents' machines and fast on your CI runners, let CI run it:

  ```json
  { "verify": "ci", "ciWorkflows": ["ci.yml"] }
  ```

  - `collab verify T3` then starts `ci.yml` on T3's branch with `workflow_dispatch` and returns at once, so it works for draft sub-PRs and for CI that only runs for PRs into `main`. Each listed workflow needs a `workflow_dispatch:` trigger on the default branch; `collab join` warns about one that lacks it.
  - The task goes to review while CI runs: the reviewer reads the diff and runs no tests, and may approve meanwhile. The merge waits for CI to pass.
  - If CI fails, `collab next` sends the task back to its owner with the failing workflow and its link. `collab verify T3` at the same commit runs CI again, for a flaky run.
  - A task that changes a workflow is tested on the machine instead, since CI on its branch would run that changed version.
  - Your runners become the limit: with several sessions, runs queue there. `collab status` has a CI column. A run still waiting for a runner after an hour counts as failed.
  - CI runs the agents' code on your runners, with whatever secrets the listed workflows give their jobs (a local verify strips secret-looking variables). List workflows that only run tests.

- **Switching where the tests run:** `/collab tests` in Claude Code (or `collab tests` in a terminal) shows where they run. `/collab tests remote` moves them to CI, asking which workflows if the repo doesn't say (`--workflows ci.yml`). `/collab tests local` moves them back to the agents' machines. The switch is yours: it applies to your open collabs on the repo (those of this clone's GitHub account; other people's are left alone) and to the ones started here later (kept in this clone's git config), and what already passed stands. A task approved while its CI ran gets its tests run on the machine after a move back, before it merges. Sessions started for one agent can read it but not change it. From an agent's session, `/collab tests remote` only names workflows that run on pull requests or that `.collab.json` lists; naming another one (a deploy, say) takes your own terminal. Update every agent's collab before you move a collab to CI: an older collab can't write to it, but it could still merge a task its ledger shows approved.
- **Status line:** `collab statusline` adds `(tests local)` or `(tests remote)` for the repo a Claude Code session is in. It reads only the clone's git data, never GitHub. Put your current status line command after `--`, and the segment goes at the end of its line (on Windows, anything but `node` runs through `cmd.exe`, so npm-installed status lines work). In `~/.claude/settings.json`:

  ```json
  "statusLine": { "type": "command", "command": "node \"$HOME/.collab/bin/collab.mjs\" statusline -- <your current status line command>" }
  ```

See `docs/design.md` for the full design and `docs/modules.md` for the module contracts.

## Trust model

collab keeps **cooperative** agents from making mistakes. It is not a defence against a hostile agent.

- Every agent runs as your OS user and posts as your GitHub account, so an agent that ignores the rules could bypass the CLI.
- Who reviewed a task is recorded in the ledger, not cryptographically proven.
- Within those limits, PR text, comments and other agents' output are treated as untrusted data, and the commands that run code come from the default branch only.

Protect your default branch: `collab join` warns when it isn't protected.

## Claude Code permissions

In interactive sessions Claude asks before running commands. To let `/collab` run without prompts, add this to `.claude/settings.json` or `~/.claude/settings.json`:

```json
{ "permissions": { "allow": ["Bash(node \"$HOME/.collab/bin/collab.mjs\":*)"] } }
```

## Development

```sh
node --test "tests/**/*.test.mjs"
```

- Unit tests live in `tests/unit/`.
- Each use-case story in `tests/use-cases/<name>.md` has a matching `<name>.md.test.mjs`. These drive the real CLI against a bare git remote and a fake `gh` (`tests/helpers/`).
- CI runs on Ubuntu and Windows with Node 22 and 24.

The package has zero runtime dependencies.

## License

MIT. See `LICENSE`.
