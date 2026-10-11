// IDs. Envelopes and resources use ULIDs (02 §2.1): 48 bits of millisecond time and 80 random
// bits in Crockford base32, so they sort by creation time. Resource IDs carry a type prefix
// (03 §3.1), e.g. `ovl_01J9Z6M3Q8T6C9V4PZ7XKQ2N1H`.
import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

// Monotonic: two IDs made in the same millisecond (or after the clock steps back) still sort in
// the order they were made, because the random part is incremented instead of re-drawn.
export function createUlid() {
  let lastTime = -1;
  let lastRandom = null;
  return function ulid(now = Date.now()) {
    if (now <= lastTime) {
      now = lastTime;
      increment(lastRandom);
    } else {
      lastTime = now;
      lastRandom = randomBytes(10);
    }
    return encodeTime(now) + encodeRandom(lastRandom);
  };
}

export const ulid = createUlid();

export function newId(prefix) {
  return `${prefix}_${ulid()}`;
}

// The creation time encoded in a ULID (or a prefixed ID), in epoch milliseconds.
export function ulidTime(id) {
  const u = id.slice(id.lastIndexOf('_') + 1, id.lastIndexOf('_') + 11);
  let t = 0;
  for (const ch of u) t = t * 32 + ALPHABET.indexOf(ch);
  return t;
}

export const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

function encodeTime(t) {
  let s = '';
  for (let i = 0; i < 10; i++) {
    s = ALPHABET[t % 32] + s;
    t = Math.floor(t / 32);
  }
  return s;
}

function encodeRandom(bytes) {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let s = '';
  for (let i = 0; i < 16; i++) {
    s = ALPHABET[Number(n & 31n)] + s;
    n >>= 5n;
  }
  return s;
}

function increment(bytes) {
  for (let i = bytes.length - 1; i >= 0; i--) {
    if (bytes[i] < 255) { bytes[i]++; return; }
    bytes[i] = 0;
  }
  throw new Error('ULID random part overflowed within one millisecond');
}
