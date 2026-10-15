import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { startPlatform, StartupError } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { readBody, sendJson, sendProblem } from '../src/http/server.js';
import { uiRoutes } from '../src/http/ui.js';
import { migrations } from '../src/store/migrations.js';
import { defer, memoryLogger, tempDir } from './helpers.js';

async function start(t, { routes = [], store = 'sqlite' } = {}) {
  const root = tempDir(t);
  const config = loadConfig({
    argv: ['--port', '0', '--store', store],
    env: { SKP_DATA_DIR: path.join(root, 'data'), SKP_CONFIG_DIR: path.join(root, 'config') },
  });
  const { log, entries } = memoryLogger();
  const platform = await startPlatform(config, { log, routes });
  defer(t, () => platform.stop());
  return { platform, entries, url: platform.url };
}

// Sends raw bytes and returns the status line of the reply.
function raw(port, text) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(text));
    let data = '';
    socket.on('data', (d) => { data += d; });
    socket.on('end', () => resolve(data.split('\r\n')[0]));
    socket.on('error', reject);
    setTimeout(() => { socket.destroy(); resolve(data.split('\r\n')[0]); }, 2000);
  });
}

test('GET /healthz answers 200 "ok" with nothing else (10 §10.3)', async (t) => {
  const { url } = await start(t);
  const res = await fetch(`${url}/healthz`);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'ok');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  const head = await fetch(`${url}/healthz`, { method: 'HEAD' });
  assert.equal(head.status, 200);
});

test('unknown paths get a 404 problem document', async (t) => {
  const { url } = await start(t);
  const res = await fetch(`${url}/nope`);
  assert.equal(res.status, 404);
  assert.equal(res.headers.get('content-type'), 'application/problem+json');
  const body = await res.json();
  assert.deepEqual(Object.keys(body).sort(), ['detail', 'instance', 'status', 'title', 'type']);
  assert.equal(body.status, 404);
});

test('a known path with the wrong method gets 405 with Allow', async (t) => {
  const { url } = await start(t);
  const res = await fetch(`${url}/healthz`, { method: 'POST' });
  assert.equal(res.status, 405);
  assert.equal(res.headers.get('allow'), 'GET, HEAD');
});

test('malformed requests get 400 and the server keeps serving (H11)', async (t) => {
  const { platform, url } = await start(t);
  assert.equal(await raw(platform.port, 'GET /%E0%A4%A HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'), 'HTTP/1.1 400 Bad Request');
  assert.equal(await raw(platform.port, 'NOT HTTP AT ALL\r\n\r\n'), 'HTTP/1.1 400 Bad Request');
  assert.equal((await fetch(`${url}/healthz`)).status, 200);
});

test('a handler that throws or rejects gets a 500 with no stack, logged to crash.log', async (t) => {
  const routes = [
    { method: 'GET', path: '/sync-boom', handler: () => { throw new Error('kaboom ?key=skp_ovl_leak'); } },
    { method: 'GET', path: '/async-boom', handler: async () => { await null; throw new Error('async kaboom'); } },
  ];
  const { platform, url, entries } = await start(t, { routes });
  for (const p of ['/sync-boom', '/async-boom']) {
    const res = await fetch(url + p);
    assert.equal(res.status, 500);
    const text = await res.text();
    assert.doesNotMatch(text, /kaboom|at |\.js/);
  }
  const crash = readFileSync(platform.crash.file, 'utf8');
  assert.match(crash, /kaboom/);
  assert.doesNotMatch(crash, /skp_ovl_leak/);
  assert.ok(entries.some((e) => e.level === 'error' && e.msg === 'request failed'));
  assert.equal((await fetch(`${url}/healthz`)).status, 200);
});

test('errors under /o/ and /sdk/ allow any origin; others do not (07 §7.10)', async (t) => {
  const routes = [
    { method: 'GET', path: '/sdk/boom', handler: () => { throw new Error('boom'); } },
    { method: 'GET', path: '/api/boom', handler: () => { throw new Error('boom'); } },
  ];
  const { url } = await start(t, { routes });
  for (const [p, status, cors] of [['/sdk/boom', 500, '*'], ['/o/x/y/z/w', 404, '*'], ['/api/boom', 500, null], ['/nope', 404, null]]) {
    const res = await fetch(url + p);
    assert.equal(res.status, status, p);
    assert.equal(res.headers.get('access-control-allow-origin'), cors, p);
  }
});

// Sends a raw request and resolves with the reply's status line and headers, and whether the
// server closed the connection afterwards (within a second of the reply).
function exchange(port, text) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(text));
    let data = '';
    let timer;
    const done = (closed) => {
      clearTimeout(timer);
      socket.destroy();
      const [head] = data.split('\r\n\r\n');
      const [status, ...lines] = head.split('\r\n');
      const headers = Object.fromEntries(lines.map((l) => [l.slice(0, l.indexOf(':')).toLowerCase(), l.slice(l.indexOf(':') + 1).trim()]));
      resolve({ status, headers, closed });
    };
    socket.setEncoding('latin1');
    socket.on('data', (d) => {
      data += d;
      clearTimeout(timer);
      timer = setTimeout(() => done(false), 1000);
    });
    socket.on('end', () => done(true));
    socket.on('error', reject);
  });
}

test('a body over the limit gets its 413, then the connection closes (chunked or declared)', async (t) => {
  // A route that reads at most 8 KiB and answers with the size, or with the BodyError.
  const routes = [{
    method: 'POST',
    path: '/body',
    handler: async ({ req, res }) => {
      let text;
      try { text = await readBody(req, 8192); } catch (err) { return sendProblem(res, err.status, 'Too large', err.message, { headers: err.headers }); }
      sendJson(res, 200, { bytes: Buffer.byteLength(text) });
    },
  }];
  const { platform, url } = await start(t, { routes });
  const chunks = (n) => Array.from({ length: n / 1000 }, () => `3e8\r\n${'x'.repeat(1000)}\r\n`).join('') + '0\r\n\r\n';

  const small = await fetch(`${url}/body`, { method: 'POST', body: 'x'.repeat(5000) });
  assert.deepEqual(await small.json(), { bytes: 5000 });

  const chunked = await exchange(platform.port, `POST /body HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n${chunks(9000)}`);
  assert.equal(chunked.status, 'HTTP/1.1 413 Payload Too Large');
  assert.equal(chunked.headers.connection, 'close');
  assert.equal(chunked.closed, true);

  const declared = await exchange(platform.port, `POST /body HTTP/1.1\r\nHost: x\r\nContent-Length: 9000\r\n\r\n${'x'.repeat(1000)}`);
  assert.equal(declared.status, 'HTTP/1.1 413 Payload Too Large');
  assert.equal(declared.headers.connection, 'close');
  assert.equal(declared.closed, true, 'the server does not wait for (or read) the other 8000 bytes');

  assert.equal((await fetch(`${url}/healthz`)).status, 200);
});

test('a body that takes too long to arrive gets its 408, then the connection closes; the whole request has a backstop long enough for an upload', async (t) => {
  const routes = [{
    method: 'POST',
    path: '/body',
    handler: async ({ req, res }) => {
      let text;
      try { text = await readBody(req, 8192, { ms: 300 }); } catch (err) { return sendProblem(res, err.status, 'Refused', err.message, { headers: err.headers }); }
      sendJson(res, 200, { bytes: Buffer.byteLength(text) });
    },
  }];
  const { platform, url } = await start(t, { routes });
  assert.deepEqual(await (await fetch(`${url}/body`, { method: 'POST', body: 'x'.repeat(100) })).json(), { bytes: 100 });
  // 100 of the 1000 bytes it declares, then nothing.
  const slow = exchange(platform.port, `POST /body HTTP/1.1\r\nHost: x\r\nContent-Length: 1000\r\n\r\n${'x'.repeat(100)}`);
  const reply = await Promise.race([slow, new Promise((resolve) => setTimeout(() => resolve({ status: 'no answer' }), 3000))]);
  assert.equal(reply.status, 'HTTP/1.1 408 Request Timeout');
  assert.deepEqual([reply.headers.connection, reply.closed], ['close', true]);
  // Node's requestTimeout can't be set per route: it must let 600 MiB through on a slow link.
  assert.ok(platform.server.requestTimeout >= 30 * 60 * 1000);
  assert.equal(platform.server.headersTimeout, 30000, 'headers still arrive in 30 s or not at all');
});

test('the admin UI\'s and the API\'s headers are on every answer, a route\'s own included; the routes served are listed', async (t) => {
  const routes = [{ method: 'GET', path: '/api/picture', handler: ({ res }) => { res.writeHead(200, { 'content-type': 'image/png' }); res.end(); } }];
  const { platform, url } = await start(t, { routes });
  const res = await fetch(`${url}/api/picture`);
  assert.deepEqual(['x-content-type-options', 'referrer-policy', 'content-security-policy'].map((h) => Boolean(res.headers.get(h))), [true, true, true]);
  assert.equal(res.headers.get('referrer-policy'), 'same-origin');
  assert.ok(platform.server.routes.some((r) => r.method === 'GET' && r.path === '/api/picture'));
  assert.ok(platform.server.routes.some((r) => r.method === 'GET' && r.path === '/healthz'));
});

test('route close hooks run when the server closes', async (t) => {
  let closed = 0;
  const routes = [{ method: 'GET', path: '/x', handler: ({ res }) => res.end(), close: () => { closed++; } }];
  const { platform } = await start(t, { routes });
  assert.equal(closed, 0);
  await platform.stop();
  assert.equal(closed, 1);
});

test('route parameters are decoded path segments', async (t) => {
  const routes = [{ method: 'GET', path: '/echo/:name', handler: ({ res, params }) => res.end(params.name) }];
  const { url } = await start(t, { routes });
  assert.equal(await (await fetch(`${url}/echo/friday%20main`)).text(), 'friday main');
  assert.equal((await fetch(`${url}/echo/`)).status, 404);
});

test('startup migrates the store and logs where it is listening', async (t) => {
  for (const store of ['sqlite', 'json']) {
    const { platform, entries } = await start(t, { store });
    assert.equal(platform.store.schemaVersion, migrations.length);
    const listening = entries.find((e) => e.msg === 'listening');
    assert.equal(listening.context.url, `${platform.url}/`);
    assert.equal(listening.context.store, store);
  }
});

test('a port that is already taken is a clear StartupError', async (t) => {
  const { platform } = await start(t);
  const root = tempDir(t);
  const config = loadConfig({
    argv: ['--port', String(platform.port)],
    env: { SKP_DATA_DIR: path.join(root, 'data'), SKP_CONFIG_DIR: path.join(root, 'config') },
  });
  await assert.rejects(startPlatform(config, { log: memoryLogger().log }), (e) => e instanceof StartupError && /already in use/.test(e.message));
});

// The admin UI's files (src/http/ui.js): nothing but the files in its directory, whatever the
// separator. On Windows a backslash separates too, so "pages\.hidden.js" and "pages\..\app.js"
// must not slip past the checks made on "/"-separated parts.
test('the UI files: a backslash in the path is refused like a dot file or a step outside', async (t) => {
  const dir = tempDir(t);
  mkdirSync(path.join(dir, 'pages'));
  writeFileSync(path.join(dir, 'app.js'), 'export {};');
  writeFileSync(path.join(dir, 'pages', 'live.js'), 'export {};');
  writeFileSync(path.join(dir, 'pages', '.hidden.js'), 'secret');
  const handler = uiRoutes({ dir: `${dir}${path.sep}` }).find((r) => r.path === '/ui/*').handler;
  const get = async (rel) => {
    const res = { writeHead(status) { this.status = status; }, end() {} };
    await handler({ res, params: { '*': rel } });
    return res.status;
  };
  assert.equal(await get('app.js'), 200);
  assert.equal(await get('pages/live.js'), 200);
  for (const rel of ['pages/.hidden.js', 'pages\\.hidden.js', 'pages\\..\\app.js', 'pages\\live.js', '..\\package.json', 'pages/../app.js']) {
    assert.equal(await get(rel), 404, rel);
  }
});
