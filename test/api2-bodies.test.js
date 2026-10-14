// How long a request's body may take (07 §7.11), on the real server (http/server.js) with the API
// toolkit (http/api.js) behind a guard that believes X-Who: a body nobody reads, because the
// request was refused before it, gets the server's short deadline; an upload from someone allowed
// to send it may take long, but not go silent; a body read with readBytes() gets the time its limit
// takes at the upload rate, so a slow link gets a whole package through.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import net from 'node:net';
import { createApi } from '../src/http/api.js';
import { close, createHttpServer, listen, readBytes, sendJson, sendProblem } from '../src/http/server.js';
import { defer } from './helpers.js';

// X-Who: anyone; none is a 401, answered before the body is read.
function believe(req, res) {
  if (req.headers['x-who']) return { kind: 'token', tokenId: req.headers['x-who'], scopes: new Set() };
  res.writeHead(401, { 'content-type': 'text/plain' });
  res.end('Sign in first.');
  return undefined;
}

// The server with `defs` on the toolkit and `routes` as they are.
async function serve(t, { defs = [], routes = [], bodyMs, api: options = {} }) {
  let port;
  const store = { get() {}, put() {}, list: () => [], delete() {} };
  const api = createApi({ guard: believe, hosts: () => [`127.0.0.1:${port}`], store, log: { error() {} }, ...options });
  const server = createHttpServer({ log: { error() {} }, crash: { record() {} }, routes: [...defs.map((def) => api.route({ summary: def.path, ...def })), ...routes], bodyMs });
  await listen(server, 0, '127.0.0.1');
  port = server.address().port;
  defer(t, () => close(server));
  return port;
}

// Sends `head`, then `piece` every gapMs (`count` of them); resolves with the answer's status line
// and how long after connecting the server closed the connection (undefined: still open after
// waitMs).
function trickle(port, head, { piece = 'x', gapMs = 100, count = Infinity, waitMs = 3000 } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    let data = '';
    let sent = 0;
    const socket = net.connect(port, '127.0.0.1', () => socket.write(head));
    const tick = setInterval(() => {
      if (sent < count && !socket.destroyed) {
        sent++;
        socket.write(piece);
      }
    }, gapMs);
    const finish = (closedMs) => {
      clearInterval(tick);
      clearTimeout(timer);
      socket.destroy();
      resolve({ status: data.split('\r\n')[0], closedMs });
    };
    const timer = setTimeout(() => finish(undefined), waitMs);
    socket.setEncoding('latin1');
    socket.on('data', (d) => { data += d; });
    socket.on('error', () => {});
    socket.on('close', () => finish(Date.now() - started));
  });
}

const head = (path, headers) => `POST ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('')}\r\n`;

// An upload from someone allowed to send it, in pieces gapMs apart: its status, or "dropped".
function upload(port, path, pieces, gapMs) {
  return new Promise((resolve) => {
    const req = request({ host: '127.0.0.1', port, method: 'POST', path, headers: { 'x-who': 'deck', 'content-type': 'application/octet-stream', 'content-length': pieces.reduce((n, p) => n + p.length, 0) } }, (res) => {
      let text = '';
      res.on('data', (d) => { text += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: text }));
    });
    req.on('error', () => resolve({ status: 'dropped' }));
    req.flushHeaders();
    let i = 0;
    const next = () => {
      req.write(pieces[i++]);
      if (i < pieces.length) setTimeout(next, gapMs);
      else req.end();
    };
    setTimeout(next, gapMs);
  });
}

test('a body nobody reads must arrive within the server\'s deadline; an upload from someone allowed may take longer', async (t) => {
  const size = async (body) => {
    let n = 0;
    for await (const chunk of body) n += chunk.length;
    return n;
  };
  const port = await serve(t, {
    bodyMs: 300,
    api: { uploadIdleMs: 600 },
    defs: [
      { method: 'POST', path: '/shows', body: { fields: [] }, run: () => ({ status: 201, body: {} }) },
      { method: 'POST', path: '/media', body: { stream: true }, run: async ({ body }) => ({ status: 201, body: { size: await size(body) } }) },
      { method: 'POST', path: '/package', body: { raw: true, limit: 10 * 1024 * 1024 }, run: ({ body }) => ({ status: 201, body: { size: body.length } }) },
    ],
  });

  // Refused at once (no credentials, nothing at that path), then a byte every 100 ms of the
  // 100000 declared: the connection is dropped at the deadline, not held for the 30-minute backstop.
  for (const path of ['/shows', '/media', '/nope']) {
    const refused = await trickle(port, head(path, { 'content-type': 'application/json', 'content-length': 100000 }));
    assert.match(refused.status, / 40[14] /, path);
    assert.ok(refused.closedMs !== undefined && refused.closedMs < 1500, `${path}: closed after ${refused.closedMs} ms`);
  }

  // Signed in: 12 pieces 100 ms apart, four times the deadline for a body nobody reads and twice
  // the 600 ms of silence an upload is allowed, never silent that long.
  const pieces = Array(12).fill(Buffer.alloc(1000, 1));
  assert.deepEqual(await upload(port, '/media', pieces, 100), { status: 201, body: '{"size":12000}' }, 'a streamed upload');
  assert.deepEqual(await upload(port, '/package', pieces, 100), { status: 201, body: '{"size":12000}' }, 'a raw one');
});

test('a raw upload that goes silent gets its 408 at the limit for silence, not after the time its size limit would take', async (t) => {
  // 10 MiB at 64 KiB/s would be 160 s; 600 ms with nothing arriving is the limit here. The server's
  // deadline for a body nobody reads (300 ms) has stood down: readBytes answers for it.
  const port = await serve(t, {
    bodyMs: 300,
    api: { uploadIdleMs: 600 },
    defs: [{ method: 'POST', path: '/package', body: { raw: true, limit: 10 * 1024 * 1024 }, run: ({ body }) => ({ size: body.length }) }],
  });
  const silent = await trickle(port, head('/package', { 'x-who': 'deck', 'content-type': 'application/octet-stream', 'content-length': 1000 }), { piece: 'x'.repeat(100), count: 1 });
  assert.equal(silent.status, 'HTTP/1.1 408 Request Timeout');
  assert.ok(silent.closedMs !== undefined && silent.closedMs < 2000, `closed after ${silent.closedMs} ms`);
});

test('readBytes allows the time its limit takes at its rate (a slow link gets through), and no longer', async (t) => {
  const reader = (limit) => async ({ req, res }) => {
    try {
      const bytes = await readBytes(req, limit, { ms: 100, rate: 10_000, idleMs: 5000 });
      sendJson(res, 200, { size: bytes.length });
    } catch (err) {
      sendProblem(res, err.status, 'Refused', err.message, { headers: err.headers });
    }
  };
  const port = await serve(t, {
    routes: [{ method: 'POST', path: '/small', handler: reader(3000) }, { method: 'POST', path: '/large', handler: reader(30_000) }],
  });
  // 3000 bytes at 2 kB/s take 1.5 s. Under a 3000-byte limit (300 ms at 10 kB/s) that's a 408 at
  // about 300 ms; under a 30 kB limit (3 s) the same steady trickle is accepted (07 §7.11).
  const slow = await trickle(port, head('/small', { 'content-length': 3000 }), { piece: 'x'.repeat(100), gapMs: 50, count: 30 });
  assert.equal(slow.status, 'HTTP/1.1 408 Request Timeout');
  assert.ok(slow.closedMs !== undefined && slow.closedMs < 1200, `closed after ${slow.closedMs} ms`);
  const steady = await trickle(port, head('/large', { 'content-length': 3000 }), { piece: 'x'.repeat(100), gapMs: 50, count: 30 });
  assert.equal(steady.status, 'HTTP/1.1 200 OK');
  const brisk = await fetch(`http://127.0.0.1:${port}/small`, { method: 'POST', body: 'x'.repeat(3000) });
  assert.deepEqual([brisk.status, await brisk.json()], [200, { size: 3000 }]);
});
