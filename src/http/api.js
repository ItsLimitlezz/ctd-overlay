// The API's conventions (03 §3.1–3.5), in one place for every /api/v1 route:
//
// - who is asking: guard() (auth/routes.js) with the route's scope, or `open` for setup and login;
// - a JSON body (or raw bytes for uploads), with the fields a write accepts: others are refused
//   (07 §7.11), in a field of a fixed shape too (`nested`);
// - rate limits: 600 requests a minute per principal (a token, a user's sessions, the command
//   line; an address when nobody is signed in, an IPv6 one by its /64), or a route's own budget a
//   second (POST /events: 60), RateLimit-* on every answer, 429 + Retry-After over it (03 §3.5);
// - ETag on a resource (`"<id>-r<rev>"`), and If-Match on PATCH and PUT of one: a session (the
//   admin UI) must send it (428 without, 412 when stale); a token or the command line may omit it.
//   Commands (take a scene, fire an action or a cue) take none (03 §3.1, H16);
// - Idempotency-Key on POST: a repeat within 24 hours answers what the first did, so a hardware
//   button pressed twice fires once (03 §3.1);
// - cursor pagination: ?limit=1…200&cursor= → { items, next } (paginate());
// - problems: RFC 9457 with `type`, `title`, `status`, `detail` (what to do) and `instance` (the
//   path, never its query: an overlay key rides there), never a stack (03 §3.2);
// - the base headers on every answer (no-store, nosniff, Referrer-Policy: 03 §3.4, 07 §7.10).
//
// The routes' descriptions make the OpenAPI document (GET /api/v1/openapi.json).
import { createHash } from 'node:crypto';
import { normalizeIp } from '../net.js';
import { jsonBody, refusedHere } from './local.js';
import { BASE_HEADERS, BODY_MS, readBytes, sendJson } from './server.js';

export const PER_MINUTE = 600;
export const IDEMPOTENCY_MS = 24 * 60 * 60 * 1000;
export const MAX_PAGE = 200;
// A raw upload may take as long as its limit needs at 64 KiB a second (a 100 MiB package: about 27
// minutes), never less than a JSON body may.
const UPLOAD_RATE = 64 * 1024;
const TITLES = { 400: 'Bad request', 401: 'Not signed in', 403: 'Forbidden', 404: 'Not found', 408: 'Request timeout', 409: 'Conflict', 412: 'Precondition failed', 413: 'Too large', 415: 'Unsupported media type', 422: 'Not possible', 428: 'Precondition required', 429: 'Too many requests', 500: 'Server error', 502: 'Bad gateway', 503: 'Unavailable', 504: 'Gateway timeout' };
export const problemType = (code) => `https://skp.dev/errors/${code}`;

// A response nothing reaches: guard() answers its refusals itself, and a check made while a stream
// is already answering must not.
const NOWHERE = { writeHead() { return this; }, setHeader() {}, end() {} };

// What a rate limit counts an address as: an IPv6 one by its /64 ("2001:db8:1:2::/64"), the block
// one home or server has to rotate through; any other as it is.
export function addressKey(ip) {
  const a = normalizeIp(ip).split('%')[0];
  if (!a.includes(':')) return a;
  const groups = (s) => (s ? s.split(':').flatMap((g) => (g.includes('.') ? ['0', '0'] : [g])) : []);
  const [head, tail] = a.split('::');
  const full = tail === undefined ? groups(head) : [...groups(head), ...Array(Math.max(0, 8 - groups(head).length - groups(tail).length)).fill('0'), ...groups(tail)];
  return `${full.slice(0, 4).map((g) => (parseInt(g, 16) || 0).toString(16)).join(':')}::/64`;
}

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
  if (err?.name === 'BodyError') return { status: err.status, code: err.code, detail: err.message, headers: err.headers };
  const known = ['ShowError', 'AuthError', 'OverlayError', 'TemplateError', 'MediaError', 'SourceError', 'SecretsError', 'MigrateError', 'ZipError'];
  if (known.includes(err?.name)) {
    const status = Number.isInteger(err.status) ? err.status : statusOf(err);
    const headers = err.retryAfterS ? { 'retry-after': String(err.retryAfterS) } : undefined;
    // findings: what a package's lint found; problems: what doesn't fit in settings ({ path,
    // message }), on their own or in an upgrade's plan.
    const extra = err.findings ? { findings: err.findings }
      : Array.isArray(err.detail) ? { problems: err.detail }
      : err.detail && typeof err.detail === 'object' ? { plan: err.detail, ...(Array.isArray(err.detail.problems) ? { problems: err.detail.problems } : {}) }
      : undefined;
    return { status, code: err.code || 'refused', detail: err.message, headers, extra };
  }
  return undefined;
}
// Codes whose errors don't carry a status of their own: a conflict with what is there (409); the
// platform failing to write (500), shutting down or unable to now (503); a download failing
// upstream (502, 504). Anything else is about the request (422).
const STATUS_BY_CODE = {
  'not-found': 404, 'no-overlay': 404, 'not-installed': 404,
  'slug-taken': 409, 'in-use': 409, 'busy': 409, 'confirm-major': 409, 'confirm-changes': 409, 'public-needs-key': 409, 'exists': 409, 'id-taken': 409, 'version-exists': 409,
  'too-large': 413, 'unsupported-type': 415,
  'write-failed': 500,
  'unreachable': 502, 'bad-response': 502, 'download-failed': 502,
  'read-only': 503, 'closed': 503, 'stopped': 503, 'rate-limited': 503,
  'timeout': 504,
};
// A package too large to download is the remote's, not this request's body (413).
const statusOf = (err) => (err.name === 'SourceError' && err.code === 'too-large' ? 422 : STATUS_BY_CODE[err.code] || 422);

// uploadIdleMs: how long a streamed upload may go with nothing arriving (tests shorten it).
export function createApi({ guard, hosts, store, log, now = Date.now, perMinute = PER_MINUTE, uploadIdleMs = BODY_MS }) {
  const routes = [];
  const inFlight = new Set(); // idempotency keys being answered
  let lastPrune = 0;

  // ---- rate limits (03 §3.5) ---------------------------------------------------------------
  // A window per principal (and per route, for one with a budget of its own): { start, ms,
  // count }. The map holds them in the order they opened, so the expired ones are pruned from its
  // front, never by scanning the live ones: a flood of new addresses would make every request pay
  // for all of them.
  const windows = new Map();
  function limit(key, res, max, ms) {
    const t = now();
    let w = windows.get(key);
    if (!w || t - w.start >= w.ms) {
      windows.delete(key); // to the back, where the newest windows are
      windows.set(key, (w = { start: t, ms, count: 0 }));
    }
    for (const [k, v] of windows) {
      if (t - v.start < v.ms) break;
      windows.delete(k);
    }
    w.count++;
    const reset = Math.max(1, Math.ceil((w.start + ms - t) / 1000));
    res.setHeader('ratelimit-limit', String(max));
    res.setHeader('ratelimit-remaining', String(Math.max(0, max - w.count)));
    res.setHeader('ratelimit-reset', String(reset));
    return w.count > max ? reset : 0;
  }
  const principalKey = (who, req) => (who ? `${who.kind}:${who.tokenId || who.user?.id || 'local'}` : `ip:${addressKey(req.client?.ip ?? req.socket.remoteAddress)}`);

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
    res.writeHead(status, { ...BASE_HEADERS, 'content-type': 'application/problem+json', ...(headers || {}) });
    res.end(JSON.stringify({ type: problemType(code), title: TITLES[status] || 'Refused', status, detail, instance, ...(extra || {}) }));
  }

  // def: { method, path, scope?, open?, summary, tag?,
  //   body?: { fields?: [...], nested?: { field: [...] }, raw?: true, stream?: true, json?: [...], limit? },
  //   resource?: (params) => ({ id, rev }) (If-Match is checked against it on PATCH and PUT),
  //   command?: true (no If-Match), idempotent?: false, perSecond?: n (its own budget, a second),
  //   paged?: true, query?: [...], status?, produces? (for the OpenAPI document),
  //   run({ who, params, body, url, req, res, ifRev, still }) }
  // nested: the fields a field of a fixed shape takes (a template reference: id, version); json:
  // the fields a raw route also takes as JSON. run returns a value (200 OK), or { status, body,
  // headers }; a body with `id` and `rev` gets an ETag. still() says whether the principal may still
  // (for a route that answers for long: a stream).
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
        const wait = def.perSecond
          ? limit(`${principalKey(who, req)} ${def.method} ${def.path}`, res, def.perSecond, 1000)
          : limit(principalKey(who, req), res, perMinute, 60000);
        if (wait) return problem(res, req, { status: 429, code: 'rate-limited', detail: def.perSecond ? `More than ${def.perSecond} a second. Wait ${wait} s.` : `More than ${perMinute} requests a minute. Wait ${wait} s.`, headers: { 'retry-after': String(wait) } });

        // The body: JSON with the fields this route takes, or raw bytes.
        let body = {};
        if (def.body?.stream) {
          // The route reads it (an upload of hundreds of MiB, never buffered), for as long as it
          // takes, but a minute with nothing arriving drops it.
          req.setTimeout(uploadIdleMs, () => req.destroy());
          req.once('end', () => req.setTimeout(0));
          body = req;
        } else if (def.body?.raw) {
          try {
            body = await readBytes(req, bodyLimit, { ms: Math.max(BODY_MS, (bodyLimit / UPLOAD_RATE) * 1000) });
          } catch (err) {
            return problem(res, req, err.status ? { status: err.status, code: err.code, detail: err.message, headers: err.headers } : { status: 400, code: 'bad-request', detail: 'The body could not be read.' });
          }
        } else if (def.method !== 'GET' && def.method !== 'HEAD') {
          body = await jsonBody(req, res, bodyLimit);
          if (body === undefined) return;
          if (!body || typeof body !== 'object' || Array.isArray(body)) return problem(res, req, { status: 400, code: 'bad-request', detail: 'The body must be a JSON object.' });
          if (def.body?.fields) {
            const unknown = Object.keys(body).filter((k) => !def.body.fields.includes(k));
            if (unknown.length) return problem(res, req, { status: 422, code: 'unknown-field', detail: `Unknown field${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}. This takes ${def.body.fields.length ? def.body.fields.join(', ') : 'no fields'}.` });
            for (const [field, takes] of Object.entries(def.body.nested || {})) {
              const value = body[field];
              const extra = value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).filter((k) => !takes.includes(k)) : [];
              if (extra.length) return problem(res, req, { status: 422, code: 'unknown-field', detail: `Unknown field${extra.length > 1 ? 's' : ''} in "${field}": ${extra.join(', ')}. It takes ${takes.join(', ')}.` });
            }
          }
        }

        // Whether the principal may still: signed in (not signed out, expired, revoked or removed
        // since) and holding the route's scope.
        const still = () => {
          if (def.open) return true;
          try {
            return Boolean(guard(req, NOWHERE, def.scope));
          } catch (err) {
            log.error('a principal could not be checked again', { method: def.method, path: def.path, err });
            return false;
          }
        };

        try {
          // If-Match on PATCH and PUT of a resource (03 §3.1, H16).
          let ifRev;
          if (def.resource && !def.command && (def.method === 'PATCH' || def.method === 'PUT' || def.method === 'DELETE')) {
            const current = def.resource(params);
            const tag = etagFor(current.id, current.rev);
            const given = req.headers['if-match'];
            // "*" (it exists), or a list of tags with the current one in it, compared strongly: a
            // weak tag (W/"…") never matches (RFC 9110 §13.1.1). The admin UI must name the
            // version it read (H16), so "*" from a session counts as no tag.
            const tags = given === undefined ? [] : String(given).split(',').map((s) => s.trim()).filter(Boolean);
            const any = tags.length === 1 && tags[0] === '*';
            if ((given === undefined || any) && who?.kind === 'session' && def.method !== 'DELETE') {
              return problem(res, req, { status: 428, code: 'if-match-required', detail: `Send If-Match with the ETag you last read (${tag} now), so a change made meanwhile isn't overwritten.` });
            }
            if (any || tags.includes(tag)) ifRev = current.rev;
            else if (given !== undefined) return problem(res, req, { status: 412, code: 'stale', detail: `It changed since you read it (now ${tag}): read it again, then retry.`, headers: { etag: tag } });
          }

          // Idempotency-Key on POST: the first answer, again. Not on a streamed upload: its body
          // can't be fingerprinted before the route has read it, so another file sent under the
          // same key couldn't be told apart (a 422, 03 §3.1); there the key is ignored.
          const idemKey = def.method === 'POST' && def.idempotent !== false && !def.body?.stream ? req.headers['idempotency-key'] : undefined;
          let idemId;
          if (idemKey !== undefined) {
            if (typeof idemKey !== 'string' || !/^[\x21-\x7e]{1,200}$/.test(idemKey)) return problem(res, req, { status: 400, code: 'bad-request', detail: 'Idempotency-Key is 1 to 200 printable characters.' });
            idemId = createHash('sha256').update(`${principalKey(who, req)}\n${idemKey}`).digest('hex');
            // The request: its query too (?source=, ?name=), and raw bytes as they are (as JSON, a
            // Buffer is a number a byte: seconds of work and a GB of memory for a package).
            const request = createHash('sha256').update(`${def.method} ${url.pathname}${url.search}\n`).update(Buffer.isBuffer(body) ? body : JSON.stringify(body)).digest('hex');
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
            const out = await def.run({ who, params, body, url, req, res, ifRev, still });
            if (res.headersSent) return; // the route answered itself (a stream)
            const answer = out && typeof out === 'object' && 'status' in out && 'body' in out ? out : { status: 200, body: out };
            const etag = etagOf(answer.body);
            const headers = { ...(etag ? { etag } : {}), ...(answer.headers || {}) };
            if (idemId && answer.status < 500) {
              store.put('idempotency', idemId.id, { request: idemId.request, status: answer.status, body: answer.body ?? null, ...(etag ? { etag } : {}), at: now() });
              if (now() - lastPrune > 60 * 60 * 1000) pruneIdempotency();
            }
            if (answer.status === 204) {
              res.writeHead(204, { ...BASE_HEADERS, ...headers });
              return res.end();
            }
            return sendJson(res, answer.status, answer.body ?? null, headers);
          } finally {
            if (idemId) inFlight.delete(idemId.id);
          }
        } catch (err) {
          const p = problemOf(err);
          // A failure of the platform's own (a write) is in the log too, for whoever looks after it.
          if (p?.status === 500) log.error('an API request failed', { method: def.method, path: def.path, err });
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
    const object = (fields, nested = {}) => (fields
      ? { type: 'object', additionalProperties: false, properties: Object.fromEntries(fields.map((f) => [f, nested[f] ? object(nested[f]) : {}])) }
      : { type: 'object' });
    const page = { type: 'object', required: ['items'], properties: { items: { type: 'array' }, next: { type: 'string' } } };
    for (const r of routes) {
      const p = r.path.replace(/:([A-Za-z]+)/g, '{$1}').replace(/\/\*$/, '/{path}');
      const params = [...r.path.matchAll(/:([A-Za-z]+)/g)].map((m) => ({ name: m[1], in: 'path', required: true, schema: { type: 'string' } }));
      if (r.path.endsWith('/*')) params.push({ name: 'path', in: 'path', required: true, schema: { type: 'string' } });
      if (r.paged) {
        params.push({ name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: MAX_PAGE, default: 50 } });
        params.push({ name: 'cursor', in: 'query', required: false, description: 'The "next" of the page before', schema: { type: 'string' } });
      }
      for (const name of r.query || []) params.push({ name, in: 'query', required: false, schema: { type: 'string' } });
      // The body: bytes (an upload, streamed or not; JSON too where a raw route takes some), or a
      // JSON object with the route's fields.
      const requestBody = r.body?.raw || r.body?.stream
        ? { required: true, content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } }, ...(r.body.json ? { 'application/json': { schema: object(r.body.json) } } : {}) } }
        : r.body && r.method !== 'GET' ? { content: { 'application/json': { schema: object(r.body.fields, r.body.nested) } } } : undefined;
      const status = String(r.status || 200);
      const op = {
        summary: r.summary,
        ...(r.tag ? { tags: [r.tag] } : {}),
        ...(params.length ? { parameters: params } : {}),
        security: r.open ? [] : [{ session: [] }, { token: [] }],
        ...(r.scope ? { 'x-skp-scope': r.scope } : {}),
        ...(requestBody ? { requestBody } : {}),
        responses: {
          default: { description: 'A problem (RFC 9457)', content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } } },
          [status]: status === '204' ? { description: 'Done' } : { description: 'OK', content: { [r.produces || 'application/json']: r.paged ? { schema: page } : {} } },
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
          Problem: {
            type: 'object',
            required: ['type', 'title', 'status', 'detail'],
            properties: {
              type: { type: 'string' }, title: { type: 'string' }, status: { type: 'integer' }, detail: { type: 'string' }, instance: { type: 'string' },
              problems: { type: 'array', description: 'What doesn\'t fit in settings', items: { type: 'object', properties: { path: { type: 'string' }, message: { type: 'string' } } } },
              findings: { type: 'array', description: 'What a package\'s lint found' },
              plan: { type: 'object', description: 'An upgrade\'s plan, to review before confirming' },
            },
          },
        },
      },
    };
  }

  return { route, openapi, paginate, routes, problem };
}
