// GET /media/<fileId>/<name> (03 §3.4): an uploaded file, for overlays (settings, lineups,
// media.play) and the admin UI. No key: the fileId is the secret (07 §7.6). Immutable: a file never
// changes at its URL (H14). Byte ranges, because a <video> seeks with them.
import { open } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { sendProblem } from '../http/server.js';

const HEADERS = {
  'access-control-allow-origin': '*', // fonts and media for the sandboxed (opaque-origin) previews
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'cache-control': 'public, max-age=31536000, immutable',
  // Opened directly, nothing in it runs and it has no origin on the platform's host (07 §7.1).
  'content-security-policy': "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'",
  'accept-ranges': 'bytes',
};

export function mediaRoutes({ media }) {
  // The file is opened before anything is sent, so its size and its bytes are one file's; a
  // client gone while it opened gets nothing, and the stream ends with the response either way
  // (an fd left open would leak, and on Windows keep the file from being removed).
  async function file({ req, res, params }) {
    const found = media.file(params.fileId, params.name);
    let handle;
    let size;
    try {
      if (found) {
        handle = await open(found.file, 'r');
        size = (await handle.stat()).size;
      }
    } catch {
      await handle?.close().catch(() => {});
      handle = undefined;
    }
    if (!handle) {
      return sendProblem(res, 404, 'Not found', 'There is no such media file. It may have been removed; upload it again.', { headers: { 'access-control-allow-origin': '*', 'referrer-policy': 'no-referrer' } });
    }
    if (res.destroyed || req.socket?.destroyed) {
      await handle.close().catch(() => {});
      return;
    }
    const range = parseRange(req.headers.range, size);
    if (range === 'invalid') {
      await handle.close().catch(() => {});
      // An answer about this request's Range, not the file: never cached.
      res.writeHead(416, {
        'access-control-allow-origin': '*', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff',
        'cache-control': 'no-store', 'content-range': `bytes */${size}`,
      });
      res.end();
      return;
    }
    const [start, end] = range || [0, size - 1];
    res.writeHead(range ? 206 : 200, {
      ...HEADERS,
      'content-type': found.doc.data.type,
      'content-length': end - start + 1,
      ...(range ? { 'content-range': `bytes ${start}-${end}/${size}` } : {}),
    });
    if (req.method === 'HEAD' || size === 0) {
      await handle.close().catch(() => {});
      res.end();
      return;
    }
    const stream = handle.createReadStream({ start, end, autoClose: true });
    await pipeline(stream, res).catch(() => {}); // a client that leaves mid-file is routine
  }

  return [{ method: 'GET', path: '/media/:fileId/:name', handler: file }];
}

// One "bytes=a-b" range: [start, end], 'invalid' (unsatisfiable, 416), or undefined (no range,
// or one this server answers in full: several ranges, another unit, a malformed header).
export function parseRange(header, size) {
  if (typeof header !== 'string') return undefined;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return undefined;
  let start;
  let end;
  if (m[1] === '') {
    // The last n bytes.
    const n = Number(m[2]);
    if (n === 0) return 'invalid';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
    if (start > end || start >= size) return 'invalid';
  }
  return [start, end];
}
