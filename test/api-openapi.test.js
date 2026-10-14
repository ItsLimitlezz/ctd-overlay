// The OpenAPI document (GET /api/v1/openapi.json, 03 §3.1) describes every operation as it is:
// what a success answers (201 for a create, 202, both of an install's), its query parameters
// (limit and cursor on every paged list, and each route's own), the bodies of uploads (a package or
// JSON { url }, a media file in its own type) and answers that aren't JSON (a preview image, an
// event stream). Held to the routes' declarations, and to what a tour of every route answers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { startPlatform } from '../src/app.js';
import { authRoutes } from '../src/auth/routes.js';
import { hotp, stepAt } from '../src/auth/totp.js';
import { loadConfig } from '../src/config.js';
import { createApi } from '../src/http/api.js';
import { createRouter } from '../src/http/server.js';
import { systemRoutes } from '../src/http/system.js';
import { mediaApiRoutes } from '../src/media/api.js';
import { overlayApiRoutes } from '../src/overlays/api.js';
import { simulateRoutes } from '../src/overlays/simulate.js';
import { showRoutes } from '../src/shows/routes.js';
import { templateRoutes } from '../src/templates/api.js';
import { defer, DIAG_DIR, FIXTURE_TEMPLATES, memoryLogger, packTemplate, signedIn, tempDir, TESTBED } from './helpers.js';

const PASSWORD = 'correct horse battery staple';
const NEW_PASSWORD = 'staple battery horse correct';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
const sample = (version, id = 'dev.skp.sample') => packTemplate(DIAG_DIR, { manifest: { id, version } });
const FETCHED = sample('1.0.0', 'dev.skp.fetched');

async function start(t) {
  const clock = { t: Date.UTC(2026, 9, 17, 18), now: () => clock.t };
  // A package to install from a URL; GitHub (a followed source) has no release.
  const download = async (url) => (String(url).startsWith('https://packages.example/')
    ? new Response(FETCHED, { status: 200, headers: { 'content-type': 'application/octet-stream', 'content-length': String(FETCHED.length) } })
    : new Response(JSON.stringify({ message: 'Not Found' }), { status: 404, headers: { 'content-type': 'application/json' } }));
  const lookup = async () => [{ address: '140.82.112.6', family: 4 }];
  const root = tempDir(t);
  const config = loadConfig({ argv: ['--port', '0'], env: { SKP_DATA_DIR: path.join(root, 'data'), SKP_CONFIG_DIR: path.join(root, 'config') } });
  const platform = await startPlatform(config, { log: memoryLogger().log, templateDirs: [FIXTURE_TEMPLATES], scrypt: { N: 1024 }, clock: { now: clock.now }, fetch: download, lookup });
  defer(t, () => platform.stop());
  const doc = await (await fetch(`${platform.url}/api/v1/openapi.json`)).json();
  return { platform, clock, doc };
}

// A route's path as the document writes it.
const docPath = (p) => p.replace(/:([A-Za-z]+)/g, '{$1}').replace(/\/\*$/, '/{path}');
const queryOf = (op) => (op.parameters || []).filter((x) => x.in === 'query').map((x) => x.name);
// A media range ("image/*") and a content type ("image/svg+xml; charset=…") agree.
const fits = (range, type) => {
  const [a, b] = range.split('/');
  const [x, y] = String(type).split(';')[0].trim().toLowerCase().split('/');
  return (a === '*' || a === x) && (b === '*' || b === y);
};

// Every API route's declaration, as the platform's route files make them.
function declarations() {
  const api = createApi({ guard: () => undefined, hosts: () => [], store: {}, log: {} });
  authRoutes({ api, auth: {}, audit: {} });
  showRoutes({ api, shows: {}, timeline: {} });
  simulateRoutes({ api, overlays: {}, bus: {}, log: {} });
  overlayApiRoutes({ api, overlays: {}, templates: {}, shows: {}, audit: {}, base: () => '' });
  templateRoutes({ api, templates: {}, overlays: {}, sources: {}, audit: {}, config: {} });
  mediaApiRoutes({ api, media: {}, overlays: {}, audit: {} });
  systemRoutes({ api, bus: {}, store: {}, media: {}, templates: {}, overlays: {}, shows: {}, config: {}, version: '0' });
  return api.routes;
}

test('for every route, the document says what its declaration does: what a success answers, its query parameters, its body', async (t) => {
  const { doc } = await start(t);
  const defs = declarations();
  const described = Object.entries(doc.paths).flatMap(([p, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${p}`));
  assert.deepEqual(new Set(defs.map((d) => `${d.method} ${docPath(d.path)}`)), new Set(described), 'every route the document has is declared here');
  for (const d of defs) {
    const where = `${d.method} ${d.path}`;
    const op = doc.paths[docPath(d.path)][d.method.toLowerCase()];
    const statuses = [].concat(d.status || 200).map(String);
    assert.deepEqual(Object.keys(op.responses).sort(), ['default', ...statuses].sort(), where);
    for (const s of statuses) assert.deepEqual(Object.keys(op.responses[s].content || {}), s === '204' ? [] : [d.produces || 'application/json'], `${where} ${s}`);
    assert.deepEqual(queryOf(op), [...(d.paged ? ['limit', 'cursor'] : []), ...(d.query || [])], where);
    if (d.paged) assert.deepEqual(Object.keys(op.responses['200'].content['application/json'].schema.properties), ['items', 'next'], where);
    const bodies = d.body?.raw || d.body?.stream ? [...(d.body.types || ['application/octet-stream']), ...(d.body.json ? ['application/json'] : [])]
      : d.body && d.method !== 'GET' ? ['application/json'] : [];
    assert.deepEqual(Object.keys(op.requestBody?.content || {}), bodies, where);
  }
});

test('what 03 names: creates answer 201 (an install 201 or 200), every paged list takes limit and cursor, each route its own query, uploads their bytes', async (t) => {
  const { doc } = await start(t);
  const op = (m, p) => doc.paths[`/api/v1${p}`][m];
  const success = (o) => Object.keys(o.responses).filter((s) => s !== 'default').sort();
  for (const p of ['/setup', '/users', '/tokens', '/overlays', '/shows', '/shows/{ref}/cues', '/shows/{ref}/plans', '/templates/sources', '/media']) {
    assert.deepEqual(success(op('post', p)), ['201'], `POST ${p}`);
    assert.equal(op('post', p).responses['201'].description, 'Created');
  }
  assert.deepEqual(success(op('post', '/templates')), ['200', '201'], 'installed, or there already');
  assert.deepEqual(success(op('post', '/events')), ['202']);
  for (const p of ['/auth/sessions', '/users', '/tokens', '/system/audit', '/overlays', '/shows', '/shows/{ref}/cues', '/shows/{ref}/plans', '/templates', '/templates/sources', '/templates/{id}/versions', '/media']) {
    assert.deepEqual(queryOf(op('get', p)).slice(0, 2), ['limit', 'cursor'], `GET ${p}`);
    assert.deepEqual(op('get', p).responses['200'].content['application/json'].schema.required, ['items'], `GET ${p}`);
  }
  assert.deepEqual(queryOf(op('post', '/media')), ['name']);
  assert.deepEqual(queryOf(op('delete', '/templates/{id}')), ['version']);
  assert.deepEqual(queryOf(op('get', '/tokens')), ['limit', 'cursor', 'all']);
  assert.deepEqual(queryOf(op('get', '/system/audit')), ['limit', 'cursor', 'action']);
  assert.deepEqual(queryOf(op('get', '/templates')), ['limit', 'cursor', 'category']);
  assert.deepEqual(queryOf(op('post', '/templates/sources/check')), ['source']);
  assert.deepEqual(queryOf(op('get', '/events')), ['types']);
  // A media file as anything (what it is is read from its bytes, which the summary says); a package, or { url }.
  assert.deepEqual(Object.keys(op('post', '/media').requestBody.content), ['*/*']);
  assert.match(op('post', '/media').summary, /read from the file itself/);
  const install = op('post', '/templates').requestBody;
  assert.deepEqual([install.required, Object.keys(install.content)], [true, ['application/octet-stream', 'application/json']]);
  assert.deepEqual(install.content['application/json'].schema, { type: 'object', additionalProperties: false, properties: { url: {} }, required: ['url'] });
  assert.deepEqual(Object.keys(op('post', '/templates/validate').requestBody.content), ['application/octet-stream']);
  // Answers that aren't JSON.
  assert.deepEqual(Object.keys(op('get', '/templates/{id}/versions/{version}/previews/{path}').responses['200'].content), ['image/*']);
  assert.deepEqual(Object.keys(op('get', '/events').responses['200'].content), ['text/event-stream']);
});

// The query parameters a route reads: every name asked of a URLSearchParams while it answers.
function recordReads(t) {
  const reads = [];
  for (const name of ['get', 'getAll', 'has']) {
    const original = URLSearchParams.prototype[name];
    URLSearchParams.prototype[name] = function (key, ...rest) {
      reads.push(key);
      return original.call(this, key, ...rest);
    };
    defer(t, () => { URLSearchParams.prototype[name] = original; });
  }
  return reads;
}

test('a tour of every route: each success it answers, the type it answers in, the query it reads and the body it takes are what the document says', async (t) => {
  const { platform, clock, doc } = await start(t);
  const reads = recordReads(t);
  const router = createRouter(platform.server.routes.filter((r) => r.path.startsWith('/api/v1/')));
  const calls = [];
  const ui = {};
  // as: 'cli' (the command line's token), 'ui' (the owner's session) or null (nobody). stream:
  // read the answer's head only (an event stream never ends).
  async function call(method, p, { as = 'cli', body, type, headers = {}, stream = false } = {}) {
    const url = new URL(`${platform.url}/api/v1${p}`);
    const { route } = router.match(method, url.pathname.split('/').slice(1).map(decodeURIComponent));
    assert.ok(route, `${method} ${p} is an API route`);
    const sent = body === undefined ? undefined : type || (Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json');
    const who = as === 'cli' ? signedIn(platform) : as === 'ui' ? { cookie: ui.cookie, 'x-skp-csrf': ui.csrf } : {};
    const ctrl = new AbortController();
    reads.length = 0;
    const res = await fetch(url, { method, headers: { ...who, ...(sent ? { 'content-type': sent } : {}), ...headers }, body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body), signal: ctrl.signal });
    let json;
    if (stream) ctrl.abort();
    else {
      const text = await res.text();
      try { json = JSON.parse(text); } catch { json = text; }
    }
    assert.ok(res.status < 300, `${method} ${p}: ${res.status} ${JSON.stringify(json)}`);
    calls.push({ op: `${method} ${docPath(route.path)}`, status: res.status, type: res.headers.get('content-type'), sent, reads: [...reads] });
    return { status: res.status, body: json, headers: res.headers };
  }
  const signIn = (answer) => {
    ui.cookie = answer.headers.get('set-cookie').split(';')[0];
    ui.csrf = answer.body.csrf;
  };

  // The platform, and live data.
  await call('GET', '/openapi.json', { as: null });
  await call('GET', '/system/health');
  await call('GET', '/system/info');
  await call('GET', '/events?types=custom.*', { stream: true });
  await call('POST', '/events', { body: { type: 'custom.goal', data: { team: 'A' } } });
  await call('PUT', '/state/custom.score', { body: { value: 3 } });
  await call('GET', '/state/custom.score');
  await call('GET', '/state');

  // Accounts: the owner, signed in twice; a session ended, the password changed, two-factor on and
  // off; another account; a token.
  await call('GET', '/setup', { as: null });
  await call('POST', '/setup', { as: null, body: { code: platform.auth.setupCode, username: 'juan', password: PASSWORD } });
  signIn(await call('POST', '/auth/login', { as: null, body: { username: 'juan', password: PASSWORD } }));
  await call('GET', '/auth/session', { as: 'ui' });
  const other = (await call('GET', '/auth/sessions', { as: 'ui' })).body.items.find((s) => !s.current);
  await call('DELETE', `/auth/sessions/${other.id}`, { as: 'ui' });
  signIn(await call('POST', '/auth/password', { as: 'ui', body: { current: PASSWORD, password: NEW_PASSWORD } }));
  const { secret } = (await call('POST', '/auth/totp/enroll', { as: 'ui', body: { password: NEW_PASSWORD } })).body;
  signIn(await call('POST', '/auth/totp/verify', { as: 'ui', body: { code: hotp(secret, stepAt(clock.t)) } }));
  signIn(await call('DELETE', '/auth/totp', { as: 'ui', body: { password: NEW_PASSWORD } }));
  // The admin UI's look (a person's), and the installation's name.
  await call('PUT', '/auth/preferences', { as: 'ui', body: { theme: 'dark', density: 'compact' } });
  await call('PUT', '/system/settings', { as: 'ui', body: { name: 'D/PRTMNT' } });
  await call('GET', '/system/settings', { as: 'ui' });
  const bo =(await call('POST', '/users', { body: { username: 'bo', password: PASSWORD, role: 'operator' } })).body;
  await call('GET', '/users');
  await call('GET', `/users/${bo.id}`);
  await call('PATCH', `/users/${bo.id}`, { body: { role: 'viewer' } });
  await call('DELETE', `/users/${bo.id}`);
  const token = (await call('POST', '/tokens', { as: 'ui', body: { name: 'deck' } })).body;
  await call('GET', '/tokens?all=true', { as: 'ui' });
  await call('DELETE', `/tokens/${token.id}`, { as: 'ui' });

  // Templates: linted, installed (again: there already), from a URL; read, with a preview; sources.
  await call('POST', '/templates/validate', { body: sample('1.0.0') });
  await call('POST', '/templates', { body: sample('1.0.0'), headers: { 'x-skp-filename': 'sample.skp' } });
  await call('POST', '/templates', { body: sample('1.0.0') });
  await call('POST', '/templates', { body: sample('1.1.0') });
  await call('POST', '/templates', { body: Buffer.from(JSON.stringify({ url: 'https://packages.example/fetched.skp' })), type: 'application/json' });
  await call('GET', '/templates?category=show');
  const testbed = (await call('GET', `/templates/${TESTBED.id}`)).body;
  await call('GET', testbed.previews[0].slice('/api/v1'.length));
  await call('GET', '/templates/dev.skp.sample/versions?limit=1');
  await call('POST', '/templates/sources', { body: { source: 'a/missing' } });
  await call('GET', '/templates/sources');
  await call('POST', '/templates/sources/check?source=a/missing', { body: {} });
  await call('DELETE', '/templates/sources/a%2Fmissing');

  // Overlays: one for a show, one on its own, one to upgrade and revert.
  await call('POST', '/overlays', { body: { slug: 'main', template: TESTBED } });
  await call('POST', '/overlays', { body: { slug: 'solo', template: TESTBED } });
  await call('GET', '/overlays');
  await call('GET', '/overlays/main');
  await call('PATCH', '/overlays/main', { body: { settings: { size: 3 } } });
  await call('GET', '/overlays/main/url');
  await call('POST', '/overlays/solo/key/rotate', { body: {} });
  await call('POST', '/overlays/solo/simulate', { body: { kind: 'follow' } });
  await call('PUT', '/overlays/solo/scene', { body: { scene: 'brb' } });
  await call('POST', '/overlays/solo/actions/titleCard', { body: {} });
  await call('POST', '/overlays', { body: { slug: 'up', template: { id: 'dev.skp.sample', version: '1.0.0' } } });
  await call('POST', '/overlays/up/upgrade', { body: { version: '1.1.0', dryRun: true } });
  await call('POST', '/overlays/up/upgrade', { body: { version: '1.1.0' } });
  await call('POST', '/overlays/up/revert', { body: {} });
  await call('DELETE', '/templates/dev.skp.sample?version=1.1.0');
  await call('DELETE', '/overlays/up');

  // A show: commands, its cues (with the operator's overrides) and a plan.
  await call('POST', '/shows', { body: { name: 'Night', overlays: ['main'], date: '2026-10-17', timezone: 'America/Toronto', lineup: [{ time: '22:00', name: 'VIK' }] } });
  await call('GET', '/shows');
  await call('GET', '/shows/Night');
  await call('PATCH', '/shows/Night', { body: { goLive: '21:30' } });
  await call('PUT', '/shows/Night/scene', { body: { scene: 'brb' } });
  await call('POST', '/shows/Night/triggers/titleCard', { body: {} });
  await call('PUT', '/shows/Night/slot', { body: { slot: 0 } });
  await call('POST', '/shows/Night/rec', { body: { action: 'start' } });
  const cue = (await call('POST', '/shows/Night/cues', { body: { at: '23:00', action: { type: 'show.scene', scene: 'brb' }, label: 'Break' } })).body;
  await call('GET', '/shows/Night/cues');
  await call('GET', `/shows/Night/cues/${cue.id}`);
  await call('PATCH', `/shows/Night/cues/${cue.id}`, { body: { label: 'BRB' } });
  for (const op of ['skip', 'rearm', 'fire']) await call('POST', `/shows/Night/cues/${cue.id}/${op}`, { body: {} });
  await call('POST', '/shows/Night/cues/build', { body: {} });
  await call('DELETE', `/shows/Night/cues/${cue.id}`);
  const plan = (await call('POST', '/shows/Night/plans', { body: { date: '2026-10-24', goLive: '21:00' } })).body;
  await call('GET', '/shows/Night/plans');
  await call('DELETE', `/shows/Night/plans/${plan.id}`);
  await call('DELETE', '/shows/Night');

  // Media: a file in its own type.
  const file = (await call('POST', '/media?name=Logo.png', { body: PNG, type: 'image/png' })).body;
  await call('GET', '/media');
  await call('GET', `/media/${file.id}`);
  await call('DELETE', `/media/${file.id}`);

  await call('GET', '/system/audit?action=overlay');
  await call('POST', '/auth/logout', { as: 'ui', body: {} });

  const byOp = Map.groupBy(calls, (c) => c.op);
  const served = platform.server.routes.filter((r) => r.path.startsWith('/api/v1/')).map((r) => `${r.method} ${docPath(r.path)}`);
  assert.deepEqual(served.filter((op) => !byOp.has(op)), [], 'every route is on the tour');
  for (const [key, list] of byOp) {
    const [method, p] = key.split(' ');
    const op = doc.paths[p][method.toLowerCase()];
    const described = Object.keys(op.responses).filter((s) => s !== 'default').sort();
    assert.deepEqual([...new Set(list.map((c) => String(c.status)))].sort(), described, `${key}: what a success answers`);
    for (const c of list) {
      const answers = Object.keys(op.responses[c.status].content || {});
      assert.ok(c.status === 204 ? !c.type : answers.some((range) => fits(range, c.type)), `${key}: answered ${c.type}, described as ${answers.join(', ')}`);
      const takes = Object.keys(op.requestBody?.content || {});
      if (c.sent) assert.ok(takes.some((range) => fits(range, c.sent)), `${key}: took ${c.sent}, described as ${takes.join(', ') || 'nothing'}`);
    }
    assert.deepEqual([...new Set(list.flatMap((c) => c.reads))].sort(), queryOf(op).sort(), `${key}: the query parameters it reads`);
  }
});
