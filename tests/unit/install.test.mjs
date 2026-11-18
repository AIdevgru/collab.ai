import assert from "node:assert/strict";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SKILL, install, linkTarget, uninstall } from "../../scripts/install.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const INSTALL_CLI = path.join(REPO, "scripts", "install.mjs");
const VERSION = JSON.parse(readFileSync(path.join(REPO, "package.json"), "utf8")).version;
const isLink = (p) => {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
};
const same = (a, b) => realpathSync(a).toLowerCase() === realpathSync(b).toLowerCase();

// Every link under home is removed before the recursive rm, so a junction can never take SKILL with it.
function cleanup(home) {
  for (const rel of [".claude/skills/collab", ".codex/skills/collab", ".collab/skill"]) {
    const p = path.join(home, rel);
    if (isLink(p)) unlinkSync(p);
  }
  rmSync(home, { recursive: true, force: true });
}

function withHome(fn, { codex = true } = {}) {
  const home = mkdtempSync(path.join(tmpdir(), "collab-install-"));
  if (codex) mkdirSync(path.join(home, ".codex"));
  try {
    return fn(home);
  } finally {
    cleanup(home);
  }
}

afterEach(() => {
  assert.ok(existsSync(path.join(SKILL, "SKILL.md")), "skills/collab/SKILL.md must survive every test");
});

const dests = (home) => ({
  claude: path.join(home, ".claude", "skills", "collab"),
  codex: path.join(home, ".codex", "skills", "collab"),
  skill: path.join(home, ".collab", "skill"),
});

describe("install", () => {
  test("fresh install links all three places to SKILL", () =>
    withHome((home) => {
      const r = install({ home });
      assert.equal(r.ok, true);
      for (const d of Object.values(dests(home))) {
        assert.ok(isLink(d), `${d} is a link`);
        assert.ok(same(d, SKILL));
      }
    }));

  test("without ~/.codex only two links and a skip message", () =>
    withHome(
      (home) => {
        const r = install({ home });
        const d = dests(home);
        assert.ok(isLink(d.claude) && isLink(d.skill));
        assert.equal(existsSync(path.join(home, ".codex")), false);
        assert.ok(r.notes.includes("Codex not found (no ~/.codex); skipped"));
        assert.equal(r.manifest.links.length, 2);
      },
      { codex: false },
    ));

  test("running again is a no-op", () =>
    withHome((home) => {
      install({ home });
      const m1 = readFileSync(path.join(home, ".collab", "install.json"), "utf8");
      const r = install({ home });
      assert.equal(r.actions.filter((a) => a.startsWith("already linked")).length, 3);
      assert.equal(r.actions.some((a) => /back up|replace|link .* ->/.test(a)), false);
      assert.deepEqual(JSON.parse(readFileSync(path.join(home, ".collab", "install.json"), "utf8")).backups, JSON.parse(m1).backups);
      assert.deepEqual(readdirSync(path.join(home, ".claude", "skills")), ["collab"]);
    }));

  test("a stale link is replaced", () =>
    withHome((home) => {
      const other = mkdtempSync(path.join(tmpdir(), "collab-other-"));
      try {
        writeFileSync(path.join(other, "keep.txt"), "x");
        const d = dests(home);
        mkdirSync(path.dirname(d.claude), { recursive: true });
        symlinkSync(other, d.claude, process.platform === "win32" ? "junction" : "dir");
        assert.ok(!same(d.claude, SKILL));
        install({ home });
        assert.ok(same(d.claude, SKILL));
        assert.ok(existsSync(path.join(other, "keep.txt")), "the old link's target is untouched");
      } finally {
        rmSync(other, { recursive: true, force: true });
      }
    }));

  test("a real directory at the destination is backed up", () =>
    withHome((home) => {
      const d = dests(home);
      mkdirSync(d.claude, { recursive: true });
      writeFileSync(path.join(d.claude, "mine.txt"), "mine");
      const r = install({ home });
      assert.ok(isLink(d.claude));
      const bak = r.manifest.backups.find((b) => b.startsWith(d.claude + ".bak-"));
      assert.ok(bak, "backup recorded");
      assert.match(path.basename(bak), /^collab\.bak-\d{14}/);
      assert.equal(readFileSync(path.join(bak, "mine.txt"), "utf8"), "mine");
    }));

  test("the launcher prints the version through the link", () =>
    withHome((home) => {
      install({ home });
      const launcher = path.join(home, ".collab", "bin", "collab.mjs");
      const text = readFileSync(launcher, "utf8");
      assert.ok(text.startsWith("#!/usr/bin/env node\n"));
      assert.ok(text.includes('await import(new URL("../skill/bin/collab.mjs", import.meta.url));'));
      const r = spawnSync(process.execPath, [launcher, "--version"], { encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout.trim(), `collab ${VERSION}`);
    }));

  test("shims exist and collab.cmd uses CRLF", () =>
    withHome((home) => {
      install({ home });
      const bin = path.join(home, ".collab", "bin");
      const sh = readFileSync(path.join(bin, "collab"), "utf8");
      assert.equal(sh, '#!/bin/sh\nexec node "$HOME/.collab/bin/collab.mjs" "$@"\n');
      if (process.platform !== "win32") assert.equal(lstatSync(path.join(bin, "collab")).mode & 0o777, 0o755);
      const cmd = readFileSync(path.join(bin, "collab.cmd"), "utf8");
      assert.equal(cmd, '@node "%USERPROFILE%\\.collab\\bin\\collab.mjs" %*\r\n');
      assert.equal(cmd.replace(/\r\n/g, "").includes("\n"), false);
    }));

  test("the manifest has the expected shape", () =>
    withHome((home) => {
      install({ home });
      const m = JSON.parse(readFileSync(path.join(home, ".collab", "install.json"), "utf8"));
      assert.equal(m.version, VERSION);
      assert.equal(m.repo, REPO);
      assert.equal(m.mode, "link");
      assert.ok(!Number.isNaN(Date.parse(m.installedAt)));
      assert.equal(m.links.length, 3);
      for (const l of m.links) {
        assert.ok(path.isAbsolute(l.dest));
        assert.equal(l.src, SKILL);
        assert.equal(l.kind, "link");
      }
      assert.deepEqual(m.files.map((f) => path.basename(f)), ["collab.mjs", "collab", "collab.cmd"]);
      assert.deepEqual(m.backups, []);
    }));

  test("--copy copies, is re-runnable, and replaces only its own copy", () =>
    withHome((home) => {
      const d = dests(home);
      install({ home, copy: true });
      for (const p of Object.values(d)) {
        assert.equal(isLink(p), false);
        assert.ok(existsSync(path.join(p, "SKILL.md")));
      }
      const m = JSON.parse(readFileSync(path.join(home, ".collab", "install.json"), "utf8"));
      assert.equal(m.mode, "copy");
      assert.ok(m.links.every((l) => l.kind === "copy"));
      writeFileSync(path.join(d.claude, "stray.txt"), "ours, will be replaced");
      const r = install({ home, copy: true });
      assert.equal(existsSync(path.join(d.claude, "stray.txt")), false);
      assert.deepEqual(r.manifest.backups, [], "own previous copy is deleted, not backed up");
      assert.ok(existsSync(path.join(SKILL, "SKILL.md")));
    }));

  test("--dry-run changes nothing", () =>
    withHome((home) => {
      const r = install({ home, dryRun: true });
      assert.ok(r.actions.length > 0);
      assert.ok(r.actions.every((a) => a.startsWith("[dry run] would ") || a.startsWith("already")));
      assert.deepEqual(readdirSync(home), [".codex"]);
      install({ home });
      const r2 = uninstall({ home, dryRun: true });
      assert.ok(r2.actions.length > 0);
      assert.ok(isLink(dests(home).claude));
      assert.ok(existsSync(path.join(home, ".collab", "install.json")));
    }));

  test("the CLI honors --home, --json, --dry-run and exits 0", () =>
    withHome((home) => {
      const dry = spawnSync(process.execPath, [INSTALL_CLI, "--home", home, "--dry-run", "--json"], { encoding: "utf8" });
      assert.equal(dry.status, 0, dry.stderr);
      const j = JSON.parse(dry.stdout);
      assert.equal(j.ok, true);
      assert.ok(Array.isArray(j.actions) && j.actions.length > 0);
      assert.equal(existsSync(path.join(home, ".collab")), false);
      const run = spawnSync(process.execPath, [INSTALL_CLI, "--home", home], { encoding: "utf8" });
      assert.equal(run.status, 0, run.stderr);
      assert.ok(isLink(dests(home).claude));
      const bad = spawnSync(process.execPath, [INSTALL_CLI, "--nope"], { encoding: "utf8" });
      assert.equal(bad.status, 1);
    }));
});

describe("uninstall", () => {
  test("removes only manifest items and keeps runs/ agents/ archive/", () =>
    withHome((home) => {
      install({ home });
      const c = path.join(home, ".collab");
      for (const d of ["runs", "agents", "archive"]) {
        mkdirSync(path.join(c, d), { recursive: true });
        writeFileSync(path.join(c, d, "keep.txt"), d);
      }
      writeFileSync(path.join(c, "bin", "mine.txt"), "not ours");
      writeFileSync(path.join(home, ".claude", "skills", "other.txt"), "not ours");
      const r = uninstall({ home });
      assert.ok(r.actions.length >= 6);
      const d = dests(home);
      for (const p of Object.values(d)) assert.equal(lstatOrNull(p), null);
      assert.ok(existsSync(path.join(SKILL, "SKILL.md")) && existsSync(path.join(SKILL, "bin", "collab.mjs")), "link targets survive");
      for (const f of ["collab.mjs", "collab", "collab.cmd"]) assert.equal(existsSync(path.join(c, "bin", f)), false);
      assert.equal(existsSync(path.join(c, "install.json")), false);
      for (const x of ["runs", "agents", "archive"]) assert.equal(readFileSync(path.join(c, x, "keep.txt"), "utf8"), x);
      assert.ok(existsSync(path.join(c, "bin", "mine.txt")));
      assert.ok(existsSync(path.join(home, ".claude", "skills", "other.txt")));
    }));

  test("copy mode uninstall deletes the copies; link mode never deletes a real directory", () =>
    withHome((home) => {
      install({ home, copy: true });
      uninstall({ home });
      for (const p of Object.values(dests(home))) assert.equal(lstatOrNull(p), null);
      install({ home });
      const d = dests(home);
      unlinkSync(d.claude);
      mkdirSync(d.claude);
      writeFileSync(path.join(d.claude, "user.txt"), "u");
      const r = uninstall({ home });
      assert.ok(existsSync(path.join(d.claude, "user.txt")));
      assert.ok(r.notes.some((n) => n.includes("not a link we made")));
    }));

  test("ignores manifest paths outside home", () =>
    withHome((home) => {
      install({ home });
      const outside = mkdtempSync(path.join(tmpdir(), "collab-outside-"));
      try {
        writeFileSync(path.join(outside, "x.txt"), "x");
        const mp = path.join(home, ".collab", "install.json");
        const m = JSON.parse(readFileSync(mp, "utf8"));
        m.files.push(path.join(outside, "x.txt"));
        m.links.push({ dest: outside, src: SKILL, kind: "copy" });
        writeFileSync(mp, JSON.stringify(m));
        uninstall({ home });
        assert.ok(existsSync(path.join(outside, "x.txt")));
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    }));

  test("with no manifest it does nothing", () =>
    withHome((home) => {
      const r = uninstall({ home });
      assert.equal(r.ok, true);
      assert.equal(r.actions.length, 0);
    }));
});

function lstatOrNull(p) {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
}

test("linkTarget is null for a real directory", () => {
  assert.equal(linkTarget(SKILL), null);
  assert.equal(typeof cpSync, "function");
});
