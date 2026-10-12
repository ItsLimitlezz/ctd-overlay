// Login protection (07 §7.3): ten failures for one account or from one address within 15 minutes,
// and each further try waits longer: 1 s, 2 s, 4 s … up to 15 minutes. The same for setup codes.
export const LIMIT = 10;
export const WINDOW_MS = 15 * 60 * 1000;
export const MAX_DELAY_MS = 15 * 60 * 1000;

export function createThrottle({ now = Date.now, limit = LIMIT, windowMs = WINDOW_MS, maxDelayMs = MAX_DELAY_MS } = {}) {
  const keys = new Map(); // key → { fails: [ms], until }

  const entry = (key) => {
    let e = keys.get(key);
    if (!e) keys.set(key, (e = { fails: [], until: 0 }));
    e.fails = e.fails.filter((t) => now() - t < windowMs);
    return e;
  };

  // Forget keys with nothing recent, so the map stays small.
  function sweep() {
    if (keys.size < 10000) return;
    for (const [key, e] of keys) if (e.until <= now() && !e.fails.some((t) => now() - t < windowMs)) keys.delete(key);
  }

  return {
    // How long the caller must wait (ms) before any of these keys may try again: 0 for now.
    wait(...list) {
      let ms = 0;
      for (const key of list) {
        const e = keys.get(key);
        if (e && e.until > now()) ms = Math.max(ms, e.until - now());
      }
      return ms;
    },
    fail(...list) {
      sweep();
      for (const key of list) {
        const e = entry(key);
        e.fails.push(now());
        if (e.fails.length > 100) e.fails.splice(0, e.fails.length - 100);
        if (e.fails.length >= limit) e.until = now() + Math.min(maxDelayMs, 1000 * 2 ** Math.min(30, e.fails.length - limit));
      }
    },
    succeed(...list) {
      for (const key of list) keys.delete(key);
    },
  };
}
