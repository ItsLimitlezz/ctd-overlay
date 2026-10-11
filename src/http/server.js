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

export function createHttpServer({ log, crash, routes = [] }) {
  const router = createRouter([{ method: 'GET', path: '/healthz', handler: healthz }, ...routes]);

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
        'The server hit an unexpected error and logged it. Try again; if it keeps happening, look in crash.log in the data directory.');
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

async function handle(req, res, router) {
  req.on('error', () => {}); // client aborts mid-request are routine, not crashes
  res.on('error', () => {});

  let url;
  let segments;
  try {
    url = new URL(req.url, 'http://localhost');
    segments = url.pathname.split('/').slice(1).map((s) => decodeURIComponent(s));
  } catch {
    return sendProblem(res, 400, 'Bad request', 'The request URL is malformed.');
  }

  const method = req.method === 'HEAD' ? 'GET' : req.method;
  const match = router.match(method, segments);
  if (match.status === 404) {
    return sendProblem(res, 404, 'Not found', `Nothing is served at ${url.pathname}.`);
  }
  if (match.status === 405) {
    return sendProblem(res, 405, 'Method not allowed', `${url.pathname} accepts ${match.allow.join(', ')}.`, {
      headers: { allow: match.allow.join(', ') },
    });
  }
  await match.route.handler({ req, res, params: match.params, url });
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
