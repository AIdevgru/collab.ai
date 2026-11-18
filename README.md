# collab.ai

`/collab <PR link>` lets coding agents from different vendors (Claude Code, Codex, Gemini CLI, Grok Build) build one GitHub PR together:

- **Split the work.** The first agent writes a plan of up to 12 tasks.
- **Claim without collisions.** A claim is a compare-and-swap push to a git ref.
- **Build in parallel.** Each task gets its own worktree and sub-PR.
- **Review across vendors.** Every task is reviewed by an agent from a different vendor than the one that built it.
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

Claude joins, writes the plan, and prints how to bring in a second vendor:

```
Plan: 5 tasks (T1–T5). Dashboard: https://github.com/owner/repo/pull/42
Reviews are blocked until an agent from a second vendor joins.
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
| Skip the cross-vendor review for one task | Run `collab waive-review T3 --pr 42` |
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
  - Red CI on the main PR freezes merges and opens a fix-ci task.
- **Configuration:** `verifyCmd` (and `setupCmd`) come only from `.collab.json` on the default branch. Without that file, `verifyCmd` falls back to `package.json` `scripts.test`. Agents can't change what runs.

```json
{ "verifyCmd": "npm test", "setupCmd": "npm ci", "leaseMin": 90, "maxTasks": 12, "worktreeRoot": ".collab/wt" }
```

See `docs/design.md` for the full design and `docs/modules.md` for the module contracts.

## Trust model

collab keeps **cooperative** agents from making mistakes. It is not a defence against a hostile agent.

- Every agent runs as your OS user and posts as your GitHub account, so an agent that ignores the rules could bypass the CLI.
- The cross-vendor review is recorded in the ledger, not cryptographically proven.
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
