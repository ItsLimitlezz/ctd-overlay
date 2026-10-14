// The HTTP server. Nothing a client sends may take the process down (H11, 01 §1.7): malformed
// URLs get 400, a handler that throws or rejects gets 500, and the error goes to the log and
// crash.log. Responses never carry stack traces (03 §3.2).
import http from 'node:http';
import https from 'node:https';
import { clientOf, normalizeIp } from '../net.js';

// On every answer the platform writes, the API's included (03 §3.4, 07 §7.10).
export const BASE_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
  'cache-control': 'no-store',
};
// The admin UI and the API (07 §7.10), set before any route runs, so an answer a route writes
// itself (a preview image) has them too; overlay pages, template files, media and the SDK set
// their own (04 §4.8).
const ADMIN_HEADERS = {
  'content-security-policy': "default-src 'self'; frame-ancestors 'none'; object-src 'none'; frame-src 'self'",
  'cross-origin-opener-policy': 'same-origin',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
};
const HSTS = 'max-age=31536000';
const overlayFacing = (rawUrl) => /^\/(o|sdk|media)\//.test(rawUrl || '');

// Routes: { method, path: '/a/:param/b', handler({ req, res, params, url }), close() }. A final `*`
// segment matches one or more remaining segments, joined with "/" in params['*']. The optional
// close() runs once the server has closed, for timers a handler keeps.
export function createRouter(routes) {
  const compiled = routes.map((r) => ({ ...r, parts: r.path.split('/').slice(1) }));
  return {
    match(method, segments) {
      const allow = new Set();
      for (const route of compiled) {
        const params = matchParts(route.parts, segments);
        if (!params) continue;
        allow.add(route.method);
        if (route.method === method) return { route, params };
      }
      if (!allow.size) return { status: 404 };
      if (allow.has('GET')) allow.add('HEAD');
      return { status: 405, allow: [...allow] };
    },
  };
}

function matchParts(parts, segments) {
  const rest = parts[parts.length - 1] === '*';
  if (rest ? segments.length < parts.length : parts.length !== segments.length) return null;
  const params = {};
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (rest && i === parts.length - 1) {
      params['*'] = segments.slice(i).join('/');
    } else if (part.startsWith(':')) {
      if (!segments[i]) return null;
      params[part.slice(1)] = segments[i];
    } else if (part !== segments[i]) {
      return null;
    }
  }
  return params;
}

export function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, { ...BASE_HEADERS, 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(body));
}

export function sendText(res, status, text, headers = {}) {
  res.writeHead(status, { ...BASE_HEADERS, 'content-type': 'text/plain; charset=utf-8', ...headers });
  res.end(text);
}

// RFC 9457 problem details. `detail` is shown to operators verbatim, so it says what happened
// and what to do (03 §3.2).
export function sendProblem(res, status, title, detail, { type = 'about:blank', headers = {} } = {}) {
  res.writeHead(status, { ...BASE_HEADERS, 'content-type': 'application/problem+json', ...headers });
  // instance: the path asked for, never its query (an overlay key rides there).
  const instance = res.req?.url ? String(res.req.url).split('?')[0] : undefined;
  res.end(JSON.stringify({ type, title, status, detail, ...(instance ? { instance } : {}) }));
}

// GET /healthz: 200 "ok", no version or detail, no authentication (10 §10.3).
const healthz = ({ res }) => sendText(res, 200, 'ok');

// Browsers (OBS's included) ask every page's host for /favicon.ico; answer quietly instead of
// filling logs with 404s.
const favicon = ({ res }) => {
  res.writeHead(204, { ...BASE_HEADERS, 'cache-control': 'public, max-age=86400' });
  res.end();
};

// tls: { cert, key } (PEM) to serve HTTPS. trustProxy: the addresses whose X-Forwarded-* are
// believed (net.js clientOf, set on each request as req.client). admit(req): a problem
// { status, title, detail } for a client this platform doesn't serve (lan and public modes), or
// nothing. bodyMs: how long a body nobody reads may take to arrive (tests shorten it).
export function createHttpServer({ log, crash, routes = [], tls, trustProxy = [], admit, bodyMs = BODY_MS }) {
  const served = [
    { method: 'GET', path: '/healthz', handler: healthz },
    { method: 'GET', path: '/favicon.ico', handler: favicon },
    ...routes,
  ];
  const router = createRouter(served);
  let warnedUnnamed = false;

  const onRequest = (req, res) => {
    // A body nobody reads (the request was refused before it: 401, 403, 404, 405, 429 …) must
    // still arrive within bodyMs, or the connection is dropped: requestTimeout is the 30-minute
    // backstop an upload needs, and a refused request trickling its body would hold its socket
    // that long. A reader with a deadline of its own takes over (claimBody).
    const deadline = setTimeout(() => { if (!req.complete) req.socket?.destroy(); }, bodyMs);
    deadline.unref?.();
    bodyDeadlines.set(req, deadline);
    req.once('close', () => clearTimeout(deadline));
    req.client = clientOf(req, trustProxy);
    // A trusted proxy that forwards without naming the client makes everyone "unknown": refused in
    // lan mode and at setup, one throttle for all. Say why once, so the proxy gets fixed.
    if (req.client.unnamed && !warnedUnnamed) {
      warnedUnnamed = true;
      log?.warn('a trusted proxy forwarded a request without X-Forwarded-For: its clients count as unknown (refused in lan mode and at setup) until it sends X-Forwarded-For (07 §7.8)', { proxy: normalizeIp(req.socket?.remoteAddress) });
    }
    if (req.client.https) res.setHeader('strict-transport-security', HSTS);
    if (!overlayFacing(req.url)) for (const [k, v] of Object.entries(ADMIN_HEADERS)) res.setHeader(k, v);
    const refused = admit?.(req);
    if (refused) {
      if (req.url !== '/healthz') {
        sendProblem(res, refused.status, refused.title, refused.detail, { headers: corsFor(req.url) });
        return;
      }
    }
    handle(req, res, router).catch((err) => fail(err, req, res));
  };
  const server = tls ? https.createServer({ cert: tls.cert, key: tls.key }, onRequest) : http.createServer(onRequest);

  function fail(err, req, res) {
    log.error('request failed', { method: req.method, url: req.url, err });
    crash.record('request', err, { method: req.method, url: req.url });
    if (res.headersSent) {
      res.destroy();
      return;
    }
    try {
      sendProblem(res, 500, 'Something went wrong',
        'The server hit an unexpected error and logged it. Try again; if it keeps happening, look in crash.log in the data directory.',
        { headers: corsFor(req.url) });
    } catch {
      res.destroy();
    }
  }

  server.on('close', () => {
    for (const route of routes) {
      try { route.close?.(); } catch (err) { log.error('a route failed to close', { path: route.path, err }); }
    }
  });

  // Malformed HTTP (not even a parseable request line) from scanners and broken clients.
  server.on('clientError', (err, socket) => {
    if (err.code !== 'ECONNRESET' && socket.writable) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    } else {
      socket.destroy();
    }
  });

  server.keepAliveTimeout = 5000;
  // A slow client gets 30 s to send its headers. The whole request may take longer: Node's
  // requestTimeout can't be set per route, and an upload (600 MiB of media, a 100 MiB package)
  // must get through on a slow link, so it is only a backstop here. The tighter limits are per
  // request: a body nobody reads has bodyMs (onRequest), readBytes() a deadline and a limit for
  // silence, and a streamed upload one for silence (api.js).
  server.headersTimeout = 30000;
  server.requestTimeout = UPLOAD_MS;
  // The routes served, as { method, path } (the OpenAPI test holds the document to them).
  server.routes = Object.freeze(served.map(({ method, path }) => ({ method, path })));
  return server;
}

// Overlay pages, the SDK and media load in OBS and in the admin UI's sandboxed (opaque-origin)
// previews. Even their errors carry Access-Control-Allow-Origin, so a preview can tell an error
// from an outage. The admin API does not (07 §7.10).
function corsFor(rawUrl) {
  return overlayFacing(rawUrl) ? { 'access-control-allow-origin': '*' } : {};
}

async function handle(req, res, router) {
  req.on('error', () => {}); // client aborts mid-request are routine, not crashes
  res.on('error', () => {});
  const cors = corsFor(req.url);

  let url;
  let segments;
  try {
    url = new URL(req.url, 'http://localhost');
    segments = url.pathname.split('/').slice(1).map((s) => decodeURIComponent(s));
  } catch {
    return sendProblem(res, 400, 'Bad request', 'The request URL is malformed.', { headers: cors });
  }

  const method = req.method === 'HEAD' ? 'GET' : req.method;
  const match = router.match(method, segments);
  if (match.status === 404) {
    return sendProblem(res, 404, 'Not found', `Nothing is served at ${url.pathname}.`, { headers: cors });
  }
  if (match.status === 405) {
    return sendProblem(res, 405, 'Method not allowed', `${url.pathname} accepts ${match.allow.join(', ')}.`, {
      headers: { ...cors, allow: match.allow.join(', ') },
    });
  }
  await match.route.handler({ req, res, params: match.params, url });
}

// `headers` go on the error's response; `code` is its problem type (too-large, too-slow). A 413 or
// 408 closes the connection: the rest of the body is never read, so the connection can't carry
// another request (and Node would otherwise read and discard the whole body to keep it alive).
export class BodyError extends Error {
  constructor(status, message, headers = {}, code = 'too-large') {
    super(message);
    this.name = 'BodyError';
    this.status = status;
    this.headers = headers;
    this.code = code;
  }
}

const tooLarge = (message) => new BodyError(413, message, { connection: 'close' });

// How long a whole request may take (the server's backstop), and how long a body may take to
// arrive (408 past it when read here): a JSON body or a log entry in a minute, as before uploads.
export const UPLOAD_MS = 30 * 60 * 1000;
export const BODY_MS = 60 * 1000;

// The server's deadline for each request's body, until a reader with one of its own claims it.
const bodyDeadlines = new WeakMap();

// From here the body's time is the caller's: readBytes() (a 408 of its own), or a route that
// takes a long body (an upload) once it knows who is sending. Before, a body nobody reads is
// dropped after bodyMs (createHttpServer).
export function claimBody(req) {
  clearTimeout(bodyDeadlines.get(req));
  bodyDeadlines.delete(req);
}

// Reads a request body as text, refusing more than `limit` bytes (413) without buffering the rest,
// or one that takes too long to arrive (408). On either it only stops reading: destroying the
// request would also destroy the socket, and the answer would never arrive.
export function readBody(req, limit, options) {
  return readBytes(req, limit, options).then((b) => b.toString('utf8'));
}

// The same, as bytes (an upload). ms: how long the body may take; with rate (bytes a second), as
// long as the size limit takes at that rate if that is longer (07 §7.11: a slow link still gets a
// whole package through). Whatever the total, idleMs with nothing arriving is a 408 too: a 1 KB
// body that goes silent doesn't hold its socket for the time 100 MiB would take.
export function readBytes(req, limit, { ms = BODY_MS, rate, idleMs = BODY_MS } = {}) {
  claimBody(req);
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (declared > limit) {
      reject(tooLarge(`The body is ${declared} bytes; the limit is ${limit}.`));
      return;
    }
    const total = rate ? Math.max(ms, (limit / rate) * 1000) : ms;
    const chunks = [];
    let size = 0;
    const done = () => {
      clearTimeout(timer);
      clearTimeout(idle);
    };
    const stop = (err) => {
      done();
      req.off('data', onData);
      req.off('end', onEnd);
      req.pause();
      reject(err);
    };
    const onData = (chunk) => {
      idle.refresh();
      size += chunk.length;
      if (size > limit) return stop(tooLarge(`The body is over the ${limit}-byte limit.`));
      chunks.push(chunk);
    };
    const onEnd = () => {
      done();
      resolve(Buffer.concat(chunks));
    };
    const slow = (what) => stop(new BodyError(408, `${what} Send it again, on a faster connection if you can.`, { connection: 'close' }, 'too-slow'));
    const timer = setTimeout(() => slow(`The body took longer than ${Math.round(total / 1000)} s to arrive.`), total);
    const idle = setTimeout(() => slow(`Nothing of the body arrived for ${Math.round(idleMs / 1000)} s.`), idleMs);
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', (err) => {
      done();
      reject(err);
    });
  });
}

export function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (err) => reject(err);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      resolve(server.address());
    });
  });
}

export function close(server) {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}
