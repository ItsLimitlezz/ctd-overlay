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

// Writes a key file atomically, readable by its owner only (POSIX: on Windows the mode doesn't
// apply, and the file takes the config directory's permissions, owner-only in the default
// %LOCALAPPDATA%; config.js warns about a config directory outside the user's profile).
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
    finishRotation(file, log);
    let text;
    try { text = readFileSync(file, 'utf8'); } catch (err) { throw new SecretsError(`Can't read the master key file ${file} (${err.code || err.message}).`); }
    key = parseKey(text, file);
    source = 'SKP_MASTER_KEY_FILE';
  } else {
    file = path.join(config.configDir, KEY_FILE);
    finishRotation(file, log);
    if (existsSync(file)) {
      key = parseKey(readFileSync(file, 'utf8'), file);
    } else if (create) {
      key = randomBytes(32);
      writeKeyFile(file, key);
      log?.warn(`Made a new master key in ${file}. It decrypts the secrets in the data directory: back it up, separately from the data (a backup of the data alone can't be decrypted).`, { file });
    } else {
      throw new SecretsError(`There is no master key in ${config.configDir}. If the platform gets its key from SKP_MASTER_KEY or SKP_MASTER_KEY_FILE, set the same here; the platform makes one in the config directory only when it starts without either.`);
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

// Every encrypted value in the store, with its associated data: overlay keys, TOTP secrets, the
// Twitch and Kick credentials the v0 importer keeps for connections (import/v0.js), and each
// connection's secrets and account tokens (connectors/records.js).
export const ENCRYPTED = Object.freeze([
  ['overlays', [['key', (id) => id]]],
  ['users', [['totp.secret', (id) => `totp:${id}`], ['totpPending.secret', (id) => `totp:${id}`]]],
  ['pending_connections', [['clientSecret', (id) => id]]],
  ['connections', [['secrets', (id) => `connection:${id}`]]],
  ['connection_tokens', [['user', (id) => `tokens:${id}`]]],
]);
function* encryptedFields(store) {
  for (const [collection, fields] of ENCRYPTED) {
    for (let after = ''; ;) {
      const page = store.list(collection, { after, limit: 1000 });
      for (const doc of page) for (const [field, aad] of fields) yield { collection, doc, field, aad: aad(doc.id) };
      if (page.length < 1000) break;
      after = page[page.length - 1].id;
    }
  }
}
const getPath = (o, p) => p.split('.').reduce((v, k) => v?.[k], o);
function setPath(o, p, value) {
  const keys = p.split('.');
  const copy = { ...o };
  let at = copy;
  for (const k of keys.slice(0, -1)) at = at[k] = { ...at[k] };
  at[keys.at(-1)] = value;
  return copy;
}

// `skp key rotate` (07 §7.7), with the platform stopped: a new master key, every secret
// re-encrypted with it in one transaction, then the new key in place and the old one kept as
// master.key.<id>.retired (delete it once backups made with it are gone). Refused when the key
// comes from SKP_MASTER_KEY: the environment can't be rewritten from here. resumed: it finished,
// with its key, a rotation that had stopped part way.
export function rotateMasterKey(config, store, { log } = {}) {
  const current = loadMasterKey(config, { log, create: false });
  if (current.source === 'SKP_MASTER_KEY') throw new SecretsError('The master key comes from SKP_MASTER_KEY; rotate it there: decrypting needs both keys, so use a key file (SKP_MASTER_KEY_FILE) to rotate.');
  const nextFile = `${current.file}.next`;
  // A rotation that stopped after its commit and before its renames left its key here, maybe the
  // only copy of the key the secrets are under now: never overwrite it, finish that rotation with
  // it. (The ring decrypts each secret whichever key it is under; all end up under this one.)
  let next;
  const resumed = existsSync(nextFile);
  if (resumed) {
    let text;
    try { text = readFileSync(nextFile, 'utf8'); } catch (err) { throw new SecretsError(`Can't read ${nextFile} (${err.code || err.message}), left by a key rotation that stopped part way: it may hold the key the secrets are under. Make it readable, then rotate again.`); }
    next = parseKey(text, nextFile);
  } else {
    next = randomBytes(32);
    writeKeyFile(nextFile, next);
  }
  const oldSecrets = createSecrets({ key: current.key, ring: current.ring });
  const newSecrets = createSecrets({ key: next });
  let count = 0;
  const fields = [...encryptedFields(store)]; // read before: inside a transaction only tx reads
  store.transaction((tx) => {
    for (const { collection, doc, field, aad } of fields) {
      const value = getPath(tx.get(collection, doc.id)?.data, field);
      if (!isEncrypted(value)) continue;
      const cur = tx.get(collection, doc.id);
      tx.put(collection, doc.id, setPath(cur.data, field, newSecrets.encrypt(oldSecrets.decrypt(value, aad), aad)));
      count++;
    }
  });
  renameSync(current.file, `${current.file}.${current.kid}.retired`);
  renameSync(nextFile, current.file);
  return { from: current.kid, to: keyId(next), reencrypted: count, retired: `${current.file}.${current.kid}.retired`, resumed };
}

// A rotation that stopped between its two renames: the secrets are under master.key.next, and
// there is no master.key. Put the next key in its place (making a new one would decrypt nothing).
function finishRotation(file, log) {
  const nextFile = `${file}.next`;
  if (existsSync(file) || !existsSync(nextFile)) return;
  try {
    renameSync(nextFile, file);
  } catch (err) {
    throw new SecretsError(`A key rotation stopped part way: ${file} is missing and ${nextFile} holds the key. Rename it to ${path.basename(file)} (${err.code || err.message}).`);
  }
  log?.warn(`A key rotation had stopped part way: ${path.basename(nextFile)} is the master key now, in ${file}.`, { file });
}

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
