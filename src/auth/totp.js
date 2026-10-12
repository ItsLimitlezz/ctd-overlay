// Two-factor codes (07 §7.4): TOTP per RFC 6238 with SHA-1, 6 digits and 30-second steps,
// accepting one step either side; and base32 (RFC 4648, no padding) for the shared secret.
import { createHmac, randomBytes } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const STEP_S = 30;
export const DIGITS = 6;

export function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s) {
  const clean = String(s).toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error('not base32');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function newSecret() {
  return base32Encode(randomBytes(20)); // 160 bits, as RFC 4226 recommends
}

// The code for one counter value (RFC 4226 dynamic truncation).
export function hotp(secret, counter, digits = DIGITS) {
  const key = Buffer.isBuffer(secret) ? secret : base32Decode(secret);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', key).update(msg).digest();
  const offset = mac[mac.length - 1] & 15;
  const n = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return String(n).padStart(digits, '0');
}

export const stepAt = (ms) => Math.floor(ms / 1000 / STEP_S);

// The step a code matches at time ms (now, or one step either side), or undefined. A code whose
// step is not after `lastStep` was used already (replay) and doesn't match.
export function verifyTotp(secret, code, ms, { lastStep = -1 } = {}) {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code.trim())) return undefined;
  const c = code.trim();
  const now = stepAt(ms);
  for (const step of [now - 1, now, now + 1]) {
    if (step > lastStep && hotp(secret, step) === c) return step;
  }
  return undefined;
}

export function otpauthUri(secret, account, issuer = 'Stream Kit') {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_S}`;
}
