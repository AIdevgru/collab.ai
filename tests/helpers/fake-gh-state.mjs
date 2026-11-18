// State file, lock and test helper for the fake `gh` (tests/helpers/fake-gh.mjs).
//
// State shape (every key optional; missing parts get defaults):
// {
//   user: "zwymer",                         // login `gh api user` returns without GH_TOKEN
//   tokens: { zwymer: "tok-z" },            // `gh auth token --user L`; GH_TOKEN=<token> acts as that login
//   repos: { "o/r": { defaultBranch: "main", allowSquash: true, allowMerge: true, private: true,
//                     protected: ["main"], collaborators: { zwymer: "admin" },
//                     gitDir: "/abs/remote.git" } },   // optional: head SHAs, merges and branch
//                                                       // deletes then use this bare repo
//   pulls: { "o/r#42": { title, body, state: "open"|"closed", merged, draft, headRef, baseRef, headSha,
//                        isCrossRepository, mergeable: "MERGEABLE"|"CONFLICTING"|"UNKNOWN",
//                        ci: "SUCCESS"|"FAILURE"|"ERROR"|"PENDING"|"EXPECTED"|null, checks: 3,
//                        additions, deletions, nodeId } },
//   comments: { "o/r#42": [{ id, login, body, createdAt }] },
//   nextId: 1000,                           // next comment id
//   failures: [{ match: "PUT repos/o/r/pulls/7/merge", status: 500, message: "boom", times: 1 }],
//             // `match` is a substring of "<METHOD> <path>" ("POST graphql" for GraphQL);
//             // status null means a network error; times omitted means every call
//   calls: []                               // appended: { argv, stdin, env: { GH_TOKEN, GITHUB_TOKEN } }
// }

import { closeSync, mkdtempSync, realpathSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const FAKE_GH_PATH = fileURLToPath(new URL("./fake-gh.mjs", import.meta.url));

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function withLock(file, fn, { timeoutMs = 15_000, staleMs = 30_000 } = {}) {
  const lock = `${file}.lock`;
  const deadline = Date.now() + timeoutMs;
  let fd;
  for (;;) {
    try {
      fd = openSync(lock, "wx");
      break;
    } catch (e) {
      if (!["EEXIST", "EPERM", "EACCES", "EBUSY"].includes(e.code)) throw e;
      try {
        if (Date.now() - statSync(lock).mtimeMs > staleMs) rmSync(lock, { force: true });
      } catch {
        // the holder released it meanwhile
      }
      if (Date.now() > deadline) throw new Error(`fake gh: state lock still held after ${timeoutMs} ms: ${lock}`);
      sleep(5 + Math.floor(Math.random() * 20));
    }
  }
  try {
    return fn();
  } finally {
    closeSync(fd);
    rmSync(lock, { force: true });
  }
}

export function readState(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

// Temp file then rename; Windows may briefly refuse the rename while a reader has the file open.
export function writeState(file, state) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  for (let i = 0; ; i++) {
    try {
      renameSync(tmp, file);
      return;
    } catch (e) {
      if (i >= 50 || !["EPERM", "EBUSY", "EACCES"].includes(e.code)) {
        rmSync(tmp, { force: true });
        throw e;
      }
      sleep(10);
    }
  }
}

// Locked read-modify-write. `fn` mutates the state in place (or returns a replacement).
export function updateState(file, fn) {
  return withLock(file, () => {
    const state = readState(file);
    const next = fn(state) ?? state;
    writeState(file, next);
    return next;
  });
}

export function defaultState(initial = {}) {
  return { user: null, tokens: {}, repos: {}, pulls: {}, comments: {}, nextId: 1000, failures: [], calls: [], ...structuredClone(initial) };
}

// makeFakeGh(initialState) -> { env, file, read(), update(fn), calls(), use(), cleanup() }
// `env` holds COLLAB_GH and COLLAB_FAKE_GH_STATE; `use()` puts them in process.env and returns
// a function that restores the previous values.
export function makeFakeGh(initialState = {}) {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "collab-fake-gh-")));
  const file = join(dir, "state.json");
  writeState(file, defaultState(initialState));
  const env = { COLLAB_GH: JSON.stringify([process.execPath, FAKE_GH_PATH]), COLLAB_FAKE_GH_STATE: file };
  return {
    env,
    file,
    read: () => withLock(file, () => readState(file)),
    update: (fn) => updateState(file, fn),
    calls: () => withLock(file, () => readState(file)).calls,
    use() {
      const prev = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
      Object.assign(process.env, env);
      return () => {
        for (const [k, v] of Object.entries(prev)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      };
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
  };
}
