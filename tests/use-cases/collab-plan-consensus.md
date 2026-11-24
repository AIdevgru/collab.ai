# Use case: everyone agrees

Plan session #2 has two people, Zach and Alice, and the plan is at revision 2.

1. **Agreeing through an agent.** Zach tells his Claude "yes, I agree to revision 2".
   - Claude runs `collab plan agree 2 --rev 2`.
   - collab records the agreement, bound to revision 2's content hash, with `via: agent:<id>`.
   - It posts "✅ Agrees: zwymer agrees to revision 2 (…)" from Zach's account, with a `collab:plan-agree` marker.
   - The status block shows Zach as agreed and the session as waiting on Alice.
2. **Stale agreements are refused.** Agreeing to revision 1 while revision 2 is current exits 2, naming the current revision.
3. **Agreeing in the browser.** Alice comments `/collab agree r2 <first 8 characters of the hash>`, the line the status block shows.
   - The next collab command from anyone applies it: Alice agrees `via: comment`, and the comment itself is the record.
   - Everyone has now agreed, so the session becomes `agreed` and one "✅ Agreed: everyone agreed to revision 2" notice goes out.
4. **Comments that don't count** are recorded as directives with `applied: false`, and change nothing:
   - a `/collab agree` from someone with read access, or from someone who never joined;
   - one naming the wrong revision, or the wrong hash;
   - an agent's `plan say` message that quotes `/collab agree …`.
5. **A new revision resets every agreement.** Before Alice agreed, Zach published revision 3, so his agreement to revision 2 was cleared and the session waited on both of them again.
6. **Frozen when agreed.**
   - While the session is `agreed`, `collab plan edit` and `collab plan agree` are refused.
   - The owner, in their own terminal, runs `collab plan reopen 2`. That clears the agreements, and the plan can change again.
   - `reopen` is refused inside an agent session.
7. **Minimum number of people.** A session created with `--people 2` isn't agreed when only its owner has joined and agreed. With `--people 1` it is, so one person planning with their agents can finish.
8. **`next` and `wait`:**
   - while others still have to agree, they say `wait` and name who;
   - after agreement they say `agreed` and suggest `collab plan handoff 2`.
