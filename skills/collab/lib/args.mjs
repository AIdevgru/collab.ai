// Tiny argv parser: `cmd pos... --flag value --bool`. No dependencies.

const BOOLEANS = new Set([
  "json", "dry-run", "steal", "allow-overlap", "owner", "approve", "changes", "print", "write",
  "help", "offline", "no-dashboard", "force", "once", "purge", "stat", "allow-protected",
  "peek", "all", "withdraw", "raw",
]);

export function parseArgs(argv) {
  const out = { cmd: null, pos: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") { out.pos.push(...argv.slice(i + 1)); break; }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const key = (eq > 0 ? a.slice(2, eq) : a.slice(2));
      if (eq > 0) out.flags[key] = a.slice(eq + 1);
      else if (BOOLEANS.has(key)) out.flags[key] = true;
      else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) out.flags[key] = argv[++i];
      else out.flags[key] = true;
    } else if (a === "-h") {
      out.flags.help = true;
    } else if (out.cmd === null) {
      out.cmd = a;
    } else {
      out.pos.push(a);
    }
  }
  return out;
}

export const list = (v) => (v === undefined || v === true ? [] : String(v).split(/[,;]/).map((s) => s.trim()).filter(Boolean));

// "9m", "90s", "2h", "1500" (ms) -> milliseconds
export function duration(v, fallbackMs) {
  if (v === undefined || v === true) return fallbackMs;
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(String(v).trim());
  if (!m) return fallbackMs;
  const n = Number(m[1]);
  return Math.round(n * ({ ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[m[2] ?? "ms"]));
}
