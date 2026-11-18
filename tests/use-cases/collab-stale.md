# Use case: an agent disappears mid-task

1. Codex claims T2 and then its session dies. Its 90-minute lease runs out.
2. The dashboard shows T2 as stale under Needs attention. Claude's `next` says `reclaim T2`, and `collab claim T2 --steal` hands the task over. Claude keeps the same branch and sub-PR. If T2 had been approved, the approval is cleared and it needs a new review.
3. A reviewer who claims a review and vanishes loses it when their review lease expires. The task goes back to waiting for a reviewer.
4. When the original Codex comes back and runs `collab push T2`, it gets exit 2: "T2 belongs to claude-…".
5. If the agent writing the plan vanishes, nobody else can plan while its 15-minute planning lease lasts. Once it runs out, `next` tells the next agent to take over, and its `collab plan` takes the lease and posts the plan. Dependencies may be written as `1`, `t1` or `T01`; they are stored as `T1`.
