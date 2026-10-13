// Accounts and sign-in (07 §7.2–7.5): the setup code and the owner, users and roles, sessions,
// API tokens, two-factor codes, login protection, and the command line's local token.
//
//   store collection "users"     id usr_…: { username, role, passwordHash, totp?, recovery?, … }
//   store collection "sessions"  id ses_…: { userId, hash (SHA-256 of the cookie's value), csrf, … }
//   store collection "tokens"    id tok_…: { userId, name, hash (SHA-256 of the token), scopes, … }
//
// Secrets are never stored as they are: a session or API token is kept as its SHA-256, a password
// as its scrypt hash, a recovery code as its SHA-256. The TOTP secret is kept as it is until secrets
// at rest are encrypted (step 12).
//
// The command line on this machine drives the running platform with a local token: 32 random
// bytes the platform writes, at each start, to <configDir>/local-token (0600), accepted only from a
// loopback address. Whoever can read the config directory can read the master key there anyway.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { BlockList, isIP } from 'node:net';
import path from 'node:path';
import { newId } from '../ids.js';
import { isEncrypted } from '../secrets.js';
import { BusyError, createHasher, passwordProblem } from './passwords.js';
import { ASSIGNABLE, SCOPES, scopesOf } from './roles.js';
import { createThrottle } from './throttle.js';
import { base32Encode, newSecret, otpauthUri, verifyTotp } from './totp.js';

export const IDLE_MS = 12 * 60 * 60 * 1000;
export const KEEP_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSION_MS = 24 * 60 * 60 * 1000;
export const SETUP_MS = 60 * 60 * 1000;
const ENROLL_MS = 10 * 60 * 1000;
const TOUCH_MS = 60 * 1000;
const USERNAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const RECOVERY_CODES = 10;
const MAX_TOKENS = 100;
const MAX_SESSIONS = 50; // per user: the oldest go first
export const LOCAL_TOKEN_FILE = 'local-token';

export class AuthError extends Error {
  constructor(message, code, status = 422, extra = {}) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
    this.status = status;
    Object.assign(this, extra);
  }
}

const sha256 = (s) => createHash('sha256').update(String(s)).digest('hex');
const safeEqual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};
const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
function base62(bytes) {
  let n = BigInt(`0x${bytes.toString('hex')}`);
  let s = '';
  while (n > 0n) {
    s = B62[Number(n % 62n)] + s;
    n /= 62n;
  }
  return s.padStart(43, '0');
}
export const isLoopback = (addr) => {
  const a = String(addr || '').replace(/^::ffff:/, '');
  return a === '::1' || (isIP(a) === 4 && a.startsWith('127.'));
};

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const k = part.slice(0, i).trim();
    if (!(k in out)) out[k] = part.slice(i + 1).trim();
  }
  return out;
}

// Over HTTPS the session cookie is Secure with the __Host- prefix (07 §7.3); secrets encrypts the
// TOTP secret at rest (07 §7.7).
export function createAuth({ store, audit, secrets, log, now = Date.now, hasher = createHasher(), configDir }) {
  const cookieName = (secure) => (secure ? '__Host-skp_session' : 'skp_session');
  const seal = (secret, userId) => (secrets ? secrets.encrypt(secret, `totp:${userId}`) : secret);
  const unseal = (stored, userId) => (secrets && isEncrypted(stored) ? secrets.decrypt(stored, `totp:${userId}`) : stored);
  const throttle = createThrottle({ now });
  const sessionsByHash = new Map(); // SHA-256 → session id
  const tokensByHash = new Map(); // SHA-256 → token id
  let setup = null; // { code, expiresAt, used }
  let localToken = null;

  function* all(collection) {
    for (let after = ''; ;) {
      const page = store.list(collection, { after, limit: 1000 });
      yield* page;
      if (page.length < 1000) break;
      after = page[page.length - 1].id;
    }
  }
  for (const s of all('sessions')) sessionsByHash.set(s.data.hash, s.id);
  for (const t of all('tokens')) tokensByHash.set(t.data.hash, t.id);

  // ---- users -------------------------------------------------------------------------------
  const userView = (doc) => ({
    id: doc.id,
    username: doc.data.username,
    role: doc.data.role,
    totp: !!doc.data.totp,
    preferences: doc.data.preferences || {},
    createdAt: doc.data.createdAt,
    ...(doc.data.lastLoginAt ? { lastLoginAt: doc.data.lastLoginAt } : {}),
  });
  const findUser = (username) => [...all('users')].find((d) => d.data.username === username);
  const ownerDoc = () => [...all('users')].find((d) => d.data.role === 'owner');
  const userDoc = (id) => {
    const doc = typeof id === 'string' && /^usr_[0-9A-Z]{26}$/.test(id) ? store.get('users', id) : undefined;
    if (!doc) throw new AuthError(`There is no user "${id}".`, 'not-found', 404);
    return doc;
  };
  const byRef = (ref) => {
    if (typeof ref === 'string' && USERNAME.test(ref.toLowerCase()) && !ref.startsWith('usr_')) {
      const doc = findUser(ref.toLowerCase());
      if (!doc) throw new AuthError(`There is no user "${ref}".`, 'not-found', 404);
      return doc;
    }
    return userDoc(ref);
  };

  function cleanUsername(username) {
    const name = typeof username === 'string' ? username.trim().toLowerCase() : '';
    if (!USERNAME.test(name)) throw new AuthError('"username" is 1 to 64 lowercase letters, digits, dots, dashes or underscores, starting with a letter or digit.', 'invalid');
    return name;
  }
  function checkPassword(password, username) {
    const problem = passwordProblem(password, { username });
    if (problem) throw new AuthError(problem, 'weak-password');
  }
  const hash = async (password) => {
    try { return await hasher.hash(password); } catch (err) { throw busy(err); }
  };
  const verify = async (password, stored) => {
    try { return await hasher.verify(typeof password === 'string' ? password : '', stored); } catch (err) { throw busy(err); }
  };
  const busy = (err) => (err instanceof BusyError ? new AuthError(err.message, 'busy', 429, { retryAfterS: err.retryAfterS }) : err);

  // ---- sessions ----------------------------------------------------------------------------
  function cookie(token, keep, secure) {
    return `${cookieName(secure)}=${token}; HttpOnly; SameSite=Lax; Path=/${keep ? `; Max-Age=${KEEP_MS / 1000}` : ''}${secure ? '; Secure' : ''}`;
  }
  const clearCookie = (secure) => `${cookieName(secure)}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure ? '; Secure' : ''}`;

  function dropSession(id) {
    const doc = store.get('sessions', id);
    if (doc) sessionsByHash.delete(doc.data.hash);
    store.delete('sessions', id);
  }
  const sessionsOf = (userId) => [...all('sessions')].filter((s) => s.data.userId === userId);
  function endSessions(userId) {
    for (const s of sessionsOf(userId)) dropSession(s.id);
  }
  const expired = (d) => d.expiresAt <= now() || now() - d.lastSeenAt >= IDLE_MS;

  // A new session for the user (a sign-in, or after a change that ended their others): the
  // cookie's value is shown once, here, and kept as its hash.
  function startSession(user, { keep = false, ip, ua, https = false } = {}) {
    for (const s of all('sessions')) if (expired(s.data)) dropSession(s.id);
    const mine = sessionsOf(user.id).sort((a, b) => a.data.createdAt - b.data.createdAt);
    while (mine.length >= MAX_SESSIONS) dropSession(mine.shift().id);
    const token = randomBytes(32).toString('base64url');
    const t = now();
    const data = { userId: user.id, hash: sha256(token), csrf: randomBytes(32).toString('base64url'), createdAt: t, lastSeenAt: t, expiresAt: t + (keep ? KEEP_MS : SESSION_MS), keep: !!keep, ...(ip ? { ip: String(ip) } : {}), ...(ua ? { ua: String(ua).slice(0, 200) } : {}) };
    const doc = store.put('sessions', newId('ses'), data, { ifRev: 0 });
    sessionsByHash.set(data.hash, doc.id);
    return { id: doc.id, csrf: data.csrf, expiresAt: new Date(data.expiresAt).toISOString(), cookie: cookie(token, keep, https) };
  }
  const signedIn = (user, session) => ({ user: userView(user), csrf: session.csrf, expiresAt: session.expiresAt, cookie: session.cookie });

  // ---- who is asking -----------------------------------------------------------------------
  // { principal } for a valid credential, { error } for one that isn't, {} for none. A principal:
  // { kind: 'session' | 'token' | 'local', user?, role, scopes (a Set), label, csrf?, sessionId?, tokenId? }.
  function authenticate(req) {
    const authz = req.headers.authorization;
    if (authz !== undefined) {
      const m = /^Bearer\s+(\S+)\s*$/i.exec(authz);
      if (!m) return { error: 'Send an API token as "Authorization: Bearer skp_pat_…".' };
      if (m[1].startsWith('skp_cli_')) return local(m[1], req);
      return apiToken(m[1], req);
    }
    const jar = parseCookies(req.headers.cookie);
    const value = jar[cookieName(true)] ?? jar[cookieName(false)];
    return value ? session(value) : {};
  }

  function session(value) {
    const id = sessionsByHash.get(sha256(value));
    const doc = id && store.get('sessions', id);
    if (!doc) return { error: 'Your session has ended. Sign in again.', clear: true };
    if (expired(doc.data)) {
      dropSession(doc.id);
      return { error: 'Your session has ended. Sign in again.', clear: true };
    }
    const user = store.get('users', doc.data.userId);
    if (!user) {
      dropSession(doc.id);
      return { error: 'Your session has ended. Sign in again.', clear: true };
    }
    if (now() - doc.data.lastSeenAt >= TOUCH_MS) store.put('sessions', doc.id, { ...doc.data, lastSeenAt: now() });
    return { principal: { kind: 'session', user: userView(user), role: user.data.role, scopes: new Set(scopesOf(user.data.role)), label: user.data.username, csrf: doc.data.csrf, sessionId: doc.id } };
  }

  function apiToken(value, req) {
    const id = value.startsWith('skp_pat_') ? tokensByHash.get(sha256(value)) : undefined;
    const doc = id && store.get('tokens', id);
    if (!doc) return { error: 'That API token isn\'t valid (revoked, or mistyped).' };
    const d = doc.data;
    if (d.expiresAt && d.expiresAt <= now()) return { error: 'That API token has expired. Create a new one.' };
    if (d.ips?.length) {
      const allow = new BlockList();
      for (const entry of d.ips) addAddress(allow, entry);
      const addr = String(req.client?.ip ?? req.socket?.remoteAddress ?? '').replace(/^::ffff:/, '');
      if (!isIP(addr) || !allow.check(addr, isIP(addr) === 6 ? 'ipv6' : 'ipv4')) return { error: 'That API token can\'t be used from this address.' };
    }
    const user = store.get('users', d.userId);
    if (!user) return { error: 'That API token\'s user no longer exists.' };
    if (now() - (d.lastUsedAt || 0) >= TOUCH_MS) store.put('tokens', doc.id, { ...d, lastUsedAt: now() });
    // Never more than the creator's role has now.
    const scopes = new Set(d.scopes.filter((s) => scopesOf(user.data.role).includes(s)));
    return { principal: { kind: 'token', user: userView(user), role: user.data.role, scopes, label: `${user.data.username} (token ${d.name})`, tokenId: doc.id } };
  }

  function local(value, req) {
    if (!localToken || !safeEqual(value, localToken)) return { error: 'The command line\'s local token doesn\'t match: is the platform running with this config directory?' };
    // From this machine, and not through a proxy that is (a local reverse proxy forwards others).
    if (!isLoopback(req.socket?.remoteAddress) || req.client?.proxied || req.headers['x-forwarded-for']) return { error: 'The local token works only from this machine.' };
    return { principal: { kind: 'local', role: 'owner', scopes: new Set(SCOPES), label: 'local' } };
  }

  // ---- setup (07 §7.2) ---------------------------------------------------------------------
  function newSetupCode() {
    const raw = base32Encode(randomBytes(8)).slice(0, 12); // 60 random bits
    return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
  }
  const normalizeCode = (c) => String(c).toUpperCase().replace(/[^A-Z0-9]/g, '');

  async function createOwner({ code, username, password } = {}, { ip, ua, keep, https } = {}) {
    if (ownerDoc()) throw new AuthError('The owner account exists already: sign in instead.', 'setup-done', 409);
    const wait = throttle.wait(`setup:${ip}`);
    if (wait) throw new AuthError(`Too many wrong setup codes. Try again in ${Math.ceil(wait / 1000)} s.`, 'throttled', 429, { retryAfterS: Math.ceil(wait / 1000) });
    if (!setup || setup.used || now() >= setup.expiresAt) throw new AuthError('The setup code has expired. Restart the platform for a new one: it is printed in the log.', 'setup-expired', 403);
    if (typeof code !== 'string' || !safeEqual(normalizeCode(code), normalizeCode(setup.code))) {
      throttle.fail(`setup:${ip}`);
      audit.record({ action: 'setup.failure', actor: 'anonymous', ip });
      throw new AuthError('That setup code is wrong. The platform printed it in its log at startup ("setup code").', 'bad-setup-code', 403);
    }
    const name = cleanUsername(username);
    checkPassword(password, name);
    setup.used = true; // before the wait for the hash: a second request with the same code loses
    let passwordHash;
    try { passwordHash = await hash(password); } catch (err) {
      setup.used = false;
      throw err;
    }
    if (ownerDoc()) throw new AuthError('The owner account exists already: sign in instead.', 'setup-done', 409);
    const t = new Date(now()).toISOString();
    const user = store.put('users', newId('usr'), { username: name, role: 'owner', passwordHash, createdAt: t, lastLoginAt: t }, { ifRev: 0 });
    audit.record({ action: 'setup', actor: name, ip, target: user.id });
    log.info('owner account created', { username: name });
    return signedIn(user, startSession(user, { keep, ip, ua, https }));
  }

  // ---- signing in (07 §7.3, §7.4) ----------------------------------------------------------
  async function login({ username, password, code, keep } = {}, { ip, ua, https } = {}) {
    const name = typeof username === 'string' ? username.trim().toLowerCase() : '';
    const keys = [`account:${name}`, `ip:${ip}`];
    const wait = throttle.wait(...keys);
    if (wait) {
      throw new AuthError(`Too many failed sign-ins. Try again in ${wait >= 60000 ? `${Math.ceil(wait / 60000)} min` : `${Math.ceil(wait / 1000)} s`}.`, 'throttled', 429, { retryAfterS: Math.ceil(wait / 1000) });
    }
    const doc = USERNAME.test(name) ? findUser(name) : undefined;
    // An unknown name costs one hash too: the answer and its timing say nothing about who exists.
    const { ok, rehash } = await verify(password, doc?.data.passwordHash);
    const failed = (what) => {
      throttle.fail(...keys);
      audit.record({ action: 'login.failure', actor: name || 'anonymous', ip, reason: what });
    };
    if (!doc || !ok) {
      failed('password');
      throw new AuthError('The username or password is wrong.', 'bad-credentials', 401);
    }
    let user = doc;
    if (user.data.totp) {
      if (code === undefined || code === null || code === '') throw new AuthError('Enter the six-digit code from your authenticator app, or a recovery code.', 'totp-required', 401);
      const step = verifyTotp(unseal(user.data.totp.secret, user.id), String(code), now(), { lastStep: user.data.totp.lastStep ?? -1 });
      if (step !== undefined) user = store.put('users', user.id, { ...user.data, totp: { ...user.data.totp, lastStep: step } });
      else {
        const used = sha256(normalizeCode(code));
        const i = (user.data.recovery || []).indexOf(used);
        if (i < 0) {
          failed('code');
          throw new AuthError('That code is wrong, or was used already.', 'bad-code', 401);
        }
        user = store.put('users', user.id, { ...user.data, recovery: user.data.recovery.filter((_, j) => j !== i) });
        audit.record({ action: 'totp.recovery-used', actor: name, ip, left: user.data.recovery.length });
      }
    }
    throttle.succeed(`account:${name}`);
    const next = { ...user.data, lastLoginAt: new Date(now()).toISOString() };
    if (rehash) next.passwordHash = await hash(password);
    user = store.put('users', user.id, next);
    audit.record({ action: 'login', actor: name, ip, keep: !!keep });
    return signedIn(user, startSession(user, { keep, ip, ua, https }));
  }

  function logout(who, { ip, https } = {}) {
    if (who.kind === 'session') {
      dropSession(who.sessionId);
      audit.record({ action: 'session.end', actor: who.label, ip, target: who.sessionId });
    }
    return { cookie: clearCookie(https) };
  }

  // What GET /auth/session answers.
  const describe = (who) => ({
    via: who.kind,
    ...(who.user ? { user: who.user } : {}),
    role: who.role,
    scopes: [...who.scopes],
    ...(who.csrf ? { csrf: who.csrf } : {}),
    ...(who.sessionId ? { expiresAt: new Date(store.get('sessions', who.sessionId).data.expiresAt).toISOString() } : {}),
    ...(!ownerDoc() ? { setupNeeded: true } : {}),
  });

  // The signed-in user's record, for what only a person (not a token or the command line) does.
  function self(who) {
    if (who.kind !== 'session') throw new AuthError('Sign in as yourself for this (not with a token or from the command line).', 'session-only', 403);
    return userDoc(who.user.id);
  }

  async function changePassword(who, { current, password } = {}, { ip, ua, https } = {}) {
    const doc = self(who);
    if (!(await verify(current, doc.data.passwordHash)).ok) throw new AuthError('The current password is wrong.', 'bad-credentials', 403);
    checkPassword(password, doc.data.username);
    const saved = store.put('users', doc.id, { ...doc.data, passwordHash: await hash(password) });
    endSessions(doc.id);
    audit.record({ action: 'password.change', actor: who.label, ip, target: doc.id });
    return signedIn(saved, startSession(saved, { ip, ua, https, keep: false }));
  }

  // The admin UI's look for this user (08 §8.6): theme, accent colour, density.
  function setPreferences(who, prefs = {}) {
    const doc = self(who);
    const next = { ...(doc.data.preferences || {}) };
    const choices = { theme: ['system', 'light', 'dark'], density: ['comfortable', 'compact'] };
    for (const [k, v] of Object.entries(prefs)) {
      if (k === 'accent') {
        if (v !== null && (typeof v !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(v))) throw new AuthError('"accent" is a colour like #16e0ff, or null for the default.', 'invalid');
        if (v === null) delete next.accent;
        else next.accent = v.toLowerCase();
      } else if (choices[k]) {
        if (!choices[k].includes(v)) throw new AuthError(`"${k}" is one of ${choices[k].join(', ')}.`, 'invalid');
        next[k] = v;
      }
    }
    store.put('users', doc.id, { ...doc.data, preferences: next });
    return next;
  }

  // ---- two-factor (07 §7.4) ----------------------------------------------------------------
  async function totpEnroll(who, { password } = {}) {
    const doc = self(who);
    if (!(await verify(password, doc.data.passwordHash)).ok) throw new AuthError('The password is wrong.', 'bad-credentials', 403);
    if (doc.data.totp) throw new AuthError('Two-factor is on already; turn it off first to set up another device.', 'totp-on', 409);
    const secret = newSecret();
    store.put('users', doc.id, { ...doc.data, totpPending: { secret: seal(secret, doc.id), at: now() } });
    return { secret, uri: otpauthUri(secret, doc.data.username) };
  }

  function totpVerify(who, { code } = {}, { ip, ua, https } = {}) {
    const doc = self(who);
    const pending = doc.data.totpPending;
    if (!pending || now() - pending.at > ENROLL_MS) throw new AuthError('Start again: enroll, then enter a code within ten minutes.', 'no-enrollment', 409);
    const step = verifyTotp(unseal(pending.secret, doc.id), String(code ?? ''), now());
    if (step === undefined) throw new AuthError('That code is wrong. Check the time on your phone, and enter the code it shows now.', 'bad-code', 422);
    const recoveryCodes = Array.from({ length: RECOVERY_CODES }, () => {
      const c = randomBytes(8).toString('hex').toUpperCase().slice(0, 12);
      return `${c.slice(0, 4)}-${c.slice(4, 8)}-${c.slice(8)}`;
    });
    const next = { ...doc.data, totp: { secret: pending.secret, lastStep: step, enabledAt: now() }, recovery: recoveryCodes.map((c) => sha256(normalizeCode(c))) };
    delete next.totpPending;
    const saved = store.put('users', doc.id, next);
    endSessions(doc.id);
    audit.record({ action: 'totp.enable', actor: who.label, ip, target: doc.id });
    return { ...signedIn(saved, startSession(saved, { ip, ua, https })), recoveryCodes };
  }

  async function totpDisable(who, { password } = {}, { ip, ua, https } = {}) {
    const doc = self(who);
    if (!(await verify(password, doc.data.passwordHash)).ok) throw new AuthError('The password is wrong.', 'bad-credentials', 403);
    const next = { ...doc.data };
    delete next.totp;
    delete next.recovery;
    delete next.totpPending;
    const saved = store.put('users', doc.id, next);
    endSessions(doc.id);
    audit.record({ action: 'totp.disable', actor: who.label, ip, target: doc.id });
    return signedIn(saved, startSession(saved, { ip, ua, https }));
  }

  // ---- users (owner) -----------------------------------------------------------------------
  async function createUser({ username, password, role } = {}, { actor, ip } = {}) {
    const name = cleanUsername(username);
    if (!ASSIGNABLE.includes(role)) throw new AuthError(`"role" is one of ${ASSIGNABLE.join(', ')} (there is one owner).`, 'invalid');
    if (findUser(name)) throw new AuthError(`There is already a user "${name}".`, 'name-taken', 409);
    checkPassword(password, name);
    const passwordHash = await hash(password);
    if (findUser(name)) throw new AuthError(`There is already a user "${name}".`, 'name-taken', 409);
    const doc = store.put('users', newId('usr'), { username: name, role, passwordHash, createdAt: new Date(now()).toISOString() }, { ifRev: 0 });
    audit.record({ action: 'user.create', actor, ip, target: doc.id, username: name, role });
    return userView(doc);
  }

  // { role?, password?, totp: false? }: each ends the user's sessions.
  async function updateUser(ref, patch = {}, { actor, ip } = {}) {
    let doc = byRef(ref);
    const next = { ...doc.data };
    const changed = [];
    if (patch.role !== undefined && patch.role !== doc.data.role) {
      if (doc.data.role === 'owner') throw new AuthError('The owner stays the owner.', 'owner', 409);
      if (!ASSIGNABLE.includes(patch.role)) throw new AuthError(`"role" is one of ${ASSIGNABLE.join(', ')} (there is one owner).`, 'invalid');
      next.role = patch.role;
      changed.push('role');
    }
    if (patch.password !== undefined) {
      checkPassword(patch.password, doc.data.username);
      next.passwordHash = await hash(patch.password);
      changed.push('password');
    }
    if (patch.totp === false && doc.data.totp) {
      delete next.totp;
      delete next.recovery;
      changed.push('totp');
    }
    if (!changed.length) return userView(doc);
    doc = store.put('users', doc.id, next);
    endSessions(doc.id);
    for (const what of changed) audit.record({ action: what === 'role' ? 'user.role' : what === 'password' ? 'user.password' : 'user.totp-reset', actor, ip, target: doc.id, username: doc.data.username, ...(what === 'role' ? { role: next.role } : {}) });
    return userView(doc);
  }

  function removeUser(ref, { actor, ip } = {}) {
    const doc = byRef(ref);
    if (doc.data.role === 'owner') throw new AuthError('The owner can\'t be removed.', 'owner', 409);
    endSessions(doc.id);
    for (const t of [...all('tokens')].filter((x) => x.data.userId === doc.id)) dropToken(t.id);
    store.delete('users', doc.id);
    audit.record({ action: 'user.delete', actor, ip, target: doc.id, username: doc.data.username });
    return { id: doc.id, username: doc.data.username };
  }

  // ---- API tokens (07 §7.5) ----------------------------------------------------------------
  const tokenView = (doc) => ({
    id: doc.id,
    name: doc.data.name,
    user: store.get('users', doc.data.userId)?.data.username,
    scopes: doc.data.scopes,
    createdAt: new Date(doc.data.createdAt).toISOString(),
    ...(doc.data.expiresAt ? { expiresAt: new Date(doc.data.expiresAt).toISOString() } : {}),
    ...(doc.data.ips?.length ? { ips: doc.data.ips } : {}),
    ...(doc.data.lastUsedAt ? { lastUsedAt: new Date(doc.data.lastUsedAt).toISOString() } : {}),
  });
  function dropToken(id) {
    const doc = store.get('tokens', id);
    if (doc) tokensByHash.delete(doc.data.hash);
    store.delete('tokens', id);
  }
  // Whose tokens a principal works with: the signed-in user's; from the command line, the owner's.
  function holder(who) {
    if (who.kind === 'token') throw new AuthError('A token can\'t manage tokens: sign in, or use the command line.', 'session-only', 403);
    if (who.kind === 'session') return userDoc(who.user.id);
    const owner = ownerDoc();
    if (!owner) throw new AuthError('There is no owner yet: run skp setup first.', 'setup-needed', 409);
    return owner;
  }

  function createToken(who, { name, scopes, expiresAt, expiresInDays, ips } = {}, { ip } = {}) {
    const user = holder(who);
    if (typeof name !== 'string' || !name.trim() || name.length > 80) throw new AuthError('"name" says what the token is for (Stream Deck, a bot), at most 80 characters.', 'invalid');
    const allowed = scopesOf(user.data.role);
    const wanted = scopes === undefined ? allowed : scopes;
    if (!Array.isArray(wanted) || !wanted.length || wanted.some((s) => typeof s !== 'string')) throw new AuthError(`"scopes" is a list of: ${allowed.join(', ')}.`, 'invalid');
    const unknown = wanted.filter((s) => !SCOPES.includes(s));
    if (unknown.length) throw new AuthError(`Unknown scopes: ${unknown.join(', ')}. They are: ${SCOPES.join(', ')}.`, 'invalid');
    const over = wanted.filter((s) => !allowed.includes(s));
    if (over.length) throw new AuthError(`A token can't do more than its user: ${user.data.username} (${user.data.role}) doesn't have ${over.join(', ')}.`, 'over-role', 403);
    let expires;
    if (expiresAt !== undefined && expiresAt !== null) {
      expires = typeof expiresAt === 'string' ? Date.parse(expiresAt) : NaN;
      if (!Number.isFinite(expires) || expires <= now()) throw new AuthError('"expiresAt" is an instant in the future (2027-01-01T00:00:00Z).', 'invalid');
    } else if (expiresInDays !== undefined && expiresInDays !== null) {
      if (!Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > 3650) throw new AuthError('"expiresInDays" is 1 to 3650.', 'invalid');
      expires = now() + expiresInDays * 24 * 60 * 60 * 1000;
    }
    let list;
    if (ips !== undefined && ips !== null) {
      if (!Array.isArray(ips) || ips.length > 20) throw new AuthError('"ips" is a list of at most 20 addresses or ranges (192.168.1.20, 192.168.1.0/24).', 'invalid');
      for (const entry of ips) addAddress(new BlockList(), entry);
      list = ips.map(String);
    }
    if ([...all('tokens')].filter((t) => t.data.userId === user.id).length >= MAX_TOKENS) throw new AuthError(`A user has at most ${MAX_TOKENS} tokens; revoke some first.`, 'too-many', 409);
    const secret = `skp_pat_${base62(randomBytes(32))}`;
    const data = { userId: user.id, name: name.trim(), hash: sha256(secret), scopes: [...new Set(wanted)], createdAt: now(), ...(expires ? { expiresAt: expires } : {}), ...(list?.length ? { ips: list } : {}) };
    const doc = store.put('tokens', newId('tok'), data, { ifRev: 0 });
    tokensByHash.set(data.hash, doc.id);
    audit.record({ action: 'token.create', actor: who.label, ip, target: doc.id, name: data.name, scopes: data.scopes.join(' ') });
    return { ...tokenView(doc), token: secret };
  }

  function listTokens(who, { all: everyone = false } = {}) {
    if (everyone && who.scopes.has('users:admin')) return [...all('tokens')].map(tokenView);
    const user = holder(who);
    return [...all('tokens')].filter((t) => t.data.userId === user.id).map(tokenView);
  }

  function revokeToken(who, id, { ip } = {}) {
    const doc = typeof id === 'string' && /^tok_[0-9A-Z]{26}$/.test(id) ? store.get('tokens', id) : undefined;
    const mine = doc && who.kind !== 'token' && (who.scopes.has('users:admin') || doc.data.userId === holder(who).id);
    if (!doc || !mine) throw new AuthError(`There is no token "${id}".`, 'not-found', 404);
    dropToken(doc.id);
    audit.record({ action: 'token.revoke', actor: who.label, ip, target: doc.id, name: doc.data.name });
    return { id: doc.id };
  }

  // ---- a user's own sessions ---------------------------------------------------------------
  function listSessions(who) {
    const user = self(who);
    return sessionsOf(user.id).filter((s) => !expired(s.data)).sort((a, b) => b.data.lastSeenAt - a.data.lastSeenAt).map((s) => ({
      id: s.id,
      current: s.id === who.sessionId,
      createdAt: new Date(s.data.createdAt).toISOString(),
      lastSeenAt: new Date(s.data.lastSeenAt).toISOString(),
      expiresAt: new Date(s.data.expiresAt).toISOString(),
      ...(s.data.ip ? { ip: s.data.ip } : {}),
      ...(s.data.ua ? { device: s.data.ua } : {}),
    }));
  }

  function revokeSession(who, id, { ip } = {}) {
    const user = self(who);
    const doc = typeof id === 'string' && /^ses_[0-9A-Z]{26}$/.test(id) ? store.get('sessions', id) : undefined;
    if (!doc || doc.data.userId !== user.id) throw new AuthError(`There is no session "${id}".`, 'not-found', 404);
    dropSession(doc.id);
    audit.record({ action: 'session.revoke', actor: who.label, ip, target: doc.id });
    return { id: doc.id, current: doc.id === who.sessionId };
  }

  // ---- startup and the local token ---------------------------------------------------------
  const tokenFile = configDir ? path.join(configDir, LOCAL_TOKEN_FILE) : undefined;

  return {
    cookieName,
    clearCookie,
    authenticate,
    describe,
    setupNeeded: () => !ownerDoc(),
    createOwner,
    login,
    logout,
    changePassword,
    setPreferences,
    totp: { enroll: totpEnroll, verify: totpVerify, disable: totpDisable },
    users: {
      list: () => [...all('users')].map(userView).sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1)),
      get: (ref) => userView(byRef(ref)),
      create: createUser,
      update: updateUser,
      remove: removeUser,
    },
    tokens: { list: listTokens, create: createToken, revoke: revokeToken },
    sessions: { list: listSessions, revoke: revokeSession },
    // The setup code while one is valid (for the desktop app's window, and tests).
    get setupCode() { return setup && !setup.used && now() < setup.expiresAt ? setup.code : undefined; },
    get localToken() { return localToken; },
    // At platform start: a setup code if there's no owner (printed to the log), and a new local
    // token for the command line.
    start() {
      for (const s of all('sessions')) if (expired(s.data)) dropSession(s.id);
      if (!ownerDoc()) {
        setup = { code: newSetupCode(), expiresAt: now() + SETUP_MS, used: false };
        log.warn(`No owner account yet. Create it within an hour with this setup code: ${setup.code}  (skp setup, or the admin UI)`, { setupCode: setup.code });
      }
      localToken = `skp_cli_${base62(randomBytes(32))}`;
      if (tokenFile) {
        try {
          rmSync(tokenFile, { force: true });
          writeFileSync(tokenFile, `${localToken}\n`, { mode: 0o600, flag: 'wx' });
        } catch (err) {
          log.warn('the command line\'s local token could not be written; skp show … won\'t reach this platform', { file: tokenFile, err: err.message });
        }
      }
    },
    stop() {
      if (!tokenFile || !localToken) return;
      try {
        if (readFileSync(tokenFile, 'utf8').trim() === localToken) rmSync(tokenFile, { force: true });
      } catch { /* gone already */ }
    },
  };
}

function addAddress(list, entry) {
  const s = String(entry).trim();
  const m = /^([^/]+)(?:\/(\d{1,3}))?$/.exec(s);
  const kind = m && isIP(m[1]);
  const bits = m?.[2] === undefined ? undefined : Number(m[2]);
  if (!kind || (bits !== undefined && bits > (kind === 6 ? 128 : 32))) throw new AuthError(`"${s}" isn't an IP address or range (192.168.1.20, 192.168.1.0/24, fd00::/8).`, 'invalid');
  if (bits === undefined) list.addAddress(m[1], kind === 6 ? 'ipv6' : 'ipv4');
  else list.addSubnet(m[1], bits, kind === 6 ? 'ipv6' : 'ipv4');
}

// The command line's credential: the local token the running platform wrote, if any.
export function readLocalToken(configDir) {
  try { return readFileSync(path.join(configDir, LOCAL_TOKEN_FILE), 'utf8').trim() || undefined; } catch { return undefined; }
}
