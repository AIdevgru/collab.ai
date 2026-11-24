// The plan-session reducer (docs/modules.md, "Plan sessions"). Pure: no I/O, no clock.
//
// A plan session is a GitHub issue plus this ledger on refs/collab/plan-<n>. People (GitHub
// logins), each with one or more agents, revise one shared Markdown plan. It is agreed when every
// active person agrees to the same revision (number and sha256 content hash) and at least
// minPeople people take part. After that it is frozen until the owner reopens it or it is handed
// off to a build PR. Every shared-state change is an event applied here.

import { createHash } from "node:crypto";
import { CollabError, EXIT } from "./errors.mjs";
import { vendorOf } from "./ledger.mjs";

export const SCHEMA = 1;
export const PHASES = Object.freeze(["drafting", "agreed", "handed-off", "closed"]);
export const MAX_CHARS = 50_000;

// Agreed and handed-off plans are frozen: the text and the agreements can't change.
const FROZEN = new Set(["agreed", "handed-off"]);
const FROZEN_REFUSED = new Set(["rev.add", "agree", "agree.withdraw", "person.leave", "person.remove"]);
// Events still allowed once the session is closed.
const CLOSED_OK = new Set(["comments.seen", "notice.sent", "agent.seen", "directive"]);
// Events whose login need not be a person in the session (yet).
const ANY_LOGIN = new Set(["plan.join", "directive", "comments.seen", "notice.sent"]);

const HASH_RE = /^sha256:[0-9a-f]{64}$/;
const BLOB_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
// Logins, agent ids and notice keys become object keys; this one would set the prototype instead.
const BAD_KEY = "__proto__";

const ms = (t) => (t instanceof Date ? t.getTime() : typeof t === "number" ? t : Date.parse(t));
const isoOf = (t) => new Date(ms(t)).toISOString();
const validTime = (t) => typeof t === "string" && !Number.isNaN(Date.parse(t));
const nonEmpty = (s) => typeof s === "string" && s.trim() !== "";
const own = (o, k) => (o && typeof o === "object" && typeof k === "string" && Object.hasOwn(o, k) ? o[k] : undefined);
// A whole number given as a number or a digit string ("3"); anything else is NaN.
const int = (v) => (typeof v === "number" ? (Number.isInteger(v) ? v : NaN) : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : NaN);
const short = (hash) => String(hash ?? "?").replace(/^sha256:/, "").slice(0, 8) || "?";
const reasonOf = (r) => (r == null ? null : String(r).trim() || null);

// ---------------------------------------------------------------- people and agents

// "active", "observer", "left", "removed", or null when the login is not in the session.
export function personStatus(ledger, login) {
  const p = own(ledger?.people, login);
  if (!p) return null;
  if (p.removed) return "removed";
  if (p.left) return "left";
  if (p.observer) return "observer";
  return "active";
}

// Logins of the people who take part right now (not observers, not left or removed), sorted.
export function activePeople(ledger) {
  return Object.keys(ledger?.people ?? {}).filter((l) => personStatus(ledger, l) === "active").sort();
}

// The login an agent acts for, or null for an agent that has not joined.
export function personOf(ledger, agent) {
  return own(ledger?.agents, agent)?.login ?? null;
}

export function isOwner(ledger, login) {
  return typeof login === "string" && login !== "" && login === ledger?.owner;
}

// { agreed, waitingOn, agreedBy, needMore }: who still has to agree to the current revision, and
// how many people must still join to reach minPeople. An agreement counts only for the current
// revision number and its hash.
export function consensus(ledger) {
  const people = activePeople(ledger);
  const cur = own(ledger?.revs, String(ledger?.current));
  const ok = (login) => {
    const a = own(ledger?.agreements, login);
    return !!a && !!cur && a.rev === ledger.current && a.hash === cur.hash;
  };
  const agreedBy = people.filter(ok);
  const waitingOn = people.filter((l) => !ok(l));
  const min = Number.isInteger(ledger?.minPeople) && ledger.minPeople > 0 ? ledger.minPeople : 2;
  const needMore = Math.max(0, min - people.length);
  return { agreed: people.length > 0 && needMore === 0 && waitingOn.length === 0, waitingOn, agreedBy, needMore };
}

// Changes whenever the current revision, the phase, an agreement or a person's status changes,
// and never for lastSeen alone. An agent compares it with the key it saw last.
export function stateKey(ledger) {
  const cur = own(ledger?.revs, String(ledger?.current));
  const people = Object.keys(ledger?.people ?? {}).sort().map((l) => [l, personStatus(ledger, l)]);
  const agreements = Object.keys(ledger?.agreements ?? {}).sort().map((l) => [l, ledger.agreements[l]?.rev ?? null, ledger.agreements[l]?.hash ?? null]);
  const body = JSON.stringify([ledger?.current ?? null, cur?.hash ?? null, ledger?.phase ?? null, agreements, people]);
  return `r${ledger?.current ?? 0}.${ledger?.phase ?? "unknown"}.${createHash("sha256").update(body).digest("hex").slice(0, 16)}`;
}

// ---------------------------------------------------------------- constructor

// What is wrong with a revision's text fields, or null. `rev1` and `rev.add` share it.
function textProblem({ hash, blob, chars }, maxChars) {
  if (!Number.isInteger(chars) || chars < 0) return { code: "format", why: "chars must be a whole number" };
  if (chars > maxChars) return { code: "size", why: `the plan is ${chars} characters, and the most is ${maxChars}` };
  if (typeof hash !== "string" || !HASH_RE.test(hash)) return { code: "format", why: "the hash must be \"sha256:\" and 64 lower-case hex digits" };
  if (typeof blob !== "string" || !BLOB_RE.test(blob)) return { code: "format", why: "the blob id must be 40 or 64 lower-case hex digits" };
  return null;
}

const newPerson = (at, observer) => ({ joinedAt: at, lastSeen: at, observer, left: null, removed: null });
const newAgent = (tool, login, host, at) => ({ tool, vendor: vendorOf(tool), login, host: typeof host === "string" ? host : null, joinedAt: at, lastSeen: at });

export function newPlanLedger({ issue, owner, agent, minPeople = 2, rev1, now, lastCommentId = 0, lastCommentAt = null } = {}) {
  const number = int(issue?.number);
  if (!(number > 0)) throw new TypeError("newPlanLedger needs issue.number");
  if (!nonEmpty(owner) || owner === BAD_KEY) throw new TypeError("newPlanLedger needs the owner's login");
  if (!nonEmpty(agent?.id) || agent.id === BAD_KEY) throw new TypeError("newPlanLedger needs an agent id");
  if (now == null || Number.isNaN(ms(now))) throw new TypeError("newPlanLedger needs now");
  if (!Number.isInteger(minPeople) || minPeople < 1) throw new TypeError("newPlanLedger: minPeople must be a whole number of at least 1");
  const r = rev1 ?? {};
  const problem = textProblem(r, MAX_CHARS);
  if (problem?.code === "size") {
    throw new CollabError(EXIT.PRECONDITION, `${owner} can't start plan #${number}: ${problem.why}`, { type: "plan.new", login: owner, agent: agent.id });
  }
  if (problem) throw new TypeError(`newPlanLedger: rev1 is malformed: ${problem.why}`);
  const at = isoOf(now);
  const tool = nonEmpty(agent.tool) ? agent.tool : "other";
  return {
    schema: SCHEMA,
    kind: "plan",
    seq: 0,
    rev: null,
    issue: {
      repo: issue.repo ?? null, number, url: issue.url ?? null, title: issue.title == null ? "" : String(issue.title), defaultBranch: issue.defaultBranch ?? null,
    },
    owner,
    phase: "drafting",
    current: 1,
    minPeople,
    maxChars: MAX_CHARS,
    revs: {
      1: { hash: r.hash, blob: r.blob, base: 0, merged: false, agent: agent.id, login: owner, summary: r.summary == null ? "" : String(r.summary), chars: r.chars, at },
    },
    people: { [owner]: newPerson(at, false) },
    agents: { [agent.id]: newAgent(tool, owner, agent.host, at) },
    agreements: {},
    directives: [],
    // Comments already on the issue when the session starts are history, not directives for it.
    lastCommentId: Number(lastCommentId) || 0,
    lastCommentAt: validTime(lastCommentAt) ? isoOf(lastCommentAt) : null,
    notices: {},
    handoff: null,
    agreedAt: null,
    closed: null,
  };
}

// ---------------------------------------------------------------- refusals

const revNo = (ev) => (Number.isInteger(int(ev.data?.rev)) ? ` ${int(ev.data.rev)}` : "");
const VERB = {
  "plan.join": () => "join the plan",
  "agent.seen": () => "check in",
  "rev.add": (ev) => `add revision${revNo(ev)}`,
  agree: (ev) => `agree to revision${revNo(ev)}`,
  "agree.withdraw": () => "withdraw their agreement",
  "person.leave": () => "leave the plan",
  "person.remove": (ev) => `remove ${nonEmpty(ev.data?.target) ? ev.data.target : "a person"}`,
  reopen: () => "reopen the plan",
  handoff: (ev) => `hand off revision${revNo(ev)}`,
  "state.set": (ev) => (ev.data?.phase === "closed" ? "close the plan" : "change the plan's state"),
  directive: () => "record a /collab comment",
  "comments.seen": () => "mark comments seen",
  "notice.sent": () => "record a notice",
};

function refuse(ev, why, code = EXIT.PRECONDITION) {
  const who = nonEmpty(ev.login) ? ev.login : "someone";
  const verb = Object.hasOwn(VERB, ev.type) ? VERB[ev.type](ev) : ev.type;
  throw new CollabError(code, `${who} can't ${verb}: ${why}`, { type: ev.type, login: ev.login ?? null, agent: ev.agent ?? null });
}

function frozenWhy(L) {
  if (L.phase === "handed-off") {
    const pr = Number(L.handoff?.pr);
    return `revision ${L.current} was agreed and handed off${pr ? ` to PR #${pr}` : ""}, so the plan is frozen`;
  }
  return `everyone agreed to revision ${L.current}, so the plan is frozen until the owner runs collab plan reopen ${L.issue?.number}`;
}

function needActive(L, ev) {
  const status = personStatus(L, ev.login);
  if (status === "active") return;
  const why = {
    observer: `${ev.login} joined after revision ${L.current} was agreed and only watches until the owner reopens the plan`,
    left: `${ev.login} left the plan; join again first`,
    removed: `${ev.login} was removed from the plan`,
  }[status] ?? `${ev.login} is not in the plan`;
  refuse(ev, why);
}

// person.remove, reopen and state.set: the owner, or a repo admin (the CLI checks the permission
// and sets data.asAdmin).
function needOwnerOp(L, ev) {
  if (ev.login !== L.owner && ev.data.asAdmin !== true) refuse(ev, `only the owner (${L.owner}) or a repo admin can do that`);
}

function currentRev(L) {
  return own(L.revs, String(L.current)) ?? {};
}

// After an agreement or a person leaving: the plan is agreed once consensus holds.
function settle(L, ev) {
  if (L.phase === "drafting" && consensus(L).agreed) {
    L.phase = "agreed";
    L.agreedAt = ev.at;
  }
}

// How someone agreed: "agent:<id>" (that agent must act for them), "comment", "terminal", or
// whatever the CLI recorded. Without one: their agent if the event names one, else their terminal.
function viaOf(L, ev) {
  const v = ev.data.via;
  if (v == null || v === "") return ev.agent ? `agent:${ev.agent}` : "terminal";
  if (typeof v !== "string") refuse(ev, "data.via must be a string such as agent:<id>, comment or terminal");
  if (v.startsWith("agent:")) {
    const id = v.slice("agent:".length);
    const ag = own(L.agents, id);
    if (!ag) refuse(ev, `agent ${id} has not joined the plan`);
    if (ag.login !== ev.login) refuse(ev, `agent ${id} acts for ${ag.login}, not ${ev.login}`);
  }
  return v;
}

// ---------------------------------------------------------------- handlers

const H = {
  "plan.join"(L, ev) {
    const id = ev.agent;
    if (!nonEmpty(id) || id === BAD_KEY) refuse(ev, "an agent id is required");
    if (ev.login === BAD_KEY) refuse(ev, "that login can't be used");
    const ag = own(L.agents, id);
    if (ag) {
      if (ag.login !== ev.login) refuse(ev, `agent ${id} acts for ${ag.login}`);
      if (nonEmpty(ev.data.tool) && ev.data.tool !== ag.tool) refuse(ev, `${id} already joined as ${ag.tool}`);
    }
    const p = own(L.people, ev.login);
    if (p?.removed) {
      const reason = p.removed.reason ? `: ${p.removed.reason}` : "";
      refuse(ev, `${ev.login} was removed from the plan by ${p.removed.by}${reason}`);
    }
    // Whoever joins a frozen plan only watches until the owner reopens it: they never agreed to
    // the frozen revision, so they can't count as taking part in that agreement.
    const frozen = FROZEN.has(L.phase);
    if (!p) L.people[ev.login] = newPerson(ev.at, frozen);
    else if (p.left) {
      p.left = null;
      if (frozen) p.observer = true;
    }
    if (!ag) {
      const tool = nonEmpty(ev.data.tool) ? ev.data.tool : "other";
      L.agents[id] = newAgent(tool, ev.login, ev.data.host, ev.at);
    }
  },

  "agent.seen"() {}, // apply() updates lastSeen

  "rev.add"(L, ev) {
    needActive(L, ev);
    const d = ev.data;
    const rev = int(d.rev);
    const next = L.current + 1;
    if (rev !== next) {
      const taken = own(L.revs, String(rev));
      refuse(ev, taken ? `revision ${rev} already exists (by ${taken.login}); the next one is ${next}` : `revision ${L.current} is current, so the next one is ${next}`);
    }
    const base = int(d.base);
    if (!(base >= 1 && base <= L.current)) refuse(ev, `the base must be a revision from 1 to ${L.current}`);
    const chars = int(d.chars);
    const problem = textProblem({ hash: d.hash, blob: d.blob, chars }, Number(L.maxChars) || MAX_CHARS);
    if (problem) refuse(ev, problem.why);
    // Agreements are cleared by a new revision: one with the same text would clear them for nothing.
    if (d.hash === currentRev(L).hash) refuse(ev, `the text is the same as revision ${L.current}`);
    L.revs[String(rev)] = {
      hash: d.hash, blob: d.blob, base, merged: d.merged === true, agent: ev.agent ?? null, login: ev.login,
      summary: d.summary == null ? "" : String(d.summary), chars, at: ev.at,
    };
    L.current = rev;
    L.agreements = {};
  },

  agree(L, ev) {
    needActive(L, ev);
    const d = ev.data;
    if (int(d.rev) !== L.current) refuse(ev, `revision ${L.current} is current`);
    const cur = currentRev(L);
    if (d.hash !== cur.hash) refuse(ev, `revision ${L.current} is ${short(cur.hash)}, not ${short(d.hash)}; read it again before agreeing`);
    const via = viaOf(L, ev);
    L.agreements[ev.login] = {
      rev: L.current, hash: cur.hash, at: ev.at, via, commentId: Number(d.commentId) || 0, url: typeof d.url === "string" ? d.url : null,
    };
    settle(L, ev);
  },

  "agree.withdraw"(L, ev) {
    if (!own(L.agreements, ev.login)) refuse(ev, `${ev.login} has not agreed to revision ${L.current}`);
    delete L.agreements[ev.login];
  },

  "person.leave"(L, ev) {
    if (isOwner(L, ev.login)) refuse(ev, `${ev.login} owns the plan; the owner can close it instead`);
    const p = L.people[ev.login];
    if (p.removed) refuse(ev, `${ev.login} was removed from the plan`);
    if (p.left) refuse(ev, `${ev.login} already left`);
    p.left = ev.at;
    delete L.agreements[ev.login];
    settle(L, ev);
  },

  "person.remove"(L, ev) {
    needOwnerOp(L, ev);
    const target = ev.data.target;
    const p = nonEmpty(target) ? own(L.people, target) : undefined;
    if (!p) refuse(ev, `${nonEmpty(target) ? target : "the target"} is not in the plan`);
    if (target === L.owner) refuse(ev, `${target} owns the plan and can't be removed`);
    if (p.removed) refuse(ev, `${target} was already removed`);
    p.removed = { by: ev.login, at: ev.at, reason: reasonOf(ev.data.reason) };
    delete L.agreements[target];
    settle(L, ev);
  },

  reopen(L, ev) {
    needOwnerOp(L, ev);
    if (L.phase !== "agreed") {
      refuse(ev, L.phase === "handed-off" ? "it was already handed off to a build PR; start a new plan session instead" : "only an agreed plan can be reopened");
    }
    L.phase = "drafting";
    L.agreements = {};
    L.agreedAt = null;
    // People who joined while it was frozen take part from now on.
    for (const p of Object.values(L.people)) if (p.observer) p.observer = false;
  },

  handoff(L, ev) {
    needActive(L, ev);
    if (L.phase !== "agreed") refuse(ev, L.phase === "handed-off" ? "it was already handed off" : "only an agreed plan can be handed off");
    const d = ev.data;
    if (int(d.rev) !== L.current) refuse(ev, `revision ${L.current} is the agreed one`);
    const cur = currentRev(L);
    if (d.hash !== cur.hash) refuse(ev, `revision ${L.current} is ${short(cur.hash)}, not ${short(d.hash)}`);
    const pr = int(d.pr);
    if (!(pr > 0)) refuse(ev, "data.pr must be the build PR's number");
    L.phase = "handed-off";
    L.handoff = { ...d, pr, rev: L.current, hash: cur.hash, by: ev.login, at: ev.at };
  },

  "state.set"(L, ev) {
    needOwnerOp(L, ev);
    if (ev.data.phase !== "closed") refuse(ev, "closed is the only state to set; reopen and handoff have their own events");
    L.phase = "closed";
    L.closed = { by: ev.login, at: ev.at, reason: reasonOf(ev.data.reason) };
  },

  // The audit record of one `/collab …` comment on the issue by event.login. It is always recorded,
  // so lastCommentId moves on; `applied` says whether the CLI acted on it.
  directive(L, ev) {
    const d = ev.data;
    const commentId = Number(d.commentId);
    if (d.commentId == null || !Number.isFinite(commentId)) refuse(ev, "data.commentId is required");
    if (commentId <= L.lastCommentId) refuse(ev, `comment ${commentId} was already seen (last ${L.lastCommentId})`);
    if (!nonEmpty(d.cmd)) refuse(ev, "data.cmd is required");
    const entry = { commentId, login: ev.login, cmd: d.cmd, at: ev.at, applied: d.applied === true };
    if (Number.isInteger(int(d.rev))) entry.rev = int(d.rev);
    if (nonEmpty(d.hashPrefix)) entry.hashPrefix = d.hashPrefix;
    if (nonEmpty(d.url)) entry.url = d.url;
    if (d.why != null) entry.why = String(d.why);
    L.directives.push(entry);
    L.lastCommentId = commentId;
    if (validTime(d.commentAt)) L.lastCommentAt = isoOf(d.commentAt);
  },

  "comments.seen"(L, ev) {
    const id = Number(ev.data.lastCommentId);
    if (ev.data.lastCommentId == null || !Number.isFinite(id)) refuse(ev, "data.lastCommentId is required");
    if (id >= L.lastCommentId && validTime(ev.data.lastCommentAt)) L.lastCommentAt = isoOf(ev.data.lastCommentAt);
    L.lastCommentId = Math.max(L.lastCommentId, id);
  },

  "notice.sent"(L, ev) {
    const key = ev.data.key;
    if (!nonEmpty(key) || key === BAD_KEY) refuse(ev, "data.key is required");
    L.notices[key] = ev.data.commentId ?? null;
  },
};

export const EVENT_TYPES = Object.freeze(Object.keys(H));

// ---------------------------------------------------------------- apply

export function apply(ledger, event) {
  if (!ledger || typeof ledger !== "object") throw new TypeError("apply needs a plan ledger");
  if (ledger.schema !== SCHEMA) {
    throw new CollabError(EXIT.ENV, `this plan ledger is schema ${ledger.schema}, but this collab understands schema ${SCHEMA}; update collab`);
  }
  if (ledger.kind !== "plan") throw new CollabError(EXIT.ENV, `this is not a plan ledger (kind ${ledger.kind ?? "pr"})`);
  if (!event || typeof event.type !== "string" || !event.type) throw new CollabError(EXIT.BUG, "malformed plan event: no type");
  if (!validTime(event.at)) throw new CollabError(EXIT.BUG, `malformed ${event.type} event: no valid "at" time`);
  if (!nonEmpty(event.login)) throw new CollabError(EXIT.BUG, `malformed ${event.type} event: no login`);
  const data = event.data && typeof event.data === "object" && !Array.isArray(event.data) ? structuredClone(event.data) : {};
  const ev = { ...event, at: isoOf(event.at), data };
  const handler = Object.hasOwn(H, ev.type) ? H[ev.type] : null;
  if (!handler) refuse(ev, `unknown event type ${ev.type}`);

  const n = ledger.issue?.number;
  if (!ANY_LOGIN.has(ev.type)) {
    if (!own(ledger.people, ev.login)) refuse(ev, `${ev.login} has not joined plan #${n}; run collab plan join ${n}`);
    if (ev.agent != null) {
      const ag = own(ledger.agents, ev.agent);
      if (!ag) refuse(ev, `agent ${ev.agent} has not joined plan #${n}`);
      if (ag.login !== ev.login) refuse(ev, `agent ${ev.agent} acts for ${ag.login}`);
    }
  }
  if (ledger.phase === "closed" && !CLOSED_OK.has(ev.type)) refuse(ev, `plan #${n} is closed`, EXIT.UNSUPPORTED);
  if (FROZEN.has(ledger.phase) && FROZEN_REFUSED.has(ev.type)) refuse(ev, frozenWhy(ledger));

  const L = structuredClone(ledger);
  handler(L, ev);
  L.seq = ledger.seq + 1;
  // A sign of life from the person and the agent acting for them. A directive is someone's
  // comment processed later by whichever agent ran housekeeping, so it touches nobody.
  if (ev.type !== "directive") {
    const p = own(L.people, ev.login);
    if (p) p.lastSeen = ev.at;
    const ag = own(L.agents, ev.agent);
    if (ag && ag.login === ev.login) ag.lastSeen = ev.at;
  }
  return L;
}
