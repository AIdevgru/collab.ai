# Use case: talking and revising the plan together

Plan session #2 is open, and Zach and Alice have both joined with Claude.

1. **Drafting.** Alice asks her Claude to tighten the Goal section.
   - Claude runs `collab plan pull 2`, which writes revision 1 to `.collab/plans/2/draft.md` and remembers it as the base.
   - It edits the draft with Alice (in Claude Code's plan mode, if she agrees), then runs `collab plan edit 2 --summary "Sharper goal"`.
   - That makes revision 2. collab posts "📝 Revision 2 by alice's Claude (…): Sharper goal" with the diff in a `<details>` block, and the issue's plan section now shows revision 2.
2. **Talking.**
   - Alice's Claude runs `collab plan say 2 --body "…"`, which posts a comment from Alice's account labelled "🤖 alice's Claude (claude-…):".
   - A `@carol` mention for someone outside the session is put in backticks, so Carol isn't pinged.
   - A message with a line that starts with `/collab` is refused: those comments are the people's.
3. **Waiting.** Zach's Claude is running `collab plan wait 2`. It returns `read` as soon as the new revision or message lands.
   - `collab plan show 2` prints what changed since Zach last looked, the new messages (from people with write access only, marked untrusted) and who still has to agree.
   - A comment from someone with read access only is left out and counted.
   - Run again with nothing new, `show` says "No new messages".
4. **Edits to different lines merge.** Zach and Alice both pull revision 2. Alice publishes revision 3, which changes the Goal. Zach then publishes his draft, which changes Risks and is still based on revision 2.
   - collab merges the two (`git merge-file`) into revision 4 with `merged: true`, and both changes are in it.
5. **Edits to the same line conflict.** Both change the same line of Context from the same base.
   - The second `collab plan edit` exits 2 and publishes nothing.
   - collab writes `.collab/plans/2/draft.conflict.md` holding both versions between `<<<<<<<` and `>>>>>>>` lines, and prints the exact command to publish the resolved file on top of the current revision.
   - Publishing the file with the conflict lines still in it is refused. Once they're resolved, it publishes.
   - Afterwards `draft.md` holds the new revision and the conflict file is gone, so Zach's next pull or edit starts from it and can't undo what Alice published.
6. **Windows line endings** in a draft make no difference: the content hash is the same as for the LF version, so a CRLF draft that matches the current revision has "nothing to publish".
7. **Browser edits.** Someone edits the plan in the issue's description in the browser. On the next update:
   - collab leaves the edited text alone and posts one "⚠️ Warning: …edited in the browser" notice with the diff;
   - the status block warns too;
   - the ledger's revision is still the plan, and agreements stay bound to its hash;
   - the next real revision replaces the edited text.
8. **An edited revision number.** If someone edits the plan block's revision number in the description (say to 99), collab doesn't treat the block as newer than it is. It checks the session's ref, puts the current revision back, and posts one warning.
