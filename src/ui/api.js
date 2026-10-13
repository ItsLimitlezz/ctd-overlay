// The admin UI's only way to the platform: the public API (03), signed in with the session cookie.
// A change sends the session's CSRF token (07 §7.3), and an edit of a resource sends If-Match
// with the ETag it was read with (H16), so a change made meanwhile is a 412, never overwritten.

export class ApiProblem extends Error {
  constructor(status, body) {
    super(body?.detail || body?.title || `The request failed (${status}).`);
    this.name = 'ApiProblem';
    this.status = status;
    this.code = typeof body?.type === 'string' && body.type.startsWith('https://skp.dev/errors/') ? body.type.slice(23) : undefined;
    this.body = body || {};
  }
}

let csrf;
const listeners = new Set();
export const setCsrf = (token) => { csrf = token; };
// onUnauthenticated(fn): told when a request finds the session gone (a 401), so the app can sign in again.
export const onUnauthenticated = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

// The ETag of a resource the API answered with ({ id, rev }), for If-Match.
export const etagOf = (resource) => (resource && resource.id && Number.isInteger(resource.rev) ? `"${resource.id}-r${resource.rev}"` : undefined);

const SAFE = new Set(['GET', 'HEAD']);

// The server's clock, from the Date header of its answers: countdowns run in server time (08 §8.4).
// The header has whole seconds, so a difference under 1.5 s is taken as none.
let skew = 0;
export const serverNow = () => Date.now() + skew;
function noteServerDate(header, sentAt, receivedAt) {
  const server = Date.parse(header || '');
  if (!Number.isFinite(server)) return;
  // The server's Date floors to its second; mid-second is the best guess.
  const estimate = server + 500 - (sentAt + receivedAt) / 2;
  skew = Math.abs(estimate) < 1500 ? 0 : estimate;
}

// request(method, path, { body, ifMatch, raw, contentType, query, signal }):
//   body     JSON-encoded unless raw (a Blob, File or ArrayBuffer, sent as is with contentType)
//   ifMatch  a resource ({ id, rev }) or an ETag string
//   query    an object added to the path's query string (undefined values left out)
// Resolves with the parsed JSON (or undefined for an empty answer); rejects with ApiProblem.
export async function request(method, path, opts = {}) {
  const { body, ifMatch, raw, contentType, query, signal } = opts;
  let url = path;
  if (query) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
    const s = qs.toString();
    if (s) url += (url.includes('?') ? '&' : '?') + s;
  }
  const headers = { accept: 'application/json, application/problem+json' };
  if (!SAFE.has(method) && csrf) headers['x-skp-csrf'] = csrf;
  const tag = typeof ifMatch === 'string' ? ifMatch : etagOf(ifMatch);
  if (tag) headers['if-match'] = tag;
  let payload;
  if (raw !== undefined) {
    payload = raw;
    headers['content-type'] = contentType || raw.type || 'application/octet-stream';
  } else if (body !== undefined) {
    payload = JSON.stringify(body);
    headers['content-type'] = 'application/json';
  }
  let res;
  const sentAt = Date.now();
  try {
    res = await fetch(url, { method, headers, body: payload, credentials: 'same-origin', cache: 'no-store', signal });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    throw new ApiProblem(0, { title: 'Offline', detail: 'The platform could not be reached. Check the connection; this retries on its own where it can.' });
  }
  noteServerDate(res.headers.get('date'), sentAt, Date.now());
  const text = await res.text();
  let data;
  if (text) {
    try { data = JSON.parse(text); } catch { data = { detail: text.slice(0, 300) }; }
  }
  if (!res.ok) {
    const problem = new ApiProblem(res.status, data);
    if (res.status === 401 && !path.startsWith('/api/v1/auth/login') && !path.startsWith('/api/v1/setup')) for (const fn of listeners) fn(problem);
    throw problem;
  }
  return data;
}

export const get = (path, opts) => request('GET', path, opts);
export const post = (path, body, opts) => request('POST', path, { ...opts, body: body ?? {} });
export const put = (path, body, opts) => request('PUT', path, { ...opts, body: body ?? {} });
export const patch = (path, body, opts) => request('PATCH', path, { ...opts, body: body ?? {} });
export const del = (path, opts) => request('DELETE', path, opts);

// Every item of a paged list ({ items, next }), following its cursors.
export async function all(path, { query, signal, max = 5000 } = {}) {
  const items = [];
  let cursor;
  do {
    const page = await get(path, { query: { ...query, limit: 200, cursor }, signal });
    items.push(...(page?.items || []));
    cursor = page?.next;
  } while (cursor && items.length < max);
  return items;
}

// A path segment, encoded.
export const seg = (s) => encodeURIComponent(String(s));

// events(types, onEvent, { onStatus }): GET /api/v1/events as Server-Sent Events, reconnecting
// by itself (EventSource does). Each frame is named by its event type, so `types` lists exact
// types (["state.changed", "system.connection"]), no wildcards. Returns a stop function.
export function events(types, onEvent, { onStatus } = {}) {
  const url = `/api/v1/events?types=${encodeURIComponent(types.join(','))}`;
  let source;
  let stopped = false;
  let retry;
  const deliver = (e) => {
    let env;
    try { env = JSON.parse(e.data); } catch { return; }
    try { onEvent(env); } catch (err) { console.error(err); }
  };
  const open = () => {
    if (stopped) return;
    source = new EventSource(url, { withCredentials: true });
    source.onopen = () => onStatus?.('open');
    for (const type of types) source.addEventListener(type, deliver);
    source.onerror = () => {
      onStatus?.('reconnecting');
      // A refused stream (signed out, no permission) closes for good: try again later, gently.
      if (source.readyState === EventSource.CLOSED) {
        clearTimeout(retry);
        retry = setTimeout(open, 5000);
      }
    };
  };
  open();
  return () => {
    stopped = true;
    clearTimeout(retry);
    source?.close();
  };
}
