// Pushed events arrive twice (a webhook retried, a stream resumed a little before where it left
// off, a backfill overlapping live chat): a connection remembers the service's message ids for at
// least 10 minutes (06 §6.1). Kept per connection, across restarts of its instance, in memory only:
// at most `max` ids, the oldest forgotten first.
export function createDedupe({ ttlMs = 10 * 60 * 1000, max = 20000, now = Date.now } = {}) {
  const seen = new Map(); // key → when, oldest first
  const prune = () => {
    const t = now();
    for (const [k, at] of seen) {
      if (t - at < ttlMs && seen.size <= max) break;
      seen.delete(k);
    }
  };
  return {
    // true when key was seen within the window (a duplicate); otherwise remembers it.
    seen(key) {
      const k = String(key);
      prune();
      if (seen.has(k)) return true;
      seen.set(k, now());
      prune();
      return false;
    },
    has: (key) => { prune(); return seen.has(String(key)); },
    get size() { return seen.size; },
    clear: () => seen.clear(),
  };
}
