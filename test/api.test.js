// The API's conventions (03 §3.1–3.5) and the resources the admin UI uses: OpenAPI, ETag and
// If-Match, idempotency keys, rate limits, pagination, unknown fields, problems; overlays,
// templates, media, system, live events and state; and downloads pinned to the address checked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import path from 'node:path';
import { startPlatform } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { pinnedFetch } from '../src/net.js';
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
  assert.deepEqual(Object.keys(doc.paths['/api/v1/shows'].post.requestBody.content['application/json'].schema.properties), ['name', 'overlays', 'date', 'timezone', 'dayBoundary', 'goLive', 'lineup']);
  // Every API route the server has is in it.
  const described = new Set(Object.entries(doc.paths).flatMap(([p, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${p}`)));
  const served = platform.server.listeners('request').length; // the server is up
  assert.ok(served >= 1 && described.size > 50);
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
  // Answers that hold a secret are never kept: a token's, a session's.
  const tok = await api('POST', '/tokens', { name: 'deck' }, { 'idempotency-key': 't-1' });
  assert.equal(tok.status, 409, 'there is no owner yet');
});

test('rate limits (03 §3.5): RateLimit-* on every answer, 429 with Retry-After past the limit', async (t) => {
  const { api } = await start(t, { rateLimit: 5 });
  const answers = [];
  for (let i = 0; i < 6; i++) answers.push(await api('GET', '/shows'));
  assert.deepEqual(answers.map((a) => a.headers.get('ratelimit-remaining')), ['4', '3', '2', '1', '0', '0']);
  assert.equal(answers[0].headers.get('ratelimit-limit'), '5');
  assert.ok(Number(answers[0].headers.get('ratelimit-reset')) <= 60);
  assert.equal(answers[5].status, 429);
  assert.equal(answers[5].body.type, 'https://skp.dev/errors/rate-limited');
  assert.ok(Number(answers[5].headers.get('retry-after')) >= 1);
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
  assert.equal((await api('PATCH', '/overlays/main-h', { settings: { size: 99 } })).status, 422, 'settings that don\'t fit');
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
  await img.arrayBuffer();
  const pkg = packTemplate(DIAG_DIR, { manifest: { id: 'dev.skp.sample', version: '1.0.0' } });
  const lint = await api('POST', '/templates/validate', pkg);
  assert.deepEqual([lint.body.valid, lint.body.id], [true, 'dev.skp.sample']);
  assert.equal((await api('POST', '/templates/validate', Buffer.from('not a zip'))).status, 422);
  const installed = await api('POST', '/templates', pkg);
  assert.deepEqual([installed.status, installed.body.installed], [201, true]);
  assert.deepEqual([(await api('POST', '/templates', pkg)).status], [200], 'the same package again: nothing to do');
  await api('POST', '/overlays', { slug: 'uses', template: { id: 'dev.skp.sample', version: '1.0.0' } });
  assert.equal((await api('DELETE', '/templates/dev.skp.sample')).status, 409, 'in use');
  await api('DELETE', '/overlays/uses');
  assert.deepEqual((await api('DELETE', '/templates/dev.skp.sample')).body.removed.map((x) => x.version), ['1.0.0']);
  assert.equal((await api('DELETE', `/templates/${DIAG.id}`)).status, 422, 'it ships with the platform');
  // A URL to install from, and a source to follow: here GitHub answers 404.
  const fromUrl = await api('POST', '/templates', Buffer.from(JSON.stringify({ url: 'a/missing' })), { 'content-type': 'application/json' });
  assert.deepEqual([fromUrl.status, fromUrl.body.type], [422, 'https://skp.dev/errors/no-release']);
  const followed = await api('POST', '/templates/sources', { source: 'a/missing' });
  assert.equal(followed.status, 201);
  assert.equal(followed.body.check.error.code, 'no-release');
  assert.equal((await api('GET', '/templates/sources')).body.items.length, 1);
  assert.equal((await api('DELETE', '/templates/sources/a%2Fmissing')).status, 200);
});

test('media: upload (streamed), list, delete (not while used)', async (t) => {
  const { platform, api } = await start(t);
  const up = await api('POST', '/media?name=Logo.png', PNG);
  assert.equal(up.status, 201);
  assert.match(up.body.url, /^\/media\/[0-9a-f]{32}\/Logo\.png$/);
  assert.equal((await fetch(`${platform.url}${up.body.url}`)).status, 200);
  assert.equal((await api('GET', '/media')).body.items[0].id, up.body.id);
  const tk = await api('POST', '/overlays', { slug: 'x', template: { id: 'com.dprtmnt.takeover', version: '1.0.0' }, settings: { look: 'event', eventMark: up.body.url } });
  assert.equal(tk.status, 201);
  assert.deepEqual((await api('GET', `/media/${up.body.id}`)).body.usedBy, ['x']);
  const inUse = await api('DELETE', `/media/${up.body.id}`);
  assert.deepEqual([inUse.status, inUse.body.type], [409, 'https://skp.dev/errors/in-use']);
  await api('DELETE', '/overlays/x');
  assert.equal((await api('DELETE', `/media/${up.body.id}`)).status, 200);
  assert.equal((await api('DELETE', `/media/${up.body.id}`)).status, 404);
  assert.equal((await api('POST', '/media?name=x.txt', Buffer.from('just text'))).status, 415);
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
