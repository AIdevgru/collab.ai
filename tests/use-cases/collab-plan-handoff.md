# Use case: handing the agreed plan to a build PR

Plan session #2 ("Add SSO login") is agreed at revision 2 by Zach and Alice.

1. Zach's Claude runs `collab plan handoff 2`. collab:
   - checks that GitHub has an agreement comment for revision 2 from every person in the session, either collab's `collab:plan-agree` comment or the person's own `/collab agree r2 <hash>`;
   - builds a commit on top of `origin/main` with git plumbing, adding `docs/plans/2-add-sso-login.md` with the agreed text byte for byte (its hash equals the agreed hash), and pushes it to the branch `collab/plan-2-build`. That name can't be confused with the session's own ref `refs/collab/plan-2`. Zach's checkout, index and HEAD are untouched.
   - opens draft PR #3, "Build: Add SSO login", into `main`. Its body holds a `collab:plan-source issue=2 rev=2 sha256=…` marker, says who agreed, and ends with "Closes #2".
   - records the handoff in the plan ledger (phase `handed-off`), posts one "🚀 Handed off" notice on the issue, and prints the PR link with `/collab <PR link>` to build it.
2. Running `collab plan handoff 2` again prints the same PR and changes nothing.
3. Handing off before everyone agreed is refused (exit 2), and says who it is waiting on.
4. If a person's agreement is in the ledger but GitHub has no matching comment from them (say, the ledger was edited by hand), handoff is refused and names them.
5. Zach runs `/collab <PR #3 link>`:
   - `collab join 3` and `collab context` return `planSource` (issue 2, revision 2, the hash, who agreed, the file path, and whether the branch's copy has changed since);
   - the agreed text comes from the plan's own ref, under `untrusted.plan`;
   - the planner splits that plan into tasks.
6. A PR whose body copies the `collab:plan-source` marker but that the plan's ledger doesn't name gets `planSource: null` and a warning, so a forged marker can't push a plan in front of the planner.
7. **A prepared branch.** If `collab/plan-<n>-build` already exists with more on it than the agreed plan (say, extra code), handoff refuses it and changes nothing. It reuses an existing branch only when that is one commit on the default branch adding just the plan file, and it adopts an open PR from it only if that PR targets the default branch.
