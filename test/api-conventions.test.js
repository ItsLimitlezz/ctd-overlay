// The API toolkit's conventions on their own (http/api.js, 03 §3.1–3.5): routes on createApi
// behind a guard that believes X-Who, a store in memory, and a server that takes the client's
// address from X-IP. The platform's own routes are in api.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { addressKey, ApiError, createApi } from '../src/http/api.js';
import { createRouter } from '../src/http/server.js';
import { defer } from './helpers.js';

const BASE = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin', 'cache-control': 'no-store' };

// X-Who: "<id>" is a token, "session:<id>" a user's session; none is a 401.
function believe(req, res) {
  const who = req.headers['x-who'];
  if (!who) {
    res.writeHead(401);
    res.end();
    return undefined;
  }
  const [kind, id] = who.includes(':') ? who.split(':') : ['token', who];
  return kind === 'session' ? { kind, user: { id }, scopes: new Set() } : { kind: 'token', tokenId: id, scopes: new Set() };
}

async function harness(t, defs, options = {}) {
  const docs = new Map();
  const store = {
    get: (c, id) => docs.get(`${c}/${id}`),
    put: (c, id, data) => { const doc = { id, rev: 1, data }; docs.set(`${c}/${id}`, doc); return doc; },
    list: (c) => [...docs].filter(([k]) => k.startsWith(`${c}/`)).map(([, doc]) => doc),
    delete: (c, id) => docs.delete(`${c}/${id}`),
  };
  const errors = [];
  let port;
  const api = createApi({ guard: options.guard || believe, hosts: () => [`127.0.0.1:${port}`], store, log: { error: (msg, ctx) => errors.push({ msg, ...ctx }) }, ...options.api });
  const router = createRouter(defs.map((def) => api.route({ summary: def.path, ...def })));
  const server = createServer((req, res) => {
    req.client = { ip: req.headers['x-ip'] || req.socket.remoteAddress };
    const url = new URL(req.url, 'http://localhost');
    const found = router.match(req.method, url.pathname.split('/').slice(1));
    if (!found.route) {
      res.writeHead(404);
      return res.end();
    }
    found.route.handler({ req, res, params: found.params, url }).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
  defer(t, () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const call = async (method, p, { body, headers = {} } = {}) => {
    const raw = Buffer.isBuffer(body);
    const res = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'x-who': 'deck', ...(body !== undefined ? { 'content-type': raw ? 'application/octet-stream' : 'application/json' } : {}), ...headers }, body: body === undefined ? undefined : raw ? body : JSON.stringify(body) });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json, headers: res.headers };
  };
  return { api, call, docs, errors, port: () => port };
}

const idempotency = (docs) => [...docs.keys()].filter((k) => k.startsWith('idempotency/'));

test('Idempotency-Key is per principal, and a repeat while the first is still being answered is a 409', async (t) => {
  let runs = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { call } = await harness(t, [{ method: 'POST', path: '/x', scope: 'x', body: { fields: [] }, async run({ who }) {
    runs++;
    if (who.tokenId === 'slow') await gate;
    return { status: 201, body: { by: who.tokenId, n: runs } };
  } }]);
  const a = await call('POST', '/x', { body: {}, headers: { 'x-who': 'A', 'idempotency-key': 'k' } });
  const b = await call('POST', '/x', { body: {}, headers: { 'x-who': 'B', 'idempotency-key': 'k' } });
  assert.deepEqual([a.status, b.status, b.headers.get('idempotent-replayed'), b.body.by, runs], [201, 201, null, 'B', 2], 'another principal\'s key is its own');
  const first = call('POST', '/x', { body: {}, headers: { 'x-who': 'slow', 'idempotency-key': 'press' } });
  while (runs < 3) await new Promise((resolve) => setTimeout(resolve, 5));
  setTimeout(release, 300); // a second run, if there were one, wouldn't wait for ever
  const second = await call('POST', '/x', { body: {}, headers: { 'x-who': 'slow', 'idempotency-key': 'press' } });
  assert.deepEqual([second.status, second.body.type], [409, 'https://skp.dev/errors/idempotency-in-progress']);
  release();
  assert.equal((await first).status, 201);
  assert.equal(runs, 3, 'a button pressed twice fired once');
  const third = await call('POST', '/x', { body: {}, headers: { 'x-who': 'slow', 'idempotency-key': 'press' } });
  assert.deepEqual([third.status, third.headers.get('idempotent-replayed'), runs], [201, 'true', 3], 'once answered, the answer again');
});

test('Idempotency-Key: the query is part of the request, and raw bytes are fingerprinted as they are (never as JSON)', async (t) => {
  let checks = 0;
  const { call } = await harness(t, [
    { method: 'POST', path: '/check', body: { fields: [] }, run: ({ url }) => ({ checked: url.searchParams.get('source'), n: ++checks }) },
    { method: 'POST', path: '/package', body: { raw: true, limit: 8 * 1024 * 1024 }, run: ({ body }) => ({ status: 201, body: { bytes: body.length, first: body[0] } }) },
  ]);
  const a = await call('POST', '/check?source=a/one', { body: {}, headers: { 'idempotency-key': 'k' } });
  const b = await call('POST', '/check?source=b/two', { body: {}, headers: { 'idempotency-key': 'k' } });
  assert.deepEqual([a.status, a.body.checked, b.status, b.body.type], [200, 'a/one', 422, 'https://skp.dev/errors/idempotency-mismatch'], 'another query is another request');
  assert.equal((await call('POST', '/check?source=a/one', { body: {}, headers: { 'idempotency-key': 'k' } })).headers.get('idempotent-replayed'), 'true');
  assert.equal(checks, 1);

  // JSON.stringify(Buffer) goes through Buffer#toJSON: an array of a number per byte, seconds of
  // work and a GB of memory for a 100 MiB package. It must never be called.
  const toJSON = Buffer.prototype.toJSON;
  Buffer.prototype.toJSON = () => { throw new Error('a raw body was turned into JSON'); };
  t.after(() => { Buffer.prototype.toJSON = toJSON; });
  const pkg = Buffer.alloc(4 * 1024 * 1024, 7);
  const first = await call('POST', '/package', { body: pkg, headers: { 'idempotency-key': 'p' } });
  const again = await call('POST', '/package', { body: pkg, headers: { 'idempotency-key': 'p' } });
  assert.deepEqual([first.status, first.body.bytes, again.status, again.headers.get('idempotent-replayed')], [201, pkg.length, 201, 'true']);
  const other = await call('POST', '/package', { body: Buffer.alloc(pkg.length, 8), headers: { 'idempotency-key': 'p' } });
  assert.deepEqual([other.status, other.body.type], [422, 'https://skp.dev/errors/idempotency-mismatch'], 'other bytes are another request');
});

test('a streamed upload ignores Idempotency-Key: its body can\'t be told apart before it is read', async (t) => {
  let n = 0;
  const { call, docs } = await harness(t, [{ method: 'POST', path: '/upload', body: { stream: true }, run: async ({ body }) => {
    let size = 0;
    for await (const chunk of body) size += chunk.length;
    return { status: 201, body: { n: ++n, size } };
  } }]);
  const a = await call('POST', '/upload?name=a.png', { body: Buffer.alloc(1000, 1), headers: { 'idempotency-key': 'u' } });
  const b = await call('POST', '/upload?name=a.png', { body: Buffer.alloc(2000, 2), headers: { 'idempotency-key': 'u' } });
  assert.deepEqual([a.status, a.body, b.status, b.body], [201, { n: 1, size: 1000 }, 201, { n: 2, size: 2000 }]);
  assert.equal(b.headers.get('idempotent-replayed'), null, 'another file is never answered with the first one\'s record');
  assert.deepEqual(idempotency(docs), [], 'nothing kept');
});

test('If-Match (RFC 9110 §13.1.1): "*" when it exists, a list when one is current, never a weak tag; a session must name the version', async (t) => {
  const thing = { id: 'thing_1', rev: 3 };
  const { call } = await harness(t, [
    { method: 'PATCH', path: '/thing', resource: () => thing, body: { fields: [] }, run: ({ ifRev }) => ({ ifRev }) },
    { method: 'DELETE', path: '/thing', resource: () => thing, run: ({ ifRev }) => ({ ifRev: ifRev ?? null }) },
  ]);
  const patch = (ifMatch, who = 'deck') => call('PATCH', '/thing', { body: {}, headers: { 'x-who': who, ...(ifMatch === undefined ? {} : { 'if-match': ifMatch }) } });
  const current = '"thing_1-r3"';
  assert.deepEqual([(await patch(current)).status, (await patch(current)).body.ifRev], [200, 3]);
  const weak = await patch(`W/${current}`);
  assert.deepEqual([weak.status, weak.body.type, weak.headers.get('etag')], [412, 'https://skp.dev/errors/stale', current], 'a weak tag never matches');
  assert.deepEqual([(await patch('*')).status, (await patch('*')).body.ifRev], [200, 3], '"*": it exists');
  assert.equal((await patch(`"x-r1", ${current}`)).status, 200, 'one of the list is current');
  assert.equal((await patch(`${current},"x-r1"`)).status, 200);
  assert.equal((await patch('"x-r1", "thing_1-r2"')).status, 412, 'none of the list is');
  assert.equal((await patch('thing_1-r3')).status, 412, 'not a tag');
  assert.equal((await patch(undefined)).status, 200, 'a token may leave it out');
  assert.deepEqual([(await patch('*', 'session:usr_1')).status, (await patch('*', 'session:usr_1')).body.type], [428, 'https://skp.dev/errors/if-match-required'], 'the admin UI names what it read (H16)');
  assert.equal((await patch(current, 'session:usr_1')).status, 200);
  assert.equal((await call('DELETE', '/thing', { headers: { 'x-who': 'session:usr_1', 'if-match': '*' } })).status, 200);
});

test('problems: a conflict is 409, a failure of the platform 500, shutting down 503, a download failing upstream 502/504; settings problems are `problems`', async (t) => {
  const thrown = (name, code, detail) => Object.assign(new Error(`${name} ${code}`), { name, code, ...(detail !== undefined ? { detail } : {}) });
  const errors = {
    busy: thrown('MediaError', 'busy'),
    'in-use': thrown('MediaError', 'in-use'),
    'version-exists': thrown('TemplateError', 'version-exists'),
    'write-failed': thrown('TemplateError', 'write-failed'),
    'read-only': thrown('MediaError', 'read-only'),
    closed: thrown('MediaError', 'closed'),
    stopped: thrown('SourceError', 'stopped'),
    unreachable: thrown('SourceError', 'unreachable'),
    'bad-response': thrown('SourceError', 'bad-response'),
    'download-failed': thrown('SourceError', 'download-failed'),
    timeout: thrown('SourceError', 'timeout'),
    'remote-too-large': thrown('SourceError', 'too-large'),
    'upload-too-large': thrown('MediaError', 'too-large'),
    'no-release': thrown('SourceError', 'no-release'),
    'login-busy': Object.assign(thrown('AuthError', 'busy'), { status: 429, retryAfterS: 2 }),
    settings: thrown('OverlayError', 'bad-settings', [{ path: '/size', message: 'must be at most 10' }]),
    upgrade: thrown('OverlayError', 'bad-settings', { overlay: 'main', from: '1.0.0', to: '2.0.0', problems: [{ path: '/size', message: 'must be at most 10' }] }),
    major: thrown('OverlayError', 'confirm-major', { overlay: 'main', from: '1.0.0', to: '2.0.0' }),
  };
  const { call, errors: logged } = await harness(t, [{ method: 'GET', path: '/fail/:what', run: ({ params }) => { throw errors[params.what]; } }]);
  const statuses = {};
  for (const what of Object.keys(errors)) statuses[what] = (await call('GET', `/fail/${what}`)).status;
  assert.deepEqual(statuses, {
    busy: 409, 'in-use': 409, 'version-exists': 409,
    'write-failed': 500, 'read-only': 503, closed: 503, stopped: 503,
    unreachable: 502, 'bad-response': 502, 'download-failed': 502, timeout: 504,
    'remote-too-large': 422, 'upload-too-large': 413, 'no-release': 422, 'login-busy': 429,
    settings: 422, upgrade: 422, major: 409,
  });
  assert.equal((await call('GET', '/fail/unreachable')).body.title, 'Bad gateway');
  assert.ok(logged.some((e) => e.err === errors['write-failed']), 'a failure of the platform\'s own is logged');
  const settings = (await call('GET', '/fail/settings')).body;
  assert.deepEqual([settings.problems, settings.plan], [[{ path: '/size', message: 'must be at most 10' }], undefined], 'validation problems, not a plan');
  const upgrade = (await call('GET', '/fail/upgrade')).body;
  assert.deepEqual([upgrade.plan.to, upgrade.problems[0].path], ['2.0.0', '/size'], 'the same problems, beside the plan');
  const major = (await call('GET', '/fail/major')).body;
  assert.deepEqual([major.plan.to, major.problems], ['2.0.0', undefined]);
});

test('every answer the toolkit writes carries the base headers: problems, 204s, 429s (03 §3.4, 07 §7.10)', async (t) => {
  const thing = { id: 'thing_1', rev: 1 };
  const { call } = await harness(t, [
    { method: 'POST', path: '/gone', body: { fields: ['a'] }, run: () => ({ status: 204, body: null }) },
    { method: 'GET', path: '/nope', run: () => { throw new ApiError(404, 'not-found', 'Nothing here.'); } },
    { method: 'PATCH', path: '/thing', resource: () => thing, body: { fields: [] }, run: () => thing },
  ], { api: { perMinute: 5 } });
  const answers = {
    204: await call('POST', '/gone', { body: { a: 1 } }),
    404: await call('GET', '/nope'),
    422: await call('POST', '/gone', { body: { b: 1 } }),
    412: await call('PATCH', '/thing', { body: {}, headers: { 'if-match': '"thing_1-r0"' } }),
    428: await call('PATCH', '/thing', { body: {}, headers: { 'x-who': 'session:usr_1' } }),
  };
  await call('GET', '/nope');
  answers[429] = await call('GET', '/nope');
  for (const [status, answer] of Object.entries(answers)) {
    assert.equal(answer.status, Number(status));
    for (const [name, value] of Object.entries(BASE)) assert.equal(answer.headers.get(name), value, `${status}: ${name}`);
  }
});

test('rate limits: an IPv6 address counts by its /64; a route with a budget a second of its own keeps it apart', async (t) => {
  const clock = { t: Date.UTC(2026, 9, 17, 18) };
  const { call } = await harness(t, [
    { method: 'GET', path: '/open', open: true, run: () => ({ ok: true }) },
    { method: 'POST', path: '/publish', body: { fields: [] }, perSecond: 3, status: 202, run: () => ({ status: 202, body: {} }) },
    { method: 'GET', path: '/read', run: () => ({ ok: true }) },
  ], { api: { perMinute: 5, now: () => clock.t } });
  const from = async (ip) => (await call('GET', '/open', { headers: { 'x-ip': ip } })).headers.get('ratelimit-remaining');
  assert.deepEqual([await from('2001:db8:0:1::1'), await from('2001:db8:0:1:ffff::2'), await from('2001:db8:0:2::1')], ['4', '3', '4'], 'one /64, then another');
  assert.deepEqual([await from('10.0.0.1'), await from('10.0.0.2')], ['4', '4'], 'IPv4 addresses one by one');
  assert.deepEqual(['2001:db8::1', '2001:0DB8:0001:0002:0003::', '::1', '::ffff:10.1.2.3', 'fe80::1%eth0', '[2001:db8:1::]', '64:ff9b::192.0.2.1'].map(addressKey),
    ['2001:db8:0:0::/64', '2001:db8:1:2::/64', '0:0:0:0::/64', '10.1.2.3', 'fe80:0:0:0::/64', '2001:db8:1:0::/64', '64:ff9b:0:0::/64']);

  const publish = () => call('POST', '/publish', { body: {} });
  const sent = [await publish(), await publish(), await publish(), await publish()];
  assert.deepEqual(sent.map((a) => a.status), [202, 202, 202, 429]);
  assert.deepEqual([sent[0].headers.get('ratelimit-limit'), sent[0].headers.get('ratelimit-reset'), sent[3].headers.get('retry-after')], ['3', '1', '1']);
  assert.equal((await call('GET', '/read')).headers.get('ratelimit-remaining'), '4', 'publishing used none of the per-minute budget');
  clock.t += 1000;
  assert.equal((await publish()).status, 202, 'the next second');
});

test('rate limits: expired windows are pruned without every request scanning the live ones', async (t) => {
  // The route's handler, called directly: tens of thousands of requests, no sockets.
  const make = () => {
    const api = createApi({ guard: believe, hosts: () => ['h'], store: { get() {}, put() {}, list: () => [], delete() {} }, log: { error() {} }, now: () => 0 });
    const r = api.route({ method: 'GET', path: '/open', open: true, summary: 'open', run: () => ({ ok: true }) });
    const res = { setHeader() {}, writeHead() {}, end() {}, headersSent: false };
    const url = new URL('http://h/open');
    return async (ip) => r.handler({ req: { method: 'GET', url: '/open', headers: { host: 'h' }, client: { ip }, socket: {} }, res, params: {}, url });
  };
  const timed = async (send, n) => {
    const start = performance.now();
    for (let i = 0; i < n; i++) await send('192.0.2.1');
    return performance.now() - start;
  };
  const baseline = await timed(make(), 4000);
  const flooded = make();
  for (let i = 0; i < 40000; i++) await flooded(`10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`);
  const loaded = await timed(flooded, 4000);
  assert.ok(loaded < baseline * 5 + 150, `4000 requests took ${Math.round(loaded)} ms with 40000 live windows, ${Math.round(baseline)} ms with none`);
});

test('a field of a fixed shape takes its own fields only (07 §7.11)', async (t) => {
  const { call, api } = await harness(t, [{ method: 'POST', path: '/make', body: { fields: ['slug', 'template', 'settings'], nested: { template: ['id', 'version'] } }, run: ({ body }) => body }]);
  const typo = await call('POST', '/make', { body: { slug: 'a', template: { id: 'x', version: '1', bogus: true } } });
  assert.deepEqual([typo.status, typo.body.type], [422, 'https://skp.dev/errors/unknown-field']);
  assert.match(typo.body.detail, /Unknown field in "template": bogus\. It takes id, version\./);
  assert.equal((await call('POST', '/make', { body: { slug: 'a', template: { id: 'x', version: '1' }, settings: { anything: 1 } } })).status, 200, 'settings are the template\'s to check');
  assert.equal((await call('POST', '/make', { body: { slug: 'a', template: 'x@1' } })).status, 200, 'not an object: the route says what it takes');
  const schema = api.openapi().paths['/make'].post.requestBody.content['application/json'].schema;
  assert.deepEqual(Object.keys(schema.properties.template.properties), ['id', 'version']);
});

test('the OpenAPI document: bodies of raw and streamed routes, query parameters, pages, and what a success answers', async (t) => {
  const { api } = await harness(t, [
    { method: 'POST', path: '/media', body: { stream: true }, query: ['name'], status: 201, run: () => ({}) },
    { method: 'POST', path: '/templates', body: { raw: true, json: ['url'] }, status: 201, run: () => ({}) },
    { method: 'POST', path: '/overlays/:ref/simulate', body: { limit: 1024 }, run: () => ({}) },
    { method: 'GET', path: '/shows', paged: true, run: () => ({ items: [] }) },
    { method: 'GET', path: '/events', query: ['types'], produces: 'text/event-stream', run: () => ({}) },
    { method: 'POST', path: '/events', body: { fields: ['type', 'data'] }, status: 202, run: () => ({}) },
    { method: 'DELETE', path: '/gone/:id', status: 204, run: () => ({}) },
  ]);
  const { paths } = api.openapi();
  const media = paths['/media'].post;
  assert.deepEqual([media.requestBody.required, Object.keys(media.requestBody.content)], [true, ['application/octet-stream']]);
  assert.deepEqual(media.parameters.map((p) => `${p.in}:${p.name}`), ['query:name']);
  assert.deepEqual(Object.keys(media.responses).sort(), ['201', 'default']);
  assert.deepEqual(Object.keys(paths['/templates'].post.requestBody.content), ['application/octet-stream', 'application/json']);
  assert.deepEqual(Object.keys(paths['/templates'].post.requestBody.content['application/json'].schema.properties), ['url']);
  assert.deepEqual(paths['/overlays/{ref}/simulate'].post.requestBody.content['application/json'].schema, { type: 'object' });
  const shows = paths['/shows'].get;
  assert.deepEqual(shows.parameters.map((p) => `${p.in}:${p.name}`), ['query:limit', 'query:cursor']);
  assert.equal(shows.parameters[0].schema.maximum, 200);
  assert.deepEqual(Object.keys(shows.responses['200'].content['application/json'].schema.properties), ['items', 'next']);
  assert.deepEqual(Object.keys(paths['/events'].get.responses['200'].content), ['text/event-stream']);
  assert.ok(paths['/events'].post.responses['202']);
  assert.deepEqual(paths['/gone/{id}'].delete.responses['204'], { description: 'Done' });
});

// Sends a request's head and then its body in pieces, `gapMs` apart; resolves with the status, or
// with "dropped" when the server closes the connection first.
function trickle(port, path, pieces, gapMs) {
  return new Promise((resolve) => {
    const req = request({ host: '127.0.0.1', port, method: 'POST', path, headers: { 'x-who': 'deck', 'content-type': 'application/octet-stream', 'content-length': pieces.reduce((n, p) => n + p.length, 0) } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', () => resolve('dropped'));
    req.flushHeaders();
    let i = 0;
    const next = () => {
      if (i === pieces.length) return;
      req.write(pieces[i++]);
      if (i < pieces.length) setTimeout(next, gapMs);
      else req.end();
    };
    setTimeout(next, gapMs);
  });
}

test('a streamed upload may take as long as it needs, but not stall', async (t) => {
  const { port } = await harness(t, [{ method: 'POST', path: '/upload', body: { stream: true }, run: async ({ body }) => {
    let size = 0;
    for await (const chunk of body) size += chunk.length;
    return { status: 201, body: { size } };
  } }], { api: { uploadIdleMs: 300 } });
  const piece = Buffer.alloc(1000, 1);
  assert.equal(await trickle(port(), '/upload', Array(8).fill(piece), 100), 201, 'eight pieces, 100 ms apart: longer than the 300 ms of silence allowed, never silent that long');
  const stalled = trickle(port(), '/upload', [piece, piece], 1500);
  const outcome = await Promise.race([stalled, new Promise((resolve) => setTimeout(() => resolve('still open'), 1200))]);
  assert.equal(outcome, 'dropped', 'silent for longer than allowed: dropped');
});
