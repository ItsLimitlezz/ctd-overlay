// GET /api/v1/events (03 §3.4): a stream that outlives the request that opened it. It holds no
// more than a bounded queue for a client that can't keep up, and ends once whoever opened it may
// no longer read it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { startPlatform } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { defer, memoryLogger, signedIn, tempDir } from './helpers.js';

const PASSWORD = 'correct horse battery staple';

async function start(t, options = {}) {
  const root = tempDir(t);
  const config = loadConfig({ argv: ['--port', '0'], env: { SKP_DATA_DIR: path.join(root, 'data'), SKP_CONFIG_DIR: path.join(root, 'config') } });
  const platform = await startPlatform(config, { log: memoryLogger().log, scrypt: { N: 1024 }, ...options });
  defer(t, () => platform.stop());
  return platform;
}

// A browser signed in (the owner by the setup code, or anyone by password): call(method, path, body).
async function browser(platform, how) {
  const made = how
    ? await fetch(`${platform.url}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(how) })
    : await fetch(`${platform.url}/api/v1/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: platform.auth.setupCode, username: 'juan', password: PASSWORD }) });
  const cookie = made.headers.get('set-cookie').split(';')[0];
  const { csrf } = await made.json();
  const call = (method, p, body) => fetch(`${platform.url}/api/v1${p}`, { method, headers: { cookie, 'x-skp-csrf': csrf, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })
    .then(async (res) => ({ status: res.status, body: await res.json().catch(() => null) }));
  return { cookie, call };
}

// An open stream: next(type) waits for an event of that type; ended(ms) whether the server ended
// the stream within ms (reading what is left meanwhile); seen, every event type read so far.
async function open(t, platform, headers, query = '?types=custom.*') {
  const ctrl = new AbortController();
  defer(t, () => ctrl.abort());
  const res = await fetch(`${platform.url}/api/v1/events${query}`, { headers, signal: ctrl.signal });
  assert.equal(res.status, 200);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const seen = [];
  let text = '';
  let done = false;
  const pump = async () => {
    try {
      const chunk = await reader.read();
      if (chunk.done) done = true;
      else text += decoder.decode(chunk.value, { stream: true });
    } catch {
      done = true;
    }
    for (let i; (i = text.indexOf('\n\n')) >= 0;) {
      const type = /^event: (.+)$/m.exec(text.slice(0, i))?.[1];
      if (type) seen.push(type);
      text = text.slice(i + 2);
    }
  };
  return {
    res,
    seen,
    async next(type) {
      while (!seen.includes(type)) {
        if (done) throw new Error(`the stream ended before ${type}`);
        await pump();
      }
    },
    async ended(ms) {
      const until = Date.now() + ms;
      while (!done && Date.now() < until) await Promise.race([pump(), new Promise((resolve) => setTimeout(resolve, until - Date.now()))]);
      return done;
    },
  };
}

test('GET /events carries the base headers; a client that can\'t keep up is cut off, never buffered without end', async (t) => {
  const platform = await start(t);
  const stream = await open(t, platform, signedIn(platform));
  for (const [name, value] of Object.entries({ 'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin', 'cache-control': 'no-store' })) {
    assert.equal(stream.res.headers.get(name), value, name);
  }
  // 1500 events of 30 KB in one go: the socket backs up at once, so all but the first wait in the
  // stream's queue, which holds 1000 (overlays/sse.js).
  const big = 'x'.repeat(30 * 1024);
  for (let i = 0; i < 1500; i++) platform.bus.publish('custom.big', { i, big });
  assert.equal(await stream.ended(5000), true, 'the stream was ended');
  assert.ok(stream.seen.length < 1500, `${stream.seen.length} of 1500 arrived`);
});

test('GET /events: an event once the token is revoked ends the stream instead (07 §7.5)', async (t) => {
  const clock = { t: Date.UTC(2026, 9, 17, 18), now: () => clock.t };
  // No heartbeat in the meantime: the event itself finds out.
  const platform = await start(t, { clock: { now: clock.now }, heartbeatMs: 60 * 60 * 1000 });
  const owner = await browser(platform);
  const made = await owner.call('POST', '/tokens', { name: 'deck', scopes: ['events:read'] });
  assert.equal(made.status, 201);
  const stream = await open(t, platform, { authorization: `Bearer ${made.body.token}` });
  platform.bus.publish('custom.before', {});
  await stream.next('custom.before');
  assert.equal((await owner.call('DELETE', `/tokens/${made.body.id}`)).status, 200);
  clock.t += 1000; // the stream checks again before an event once its last check is a second old
  platform.bus.publish('custom.after', {});
  assert.equal(await stream.ended(3000), true);
  assert.deepEqual(stream.seen, ['custom.before'], 'nothing after the revocation');
});

test('GET /events ends at the next heartbeat once its principal may no longer read: signed out, removed, expired', async (t) => {
  const clock = { t: Date.UTC(2026, 9, 17, 18), now: () => clock.t };
  const platform = await start(t, { clock: { now: clock.now }, heartbeatMs: 50 });
  const owner = await browser(platform);
  assert.equal((await owner.call('POST', '/users', { username: 'op', password: PASSWORD, role: 'operator' })).status, 201);
  const op = await browser(platform, { username: 'op', password: PASSWORD });
  const again = await browser(platform, { username: 'juan', password: PASSWORD }); // the owner's second session
  const short = (await owner.call('POST', '/tokens', { name: 'brief', scopes: ['events:read'], expiresInDays: 1 })).body;

  const ops = await open(t, platform, { cookie: op.cookie });
  const theirs = await open(t, platform, { cookie: again.cookie });
  const brief = await open(t, platform, { authorization: `Bearer ${short.token}` });
  const local = await open(t, platform, signedIn(platform));

  assert.equal((await again.call('POST', '/auth/logout', {})).status, 200);
  assert.equal(await theirs.ended(3000), true, 'signed out');
  assert.equal((await owner.call('DELETE', '/users/op')).status, 200);
  assert.equal(await ops.ended(3000), true, 'the user removed');
  assert.equal(await brief.ended(300), false, 'the token still holds');
  clock.t += 24 * 60 * 60 * 1000;
  assert.equal(await brief.ended(3000), true, 'the token expired');
  assert.equal(await local.ended(300), false, 'the command line still may');
});
