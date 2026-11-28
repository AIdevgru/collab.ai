# Use case: a second vendor joins and claims work

Codex joins PR #42 after Claude posted the plan. T1 has no dependencies, and T3 depends on T1.

1. Codex runs `collab join 42 --tool codex` and gets the id `codex-xxxx` (vendor openai). The ledger records it, and the `~/.collab/agents/<id>.json` note is written best-effort.
2. `collab next` says `claim T1`. Codex runs `collab claim T1`. collab creates the worktree `.collab/wt/pr42-t1` on branch `collab/pr-42/t1` inside the repo, adds `.collab/` to the repo's exclude file, and prints the acceptance criteria.
3. While Codex holds T1, it can't claim T2 (WIP limit 1), and nobody can claim T3 until T1 is done. If T1 is cancelled instead, T3 stops waiting on it and becomes claimable; `claim T3` notes that T1 was cancelled.
4. Claude tries to claim T4, whose scope `src/a.mjs` overlaps T1's scope. collab refuses and names the overlapping files, unless Claude passes `--allow-overlap`. The ledger then records what overlapped, and the dashboard warns about it while both T4 and the task it overlaps are in flight.
5. `next` expands scope globs against the files at the PR head, just as `claim` does. When Gemini holds T5 (`**/*.txt`), `next` never offers Grok T6 (`src/x.*`): both cover `src/x.txt`, and `claim T6` would be refused.
6. Running `collab join` outside a clone of the PR's repo fails with exit 5 and says which folder to use.
7. Of the tasks an agent may claim, `next` offers first the one that the most work waits on: a task's weight is its size (S 1, M 2, L 3), plus the heaviest chain of unfinished tasks waiting on it. So with Docs (T1), Core (T2) and an L task that needs Core (T3), `next` says `claim T2`, though T1 comes first by id. Equal weights go by id, and a fix-ci task or a task reserved for the agent still comes first. The session keeper hands out tasks in the same order.
8. `next` keeps to finish-before-start: fix my task, merge my approved task, review someone else's, claim, reclaim a stale task, then wait.
