// One racer for the store concurrency test:
//   node race-worker.mjs <clone> <agent> <rounds> <pr>
// Each round increments ledger.counter and appends the agent to ledger.log.
// Prints one JSON line { agent, rounds, attempts } and exits 0, or prints the error and exits 1.

import { iso } from "../../skills/collab/lib/clock.mjs";
import { write } from "../../skills/collab/lib/store.mjs";

const [cwd, agent, roundsArg, prArg] = process.argv.slice(2);
const rounds = Number(roundsArg);
const pr = Number(prArg);
let attempts = 0;

try {
  for (let i = 0; i < rounds; i++) {
    write({
      cwd,
      pr,
      agent,
      maxTries: 1000, // this test is about lost updates, not about giving up
      mutate(current) {
        attempts += 1;
        if (!current) throw new Error("the test creates the ledger before the racers start");
        const ledger = { seq: current.seq + 1, counter: current.counter + 1, log: [...current.log, agent] };
        return { ledger, events: [{ v: 1, seq: ledger.seq, at: iso(), agent, type: "test.inc", data: { round: i } }] };
      },
    });
  }
  process.stdout.write(`${JSON.stringify({ agent, rounds, attempts })}\n`);
} catch (e) {
  process.stderr.write(`${agent}: ${e.stack ?? e}\n${JSON.stringify(e.details ?? {})}\n`);
  process.exit(1);
}
