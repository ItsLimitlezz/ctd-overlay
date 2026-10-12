// Secrets at rest (07 §7.7): AES-256-GCM with the master key, a random 96-bit nonce per value and
// the record's id as associated data, so a ciphertext can't be moved to another record. Each
// carries its key's id, so the key can be rotated:
//
//   enc:v1:<key id>:<nonce, base64url>:<ciphertext and tag, base64url>
//
// The 32-byte master key comes from SKP_MASTER_KEY (base64) or SKP_MASTER_KEY_FILE; with neither,
// the platform makes one in the config directory (master.key, 0600), deliberately outside the data
// directory, and says so: a backup of the data without the key can't decrypt its secrets.
// `skp key rotate` re-encrypts every secret with a new key; until it finishes, the keys beside
// master.key (master.key.next, master.key.*.retired) still decrypt.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, openSync, readdirSync, readFileSync, renameSync, writeSync } from 'node:fs';
import path from 'node:path';

export const KEY_FILE = 'master.key';
const PREFIX = 'enc:v1:';
const KEY_TEXT = /^[A-Za-z0-9+/]{43}=$/;

export class SecretsError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SecretsError';
  }
}

export const keyId = (key) => createHash('sha256').update(key).digest('hex').slice(0, 8);

function parseKey(text, where) {
  const t = String(text).trim();
  const key = KEY_TEXT.test(t) ? Buffer.from(t, 'base64') : null;
  if (!key || key.length !== 32) throw new SecretsError(`${where} must hold a 32-byte key in base64 (44 characters ending in "=").`);
  return key;
}

// Writes a key file atomically, readable by its owner only.
export function writeKeyFile(file, key) {
  const tmp = `${file}.tmp-${process.pid}`;
  const fd = openSync(tmp, 'w', 0o600);
  try {
    writeSync(fd, `${key.toString('base64')}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
}

// The master key and any older ones still needed to decrypt: { key, kid, ring, source, file }.
export function loadMasterKey(config, { log, create = true } = {}) {
  let key;
  let source;
  let file;
  if (config.masterKey) {
    key = parseKey(config.masterKey, 'SKP_MASTER_KEY');
    source = 'SKP_MASTER_KEY';
  } else if (config.masterKeyFile) {
    file = config.masterKeyFile;
    let text;
    try { text = readFileSync(file, 'utf8'); } catch (err) { throw new SecretsError(`Can't read the master key file ${file} (${err.code || err.message}).`); }
    key = parseKey(text, file);
    source = 'SKP_MASTER_KEY_FILE';
  } else {
    file = path.join(config.configDir, KEY_FILE);
    if (existsSync(file)) {
      key = parseKey(readFileSync(file, 'utf8'), file);
    } else if (create) {
      key = randomBytes(32);
      writeKeyFile(file, key);
      log?.warn(`Made a new master key in ${file}. It decrypts the secrets in the data directory: back it up, separately from the data (a backup of the data alone can't be decrypted).`, { file });
    } else {
      throw new SecretsError(`There is no master key in ${config.configDir}.`);
    }
    source = 'file';
  }
  // Older keys beside it, for what a rotation hasn't re-encrypted yet.
  const ring = new Map([[keyId(key), key]]);
  const dir = file ? path.dirname(file) : config.configDir;
  const base = file ? path.basename(file) : KEY_FILE;
  let names = [];
  try { names = readdirSync(dir); } catch { /* no directory: no older keys */ }
  for (const name of names) {
    if (name !== `${base}.next` && !(name.startsWith(`${base}.`) && name.endsWith('.retired'))) continue;
    try {
      const k = parseKey(readFileSync(path.join(dir, name), 'utf8'), name);
      if (!ring.has(keyId(k))) ring.set(keyId(k), k);
    } catch (err) {
      log?.warn('an older master key could not be read', { file: name, err: err.message });
    }
  }
  return { key, kid: keyId(key), ring, source, file };
}

export const isEncrypted = (value) => typeof value === 'string' && value.startsWith(PREFIX);

// encrypt(plain, aad) and decrypt(text, aad) with the current key (and the ring, to decrypt).
export function createSecrets({ key, ring = new Map([[keyId(key), key]]) }) {
  const kid = keyId(key);
  return {
    kid,
    encrypt(plain, aad) {
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      cipher.setAAD(Buffer.from(String(aad)));
      const body = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final(), cipher.getAuthTag()]);
      return `${PREFIX}${kid}:${nonce.toString('base64url')}:${body.toString('base64url')}`;
    },
    decrypt(text, aad) {
      const m = /^enc:v1:([0-9a-f]{8}):([A-Za-z0-9_-]{16}):([A-Za-z0-9_-]{22,})$/.exec(String(text));
      if (!m) throw new SecretsError('not an encrypted value');
      const k = ring.get(m[1]);
      if (!k) throw new SecretsError(`encrypted with a key this platform doesn't have (key id ${m[1]}): restore that master key`);
      const body = Buffer.from(m[3], 'base64url');
      const decipher = createDecipheriv('aes-256-gcm', k, Buffer.from(m[2], 'base64url'));
      decipher.setAAD(Buffer.from(String(aad)));
      decipher.setAuthTag(body.subarray(body.length - 16));
      try {
        return Buffer.concat([decipher.update(body.subarray(0, body.length - 16)), decipher.final()]).toString('utf8');
      } catch {
        throw new SecretsError('an encrypted value doesn\'t decrypt: it was changed, or belongs to another record');
      }
    },
    keyIdOf: (text) => /^enc:v1:([0-9a-f]{8}):/.exec(String(text))?.[1],
  };
}
