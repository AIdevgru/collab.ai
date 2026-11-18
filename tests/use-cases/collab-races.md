# Use case: agents racing for the same thing

1. Claude and Codex both run `collab join 7` on a PR with no collab yet, at the same moment. The ledger ref is created with an empty-expect `--force-with-lease`, so exactly one push wins. The winner plans. The loser's retry sees the new ledger and joins as a worker. There is exactly one planner.
2. Four agents run `collab claim T1` at the same time. Each claim is a compare-and-swap push of the ledger ref, so exactly one succeeds. The others get exit 2 ("T1 is claimed by …") and `next` offers them something else.
3. The ledger ref's history stays a straight line: every commit's parent is the previous ledger, and no update is lost.
