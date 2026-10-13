// The API's conventions (03 §3.1–3.5), in one place for every /api/v1 route:
//
// - who is asking: guard() (auth/routes.js) with the route's scope, or `open` for setup and login;
// - a JSON body (or raw bytes for uploads), with the fields a write accepts: others are refused
//   (07 §7.11);
// - rate limits: 600 requests a minute per principal (a token, a user's sessions, the command
//   line; an address when nobody is signed in), RateLimit-* on every answer, 429 + Retry-After
//   over it (03 §3.5);
// - ETag on a resource (`"<id>-r<rev>"`), and If-Match on PATCH and PUT of one: a session (the
//   admin UI) must send it (428 without, 412 when stale); a token or the command line may omit it.
//   Commands (take a scene, fire an action or a cue) take none (03 §3.1, H16);
// - Idempotency-Key on POST: a repeat within 24 hours answers what the first did, so a hardware
//   button pressed twice fires once (03 §3.1);
// - cursor pagination: ?limit=1…200&cursor= → { items, next } (paginate());
// - problems: RFC 9457 with `type`, `title`, `status`, `detail` (what to do) and `instance` (the
//   path, never its query: an overlay key rides there), never a stack (03 §3.2).
//
// The routes' descriptions make the OpenAPI document (GET /api/v1/openapi.json).
import { createHash } from 'node:crypto';
import { jsonBody, refusedHere } from './local.js';
import { readBytes, sendJson } from './server.js';

export const PER_MINUTE = 600;
export const IDEMPOTENCY_MS = 24 * 60 * 60 * 1000;
export const MAX_PAGE = 200;
const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const TITLES = { 400: 'Bad request', 401: 'Not signed in', 403: 'Forbidden', 404: 'Not found', 409: 'Conflict', 412: 'Precondition failed', 413: 'Too large', 415: 'Unsupported media type', 422: 'Not possible', 428: 'Precondition required', 429: 'Too many requests', 503: 'Unavailable' };
export const problemType = (code) => `https://skp.dev/errors/${code}`;

// A refusal any route may throw: status, code (its problem type), what to do, and extra headers.
export class ApiError extends Error {
  constructor(status, code, message, { headers, extra } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.headers = headers;
    this.extra = extra;
  }
}

const etagOf = (value) => (value && typeof value === 'object' && typeof value.id === 'string' && Number.isInteger(value.rev) ? `"${value.id}-r${value.rev}"` : undefined);
export const etagFor = (id, rev) => `"${id}-r${rev}"`;

// { items, next }: a page of a list sorted by key(item) (a string), after the cursor's key.
export function paginate(list, url, key = (x) => x.id) {
  const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE) throw new ApiError(422, 'invalid', `"limit" is 1 to ${MAX_PAGE}.`);
  const cursor = url.searchParams.get('cursor');
  let after = '';
  if (cursor) {
    try { after = Buffer.from(cursor, 'base64url').toString('utf8'); } catch { after = ''; }
    if (!after) throw new ApiError(422, 'invalid', '"cursor" is the "next" of the page before.');
  }
  const rest = after ? list.filter((x) => key(x) > after) : list;
  const items = rest.slice(0, limit);
  return { items, ...(rest.length > limit ? { next: Buffer.from(key(items[items.length - 1])).toString('base64url') } : {}) };
}

// A problem from anything a route throws: the platform's own errors carry status and code.
function problemOf(err) {
  if (err instanceof ApiError) return { status: err.status, code: err.code, detail: err.message, headers: err.headers, extra: err.extra };
  if (err?.name === 'ConflictError') return { status: 409, code: 'conflict', detail: 'It changed meanwhile: read it again, then retry.' };
  if (err?.name === 'BodyError') return { status: err.status, code: 'too-large', detail: err.message, headers: err.headers };
  const known = ['ShowError', 'AuthError', 'OverlayError', 'TemplateError', 'MediaError', 'SourceError', 'SecretsError', 'MigrateError', 'ZipError'];
  if (known.includes(err?.name)) {
    const status = Number.isInteger(err.status) ? err.status : STATUS_BY_CODE[err.code] || 422;
    const headers = err.retryAfterS ? { 'retry-after': String(err.retryAfterS) } : undefined;
    const extra = err.findings ? { findings: err.findings } : err.detail && typeof err.detail === 'object' ? { plan: err.detail } : undefined;
    return { status, code: err.code || 'refused', detail: err.message, headers, extra };
  }
  return undefined;
}
// Codes whose errors don't carry a status of their own.
const STATUS_BY_CODE = {
  'not-found': 404, 'no-overlay': 404, 'not-installed': 404,
  'slug-taken': 409, 'in-use': 409, 'confirm-major': 409, 'confirm-changes': 409, 'public-needs-key': 409, 'exists': 409,
  'too-large': 413, 'unsupported-type': 415,
};

export function createApi({ guard, hosts, store, log, now = Date.now, perMinute = PER_MINUTE }) {
  const routes = [];
  const windows = new Map(); // principal → { start, count }
  const inFlight = new Set(); // idempotency keys being answered
  let lastPrune = 0;

  // ---- rate limits (03 §3.5) ---------------------------------------------------------------
  function limit(key, res) {
    const t = now();
    let w = windows.get(key);
    if (!w || t - w.start >= 60000) windows.set(key, (w = { start: t, count: 0 }));
    w.count++;
    const reset = Math.max(1, Math.ceil((w.start + 60000 - t) / 1000));
    res.setHeader('ratelimit-limit', String(perMinute));
    res.setHeader('ratelimit-remaining', String(Math.max(0, perMinute - w.count)));
    res.setHeader('ratelimit-reset', String(reset));
    if (windows.size > 10000) for (const [k, v] of windows) if (t - v.start >= 60000) windows.delete(k);
    return w.count > perMinute ? reset : 0;
  }
  const principalKey = (who, req) => (who ? `${who.kind}:${who.tokenId || who.user?.id || 'local'}` : `ip:${req.client?.ip ?? req.socket.remoteAddress}`);

  // ---- idempotency (03 §3.1) ---------------------------------------------------------------
  function pruneIdempotency() {
    lastPrune = now();
    for (let after = ''; ;) {
      const page = store.list('idempotency', { after, limit: 1000 });
      for (const doc of page) if (now() - doc.data.at > IDEMPOTENCY_MS) store.delete('idempotency', doc.id);
      if (page.length < 1000) break;
      after = page[page.length - 1].id;
    }
  }

  function problem(res, req, { status, code, detail, headers, extra }) {
    const instance = String(req.url || '').split('?')[0];
    res.writeHead(status, { 'content-type': 'application/problem+json', ...(headers || {}) });
    res.end(JSON.stringify({ type: problemType(code), title: TITLES[status] || 'Refused', status, detail, instance, ...(extra || {}) }));
  }

  // def: { method, path, scope?, open?, summary, tag?, body?: { fields?: [...], raw?: true, limit? },
  //   resource?: (params) => ({ id, rev }) (If-Match is checked against it on PATCH and PUT),
  //   command?: true (no If-Match), idempotent?: false, run({ who, params, body, url, req, res, ifRev }) }
  // run returns a value (200 OK), or { status, body, headers }; a body with `id` and `rev` gets an
  // ETag.
  function route(def) {
    routes.push(def);
    const bodyLimit = def.body?.limit ?? 64 * 1024;
    return {
      method: def.method,
      path: def.path,
      async handler({ req, res, params, url }) {
        let who;
        if (def.open) {
          if (refusedHere(req, res, hosts)) return;
        } else {
          who = guard(req, res, def.scope);
          if (!who) return;
        }
        const wait = limit(principalKey(who, req), res);
        if (wait) return problem(res, req, { status: 429, code: 'rate-limited', detail: `More than ${perMinute} requests a minute. Wait ${wait} s.`, headers: { 'retry-after': String(wait) } });

        // The body: JSON with the fields this route takes, or raw bytes.
        let body = {};
        if (def.body?.stream) {
          body = req; // the route reads it (an upload of hundreds of MiB, never buffered)
        } else if (def.body?.raw) {
          try {
            body = await readBytes(req, bodyLimit);
          } catch (err) {
            return problem(res, req, err.status ? { status: err.status, code: 'too-large', detail: err.message, headers: err.headers } : { status: 400, code: 'bad-request', detail: 'The body could not be read.' });
          }
        } else if (def.method !== 'GET' && def.method !== 'HEAD') {
          body = await jsonBody(req, res, bodyLimit);
          if (body === undefined) return;
          if (!body || typeof body !== 'object' || Array.isArray(body)) return problem(res, req, { status: 400, code: 'bad-request', detail: 'The body must be a JSON object.' });
          if (def.body?.fields) {
            const unknown = Object.keys(body).filter((k) => !def.body.fields.includes(k));
            if (unknown.length) return problem(res, req, { status: 422, code: 'unknown-field', detail: `Unknown field${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}. This takes ${def.body.fields.length ? def.body.fields.join(', ') : 'no fields'}.` });
          }
        }

        try {
          // If-Match on PATCH and PUT of a resource (03 §3.1, H16).
          let ifRev;
          if (def.resource && !def.command && (def.method === 'PATCH' || def.method === 'PUT' || def.method === 'DELETE')) {
            const current = def.resource(params);
            const given = req.headers['if-match'];
            if (given === undefined) {
              if (who?.kind === 'session' && def.method !== 'DELETE') return problem(res, req, { status: 428, code: 'if-match-required', detail: `Send If-Match with the ETag you last read (${etagFor(current.id, current.rev)} now), so a change made meanwhile isn't overwritten.` });
            } else {
              const m = /^(?:W\/)?"(.+)-r(\d+)"$/.exec(String(given).trim());
              if (!m || m[1] !== current.id || Number(m[2]) !== current.rev) {
                return problem(res, req, { status: 412, code: 'stale', detail: `It changed since you read it (now ${etagFor(current.id, current.rev)}): read it again, then retry.`, headers: { etag: etagFor(current.id, current.rev) } });
              }
              ifRev = current.rev;
            }
          }

          // Idempotency-Key on POST: the first answer, again.
          const idemKey = def.method === 'POST' && def.idempotent !== false ? req.headers['idempotency-key'] : undefined;
          let idemId;
          if (idemKey !== undefined) {
            if (typeof idemKey !== 'string' || !/^[\x21-\x7e]{1,200}$/.test(idemKey)) return problem(res, req, { status: 400, code: 'bad-request', detail: 'Idempotency-Key is 1 to 200 printable characters.' });
            idemId = createHash('sha256').update(`${principalKey(who, req)}\n${idemKey}`).digest('hex');
            const request = createHash('sha256').update(`${def.method} ${url.pathname}\n${JSON.stringify(body)}`).digest('hex');
            const seen = store.get('idempotency', idemId);
            if (seen && now() - seen.data.at <= IDEMPOTENCY_MS) {
              if (seen.data.request !== request) return problem(res, req, { status: 422, code: 'idempotency-mismatch', detail: 'This Idempotency-Key was used for another request. Use a new key for a new request.' });
              res.setHeader('idempotent-replayed', 'true');
              if (seen.data.etag) res.setHeader('etag', seen.data.etag);
              return sendJson(res, seen.data.status, seen.data.body);
            }
            if (inFlight.has(idemId)) return problem(res, req, { status: 409, code: 'idempotency-in-progress', detail: 'The first request with this Idempotency-Key is still being answered.' });
            inFlight.add(idemId);
            idemId = { id: idemId, request };
          }

          try {
            const out = await def.run({ who, params, body, url, req, res, ifRev });
            if (res.headersSent) return; // the route answered itself (a stream)
            const answer = out && typeof out === 'object' && 'status' in out && 'body' in out ? out : { status: 200, body: out };
            const etag = etagOf(answer.body);
            const headers = { ...(etag ? { etag } : {}), ...(answer.headers || {}) };
            if (idemId && answer.status < 500) {
              store.put('idempotency', idemId.id, { request: idemId.request, status: answer.status, body: answer.body ?? null, ...(etag ? { etag } : {}), at: now() });
              if (now() - lastPrune > 60 * 60 * 1000) pruneIdempotency();
            }
            if (answer.status === 204) {
              res.writeHead(204, headers);
              return res.end();
            }
            return sendJson(res, answer.status, answer.body ?? null, headers);
          } finally {
            if (idemId) inFlight.delete(idemId.id);
          }
        } catch (err) {
          const p = problemOf(err);
          if (p) return problem(res, req, p);
          log.error('an API request failed', { method: def.method, path: def.path, err });
          throw err;
        }
      },
    };
  }

  // The OpenAPI 3.1 document of every route described so far.
  function openapi({ version, base = '/' } = {}) {
    const paths = {};
    for (const r of routes) {
      const p = r.path.replace(/:([A-Za-z]+)/g, '{$1}').replace(/\/\*$/, '/{path}');
      const params = [...r.path.matchAll(/:([A-Za-z]+)/g)].map((m) => ({ name: m[1], in: 'path', required: true, schema: { type: 'string' } }));
      if (r.path.endsWith('/*')) params.push({ name: 'path', in: 'path', required: true, schema: { type: 'string' } });
      const op = {
        summary: r.summary,
        ...(r.tag ? { tags: [r.tag] } : {}),
        ...(params.length ? { parameters: params } : {}),
        security: r.open ? [] : [{ session: [] }, { token: [] }],
        ...(r.scope ? { 'x-skp-scope': r.scope } : {}),
        ...(r.body?.raw ? { requestBody: { content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } } } : r.body?.fields ? {
          requestBody: { content: { 'application/json': { schema: { type: 'object', additionalProperties: false, properties: Object.fromEntries(r.body.fields.map((f) => [f, {}])) } } } },
        } : {}),
        responses: {
          default: { description: 'A problem (RFC 9457)', content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } } },
          200: { description: 'OK', content: { 'application/json': {} } },
        },
      };
      (paths[p] ??= {})[r.method.toLowerCase()] = op;
    }
    return {
      openapi: '3.1.0',
      info: { title: 'Stream Kit Platform API', version: version || '1', description: 'Every route of the platform\'s API v1 (docs/standard/03-api.md).' },
      servers: [{ url: base }],
      paths,
      components: {
        securitySchemes: {
          session: { type: 'apiKey', in: 'cookie', name: 'skp_session', description: 'The admin UI\'s session; changes also need X-SKP-CSRF.' },
          token: { type: 'http', scheme: 'bearer', description: 'An API token, skp_pat_…' },
        },
        schemas: {
          Problem: { type: 'object', required: ['type', 'title', 'status', 'detail'], properties: { type: { type: 'string' }, title: { type: 'string' }, status: { type: 'integer' }, detail: { type: 'string' }, instance: { type: 'string' } } },
        },
      },
    };
  }

  return { route, openapi, paginate, routes, problem };
}
