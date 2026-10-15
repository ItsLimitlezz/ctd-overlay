// The admin UI's files (08): GET / is the app, GET /ui/<file> its scripts, styles and icons, from
// src/ui. App files are no-store (H14: a new version is never hidden by a cache). The UI uses the
// public API only (03), signed in like any other client.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sendProblem } from './server.js';

export const UI_DIR = fileURLToPath(new URL('../ui/', import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json' };

export function uiRoutes({ dir = UI_DIR } = {}) {
  async function serve(res, rel) {
    const full = path.join(dir, ...rel.split('/'));
    const type = TYPES[path.extname(full).toLowerCase()];
    // A backslash is a separator on Windows: "pages\.env" or "pages\..\x" would pass the checks of
    // "/"-separated parts. No UI file has one in its name, so any path with one is refused.
    if (!type || rel.includes('\\') || !full.startsWith(dir) || rel.split('/').some((s) => s === '..' || s.startsWith('.'))) {
      return sendProblem(res, 404, 'Not found', 'No such file.');
    }
    let data;
    try { data = await readFile(full); } catch { return sendProblem(res, 404, 'Not found', 'No such file.'); }
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin' });
    res.end(data);
  }
  return [
    { method: 'GET', path: '/', handler: ({ res }) => serve(res, 'index.html') },
    { method: 'GET', path: '/ui/*', handler: ({ res, params }) => serve(res, params['*']) },
  ];
}
