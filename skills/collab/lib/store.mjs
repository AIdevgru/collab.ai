// The ledger lives in one file, ledger.json, on the custom ref refs/collab/<kind>-<n>: kind "pr"
// (a PR collab) or "plan" (a plan session on an issue). Each write is a commit whose parent is the
// previous ledger, pushed with --force-with-lease, so the server's ref lock makes it a
// compare-and-swap. A write may put extra files (blobs the caller wrote) next to ledger.json.

import { iso } from "./clock.mjs";
import { CollabError, EXIT } from "./errors.mjs";
import { git } from "./git.mjs";

export const KINDS = Object.freeze(["pr", "plan"]);
export const refFor = (n, kind = "pr") => `refs/collab/${kind}-${n}`;
export const cacheRefFor = (agent, n, kind = "pr") => `refs/collab-cache/${agent ?? "anon"}/${kind}-${n}`;

const EMAIL = "collab@users.noreply.github.com";
const NETWORK_RETRIES = 3;
const TRAILER = "Collab-Event: ";
const LEDGER = "ledger.json";
const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const OID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

const sleepCell = new Int32Array(new SharedArrayBuffer(4));
const sleep = (ms) => Atomics.wait(sleepCell, 0, 0, ms);
// 50-400 ms times the try number, so racers spread out more each time they collide.
const backoff = (tries) => sleep(Math.round((50 + Math.random() * 350) * Math.min(tries, 6)));

const NETWORK_RE = /Could not resolve host|unable to access|Connection/i;
const isNetwork = (r) => NETWORK_RE.test(r.stderr) || (r.code === 128 && !r.stdout.trim());

function networkError(message, r) {
  return new CollabError(EXIT.ENV, message, { stderr: r.stderr.trim(), code: r.code, network: isNetwork(r) });
}

function checkKind(kind) {
  if (!KINDS.includes(kind)) throw new CollabError(EXIT.BUG, `unknown ledger kind "${kind}" (expected ${KINDS.join(" or ")})`);
  return kind;
}

// "PR 42" or "plan 57", for messages.
const what = (n, kind) => `${kind === "plan" ? "plan" : "PR"} ${n}`;

// The agent id becomes part of a ref name, so keep it to safe characters.
function checkAgent(agent) {
  const ok = (id) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) && !/\.\.|\.lock$|\.$/.test(id);
  if (agent != null && !ok(String(agent))) {
    throw new CollabError(EXIT.PRECONDITION, `"${agent}" can't be an agent id: use letters, digits, '.', '_' and '-'`);
  }
}

function checkedCacheRef(agent, n, kind) {
  checkAgent(agent);
  return cacheRefFor(agent, n, kind);
}

// One git process for the commit id and the blob (each spawn costs ~70 ms on Windows).
// The blob comes last, so its byte size isn't needed to cut it out of the utf8 text.
function readCache(cwd, cacheRef) {
  const input = `info ${cacheRef}^{commit}\ncontents ${cacheRef}:${LEDGER}\n`;
  const outText = git(["cat-file", "--batch-command"], { cwd, input }).stdout;
  const nl1 = outText.indexOf("\n");
  const [rev, type] = outText.slice(0, nl1).split(" ");
  if (type !== "commit") return null;
  const nl2 = outText.indexOf("\n", nl1 + 1);
  const [, blobType] = outText.slice(nl1 + 1, nl2).split(" ");
  if (blobType !== "blob") throw new CollabError(EXIT.ENV, `${rev} has no ${LEDGER}`, { rev });
  const text = outText.slice(nl2 + 1, -1);
  try {
    return { ledger: JSON.parse(text), rev };
  } catch (e) {
    throw new CollabError(EXIT.ENV, `${LEDGER} at ${rev} is not valid JSON: ${e.message}`, { rev });
  }
}

// Fetches the ledger into this agent's cache ref. Null when there is no ledger yet.
export function read({ cwd, pr, agent, auth, kind = "pr" }) {
  checkKind(kind);
  const ref = refFor(pr, kind);
  const cacheRef = checkedCacheRef(agent, pr, kind);
  const r = git(["fetch", "--no-tags", "--no-write-fetch-head", "origin", `+${ref}:${cacheRef}`], {
    cwd,
    auth,
    allowFail: true,
  });
  if (r.code !== 0) {
    if (/couldn't find remote ref/i.test(r.stderr)) {
      // The remote ledger is gone (or never existed): drop any stale cached copy.
      git(["update-ref", "-d", cacheRef], { cwd, allowFail: true });
      return null;
    }
    throw networkError(`could not fetch the ledger for ${what(pr, kind)}`, r);
  }
  return readCache(cwd, cacheRef);
}

function subject(events, agent) {
  const e = events[0];
  const summary =
    typeof e?.data?.summary === "string" && e.data.summary.trim()
      ? e.data.summary
      : e
        ? [e.agent ?? agent, e.type, e.task].filter(Boolean).join(" ")
        : `${agent} update`;
  return `collab: ${summary.replace(/\s+/g, " ").trim()}`;
}

export function commitMessage(events, agent) {
  const trailers = events.map((e) => TRAILER + JSON.stringify(e));
  return trailers.length ? `${subject(events, agent)}\n\n${trailers.join("\n")}\n` : `${subject(events, agent)}\n`;
}

// The extra tree lines for `files` ({ name: blobOid }), sorted by name. A bad name or id is a bug:
// the CLI picks every name.
function fileLines(files) {
  if (files == null) return [];
  if (typeof files !== "object" || Array.isArray(files)) throw new CollabError(EXIT.BUG, "store files must be an object of { name: blobOid }");
  const lines = [];
  for (const name of Object.keys(files).sort()) {
    const oid = files[name];
    if (!FILE_RE.test(name) || name === LEDGER) {
      throw new CollabError(EXIT.BUG, `"${name}" can't be a ledger file name: use letters, digits, '.', '_' and '-', and not ${LEDGER}`);
    }
    if (typeof oid !== "string" || !OID_RE.test(oid)) throw new CollabError(EXIT.BUG, `the ledger file ${name} needs a blob id, got "${oid}"`);
    lines.push(`100644 blob ${oid}\t${name}\n`);
  }
  return lines;
}

function makeCommit(cwd, ledger, events, rev, agent, files) {
  const extra = fileLines(files);
  const blob = git(["hash-object", "-w", "--stdin"], { cwd, input: `${JSON.stringify(ledger, null, 2)}\n` }).stdout.trim();
  // mktree checks each blob exists, so a file the caller never wrote fails here, before the push.
  const tree = git(["mktree"], { cwd, input: `100644 blob ${blob}\t${LEDGER}\n${extra.join("")}` }).stdout.trim();
  const who = `collab (${agent})`;
  const when = iso();
  const env = {
    GIT_AUTHOR_NAME: who,
    GIT_AUTHOR_EMAIL: EMAIL,
    GIT_AUTHOR_DATE: when,
    GIT_COMMITTER_NAME: who,
    GIT_COMMITTER_EMAIL: EMAIL,
    GIT_COMMITTER_DATE: when,
  };
  const args = ["commit-tree", tree, ...(rev ? ["-p", rev] : []), "-F", "-"];
  return git(args, { cwd, env, input: commitMessage(events, agent) }).stdout.trim();
}

// "ok", "race" (someone else moved the ref first), "network", or "error".
export function classifyPush(r, ref) {
  const line = r.stdout.split(/\r?\n/).find((l) => /^[ +\-*=!]\t/.test(l) && l.split("\t")[1]?.endsWith(`:${ref}`));
  if (line?.startsWith("!")) {
    if (/declined|denied|protected/i.test(line)) return "error";
    if (/stale info|fetch first|non-fast-forward|rejected/i.test(line)) return "race";
    return "error";
  }
  if (r.code === 0 && line) return "ok";
  if (isNetwork(r)) return "network";
  return "error";
}

export function write({ cwd, pr, agent, auth, mutate, maxTries = 6, kind = "pr" }) {
  checkKind(kind);
  const ref = refFor(pr, kind);
  const cacheRef = checkedCacheRef(agent, pr, kind);
  const who = agent ?? "anon";
  let races = 0;
  let netFails = 0;
  const onNetwork = (err) => {
    netFails += 1;
    if (netFails > NETWORK_RETRIES) throw err;
    backoff(netFails);
  };

  for (;;) {
    let current;
    try {
      current = read({ cwd, pr, agent, auth, kind });
    } catch (e) {
      if (!(e instanceof CollabError) || !e.details?.network) throw e;
      onNetwork(e);
      continue;
    }
    const rev = current?.rev ?? null;
    const next = mutate(current ? current.ledger : null, rev);
    if (next == null) return { ledger: current?.ledger ?? null, rev, events: [] };
    const events = next.events ?? [];
    const commit = makeCommit(cwd, next.ledger, events, rev, who, next.files);

    const r = git(["push", "--porcelain", "origin", `${commit}:${ref}`, `--force-with-lease=${ref}:${rev ?? ""}`], {
      cwd,
      auth,
      allowFail: true,
    });
    const result = classifyPush(r, ref);
    if (result === "ok") {
      git(["update-ref", cacheRef, commit], { cwd });
      return { ledger: next.ledger, rev: commit, events };
    }
    if (result === "race") {
      races += 1;
      if (races >= maxTries) {
        throw new CollabError(EXIT.CONTENTION, `gave up writing the ledger for ${what(pr, kind)} after ${races} lost races`, {
          tries: races,
        });
      }
      backoff(races);
      continue;
    }
    const err = new CollabError(EXIT.ENV, `could not push the ledger for ${what(pr, kind)}`, {
      stderr: r.stderr.trim(),
      stdout: r.stdout.trim(),
      code: r.code,
      network: result === "network",
    });
    if (result === "network") {
      onNetwork(err);
      continue;
    }
    throw err;
  }
}

// Every ledger of one kind on origin, [{ n, ledger, rev }] in numeric order. One fetch mirrors
// refs/collab/<kind>-* into this agent's cache refs (--prune drops deleted ones); a ref whose
// ledger.json is missing or can't be parsed is skipped.
export function list({ cwd, agent, auth, kind = "pr" }) {
  checkKind(kind);
  checkAgent(agent);
  const prefix = `refs/collab-cache/${agent ?? "anon"}/${kind}-`;
  const spec = `+refs/collab/${kind}-*:${prefix}*`;
  const r = git(["fetch", "--prune", "--no-tags", "--no-write-fetch-head", "origin", spec], { cwd, auth, allowFail: true });
  if (r.code !== 0) throw networkError(`could not fetch the ${kind === "plan" ? "plan" : "PR"} ledgers`, r);
  const refs = git(["for-each-ref", "--format=%(refname)", `refs/collab-cache/${agent ?? "anon"}/`], { cwd }).stdout;
  const out = [];
  for (const name of refs.split(/\r?\n/)) {
    if (!name.startsWith(prefix)) continue;
    const tail = name.slice(prefix.length);
    if (!/^[1-9]\d*$/.test(tail)) continue;
    let got = null;
    try {
      got = readCache(cwd, name);
    } catch {
      got = null; // not a ledger we can read: skip it
    }
    if (got) out.push({ n: Number(tail), ledger: got.ledger, rev: got.rev });
  }
  return out.sort((a, b) => a.n - b.n);
}

// Events from the cached ref's commit trailers, newest first. Call read() first to refresh.
export function history({ cwd, pr, agent, limit = 10, kind = "pr" }) {
  checkKind(kind);
  return logEvents(cwd, checkedCacheRef(agent, pr, kind), limit).slice(0, limit);
}

// Events with seq above afterSeq from the cached ref, oldest first: what an agent has not read yet.
// Local only, like history(). At most `limit` commits back are searched, so a reader that fell far
// behind gets the newest part.
export function eventsSince({ cwd, pr, agent, afterSeq = 0, limit = 200, kind = "pr" }) {
  checkKind(kind);
  const after = Number(afterSeq) || 0;
  return logEvents(cwd, checkedCacheRef(agent, pr, kind), limit)
    .filter((h) => Number(h.event?.seq) > after)
    .reverse();
}

// { sha, at, event } for the events in the last `commits` commits of a ref, newest first.
function logEvents(cwd, cacheRef, commits) {
  const head = git(["rev-parse", "--verify", "--quiet", `${cacheRef}^{commit}`], { cwd, allowFail: true });
  if (head.code !== 0) return [];
  const log = git(["log", head.stdout.trim(), "-n", String(commits), "--format=%H%x1f%cI%x1f%B%x1e"], { cwd }).stdout;
  const result = [];
  for (const record of log.split("\x1e")) {
    const [sha, date, body] = record.replace(/^\s+/, "").split("\x1f");
    if (!sha || body === undefined) continue;
    const at = new Date(date).toISOString();
    const events = [];
    for (const line of body.split(/\r?\n/)) {
      if (!line.startsWith(TRAILER)) continue;
      try {
        events.push(JSON.parse(line.slice(TRAILER.length)));
      } catch {
        // not ours or truncated: skip it
      }
    }
    // Events in one commit were applied in order, so the last one is the newest.
    for (const event of events.reverse()) result.push({ sha, at, event });
  }
  return result;
}

// Deletes the ledger on origin and this clone's cached copies of it.
export function remove({ cwd, pr, auth, kind = "pr" }) {
  checkKind(kind);
  const ref = refFor(pr, kind);
  const r = git(["push", "--porcelain", "origin", `:${ref}`], { cwd, auth, allowFail: true });
  const line = r.stdout.split(/\r?\n/).find((l) => l.split("\t")[1] === `:${ref}`);
  const gone = /remote ref does not exist/i.test(r.stderr + r.stdout);
  if (!(r.code === 0 && line && !line.startsWith("!")) && !gone) {
    throw networkError(`could not delete the ledger for ${what(pr, kind)}`, r);
  }
  const caches = git(["for-each-ref", "--format=%(refname)", "refs/collab-cache/"], { cwd }).stdout;
  for (const name of caches.split(/\r?\n/)) {
    if (name.endsWith(`/${kind}-${pr}`)) git(["update-ref", "-d", name], { cwd, allowFail: true });
  }
}
