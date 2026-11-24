# Use case: people come and go

Plan session #2 has Zach (the owner), Alice and Bob. Bob went quiet.

1. **Leaving.**
   - Alice decides she doesn't need a say and runs `collab plan leave 2`. She no longer counts toward agreement, and her agreement, if any, is dropped.
   - The owner can't leave; he closes the session instead.
   - While she's out, her agent's `collab plan say` is refused (exit 4).
   - Running `collab plan join 2` again brings Alice back.
2. **Removing someone who never comes back.**
   - Zach, in his own terminal, runs `collab plan remove 2 bob`, and Bob is removed.
   - If everyone else has already agreed to the current revision, that completes agreement.
   - Bob's own `collab plan join 2` is refused afterwards.
3. **Owner commands are the owner's:**
   - `remove`, `close` and `reopen` are refused inside an agent session, because the agent environment is detected;
   - they are refused through the relay a sandboxed Codex uses;
   - they are refused from another person's clone, unless that person is a repo admin.
4. **Closing.**
   - `collab plan close 2` marks the session closed, posts a closing comment and closes the issue.
   - Agents' `collab plan next` and `wait` then return `closed` with exit 4, and `edit` and `say` are refused with exit 4.
5. **Closed in the browser.** If someone closes the issue on GitHub instead, agents' `next` returns `closed` (exit 4), even though the ledger still says drafting.
6. **The label is only a hint.** If someone removes the `collab-plan` label from the issue, `collab plan list` still finds the session through its ref.
7. **Closed sessions** don't appear in `collab plan list` unless you pass `--all`.
8. **An admin steps in.** Carol, a repo admin who never joined, closes a session from her own terminal; she doesn't have to join first.
