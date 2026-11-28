# Use case: CI runs fast where agents wait on it, and in full before main

1. Zach runs `/collab <PR> --sessions 4` on a PR into `main`. Four Claude sessions and a Codex each push draft sub-PRs into the PR branch.
2. Each sub-PR's CI runs on Linux only, on node 22 and 24, with the suite split into 3 shards. The slowest shard takes about 3 minutes, not the 6 a single Linux job took. Sub-PRs no longer start Windows jobs, which took about 19 minutes and count double against a private repo's minutes.
3. With CI verify on (`"verify": "ci"`), `collab verify` dispatches the workflow on the task branch. That run is the same Linux tier.
4. Each merged task moves the main PR's head. The main PR targets `main`, so its CI runs the full matrix: Linux and Windows, node 22 and 24, 3 shards each. The slowest Windows shard takes about 7 minutes. Zach merges the main PR only after that is green, so a Windows-only break is caught there, as a red main PR CI and a fix-ci task.
5. Pushes to `main` run the full matrix too. To run Windows on another branch, Zach dispatches CI with "full" checked.
6. A stacked PR into another feature branch gets the Linux tier, like a sub-PR, until it is retargeted to `main`.
7. When someone adds a shard, the job name, the shard list and `--test-shard` must agree. The test command in CI must stay the one `npm test` runs, and the lowest node in the matrix must be the one `engines` names. The tests check all three.
