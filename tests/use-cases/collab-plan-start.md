# Use case: starting a plan session and joining one

Zach wants to settle how SSO login should work before anyone builds it. Alice and Bob have to agree too. In Claude Code, inside his clone of `o/r`, he types `/collab plan Add SSO login for enterprise customers`.

1. Claude runs `collab plan new --title "Add SSO login for enterprise customers" --tool claude`. collab then:
   - checks that Zach (`zwymer`) has write access;
   - makes sure the `collab-plan` label exists, and opens issue #2 titled "Plan: Add SSO login for enterprise customers" with that label. Issues and PRs share one number counter, and PR #1 already exists.
   - writes the session ledger on `refs/collab/plan-2`. Its tree holds `ledger.json`, `plan.md` and `r1.md`. Revision 1 is the skeleton from `templates/plan-doc.md`, with Zach's request under "Request".
   - writes the issue body: a status block (`collab:plan-status` markers) above the plan itself (`collab:plan-doc` markers).
   - prints Zach's agent id, the issue link and the share lines: `/collab plan 2` for Claude Code, `$collab plan 2` for Codex, and `collab prompt plan 2` for other agents.
2. With `--body-file`, revision 1 is the text Zach already drafted (say, a native `/plan` file copied into `.collab/`) instead of the skeleton.
3. collab refuses three kinds of plan text, and creates no issue for them:
   - text over 50,000 characters;
   - text containing `<!-- collab:`, collab's own marker;
   - text that is empty.
   - a file outside the repo's `.collab/` folder, such as `test/ok.test.mjs`: plan files are published to GitHub, so collab reads them only from there.
4. Alice runs `/collab plan` in her own clone, pinned to her account `alice`. Claude runs `collab plan list`, which finds #2 through its ref and the `collab-plan` label and lists its revision and who it's waiting on. Alice picks it, and Claude runs `collab plan join 2 --tool claude`.
   - collab checks that `alice` has write access, registers her as a person with her agent, and posts "👋 Joined: alice joined…" from **her** account. That comment subscribes her to the issue.
   - The output names her agent id and says who the plan is waiting on.
5. Bob has only read access. His `collab plan join 2` is refused with exit 5 and a message telling him to ask for write access or comment on the issue instead.
6. An agent can't act for someone else: Zach's agent id run from Alice's clone is refused, because that agent belongs to `zwymer`.
7. `#1` is a pull request, so `collab plan join 1` is refused and points to `collab join 1`.
8. The PR collab's own planner command still works: `collab plan --tasks .collab/plan.json` on PR #1 posts the task split as before.
9. Alice's agent is also in a PR collab, and its file under `COLLAB_HOME` keeps how far it has read that PR's inbox. When the agent joins the plan session again, collab adds the session to that file and keeps everything else in it, so the inbox doesn't show old items as new.
