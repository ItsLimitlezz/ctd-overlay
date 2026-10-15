// An upload over the size cap through the real HTTP server (POST /api/v1/media, 07 §7.11): a 413
// the admin UI can show, then the connection closes; nothing is kept.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startPlatform } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { auditOf, defer, memoryLogger, signedIn, tempDir } from './helpers.js';

const CAP = 64 * 1024; // the library's limits option, lowered from 600 MiB
const NO_FFMPEG = [path.join(fileURLToPath(new URL('.', import.meta.url)), 'no-such-ffmpeg-here')];
// A PNG's first bytes, padded to `size`.
const png = (size) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(size - 8, 7)]);

async function platformWith(t) {
  const root = tempDir(t);
  const config = loadConfig({ argv: ['--port', '0'], env: { SKP_DATA_DIR: path.join(root, 'data'), SKP_CONFIG_DIR: path.join(root, 'config') } });
  const { log } = memoryLogger();
  const platform = await startPlatform(config, { log, ffmpeg: NO_FFMPEG, media: { limits: { fileBytes: CAP }, lowerPriority: false } });
  defer(t, () => platform.stop());
  return { platform, config, mediaDir: path.join(config.dataDir, 'media') };
}

// The head of an upload: with a declared Content-Length, or chunked.
const head = (platform, declare) => `POST /api/v1/media?name=big.png HTTP/1.1\r\nHost: 127.0.0.1:${platform.port}\r\nAuthorization: ${signedIn(platform).authorization}\r\nContent-Type: application/octet-stream\r\n${declare ? `Content-Length: ${declare}` : 'Transfer-Encoding: chunked'}\r\n\r\n`;
const chunk = (piece) => Buffer.concat([Buffer.from(`${piece.length.toString(16)}\r\n`), piece, Buffer.from('\r\n')]);

async function until(check, ms = 5000) {
  for (const t0 = Date.now(); !check();) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
}

// POSTs an upload over a raw connection: `declare` sends a Content-Length and only `send` bytes of
// it; without it the body is chunked, `send` bytes of it, and never ended (the client is still
// sending when the answer comes). It stops sending once the answer starts. Resolves with the
// answer, how much was sent, and whether the server closed the connection after it (within 5 s).
function upload(platform, { declare, send }) {
  return new Promise((resolve) => {
    const socket = net.connect(platform.port, '127.0.0.1');
    const received = [];
    let sent = 0;
    let answered = false;
    let error;
    let done = false;
    const timer = setTimeout(() => finish(false), 5000);
    const finish = (closed) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      const text = Buffer.concat(received).toString('latin1');
      const split = text.indexOf('\r\n\r\n');
      const [status, ...lines] = text.slice(0, split).split('\r\n');
      const headers = Object.fromEntries(lines.map((l) => [l.slice(0, l.indexOf(':')).toLowerCase(), l.slice(l.indexOf(':') + 1).trim()]));
      let body = text.slice(split + 4);
      if (headers['transfer-encoding'] === 'chunked') {
        let out = '';
        for (let at = 0; ;) {
          const eol = body.indexOf('\r\n', at);
          const n = parseInt(body.slice(at, eol), 16);
          if (!n) break;
          out += body.slice(eol + 2, eol + 2 + n);
          at = eol + 2 + n + 2;
        }
        body = out;
      }
      resolve({ status, headers, body: Buffer.from(body, 'latin1').toString('utf8'), sent, closed, error });
    };
    socket.on('data', (d) => { answered = true; received.push(d); });
    socket.on('error', (err) => { error = err.code; }); // a reset after the answer still closes it
    socket.on('close', () => finish(true));
    socket.on('connect', async () => {
      socket.write(head(platform, declare));
      const file = png(Math.max(send, 8));
      for (let at = 0; at < send && !answered && !socket.destroyed; at += 16 * 1024) {
        const piece = file.subarray(at, Math.min(send, at + 16 * 1024));
        const more = socket.write(declare ? piece : chunk(piece));
        sent += piece.length;
        if (!more) await new Promise((r) => { socket.once('drain', r); socket.once('close', r); });
      }
    });
  });
}

// The refusal the admin UI shows: 413, a problem of type too-large naming the limit, and the
// connection closed after it.
function assertRefused(answer, what) {
  assert.equal(answer.status, 'HTTP/1.1 413 Payload Too Large', what);
  assert.equal(answer.headers['content-type'], 'application/problem+json', what);
  assert.equal(answer.headers.connection, 'close', what);
  const problem = JSON.parse(answer.body);
  assert.equal(problem.type, 'https://skp.dev/errors/too-large', what);
  assert.equal(problem.status, 413, what);
  assert.equal(problem.instance, '/api/v1/media', what);
  assert.equal(problem.detail, 'The file is larger than 64 KiB, the most an upload can be.', what);
  assert.equal(answer.closed, true, `${what}: the server closes the connection after the answer`);
}

test('an upload sent past the cap gets a 413 naming the limit, then the connection closes; nothing is kept', async (t) => {
  const { platform, config, mediaDir } = await platformWith(t);
  // The body never ends: an answer at all means the server stopped reading at the cap.
  const answer = await upload(platform, { send: 4 * CAP });
  assertRefused(answer, 'chunked, past the cap');
  assert.ok(answer.sent > CAP);
  // Nothing on disk (no staging file either), nothing in the store.
  assert.deepEqual(existsSync(mediaDir) ? readdirSync(mediaDir) : [], []);
  assert.deepEqual(platform.media.list(), []);
  // The platform still takes an upload, exactly at the cap.
  const ok = await fetch(`${platform.url}/api/v1/media?name=exact.png`, { method: 'POST', headers: signedIn(platform, { 'content-type': 'image/png' }), body: png(CAP) });
  assert.equal(ok.status, 201);
  assert.equal((await ok.json()).size, CAP);
  assert.equal(platform.media.list().length, 1);
  await platform.stop();
  assert.deepEqual(auditOf(config).filter((o) => o.action === 'media.add').length, 1, 'only the upload kept is in the audit log');
});

test('a declared Content-Length over the cap is refused before the body is read', async (t) => {
  const { platform, mediaDir } = await platformWith(t);
  // Not a byte of the body sent: the answer can't have waited for it.
  const nothing = await upload(platform, { declare: CAP + 1, send: 0 });
  assertRefused(nothing, 'declared, nothing sent');
  // A little of a large one sent: still refused at once, never read to the end.
  const some = await upload(platform, { declare: 600 * CAP, send: 1000 });
  assertRefused(some, 'declared, 1000 bytes sent');
  assert.deepEqual(existsSync(mediaDir) ? readdirSync(mediaDir) : [], []);
  assert.deepEqual(platform.media.list(), []);
  // Exactly the cap, declared, is taken.
  const ok = await fetch(`${platform.url}/api/v1/media?name=exact.png`, { method: 'POST', headers: signedIn(platform), body: png(CAP) });
  assert.equal(ok.status, 201);
});

test('a client gone mid-upload still interrupts it: the partial file is removed and nothing kept', async (t) => {
  const { platform, mediaDir } = await platformWith(t);
  const socket = net.connect(platform.port, '127.0.0.1');
  socket.on('error', () => {});
  await new Promise((r) => socket.once('connect', r));
  socket.write(head(platform));
  socket.write(chunk(png(CAP / 2)));
  await until(() => readdirSync(mediaDir).some((n) => n.startsWith('.incoming-')));
  socket.destroy();
  await until(() => readdirSync(mediaDir).length === 0);
  assert.deepEqual(platform.media.list(), []);
});
