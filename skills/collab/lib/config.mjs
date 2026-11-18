// Repo config. Commands that run code come only from the default branch, which agents can't
// merge into: .collab.json and package.json are read at origin/<default>, never from a worktree.

import { CollabError, EXIT } from "./errors.mjs";
import { lsFiles, showFile } from "./git.mjs";

export const DEFAULTS = Object.freeze({ leaseMin: 90, reviewLeaseMin: 60, planLeaseMin: 15, reviewAlertH: 2, maxTasks: 12, wip: 1, worktreeRoot: ".collab/wt" });

const CMD_KEYS = ["verifyCmd", "setupCmd"];
const INTEGER_KEYS = new Set(["maxTasks", "wip"]);
const NPM_PLACEHOLDER = /no test specified/i;
const LOCKFILES = [
  ["package-lock.json", ["npm", "ci"]],
  ["pnpm-lock.yaml", ["pnpm", "install", "--frozen-lockfile"]],
  ["yarn.lock", ["yarn", "install", "--frozen-lockfile"]],
];

// `io` exists for tests; it defaults to git.mjs reading origin/<defaultBranch>.
// Returns DEFAULTS merged with .collab.json, plus verifyCmd/setupCmd as argv arrays (or null)
// and warnings[] for anything ignored. Quotes in command strings are not supported: a string is
// split on whitespace. Use an array, or a package.json script, for anything more complex.
export function loadRepoConfig(cwd, defaultBranch, io = { showFile, lsFiles }) {
  const ref = `origin/${defaultBranch}`;
  const read = (p) => io.showFile(cwd, ref, p);
  const warnings = [];
  const config = { ...DEFAULTS };

  const raw = read(".collab.json");
  let user = {};
  if (raw !== null && raw !== undefined) {
    try {
      user = JSON.parse(raw);
    } catch (e) {
      throw new CollabError(EXIT.ENV, `.collab.json on ${ref} is not valid JSON (${e.message}). Fix it on the default branch.`);
    }
    if (!user || typeof user !== "object" || Array.isArray(user)) {
      throw new CollabError(EXIT.ENV, `.collab.json on ${ref} must hold a JSON object. Fix it on the default branch.`);
    }
  }

  for (const [key, value] of Object.entries(user)) {
    if (CMD_KEYS.includes(key)) continue;
    // Variables the test and setup commands may see although their names look like secrets
    // (say NPM_TOKEN for a private registry). It comes from the default branch, like the commands.
    if (key === "passEnv") {
      if (Array.isArray(value) && value.every((s) => typeof s === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(s))) config.passEnv = [...value];
      else warnings.push('.collab.json: "passEnv" must be an array of environment variable names; ignored');
      continue;
    }
    if (!Object.hasOwn(DEFAULTS, key)) {
      warnings.push(`.collab.json: unknown key "${key}" ignored`);
      continue;
    }
    if (validValue(key, value)) config[key] = value;
    else warnings.push(`.collab.json: "${key}" must be ${describe(key)}; using the default ${JSON.stringify(DEFAULTS[key])}`);
  }

  let pkg = null;
  const auto = {
    verifyCmd: () => {
      pkg ??= readPackageJson(read, warnings);
      const test = pkg?.scripts?.test;
      return typeof test === "string" && test.trim() && !NPM_PLACEHOLDER.test(test) ? ["npm", "test"] : null;
    },
    setupCmd: () => {
      const files = new Set(io.lsFiles(cwd, ref));
      return LOCKFILES.find(([f]) => files.has(f))?.[1].slice() ?? null;
    },
  };

  for (const key of CMD_KEYS) {
    if (!Object.hasOwn(user, key)) {
      config[key] = auto[key]();
      continue;
    }
    const parsed = parseCmd(user[key]);
    if (parsed === undefined) {
      warnings.push(`.collab.json: "${key}" must be a string, an array of strings or null; auto-detecting instead`);
      config[key] = auto[key]();
    } else {
      config[key] = parsed;
    }
  }

  config.warnings = warnings;
  return config;
}

function validValue(key, value) {
  if (typeof DEFAULTS[key] === "string") return typeof value === "string" && value.trim() !== "";
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return false;
  return !INTEGER_KEYS.has(key) || Number.isInteger(value);
}

const describe = (key) => (typeof DEFAULTS[key] === "string" ? "a non-empty string" : INTEGER_KEYS.has(key) ? "a positive whole number" : "a positive number");

function readPackageJson(read, warnings) {
  const raw = read("package.json");
  if (raw === null || raw === undefined) return null;
  try {
    return JSON.parse(raw);
  } catch {
    warnings.push("package.json on the default branch is not valid JSON; verifyCmd not auto-detected");
    return null;
  }
}

// string -> split on whitespace; array of strings -> copy; null/false/"" -> null (disabled);
// anything else -> undefined (invalid).
export function parseCmd(value) {
  if (value === null || value === false) return null;
  if (typeof value === "string") {
    const argv = value.trim().split(/\s+/).filter(Boolean);
    return argv.length ? argv : null;
  }
  if (Array.isArray(value) && value.every((s) => typeof s === "string")) {
    return value.length ? value.slice() : null;
  }
  return undefined;
}

const WIN_SHIMS = new Set(["npm", "npx", "pnpm", "yarn"]);
const CMD_META = /[&|<>^%"]/;

// Turns an argv array into spawnSync arguments, always with shell: false.
// On Windows npm, pnpm and yarn are .cmd shims, and since the CVE-2024-27980 fix Node refuses
// to spawn a .cmd or .bat file without a shell (EINVAL). So they run as
// `cmd.exe /d /s /c npm.cmd ...`: /d skips AutoRun, /s keeps cmd's quote handling predictable.
// cmd.exe still interprets & | < > ^ % and quotes in that line, so arguments holding them are
// refused rather than escaped; put such a command in a package.json script instead.
export function resolveCmd(argv, platform = process.platform, env = process.env) {
  if (!Array.isArray(argv) || argv.length === 0) return null;
  const [first, ...rest] = argv;
  if (platform !== "win32") return { cmd: first, args: rest, shell: false };
  const lower = first.toLowerCase();
  const isBatch = /\.(cmd|bat)$/.test(lower);
  if (!WIN_SHIMS.has(lower) && !isBatch) return { cmd: first, args: rest, shell: false };
  const target = isBatch ? first : `${first}.cmd`;
  const bad = [target, ...rest].find((a) => CMD_META.test(a));
  if (bad !== undefined) {
    throw new CollabError(EXIT.PRECONDITION, `the command argument "${bad}" holds a character cmd.exe would interpret (& | < > ^ % "). Put the command in a package.json script and call that script instead.`);
  }
  return { cmd: env.ComSpec || env.COMSPEC || "cmd.exe", args: ["/d", "/s", "/c", target, ...rest], shell: false };
}

// A PATH entry with a stray quote (some installers leave one in the machine PATH) makes cmd.exe
// misread every later entry, so npm.cmd and friends are "not recognized". Children get PATH
// entries with quotes removed.
export function childEnv(env = process.env, platform = process.platform) {
  const out = { ...env };
  if (platform !== "win32") return out;
  for (const k of Object.keys(out)) {
    if (k.toLowerCase() === "path" && typeof out[k] === "string") {
      out[k] = out[k].split(";").map((p) => p.replace(/"/g, "").trim()).filter(Boolean).join(";");
    }
  }
  return out;
}
