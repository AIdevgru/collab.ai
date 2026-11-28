// How long `collab wait` sleeps before it looks again, and how often that look includes GitHub.
// Pure: the caller passes the times and a random number.
//
// Two clocks. The ledger check is one small git fetch, so it runs often after a change and less
// often the longer nothing happens. Comments and CI cost GitHub API calls, so they run on a slower
// clock of their own, kept short only while CI is what the agent waits for.

export const FAST_MS = 5_000; // ledger check right after a change
export const CEILING_MS = 60_000; // ledger check once things have gone quiet
export const CI_MS = 30_000; // GitHub check while waiting on CI
export const GITHUB_MIN_MS = 60_000; // GitHub check otherwise, growing to...
export const GITHUB_MAX_MS = 180_000;
const JITTER = 0.2; // +-20%, so agents that started together don't poll together
const MIN_SLEEP_MS = 1_000;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// sinceChangeMs  time since the ledger last changed (or since the wait began)
// untilGithubMs  time until comments and CI are due to be read again, or null
// untilExpiryMs  time until the next lease runs out, or null: something may be free to take then
// soloAgent      no other agent has joined, so only the owner can change anything
export function plan({ sinceChangeMs = 0, untilGithubMs = null, untilExpiryMs = null, soloAgent = false, rand = Math.random } = {}) {
  // Half the quiet time so far: each quiet check comes 1.5 times later than the one before.
  let sleepMs = soloAgent ? CEILING_MS : clamp(sinceChangeMs / 2, FAST_MS, CEILING_MS);
  sleepMs *= 1 - JITTER + 2 * JITTER * rand();
  // End the sleep at a deadline rather than a little after it. The caller fixes the GitHub
  // deadline when it last read GitHub, so aiming at it can't fall short and loop.
  if (untilGithubMs != null && untilGithubMs > 0) sleepMs = Math.min(sleepMs, untilGithubMs);
  if (untilExpiryMs != null && untilExpiryMs > 0) sleepMs = Math.min(sleepMs, untilExpiryMs + 500);
  return { sleepMs: Math.max(MIN_SLEEP_MS, Math.round(sleepMs)) };
}

// How long after reading GitHub to read it again.
export function githubEvery({ sinceChangeMs = 0, waitingOnCi = false } = {}) {
  return waitingOnCi ? CI_MS : clamp(sinceChangeMs / 2, GITHUB_MIN_MS, GITHUB_MAX_MS);
}
