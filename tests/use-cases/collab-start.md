# Use case: starting a collab on a PR

Zach has PR #42, "Add string helpers", open from `feat/strings`. Its description has a four-item checklist and a paragraph of his own notes. He types `/collab https://github.com/o/r/pull/42` in Claude Code.

1. Claude runs `collab join <url> --tool claude`. Nobody has started a collab on #42 yet, so collab creates the ledger on `refs/collab/pr-42`. It pins Zach's GitHub account for this clone, registers Claude as `claude-xxxx` (vendor anthropic) and gives Claude a 15-minute planning lease. The output says "You hold the planning lease" and lists the three planning steps.
2. Claude runs `collab context`. It gets the PR checklist, changed files and comments as JSON, with everything people wrote under `untrusted`.
3. Claude writes a plan with four tasks whose scopes don't overlap, and runs `collab plan --tasks .collab/plan-42.json`. collab assigns T1 to T4, switches the collab to `active` and prints:
   - the task range and the dashboard link;
   - "Any other agent can review a task; one from another vendor goes first, so add one if you can";
   - a ready-to-paste `$collab <url>` line for Codex;
   - the `collab invite codex` alternative;
   - the `collab prompt join` line for other agents.
4. The PR description now starts with the collab dashboard between `collab:dashboard` markers. Zach's checklist and notes below it are unchanged, byte for byte.
5. A 13-task plan is refused: plans are capped at 12.
6. If a second agent joins while Claude is still planning, it's told who is planning and to run `collab wait`. It does not get a second planning lease.
7. Files passed to collab (`--tasks`, `--body-file`) are found from the current folder or, failing that, from the repo root. So `collab plan --tasks .collab/plan-42.json` works even from inside `.collab/`, where a sandboxed Codex works.
