// A connection's health (06 §6.3): status, a plain-language detail, since when, the last event, a
// quota and warnings. Every change publishes system.connection (02 §2.6), an operator-only event
// (never sent to an overlay): at most one a second per connection, the latest state when the
// second ends, so a connection flapping can't flood the admin UI. The detail is scrubbed of the
// connection's secrets and cut to 300 characters: it is shown to operators as it is.
export const STATUSES = Object.freeze(['disabled', 'connecting', 'connected', 'degraded', 'needs-reauth', 'error']);
const DETAIL_CHARS = 300;
const WARNING_CHARS = 300;
const MAX_WARNINGS = 5;
const EMIT_MS = 1000;

export function createHealth({ connection, now = Date.now, timers, publish, scrub = (s) => s, log }) {
  let h = { status: 'disabled', since: now(), warnings: [] };
  let sent; // the state at the last system.connection
  let lastEmit = -Infinity;
  let timer = null;
  let closed = false;

  const clean = (s, n) => (typeof s === 'string' && s.trim() ? scrub(s.trim()).slice(0, n) : undefined);

  function payload(prev) {
    return {
      connection: connection.id,
      connector: connection.connector,
      name: connection.name,
      status: h.status,
      ...(prev && prev !== h.status ? { prev } : {}),
      ...(h.detail ? { detail: h.detail } : {}),
      since: new Date(h.since).toISOString(),
      ...(h.lastEventAt ? { lastEventAt: new Date(h.lastEventAt).toISOString() } : {}),
      ...(h.quota ? { quota: h.quota } : {}),
      warnings: [...h.warnings],
    };
  }

  function emit() {
    timer = null;
    if (closed) return;
    lastEmit = now();
    const prev = sent?.status;
    sent = { status: h.status, detail: h.detail, warnings: h.warnings.join('\n'), quota: JSON.stringify(h.quota) };
    try { publish(payload(prev)); } catch (err) { log?.error('system.connection could not be published', { connection: connection.id, err: err.message }); }
  }

  function changed() {
    if (closed || timer) return;
    const wait = lastEmit + EMIT_MS - now();
    if (wait <= 0) emit();
    else {
      timer = timers.setTimeout(emit, wait);
      timer?.unref?.();
    }
  }

  return {
    // { status?, detail?, warnings?, quota? }: what is given changes; a new status starts `since`.
    // detail: undefined keeps it unless the status changes (a new status starts without one).
    set({ status, detail, warnings, quota } = {}) {
      const next = { ...h };
      if (status !== undefined && status !== h.status) {
        if (!STATUSES.includes(status)) throw new TypeError(`"${status}" isn't a health status (${STATUSES.join(', ')}).`);
        next.status = status;
        next.since = now();
        delete next.detail;
      }
      if (detail !== undefined) {
        const d = clean(detail, DETAIL_CHARS);
        if (d) next.detail = d;
        else delete next.detail;
      }
      if (warnings !== undefined) next.warnings = (Array.isArray(warnings) ? warnings : [warnings]).map((w) => clean(w, WARNING_CHARS)).filter(Boolean).slice(0, MAX_WARNINGS);
      if (quota !== undefined) {
        if (quota === null) delete next.quota;
        else next.quota = cleanQuota(quota);
      }
      const moved = next.status !== h.status || next.detail !== h.detail || next.warnings.join('\n') !== h.warnings.join('\n') || JSON.stringify(next.quota) !== JSON.stringify(h.quota);
      h = next;
      if (moved) changed();
    },
    // An event arrived: lastEventAt moves, quietly (it rides on the next change).
    event() { h.lastEventAt = now(); },
    get status() { return h.status; },
    get since() { return h.since; },
    view() {
      const { connection: _c, connector: _k, name: _n, prev: _p, ...rest } = payload();
      return rest;
    },
    // The name changed (a PATCH): later events carry it.
    rename(name) { connection.name = name; },
    close() {
      closed = true;
      if (timer) timers.clearTimeout(timer);
      timer = null;
    },
  };
}

function cleanQuota(q) {
  const out = {};
  if (Number.isInteger(q.used)) out.used = q.used;
  if (Number.isInteger(q.limit)) out.limit = q.limit;
  if (q.resetsAt !== undefined) {
    const t = typeof q.resetsAt === 'number' ? q.resetsAt : Date.parse(q.resetsAt);
    if (Number.isFinite(t)) out.resetsAt = new Date(t).toISOString();
  }
  return out;
}
