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
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBody, sendJson, sendProblem } from '../http/server.js';
import { attrNames, scanTags } from '../templates/html.js';
import { pickCanvas } from '../templates/registry.js';
import { createSseWriter } from './sse.js';

const SDK_FILE = fileURLToPath(new URL('../sdk/sk.js', import.meta.url));
const MOCK_FILE = fileURLToPath(new URL('../sdk/mock.js', import.meta.url));
const HEARTBEAT_MS = 15000; // at least every 15 s (01 §1.5)

// Over HTTP/1.1 a browser keeps at most six connections per host, shared by every page in its
// profile (OBS's browser sources included), and each live stream holds one for good. With six
// streams open, a seventh overlay can't even load its page. So one browser gets at most four
// streams; further overlays are told to poll, which leaves two connections for page loads,
// snapshots and polls (01 §1.5). A browser is its address plus its User-Agent.
const MAX_STREAMS_PER_CLIENT = 4;
const USE_POLLING = 'https://skp.dev/errors/use-polling';

// SK.log (04 §4.4): template messages forwarded to the platform log, rate-limited per overlay,
// because a template stuck in a loop must not flood the log or the disk. The body limit leaves
// room for a full batch with its contexts; each context is cut down here.
const LOG_BODY_LIMIT = 64 * 1024;
const LOG_BATCH = 20; // entries used from one request, as many as the SDK sends at once
const LOG_PER_MINUTE = 30;
const LOG_CONTEXT_CHARS = 2000;
const LOG_DROPS_EVERY_MS = 60000; // the dropped-entries summary, at most once a minute
const LOG_LEVELS = new Set(['info', 'warn', 'error']);
const LOG_SHAPE = 'Send JSON: { "entries": [{ "level": "warn", "msg": "…" }] }';

const OVERLAY_HEADERS = {
  'access-control-allow-origin': '*', // lets the sandboxed admin preview fetch (04 §4.8)
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
};

const IMMUTABLE = 'public, max-age=31536000, immutable';
const FILE_CSP = "sandbox; default-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; media-src 'self'";

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav',
};

export function overlayRoutes({ overlays, log, heartbeatMs = HEARTBEAT_MS, maxStreamsPerClient = MAX_STREAMS_PER_CLIENT }) {
  // The SDK's content hash goes on its <script> URL, a second guard against OBS's sticky cache
  // beside no-store (H14).
  const sdkVersion = createHash('sha256').update(readFileSync(SDK_FILE)).digest('hex').slice(0, 12);
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
    const { id, width, height } = pickCanvas(manifest, url.searchParams.get('canvas'));
    const meta = {
      standard: 'skp/1',
      slug: params.slug,
      build,
      template: { id: manifest.id, version: manifest.version },
      canvas: { id, width, height },
      canvases: manifest.canvases,
      scenes: manifest.scenes || [],
      actions: manifest.actions || [],
      alerts: manifest.alerts || {},
      transitions: manifest.transitions || [],
      consumes: { state: manifest.consumes?.state || [], events: manifest.consumes?.events || [], chat: manifest.consumes?.chat || null },
      // The resolved settings (what overlay.settings carries), for ?mock=1, which never fetches the
      // snapshot (04 §4.9, 08 §8.5).
      settings: o.settings,
    };
    res.writeHead(200, {
      ...OVERLAY_HEADERS,
      'content-type': 'text/html; charset=utf-8',
      'x-content-type-options': 'nosniff',
      'content-security-policy': overlayCsp(manifest),
    });
    o.template.prepared ??= prepareEntry(o.template.entry); // once per template version
    res.end(injectPrepared(o.template.prepared, params.slug, build, meta, sdkVersion));
  }

  // The build rides on every snapshot and poll, so a page whose template was upgraded reloads
  // itself and the URL in OBS never changes (01 §1.4).
  function snapshot({ res, params }) {
    const o = find(res, params.slug);
    if (o) sendJson(res, 200, { ...o.channel.snapshot(), build: o.template.build }, OVERLAY_HEADERS);
  }

  function poll({ res, params, url }) {
    const o = find(res, params.slug);
    if (!o) return;
    const result = o.channel.since(url.searchParams.get('cursor'));
    if (result.gone) return gone(res);
    sendJson(res, 200, { envelopes: result.envelopes, cursor: result.cursor, ts: Date.now(), build: o.template.build }, OVERLAY_HEADERS);
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
        { type: USE_POLLING, headers: { ...OVERLAY_HEADERS, 'retry-after': '60', 'access-control-expose-headers': 'Retry-After' } });
    }
    streamsByClient.set(client, open + 1);

    res.writeHead(200, {
      ...OVERLAY_HEADERS,
      'content-type': 'text/event-stream; charset=utf-8',
      'x-content-type-options': 'nosniff',
      'x-accel-buffering': 'no', // no buffering in nginx-style proxies
    });
    // Sends the headers now, so the client knows the stream opened. Comments carry server time
    // (the client keeps its clock estimate fresh, 01 §1.6) and the overlay's current build, so a
    // page whose template was upgraded reloads even if its stream outlived the upgrade.
    res.write(`: open ${Date.now()} ${o.template.build}\n\n`);

    const writer = createSseWriter(res);
    for (const env of backlog.envelopes) writer.send(env);
    const unsubscribe = o.channel.subscribe((env) => writer.send(env), () => res.end());
    const heartbeat = setInterval(() => {
      const build = overlays.currentBuild(params.slug);
      writer.comment(build ? `hb ${Date.now()} ${build}` : `hb ${Date.now()}`);
    }, heartbeatMs);

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

  // Only files the registry listed for this build, matched exactly: no stat of arbitrary paths, no
  // links followed, and the same answer on case-insensitive disks (Windows, macOS) as on Linux.
  async function file({ res, params }) {
    const o = overlays.resolve(params.slug);
    const rel = params['*'];
    if (!o?.template || params.build !== o.template.build || !o.template.files.has(rel)) return notFound(res);
    const full = path.join(o.template.dir, ...rel.split('/'));
    if (!full.startsWith(o.template.dir + path.sep)) return notFound(res);
    let data;
    try {
      data = await readFile(full);
    } catch {
      return notFound(res);
    }
    res.writeHead(200, {
      ...OVERLAY_HEADERS,
      'cache-control': IMMUTABLE,
      'content-type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
      'x-content-type-options': 'nosniff',
      // A template's files are third-party content on the platform's origin. Loaded by the page they
      // are subresources and this changes nothing; opened directly, an .html or .svg among them
      // runs sandboxed, with no script and no origin (07 §7.1).
      'content-security-policy': FILE_CSP,
    });
    res.end(data);
  }

  const script = (file) => async ({ res }) => {
    const code = await readFile(file);
    res.writeHead(200, {
      ...OVERLAY_HEADERS,
      'content-type': 'text/javascript; charset=utf-8',
      'x-content-type-options': 'nosniff',
    });
    res.end(code);
  };

  // SK.log's POST is CORS-simple (a string body, no preflight), so it is delivered from any page
  // whatever the answer says. The answers still carry Access-Control-Allow-Origin, beyond the GETs
  // of 07 §7.10: without it the sandboxed preview logs a CORS error to its console on every flush.
  // Allowing it exposes nothing: the answer is a bare 204, or a problem about the request itself.
  const templateLog = log.child('template');
  const buckets = new Map(); // slug → { tokens, at, template, dropped, reportedAt, timer }
  async function logEntry({ req, res, params }) {
    const o = find(res, params.slug);
    if (!o) return;
    let body;
    try {
      body = JSON.parse(await readBody(req, LOG_BODY_LIMIT));
    } catch (err) {
      return sendProblem(res, err.status || 400, 'Bad log entry', err.status ? err.message : LOG_SHAPE,
        { headers: { ...OVERLAY_HEADERS, ...err.headers } });
    }
    const entries = logEntries(body);
    if (!entries) return sendProblem(res, 400, 'Bad log entry', LOG_SHAPE, { headers: OVERLAY_HEADERS });

    const now = Date.now();
    sweepBuckets(now);
    const bucket = buckets.get(params.slug) || { tokens: LOG_PER_MINUTE, at: now, dropped: 0, reportedAt: -Infinity, timer: null };
    bucket.tokens = refilled(bucket, now);
    bucket.at = now;
    bucket.template = `${o.template.id}@${o.template.version}`;
    buckets.set(params.slug, bucket);
    for (const e of entries) {
      if (bucket.tokens < 1) { bucket.dropped++; continue; }
      bucket.tokens--;
      const level = LOG_LEVELS.has(e.level) ? e.level : 'warn';
      templateLog[level](e.msg.slice(0, 500), { overlay: params.slug, template: bucket.template, context: clipContext(e.context) });
    }
    reportDrops(params.slug, bucket, now);
    res.writeHead(204, OVERLAY_HEADERS);
    res.end();
  }

  // The dropped-entries summary costs no token. It's written at the first drop, then at most once
  // a minute while drops go on; a timer writes what's left when that minute ends, so the drops at
  // the tail of a flood are reported too. A last report in the future means the clock stepped
  // back: report now rather than wait for the clock to catch up.
  function reportDrops(slug, bucket, now) {
    if (!bucket.dropped || bucket.timer) return;
    const wait = bucket.reportedAt + LOG_DROPS_EVERY_MS - now;
    if (wait > 0 && wait <= LOG_DROPS_EVERY_MS) {
      bucket.timer = setTimeout(() => writeDrops(slug, bucket), wait);
      bucket.timer.unref();
    } else {
      writeDrops(slug, bucket);
    }
  }

  function writeDrops(slug, bucket) {
    clearTimeout(bucket.timer);
    bucket.timer = null;
    templateLog.warn('template log entries were dropped by the rate limit', { overlay: slug, template: bucket.template, dropped: bucket.dropped });
    bucket.dropped = 0;
    bucket.reportedAt = Date.now();
  }

  // Forgets buckets that are full again and owe no summary (dropped entries always have a timer
  // waiting), so the map holds only overlays that logged in about the last minute, and a deleted
  // overlay's bucket doesn't stay forever.
  function sweepBuckets(now) {
    for (const [slug, b] of buckets) {
      if (!b.timer && refilled(b, now) >= LOG_PER_MINUTE && now - b.reportedAt >= LOG_DROPS_EVERY_MS) buckets.delete(slug);
    }
  }

  // At shutdown, drops still waiting for their minute are reported at once.
  function closeLog() {
    for (const [slug, b] of buckets) if (b.timer) writeDrops(slug, b);
    buckets.clear();
  }

  return [
    { method: 'GET', path: '/o/:slug', handler: page },
    { method: 'GET', path: '/o/:slug/snapshot', handler: snapshot },
    { method: 'GET', path: '/o/:slug/poll', handler: poll },
    { method: 'GET', path: '/o/:slug/stream', handler: stream },
    { method: 'GET', path: '/o/:slug/t/:build/*', handler: file },
    { method: 'POST', path: '/o/:slug/log', handler: logEntry, close: closeLog },
    { method: 'GET', path: '/sdk/v1/sk.js', handler: script(SDK_FILE) },
    { method: 'GET', path: '/sdk/v1/mock.js', handler: script(MOCK_FILE) },
  ];
}

function gone(res) {
  sendProblem(res, 410, 'Cursor expired', 'This position in the stream is no longer kept. Fetch the snapshot again and continue from its cursor.', { headers: OVERLAY_HEADERS });
}

function notFound(res) {
  sendProblem(res, 404, 'Not found', 'No such template file.', { headers: OVERLAY_HEADERS });
}

// What SK.log sends: { "entries": [{ "level", "msg", "context"? }, …] } (04 §4.4). Only the first
// LOG_BATCH entries are used; null when the body isn't that shape.
function logEntries(body) {
  if (!isObject(body) || !Array.isArray(body.entries)) return null;
  const entries = body.entries.slice(0, LOG_BATCH);
  return entries.every((e) => isObject(e) && typeof e.msg === 'string') ? entries : null;
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// A bucket's tokens after refilling for the time since its last request. Math.max: a clock that
// stepped back refills nothing, instead of draining the bucket below zero.
function refilled(bucket, now) {
  return Math.min(LOG_PER_MINUTE, bucket.tokens + (Math.max(0, now - bucket.at) / 60000) * LOG_PER_MINUTE);
}

// A template's context, cut to LOG_CONTEXT_CHARS of JSON so one entry can't fill the log.
function clipContext(context) {
  if (context === undefined) return undefined;
  const text = JSON.stringify(context);
  return text.length > LOG_CONTEXT_CHARS ? { truncated: text.slice(0, LOG_CONTEXT_CHARS) } : context;
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

// A small corner badge with no script: invisible, revealed by a CSS delay unless the SDK removes
// it as soon as it runs. If the runtime never starts in OBS (a 404, a CSP block, syntax OBS's
// browser doesn't know), this is the only thing that can say so (v0's error ladder, under a CSP
// that forbids inline script). The SDK marks <html> with data-skp-canvas the moment it runs, which
// hides the badge even if the document is slow to finish parsing.
export const BOOT_BADGE =
  '<style>@keyframes skp-boot{to{opacity:1}}html[data-skp-canvas] [data-skp-boot]{display:none}</style>' +
  '<div data-skp-boot style="position:fixed;left:8px;bottom:8px;z-index:2147483647;max-width:60%;padding:4px 8px;' +
  'font:12px/1.4 ui-monospace,Consolas,monospace;color:#ff5a5a;background:rgba(0,0,0,.8);opacity:0;pointer-events:none;' +
  'animation:skp-boot 0s linear 8s forwards">SKP: the overlay runtime did not start. Open this URL with ?debug=1, ' +
  'or check the platform log.</div>';

// Inserts, as the first children of <head>: the <base> that points relative URLs at the pinned
// template's files, the runtime's settings as a <meta> (CSP forbids inline scripts), and the SDK
// script, so SK exists before any template script runs (04 §4.4–4.5). The boot badge goes first in
// <body>. Only real tags count: not text in comments, attribute values or a script's code.
//
// The SDK and the entry's own external scripts load with `crossorigin`. The admin preview frames
// the page in <iframe sandbox="allow-scripts">, an opaque origin, so there every script is a
// cross-origin load, and without CORS its errors reach window.onerror only as "Script error." and
// its rejections never fire unhandledrejection (04 §4.8). Every /sdk/ and /o/<slug>/t/ response,
// errors included, allows any origin. In OBS the page is same-origin and nothing changes.
export function injectRuntime(entry, slug, build, meta, sdkVersion = '') {
  return injectPrepared(prepareEntry(entry), slug, build, meta, sdkVersion);
}

// The part of injection that depends only on the entry document, done once per template version
// (the page route caches it): the crossorigin attributes, and where <head>, <html> and <body>
// end. Linear time, whatever the document (src/templates/html.js).
export function prepareEntry(entry) {
  const doc = withCrossorigin(entry);
  const tags = scanTags(doc);
  const end = (name) => tags.find((t) => t.name === name)?.end ?? -1;
  return { doc, head: end('head'), html: end('html'), body: end('body') };
}

function injectPrepared({ doc, head, html, body }, slug, build, meta, sdkVersion) {
  const tags =
    `<base href="/o/${slug}/t/${build}/">` +
    `<meta name="skp" content="${escapeAttr(JSON.stringify(meta))}">` +
    `<script crossorigin src="/sdk/v1/sk.js${sdkVersion ? `?v=${sdkVersion}` : ''}"></script>`;
  // Where the runtime goes, and what it adds there.
  const [at, insert] = head >= 0 ? [head, tags] : html >= 0 ? [html, `<head>${tags}</head>`] : [0, `<!doctype html><html><head>${tags}</head>`];
  const out = doc.slice(0, at) + insert + doc.slice(at);
  if (body < 0) return out + BOOT_BADGE;
  const bodyEnd = body >= at ? body + insert.length : body;
  return out.slice(0, bodyEnd) + BOOT_BADGE + out.slice(bodyEnd);
}

// A bare `crossorigin` on each external <script src> that has no crossorigin attribute of its
// own (for a module script, which always loads with CORS, it changes nothing). Inline scripts,
// and anything that only looks like a script tag (scanTags), are left alone.
function withCrossorigin(html) {
  let out = '';
  let last = 0;
  for (const t of scanTags(html)) {
    if (t.name !== 'script') continue;
    const names = attrNames(t);
    if (!names.includes('src') || names.includes('crossorigin')) continue;
    const at = t.index + '<script'.length;
    out += html.slice(last, at) + ' crossorigin';
    last = at;
  }
  return out + html.slice(last);
}

function escapeAttr(s) {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
