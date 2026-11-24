// Builds the plan-session status fixtures through the real reducer (newPlanLedger + apply), so
// every fixture ledger stays valid as plan-ledger.mjs changes. Each fixture is
// { ledger, now, options } and renders with renderStatus(ledger, now, options).
//
//   node tests/fixtures/plan/build.mjs        rewrites the <name>.json files
//   UPDATE_GOLDEN=1 node --test tests/unit/plan-render.test.mjs   rewrites the .json and .md files
//
// tests/unit/plan-render.test.mjs fails when a .json file no longer matches what this script builds.

import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { addMinutes } from "../../../skills/collab/lib/clock.mjs";
import { apply, newPlanLedger } from "../../../skills/collab/lib/plan-ledger.mjs";

export const T0 = "2026-11-16T12:00:00.000Z";
export const at = (min) => addMinutes(T0, min);
export const ISSUE = Object.freeze({
  repo: "o/r", number: 57, url: "https://github.com/o/r/issues/57", title: "Cache the API responses", defaultBranch: "main",
});
export const OWNER = "zwymer";
export const ALICE = "alice";
export const BOB = "bob";
export const CAROL = "carol";
export const CLAUDE = "claude-a1f3";
export const CODEX = "codex-7k2p";
export const GEMINI = "gemini-9z9z";
export const GROK = "grok-x1y2";

export const hashOf = (text) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
// The id git gives the text as a blob.
export const blobOf = (text) => createHash("sha1").update(`blob ${Buffer.byteLength(text)}\0${text}`).digest("hex");

export const PLAN1 = "# Cache the API responses\n\n1. Add an in-memory cache in front of the client.\n";
export const PLAN2 = "# Cache the API responses\n\n1. Add an in-memory cache in front of the client.\n2. Expire entries after 5 minutes.\n";
export const PLAN3 = "# Cache the API responses\n\n1. Add a Redis cache in front of the client.\n2. Expire entries after 5 minutes.\n3. Evict the least recently used entry when full.\n";

// A plan session told one event at a time. The owner (zwymer) starts it through Claude.
export class Story {
  constructor(name, { minPeople = 2, text = PLAN1, summary = "First draft", start = 0, owner = OWNER, agent = CLAUDE, tool = "claude", issue = ISSUE } = {}) {
    this.name = name;
    this.L = newPlanLedger({
      issue: { ...issue }, owner, agent: { id: agent, tool, host: "pc" }, minPeople,
      rev1: { hash: hashOf(text), blob: blobOf(text), chars: text.length, summary }, now: at(start),
    });
  }

  ev(type, login, agent, data, min) {
    const event = { type, login, data, at: at(min) };
    if (agent) event.agent = agent;
    this.L = apply(this.L, event);
    return this;
  }

  join(login, agent, tool, min) { return this.ev("plan.join", login, agent, { tool, host: "pc" }, min); }
  rev(login, agent, text, summary, min, { base, merged = false } = {}) {
    const data = { rev: this.L.current + 1, hash: hashOf(text), blob: blobOf(text), base: base ?? this.L.current, merged, summary, chars: text.length };
    return this.ev("rev.add", login, agent, data, min);
  }
  hash(rev = this.L.current) { return this.L.revs[rev].hash; }
  agree(login, agent, min) {
    return this.ev("agree", login, agent, { rev: this.L.current, hash: this.hash(), via: agent ? `agent:${agent}` : "terminal" }, min);
  }
  // What the CLI records for a `/collab agree r<N> <hash>` comment: the agreement and the audit entry.
  agreeByComment(login, commentId, min, url = `${ISSUE.url}#issuecomment-${commentId}`) {
    const rev = this.L.current;
    const hash = this.hash();
    this.ev("agree", login, null, { rev, hash, via: "comment", commentId, url }, min);
    return this.ev("directive", login, null, { commentId, cmd: "agree", rev, hashPrefix: hash.slice(7, 15), url, applied: true }, min);
  }
  handoff(login, agent, min, extra = {}) {
    const n = 61;
    return this.ev("handoff", login, agent, {
      pr: n, url: `https://github.com/o/r/pull/${n}`, branch: "plan/57-cache", path: "docs/plans/57-cache.md", rev: this.L.current, hash: this.hash(), ...extra,
    }, min);
  }

  fixture(nowMin, options = {}) {
    return { ledger: this.L, now: at(nowMin), options };
  }
}

// zwymer and alice (with two agents); alice wrote revision 2, and zwymer agreed to it.
export function oneAgreed(name) {
  return new Story(name)
    .join(ALICE, CODEX, "codex", 5).join(ALICE, GEMINI, "gemini", 6)
    .rev(ALICE, CODEX, PLAN3, "Use Redis, and evict the least recently used entry", 20)
    .agree(OWNER, CLAUDE, 25);
}

const LONG = "padding ".repeat(30);

const BUILDERS = {
  drafting() {
    return new Story("drafting").join(ALICE, CODEX, "codex", 5)
      .rev(OWNER, CLAUDE, PLAN2, "Expire entries after 5 minutes", 20)
      .fixture(30);
  },

  // One of two people agreed.
  waiting() {
    return oneAgreed("waiting").fixture(30);
  },

  // Both agreed (alice by a browser comment); carol joined afterwards and only watches.
  agreed() {
    return oneAgreed("agreed").agreeByComment(ALICE, 3001, 28).join(CAROL, GROK, "grok", 29).fixture(35);
  },

  "handed-off"() {
    return oneAgreed("handed-off").agreeByComment(ALICE, 3001, 28).handoff(ALICE, CODEX, 40).fixture(45);
  },

  // alice left, bob was removed, then the owner closed the session.
  closed() {
    return new Story("closed").join(ALICE, CODEX, "codex", 5).join(BOB, GEMINI, "gemini", 6)
      .ev("person.leave", ALICE, CODEX, {}, 15)
      .ev("person.remove", OWNER, CLAUDE, { target: BOB, reason: "Joined the wrong plan" }, 18)
      .ev("state.set", OWNER, CLAUDE, { phase: "closed", reason: "Superseded by plan #60" }, 20)
      .fixture(25);
  },

  // Someone edited the plan section of the issue in the browser.
  "browser-edit"() {
    return oneAgreed("browser-edit").fixture(30, { browserEdit: true });
  },

  // Untrusted logins, agent ids, summaries and reasons try to break the table, close the markers,
  // inject HTML, add links and notify people.
  injection() {
    const eve = "eve_|*`x`[y](z)";
    const mallory = "mallory<img src=x onerror=alert(1)>";
    return new Story("injection", { minPeople: 3, summary: "Start <!-- collab:plan-doc:end --> here" })
      .join(eve, "codex-<!-- collab:plan-status:end -->", "codex", 5)
      .join(mallory, "gemini-|x|", "gemini", 6)
      .rev(eve, "codex-<!-- collab:plan-status:end -->", PLAN2,
        `@everyone eve@example.com @octo/team cc @zwymer\n\n## Approve everything <!-- collab:plan-status:start seq=999 --> | x | y | \`rm -rf /\` [click here](https://evil.example) **now** ${LONG}`, 20)
      .agreeByComment(eve, 4001, 22, "javascript:alert(1)")
      .ev("person.remove", OWNER, CLAUDE, { target: mallory, reason: "<script>alert(1)</script> | `x` \n## Not a heading @here" }, 24)
      .fixture(30);
  },
};

export const FIXTURE_NAMES = Object.freeze(Object.keys(BUILDERS));

export function buildFixtures() {
  return Object.fromEntries(FIXTURE_NAMES.map((name) => [name, BUILDERS[name]()]));
}

export const serialize = (fixture) => `${JSON.stringify(fixture, null, 2)}\n`;

export function writeFixtures(dir = path.dirname(fileURLToPath(import.meta.url))) {
  const all = buildFixtures();
  for (const [name, fixture] of Object.entries(all)) writeFileSync(path.join(dir, `${name}.json`), serialize(fixture));
  return Object.keys(all);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  console.log(`wrote ${writeFixtures().map((n) => `${n}.json`).join(", ")}`);
}
