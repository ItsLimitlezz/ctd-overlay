// Backoff (01 §1.7, 06 §6.1): a connection that fails starts again after 1 s, 2 s, 4 s … up to
// 5 minutes, each ±20 % so a dozen connections that failed together (the network dropped) don't
// all come back in the same instant.
export const BACKOFF = Object.freeze({ base: 1000, factor: 2, cap: 300000, jitter: 0.2 });
export const MAX_WAIT_MS = 24 * 60 * 60 * 1000; // what a service may ask us to wait, at most

// The wait before attempt `attempt` (0 for the first retry).
export function nextDelay(attempt, { base = BACKOFF.base, factor = BACKOFF.factor, cap = BACKOFF.cap, jitter = BACKOFF.jitter, random = Math.random } = {}) {
  const n = Math.max(0, Math.min(Number.isInteger(attempt) ? attempt : 0, 64));
  const plain = Math.min(cap, base * factor ** n);
  const spread = plain * jitter * (random() * 2 - 1);
  return Math.max(0, Math.round(Math.min(cap * (1 + jitter), plain + spread)));
}

// Retry-After (RFC 9110 §10.2.3): seconds, or an HTTP date. In milliseconds, at most a day; undefined
// when missing or unreadable.
export function parseRetryAfter(value, now = Date.now()) {
  if (value === undefined || value === null) return undefined;
  const s = String(value).trim();
  if (/^\d{1,9}$/.test(s)) return Math.min(Number(s) * 1000, MAX_WAIT_MS);
  const at = Date.parse(s);
  if (!Number.isFinite(at)) return undefined;
  return Math.min(Math.max(0, at - now), MAX_WAIT_MS);
}
