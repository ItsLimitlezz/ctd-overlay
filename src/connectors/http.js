// The HTTP client every connector uses (06 §6.1: "timeouts, retries, 429 handling built in"), so
// each connector gets the same manners towards services without writing them again:
//
//   const { status, headers, data } = await ctx.http.request(url, {
//     method, query, headers, json | form | body, auth: 'user' | 'app' | 'none',
//     idempotent, retries, timeoutMs (10 s), expect: 'json' | 'text' | 'stream' | 'none',
//     maxBytes (1 MiB), quota (units, 06 §6.7), egress: 'service' | 'lan' | 'public', tls, signal,
//     acceptStatus: (status) => bool  a 4xx to answer rather than throw (OAuth's error bodies) })
//
// - Retries only what is safe to send twice: GET, HEAD, PUT, DELETE and OPTIONS, or a request
//   marked idempotent. At most 2, after 1 s and 2 s (±20 %), on a network error (not a name that
//   doesn't exist), 500, 502, 503 or 504, and on 429 with a Retry-After of 30 s or less. Never a
//   POST, never a token refresh (oauth.js sends those with retries: 0).
// - 429: the service's whole origin cools down for its Retry-After (60 s without one): requests to
//   it fail at once until then, instead of making the limit worse.
// - 401 with auth 'user' or 'app': the token is refreshed once and the request sent again; a
//   second 401 for the user's token means it needs signing in again (needs-reauth, no loop).
// - A body over maxBytes is cut off (too-large); a request that takes over timeoutMs is dropped
//   (for a stream: until its headers arrive).
// - Egress (07 §7.11):
//     service  the connector's own service: https only (a test may point an endpoint at a local
//              http server; those origins are allowed by name);
//     lan      an address the operator typed (OBS, CTD Multi-Stream): resolved once and connected to
//              exactly that address; loopback and private addresses only over plain http;
//              link-local (cloud metadata), unspecified and multicast never. An https service with a
//              self-signed certificate is trusted by its SHA-256 fingerprint (tls.fingerprint256),
//              checked before a byte of the request (its token) is sent;
//     public   somewhere on the internet (outbound webhooks, step 21): https, public addresses only.
// - A redirect is an error: the services connectors call don't redirect, and following one could
//   carry a token somewhere else.
import http from 'node:http';
import https from 'node:https';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import tls from 'node:tls';
import { isPrivateAddress, normalizeIp } from '../net.js';
import { nextDelay, parseRetryAfter } from './backoff.js';

export const HTTP_DEFAULTS = Object.freeze({ timeoutMs: 10000, maxBytes: 1024 * 1024, retries: 2, perSecond: 20, coolDownMs: 60000, retryAfterMaxMs: 30000 });
const IDEMPOTENT = new Set(['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS']);
const RETRY_STATUS = new Set([500, 502, 503, 504]);
const EXCERPT_CHARS = 300;

export class HttpError extends Error {
  constructor(message, { status, code = 'http-error', retryAfterMs, excerpt } = {}) {
    super(message);
    this.name = 'HttpError';
    if (status !== undefined) this.status = status;
    this.code = code;
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
    if (excerpt) this.excerpt = excerpt;
  }
}

// Why an address may not be reached as an operator-typed (lan) destination, or undefined.
export function lanRefusal(ip) {
  const a = normalizeIp(ip);
  if (isIP(a) === 4) {
    const [x, y] = a.split('.').map(Number);
    if (x === 0) return 'an unspecified address';
    if (x === 169 && y === 254) return 'a link-local address (where cloud metadata services live)';
    if (x >= 224) return 'a multicast or reserved address';
    return undefined;
  }
  if (isIP(a) === 6) {
    if (a === '::') return 'an unspecified address';
    if (/^fe[89ab]/.test(a)) return 'a link-local address';
    if (a.startsWith('ff')) return 'a multicast address';
    return undefined;
  }
  return 'not an address';
}

const normFp = (s) => String(s || '').replace(/[^0-9a-f]/gi, '').toUpperCase();
const pathOf = (u) => `${u.origin}${u.pathname}`; // never the query: it may carry a token

// fetch: what 'service' requests go through (tests: a fake). lookup(host) → [{ address, family }]
// for 'lan' and 'public'. allowHttp: origins a test pointed an endpoint at. auth: { header(kind),
// refresh(kind), rejected(kind, reason) } from the connection's tokens. quota: { use(n) }.
// signal: the instance's (aborted when it stops). scrub(text): the connection's secrets taken out.
export function createHttpClient({ fetch = globalThis.fetch, lookup = defaultLookup, now = Date.now, timers = { setTimeout, clearTimeout }, signal, auth, quota, scrub = (s) => s, log, allowHttp = new Set(), random = Math.random, limits = {} } = {}) {
  const opts0 = { ...HTTP_DEFAULTS, ...limits };
  const coolDown = new Map(); // origin → until
  let windowStart = 0;
  let windowCount = 0;

  function sleep(ms, sig) {
    return new Promise((resolve, reject) => {
      if (sig?.aborted) return reject(stopped());
      const t = timers.setTimeout(() => { sig?.removeEventListener('abort', onAbort); resolve(); }, ms);
      const onAbort = () => { timers.clearTimeout(t); reject(stopped()); };
      sig?.addEventListener('abort', onAbort, { once: true });
    });
  }
  const stopped = () => new HttpError('The connection stopped while a request was under way.', { code: 'stopped' });

  // Where a request may go, and how to reach it: { via: 'fetch' } or { via: 'node', address, family }.
  async function route(u, egress) {
    if (u.username || u.password) throw new HttpError('An address with a user name or password in it is refused: put credentials in their own fields.', { code: 'egress' });
    if (egress === 'service') {
      if (u.protocol === 'https:' || (u.protocol === 'http:' && allowHttp.has(u.origin))) return { via: 'fetch' };
      throw new HttpError(`Only https:// is used to reach a service (${u.protocol}//${u.host}).`, { code: 'egress' });
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new HttpError(`${u.protocol} addresses can't be reached; use http:// or https://.`, { code: 'egress' });
    if (egress === 'public' && u.protocol !== 'https:') throw new HttpError('Only https:// is used to reach the internet.', { code: 'egress' });
    const host = u.hostname.replace(/^\[(.*)\]$/, '$1');
    let addresses;
    if (isIP(host)) addresses = [{ address: host, family: isIP(host) }];
    else {
      try {
        addresses = await lookup(host);
      } catch (err) {
        throw new HttpError(`${host} could not be found (${err.code || err.message}). Check the address.`, { code: err.code === 'ENOTFOUND' ? 'not-found' : 'network' });
      }
    }
    const ok = (a) => (egress === 'public'
      ? !isPrivateAddress(a.address)
      : !lanRefusal(a.address) && (u.protocol === 'https:' || isPrivateAddress(a.address)));
    const pick = (addresses || []).find(ok);
    if (!pick) {
      const first = addresses?.[0]?.address;
      const why = egress === 'public' ? `${host} is a private or local address`
        : first && lanRefusal(first) ? `${host} is ${lanRefusal(first)}, which is never reached`
          : `${host} is not on the local network, and plain http:// is used only there (use https://)`;
      throw new HttpError(`${why}.`, { code: 'egress' });
    }
    return { via: 'node', address: normalizeIp(pick.address), family: pick.family === 6 || pick.family === 'IPv6' ? 6 : 4 };
  }

  async function send(u, init, how, tlsOpts) {
    if (how.via === 'fetch') return fetch(u, { ...init, redirect: 'manual' });
    return sendNode(u, { ...init, address: how.address, family: how.family, fingerprint256: tlsOpts?.fingerprint256 });
  }

  async function request(url, opts = {}) {
    const method = String(opts.method || 'GET').toUpperCase();
    let u;
    try { u = new URL(url); } catch { throw new HttpError('That address is not a URL.', { code: 'egress' }); }
    for (const [k, v] of Object.entries(opts.query || {})) if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
    const egress = opts.egress || 'service';
    const expect = opts.expect || 'json';
    const timeoutMs = opts.timeoutMs ?? opts0.timeoutMs;
    const maxBytes = opts.maxBytes ?? opts0.maxBytes;
    const idempotent = opts.idempotent ?? IDEMPOTENT.has(method);
    const retries = idempotent ? (opts.retries ?? opts0.retries) : 0;
    if (signal?.aborted || opts.signal?.aborted) throw stopped();

    const until = coolDown.get(u.origin);
    if (until !== undefined) {
      if (until > now()) throw new HttpError(`${u.host} asked for a pause (429); requests to it wait until it ends.`, { status: 429, code: 'rate-limited', retryAfterMs: until - now() });
      coolDown.delete(u.origin);
    }
    const t = now();
    if (t - windowStart >= 1000) { windowStart = t; windowCount = 0; }
    if (++windowCount > opts0.perSecond) throw new HttpError(`More than ${opts0.perSecond} requests a second from one connection: slow down.`, { code: 'rate-limited' });
    if (opts.quota) quota?.use(opts.quota);

    const how = await route(u, egress);
    const headers = { 'user-agent': 'StreamKitPlatform (+https://skp.dev)', accept: expect === 'json' ? 'application/json' : '*/*', ...(opts.headers || {}) };
    let body = opts.body;
    if (opts.json !== undefined) {
      body = JSON.stringify(opts.json);
      headers['content-type'] = 'application/json';
    } else if (opts.form !== undefined) {
      body = new URLSearchParams(Object.entries(opts.form).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)])).toString();
      headers['content-type'] = 'application/x-www-form-urlencoded';
    }
    const kind = opts.auth || 'none';

    let replayed = false;
    for (let attempt = 0; ; attempt++) {
      if (kind !== 'none') headers.authorization = await auth.header(kind);
      const ctrl = new AbortController();
      let timedOut = false;
      const onStop = () => ctrl.abort();
      signal?.addEventListener('abort', onStop, { once: true });
      opts.signal?.addEventListener('abort', onStop, { once: true });
      const timer = timers.setTimeout(() => { timedOut = true; ctrl.abort(); }, timeoutMs);
      const done = () => {
        timers.clearTimeout(timer);
        signal?.removeEventListener('abort', onStop);
        opts.signal?.removeEventListener('abort', onStop);
      };
      let res;
      try {
        res = await send(u, { method, headers, body, signal: ctrl.signal }, how, opts.tls);
      } catch (err) {
        done();
        if (signal?.aborted || opts.signal?.aborted) throw stopped();
        if (err instanceof HttpError) throw err;
        const code = err.cause?.code || err.code;
        const nxdomain = code === 'ENOTFOUND' || code === 'EAI_NONAME';
        const what = timedOut ? `${method} ${pathOf(u)} took longer than ${Math.round(timeoutMs / 1000)} s` : `${method} ${pathOf(u)} failed (${code || err.message})`;
        if (!nxdomain && attempt < retries) {
          await sleep(nextDelay(attempt, { random }), signal);
          continue;
        }
        throw new HttpError(`${scrub(what)}.`, { code: timedOut ? 'timeout' : nxdomain ? 'not-found' : 'network' });
      }

      const status = res.status;
      // 401 on a token we hold: refresh it once and send again (06 §6.1).
      if (status === 401 && kind !== 'none') {
        await discard(res);
        done();
        if (!replayed) {
          replayed = true;
          await auth.refresh(kind);
          attempt--;
          continue;
        }
        auth.rejected?.(kind, `${u.host} refused the ${kind === 'user' ? 'account\'s' : 'app\'s'} token twice (401)`);
        throw new HttpError(`${u.host} refused the token (401): sign in again.`, { status, code: kind === 'user' ? 'needs-reauth' : 'unauthorized' });
      }
      if (status === 429) {
        await discard(res);
        done();
        const wait = parseRetryAfter(res.headers.get('retry-after'), now()) ?? opts0.coolDownMs;
        if (attempt < retries && wait <= opts0.retryAfterMaxMs) {
          await sleep(wait, signal);
          continue;
        }
        coolDown.set(u.origin, now() + wait);
        log?.warn('a service asked for a pause (429)', { host: u.host, waitMs: wait });
        throw new HttpError(`${u.host} is limiting requests (429): waiting ${Math.ceil(wait / 1000)} s.`, { status, code: 'rate-limited', retryAfterMs: wait });
      }
      if (RETRY_STATUS.has(status) && attempt < retries) {
        await discard(res);
        done();
        const ra = parseRetryAfter(res.headers.get('retry-after'), now());
        await sleep(ra !== undefined && ra <= opts0.retryAfterMaxMs ? ra : nextDelay(attempt, { random }), signal);
        continue;
      }
      if (status >= 300 && !(status >= 400 && opts.acceptStatus?.(status))) {
        const excerpt = await excerptOf(res).catch(() => undefined);
        done();
        const code = status >= 300 && status < 400 ? 'redirect' : status >= 500 ? 'server-error' : 'http-error';
        const ra = parseRetryAfter(res.headers.get('retry-after'), now());
        throw new HttpError(`${method} ${pathOf(u)} answered ${status}${excerpt ? `: ${scrub(excerpt)}` : ''}.`, { status, code, ...(ra !== undefined ? { retryAfterMs: ra } : {}), ...(excerpt ? { excerpt: scrub(excerpt) } : {}) });
      }

      if (expect === 'stream') {
        done(); // the timeout covered the headers; the body is the caller's to read (or abort)
        return { status, headers: res.headers, body: res.body };
      }
      try {
        if (expect === 'none') {
          await discard(res);
          return { status, headers: res.headers };
        }
        const bytes = await readCapped(res, maxBytes, u);
        const text = bytes.toString('utf8');
        if (expect === 'text') return { status, headers: res.headers, data: text };
        let data;
        if (text.trim()) {
          try { data = JSON.parse(text); } catch { throw new HttpError(`${pathOf(u)} answered something that isn't JSON.`, { status, code: 'bad-response' }); }
        }
        return { status, headers: res.headers, data };
      } catch (err) {
        if (signal?.aborted || opts.signal?.aborted) throw stopped();
        if (timedOut) throw new HttpError(`${method} ${pathOf(u)} took longer than ${Math.round(timeoutMs / 1000)} s.`, { code: 'timeout' });
        if (err instanceof HttpError) throw err;
        throw new HttpError(`${method} ${pathOf(u)} broke off (${err.code || err.message}).`, { code: 'network' });
      } finally {
        done();
      }
    }
  }

  return { request };
}

async function discard(res) {
  try { await res.body?.cancel(); } catch { /* already gone */ }
}

async function readCapped(res, maxBytes, u) {
  if (!res.body) return Buffer.alloc(0);
  const declared = Number(res.headers.get('content-length'));
  const big = () => new HttpError(`${pathOf(u)} answered more than ${Math.round(maxBytes / 1024)} KiB.`, { status: res.status, code: 'too-large' });
  if (declared > maxBytes) {
    await discard(res);
    throw big();
  }
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      throw big();
    }
    chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
  }
  return Buffer.concat(chunks);
}

// The start of an error answer, as text, for the operator (scrubbed by the caller).
async function excerptOf(res) {
  if (!res.body) return undefined;
  const reader = res.body.getReader();
  let text = '';
  const decoder = new TextDecoder();
  while (text.length < 2048) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  await reader.cancel().catch(() => {});
  let out = text;
  try {
    const j = JSON.parse(text);
    out = j.detail || j.error_description || j.message || (typeof j.error === 'string' ? j.error : j.error?.message) || text;
  } catch { /* plain text */ }
  const line = String(out).replace(/\s+/g, ' ').trim();
  return line ? line.slice(0, EXCERPT_CHARS) : undefined;
}

async function defaultLookup(host) {
  return dnsLookup(host, { all: true, verbatim: true });
}

// A request over node:http(s) to an address already checked, so DNS can't move it elsewhere (the
// lookup answers that address only). With a fingerprint, the TLS handshake is made and the
// certificate checked first; the request (and its token) goes only over that verified socket.
function sendNode(u, { method, headers, body, signal, address, family, fingerprint256 }) {
  return new Promise((resolve, reject) => {
    const secure = u.protocol === 'https:';
    const host = u.hostname.replace(/^\[(.*)\]$/, '$1');
    const port = Number(u.port) || (secure ? 443 : 80);
    const pinned = (_name, options, cb) => (options?.all ? cb(null, [{ address, family }]) : cb(null, address, family));
    const answer = (res) => {
      const list = [];
      for (const [k, v] of Object.entries(res.headers)) list.push([k, Array.isArray(v) ? v.join(', ') : String(v)]);
      const empty = [204, 205, 304].includes(res.statusCode) || method === 'HEAD';
      if (empty) res.resume();
      if (res.statusCode < 200 || res.statusCode > 599) {
        res.resume();
        reject(new HttpError(`${pathOf(u)} answered ${res.statusCode}.`, { status: res.statusCode, code: 'bad-response' }));
        return;
      }
      resolve(new Response(empty ? null : Readable.toWeb(res), { status: res.statusCode, headers: list }));
    };
    const go = (socket) => {
      // With createConnection there must be no agent (an agent makes its own socket).
      const options = {
        hostname: host, port, path: `${u.pathname}${u.search}`, method, headers, signal,
        ...(socket ? { createConnection: () => socket } : { agent: false, lookup: pinned, ...(secure ? { servername: isIP(host) ? undefined : host } : {}) }),
      };
      const req = (secure && !socket ? https : http).request(options, answer);
      req.on('error', reject);
      req.end(body);
    };
    if (!secure || !fingerprint256) return go();
    const s = tls.connect({ host: address, port, servername: isIP(host) ? undefined : host, rejectUnauthorized: false });
    const onAbort = () => s.destroy(new Error('aborted'));
    signal?.addEventListener('abort', onAbort, { once: true });
    s.once('error', (err) => { signal?.removeEventListener('abort', onAbort); reject(err); });
    s.once('secureConnect', () => {
      signal?.removeEventListener('abort', onAbort);
      const fp = s.getPeerCertificate()?.fingerprint256;
      if (!fp || normFp(fp) !== normFp(fingerprint256)) {
        s.destroy();
        reject(new HttpError(`The certificate of ${u.host} doesn't match the fingerprint set for it: check it in the service's settings (someone else may be answering at that address).`, { code: 'tls-pin' }));
        return;
      }
      go(s);
    });
  });
}
