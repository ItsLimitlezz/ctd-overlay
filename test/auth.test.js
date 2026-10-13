// Sign-in and accounts (07 §7.2–7.5, §7.12): the setup code and the owner, passwords, sessions and
// CSRF, login protection, roles, API tokens, two-factor codes, the command line's local token, and
// the audit log.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { startPlatform } from '../src/app.js';
import { createAudit } from '../src/auth/audit.js';
import { IDLE_MS, KEEP_MS, LOCAL_TOKEN_FILE, SESSION_MS, SETUP_MS } from '../src/auth/index.js';
import { BusyError, createHasher, passwordProblem, SCRYPT } from '../src/auth/passwords.js';
import { ROLES } from '../src/auth/roles.js';
import { base32Decode, base32Encode, hotp, stepAt, verifyTotp } from '../src/auth/totp.js';
import { run } from '../src/cli.js';
import { loadConfig } from '../src/config.js';
import { openStore } from '../src/store/index.js';
import { defer, FIXTURE_TEMPLATES, memoryLogger, tempDir, TESTBED } from './helpers.js';

const FAST = { N: 1024 }; // scrypt's cost lowered for tests; hashes keep their own parameters
const PASSWORD = 'correct horse battery staple';
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

// A platform on a hand-set clock (sign-in, sessions and the audit log run on it).
async function setup(t, { dataRoot = tempDir(t), start = Date.UTC(2026, 9, 17, 18, 0) } = {}) {
  const clock = { t: start, now: () => clock.t };
  const config = loadConfig({ argv: ['--port', '0'], env: { SKP_DATA_DIR: path.join(dataRoot, 'data'), SKP_CONFIG_DIR: path.join(dataRoot, 'config') } });
  const { log, entries } = memoryLogger();
  const platform = await startPlatform(config, { log, templateDirs: [FIXTURE_TEMPLATES], scrypt: FAST, clock: { now: clock.now } });
  defer(t, () => platform.stop());
  return { platform, config, entries, clock, dataRoot };
}

// A browser: keeps its cookie, and sends the CSRF token it was given on changes.
function browser(platform) {
  const b = { cookie: undefined, csrf: undefined };
  b.call = async (method, url, body, headers = {}) => {
    const res = await fetch(`${platform.url}/api/v1${url}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(b.cookie ? { cookie: b.cookie } : {}),
        ...(b.csrf && method !== 'GET' ? { 'x-skp-csrf': b.csrf } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) {
      const pair = setCookie.split(';')[0];
      b.cookie = pair.endsWith('=') ? undefined : pair;
    }
    const json = await res.json().catch(() => null);
    if (json?.csrf) b.csrf = json.csrf;
    return { status: res.status, body: json, setCookie, retryAfter: res.headers.get('retry-after') };
  };
  return b;
}

const bearer = (platform, token) => (method, url, body) => fetch(`${platform.url}/api/v1${url}`, {
  method,
  headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body),
}).then(async (res) => ({ status: res.status, body: await res.json().catch(() => null) }));

async function withOwner(t, options) {
  const ctx = await setup(t, options);
  const owner = browser(ctx.platform);
  const made = await owner.call('POST', '/setup', { code: ctx.platform.auth.setupCode, username: 'juan', password: PASSWORD });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  return { ...ctx, owner };
}

// A signed-in browser for a new user with this role.
async function userWith(ctx, role, username = role) {
  const added = await ctx.owner.call('POST', '/users', { username, password: `${PASSWORD} ${role}`, role });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  const b = browser(ctx.platform);
  assert.equal((await b.call('POST', '/auth/login', { username, password: `${PASSWORD} ${role}` })).status, 200);
  return b;
}

function storeDump(config) {
  const store = openStore({ dataDir: config.dataDir, backend: config.store });
  try {
    return JSON.stringify(['users', 'sessions', 'tokens', 'audit'].map((c) => store.list(c, { limit: 1000 })));
  } finally {
    store.close();
  }
}

// ---- passwords ---------------------------------------------------------------------------------
test('passwords: scrypt at N = 2^17, r = 8, p = 1, stored with their parameters; verified in constant time; rehashed when they change', async () => {
  assert.deepEqual(SCRYPT, { N: 131072, r: 8, p: 1 });
  const real = createHasher();
  const stored = await real.hash(PASSWORD);
  assert.match(stored, /^scrypt\$N=131072,r=8,p=1\$[A-Za-z0-9+/]{22}==\$[A-Za-z0-9+/]{43}=$/, '16-byte salt, 32-byte hash');
  assert.deepEqual(await real.verify(PASSWORD, stored), { ok: true, rehash: false });
  assert.deepEqual(await real.verify(`${PASSWORD}!`, stored), { ok: false, rehash: false });
  const cheap = createHasher({ params: { N: 1024, r: 8, p: 1 } });
  assert.deepEqual(await cheap.verify(PASSWORD, stored), { ok: true, rehash: true }, 'another cost: still verifies, and asks for a rehash');
  assert.deepEqual(await cheap.verify(PASSWORD, 'not a hash'), { ok: false, rehash: false });
  assert.deepEqual(await cheap.verify(PASSWORD, undefined), { ok: false, rehash: false });
});

test('passwords: hashed one at a time; with more than ten waiting, the next is refused (busy)', async () => {
  const hasher = createHasher({ params: { N: 4096, r: 8, p: 1 }, maxWaiting: 10 });
  let running = 0;
  let most = 0;
  const calls = Array.from({ length: 13 }, (_, i) => hasher.hash(`password number ${i}`).then(() => {
    most = Math.max(most, running);
  }, (err) => err));
  // Watch concurrency through the queue's own count of waiting calls.
  running = hasher.waiting;
  const results = await Promise.all(calls);
  const busy = results.filter((r) => r instanceof BusyError);
  assert.equal(busy.length, 2, 'eleven accepted (one running, ten waiting), two refused');
  assert.ok(busy[0].retryAfterS >= 1);
  assert.equal(hasher.waiting, 0);
  assert.ok(most <= 11);
});

test('what a password may be: 12 to 256 characters, not common, not the username, not a run', () => {
  assert.match(passwordProblem('short'), /at least 12/);
  assert.match(passwordProblem('x'.repeat(257)), /at most 256/);
  for (const weak of ['password1234', 'QWERTY123456', '123456789012', 'abcdefghijkl', 'aaaaaaaaaaaaaa', 'ababababababab', 'streamkit123']) {
    assert.match(passwordProblem(weak), /too common/, weak);
  }
  assert.match(passwordProblem('juan.sebastian', { username: 'Juan.Sebastian' }), /username/);
  assert.equal(passwordProblem(PASSWORD), undefined);
  assert.equal(passwordProblem('🎛️ mixing at the club 🎶'), undefined, 'any characters, no composition rules');
  assert.equal(passwordProblem('ñandú en la pista'), undefined);
});

// ---- two-factor codes --------------------------------------------------------------------------
test('TOTP: RFC 6238 test vectors (SHA-1), one step either side, no replay; base32 round trips', () => {
  const secret = Buffer.from('12345678901234567890');
  for (const [s, code] of [[59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'], [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130']]) {
    assert.equal(hotp(secret, Math.floor(s / 30), 8), code, String(s));
  }
  const b32 = base32Encode(secret);
  assert.equal(b32, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.deepEqual(base32Decode(b32.toLowerCase()), secret);
  const at = 1_800_000_000_000;
  const now = hotp(b32, stepAt(at));
  assert.equal(verifyTotp(b32, now, at), stepAt(at));
  assert.equal(verifyTotp(b32, hotp(b32, stepAt(at) - 1), at), stepAt(at) - 1, 'the previous step');
  assert.equal(verifyTotp(b32, hotp(b32, stepAt(at) + 1), at), stepAt(at) + 1, 'the next');
  assert.equal(verifyTotp(b32, hotp(b32, stepAt(at) - 2), at), undefined, 'two steps off');
  assert.equal(verifyTotp(b32, now, at, { lastStep: stepAt(at) }), undefined, 'used already');
  assert.equal(verifyTotp(b32, '12345', at), undefined);
});

// ---- setup ---------------------------------------------------------------------------------------
test('first run: no default account; a setup code in the log makes the owner, once, within an hour', async (t) => {
  const { platform, entries, clock, dataRoot } = await setup(t);
  const b = browser(platform);
  assert.deepEqual((await b.call('GET', '/setup')).body, { needed: true });
  const code = platform.auth.setupCode;
  assert.match(code, /^[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$/);
  const shown = entries.find((e) => e.context?.setupCode === code);
  assert.ok(shown && shown.msg.includes(code), 'printed in the log');
  // Nothing works without signing in.
  const anonymous = await b.call('GET', '/shows');
  assert.equal(anonymous.status, 401);
  assert.match(anonymous.body.detail, /there is no owner yet: run skp setup/);
  // A wrong code, a weak password.
  assert.equal((await b.call('POST', '/setup', { code: 'AAAA-BBBB-CCCC', username: 'juan', password: PASSWORD })).body.type, 'https://skp.dev/errors/bad-setup-code');
  const weak = await b.call('POST', '/setup', { code, username: 'juan', password: 'password1234' });
  assert.deepEqual([weak.status, weak.body.type], [422, 'https://skp.dev/errors/weak-password']);
  assert.equal(platform.auth.setupCode, code, 'a refused request doesn\'t use the code up');
  // The code, in any case and spacing: the owner, signed in.
  const made = await b.call('POST', '/setup', { code: code.toLowerCase().replace(/-/g, ' '), username: ' Juan ', password: PASSWORD });
  assert.equal(made.status, 201);
  assert.deepEqual([made.body.user.username, made.body.user.role], ['juan', 'owner']);
  assert.match(made.setCookie, /^skp_session=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Lax; Path=\/$/);
  assert.equal(made.body.cookie, undefined, 'the cookie is in its header only');
  assert.equal((await b.call('GET', '/shows')).status, 200);
  assert.deepEqual((await b.call('GET', '/setup')).body, { needed: false });
  assert.equal((await browser(platform).call('POST', '/setup', { code, username: 'eve', password: PASSWORD })).status, 409);
  assert.equal(platform.auth.setupCode, undefined);
  await platform.stop();
  // A restart with no owner yet issues a new code, which expires after an hour.
  const fresh = await setup(t, { dataRoot, start: clock.t });
  const old = fresh.platform.auth.setupCode;
  assert.equal(old, undefined, 'the owner exists: no code');
  await fresh.platform.stop();
  const empty = await setup(t, { dataRoot: tempDir(t) });
  const first = empty.platform.auth.setupCode;
  empty.clock.t += SETUP_MS;
  const late = await browser(empty.platform).call('POST', '/setup', { code: first, username: 'juan', password: PASSWORD });
  assert.deepEqual([late.status, late.body.type], [403, 'https://skp.dev/errors/setup-expired']);
  assert.match(late.body.detail, /Restart the platform/);
  assert.ok(dataRoot);
});

test('wrong setup codes are throttled like logins', async (t) => {
  const { platform } = await setup(t);
  const b = browser(platform);
  for (let i = 0; i < 10; i++) assert.equal((await b.call('POST', '/setup', { code: `WRONG-${i}`, username: 'juan', password: PASSWORD })).status, 403);
  const blocked = await b.call('POST', '/setup', { code: platform.auth.setupCode, username: 'juan', password: PASSWORD });
  assert.deepEqual([blocked.status, blocked.retryAfter], [429, '1']);
});

// ---- sessions ------------------------------------------------------------------------------------
test('sessions: an HttpOnly SameSite=Lax cookie, kept as its hash; CSRF and Origin on changes; idle and absolute lifetimes', async (t) => {
  const { platform, config, owner, clock } = await withOwner(t);
  const showBody = { name: 'Night', overlays: [], date: '2026-10-17', timezone: 'America/Toronto' };
  // A change without the CSRF header is refused; with it, done.
  const csrf = owner.csrf;
  owner.csrf = undefined;
  const forged = await owner.call('POST', '/shows', showBody);
  assert.deepEqual([forged.status, forged.body.type], [403, 'https://skp.dev/errors/csrf']);
  owner.csrf = 'x'.repeat(43);
  assert.equal((await owner.call('POST', '/shows', showBody)).status, 403);
  owner.csrf = csrf;
  assert.equal((await owner.call('POST', '/shows', showBody)).status, 201);
  // Another site's page is refused even with the cookie (and CSRF) it can't read anyway.
  assert.equal((await owner.call('DELETE', '/shows/Night', undefined, { origin: 'https://evil.example' })).status, 403);
  // GET /auth/session: who, and the CSRF token.
  const me = (await owner.call('GET', '/auth/session')).body;
  assert.deepEqual([me.via, me.user.username, me.role, me.csrf], ['session', 'juan', 'owner', csrf]);
  assert.ok(me.scopes.includes('users:admin'));
  // Only hashes are stored: neither the cookie's value nor the password is anywhere in the store.
  const value = owner.cookie.split('=')[1];
  await platform.stop();
  const dump = storeDump(config);
  assert.ok(!dump.includes(value) && !dump.includes(PASSWORD));
  assert.match(dump, /scrypt\$N=1024,r=8,p=1\$/);
  // Back up, on the same data: the session survives a restart.
  const again = await setup(t, { dataRoot: path.dirname(config.dataDir), start: clock.t });
  const b = browser(again.platform);
  b.cookie = owner.cookie;
  assert.equal((await b.call('GET', '/auth/session')).status, 200);
  // Idle for 12 hours: over.
  again.clock.t += IDLE_MS - MIN;
  assert.equal((await b.call('GET', '/auth/session')).status, 200, 'used again just in time');
  again.clock.t += IDLE_MS - MIN;
  assert.equal((await b.call('GET', '/auth/session')).status, 200);
  // A session without "keep me signed in" lasts 24 hours however busy.
  again.clock.t += SESSION_MS - 2 * (IDLE_MS - MIN) + MIN;
  const ended = await b.call('GET', '/auth/session');
  assert.deepEqual([ended.status, ended.body.type], [401, 'https://skp.dev/errors/unauthenticated']);
  assert.match(ended.setCookie, /^skp_session=; .*Max-Age=0/, 'and the browser is told to forget it');
});

test('signing in: one answer for a wrong name or password, "keep me signed in" for 30 days, sign out, your sessions', async (t) => {
  const { platform, owner, clock } = await withOwner(t);
  const b = browser(platform);
  const nobody = await b.call('POST', '/auth/login', { username: 'nobody', password: PASSWORD });
  const wrong = await b.call('POST', '/auth/login', { username: 'juan', password: 'wrong password!' });
  assert.deepEqual([nobody.status, nobody.body.detail], [wrong.status, wrong.body.detail], 'nothing says who exists');
  assert.equal(wrong.body.detail, 'The username or password is wrong.');
  const kept = await b.call('POST', '/auth/login', { username: 'JUAN', password: PASSWORD, keep: true }, { 'user-agent': 'Phone Safari' });
  assert.equal(kept.status, 200);
  assert.match(kept.setCookie, new RegExp(`; Max-Age=${KEEP_MS / 1000}$`));
  assert.equal(Date.parse(kept.body.expiresAt), clock.t + KEEP_MS);
  // Your sessions: this one and the setup's; revoke the other.
  const list = (await b.call('GET', '/auth/sessions')).body.items;
  assert.equal(list.length, 2);
  const mine = list.find((s) => s.current);
  assert.equal(mine.device, 'Phone Safari');
  const other = list.find((s) => !s.current);
  assert.equal((await b.call('DELETE', `/auth/sessions/${other.id}`)).status, 200);
  assert.equal((await owner.call('GET', '/auth/session')).status, 401, 'the revoked one is signed out');
  assert.equal((await b.call('DELETE', '/auth/sessions/ses_01J00000000000000000000000')).status, 404);
  // Sign out: the cookie is cleared and no longer works.
  const cookie = b.cookie;
  const out = await b.call('POST', '/auth/logout', {});
  assert.match(out.setCookie, /Max-Age=0/);
  const stale = browser(platform);
  stale.cookie = cookie;
  assert.equal((await stale.call('GET', '/auth/session')).status, 401);
});

test('login protection: ten failures, then 1 s, 2 s, 4 s … per account and per address; a success resets the account', async (t) => {
  const { platform, clock } = await withOwner(t);
  const b = browser(platform);
  const attempt = (password) => b.call('POST', '/auth/login', { username: 'juan', password });
  for (let i = 0; i < 10; i++) assert.equal((await attempt('wrong password!')).status, 401);
  const first = await attempt(PASSWORD);
  assert.deepEqual([first.status, first.body.type, first.retryAfter], [429, 'https://skp.dev/errors/throttled', '1'], 'even the right password waits');
  clock.t += 1000;
  assert.equal((await attempt('wrong password!')).status, 401);
  const second = await attempt('wrong password!');
  assert.deepEqual([second.status, second.retryAfter], [429, '2']);
  clock.t += 2000;
  assert.equal((await attempt('wrong password!')).status, 401);
  assert.equal((await attempt('wrong password!')).retryAfter, '4');
  // It tops out at 15 minutes.
  for (let i = 0; i < 20; i++) {
    clock.t += 15 * MIN;
    await attempt('wrong password!');
  }
  assert.equal((await attempt('wrong password!')).retryAfter, '900');
  // Fifteen quiet minutes: the window is over; the right password works and resets the account.
  clock.t += 30 * MIN;
  assert.equal((await attempt(PASSWORD)).status, 200);
});

// ---- roles ---------------------------------------------------------------------------------------
test('roles: an operator runs the show but sees no accounts; a viewer only looks; an admin reads the audit log', async (t) => {
  const ctx = await withOwner(t);
  const { platform, owner } = ctx;
  platform.overlays.create({ slug: 'main-h', template: TESTBED, settings: {} });
  assert.equal((await owner.call('POST', '/shows', { name: 'Night', overlays: ['main-h'], date: '2026-10-17', timezone: 'America/Toronto' })).status, 201);
  const operator = await userWith(ctx, 'operator');
  const viewer = await userWith(ctx, 'viewer');
  const admin = await userWith(ctx, 'admin');
  assert.equal((await operator.call('PUT', '/shows/Night/scene', { scene: 'brb' })).status, 200);
  const night = await operator.call('GET', '/shows/Night');
  assert.equal((await operator.call('PATCH', '/shows/Night', { goLive: '22:00' })).status, 428, 'a session sends If-Match (03 §3.1)');
  assert.equal((await operator.call('PATCH', '/shows/Night', { goLive: '22:00' }, { 'if-match': `\"${night.body.id}-r${night.body.rev}\"` })).status, 200, 'the lineup and timeline too');
  const denied = await operator.call('GET', '/users');
  assert.deepEqual([denied.status, denied.body.type], [403, 'https://skp.dev/errors/forbidden']);
  assert.match(denied.body.detail, /users:admin.*operator/);
  assert.equal((await operator.call('GET', '/system/audit')).status, 403);
  assert.equal((await viewer.call('GET', '/shows')).status, 200);
  assert.equal((await viewer.call('PUT', '/shows/Night/scene', { scene: 'program' })).status, 403);
  assert.equal((await viewer.call('POST', '/overlays/main-h/simulate', { kind: 'follow' })).status, 403);
  assert.equal((await admin.call('GET', '/system/audit')).status, 200);
  assert.equal((await admin.call('POST', '/users', { username: 'x', password: PASSWORD, role: 'viewer' })).status, 403, 'users are the owner\'s');
  assert.deepEqual(Object.keys(ROLES), ['owner', 'admin', 'operator', 'viewer']);
  assert.ok(!ROLES.operator.some((s) => s.startsWith('connections') && s !== 'connections:read') && !ROLES.operator.includes('connections:read'), 'operators can\'t see credentials');
});

test('accounts: the owner adds, changes and removes users; each change signs that user out everywhere', async (t) => {
  const ctx = await withOwner(t);
  const { owner } = ctx;
  const ana = await userWith(ctx, 'operator', 'ana');
  assert.equal((await owner.call('POST', '/users', { username: 'ana', password: PASSWORD, role: 'viewer' })).status, 409);
  assert.equal((await owner.call('POST', '/users', { username: 'boss', password: PASSWORD, role: 'owner' })).status, 422, 'one owner');
  assert.equal((await owner.call('POST', '/users', { username: 'Bad Name', password: PASSWORD, role: 'viewer' })).status, 422);
  const list = (await owner.call('GET', '/users')).body.items;
  assert.deepEqual(list.map((u) => [u.username, u.role]), [['juan', 'owner'], ['ana', 'operator']]);
  assert.ok(list.every((u) => !('passwordHash' in u)));
  // A role change ends her sessions.
  assert.equal((await owner.call('PATCH', '/users/ana', { role: 'viewer' })).body.role, 'viewer');
  assert.equal((await ana.call('GET', '/auth/session')).status, 401);
  assert.equal((await owner.call('PATCH', '/users/juan', { role: 'admin' })).status, 409, 'the owner stays the owner');
  // Her own password change ends her other sessions and keeps her signed in here.
  const here = browser(ctx.platform);
  await here.call('POST', '/auth/login', { username: 'ana', password: `${PASSWORD} operator` });
  const there = browser(ctx.platform);
  await there.call('POST', '/auth/login', { username: 'ana', password: `${PASSWORD} operator` });
  assert.equal((await here.call('POST', '/auth/password', { current: 'wrong', password: 'a whole new password' })).status, 403);
  const changed = await here.call('POST', '/auth/password', { current: `${PASSWORD} operator`, password: 'a whole new password' });
  assert.equal(changed.status, 200);
  assert.equal((await here.call('GET', '/auth/session')).status, 200, 'a new cookie came with it');
  assert.equal((await there.call('GET', '/auth/session')).status, 401);
  // Removal: her sessions and tokens go too.
  const token = (await here.call('POST', '/tokens', { name: 'deck', scopes: ['timeline:read'] })).body.token;
  assert.equal((await owner.call('DELETE', '/users/ana')).status, 200);
  assert.equal((await here.call('GET', '/auth/session')).status, 401);
  assert.equal((await bearer(ctx.platform, token)('GET', '/shows')).status, 401);
  assert.equal((await owner.call('DELETE', '/users/juan')).status, 409);
});

// ---- API tokens ----------------------------------------------------------------------------------
test('API tokens: skp_pat_ + 32 random bytes, shown once, kept as a hash; scopes no wider than the role; expiry; an address list', async (t) => {
  const ctx = await withOwner(t);
  const { platform, owner, clock, config } = ctx;
  const made = await owner.call('POST', '/tokens', { name: 'Stream Deck', scopes: ['overlays:control', 'timeline:read'] });
  assert.equal(made.status, 201);
  const { token } = made.body;
  assert.match(token, /^skp_pat_[0-9A-Za-z]{43}$/);
  const deck = bearer(platform, token);
  assert.equal((await deck('GET', '/shows')).status, 200);
  assert.equal((await deck('POST', '/shows', { name: 'X', overlays: [], date: '2026-10-17', timezone: 'UTC' })).status, 403, 'timeline:write not granted');
  assert.equal((await deck('POST', '/tokens', { name: 'another' })).status, 403, 'a token can\'t make tokens');
  const listed = (await owner.call('GET', '/tokens')).body.items;
  assert.equal(listed.length, 1);
  assert.equal(listed[0].token, undefined, 'never shown again');
  assert.equal(listed[0].lastUsedAt, new Date(clock.t).toISOString());
  // An operator can't hand a token more than an operator may do.
  const operator = await userWith(ctx, 'operator');
  const over = await operator.call('POST', '/tokens', { name: 'mine', scopes: ['users:admin'] });
  assert.deepEqual([over.status, over.body.type], [403, 'https://skp.dev/errors/over-role']);
  const opToken = (await operator.call('POST', '/tokens', { name: 'mine' })).body;
  assert.deepEqual(opToken.scopes, ROLES.operator, 'by default: everything the role has');
  assert.equal((await bearer(platform, opToken.token)('PUT', '/shows/nope/scene', { scene: 'brb' })).status, 404);
  assert.equal((await operator.call('DELETE', `/tokens/${made.body.id}`)).status, 404, 'not theirs');
  // The creator demoted: the token shrinks with them.
  await owner.call('PATCH', '/users/operator', { role: 'viewer' });
  assert.equal((await bearer(platform, opToken.token)('PUT', '/shows/nope/scene', { scene: 'brb' })).status, 403);
  // An address list.
  const lan = (await owner.call('POST', '/tokens', { name: 'lan only', scopes: ['timeline:read'], ips: ['192.168.1.0/24'] })).body;
  assert.match((await bearer(platform, lan.token)('GET', '/shows')).body.detail, /can't be used from this address/);
  const here = (await owner.call('POST', '/tokens', { name: 'here', scopes: ['timeline:read'], ips: ['127.0.0.1', '::1'] })).body;
  assert.equal((await bearer(platform, here.token)('GET', '/shows')).status, 200);
  for (const bad of [{ name: '' }, { name: 'x', scopes: ['everything'] }, { name: 'x', ips: ['not an ip'] }, { name: 'x', expiresAt: '2020-01-01T00:00:00Z' }]) {
    assert.equal((await owner.call('POST', '/tokens', bad)).status, 422, JSON.stringify(bad));
  }
  // Expiry (the owner signs in again: a day is also as long as their session lasts).
  const brief = (await owner.call('POST', '/tokens', { name: 'brief', scopes: ['timeline:read'], expiresInDays: 1 })).body;
  clock.t += 24 * HOUR;
  const expired = await bearer(platform, brief.token)('GET', '/shows');
  assert.deepEqual([expired.status, expired.body.detail], [401, 'That API token has expired. Create a new one.']);
  assert.equal((await owner.call('POST', '/auth/login', { username: 'juan', password: PASSWORD })).status, 200);
  // Revoked: gone at once.
  assert.equal((await owner.call('DELETE', `/tokens/${made.body.id}`)).status, 200);
  assert.equal((await deck('GET', '/shows')).status, 401);
  await platform.stop();
  assert.ok(!storeDump(config).includes(token.slice(8)), 'only its hash is stored');
});

// ---- two-factor ----------------------------------------------------------------------------------
test('two-factor: enroll with the password, confirm a code, ten recovery codes; sign-in then asks for a code, and each is used once', async (t) => {
  const { platform, owner, clock } = await withOwner(t);
  assert.equal((await owner.call('POST', '/auth/totp/enroll', { password: 'wrong' })).status, 403);
  const enrolled = (await owner.call('POST', '/auth/totp/enroll', { password: PASSWORD })).body;
  assert.match(enrolled.secret, /^[A-Z2-7]{32}$/);
  assert.match(enrolled.uri, new RegExp(`^otpauth://totp/Stream%20Kit:juan\\?secret=${enrolled.secret}&issuer=Stream%20Kit`));
  assert.equal((await owner.call('POST', '/auth/totp/verify', { code: '000000' })).status, 422);
  const code = () => hotp(enrolled.secret, stepAt(clock.t));
  const on = await owner.call('POST', '/auth/totp/verify', { code: code() });
  assert.equal(on.status, 200);
  assert.equal(on.body.recoveryCodes.length, 10);
  assert.ok(on.body.recoveryCodes.every((c) => /^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/.test(c)));
  assert.equal((await owner.call('GET', '/auth/session')).status, 200, 'signed in again with a new cookie');
  // Signing in now takes a code.
  const b = browser(platform);
  const asked = await b.call('POST', '/auth/login', { username: 'juan', password: PASSWORD });
  assert.deepEqual([asked.status, asked.body.type], [401, 'https://skp.dev/errors/totp-required']);
  clock.t += 30 * 1000;
  assert.equal((await b.call('POST', '/auth/login', { username: 'juan', password: PASSWORD, code: code() })).status, 200);
  const replay = await browser(platform).call('POST', '/auth/login', { username: 'juan', password: PASSWORD, code: code() });
  assert.deepEqual([replay.status, replay.body.type], [401, 'https://skp.dev/errors/bad-code'], 'a code works once');
  const recovery = on.body.recoveryCodes[3];
  assert.equal((await browser(platform).call('POST', '/auth/login', { username: 'juan', password: PASSWORD, code: recovery.toLowerCase() })).status, 200);
  assert.equal((await browser(platform).call('POST', '/auth/login', { username: 'juan', password: PASSWORD, code: recovery })).status, 401);
  // Off again, with the password.
  assert.equal((await b.call('DELETE', '/auth/totp', { password: PASSWORD })).status, 200);
  assert.equal((await browser(platform).call('POST', '/auth/login', { username: 'juan', password: PASSWORD })).status, 200);
});

// ---- the local token and the command line ---------------------------------------------------------
test('the command line\'s local token: written at start (0600), only from this machine, removed at stop', async (t) => {
  const { platform, config } = await setup(t);
  const file = path.join(config.configDir, LOCAL_TOKEN_FILE);
  const token = readFileSync(file, 'utf8').trim();
  assert.match(token, /^skp_cli_[0-9A-Za-z]{43}$/);
  assert.equal(token, platform.auth.localToken);
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
  const req = (remoteAddress) => ({ headers: { authorization: `Bearer ${token}` }, socket: { remoteAddress } });
  assert.equal(platform.auth.authenticate(req('127.0.0.1')).principal.kind, 'local');
  assert.equal(platform.auth.authenticate(req('::ffff:127.0.0.1')).principal.role, 'owner');
  assert.match(platform.auth.authenticate(req('192.168.1.5')).error, /only from this machine/);
  assert.match(platform.auth.authenticate({ headers: { authorization: 'Bearer skp_cli_nope' }, socket: { remoteAddress: '127.0.0.1' } }).error, /doesn't match/);
  assert.match(platform.auth.authenticate({ headers: { authorization: 'Basic abc' }, socket: {} }).error, /Bearer/);
  await platform.stop();
  assert.equal(existsSync(file), false);
});

async function cli(argv, env, stdin) {
  let stdout = '';
  let stderr = '';
  const code = await run(argv, { stdout: { write: (s) => { stdout += s; } }, stderr: { write: (s) => { stderr += s; } }, env, stdin: stdin ?? Readable.from([]) });
  return { code, stdout, stderr };
}

test('skp setup, user, token and audit drive the running platform', async (t) => {
  const { platform, config } = await setup(t);
  const env = { SKP_DATA_DIR: config.dataDir, SKP_CONFIG_DIR: config.configDir, SKP_PORT: String(platform.port) };
  const pipe = (s) => Readable.from([`${s}\n`]);
  const noCode = await cli(['setup', '--username', 'juan'], env);
  assert.equal(noCode.code, 64);
  const made = await cli(['setup', '--code', platform.auth.setupCode, '--username', 'juan'], env, pipe(PASSWORD));
  assert.equal(made.code, 0, made.stderr);
  assert.match(made.stdout, /created the owner account juan/);
  assert.equal((await cli(['setup', '--code', 'X', '--username', 'x'], env, pipe(PASSWORD))).code, 64, 'once');
  const added = await cli(['user', 'add', 'ana', '--role', 'operator'], env, pipe('ana\'s own good password'));
  assert.equal(added.code, 0, added.stderr);
  const weak = await cli(['user', 'add', 'bo', '--role', 'viewer', '--json'], env, pipe('password1234'));
  assert.equal(weak.code, 1);
  assert.equal(JSON.parse(weak.stdout).error, 'weak-password');
  assert.match((await cli(['user', 'list'], env)).stdout, /^ana\s+operator\s+2FA off\s+never signed in$/m);
  assert.match((await cli(['user', 'role', 'ana', 'admin'], env)).stdout, /ana is admin now/);
  assert.match((await cli(['user', 'password', 'juan'], env, pipe('the owner forgot it once'))).stdout, /new password for juan/);
  const login = await browser(platform).call('POST', '/auth/login', { username: 'juan', password: 'the owner forgot it once' });
  assert.equal(login.status, 200, 'the owner can sign in with it');
  assert.match((await cli(['user', 'reset-2fa', 'ana'], env)).stdout, /two-factor is off for ana/);
  const created = await cli(['token', 'create', '--name', 'Stream Deck', '--scopes', 'overlays:control,timeline:read', '--expires-days', '30'], env);
  assert.equal(created.code, 0, created.stderr);
  const token = created.stdout.trim();
  assert.match(token, /^skp_pat_\w{43}$/);
  assert.match(created.stderr, /shown this once/);
  assert.equal((await bearer(platform, token)('GET', '/shows')).status, 200);
  const tokens = JSON.parse((await cli(['token', 'list', '--json'], env)).stdout);
  assert.deepEqual(tokens.map((k) => [k.name, k.user]), [['Stream Deck', 'juan']]);
  assert.match((await cli(['token', 'revoke', tokens[0].id], env)).stdout, /revoked tok_/);
  assert.match((await cli(['user', 'remove', 'ana'], env)).stdout, /removed ana/);
  const audit = JSON.parse((await cli(['audit', '--limit', '20', '--json'], env)).stdout);
  // (Resetting two-factor that was off changes nothing, so it isn't recorded.)
  assert.deepEqual(audit.items.map((e) => e.action).reverse(), ['setup', 'user.create', 'user.role', 'user.password', 'login', 'token.create', 'token.revoke', 'user.delete']);
  assert.ok(audit.items.filter((e) => e.action.startsWith('user.') || e.action.startsWith('token.')).every((e) => e.actor === 'local'));
  assert.match((await cli(['audit', '--action', 'token'], env)).stdout, /token\.revoke\s+local/);
  // Without the platform's local token (another config directory): told why.
  const lost = await cli(['user', 'list'], { ...env, SKP_CONFIG_DIR: path.join(path.dirname(config.configDir), 'elsewhere') });
  assert.equal(lost.code, 1);
  assert.match(lost.stderr, /no local token in .*elsewhere/);
});

// ---- the audit log -------------------------------------------------------------------------------
test('the audit log: who, from where, what, newest first, paged; never a secret; kept 90 days', async (t) => {
  const { platform, owner, entries, config } = await withOwner(t);
  await browser(platform).call('POST', '/auth/login', { username: 'juan', password: 'not the password' });
  const tok = (await owner.call('POST', '/tokens', { name: 'bot', scopes: ['timeline:read'] })).body;
  await owner.call('POST', '/users', { username: 'ana', password: `${PASSWORD} ana`, role: 'viewer' });
  const page = (await owner.call('GET', '/system/audit?limit=2')).body;
  assert.deepEqual(page.items.map((e) => e.action), ['user.create', 'token.create']);
  const next = (await owner.call('GET', `/system/audit?limit=2&cursor=${page.next}`)).body;
  assert.deepEqual(next.items.map((e) => e.action), ['login.failure', 'setup']);
  const failure = next.items[0];
  assert.deepEqual([failure.actor, failure.details.reason], ['juan', 'password']);
  assert.match(failure.ip, /127\.0\.0\.1/);
  assert.equal((await owner.call('GET', '/system/audit?limit=500')).status, 422);
  // No password, token or cookie in the audit log or the log.
  const all = JSON.stringify((await owner.call('GET', '/system/audit?limit=200')).body) + JSON.stringify(entries);
  for (const secret of [PASSWORD, 'not the password', tok.token, owner.cookie.split('=')[1]]) assert.ok(!all.includes(secret), 'no secret leaks');
  assert.equal(config.auditDays, 90);
  // Retention: entries older than the window go.
  const store = { docs: new Map() };
  const fake = {
    put: (c, id, data) => store.docs.set(id, data),
    delete: (c, id) => store.docs.delete(id),
    list: (c, { after = '', limit }) => [...store.docs.keys()].sort().filter((k) => k > after).slice(0, limit).map((id) => ({ id, data: store.docs.get(id) })),
  };
  let now = Date.UTC(2026, 0, 1);
  const audit = createAudit({ store: fake, now: () => now, retentionDays: 90 });
  audit.record({ action: 'old', actor: 'x' });
  now += 91 * 24 * HOUR;
  audit.record({ action: 'new', actor: 'x' });
  assert.deepEqual(audit.list().items.map((e) => e.action), ['new']);
  // A store that fails never breaks what is being recorded.
  const broken = createAudit({ store: { put() { throw new Error('disk full'); }, list: () => [], delete() {} } });
  assert.doesNotThrow(() => broken.record({ action: 'x', actor: 'y' }));
});
