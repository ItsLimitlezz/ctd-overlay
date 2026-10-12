// GET /media/<fileId>/<name> (03 §3.4): an uploaded file, for overlays (settings, lineups,
// media.play) and the admin UI. No key: the fileId is the secret (07 §7.6). Immutable: a file never
// changes at its URL (H14). Byte ranges, because a <video> seeks with them.
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
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
  async function file({ req, res, params }) {
    const found = media.file(params.fileId, params.name);
    let size;
    try {
      if (found) size = (await stat(found.file)).size;
    } catch { /* removed meanwhile */ }
    if (size === undefined) {
      return sendProblem(res, 404, 'Not found', 'There is no such media file. It may have been removed; upload it again.', { headers: { 'access-control-allow-origin': '*', 'referrer-policy': 'no-referrer' } });
    }
    const headers = { ...HEADERS, 'content-type': found.doc.data.type };
    const range = parseRange(req.headers.range, size);
    if (range === 'invalid') {
      res.writeHead(416, { ...headers, 'content-range': `bytes */${size}` });
      res.end();
      return;
    }
    const [start, end] = range || [0, size - 1];
    res.writeHead(range ? 206 : 200, {
      ...headers,
      'content-length': end - start + 1,
      ...(range ? { 'content-range': `bytes ${start}-${end}/${size}` } : {}),
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    const stream = createReadStream(found.file, { start, end });
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
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
