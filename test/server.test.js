import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { startPlatform, StartupError } from '../src/app.js';
import { loadConfig } from '../src/config.js';
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
  assert.deepEqual(Object.keys(body).sort(), ['detail', 'status', 'title', 'type']);
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

test('route parameters are decoded path segments', async (t) => {
  const routes = [{ method: 'GET', path: '/echo/:name', handler: ({ res, params }) => res.end(params.name) }];
  const { url } = await start(t, { routes });
  assert.equal(await (await fetch(`${url}/echo/friday%20main`)).text(), 'friday main');
  assert.equal((await fetch(`${url}/echo/`)).status, 404);
});

test('startup migrates the store and logs where it is listening', async (t) => {
  for (const store of ['sqlite', 'json']) {
    const { platform, entries } = await start(t, { store });
    assert.equal(platform.store.schemaVersion, 1);
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
