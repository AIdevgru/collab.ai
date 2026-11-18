export async function withNow(isoString, fn) {
  const prev = process.env.COLLAB_NOW;
  process.env.COLLAB_NOW = isoString;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.COLLAB_NOW;
    else process.env.COLLAB_NOW = prev;
  }
}
