// What OBS browser sources talk to (01 §1.5, 03 §3.4):
//
//   GET /o/<slug>                  the overlay page: the template's entry document with the runtime injected
//   GET /o/<slug>/snapshot         full current state for this overlay + a cursor
//   GET /o/<slug>/stream           Server-Sent Events after the cursor
//   GET /o/<slug>/poll?cursor=     the fallback: everything after the cursor, as JSON
//   GET /o/<slug>/t/<build>/<file> the pinned template's files, immutable
//   GET /sdk/v1/sk.js              the runtime SDK
//
// Overlay keys arrive with step 12. Until then the server only listens on loopback, and the
// overlay endpoints need no key (07 §7.6 allows "no key required" in local mode).
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sendJson, sendProblem } from '../http/server.js';
import { pickCanvas } from '../templates/registry.js';
import { createSseWriter } from './sse.js';

const SDK_FILE = fileURLToPath(new URL('../sdk/sk.js', import.meta.url));
const HEARTBEAT_MS = 15000; // at least every 15 s (01 §1.5)

// Over HTTP/1.1 a browser keeps at most six connections per host, shared by every page in its
// profile (OBS's browser sources included), and each live stream holds one for good. With six
// streams open, a seventh overlay can't even load its page. So one browser gets at most four
// streams; further overlays are told to poll, which leaves two connections for page loads,
// snapshots and polls (01 §1.5). A browser is its address plus its User-Agent.
const MAX_STREAMS_PER_CLIENT = 4;
const USE_POLLING = 'https://skp.dev/errors/use-polling';

const OVERLAY_HEADERS = {
  'access-control-allow-origin': '*', // lets the sandboxed admin preview fetch (04 §4.8)
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
};

const IMMUTABLE = 'public, max-age=31536000, immutable';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav',
};

export function overlayRoutes({ overlays, log, heartbeatMs = HEARTBEAT_MS, maxStreamsPerClient = MAX_STREAMS_PER_CLIENT }) {
  const streamsByClient = new Map();
  const capped = new Set(); // clients we've told to poll, so the log says it once

  const find = (res, slug) => {
    const found = overlays.resolve(slug);
    if (!found) {
      sendProblem(res, 404, 'No such overlay', `No overlay has the slug "${slug}". Check the URL in the OBS browser source.`, { headers: OVERLAY_HEADERS });
      return undefined;
    }
    if (!found.template) {
      sendProblem(res, 503, 'Template not installed', `The template this overlay uses (${found.doc.data.template.id}@${found.doc.data.template.version}) isn't installed.`, { headers: OVERLAY_HEADERS });
      return undefined;
    }
    return found;
  };

  function page({ res, params, url }) {
    const o = find(res, params.slug);
    if (!o) return;
    const { manifest, build } = o.template;
    const canvas = pickCanvas(manifest, url.searchParams.get('canvas'));
    const meta = {
      standard: 'skp/1',
      slug: params.slug,
      build,
      canvas,
      canvases: manifest.canvases,
      scenes: manifest.scenes || [],
      actions: manifest.actions || [],
    };
    res.writeHead(200, {
      ...OVERLAY_HEADERS,
      'content-type': 'text/html; charset=utf-8',
      'x-content-type-options': 'nosniff',
      'content-security-policy': overlayCsp(manifest),
    });
    res.end(injectRuntime(o.template.entry, params.slug, build, meta));
  }

  function snapshot({ res, params }) {
    const o = find(res, params.slug);
    if (o) sendJson(res, 200, o.channel.snapshot(), OVERLAY_HEADERS);
  }

  function poll({ res, params, url }) {
    const o = find(res, params.slug);
    if (!o) return;
    const result = o.channel.since(url.searchParams.get('cursor'));
    if (result.gone) return gone(res);
    sendJson(res, 200, { envelopes: result.envelopes, cursor: result.cursor, ts: Date.now() }, OVERLAY_HEADERS);
  }

  function stream({ req, res, params, url }) {
    const o = find(res, params.slug);
    if (!o) return;
    const cursor = req.headers['last-event-id'] || url.searchParams.get('cursor');
    const backlog = o.channel.since(cursor);
    if (backlog.gone) return gone(res);

    const client = `${req.socket.remoteAddress}|${req.headers['user-agent'] || ''}`;
    const open = streamsByClient.get(client) || 0;
    if (open >= maxStreamsPerClient) {
      if (!capped.has(client)) {
        capped.add(client);
        log.info('a browser reached the live-stream limit; its further overlays poll instead', { address: req.socket.remoteAddress, streams: open });
      }
      return sendProblem(res, 429, 'Use polling',
        `This browser already holds ${open} live streams to this server. Over plain HTTP a browser keeps at most six connections per host, so further overlays poll instead (01 §1.5).`,
        { type: USE_POLLING, headers: { ...OVERLAY_HEADERS, 'retry-after': '60' } });
    }
    streamsByClient.set(client, open + 1);

    res.writeHead(200, {
      ...OVERLAY_HEADERS,
      'content-type': 'text/event-stream; charset=utf-8',
      'x-content-type-options': 'nosniff',
      'x-accel-buffering': 'no', // no buffering in nginx-style proxies
    });
    res.write(': open\n\n'); // sends the headers now, so the client knows the stream opened

    const writer = createSseWriter(res);
    for (const env of backlog.envelopes) writer.send(env);
    const unsubscribe = o.channel.subscribe((env) => writer.send(env), () => res.end());
    const heartbeat = setInterval(() => writer.comment('hb'), heartbeatMs);

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      clearInterval(heartbeat);
      unsubscribe();
      writer.close();
      const n = (streamsByClient.get(client) || 1) - 1;
      if (n > 0) streamsByClient.set(client, n);
      else streamsByClient.delete(client);
      capped.delete(client);
    };
    req.on('close', cleanup);
    res.on('close', cleanup);
  }

  async function file({ res, params }) {
    const o = overlays.resolve(params.slug);
    const rel = params['*'];
    const parts = rel.split('/');
    const bad = !o?.template || params.build !== o.template.build ||
      parts.some((p) => !p || p === '.' || p === '..' || /[\\:\0]/.test(p));
    const full = bad ? null : path.join(o.template.dir, ...parts);
    if (!full || !full.startsWith(o.template.dir + path.sep)) return notFound(res);
    let data;
    try {
      if (!(await stat(full)).isFile()) return notFound(res);
      data = await readFile(full);
    } catch {
      return notFound(res);
    }
    res.writeHead(200, {
      ...OVERLAY_HEADERS,
      'cache-control': IMMUTABLE,
      'content-type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
      'x-content-type-options': 'nosniff',
    });
    res.end(data);
  }

  async function sdk({ res }) {
    const code = await readFile(SDK_FILE);
    res.writeHead(200, {
      ...OVERLAY_HEADERS,
      'content-type': 'text/javascript; charset=utf-8',
      'x-content-type-options': 'nosniff',
    });
    res.end(code);
  }

  return [
    { method: 'GET', path: '/o/:slug', handler: page },
    { method: 'GET', path: '/o/:slug/snapshot', handler: snapshot },
    { method: 'GET', path: '/o/:slug/poll', handler: poll },
    { method: 'GET', path: '/o/:slug/stream', handler: stream },
    { method: 'GET', path: '/o/:slug/t/:build/*', handler: file },
    { method: 'GET', path: '/sdk/v1/sk.js', handler: sdk },
  ];
}

function gone(res) {
  sendProblem(res, 410, 'Cursor expired', 'This position in the stream is no longer kept. Fetch the snapshot again and continue from its cursor.', { headers: OVERLAY_HEADERS });
}

function notFound(res) {
  sendProblem(res, 404, 'Not found', 'No such template file.', { headers: OVERLAY_HEADERS });
}

// 04 §4.8, with base-uri 'self' for the inserted <base> (04 §4.5). Font hosts beyond Google Fonts
// are allowed only when the manifest lists them in `fonts`.
export function overlayCsp(manifest = {}) {
  const extra = new Set();
  for (const url of manifest.fonts || []) {
    try {
      const { origin, protocol } = new URL(url);
      if (protocol === 'https:' && origin !== 'https://fonts.googleapis.com' && origin !== 'https://fonts.gstatic.com') extra.add(origin);
    } catch { /* the validator (step 6) reports bad URLs */ }
  }
  const more = [...extra].map((o) => ` ${o}`).join('');
  return [
    "default-src 'none'",
    "script-src 'self'",
    `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com${more}`,
    `font-src 'self' https://fonts.gstatic.com data:${more}`,
    "img-src 'self' data: https:",
    "media-src 'self' blob:",
    "connect-src 'self'",
    "frame-ancestors 'self'",
    "base-uri 'self'",
    "form-action 'none'",
  ].join('; ');
}

// Inserts, as the first children of <head>: the <base> that points relative URLs at the pinned
// template's files, the runtime's settings as a <meta> (CSP forbids inline scripts), and the SDK
// script, so SK exists before any template script runs (04 §4.4–4.5).
export function injectRuntime(entry, slug, build, meta) {
  const tags =
    `<base href="/o/${slug}/t/${build}/">` +
    `<meta name="skp" content="${escapeAttr(JSON.stringify(meta))}">` +
    '<script src="/sdk/v1/sk.js"></script>';
  const head = /<head(\s[^>]*)?>/i.exec(entry);
  if (head) return entry.slice(0, head.index + head[0].length) + tags + entry.slice(head.index + head[0].length);
  const html = /<html(\s[^>]*)?>/i.exec(entry);
  if (html) return entry.slice(0, html.index + html[0].length) + `<head>${tags}</head>` + entry.slice(html.index + html[0].length);
  return `<!doctype html><html><head>${tags}</head>${entry}`;
}

function escapeAttr(s) {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
