// PR references, the supported-PR check, the dashboard splice and the CI filter probe.

import { CollabError, EXIT } from "./errors.mjs";
import { lsFiles, showFile } from "./git.mjs";

// ---------------------------------------------------------------------------
// PR references

const URL_RE = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)(?:[/?#].*)?$/i;
const SHORT_RE = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#(\d+)$/;
const NUM_RE = /^#?(\d+)$/;

// Accepts https://github.com/o/r/pull/42 (with any /files, ?query or #anchor), o/r#42, #42 and 42.
export function parsePrRef(arg, defaultRepo) {
  const s = String(arg ?? "").trim();
  const usage = "Use a PR URL (https://github.com/owner/repo/pull/42), owner/repo#42, #42 or 42.";
  let m = URL_RE.exec(s) ?? SHORT_RE.exec(s);
  if (m) return { repo: `${m[1]}/${m[2]}`, number: toNumber(m[3], s, usage) };
  m = NUM_RE.exec(s);
  if (m) {
    if (!defaultRepo) {
      throw new CollabError(EXIT.PRECONDITION, `"${s}" names no repo and none could be worked out from origin. ${usage}`);
    }
    return { repo: defaultRepo, number: toNumber(m[1], s, usage) };
  }
  throw new CollabError(EXIT.PRECONDITION, `not a PR reference: "${s}". ${usage}`);
}

function toNumber(digits, s, usage) {
  const n = Number(digits);
  if (!Number.isSafeInteger(n) || n <= 0) throw new CollabError(EXIT.PRECONDITION, `not a PR number: "${s}". ${usage}`);
  return n;
}

// ---------------------------------------------------------------------------
// Supported PRs (exit 4 otherwise)

export function checkSupported(pr, repoInfo) {
  const label = pr?.number ? `PR #${pr.number}` : "This PR";
  const state = String(pr?.state ?? "").toUpperCase();
  if (pr?.isCrossRepository) {
    throw new CollabError(
      EXIT.UNSUPPORTED,
      `${label} comes from a fork. collab needs the head branch in this repo: push the branch here, open a new PR from it, and run collab on that PR.`,
      { reason: "fork" },
    );
  }
  if (pr?.merged || state === "MERGED") {
    throw new CollabError(EXIT.UNSUPPORTED, `${label} is already merged. Open a new PR for further work and run collab on that one.`, { reason: "merged" });
  }
  if (state === "CLOSED") {
    throw new CollabError(EXIT.UNSUPPORTED, `${label} is closed. Reopen it on GitHub, then run the command again.`, { reason: "closed" });
  }
  // A task's sub-PR (head collab/pr-<n>/t<k>) belongs to the collab on PR #n; a second collab on it
  // would only confuse everyone.
  const sub = /^collab\/pr-(\d+)\/t(\d+)$/.exec(String(pr?.headRef ?? ""));
  if (sub) {
    throw new CollabError(
      EXIT.UNSUPPORTED,
      `${label} is the sub-PR for task T${sub[2]} of the collab on PR #${sub[1]}. Join that PR instead: collab join ${sub[1]}`,
      { reason: "sub-pr", mainPr: Number(sub[1]) },
    );
  }
  const def = repoInfo?.defaultBranch;
  if (def && pr?.headRef === def) {
    throw new CollabError(
      EXIT.UNSUPPORTED,
      `${label} uses the default branch (${def}) as its head. Create a feature branch, open a PR from it into ${def}, and run collab on that PR.`,
      { reason: "default-head" },
    );
  }
  return true;
}

// ---------------------------------------------------------------------------
// Dashboard markers

export const MARK_START = /<!-- collab:dashboard:start seq=(\d+)(?: at=([^ ]+))? -->/;
export const MARK_END = "<!-- collab:dashboard:end -->";

export function readMarker(body) {
  const m = MARK_START.exec(String(body ?? ""));
  return m ? { seq: Number(m[1]), at: m[2] ?? null } : null;
}

const startLine = (seq, at) => `<!-- collab:dashboard:start seq=${seq}${at ? ` at=${at}` : ""} -->`;
const normalise = (s) => String(s).replace(/\r\n/g, "\n").replace(/^\n+|\n+$/g, "");

// Returns the new body, or null when nothing should be written: the body already holds a newer
// render (existing seq > seq) or the same block. Only the text between the markers changes; the
// owner's text around them stays byte-for-byte (CRLF included). With no complete marker pair,
// the block plus a blank line goes at the very top.
export function splice(body, block, seq, at) {
  const text = String(body ?? "");
  const content = String(block ?? "");
  if (content.includes("<!-- collab:dashboard:")) throw new Error("dashboard block must not contain collab markers");
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const inner = content.replace(/\r\n/g, "\n").replace(/\n/g, eol);
  const fresh = `${startLine(seq, at)}${eol}${inner}${eol}${MARK_END}`;

  const m = MARK_START.exec(text);
  const endAt = m ? text.indexOf(MARK_END, m.index + m[0].length) : -1;
  if (!m || endAt < 0) return text.length ? `${fresh}${eol}${eol}${text}` : `${fresh}${eol}`;

  if (Number(m[1]) > Number(seq)) return null;
  const existing = text.slice(m.index + m[0].length, endAt);
  if (normalise(existing) === normalise(content)) return null;
  return text.slice(0, m.index) + fresh + text.slice(endAt + MARK_END.length);
}

// ---------------------------------------------------------------------------
// CI filtered to the default branch

const WORKFLOW_RE = /^\.github\/workflows\/[^/]+\.ya?ml$/i;

// True when some workflow on origin/<default> runs for pull requests only when the base is the
// default branch, so sub-PRs (based on the main PR's head branch) get no checks from it.
export function ciFilteredToDefault(cwd, defaultBranch) {
  const ref = `origin/${defaultBranch}`;
  for (const file of lsFiles(cwd, ref).filter((f) => WORKFLOW_RE.test(f))) {
    const text = showFile(cwd, ref, file);
    if (text && workflowFiltersToDefault(text, defaultBranch)) return true;
  }
  return false;
}

// Pure, line-based (no YAML library). True when the workflow has a pull_request or
// pull_request_target trigger and every such trigger has a `branches:` list holding only the
// default branch. Flow mappings beyond `{ branches: [...] }` are treated as unfiltered.
export function workflowFiltersToDefault(yamlText, defaultBranch) {
  const lines = toLines(yamlText);
  const onIdx = lines.findIndex((l) => l.indent === 0 && /^["']?on["']?\s*:/.test(l.text));
  if (onIdx < 0) return false;
  const onValue = valueAfterKey(lines[onIdx].text);
  if (onValue) return false; // on: pull_request / on: [push, pull_request]: no branch filter
  const onBlock = blockAfter(lines, onIdx);
  if (!onBlock.length) return false;
  const evIndent = onBlock[0].indent;
  let prTriggers = 0;
  let filtered = 0;
  for (let i = 0; i < onBlock.length; i++) {
    const l = onBlock[i];
    if (l.indent !== evIndent) continue;
    const km = /^["']?(pull_request(?:_target)?)["']?\s*:(.*)$/.exec(l.text);
    if (!km) {
      if (/^-\s*["']?pull_request(?:_target)?["']?\s*$/.test(l.text)) prTriggers++; // list form: unfiltered
      continue;
    }
    prTriggers++;
    const inline = km[2].trim();
    let branches = null;
    if (inline) {
      const fm = /\bbranches\s*:\s*\[([^\]]*)\]/.exec(inline);
      if (fm) branches = splitFlow(fm[1]);
    } else {
      branches = branchesIn(blockAfter(onBlock, i));
    }
    if (branches && branches.length && branches.every((b) => b === defaultBranch)) filtered++;
  }
  return prTriggers > 0 && filtered === prTriggers;
}

function toLines(text) {
  const out = [];
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const noComment = raw.replace(/(^|\s)#.*$/, "");
    if (!noComment.trim()) continue;
    const indent = noComment.length - noComment.trimStart().length;
    out.push({ indent, text: noComment.trim() });
  }
  return out;
}

function valueAfterKey(text) {
  const i = text.indexOf(":");
  return i < 0 ? "" : text.slice(i + 1).trim();
}

// The lines indented deeper than lines[idx] that directly follow it.
function blockAfter(lines, idx) {
  const base = lines[idx].indent;
  const out = [];
  for (let j = idx + 1; j < lines.length && lines[j].indent > base; j++) out.push(lines[j]);
  return out;
}

function branchesIn(block) {
  if (!block.length) return null;
  const keyIndent = block[0].indent;
  for (let i = 0; i < block.length; i++) {
    const l = block[i];
    if (l.indent !== keyIndent || !/^["']?branches["']?\s*:/.test(l.text)) continue;
    const v = valueAfterKey(l.text);
    if (v.startsWith("[")) return splitFlow(v.replace(/^\[/, "").replace(/\].*$/, ""));
    if (v) return [unquote(v)];
    // Block sequence, indented deeper or (valid YAML) at the key's own indent.
    const items = [];
    for (let j = i + 1; j < block.length; j++) {
      const x = block[j];
      if (x.indent < keyIndent || (x.indent === keyIndent && !x.text.startsWith("-"))) break;
      if (x.text.startsWith("-")) items.push(unquote(x.text.slice(1).trim()));
    }
    return items;
  }
  return null;
}

const splitFlow = (s) => s.split(",").map((x) => unquote(x.trim())).filter(Boolean);
const unquote = (s) => s.replace(/^(["'])(.*)\1$/, "$2");
