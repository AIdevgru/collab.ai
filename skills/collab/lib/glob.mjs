// A small glob matcher for task scopes. Pure, posix paths only (git ls-files output).
//
// Supported: `**` (zero or more path segments: `**/x`, `a/**/b`, `dir/**`), `*` (no `/`), `?`,
// `{a,b}` (alternatives may hold any other syntax, and nest), `[abc]`, `[a-z]`, `[!a]`/`[^a]`,
// and `\x` to escape. Everything else is literal, including regex metacharacters.
// Normalising: a leading `./` or `/` is dropped, and a trailing `/` means "everything inside"
// (`src/` is `src/**`). `*` and `?` match dotfiles too: a scope is a claim on files, so
// erring towards a match is the safe side.

const compiled = new Map();
const MAX_LITERALS = 256;

function normalizeGlob(glob) {
  if (typeof glob !== "string") throw new TypeError(`glob must be a string, got ${typeof glob}`);
  let g = glob.trim();
  while (g.startsWith("./")) g = g.slice(2);
  g = g.replace(/^\/+/, "");
  if (g.endsWith("/") && !g.endsWith("\\/")) g += "**";
  return g;
}

function normalizePath(p) {
  let s = String(p);
  while (s.startsWith("./")) s = s.slice(2);
  return s.replace(/^\/+/, "");
}

const escapeRe = (ch) => ch.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

function compile(src) {
  let i = 0;

  // True when position j ends the current alternative (or the whole pattern).
  const atEnd = (j, inBrace) => j >= src.length || (inBrace && (src[j] === "," || src[j] === "}"));

  function parseClass() {
    let j = i + 1;
    let negate = false;
    if (src[j] === "!" || src[j] === "^") { negate = true; j++; }
    const bodyStart = j;
    if (src[j] === "]") j++; // a leading ] is literal
    while (j < src.length && src[j] !== "]") j++;
    if (j >= src.length) return null; // unclosed: the caller treats [ as a literal
    const body = src.slice(bodyStart, j).replace(/[\\^[\]]/g, "\\$&");
    i = j + 1;
    return negate ? `[^/${body}]` : `(?:(?!/)[${body}])`;
  }

  function parseBrace(segStart) {
    const start = i;
    i++; // past {
    const alts = [];
    for (;;) {
      alts.push(parseSeq(true, segStart));
      if (src[i] === ",") { i++; continue; }
      if (src[i] === "}") { i++; break; }
      i = start; // unclosed
      return null;
    }
    if (alts.length < 2) { i = start; return null; } // {a} is literal, like bash
    return `(?:${alts.join("|")})`;
  }

  function parseSeq(inBrace, segStartInit) {
    let out = "";
    let segStart = segStartInit;
    while (i < src.length) {
      const ch = src[i];
      if (inBrace && (ch === "," || ch === "}")) break;
      if (ch === "\\") {
        out += escapeRe(i + 1 < src.length ? src[i + 1] : "\\");
        i += 2;
        segStart = false;
        continue;
      }
      if (ch === "/") {
        // A trailing "/**" also matches the directory itself: zero segments.
        if (src[i + 1] === "*" && src[i + 2] === "*" && atEnd(i + 3, inBrace)) {
          out += "(?:/.*)?";
          i += 3;
          segStart = false;
          continue;
        }
        out += "/";
        i++;
        segStart = true;
        continue;
      }
      if (ch === "*") {
        let j = i;
        while (src[j] === "*") j++;
        if (j - i >= 2 && segStart) {
          if (src[j] === "/") { out += "(?:.*/)?"; i = j + 1; segStart = true; continue; }
          if (atEnd(j, inBrace)) { out += ".*"; i = j; segStart = false; continue; }
        }
        out += "[^/]*"; // `*`, or a `**` that isn't a whole segment
        i = j;
        segStart = false;
        continue;
      }
      if (ch === "?") { out += "[^/]"; i++; segStart = false; continue; }
      if (ch === "[") {
        const cls = parseClass();
        out += cls ?? "\\[";
        if (cls === null) i++;
        segStart = false;
        continue;
      }
      if (ch === "{") {
        const alt = parseBrace(segStart);
        if (alt === null) { out += "\\{"; i++; } else out += alt;
        segStart = false;
        continue;
      }
      out += escapeRe(ch);
      i++;
      segStart = false;
    }
    return out;
  }

  return parseSeq(false, true);
}

function regexFor(glob) {
  const g = normalizeGlob(glob);
  let re = compiled.get(g);
  if (!re) {
    re = new RegExp(`^(?:${compile(g)})$`);
    compiled.set(g, re);
  }
  return re;
}

export function globToRegExp(glob) {
  return new RegExp(regexFor(glob).source);
}

export function matchAny(globs, path) {
  if (!Array.isArray(globs) || globs.length === 0) return false;
  const p = normalizePath(path);
  return globs.some((g) => regexFor(g).test(p));
}

export function expand(globs, files) {
  if (!Array.isArray(globs) || globs.length === 0 || !Array.isArray(files)) return [];
  const out = [];
  const seen = new Set();
  for (const f of files) {
    const p = normalizePath(f);
    if (!seen.has(p) && matchAny(globs, p)) { seen.add(p); out.push(p); }
  }
  return out;
}

// Expand the first real {a,b} group, recursively. Escapes and unclosed or single-item braces
// stay as they are.
function braceExpand(g, budget = { left: MAX_LITERALS }) {
  let depth = 0;
  let open = -1;
  const commas = [];
  for (let i = 0; i < g.length; i++) {
    const ch = g[i];
    if (ch === "\\") { i++; continue; }
    if (ch === "{") { if (depth === 0) { open = i; commas.length = 0; } depth++; continue; }
    if (ch === "," && depth === 1) { commas.push(i); continue; }
    if (ch === "}" && depth > 0) {
      depth--;
      if (depth === 0 && commas.length) {
        const pre = g.slice(0, open);
        const post = g.slice(i + 1);
        const cuts = [open, ...commas, i];
        const out = [];
        for (let k = 0; k + 1 < cuts.length; k++) {
          for (const x of braceExpand(pre + g.slice(cuts[k] + 1, cuts[k + 1]) + post, budget)) {
            if (budget.left-- <= 0) return out;
            out.push(x);
          }
        }
        return out;
      }
    }
  }
  return [g];
}

// Concrete paths a scope names outright, such as new files a task will create.
function literals(globs) {
  const out = [];
  for (const raw of globs ?? []) {
    const g = normalizeGlob(raw);
    for (const alt of braceExpand(g)) {
      if (/(^|[^\\])[*?[]/.test(alt) || alt === "") continue;
      out.push(alt.replace(/\\(.)/g, "$1"));
    }
  }
  return out;
}

// The concrete files both scopes cover. A side's files are its globs expanded against
// allFiles, the files it already touched, and any literal paths its globs name. A file
// overlaps when both sides cover it (by glob or by listing it).
export function intersect(aGlobs, aFiles, bGlobs, bFiles, allFiles) {
  const aG = aGlobs ?? [];
  const bG = bGlobs ?? [];
  const aSet = new Set((aFiles ?? []).map(normalizePath));
  const bSet = new Set((bFiles ?? []).map(normalizePath));
  const inA = (f) => aSet.has(f) || matchAny(aG, f);
  const inB = (f) => bSet.has(f) || matchAny(bG, f);
  const candidates = new Set([
    ...expand([...aG, ...bG], allFiles ?? []),
    ...aSet, ...bSet,
    ...literals(aG), ...literals(bG),
  ]);
  return [...candidates].filter((f) => inA(f) && inB(f)).sort();
}
