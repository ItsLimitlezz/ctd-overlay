// The HTTP client every connector uses (06 §6.1, 07 §7.11): retries only what is safe to send twice,
// honours 429 by cooling the whole origin down, renews a token once on a 401 and then gives up,
// caps answers, times out, and reaches operator-typed addresses only on the local network (never
// link-local), pinning a self-signed certificate by its fingerprint before any request is sent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { createHttpClient, lanRefusal } from '../src/connectors/http.js';
import { fakeClock, fakeFetch } from './connector-helpers.js';
import { defer } from './helpers.js';
import { selfSigned } from './tls.js';

const SEC = 1000;
const client = (fetch, extra = {}) => {
  const clock = extra.clock || fakeClock();
  return { clock, http: createHttpClient({ fetch, now: clock.now, timers: clock.timers, random: () => 0.5, ...extra }) };
};
// Runs a request while the clock moves, so retries' waits pass.
async function settle(clock, promise, ms = 60 * SEC) {
  const out = promise.then((v) => ({ v }), (e) => ({ e }));
  await clock.advance(ms);
  const r = await out;
  if (r.e) throw r.e;
  return r.v;
}

test('only what is safe to send twice is retried: GET up to twice on a 503, a POST never', async () => {
  let n = 0;
  const fetch = fakeFetch(() => (++n <= 2 ? { status: 503, body: { message: 'busy' } } : { status: 200, body: { ok: true } }));
  const { clock, http: c } = client(fetch);
  assert.deepEqual((await settle(clock, c.request('https://svc.example/a'))).data, { ok: true });
  assert.equal(fetch.calls.length, 3);
  n = 0;
  await assert.rejects(settle(clock, c.request('https://svc.example/b', { method: 'POST', json: { x: 1 } })), (err) => err.status === 503 && err.code === 'server-error' && /busy/.test(err.message));
  assert.equal(fetch.calls.length, 4, 'one POST, not retried');
  // A name that doesn't exist isn't retried either.
  const nx = fakeFetch(() => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }));
  await assert.rejects(client(nx).http.request('https://nowhere.example/'), { code: 'not-found' });
  assert.equal(nx.calls.length, 1);
});

test('429: a short Retry-After is waited out; a long one cools the whole origin down, failing fast meanwhile', async () => {
  const script = [{ status: 429, headers: { 'retry-after': '2' } }, { status: 200, body: { n: 1 } }, { status: 429, headers: { 'retry-after': '120' } }, { status: 200, body: { n: 2 } }];
  const fetch = fakeFetch(() => script.shift());
  const { clock, http: c } = client(fetch);
  assert.deepEqual((await settle(clock, c.request('https://svc.example/a'), 3 * SEC)).data, { n: 1 });
  await assert.rejects(c.request('https://svc.example/a'), (err) => err.code === 'rate-limited' && err.retryAfterMs === 120000);
  const calls = fetch.calls.length;
  await assert.rejects(c.request('https://svc.example/other'), (err) => err.code === 'rate-limited' && err.retryAfterMs <= 120000);
  assert.equal(fetch.calls.length, calls, 'no request while cooling down');
  await clock.advance(120 * SEC);
  assert.deepEqual((await c.request('https://svc.example/a')).data, { n: 2 });
});

test('a 401 renews the token once and sends again; a second 401 is needs-reauth, not a loop', async () => {
  let token = 'old-token-000';
  const said = [];
  const auth = {
    header: async () => `Bearer ${token}`,
    refresh: async () => { token = 'new-token-111'; said.push('refresh'); },
    rejected: (kind, why) => said.push(`rejected ${kind}: ${why}`),
  };
  const fetch = fakeFetch((u, init) => (init.headers.authorization === 'Bearer new-token-111' && u.pathname === '/ok' ? { status: 200, body: { me: 1 } } : { status: 401, body: {} }));
  const { http: c } = client(fetch, { auth });
  assert.deepEqual((await c.request('https://svc.example/ok', { auth: 'user', method: 'POST' })).data, { me: 1 });
  assert.deepEqual(said, ['refresh']);
  await assert.rejects(c.request('https://svc.example/never', { auth: 'user' }), (err) => err.code === 'needs-reauth' && err.status === 401);
  assert.equal(said.length, 3);
  assert.match(said[2], /^rejected user/);
});

test('answers are capped, slow requests time out, and redirects are errors', async () => {
  const big = 'x'.repeat(2 * 1024 * 1024);
  const fetch = fakeFetch((u) => (u.pathname === '/big' ? { status: 200, body: { big } } : u.pathname === '/slow' ? 'hang' : { status: 302, headers: { location: 'https://elsewhere.example/' } }));
  const { clock, http: c } = client(fetch);
  await assert.rejects(c.request('https://svc.example/big'), { code: 'too-large' });
  const slow = c.request('https://svc.example/slow', { retries: 0 });
  await assert.rejects(settle(clock, slow, 10 * SEC), (err) => err.code === 'timeout' && /longer than 10 s/.test(err.message));
  await assert.rejects(c.request('https://svc.example/moved'), { code: 'redirect' });
  // A query never shows in an error (it may carry a token).
  await assert.rejects(c.request('https://svc.example/moved?access_token=abc'), (err) => !err.message.includes('abc'));
});

test('a service is reached over https only, except an origin a test pointed an endpoint at', async () => {
  const fetch = fakeFetch(() => ({ status: 200, body: {} }));
  await assert.rejects(client(fetch).http.request('http://svc.example/'), { code: 'egress' });
  assert.equal((await client(fetch, { allowHttp: new Set(['http://127.0.0.1:9']) }).http.request('http://127.0.0.1:9/x')).status, 200);
  assert.equal(fetch.calls.length, 1);
});

test('an operator-typed address: local network only over plain http, never link-local, unspecified or multicast', async (t) => {
  assert.match(lanRefusal('169.254.169.254'), /link-local/);
  assert.match(lanRefusal('fe80::1'), /link-local/);
  assert.match(lanRefusal('0.0.0.0'), /unspecified/);
  assert.match(lanRefusal('239.1.2.3'), /multicast/);
  assert.equal(lanRefusal('192.168.1.50'), undefined);
  // IPv4 inside IPv6 gets the IPv4 rules: NAT64, IPv4-translated and IPv4-compatible spellings.
  for (const a of ['64:ff9b::a9fe:a9fe', '64:ff9b::169.254.169.254', '::a9fe:a9fe', '::169.254.169.254', '::ffff:0:a9fe:a9fe']) assert.match(lanRefusal(a) || '', /link-local/, a);
  assert.match(lanRefusal('64:ff9b::e000:1'), /multicast/);
  assert.equal(lanRefusal('64:ff9b::c0a8:132'), undefined, '192.168.1.50 through NAT64');
  assert.equal(lanRefusal('::1'), undefined, 'loopback stays loopback');
  await assert.rejects(createHttpClient().request('http://[64:ff9b::a9fe:a9fe]/latest', { egress: 'lan' }), (err) => err.code === 'egress' && /link-local/.test(err.message));
  await assert.rejects(createHttpClient().request('http://[::a9fe:a9fe]/', { egress: 'lan' }), (err) => err.code === 'egress' && /link-local/.test(err.message));
  const lookups = [];
  const lookup = async (host) => { lookups.push(host); return host === 'evil.example' ? [{ address: '169.254.169.254', family: 4 }] : [{ address: '8.8.8.8', family: 4 }]; };
  const c = createHttpClient({ lookup });
  await assert.rejects(c.request('http://169.254.169.254/latest/meta-data', { egress: 'lan' }), (err) => err.code === 'egress' && /link-local/.test(err.message));
  await assert.rejects(c.request('http://evil.example/', { egress: 'lan' }), (err) => err.code === 'egress' && /link-local/.test(err.message));
  await assert.rejects(c.request('http://public.example/', { egress: 'lan' }), (err) => err.code === 'egress' && /local network/.test(err.message));
  await assert.rejects(c.request('ftp://192.168.1.5/', { egress: 'lan' }), { code: 'egress' });
  // A local service over plain http works, connected to the address checked.
  const got = [];
  const server = http.createServer((req, res) => { got.push(req.headers.authorization); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  defer(t, () => new Promise((r) => { server.closeAllConnections(); server.close(r); }));
  const local = createHttpClient({ lookup: async () => [{ address: '127.0.0.1', family: 4 }] });
  const r = await local.request(`http://nas.local:${server.address().port}/api/v1/status`, { egress: 'lan', headers: { authorization: 'Bearer ctd_pat_x' } });
  assert.deepEqual(r.data, { ok: true });
  assert.deepEqual(got, ['Bearer ctd_pat_x']);
});

test('a stream\'s socket closes when its request or the instance stops, or its reader cancels, however long after the headers', async (t) => {
  let open = 0;
  const server = http.createServer((req, res) => {
    open++;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const beat = setInterval(() => res.write(': ping\n\n'), 20);
    res.on('close', () => { clearInterval(beat); open--; });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  defer(t, () => new Promise((r) => { server.closeAllConnections(); server.close(r); }));
  const url = `http://127.0.0.1:${server.address().port}/events`;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const settled = async (n, what) => { for (let i = 0; i < 200 && open !== n; i++) await wait(10); assert.equal(open, n, what); };
  // Read for a while (well past the headers), then stop: by the request's signal, then the instance's.
  for (const which of ['request', 'instance']) {
    const instance = new AbortController();
    const request = new AbortController();
    const res = await createHttpClient({ signal: instance.signal }).request(url, { egress: 'lan', expect: 'stream', retries: 0, signal: request.signal });
    const reading = (async () => { for await (const _ of res.body) { /* heartbeats */ } })().catch((err) => err);
    await settled(1, `${which}: open while read`);
    await wait(100);
    (which === 'request' ? request : instance).abort();
    await settled(0, `${which}: closed when it stopped`);
    assert.ok(await reading instanceof Error, 'the reader hears it ended');
  }
  // A reader that stops reading (cancels) closes it too.
  const res = await createHttpClient().request(url, { egress: 'lan', expect: 'stream', retries: 0 });
  await settled(1, 'open');
  await res.body.cancel();
  await settled(0, 'closed when cancelled');
});

test('a self-signed https service is trusted by its fingerprint, checked before the request (and its token) is sent', async (t) => {
  const { cert, key } = selfSigned();
  const got = [];
  const server = https.createServer({ cert, key }, (req, res) => { got.push(req.headers.authorization); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"tls":true}'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  defer(t, () => new Promise((r) => { server.closeAllConnections(); server.close(r); }));
  const url = `https://127.0.0.1:${server.address().port}/api/v1/status`;
  const fingerprint256 = new X509Certificate(cert).fingerprint256;
  const c = createHttpClient();
  assert.deepEqual((await c.request(url, { egress: 'lan', tls: { fingerprint256 }, headers: { authorization: 'Bearer secret-token' } })).data, { tls: true });
  assert.deepEqual(got, ['Bearer secret-token']);
  const wrong = fingerprint256.replace(/^../, fingerprint256.startsWith('00') ? '11' : '00');
  await assert.rejects(c.request(url, { egress: 'lan', tls: { fingerprint256: wrong }, headers: { authorization: 'Bearer secret-token' } }), (err) => err.code === 'tls-pin' && /doesn't match the fingerprint/.test(err.message));
  // Without a pin a self-signed certificate is refused.
  await assert.rejects(c.request(url, { egress: 'lan', retries: 0 }), { code: 'network' });
  assert.equal(got.length, 1, 'nothing reached a server it couldn\'t prove');
});
