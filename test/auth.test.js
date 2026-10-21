// Sign-in and accounts (07 §7.2–7.5, §7.12): the setup code and the owner, passwords, sessions and
// CSRF, login protection, roles, API tokens, two-factor codes, the command line's local token, and
// the audit log.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { Readable } from 'node:stream';
import { startPlatform } from '../src/app.js';
import { cliActor, createAudit } from '../src/auth/audit.js';
import { IDLE_MS, KEEP_MS, LOCAL_TOKEN_FILE, SESSION_MS, SETUP_MS } from '../src/auth/index.js';
import { BusyError, createHasher, passwordProblem, SCRYPT } from '../src/auth/passwords.js';
import { ROLES } from '../src/auth/roles.js';
import { createGuard } from '../src/auth/routes.js';
import { base32Decode, base32Encode, hotp, stepAt, verifyTotp } from '../src/auth/totp.js';
import { run } from '../src/cli.js';
import { loadConfig } from '../src/config.js';
import { clientOf } from '../src/net.js';
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
    return { status: res.status, body: json, setCookie, retryAfter: res.headers.get('retry-after'), etag: res.headers.get('etag') };
  };
  return b;
}

// What the admin UI sends to change an account: the ETag it read (03 §3.1).
const readFirst = async (b, ref) => ({ 'if-match': (await b.call('GET', `/users/${ref}`)).etag });

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

test('passwords: hashed one at a time; with more than ten waiting, the next is refused (busy)', async (t) => {
  // Count the scrypt calls actually running (passwords.js imports scrypt by name: a live binding).
  let running = 0;
  let most = 0;
  const scrypt = crypto.scrypt;
  crypto.scrypt = (password, salt, length, options, done) => {
    most = Math.max(most, ++running);
    scrypt(password, salt, length, options, (err, key) => {
      running--;
      done(err, key);
    });
  };
  syncBuiltinESMExports();
  t.after(() => {
    crypto.scrypt = scrypt;
    syncBuiltinESMExports();
  });
  const hasher = createHasher({ params: { N: 4096, r: 8, p: 1 }, maxWaiting: 10 });
  const results = await Promise.all(Array.from({ length: 13 }, (_, i) => hasher.hash(`password number ${i}`).catch((err) => err)));
  const busy = results.filter((r) => r instanceof BusyError);
  assert.equal(busy.length, 2, 'eleven accepted (one running, ten waiting), two refused');
  assert.ok(busy[0].retryAfterS >= 1);
  assert.equal(hasher.waiting, 0);
  assert.equal(results.filter((r) => typeof r === 'string').length, 11);
  assert.equal(most, 1, 'never two scrypt calls at once (07 §7.3: 128 MiB each)');
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

test('a check that isn\'t a use (an open /events stream\'s, at each heartbeat) leaves the session\'s last use: it still ends after 12 idle hours', async (t) => {
  const { platform, clock } = await setup(t);
  const { auth, store } = platform;
  const at = { ip: '127.0.0.1' };
  await auth.createOwner({ code: auth.setupCode, username: 'juan', password: PASSWORD }, at);
  // A browser tab's requests, at the platform's own address.
  const tab = async () => {
    const { cookie } = await auth.login({ username: 'juan', password: PASSWORD }, at);
    const req = { method: 'GET', headers: { host: 'skp.test', cookie: cookie.split(';')[0] }, socket: { remoteAddress: '127.0.0.1' } };
    return { req, id: auth.authenticate(req).principal.sessionId };
  };
  const lastSeen = ({ id }) => store.get('sessions', id).data.lastSeenAt;
  const guard = createGuard({ auth, hosts: () => ['skp.test'] });
  const answer = { writeHead(status) { this.status = status; return this; }, setHeader() {}, end() {} };
  const left = await tab(); // nothing but its stream, open
  const used = await tab(); // used now and then
  const signedIn = clock.t;
  clock.t += 5 * MIN;
  assert.equal(auth.authenticate(left.req, { touch: false }).principal.label, 'juan');
  assert.equal(lastSeen(left), signedIn, 'checked, not used');
  assert.equal(guard(used.req, answer, 'events:read').label, 'juan');
  assert.equal(lastSeen(used), clock.t, 'a request is a use');
  // The stream's check, every minute for 12 hours: the session it checks ends all the same.
  while (clock.t + MIN < signedIn + IDLE_MS) {
    clock.t += MIN;
    assert.ok(guard(left.req, answer, 'events:read', { touch: false }));
  }
  assert.equal(lastSeen(left), signedIn);
  clock.t = signedIn + IDLE_MS;
  assert.equal(guard(left.req, answer, 'events:read', { touch: false }), undefined, 'idle for 12 hours: over');
  assert.equal(answer.status, 401);
  assert.equal(store.get('sessions', left.id), undefined);
  assert.equal(guard(used.req, answer, 'events:read').label, 'juan', 'the tab used 11 h 55 min ago goes on');
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

test('your sessions: newest first, and paged a page at a time, each once', async (t) => {
  const { platform, owner, clock } = await withOwner(t);
  for (let i = 0; i < 4; i++) {
    clock.t += MIN;
    assert.equal((await browser(platform).call('POST', '/auth/login', { username: 'juan', password: PASSWORD })).status, 200);
  }
  clock.t += MIN;
  assert.equal((await owner.call('GET', '/auth/session')).status, 200, 'the oldest is the one used last');
  const all = (await owner.call('GET', '/auth/sessions')).body.items;
  assert.equal(all.length, 5);
  assert.deepEqual(all.map((s) => s.createdAt), all.map((s) => s.createdAt).sort().reverse(), 'newest first');
  assert.equal(all[4].current, true);
  const walked = [];
  let cursor;
  do {
    const page = (await owner.call('GET', `/auth/sessions?limit=2${cursor ? `&cursor=${cursor}` : ''}`)).body;
    walked.push(...page.items);
    cursor = page.next;
  } while (cursor);
  assert.deepEqual(walked.map((s) => s.id), all.map((s) => s.id));
});

test('over HTTPS only the __Host- cookie counts, and signing out clears both names', async (t) => {
  const { platform, owner } = await withOwner(t);
  const value = owner.cookie.split('=')[1];
  const as = (cookie, https) => platform.auth.authenticate({ headers: { cookie }, socket: { remoteAddress: '127.0.0.1' }, client: { ip: '127.0.0.1', https, proxied: false } });
  assert.equal(as(`skp_session=${value}`, false).principal.user.username, 'juan');
  assert.deepEqual(as(`skp_session=${value}`, true), {}, 'a cookie plain HTTP could have planted signs nobody in over HTTPS');
  assert.equal(as(`__Host-skp_session=${value}`, true).principal.user.username, 'juan');
  assert.deepEqual(as(`__Host-skp_session=${value}`, false), {});
  const out = platform.auth.logout(as(`__Host-skp_session=${value}`, true).principal, { https: true });
  assert.deepEqual(out.cookie, ['__Host-skp_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0; Secure', 'skp_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0']);
  assert.equal(platform.auth.logout({ kind: 'local' }, { https: false }).cookie, 'skp_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
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

test('login protection counts each address across names, and each account across addresses; a success starts the account over', async (t) => {
  const { platform, clock } = await withOwner(t);
  const tryAs = (username, password, ip) => platform.auth.login({ username, password }, { ip }).then(() => 200, (err) => err.status);
  for (let i = 0; i < 10; i++) assert.equal(await tryAs(`nobody${i}`, 'wrong password!', '203.0.113.1'), 401);
  assert.equal(await tryAs('juan', PASSWORD, '203.0.113.1'), 429, 'one address trying many names waits');
  assert.equal(await tryAs('juan', PASSWORD, '192.0.2.1'), 200, 'the account itself is fine');
  for (let i = 0; i < 10; i++) assert.equal(await tryAs('juan', 'wrong password!', `198.51.100.${i}`), 401);
  assert.equal(await tryAs('juan', PASSWORD, '192.0.2.1'), 429, 'one account tried from many addresses waits');
  clock.t += 30 * MIN;
  for (let i = 0; i < 9; i++) assert.equal(await tryAs('juan', 'wrong password!', `198.51.100.${i}`), 401);
  assert.equal(await tryAs('juan', PASSWORD, '192.0.2.2'), 200);
  assert.equal(await tryAs('juan', 'wrong password!', '192.0.2.3'), 401);
  assert.equal(await tryAs('juan', PASSWORD, '192.0.2.4'), 200, 'the success started the count over: one failure, not ten');
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
  // An account has an ETag, and the admin UI changes the one it read (03 §3.1).
  const read = await owner.call('GET', '/users/ana');
  assert.equal(read.etag, `"${read.body.id}-r${read.body.rev}"`);
  const blind = await owner.call('PATCH', '/users/ana', { role: 'viewer' });
  assert.deepEqual([blind.status, blind.body.type], [428, 'https://skp.dev/errors/if-match-required']);
  assert.equal((await owner.call('PATCH', '/users/ana', { role: 'viewer' }, { 'if-match': `"${read.body.id}-r${read.body.rev - 1}"` })).status, 412);
  // A role change ends her sessions.
  const demoted = await owner.call('PATCH', '/users/ana', { role: 'viewer' }, { 'if-match': read.etag });
  assert.deepEqual([demoted.body.role, demoted.etag], ['viewer', `"${read.body.id}-r${read.body.rev + 1}"`]);
  assert.equal((await ana.call('GET', '/auth/session')).status, 401);
  assert.equal((await owner.call('PATCH', '/users/juan', { role: 'admin' }, await readFirst(owner, 'juan'))).status, 409, 'the owner stays the owner');
  // The owner's own password and two-factor: with the current password, at /auth/password and
  // /auth/totp; not through the accounts route, by a session (perhaps stolen) or a token.
  for (const patch of [{ password: 'taken over by a token 1' }, { totp: false }]) {
    const own = await owner.call('PATCH', '/users/juan', patch, await readFirst(owner, 'juan'));
    assert.deepEqual([own.status, own.body.type], [403, 'https://skp.dev/errors/owner'], JSON.stringify(patch));
  }
  const admin = bearer(ctx.platform, (await owner.call('POST', '/tokens', { name: 'accounts', scopes: ['users:admin'] })).body.token);
  for (const patch of [{ password: 'taken over by a token 1' }, { totp: false }, { role: 'viewer' }]) assert.equal((await admin('PATCH', '/users/juan', patch)).status, patch.role ? 409 : 403, JSON.stringify(patch));
  assert.equal((await browser(ctx.platform).call('POST', '/auth/login', { username: 'juan', password: 'taken over by a token 1' })).status, 401);
  assert.equal((await admin('PATCH', '/users/ana', { password: 'reset by the owner\'s token' })).status, 200, 'other accounts are what users:admin is for');
  // Her own password change ends her other sessions and keeps her signed in here.
  const here = browser(ctx.platform);
  await here.call('POST', '/auth/login', { username: 'ana', password: 'reset by the owner\'s token' });
  const there = browser(ctx.platform);
  await there.call('POST', '/auth/login', { username: 'ana', password: 'reset by the owner\'s token' });
  assert.equal((await here.call('POST', '/auth/password', { current: 'wrong', password: 'a whole new password' })).status, 403);
  const changed = await here.call('POST', '/auth/password', { current: 'reset by the owner\'s token', password: 'a whole new password' });
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
  // What only a person does (their sessions, password, two-factor): not with a token, nor from
  // the command line.
  for (const [method, url, body] of [['GET', '/auth/sessions'], ['DELETE', '/auth/sessions/ses_01J00000000000000000000000'], ['POST', '/auth/password', { current: PASSWORD, password: 'another long password' }], ['POST', '/auth/totp/enroll', { password: PASSWORD }], ['POST', '/auth/totp/verify', { code: '000000' }], ['DELETE', '/auth/totp', { password: PASSWORD }]]) {
    for (const who of [deck, bearer(platform, platform.auth.localToken)]) {
      const r = await who(method, url, body);
      assert.deepEqual([r.status, r.body.type], [403, 'https://skp.dev/errors/session-only'], `${method} ${url}`);
    }
  }
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
  assert.equal((await owner.call('PATCH', '/users/operator', { role: 'viewer' }, await readFirst(owner, 'operator'))).status, 200);
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
  assert.match(enrolled.uri, new RegExp(`^otpauth://totp/CTD%20Overlay:juan\\?secret=${enrolled.secret}&issuer=CTD%20Overlay`));
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
  // Off again, with the password: not without it.
  const guessed = await b.call('DELETE', '/auth/totp', { password: 'not the password' });
  assert.deepEqual([guessed.status, guessed.body.type], [403, 'https://skp.dev/errors/bad-credentials']);
  assert.equal((await browser(platform).call('POST', '/auth/login', { username: 'juan', password: PASSWORD })).body.type, 'https://skp.dev/errors/totp-required', 'still on');
  assert.equal((await b.call('DELETE', '/auth/totp', { password: PASSWORD })).status, 200);
  assert.equal((await browser(platform).call('POST', '/auth/login', { username: 'juan', password: PASSWORD })).status, 200);
});

test('two-factor whose secret no longer decrypts (restored without the master key): the recovery codes still sign in', async (t) => {
  const { platform, owner, clock, config, dataRoot } = await withOwner(t);
  const { secret } = (await owner.call('POST', '/auth/totp/enroll', { password: PASSWORD })).body;
  const { recoveryCodes } = (await owner.call('POST', '/auth/totp/verify', { code: hotp(secret, stepAt(clock.t)) })).body;
  await platform.stop();
  rmSync(path.join(config.configDir, 'master.key'));
  const again = await setup(t, { dataRoot, start: clock.t + MIN });
  const b = browser(again.platform);
  const code = await b.call('POST', '/auth/login', { username: 'juan', password: PASSWORD, code: hotp(secret, stepAt(again.clock.t)) });
  assert.equal(code.status, 422);
  assert.match(code.body.detail, /restore that master key/, 'a six-digit code says why it can\'t be checked');
  assert.equal((await b.call('POST', '/auth/login', { username: 'juan', password: PASSWORD, code: recoveryCodes[0] })).status, 200);
  assert.equal((await browser(again.platform).call('POST', '/auth/login', { username: 'juan', password: PASSWORD, code: recoveryCodes[0] })).status, 422, 'once');
});

test('a two-factor secret is encrypted for its own account (totp:<user id>, 07 §7.7): put in another\'s record, it neither turns two-factor on nor signs in there', async (t) => {
  const ctx = await withOwner(t);
  const { platform, owner, clock } = ctx;
  const bo = await userWith(ctx, 'admin', 'bo');
  const record = (username) => platform.store.list('users', { limit: 1000 }).find((d) => d.data.username === username);
  const { secret } = (await owner.call('POST', '/auth/totp/enroll', { password: PASSWORD })).body;
  assert.equal((await bo.call('POST', '/auth/totp/enroll', { password: `${PASSWORD} admin` })).status, 200);
  const pending = record('juan').data.totpPending.secret;
  assert.match(pending, /^enc:v1:/);
  assert.ok(!JSON.stringify(record('juan').data).includes(secret), 'never as it is');
  // The owner's secret, being enrolled, copied into bo's record: a code from it doesn't confirm bo's.
  platform.store.put('users', record('bo').id, { ...record('bo').data, totpPending: { ...record('bo').data.totpPending, secret: pending } });
  const confirming = await bo.call('POST', '/auth/totp/verify', { code: hotp(secret, stepAt(clock.t)) });
  assert.equal(confirming.status, 422);
  assert.equal(record('bo').data.totp, undefined, 'still off');
  // On for the owner, and that secret copied into bo's record: a code from it doesn't sign bo in.
  assert.equal((await owner.call('POST', '/auth/totp/verify', { code: hotp(secret, stepAt(clock.t)) })).status, 200);
  const on = record('juan').data.totp;
  assert.match(on.secret, /^enc:v1:/);
  const moved = { ...record('bo').data, totp: on };
  delete moved.totpPending;
  platform.store.put('users', record('bo').id, moved);
  clock.t += 30 * 1000;
  const code = hotp(secret, stepAt(clock.t));
  const signing = await browser(platform).call('POST', '/auth/login', { username: 'bo', password: `${PASSWORD} admin`, code });
  assert.deepEqual([signing.status, signing.setCookie], [422, null], 'no session');
  assert.equal((await browser(platform).call('POST', '/auth/login', { username: 'juan', password: PASSWORD, code })).status, 200, 'the same code, the owner\'s');
});

test('the password asked for again (a new password, two-factor) is throttled and recorded like a sign-in', async (t) => {
  const { platform, owner, clock } = await withOwner(t);
  const asks = [['POST', '/auth/password', (p) => ({ current: p, password: 'another long password' })], ['POST', '/auth/totp/enroll', (p) => ({ password: p })], ['DELETE', '/auth/totp', (p) => ({ password: p })]];
  for (let i = 0; i < 10; i++) {
    const [method, url, body] = asks[i % 3];
    assert.equal((await owner.call(method, url, body('not the password'))).status, 403, url);
  }
  const waits = await owner.call('POST', '/auth/totp/enroll', { password: PASSWORD });
  assert.deepEqual([waits.status, waits.body.type, waits.retryAfter], [429, 'https://skp.dev/errors/throttled', '1'], 'even the right password waits');
  assert.equal((await browser(platform).call('POST', '/auth/login', { username: 'juan', password: PASSWORD })).status, 429, 'one count with signing in');
  const failures = platform.audit.list({ action: 'login.failure' }).items;
  assert.equal(failures.length, 10);
  assert.ok(failures.every((e) => e.actor === 'juan' && e.details.reason === 'recheck' && /127\.0\.0\.1/.test(e.ip)));
  clock.t += 1000;
  assert.equal((await owner.call('POST', '/auth/totp/enroll', { password: PASSWORD })).status, 200);
});

test('answers that hold a secret are never kept for replay: a token, a two-factor secret, a session', async (t) => {
  const { platform, owner } = await withOwner(t);
  const once = { 'idempotency-key': 'press-1' };
  const first = await owner.call('POST', '/tokens', { name: 'deck' }, once);
  const again = await owner.call('POST', '/tokens', { name: 'deck' }, once);
  assert.deepEqual([first.status, again.status], [201, 201]);
  assert.notEqual(again.body.token, first.body.token, 'a second token, not the first one\'s secret again');
  assert.equal((await owner.call('POST', '/auth/totp/enroll', { password: PASSWORD }, { 'idempotency-key': 'enroll-1' })).status, 200);
  assert.equal((await browser(platform).call('POST', '/auth/login', { username: 'juan', password: PASSWORD }, { 'idempotency-key': 'login-1' })).status, 200);
  const kept = JSON.stringify(platform.store.list('idempotency', { limit: 1000 }));
  for (const secret of ['skp_pat_', 'otpauth:', 'csrf']) assert.ok(!kept.includes(secret), secret);
});

// ---- the local token and the command line ---------------------------------------------------------
test('the command line\'s local token: written at start (0600), only from this machine, removed at stop', async (t) => {
  const { platform, config } = await setup(t);
  const file = path.join(config.configDir, LOCAL_TOKEN_FILE);
  const token = readFileSync(file, 'utf8').trim();
  assert.match(token, /^skp_cli_[0-9A-Za-z]{43}$/);
  assert.equal(token, platform.auth.localToken);
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
  const req = (remoteAddress, headers = {}) => ({ headers: { authorization: `Bearer ${token}`, ...headers }, socket: { remoteAddress } });
  const local = platform.auth.authenticate(req('127.0.0.1')).principal;
  assert.deepEqual([local.kind, local.label], ['local', cliActor()], 'its changes are the command line\'s: cli:<user> (07 §7.12)');
  assert.match(local.label, /^cli(:.+)?$/);
  assert.equal(platform.auth.authenticate(req('::ffff:127.0.0.1')).principal.role, 'owner');
  assert.match(platform.auth.authenticate(req('192.168.1.5')).error, /only from this machine/);
  // Through a proxy on this machine (trusted or not), which connects from loopback too: what it
  // adds gives it away. The command line's own requests beside a trusted proxy still work.
  const via = (headers, trust) => {
    const r = req('127.0.0.1', headers);
    return { ...r, client: clientOf(r, trust) };
  };
  for (const [header, value] of [['x-forwarded-for', '203.0.113.9'], ['x-forwarded-proto', 'https'], ['forwarded', 'for=203.0.113.9'], ['x-real-ip', '203.0.113.9'], ['x-forwarded-host', 'overlays.example.com'], ['via', '1.1 caddy']]) {
    for (const trust of [['127.0.0.1'], []]) assert.match(platform.auth.authenticate(via({ [header]: value }, trust)).error, /only from this machine/, `${header}, ${trust.length ? 'a trusted proxy' : 'a proxy not trusted'}`);
  }
  assert.equal(platform.auth.authenticate(via({}, ['127.0.0.1'])).principal.kind, 'local', 'the command line beside a trusted proxy');
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
  // Made from the command line: cli:<user> (07 §7.12), as the commands that open the data do.
  const fromCli = audit.items.filter((e) => e.action.startsWith('user.') || e.action.startsWith('token.'));
  assert.equal(fromCli.length, 6);
  assert.ok(fromCli.every((e) => e.actor === cliActor()), JSON.stringify(fromCli.map((e) => e.actor)));
  assert.match((await cli(['audit', '--action', 'token'], env)).stdout, new RegExp(`token\\.revoke\\s+${cliActor().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
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
