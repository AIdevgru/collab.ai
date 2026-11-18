# Use case: stakeholders read the dashboard

Dana, a stakeholder, opens PR #42 and sees the dashboard at the top of the description.

1. The headline reads, for example, `## Agent collaboration: 🟡 At risk (as of 2026-11-16 16:02 UTC)`. Under it: "Next update expected by …", the earliest live lease expiry, or "No agent is working right now."
2. The status is the first match of:
   1. Planning, Paused, Closed or Merged;
   2. 🔵 Ready for owner review;
   3. 🔴 Blocked;
   4. ⚪ No active agents (only when work remains and no lease is live);
   5. 🟡 At risk;
   6. 🟢 On track.

   Ready and Blocked always win over No active agents.
3. A summary sentence comes next ("5 of 8 tasks done (62%) …"). Then **Needs attention** lists what's needed and who acts, then the Tasks table and the Agents table. Recent activity is collapsed in `<details>`.
4. Every emoji is followed by a word. Tables have real headers with no emoji in them. Times are absolute UTC. There's no block-character progress bar. A lint test checks all of this.
5. When everything is merged and CI is green, the block collapses to one line linking to a final-report comment that holds the full dashboard, so a squash merge never copies the dashboard into main's history. If a new push or red CI follows, the block expands again. The next Ready edits the same report comment instead of posting a new one.
6. The dashboard is rewritten only when it changed. A render with an older seq never overwrites a newer one. If the description can't be edited, the dashboard moves to a sticky comment. `mergeable: UNKNOWN` never counts as Ready.
7. Merging the last sub-PR starts CI on the main PR. While that CI runs, `collab next` tells agents to `wait` rather than stop, so the last agent waiting re-renders the dashboard once CI finishes and the block collapses at Ready. Without that, the final dashboard would be stuck showing the state from before CI finished.
8. A merge freeze turns the status to Blocked once it has lasted over an hour. When the fix-ci task was withdrawn and later reopened, the hour counts from the reopening. A claim-overlap warning names whoever holds the overlapped task now.
