// The API's conventions (03 §3.1–3.5) and the resources the admin UI uses: OpenAPI, ETag and
// If-Match, idempotency keys, rate limits, pagination, unknown fields, problems; overlays,
// templates, media, system, live events and state; and downloads pinned to the address checked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { createServer } from 'node:https';
import path from 'node:path';
import { startPlatform } from '../src/app.js';
import { hotp, stepAt } from '../src/auth/totp.js';
import { loadConfig } from '../src/config.js';
import { pinnedFetch } from '../src/net.js';
import { writeZip } from '../src/templates/zip.js';
import { DIAG, DIAG_DIR, defer, FIXTURE_TEMPLATES, memoryLogger, packTemplate, signedIn, tempDir, TESTBED } from './helpers.js';
import { selfSigned } from './tls.js';

const PASSWORD = 'correct horse battery staple';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
const SHOW = { name: 'Night', overlays: [], date: '2026-10-17', timezone: 'America/Toronto' };

async function start(t, options = {}) {
  const root = tempDir(t);
  const config = loadConfig({ argv: ['--port', '0'], env: { SKP_DATA_DIR: path.join(root, 'data'), SKP_CONFIG_DIR: path.join(root, 'config') } });
  const { log, entries } = memoryLogger();
  const platform = await startPlatform(config, { log, templateDirs: [FIXTURE_TEMPLATES], scrypt: { N: 1024 }, ...options });
  defer(t, () => platform.stop());
  // As the command line (a token: If-Match may be left out).
  const api = async (method, p, body, headers = {}) => {
    const raw = Buffer.isBuffer(body);
    const res = await fetch(`${platform.url}/api/v1${p}`, { method, headers: signedIn(platform, { ...(body !== undefined ? { 'content-type': raw ? 'application/octet-stream' : 'application/json' } : {}), ...headers }), body: body === undefined ? undefined : raw ? body : JSON.stringify(body) });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json, headers: res.headers };
  };
  return { platform, config, entries, api };
}

// A signed-in browser (a session: If-Match is required on PATCH and PUT of a resource).
async function owner(platform) {
  const made = await fetch(`${platform.url}/api/v1/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: platform.auth.setupCode, username: 'juan', password: PASSWORD }) });
  const cookie = made.headers.get('set-cookie').split(';')[0];
  const { csrf } = await made.json();
  return (method, p, body, headers = {}) => fetch(`${platform.url}/api/v1${p}`, { method, headers: { cookie, 'x-skp-csrf': csrf, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
    .then(async (res) => ({ status: res.status, body: await res.json().catch(() => null), headers: res.headers }));
}

test('the OpenAPI document describes every API route, with its scope', async (t) => {
  const { platform } = await start(t);
  const res = await fetch(`${platform.url}/api/v1/openapi.json`);
  assert.equal(res.status, 200, 'no sign-in needed');
  const doc = await res.json();
  assert.equal(doc.openapi, '3.1.0');
  for (const [p, m] of [['/api/v1/shows/{ref}', 'patch'], ['/api/v1/overlays/{ref}/key/rotate', 'post'], ['/api/v1/templates', 'post'], ['/api/v1/media', 'post'], ['/api/v1/events', 'get'], ['/api/v1/auth/login', 'post'], ['/api/v1/shows/{ref}/cues/{cueId}/{op}', 'post']]) {
    assert.ok(doc.paths[p]?.[m], `${m} ${p}`);
  }
  assert.equal(doc.paths['/api/v1/shows/{ref}'].patch['x-skp-scope'], 'timeline:write');
  assert.deepEqual(doc.paths['/api/v1/auth/login'].post.security, []);
  assert.deepEqual(Object.keys(doc.paths['/api/v1/shows'].post.requestBody.content['application/json'].schema.properties), ['name', 'overlays', 'date', 'timezone', 'dayBoundary', 'goLive', 'lineup', 'followObs']);
  // Uploads are bytes, streamed or not (a media file as anything: its type is read from its bytes);
  // a write without a list of fields still takes a JSON object.
  assert.deepEqual(Object.keys(doc.paths['/api/v1/media'].post.requestBody.content), ['*/*']);
  assert.ok(doc.paths['/api/v1/templates'].post.requestBody.content['application/octet-stream']);
  assert.equal(doc.paths['/api/v1/overlays/{ref}/simulate'].post.requestBody.content['application/json'].schema.type, 'object');
  // What a success answers, and with what.
  assert.ok(doc.paths['/api/v1/events'].post.responses['202']);
  assert.deepEqual(Object.keys(doc.paths['/api/v1/events'].get.responses['200'].content), ['text/event-stream']);
  assert.deepEqual(doc.paths['/api/v1/events'].get.parameters.map((p) => `${p.in}:${p.name}`), ['query:types']);
  // Every API route the server has is in it, and nothing else.
  const described = new Set(Object.entries(doc.paths).flatMap(([p, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${p}`)));
  const served = new Set(platform.server.routes.filter((r) => r.path.startsWith('/api/v1/')).map((r) => `${r.method} ${r.path.replace(/:([A-Za-z]+)/g, '{$1}').replace(/\/\*$/, '/{path}')}`));
  assert.ok(served.size > 50);
  assert.deepEqual(described, served);
});

test('ETag and If-Match (H16): a session must send it on PATCH and PUT; a stale one is refused; a token may leave it out', async (t) => {
  const { platform, api } = await start(t);
  const ui = await owner(platform);
  const made = await ui('POST', '/shows', SHOW);
  assert.equal(made.status, 201);
  const etag = made.headers.get('etag');
  assert.equal(etag, `"${made.body.id}-r${made.body.rev}"`);
  assert.equal((await ui('GET', `/shows/${made.body.id}`)).headers.get('etag'), etag);
  const without = await ui('PATCH', '/shows/Night', { goLive: '22:00' });
  assert.deepEqual([without.status, without.body.type], [428, 'https://skp.dev/errors/if-match-required']);
  const ok = await ui('PATCH', '/shows/Night', { goLive: '22:00' }, { 'if-match': etag });
  assert.equal(ok.status, 200);
  assert.notEqual(ok.headers.get('etag'), etag);
  const stale = await ui('PATCH', '/shows/Night', { goLive: '23:00' }, { 'if-match': etag });
  assert.deepEqual([stale.status, stale.body.type, stale.headers.get('etag')], [412, 'https://skp.dev/errors/stale', ok.headers.get('etag')]);
  assert.equal((await api('PATCH', '/shows/Night', { goLive: '23:00' })).status, 200, 'a token (the command line) may omit it');
  // A command takes no If-Match.
  assert.notEqual((await ui('PUT', '/shows/Night/scene', { scene: 'brb' })).status, 428);
  // Live control isn't an edit: an ETag read before who's on and REC changed still edits the
  // lineup mid-show; stateRev follows every change instead.
  assert.equal((await api('PATCH', '/shows/Night', { lineup: [{ time: '22:00', name: 'Opener' }, { time: '23:00', name: 'Closer', closer: true }] })).status, 200);
  const read = await ui('GET', '/shows/Night');
  assert.equal((await ui('PUT', '/shows/Night/slot', { slot: 1 })).status, 200);
  assert.equal((await ui('POST', '/shows/Night/rec', { action: 'start' })).status, 200);
  const live = await ui('GET', '/shows/Night');
  assert.equal(live.headers.get('etag'), read.headers.get('etag'), 'the ETag is the edit revision');
  assert.ok(live.body.stateRev > read.body.stateRev, 'stateRev moved');
  const edit = await ui('PATCH', '/shows/Night', { lineup: [{ time: '22:00', name: 'Opener' }, { time: '23:30', name: 'Closer', closer: true }] }, { 'if-match': read.headers.get('etag') });
  assert.equal(edit.status, 200, JSON.stringify(edit.body));
  assert.equal(edit.body.currentSlot, 1, 'who\'s on is kept');
  // An edit made meanwhile still makes it stale.
  assert.equal((await ui('PATCH', '/shows/Night', { goLive: '21:00' }, { 'if-match': read.headers.get('etag') })).status, 412);
});

test('Idempotency-Key: a repeat within 24 hours answers the first answer, once; another request with the same key is refused', async (t) => {
  const clock = { t: Date.UTC(2026, 9, 17, 18), now: () => clock.t };
  const { platform, api } = await start(t, { clock: { now: clock.now } });
  const first = await api('POST', '/shows', SHOW, { 'idempotency-key': 'button-1' });
  const again = await api('POST', '/shows', SHOW, { 'idempotency-key': 'button-1' });
  assert.deepEqual([first.status, again.status], [201, 201]);
  assert.deepEqual(again.body, first.body);
  assert.equal(again.headers.get('idempotent-replayed'), 'true');
  assert.equal(platform.shows.list().length, 1, 'made once');
  const other = await api('POST', '/shows', { ...SHOW, name: 'Other' }, { 'idempotency-key': 'button-1' });
  assert.deepEqual([other.status, other.body.type], [422, 'https://skp.dev/errors/idempotency-mismatch']);
  clock.t += 24 * 60 * 60 * 1000 + 1;
  const later = await api('POST', '/shows', { ...SHOW, name: 'Later' }, { 'idempotency-key': 'button-1' });
  assert.equal(later.status, 201, 'a day on, the key is new again');
});

test('Idempotency-Key: answers that hold a secret are never kept, nor given again (a session\'s, a token\'s, two-factor\'s)', async (t) => {
  const clock = { t: Date.UTC(2026, 9, 17, 18), now: () => clock.t };
  const { platform } = await start(t, { clock: { now: clock.now } });
  const key = { 'idempotency-key': 'secret-1' };
  const post = (p, body, headers = {}) => fetch(`${platform.url}/api/v1${p}`, { method: 'POST', headers: { 'content-type': 'application/json', ...key, ...headers }, body: JSON.stringify(body) });
  const setup = await post('/setup', { code: platform.auth.setupCode, username: 'juan', password: PASSWORD });
  assert.equal(setup.status, 201);
  const setupAgain = await post('/setup', { code: platform.auth.setupCode, username: 'juan', password: PASSWORD });
  assert.deepEqual([setupAgain.status, setupAgain.headers.get('idempotent-replayed')], [409, null], 'the owner exists: refused, not signed in again');
  const logins = [await post('/auth/login', { username: 'juan', password: PASSWORD }), await post('/auth/login', { username: 'juan', password: PASSWORD })];
  assert.deepEqual(logins.map((r) => [r.status, r.headers.get('idempotent-replayed')]), [[200, null], [200, null]]);
  assert.notEqual(logins[0].headers.get('set-cookie'), logins[1].headers.get('set-cookie'), 'a session each');
  let cookie = logins[1].headers.get('set-cookie').split(';')[0];
  const { csrf } = await logins[1].json();
  const session = (p, body) => post(p, body, { cookie, 'x-skp-csrf': csrf }).then(async (res) => ({ status: res.status, replayed: res.headers.get('idempotent-replayed'), cookie: res.headers.get('set-cookie'), body: await res.json() }));
  const tokens = [await session('/tokens', { name: 'deck' }), await session('/tokens', { name: 'deck' })];
  assert.deepEqual(tokens.map((r) => [r.status, r.replayed]), [[201, null], [201, null]]);
  assert.notEqual(tokens[0].body.token, tokens[1].body.token, 'a token each');
  const enrolled = [await session('/auth/totp/enroll', { password: PASSWORD }), await session('/auth/totp/enroll', { password: PASSWORD })];
  assert.deepEqual(enrolled.map((r) => [r.status, r.replayed]), [[200, null], [200, null]]);
  const on = await session('/auth/totp/verify', { code: hotp(enrolled[1].body.secret, stepAt(clock.t)) });
  assert.deepEqual([on.status, on.body.recoveryCodes.length], [200, 10]);
  cookie = on.cookie.split(';')[0]; // two-factor on: signed in again
  const onAgain = await session('/auth/totp/verify', { code: hotp(enrolled[1].body.secret, stepAt(clock.t)) });
  assert.deepEqual([onAgain.replayed, onAgain.body.recoveryCodes], [null, undefined], 'recovery codes are shown once');
  assert.deepEqual(platform.store.list('idempotency', { limit: 1000 }), [], 'none of it is kept for replay');
});

test('rate limits (03 §3.5): RateLimit-* on every answer, 429 with Retry-After past the limit; each principal its own', async (t) => {
  const { platform, api } = await start(t, { rateLimit: 5 });
  const answers = [];
  for (let i = 0; i < 6; i++) answers.push(await api('GET', '/shows'));
  assert.deepEqual(answers.map((a) => a.headers.get('ratelimit-remaining')), ['4', '3', '2', '1', '0', '0']);
  assert.equal(answers[0].headers.get('ratelimit-limit'), '5');
  assert.ok(Number(answers[0].headers.get('ratelimit-reset')) <= 60);
  assert.equal(answers[5].status, 429);
  assert.equal(answers[5].body.type, 'https://skp.dev/errors/rate-limited');
  assert.ok(Number(answers[5].headers.get('retry-after')) >= 1);
  // One busy client doesn't use up anyone else's.
  const anon = await fetch(`${platform.url}/api/v1/openapi.json`);
  await anon.arrayBuffer();
  assert.deepEqual([anon.status, anon.headers.get('ratelimit-remaining')], [200, '4'], 'an address has its own');
  const ui = await owner(platform);
  const theirs = await ui('GET', '/shows');
  assert.deepEqual([theirs.status, theirs.headers.get('ratelimit-remaining')], [200, '4'], 'a session has its own');
});

test('POST /events: 60 a second per principal, a budget of its own beside the 600 a minute (03 §3.5)', async (t) => {
  const clock = { t: Date.UTC(2026, 9, 17, 18), now: () => clock.t };
  const { api } = await start(t, { clock: { now: clock.now } });
  // 30 a second for 25 seconds: 750, more than 600 in a minute, all published.
  const statuses = new Set();
  for (let s = 0; s < 25; s++, clock.t += 1000) {
    for (let i = 0; i < 30; i++) statuses.add((await api('POST', '/events', { type: 'custom.tick', data: { s, i } })).status);
  }
  assert.deepEqual([...statuses], [202]);
  assert.equal((await api('GET', '/shows')).headers.get('ratelimit-remaining'), '599', 'publishing used none of it');
  const second = [];
  for (let i = 0; i < 61; i++) second.push(await api('POST', '/events', { type: 'custom.tick', data: { i } }));
  assert.deepEqual([second[0].headers.get('ratelimit-limit'), second[59].status, second[59].headers.get('ratelimit-remaining')], ['60', 202, '0']);
  assert.deepEqual([second[60].status, second[60].body.type, second[60].headers.get('retry-after')], [429, 'https://skp.dev/errors/rate-limited', '1']);
  clock.t += 1000;
  assert.equal((await api('POST', '/events', { type: 'custom.tick', data: {} })).status, 202, 'the next second');
});

test('open routes (setup, login, openapi.json) refuse another name and another origin too', async (t) => {
  const { platform } = await start(t);
  const port = new URL(platform.url).port;
  // fetch can't set Host: a DNS-rebinding page's request names the attacker's host.
  const send = (method, p, headers, body) => new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = request({ host: '127.0.0.1', port, method, path: p, headers: { host: `127.0.0.1:${port}`, ...headers, ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}) } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end(data);
  });
  const owner = { code: platform.auth.setupCode, username: 'juan', password: PASSWORD };
  for (const headers of [{ host: `rebind.example:${port}`, origin: `http://rebind.example:${port}` }, { origin: 'https://evil.example' }, { origin: 'null' }]) {
    const where = JSON.stringify(headers);
    assert.equal(await send('GET', '/api/v1/openapi.json', headers), 403, where);
    assert.equal(await send('GET', '/api/v1/setup', headers), 403, where);
    assert.equal(await send('POST', '/api/v1/setup', headers, owner), 403, where);
    assert.equal(await send('POST', '/api/v1/auth/login', headers, { username: 'juan', password: PASSWORD }), 403, where);
  }
  assert.equal(platform.auth.setupNeeded(), true, 'no owner was made');
  assert.equal(await send('GET', '/api/v1/openapi.json', {}), 200, 'from its own address');
});

test('a Host the platform lacks has the machine\'s addresses read again at once, not up to 5 s later', async (t) => {
  let ifaces = { lo: [{ address: '127.0.0.1', family: 'IPv4' }] };
  let now = Date.UTC(2026, 9, 17, 18);
  const root = tempDir(t);
  const config = loadConfig({ argv: ['--port', '0'], env: { SKP_DATA_DIR: path.join(root, 'data'), SKP_CONFIG_DIR: path.join(root, 'config'), SKP_EXPOSURE: 'lan', SKP_HOST: '127.0.0.1' } });
  const platform = await startPlatform(config, { log: memoryLogger().log, scrypt: { N: 1024 }, interfaces: () => ifaces, clock: { now: () => now } });
  defer(t, () => platform.stop());
  const as = (host) => new Promise((resolve, reject) => {
    request(`${platform.url}/api/v1/setup`, { headers: { host: `${host}:${platform.port}` } }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject).end();
  });
  assert.equal(await as('192.168.1.77'), 403);
  ifaces = { ...ifaces, wlan0: [{ address: '192.168.1.77', family: 'IPv4' }] };
  now += 1000; // a second since the last read (at most one a second), not the 5 s of a refresh
  assert.equal(await as('192.168.1.77'), 200, 'the Wi-Fi address that just arrived');
  now += 1000;
  assert.equal(await as('rebind.example'), 403, 'read again, and still not one of its names');
});

test('problems carry the base headers too: no-store, nosniff, Referrer-Policy (03 §3.4, 07 §7.10)', async (t) => {
  const { platform, api } = await start(t);
  await owner(platform);
  const login = await fetch(`${platform.url}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'juan', password: 'wrong horse battery staple' }) });
  const answers = { login: [login.status, login.headers], ...Object.fromEntries(await Promise.all([
    ['missing', api('GET', '/shows/nope')],
    ['unknown field', api('POST', '/shows', { ...SHOW, admin: true })],
  ].map(async ([what, p]) => { const a = await p; return [what, [a.status, a.headers]]; }))) };
  await login.arrayBuffer();
  for (const [what, [status, headers]] of Object.entries(answers)) {
    assert.ok(status >= 400, what);
    assert.deepEqual([headers.get('cache-control'), headers.get('x-content-type-options'), headers.get('referrer-policy')], ['no-store', 'nosniff', 'same-origin'], `${what} (${status})`);
  }
});

test('pagination: { items, next } up to 200 at a time; a cursor goes on where the page ended, whatever was deleted', async (t) => {
  const { api } = await start(t);
  for (const name of ['A', 'B', 'C', 'D', 'E']) await api('POST', '/shows', { ...SHOW, name });
  const p1 = await api('GET', '/shows?limit=2');
  assert.deepEqual(p1.body.items.map((s) => s.name), ['A', 'B']);
  await api('DELETE', '/shows/C');
  const p2 = await api('GET', `/shows?limit=2&cursor=${p1.body.next}`);
  assert.deepEqual(p2.body.items.map((s) => s.name), ['D', 'E']);
  assert.equal(p2.body.next, undefined);
  for (const bad of ['limit=0', 'limit=201', 'limit=x', 'cursor=%20']) assert.equal((await api('GET', `/shows?${bad}`)).status, 422, bad);
});

test('writes take known fields only (07 §7.11); problems say what to do, with the path but never its query', async (t) => {
  const { platform, api } = await start(t);
  const bad = await api('POST', '/shows', { ...SHOW, admin: true });
  assert.deepEqual([bad.status, bad.body.type], [422, 'https://skp.dev/errors/unknown-field']);
  assert.match(bad.body.detail, /Unknown field: admin\. This takes name, overlays/);
  assert.equal(bad.body.instance, '/api/v1/shows');
  const res = await fetch(`${platform.url}/o/nope/snapshot?key=skp_ovl_secret`);
  const p = await res.json();
  assert.equal(p.instance, '/o/nope/snapshot', 'the key in the query never comes back');
  const slot = await api('POST', '/shows', { ...SHOW, lineup: [{ time: '22:00', name: 'X', vip: true }] });
  assert.match(slot.body.detail, /unknown field vip/);
});

test('shows as resources: instants are ISO 8601 (03 §3.1)', async (t) => {
  const { api } = await start(t);
  const s = (await api('POST', '/shows', { ...SHOW, goLive: '22:30', lineup: [{ time: '01:00', name: 'VIK' }] })).body;
  assert.equal(s.goLiveAt, '2026-10-18T02:30:00.000Z');
  assert.equal(s.lineup[0].startAt, '2026-10-18T05:00:00.000Z');
  assert.equal((await api('POST', `/shows/${s.id}/rec`, { action: 'start' })).body.recStartedAt.endsWith('Z'), true);
});

test('overlays: create, read, change settings and slug, upgrade (dry run), revert, delete; never their key', async (t) => {
  const { platform, api } = await start(t);
  const ui = await owner(platform);
  const made = await api('POST', '/overlays', { slug: 'main', template: TESTBED, settings: { size: 3 } });
  assert.equal(made.status, 201);
  assert.deepEqual([made.body.slug, made.body.status, made.body.keyRequired, made.body.settings], ['main', 'ok', true, { size: 3 }]);
  assert.equal(JSON.stringify(made.body).includes('skp_ovl_'), false);
  assert.equal(JSON.stringify(made.body).includes('enc:v1'), false);
  assert.equal((await api('POST', '/overlays', { slug: 'main', template: TESTBED })).status, 409);
  assert.equal((await api('POST', '/overlays', { slug: 'x', template: { id: 'nope', version: '1' } })).status, 422);
  assert.deepEqual((await api('GET', '/overlays')).body.items.map((o) => o.slug), ['main']);
  const changed = await ui('PATCH', '/overlays/main', { settings: { size: 5 }, slug: 'main-h' }, { 'if-match': made.headers.get('etag') });
  assert.equal(changed.status, 200);
  assert.deepEqual([changed.body.slug, changed.body.settings], ['main-h', { size: 5 }]);
  const misfit = await api('PATCH', '/overlays/main-h', { settings: { size: 99 } });
  assert.deepEqual([misfit.status, misfit.body.problems?.[0]?.path, misfit.body.plan], [422, '/size', undefined], 'settings that don\'t fit: what, where');
  const pkg = packTemplate(DIAG_DIR, { manifest: { id: 'dev.skp.sample', version: '1.0.0' } });
  await api('POST', '/templates', pkg);
  await api('POST', '/templates', packTemplate(DIAG_DIR, { manifest: { id: 'dev.skp.sample', version: '1.1.0' } }));
  await api('POST', '/overlays', { slug: 'up', template: { id: 'dev.skp.sample', version: '1.0.0' } });
  const plan = await api('POST', '/overlays/up/upgrade', { version: '1.1.0', dryRun: true });
  assert.deepEqual([plan.status, plan.body.from, plan.body.to, plan.body.confirm], [200, '1.0.0', '1.1.0', false]);
  const done = await api('POST', '/overlays/up/upgrade', { version: '1.1.0' });
  assert.equal(done.body.overlay.template.version, '1.1.0');
  assert.equal((await api('POST', '/overlays/up/revert', {})).body.overlay.template.version, '1.0.0');
  assert.equal((await api('DELETE', '/overlays/up')).status, 200);
  assert.equal((await api('GET', '/overlays/up')).status, 404);
  assert.deepEqual(platform.audit.list({ action: 'overlay' }).items.map((e) => e.action).reverse(), ['overlay.create', 'overlay.rename', 'overlay.create', 'overlay.upgrade', 'overlay.revert', 'overlay.delete']);
});

test('templates: list, read with previews, install a package or a URL, validate, uninstall (not while used); sources', async (t) => {
  const lookup = async () => [{ address: '140.82.112.6', family: 4 }];
  const fake = async (url) => new Response(JSON.stringify({ message: 'Not Found' }), { status: 404, headers: { 'content-type': 'application/json' } });
  const { platform, api } = await start(t, { fetch: fake, lookup });
  const list = (await api('GET', '/templates')).body.items;
  assert.ok(list.some((x) => x.id === 'com.dprtmnt.takeover' && x.versions[0].source === 'bundled'));
  const diag = (await api('GET', `/templates/${DIAG.id}`)).body;
  assert.equal(diag.manifest.id, DIAG.id);
  assert.ok(diag.previews.length);
  const img = await fetch(`${platform.url}${diag.previews[0]}`, { headers: signedIn(platform) });
  assert.equal(img.status, 200);
  assert.match(img.headers.get('content-type'), /^image\//);
  assert.deepEqual([img.headers.get('x-content-type-options'), img.headers.get('referrer-policy')], ['nosniff', 'same-origin'], 'an answer a route writes itself has them too (07 §7.10)');
  await img.arrayBuffer();
  const pkg = packTemplate(DIAG_DIR, { manifest: { id: 'dev.skp.sample', version: '1.0.0' } });
  const lint = await api('POST', '/templates/validate', pkg);
  assert.deepEqual([lint.body.valid, lint.body.id], [true, 'dev.skp.sample']);
  assert.equal((await api('POST', '/templates/validate', Buffer.from('not a zip'))).status, 422);
  const installed = await api('POST', '/templates', pkg);
  assert.deepEqual([installed.status, installed.body.installed], [201, true]);
  assert.deepEqual([(await api('POST', '/templates', pkg)).status], [200], 'the same package again: nothing to do');
  // With an Idempotency-Key: the same bytes again are the first answer; other bytes are refused.
  const keyed = packTemplate(DIAG_DIR, { manifest: { id: 'dev.skp.keyed', version: '1.0.0' } });
  const press = { 'idempotency-key': 'install-1' };
  const once = await api('POST', '/templates', keyed, press);
  const twice = await api('POST', '/templates', keyed, press);
  assert.deepEqual([once.status, twice.status, twice.headers.get('idempotent-replayed'), twice.body.installed], [201, 201, 'true', true]);
  const another = await api('POST', '/templates', packTemplate(DIAG_DIR, { manifest: { id: 'dev.skp.keyed', version: '1.1.0' } }), press);
  assert.deepEqual([another.status, another.body.type], [422, 'https://skp.dev/errors/idempotency-mismatch']);
  await api('POST', '/overlays', { slug: 'uses', template: { id: 'dev.skp.sample', version: '1.0.0' } });
  assert.equal((await api('DELETE', '/templates/dev.skp.sample')).status, 409, 'in use');
  await api('DELETE', '/overlays/uses');
  assert.deepEqual((await api('DELETE', '/templates/dev.skp.sample')).body.removed.map((x) => x.version), ['1.0.0']);
  assert.equal((await api('DELETE', `/templates/${DIAG.id}`)).status, 422, 'it ships with the platform');
  // A URL to install from, and a source to follow: here GitHub answers 404.
  const fromUrl = await api('POST', '/templates', Buffer.from(JSON.stringify({ url: 'a/missing' })), { 'content-type': 'application/json' });
  assert.deepEqual([fromUrl.status, fromUrl.body.type, fromUrl.body.fix], [422, 'https://skp.dev/errors/no-access', 'connect-github']);
  assert.match(fromUrl.body.detail, /^This repository is private or the GitHub token can't read it\./);
  const followed = await api('POST', '/templates/sources', { source: 'a/missing' });
  assert.equal(followed.status, 201);
  assert.deepEqual([followed.body.check.error.code, followed.body.check.error.fix], ['no-access', 'connect-github']);
  assert.equal((await api('GET', '/templates/sources')).body.items.length, 1);
  assert.equal((await api('DELETE', '/templates/sources/a%2Fmissing')).status, 200);
});

test('a package too large inside (a zip bomb), sent or downloaded, is a 422: the request itself was within its limit', async (t) => {
  // 4 MiB of zeros deflate to a few KiB: over the zip limits' ratio (templates/zip.js).
  const bomb = writeZip([{ name: 'template.json', data: JSON.stringify({ id: 'dev.skp.bomb', version: '1.0.0' }) }, { name: 'zeros.bin', data: Buffer.alloc(4 * 1024 * 1024) }]);
  assert.ok(bomb.length < 64 * 1024);
  const lookup = async () => [{ address: '140.82.112.6', family: 4 }];
  const fake = async () => new Response(bomb, { status: 200, headers: { 'content-type': 'application/octet-stream', 'content-length': String(bomb.length) } });
  const { api } = await start(t, { fetch: fake, lookup });
  const sent = await api('POST', '/templates', bomb);
  const downloaded = await api('POST', '/templates', Buffer.from(JSON.stringify({ url: 'https://packages.example/bomb.skp' })), { 'content-type': 'application/json' });
  for (const [how, answer] of [['sent', sent], ['downloaded', downloaded]]) {
    assert.deepEqual([answer.status, answer.body.type], [422, 'https://skp.dev/errors/too-large'], how);
    assert.match(answer.body.detail, /expands more than/, how);
  }
});

test('media: upload (streamed), list, delete (not while used)', async (t) => {
  const { platform, api } = await start(t);
  const up = await api('POST', '/media?name=Logo.png', PNG);
  assert.equal(up.status, 201);
  assert.match(up.body.url, /^\/media\/[0-9a-f]{32}\/Logo\.png$/);
  assert.equal((await fetch(`${platform.url}${up.body.url}`)).status, 200);
  assert.equal((await api('GET', '/media')).body.items[0].id, up.body.id);
  const tk = await api('POST', '/overlays', { slug: 'x', template: { id: 'com.dprtmnt.takeover', version: '1.1.0' }, settings: { look: 'event', eventMark: up.body.url } });
  assert.equal(tk.status, 201);
  assert.deepEqual((await api('GET', `/media/${up.body.id}`)).body.usedBy, ['x']);
  const inUse = await api('DELETE', `/media/${up.body.id}`);
  assert.deepEqual([inUse.status, inUse.body.type], [409, 'https://skp.dev/errors/in-use']);
  await api('DELETE', '/overlays/x');
  assert.equal((await api('DELETE', `/media/${up.body.id}`)).status, 200);
  assert.equal((await api('DELETE', `/media/${up.body.id}`)).status, 404);
  assert.equal((await api('POST', '/media?name=x.txt', Buffer.from('just text'))).status, 415);
  // A client that sends Idempotency-Key with every POST can upload too; an upload is never
  // answered for another (its body can't be fingerprinted before it is read).
  const keyed = [await api('POST', '/media?name=Logo.png', PNG, { 'idempotency-key': 'up-1' }), await api('POST', '/media?name=Logo.png', PNG, { 'idempotency-key': 'up-1' })];
  assert.deepEqual(keyed.map((a) => [a.status, a.headers.get('idempotent-replayed')]), [[201, null], [201, null]]);
  assert.equal(platform.media.list().length, 2);
});

test('system: info and health; live events over SSE; custom events and state, and nothing else', async (t) => {
  const { platform, api } = await start(t);
  const info = (await api('GET', '/system/info')).body;
  assert.deepEqual([info.standard, info.exposure, typeof info.capabilities.ffmpeg], ['skp/1', 'local', 'boolean']);
  assert.equal((await api('GET', '/system/health')).body.status, 'ok');
  const ctrl = new AbortController();
  defer(t, () => ctrl.abort());
  const res = await fetch(`${platform.url}/api/v1/events?types=custom.*`, { headers: signedIn(platform), signal: ctrl.signal });
  assert.match(res.headers.get('content-type'), /^text\/event-stream/);
  const reader = res.body.getReader();
  assert.deepEqual((await api('POST', '/events', { type: 'custom.goal', data: { team: 'A' } })).status, 202);
  let text = '';
  while (!text.includes('custom.goal')) text += new TextDecoder().decode((await reader.read()).value);
  assert.match(text, /event: custom\.goal\ndata: .*"team":"A"/);
  assert.equal((await api('POST', '/events', { type: 'alert.follow', data: {} })).status, 422, 'the standard\'s own types are the platform\'s');
  assert.equal((await api('PUT', '/state/custom.score', { value: 3 })).body.value, 3);
  assert.equal((await api('GET', '/state/custom.score')).body.value, 3);
  assert.equal((await api('GET', '/state')).body['custom.score'], 3);
  assert.equal((await api('PUT', '/state/viewers.total', { value: 1 })).status, 422);
  assert.equal((await api('PUT', '/state/custom.score', { value: null })).body.value, null);
  assert.equal((await api('GET', '/state/custom.score')).status, 404);
});

test('a download connects only to the address it checked: private ones refused unless allowed', async (t) => {
  const { cert, key } = selfSigned();
  const server = createServer({ cert, key }, (req, res) => res.end('ok'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  defer(t, () => new Promise((r) => server.close(r)));
  const url = `https://pkg.example:${server.address().port}/x.skp`;
  const lookup = async () => [{ address: '127.0.0.1', family: 4 }];
  await assert.rejects(pinnedFetch({ lookup })(url), (err) => err.code === 'EPRIVATE' && /private or local address \(127\.0\.0\.1\)/.test(err.message));
  const res = await pinnedFetch({ lookup, allowPrivate: true, tls: { rejectUnauthorized: false } })(url);
  assert.deepEqual([res.status, await res.text()], [200, 'ok']);
  await assert.rejects(pinnedFetch({ lookup })('http://pkg.example/x'), /only https/);
});
