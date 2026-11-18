#!/usr/bin/env node
// Installs the collab skill for every agent vendor on this machine.
//
//   node scripts/install.mjs [--home DIR] [--copy] [--dry-run] [--json] [--uninstall]
//
//   (default)    link <repo>/skills/collab into ~/.claude/skills/collab, ~/.codex/skills/collab (only if
//                ~/.codex exists) and ~/.collab/skill (a junction on Windows, a symlink elsewhere)
//   --copy       copy instead of linking, for tools that do not follow links
//   --home DIR   use DIR as the home directory (tests); default os.homedir()
//   --dry-run    print the planned actions, change nothing
//   --json       print { ok, actions } as JSON
//   --uninstall  remove exactly what ~/.collab/install.json lists; runs/, agents/ and archive/ stay
//
// It also writes the launcher ~/.collab/bin/collab.mjs (the one fixed CLI path), the collab and
// collab.cmd shims, and the manifest ~/.collab/install.json. It never changes PATH or a shell profile.
// Exit codes: 0 ok, 1 unexpected error, 5 the skill folder is missing.
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT = fileURLToPath(import.meta.url);
export const REPO = path.resolve(path.dirname(SCRIPT), "..");
export const SKILL = path.join(REPO, "skills", "collab");
export const MANIFEST_NAME = "install.json";

const LAUNCHER_SOURCE = `#!/usr/bin/env node
// collab launcher, written by scripts/install.mjs. Every agent runs: node "$HOME/.collab/bin/collab.mjs" ...
await import(new URL("../skill/bin/collab.mjs", import.meta.url));
`;
const SH_SHIM = `#!/bin/sh\nexec node "$HOME/.collab/bin/collab.mjs" "$@"\n`;
const CMD_SHIM = `@node "%USERPROFILE%\\.collab\\bin\\collab.mjs" %*\r\n`;

class InstallError extends Error {
  constructor(message, code = 1) {
    super(message);
    this.code = code;
  }
}

// Where a symlink or junction points (absolute), or null when p is not a link.
export function linkTarget(p) {
  try {
    if (!lstatSync(p).isSymbolicLink()) return null;
  } catch {
    return null;
  }
  return path.resolve(path.dirname(p), readlinkSync(p).replace(/^\\\\\?\\/, ""));
}

const real = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};
const sameDir = (a, b) => real(a).toLowerCase() === real(b).toLowerCase() || real(a) === real(b);

// A link that should point at src but does not: broken, or pointing anywhere else.
export function staleLink(dest, src) {
  const cur = linkTarget(dest);
  return cur !== null && !sameDir(cur, src);
}

const lstatOrNull = (p) => {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
};

// Removes a link itself. Never recurses, so a junction's target survives.
function removeLink(p) {
  try {
    unlinkSync(p);
  } catch {
    rmSync(p, { force: true }); // non-recursive: does not follow the link
  }
}

const makeLink = (src, dest) => symlinkSync(src, dest, process.platform === "win32" ? "junction" : "dir");

const stamp = (d = new Date()) => d.toISOString().replace(/\.\d{3}Z$/, "").replace(/[-:T]/g, "");

function backupPath(dest) {
  const base = `${dest}.bak-${stamp()}`;
  let p = base;
  for (let i = 1; lstatOrNull(p); i++) p = `${base}-${i}`;
  return p;
}

const inside = (child, parent) => {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
};

export const manifestPath = (home) => path.join(home, ".collab", MANIFEST_NAME);

export function readManifest(home) {
  try {
    return JSON.parse(readFileSync(manifestPath(home), "utf8"));
  } catch {
    return null;
  }
}

const version = () => JSON.parse(readFileSync(path.join(REPO, "package.json"), "utf8")).version;

function pathHint(binDir) {
  const norm = (p) => {
    const r = path.resolve(p).replace(/[\\/]+$/, "");
    return process.platform === "win32" ? r.toLowerCase() : r;
  };
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean).map(norm);
  if (dirs.includes(norm(binDir))) return null;
  return process.platform === "win32"
    ? `${binDir} is not on PATH. To run plain "collab", add it under Settings > System > About > Advanced system settings > Environment Variables. Agents use node "$HOME/.collab/bin/collab.mjs" and need no PATH.`
    : `${binDir} is not on PATH. To run plain "collab", add this to your shell profile: export PATH="${binDir}:$PATH". Agents use node "$HOME/.collab/bin/collab.mjs" and need no PATH.`;
}

export function install({ home = homedir(), copy = false, dryRun = false } = {}) {
  home = path.resolve(home);
  if (!existsSync(path.join(SKILL, "SKILL.md"))) throw new InstallError(`skill folder missing: ${SKILL}`, 5);
  const actions = [];
  const notes = [];
  const pre = dryRun ? "[dry run] would " : "";
  const act = (text, fn) => {
    actions.push(`${pre}${text}`);
    if (!dryRun) fn();
  };

  const before = readManifest(home);
  const prevCopies = new Set((before?.links ?? []).filter((l) => l.kind === "copy").map((l) => path.resolve(l.dest)));
  const backups = [...(before?.backups ?? [])];
  const collabDir = path.join(home, ".collab");
  const binDir = path.join(collabDir, "bin");

  const targets = [path.join(home, ".claude", "skills", "collab")];
  if (existsSync(path.join(home, ".codex"))) targets.push(path.join(home, ".codex", "skills", "collab"));
  else notes.push("Codex not found (no ~/.codex); skipped");
  targets.push(path.join(collabDir, "skill"));

  const links = [];
  for (const dest of targets) {
    const kind = copy ? "copy" : "link";
    links.push({ dest, src: SKILL, kind });
    const st = lstatOrNull(dest);
    const cur = linkTarget(dest);
    const ensureParent = () => mkdirSync(path.dirname(dest), { recursive: true });
    if (st && !copy && cur !== null && sameDir(cur, SKILL)) {
      actions.push(`already linked: ${dest}`);
      continue;
    }
    if (st) {
      if (cur !== null) {
        act(`replace ${copy ? "link" : "stale link"} ${dest}`, () => removeLink(dest));
      } else if (prevCopies.has(path.resolve(dest))) {
        // our own earlier copy: safe to replace
        act(`remove previous copy ${dest}`, () => rmSync(dest, { recursive: true, force: true }));
      } else {
        const bak = backupPath(dest);
        act(`back up ${dest} to ${bak}`, () => renameSync(dest, bak));
        backups.push(bak);
      }
    }
    if (copy) {
      act(`copy ${SKILL} to ${dest}`, () => {
        ensureParent();
        cpSync(SKILL, dest, { recursive: true, filter: (p) => !/[\\/](node_modules|\.git)([\\/]|$)/.test(p) });
      });
    } else {
      act(`link ${dest} -> ${SKILL}`, () => {
        ensureParent();
        makeLink(SKILL, dest);
      });
    }
  }

  const launcher = path.join(binDir, "collab.mjs");
  const sh = path.join(binDir, "collab");
  const cmd = path.join(binDir, "collab.cmd");
  act(`write launcher ${launcher}`, () => {
    mkdirSync(binDir, { recursive: true });
    writeFileSync(launcher, LAUNCHER_SOURCE);
  });
  act(`write shims ${sh} and ${cmd}`, () => {
    writeFileSync(sh, SH_SHIM, { mode: 0o755 });
    writeFileSync(cmd, CMD_SHIM);
  });

  const manifest = {
    version: version(),
    repo: REPO,
    mode: copy ? "copy" : "link",
    installedAt: new Date().toISOString(),
    links,
    files: [launcher, sh, cmd],
    backups,
  };
  act(`write manifest ${manifestPath(home)}`, () => writeFileSync(manifestPath(home), JSON.stringify(manifest, null, 2) + "\n"));

  const hint = pathHint(binDir);
  if (hint) notes.push(hint);
  return { ok: true, actions, notes, manifest };
}

export function uninstall({ home = homedir(), dryRun = false } = {}) {
  home = path.resolve(home);
  const actions = [];
  const notes = [];
  const pre = dryRun ? "[dry run] would " : "";
  const act = (text, fn) => {
    actions.push(`${pre}${text}`);
    if (!dryRun) fn();
  };
  const m = readManifest(home);
  if (!m) {
    notes.push(`nothing to uninstall: no manifest at ${manifestPath(home)}`);
    return { ok: true, actions, notes };
  }
  // The manifest is data: only act on paths inside this home.
  const safe = (p) => typeof p === "string" && path.isAbsolute(p) && inside(p, home);

  for (const l of m.links ?? []) {
    if (!safe(l.dest)) {
      notes.push(`skipped ${l.dest}: outside ${home}`);
      continue;
    }
    const st = lstatOrNull(l.dest);
    if (!st) continue;
    if (st.isSymbolicLink()) act(`remove link ${l.dest}`, () => removeLink(l.dest));
    else if (l.kind === "copy" && m.mode === "copy") act(`remove copy ${l.dest}`, () => rmSync(l.dest, { recursive: true, force: true }));
    else notes.push(`left ${l.dest}: not a link we made`);
  }
  for (const f of m.files ?? []) {
    if (!safe(f)) {
      notes.push(`skipped ${f}: outside ${home}`);
      continue;
    }
    const st = lstatOrNull(f);
    if (!st) continue;
    if (st.isSymbolicLink()) act(`remove ${f}`, () => removeLink(f));
    else if (st.isFile()) act(`remove ${f}`, () => rmSync(f, { force: true }));
  }
  act(`remove manifest ${manifestPath(home)}`, () => rmSync(manifestPath(home), { force: true }));
  return { ok: true, actions, notes };
}

export function parseArgs(argv) {
  const o = { home: homedir(), copy: false, dryRun: false, json: false, uninstall: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--home") {
      o.home = argv[++i];
      if (!o.home) throw new InstallError("--home needs a directory");
    } else if (a === "--copy") o.copy = true;
    else if (a === "--dry-run") o.dryRun = true;
    else if (a === "--json") o.json = true;
    else if (a === "--uninstall") o.uninstall = true;
    else throw new InstallError(`unknown option ${a}`);
  }
  return o;
}

export function main(argv, out = console.log, err = console.error) {
  let json = argv.includes("--json");
  try {
    const o = parseArgs(argv);
    json = o.json;
    const r = o.uninstall ? uninstall(o) : install(o);
    if (json) out(JSON.stringify({ ok: r.ok, actions: r.actions, notes: r.notes }, null, 2));
    else {
      for (const a of r.actions) out(a);
      for (const n of r.notes) out(n);
    }
    return 0;
  } catch (e) {
    const code = e instanceof InstallError ? e.code : 1;
    if (json) out(JSON.stringify({ ok: false, actions: [], error: e.message }));
    else err(`install failed: ${e.message}`);
    return code;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
