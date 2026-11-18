// All time goes through here so tests can pin it with COLLAB_NOW (an ISO string).

export function now() {
  const pinned = process.env.COLLAB_NOW;
  return pinned ? new Date(pinned) : new Date();
}

export function iso(d = now()) {
  return (d instanceof Date ? d : new Date(d)).toISOString();
}

export function addMinutes(base, minutes) {
  const d = base instanceof Date ? base : new Date(base);
  return new Date(d.getTime() + minutes * 60_000).toISOString();
}

export function minutesBetween(a, b) {
  return (new Date(b).getTime() - new Date(a).getTime()) / 60_000;
}

// "2026-11-16 16:02 UTC" for people.
export function human(d) {
  const s = iso(d);
  return `${s.slice(0, 10)} ${s.slice(11, 16)} UTC`;
}
