// Login protection (07 §7.3): ten failures for one account or from one address, each within
// 15 minutes of the last, and every further try waits longer: 1 s, 2 s, 4 s … up to 15 minutes. A
// quiet quarter of an hour (no failure) starts the count over; a success does for the account.
// The same for setup codes.
//
// The count is a streak, not a sliding window: with delays that double, a 15-minute window would
// empty before the delay could reach its 15-minute cap, and a patient guesser would be back to
// one try a second.
export const LIMIT = 10;
export const WINDOW_MS = 15 * 60 * 1000;
export const MAX_DELAY_MS = 15 * 60 * 1000;

export function createThrottle({ now = Date.now, limit = LIMIT, windowMs = WINDOW_MS, maxDelayMs = MAX_DELAY_MS } = {}) {
  const keys = new Map(); // key → { count, last, until }

  // Forget keys gone quiet, so the map stays small.
  function sweep() {
    if (keys.size < 10000) return;
    for (const [key, e] of keys) if (e.until <= now() && now() - e.last > windowMs) keys.delete(key);
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
        let e = keys.get(key);
        if (!e || now() - e.last > windowMs) keys.set(key, (e = { count: 0, last: 0, until: 0 }));
        e.count++;
        e.last = now();
        if (e.count >= limit) e.until = now() + Math.min(maxDelayMs, 1000 * 2 ** Math.min(30, e.count - limit));
      }
    },
    succeed(...list) {
      for (const key of list) keys.delete(key);
    },
  };
}
