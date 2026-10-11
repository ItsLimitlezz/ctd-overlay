// The HTTP server. Nothing a client sends may take the process down (H11, 01 §1.7): malformed
// URLs get 400, a handler that throws or rejects gets 500, and the error goes to the log and
// crash.log. Responses never carry stack traces (03 §3.2).
import http from 'node:http';

const BASE_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
  'cache-control': 'no-store',
};

// Routes: { method, path: '/a/:param/b', handler({ req, res, params, url }) }. A final `*`
// segment matches one or more remaining segments, joined with "/" in params['*'].
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
  res.end(JSON.stringify({ type, title, status, detail }));
}

// GET /healthz: 200 "ok", no version or detail, no authentication (10 §10.3).
const healthz = ({ res }) => sendText(res, 200, 'ok');

// Browsers (OBS's included) ask every page's host for /favicon.ico; answer quietly instead of
// filling logs with 404s.
const favicon = ({ res }) => {
  res.writeHead(204, { ...BASE_HEADERS, 'cache-control': 'public, max-age=86400' });
  res.end();
};

export function createHttpServer({ log, crash, routes = [] }) {
  const router = createRouter([
    { method: 'GET', path: '/healthz', handler: healthz },
    { method: 'GET', path: '/favicon.ico', handler: favicon },
    ...routes,
  ]);

  const server = http.createServer((req, res) => {
    handle(req, res, router).catch((err) => fail(err, req, res));
  });

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

  // Malformed HTTP (not even a parseable request line) from scanners and broken clients.
  server.on('clientError', (err, socket) => {
    if (err.code !== 'ECONNRESET' && socket.writable) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    } else {
      socket.destroy();
    }
  });

  server.keepAliveTimeout = 5000;
  server.headersTimeout = 30000;
  server.requestTimeout = 60000;
  return server;
}

// Overlay pages and the SDK run in OBS and in the admin UI's sandboxed (opaque-origin) previews.
// Even their errors carry Access-Control-Allow-Origin, so a preview can tell an error from an
// outage. The admin API does not (07 §7.10).
function corsFor(rawUrl) {
  return /^\/(o|sdk)\//.test(rawUrl || '') ? { 'access-control-allow-origin': '*' } : {};
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

export class BodyError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Reads a request body as text, refusing more than `limit` bytes (413) without buffering the rest.
export function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (declared > limit) {
      reject(new BodyError(413, `The body is ${declared} bytes; the limit is ${limit}.`));
      return;
    }
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        req.destroy();
        reject(new BodyError(413, `The body is over the ${limit}-byte limit.`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
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
