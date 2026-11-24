// The single next action for one agent in a plan session. Pure: the CLI passes the plan ledger,
// the agent id, the agent's local seen state ({ key, commentId } or null), the issue's state and
// how many comments arrived since the agent last read them.
//
// Order (docs/modules.md, "plan-next.mjs"), first match wins:
//   1. closed      the session or its issue is closed
//   2. join        I have not joined; removed / left: my person is out of the session
//   3. read        the plan changed (stateKey), I never read it, or there are new comments
//   4. handed-off  the build happens in a PR now
//   5. agreed      hand it off (an observer only watches)
//   6. wait        for the people who have not agreed yet, or for more people to join
//
// Agents never agree on their own: the person they act for does, so no action is "agree".

import { consensus, personOf, personStatus, stateKey } from "./plan-ledger.mjs";

const short = (hash) => String(hash ?? "?").replace(/^sha256:/, "").slice(0, 8) || "?";
const safeUrl = (u) => (typeof u === "string" && /^https:\/\/[^\s<>()[\]`"'\\]+$/.test(u) ? u : null);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
// "a", "a and b", "a, b and c"
function list(items) {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

export function planNext(ledger, me, seen, { issueState = "OPEN", newComments = 0, number } = {}) {
  const L = ledger;
  const n = String(number ?? L.issue?.number);
  const c = (sub) => ["collab", "plan", sub, n, "--agent", me];
  const say = (action, why, cmd) => ({ action, why, cmd });

  // 1. Closed, on the ledger or on GitHub.
  if (L.phase === "closed" || String(issueState).toUpperCase() === "CLOSED") {
    return say("closed", `plan #${n} is closed; stop work on it`, []);
  }

  // 2. Not in the session.
  const login = personOf(L, me);
  if (!login) return say("join", `you (${me}) have not joined plan #${n}; join first`, c("join"));
  const status = personStatus(L, login);
  if (status === "removed") {
    const by = L.people[login].removed?.by;
    return say("removed", `${login} was removed from plan #${n}${by ? ` by ${by}` : ""}; stop work on it`, []);
  }
  // The person chose to leave: rejoining for them would undo that, so the agent stops instead.
  if (status === "left") {
    return say("left", `${login} left plan #${n}; stop work on it (run collab plan join ${n} only if ${login} asks to take part again)`, []);
  }

  // 3. Something changed since I last read the plan.
  const key = stateKey(L);
  const comments = Number(newComments) > 0 ? Number(newComments) : 0;
  if (!seen || seen.key !== key || comments > 0) {
    const what = [];
    if (!seen) what.push(`you have not read plan #${n} yet`);
    else if (seen.key !== key) what.push(`plan #${n} changed since you last read it (revision ${L.current}, ${L.phase})`);
    if (comments > 0) what.push(`${plural(comments, "new comment", "new comments")} on plan #${n}`);
    return say("read", `${what.join("; ")}: read it`, c("show"));
  }

  const cur = L.revs?.[String(L.current)];

  // 4. Handed off: the build PR is where the work goes on.
  if (L.phase === "handed-off") {
    const h = L.handoff ?? {};
    const pr = Number(h.pr) ? `PR #${Number(h.pr)}` : "a build PR";
    const url = safeUrl(h.url);
    return say("handed-off", `plan #${n} was handed off to ${pr}${url ? ` (${url})` : ""}; the build happens there, so stop work on the plan`, []);
  }

  // 5. Agreed: hand it off. Someone who joined after the agreement only watches.
  if (L.phase === "agreed") {
    if (status !== "active") {
      return say("wait", `everyone agreed to revision ${L.current} of plan #${n}; ${login} joined after that and only watches until the owner reopens it`, c("wait"));
    }
    return say("agreed", `everyone agreed to revision ${L.current} (${short(cur?.hash)}) of plan #${n}: hand it off to a build PR`, c("handoff"));
  }

  // 6. Drafting: wait for the others (or tell my person it's their turn).
  return say("wait", waitWhy(L, login, n, cur), c("wait"));
}

function waitWhy(L, login, n, cur) {
  const cs = consensus(L);
  const parts = [];
  if (cs.waitingOn.length) {
    const names = cs.waitingOn.map((l) => (l === login ? `${l} (the person you act for)` : l));
    let part = `waiting for ${list(names)} to agree to revision ${L.current} (${short(cur?.hash)}) of plan #${n}`;
    if (cs.waitingOn.includes(login)) part += `; show ${login} the plan and ask them; run collab plan agree only after they say yes to this revision`;
    parts.push(part);
  } else {
    parts.push(`everyone in plan #${n} so far agreed to revision ${L.current} (${short(cur?.hash)})`);
  }
  if (cs.needMore > 0) {
    const min = Number(L.minPeople) || 2;
    parts.push(`${plural(cs.needMore, "more person", "more people")} must join (it needs at least ${plural(min, "person", "people")})`);
  }
  return parts.join("; ");
}
