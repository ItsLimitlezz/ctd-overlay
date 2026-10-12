// Passwords (07 §7.3): scrypt at N = 2^17, r = 8, p = 1, a 16-byte salt and a 32-byte hash, stored
// as "scrypt$N=…,r=…,p=…$<salt>$<hash>" so the parameters can be raised later (a login under old
// ones rehashes). Each hash needs 128 MiB, so hashing runs one at a time, in one queue for logins,
// password changes and setup; with more than ten waiting, the next is refused (429).
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const SCRYPT = Object.freeze({ N: 2 ** 17, r: 8, p: 1 });
export const MIN_LENGTH = 12;
export const MAX_LENGTH = 256;
const MAX_WAITING = 10;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;

export class BusyError extends Error {
  constructor(retryAfterS) {
    super('Too many sign-ins are being checked at once. Try again in a moment.');
    this.name = 'BusyError';
    this.code = 'busy';
    this.retryAfterS = retryAfterS;
  }
}

// The common passwords a password may not be (case-insensitive), bundled (no download).
let common;
function commonPasswords() {
  common ??= new Set(readFileSync(new URL('./common-passwords.txt', import.meta.url), 'utf8')
    .split(/\r?\n/).map((l) => l.trim().toLowerCase()).filter((l) => l && !l.startsWith('#')));
  return common;
}

// Why a new password won't do, or undefined (07 §7.3: 12 to 256 characters, not a common
// password, no composition rules). Also refused: the username, and a run of one character or of
// consecutive characters ("aaaaaaaaaaaa", "123456789012", "abcdefghijkl").
export function passwordProblem(password, { username } = {}) {
  if (typeof password !== 'string') return 'The password must be text.';
  const length = [...password].length;
  if (length < MIN_LENGTH) return `The password is too short: use at least ${MIN_LENGTH} characters (a few words make a good one).`;
  if (length > MAX_LENGTH) return `The password is too long: at most ${MAX_LENGTH} characters.`;
  const lower = password.toLowerCase();
  if (username && lower === String(username).toLowerCase()) return 'The password can\'t be the username.';
  if (commonPasswords().has(lower) || trivial(lower)) return 'That password is too common or too easy to guess: pick another.';
  return undefined;
}

function trivial(s) {
  if (new Set(s).size <= 2) return true;
  // Each character one more (or one less) than the last, wrapping 9 → 0: "123456789012".
  const step = (a, b) => {
    const d = b.charCodeAt(0) - a.charCodeAt(0);
    return d === 1 || d === -1 || (a === '9' && b === '0') || (a === '0' && b === '9');
  };
  let run = true;
  for (let i = 1; i < s.length && run; i++) run = step(s[i - 1], s[i]);
  return run;
}

function encode(params, salt, hash) {
  return `scrypt$N=${params.N},r=${params.r},p=${params.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function decode(stored) {
  const m = /^scrypt\$N=(\d+),r=(\d+),p=(\d+)\$([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+)$/.exec(String(stored));
  if (!m) return undefined;
  return { params: { N: Number(m[1]), r: Number(m[2]), p: Number(m[3]) }, salt: Buffer.from(m[4], 'base64'), hash: Buffer.from(m[5], 'base64') };
}

const derive = (password, salt, { N, r, p }) => new Promise((resolve, reject) => {
  // 128 × N × r bytes of working memory: above Node's 32 MiB default, so maxmem says how much.
  scrypt(String(password).normalize('NFC'), salt, KEY_LENGTH, { N, r, p, maxmem: 128 * N * r + 32 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key)));
});

// params: a test hook (lower N for speed); stored hashes keep their own parameters either way.
export function createHasher({ params = SCRYPT, maxWaiting = MAX_WAITING } = {}) {
  let tail = Promise.resolve();
  let waiting = 0;
  let lastMs = 500;
  // One at a time: each call waits for the one before.
  function queued(fn) {
    if (waiting > maxWaiting) return Promise.reject(new BusyError(Math.max(1, Math.ceil((waiting * lastMs) / 1000))));
    waiting++;
    const run = tail.then(async () => {
      const started = Date.now();
      try { return await fn(); } finally {
        waiting--;
        lastMs = Date.now() - started;
      }
    });
    tail = run.catch(() => {});
    return run;
  }
  const self = {
    params,
    get waiting() { return waiting; },
    hash: (password) => queued(async () => {
      const salt = randomBytes(SALT_LENGTH);
      return encode(params, salt, await derive(password, salt, params));
    }),
    // { ok, rehash }: rehash when the stored hash used other parameters than today's.
    verify: (password, stored) => queued(async () => {
      const d = decode(stored);
      if (!d || d.hash.length !== KEY_LENGTH) {
        // Same work as a real check, so a missing or damaged hash takes as long as a wrong password.
        await derive(password, Buffer.alloc(SALT_LENGTH), params);
        return { ok: false, rehash: false };
      }
      const key = await derive(password, d.salt, d.params);
      const ok = timingSafeEqual(key, d.hash);
      return { ok, rehash: ok && (d.params.N !== params.N || d.params.r !== params.r || d.params.p !== params.p) };
    }),
  };
  return self;
}
