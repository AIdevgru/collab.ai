// Exit codes and the one error type every module throws on purpose.
// Anything else that escapes is a bug (exit 1).

export const EXIT = Object.freeze({ OK: 0, BUG: 1, PRECONDITION: 2, CONTENTION: 3, UNSUPPORTED: 4, ENV: 5 });

export class CollabError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "CollabError";
    this.code = code;
    this.details = details;
  }
}

export function fail(code, message, details) {
  throw new CollabError(code, message, details);
}

export const isCollabError = (e) => e instanceof CollabError || e?.name === "CollabError";
