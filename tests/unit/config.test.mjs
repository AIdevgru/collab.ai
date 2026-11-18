import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULTS, loadRepoConfig, parseCmd, resolveCmd, childEnv } from "../../skills/collab/lib/config.mjs";
import { EXIT } from "../../skills/collab/lib/errors.mjs";
import { makeRepo, sh } from "../helpers/bare-remote.mjs";

// An in-memory origin/<default>: { path: text }. Records which refs were read.
function memIo(files) {
  const refs = new Set();
  return {
    refs,
    showFile: (_cwd, ref, p) => (refs.add(ref), Object.hasOwn(files, p) ? files[p] : null),
    lsFiles: (_cwd, ref) => (refs.add(ref), Object.keys(files)),
  };
}

const pkg = (scripts) => JSON.stringify({ name: "x", scripts });

test("auto-detects verifyCmd from scripts.test and setupCmd from the lockfile", () => {
  const io = memIo({ "package.json": pkg({ test: "node --test" }), "package-lock.json": "{}" });
  const cfg = loadRepoConfig("/repo", "main", io);
  assert.deepEqual(cfg.verifyCmd, ["npm", "test"]);
  assert.deepEqual(cfg.setupCmd, ["npm", "ci"]);
  assert.deepEqual(cfg.warnings, []);
  for (const [k, v] of Object.entries(DEFAULTS)) assert.equal(cfg[k], v, k);
  assert.deepEqual([...io.refs], ["origin/main"]);
});

test("setupCmd follows pnpm and yarn lockfiles, and is null without one", () => {
  const setup = (files) => loadRepoConfig("/repo", "trunk", memIo(files)).setupCmd;
  assert.deepEqual(setup({ "pnpm-lock.yaml": "" }), ["pnpm", "install", "--frozen-lockfile"]);
  assert.deepEqual(setup({ "yarn.lock": "" }), ["yarn", "install", "--frozen-lockfile"]);
  assert.equal(setup({ "README.md": "" }), null);
  assert.equal(setup({ "sub/package-lock.json": "" }), null); // root lockfile only
});

test("verifyCmd is null without a test script, or with npm's placeholder", () => {
  const verify = (files) => loadRepoConfig("/repo", "main", memIo(files)).verifyCmd;
  assert.equal(verify({}), null);
  assert.equal(verify({ "package.json": pkg({ build: "tsc" }) }), null);
  assert.equal(verify({ "package.json": pkg({ test: 'echo "Error: no test specified" && exit 1' }) }), null);
  const bad = loadRepoConfig("/repo", "main", memIo({ "package.json": "{oops" }));
  assert.equal(bad.verifyCmd, null);
  assert.match(bad.warnings[0], /package\.json/);
});

test(".collab.json overrides defaults, parses commands to argv, and warns about unknown or bad keys", () => {
  const io = memIo({
    ".collab.json": JSON.stringify({
      verifyCmd: "  node --test   tests/ ",
      setupCmd: ["pnpm", "install", "--frozen-lockfile"],
      leaseMin: 30,
      worktreeRoot: "../wt",
      wip: 1.5,
      reviewAlertH: "soon",
      deploy: "rm -rf /",
    }),
    "package.json": pkg({ test: "jest" }),
    "package-lock.json": "{}",
  });
  const cfg = loadRepoConfig("/repo", "main", io);
  assert.deepEqual(cfg.verifyCmd, ["node", "--test", "tests/"]);
  assert.deepEqual(cfg.setupCmd, ["pnpm", "install", "--frozen-lockfile"]);
  assert.equal(cfg.leaseMin, 30);
  assert.equal(cfg.worktreeRoot, "../wt");
  assert.equal(cfg.wip, DEFAULTS.wip);
  assert.equal(cfg.reviewAlertH, DEFAULTS.reviewAlertH);
  assert.equal(cfg.deploy, undefined);
  assert.equal(cfg.warnings.length, 3);
  assert.ok(cfg.warnings.some((w) => /unknown key "deploy" ignored/.test(w)));
  assert.ok(cfg.warnings.some((w) => /"wip" must be a positive whole number/.test(w)));
  assert.ok(cfg.warnings.some((w) => /"reviewAlertH" must be a positive number/.test(w)));
});

test(".collab.json can switch a command off with null, and a bad command type falls back to auto-detect", () => {
  const io = memIo({
    ".collab.json": JSON.stringify({ verifyCmd: null, setupCmd: 42 }),
    "package.json": pkg({ test: "jest" }),
    "yarn.lock": "",
  });
  const cfg = loadRepoConfig("/repo", "main", io);
  assert.equal(cfg.verifyCmd, null);
  assert.deepEqual(cfg.setupCmd, ["yarn", "install", "--frozen-lockfile"]);
  assert.match(cfg.warnings[0], /"setupCmd" must be a string/);
});

test("an unreadable .collab.json is an ENV error that says where to fix it", () => {
  for (const text of ["{nope", "[1,2]", "null"]) {
    assert.throws(() => loadRepoConfig("/repo", "main", memIo({ ".collab.json": text })), (e) => e.code === EXIT.ENV && /default branch/.test(e.message), text);
  }
});

test("parseCmd splits strings on whitespace and keeps arrays as-is", () => {
  assert.deepEqual(parseCmd("npm run test:ci"), ["npm", "run", "test:ci"]);
  assert.deepEqual(parseCmd(["node", "a b.js"]), ["node", "a b.js"]);
  assert.equal(parseCmd(""), null);
  assert.equal(parseCmd(null), null);
  assert.equal(parseCmd({}), undefined);
  assert.equal(parseCmd(["ok", 1]), undefined);
});

test("resolveCmd passes argv straight through off Windows", () => {
  assert.deepEqual(resolveCmd(["npm", "test"], "linux"), { cmd: "npm", args: ["test"], shell: false });
  assert.deepEqual(resolveCmd(["node", "--test"], "darwin"), { cmd: "node", args: ["--test"], shell: false });
  assert.equal(resolveCmd([], "linux"), null);
  assert.equal(resolveCmd(null, "linux"), null);
});

test("resolveCmd on win32 runs npm/pnpm/yarn .cmd shims through cmd.exe without a shell", () => {
  const env = { ComSpec: "C:\\Windows\\system32\\cmd.exe" };
  assert.deepEqual(resolveCmd(["npm", "test"], "win32", env), { cmd: env.ComSpec, args: ["/d", "/s", "/c", "npm.cmd", "test"], shell: false });
  assert.deepEqual(resolveCmd(["pnpm", "install", "--frozen-lockfile"], "win32", env).args, ["/d", "/s", "/c", "pnpm.cmd", "install", "--frozen-lockfile"]);
  assert.deepEqual(resolveCmd(["Yarn", "install"], "win32", env).args, ["/d", "/s", "/c", "Yarn.cmd", "install"]);
  assert.deepEqual(resolveCmd(["scripts\\build.cmd"], "win32", env).args, ["/d", "/s", "/c", "scripts\\build.cmd"]);
  assert.equal(resolveCmd(["npm", "ci"], "win32", {}).cmd, "cmd.exe");
  assert.deepEqual(resolveCmd(["node", "--test"], "win32", env), { cmd: "node", args: ["--test"], shell: false });
});

test("resolveCmd refuses cmd.exe metacharacters rather than escaping them", () => {
  for (const bad of ["a&b", "x|y", ">out", "%PATH%", '"q"', "^"]) {
    assert.throws(() => resolveCmd(["npm", "run", bad], "win32", {}), (e) => e.code === EXIT.PRECONDITION && /package\.json script/.test(e.message), bad);
  }
  assert.doesNotThrow(() => resolveCmd(["node", "a&b"], "win32", {})); // no cmd.exe involved
});

test("loadRepoConfig reads .collab.json and package.json at origin/<default>, not the working tree", () => {
  const repo = makeRepo();
  try {
    const a = repo.clone("a");
    writeFileSync(join(a, ".collab.json"), JSON.stringify({ verifyCmd: "node --test", leaseMin: 45 }));
    writeFileSync(join(a, "package-lock.json"), "{}");
    sh(["add", "-A"], a);
    sh(["commit", "--quiet", "-m", "config"], a);
    sh(["push", "--quiet", "origin", "main"], a);
    sh(["fetch", "--quiet", "origin"], a);
    // A local, unpushed edit must not count.
    writeFileSync(join(a, ".collab.json"), JSON.stringify({ verifyCmd: "evil" }));
    const cfg = loadRepoConfig(a, "main");
    assert.deepEqual(cfg.verifyCmd, ["node", "--test"]);
    assert.deepEqual(cfg.setupCmd, ["npm", "ci"]);
    assert.equal(cfg.leaseMin, 45);
  } finally {
    repo.cleanup();
  }
});

test("childEnv strips stray quotes from PATH entries on Windows only", () => {
  const env = { Path: 'C:\a;C:\Pkg\bin";C:\Program Files\nodejs;;', OTHER: 'x"y' };
  const win = childEnv(env, "win32");
  assert.equal(win.Path, "C:\a;C:\Pkg\bin;C:\Program Files\nodejs");
  assert.equal(win.OTHER, 'x"y');
  assert.equal(childEnv(env, "linux").Path, env.Path);
  assert.notEqual(childEnv(env, "win32"), env, "returns a copy");
});

test("passEnv: a list of variable names from the default branch's .collab.json, or a warning", () => {
  const io = (json) => ({ showFile: (cwd, ref, p) => (p === ".collab.json" ? JSON.stringify(json) : null), lsFiles: () => [] });
  const good = loadRepoConfig("/repo", "main", io({ passEnv: ["NPM_TOKEN", "DB_PASSWORD"] }));
  assert.deepEqual(good.passEnv, ["NPM_TOKEN", "DB_PASSWORD"]);
  assert.deepEqual(good.warnings, []);
  for (const bad of ["NPM_TOKEN", [1], ["A B"], { a: 1 }]) {
    const cfg = loadRepoConfig("/repo", "main", io({ passEnv: bad }));
    assert.equal(cfg.passEnv, undefined);
    assert.ok(cfg.warnings.some((w) => /"passEnv" must be an array of environment variable names/.test(w)), JSON.stringify(bad));
  }
  assert.equal(loadRepoConfig("/repo", "main", io({})).passEnv, undefined);
});

test("commandEnv removes variables that look like secrets, except the ones in passEnv", async () => {
  const { commandEnv } = await import("../../skills/collab/lib/cli.mjs");
  const env = {
    PATH: "/bin", HOME: "/home/z", NODE_ENV: "test", CI: "1", GIT_AUTHOR_NAME: "z", KEYBOARD: "us", PATTERN: "x", AUTHOR: "z",
    PWD: "/repo", OLDPWD: "/", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "safe.directory", GIT_CONFIG_VALUE_0: "*", COMPASS: "n",
    MYSQL_PWD: "p", DB_PASS: "p", REDIS_PASS_FILE: "/p", COLLAB_RELAY_KEY: "k",
    GH_TOKEN: "t", GITHUB_TOKEN: "t", NPM_TOKEN: "t", ANTHROPIC_API_KEY: "k", OPENAI_API_KEY: "k", OPENAI_APIKEY: "k", AWS_SECRET_ACCESS_KEY: "k",
    AWS_ACCESS_KEY_ID: "k", DB_PASSWORD: "p", PGPASSWD: "p", CLAUDE_CODE_OAUTH_TOKEN: "t", SSH_AUTH_SOCK: "/tmp/s", NODE_AUTH_TOKEN: "t",
    GOOGLE_APPLICATION_CREDENTIALS: "/c.json", SIGNING_KEY: "k", MY_PAT: "p", TLS_PRIVATE_KEY_FILE: "/k",
  };
  const kept = ["PATH", "HOME", "NODE_ENV", "CI", "GIT_AUTHOR_NAME", "KEYBOARD", "PATTERN", "AUTHOR", "PWD", "OLDPWD", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0", "COMPASS"];
  const out = commandEnv(env);
  assert.deepEqual(Object.keys(out).sort(), [...kept].sort());
  const passed = commandEnv(env, ["npm_token", "DB_PASSWORD"]);
  assert.equal(passed.NPM_TOKEN, "t");
  assert.equal(passed.DB_PASSWORD, "p");
  assert.equal(passed.GH_TOKEN, undefined);
});
