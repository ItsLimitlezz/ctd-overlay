// What a connector instance gets (06 §6.1): everything it may do, and nothing else. Each context
// belongs to one start of one connection (a generation): once that instance is stopped, its
// context still answers but changes nothing, so a late timer or a request coming back after a
// restart can't publish into the new one.
//
//   ctx.connection   { id, name, connector, config (defaults applied), secrets } (frozen copies)
//   ctx.platform     the definition's main platform
//   ctx.publish(type, data, { platform, dedupeKey, backfill })   an event (names.js decides which)
//   ctx.setState(key, value, { platform })                       state; undefined removes it
//   ctx.hold(keys?)          an error for these values (all by default): held 120 s, marked stale
//   ctx.seen(key)            true for a message id seen in the last 10 minutes (else remembers it)
//   ctx.setHealth({ status: connected | degraded | connecting, detail, warnings, quota })
//   ctx.event()              an event arrived (health.lastEventAt)
//   ctx.saveTokens(set, account?)   tokens the connector obtained itself, kept encrypted
//   ctx.auth                 { hasUser, accessToken(), appToken() }
//   ctx.http                 { request(url, opts) } (http.js)
//   ctx.schedule(ms, fn) → cancel · ctx.every(ms, fn) → cancel · ctx.wrap(fn) → guarded fn
//   ctx.fail(err, { retryAfterMs, retry })   give up this start: held, then started again
//   ctx.reauth(detail)       a credential the service refuses: needs-reauth until it is changed
//   ctx.signal               aborted when the instance stops
//   ctx.now()                the platform's clock (a test's, in tests)
//   ctx.memory               { get(key), set(key, value) }: kept between starts (16 KiB)
//   ctx.quota                { use(n), exhausted({ resetsAt, detail }), set({ used, limit, resetsAt }) }
//   ctx.log                  a logger that takes the connection's secrets out of every line
//   ctx.endpoints            the definition's base URLs (a test's fake service's, in tests)
//   ctx.publicUrl            SKP_PUBLIC_URL, when set
//   ctx.inbound              { url, available }: where the service delivers (POST /hooks/…)
import { MEMORY_BYTES } from './records.js';
import { LIMITS } from './runner.js';
import { namesOf } from './names.js';

const HEALTH_FROM_CONNECTOR = new Set(['connected', 'degraded', 'connecting']);

export function makeContext(runner, gen, { def, config, secrets }) {
  const live = () => runner.current(gen);
  const names = namesOf(def);
  const env = runner.env;
  const src = (platform) => ({ connector: def.id, connection: runner.id, ...(platform ? { platform } : {}) });
  const scrubbed = (fn) => (msg, context) => fn(runner.scrub(msg), context === undefined ? undefined : runner.scrubDeep(context));
  const log = { debug: scrubbed(env.log.debug), info: scrubbed(env.log.info), warn: scrubbed(env.log.warn), error: scrubbed(env.log.error) };

  function platformFor(platform, key) {
    const p = platform ?? (key ? names.platformOf(key) : undefined) ?? def.platform;
    if (p !== undefined) names.platform(p);
    return p;
  }

  // At most 200 events a second from one instance: past that a flood is a bug, and dropped.
  function admit() {
    const w = runner.publishWindow;
    const t = env.now();
    if (t - w.start >= 1000) Object.assign(w, { start: t, count: 0, warned: false });
    if (++w.count <= LIMITS.publishPerSecond) return true;
    if (!w.warned) {
      w.warned = true;
      env.log.warn('a connection published more than 200 events in a second; the rest of that second was dropped', { connection: runner.id });
    }
    return false;
  }

  const ctx = {
    connection: Object.freeze({ id: runner.id, name: runner.doc.data.name, connector: def.id, config: deepFreeze(structuredClone(config)), secrets: Object.freeze({ ...secrets }) }),
    platform: def.platform,
    endpoints: Object.freeze({ ...env.endpointsOf(def) }),
    publicUrl: env.publicUrl,
    inbound: Object.freeze({ url: env.inboundUrl(def, runner.id), available: Boolean(env.publicUrl) }),
    signal: runner.controller.signal,
    log,
    now: () => env.now(),

    publish(type, data = {}, { platform, dedupeKey, backfill = false } = {}) {
      names.event(type);
      const p = platformFor(platform);
      if (!live()) return undefined;
      if (dedupeKey !== undefined && dedupeKey !== null && runner.dedupe.seen(dedupeKey)) return undefined;
      if (!admit()) return undefined;
      runner.health.event();
      return env.bus.publish(type, data, { src: src(p), backfill: backfill && type === 'chat.message' });
    },

    setState(key, value, { platform } = {}) {
      names.state(key);
      const p = platformFor(platform, key);
      if (!live()) return undefined;
      return env.bus.setState(key, value, { src: src(p) });
    },

    hold(keys) {
      if (!live()) return;
      runner.hold(keys === undefined ? undefined : [].concat(keys));
    },

    seen: (key) => runner.dedupe.seen(key),

    setHealth({ status, detail, warnings, quota } = {}) {
      if (status !== undefined && !HEALTH_FROM_CONNECTOR.has(status)) throw new TypeError(`A connector sets its health to connected, degraded or connecting; "${status}" comes from ctx.fail() or ctx.reauth().`);
      if (!live()) return;
      runner.health.set({ status, detail, warnings, quota });
    },
    event() { if (live()) runner.health.event(); },

    async saveTokens(set, account) {
      if (!live()) return;
      if (!runner.tokens) throw new TypeError(`${def.name} has no sign-in to save tokens for.`);
      runner.tokens.save(set);
      if (account) env.records.setAccount(runner.id, account);
    },

    auth: Object.freeze({
      hasUser: () => Boolean(runner.tokens?.hasUser()),
      accessToken: () => runner.tokens ? runner.tokens.accessToken() : Promise.reject(new TypeError(`${def.name} has no sign-in.`)),
      appToken: () => runner.tokens ? runner.tokens.appToken() : Promise.reject(new TypeError(`${def.name} has no app sign-in.`)),
    }),

    http: Object.freeze({
      request: (url, opts) => (live() ? runner.http.request(url, opts) : Promise.reject(Object.assign(new Error('The connection stopped.'), { code: 'stopped' }))),
    }),

    schedule(ms, fn) {
      if (!live()) return () => {};
      const h = runner.timer(gen, ms, fn);
      return () => runner.clearTimer(h);
    },
    every(ms, fn) {
      if (!live()) return () => {};
      const h = runner.timer(gen, ms, fn, false, true);
      return () => runner.clearTimer(h);
    },
    // A callback for something outside the platform's timers (a socket's events): a throw or a
    // rejection fails this instance instead of the process (H11).
    wrap(fn) {
      return (...args) => {
        if (!live()) return undefined;
        try {
          const out = fn(...args);
          if (out && typeof out.then === 'function') out.then(undefined, (err) => runner.failNow(gen, err));
          return out;
        } catch (err) {
          runner.failNow(gen, err);
          return undefined;
        }
      };
    },
    fail(err, opts) { runner.failNow(gen, err instanceof Error ? err : new Error(String(err)), opts); },
    reauth(detail) { runner.reauthNow(gen, String(detail || 'The service refused the credentials: enter them again.')); },

    memory: Object.freeze({
      get: (key) => {
        const v = runner.memory.data[key];
        return v === undefined ? undefined : structuredClone(v);
      },
      set: (key, value) => {
        if (!live()) return;
        const next = { ...runner.memory.data };
        if (value === undefined) delete next[key];
        else next[key] = structuredClone(value);
        if (Buffer.byteLength(JSON.stringify(next)) > MEMORY_BYTES) throw new TypeError(`A connection keeps at most ${MEMORY_BYTES / 1024} KiB between starts.`);
        runner.memory.data = next;
        runner.memoryChanged();
      },
    }),

    quota: Object.freeze({
      use: (n = 1) => runner.useQuota(n),
      exhausted({ resetsAt, detail } = {}) {
        const t = typeof resetsAt === 'number' ? resetsAt : Date.parse(resetsAt);
        runner.pauseUntil(gen, Number.isFinite(t) ? t : env.now() + 60 * 60 * 1000, detail);
      },
      set({ used, limit, resetsAt } = {}) {
        const q = { ...(runner.memory.quota || {}) };
        if (Number.isInteger(used)) q.used = used;
        if (Number.isInteger(limit)) q.limit = limit;
        if (resetsAt !== undefined) q.resetsAt = new Date(typeof resetsAt === 'number' ? resetsAt : Date.parse(resetsAt)).toISOString();
        runner.memory.quota = q;
        runner.memoryChanged();
        if (live()) runner.health.set({ quota: q });
      },
      state: () => structuredClone(runner.memory.quota || {}),
    }),
  };
  return Object.freeze(ctx);
}

function deepFreeze(o) {
  if (o && typeof o === 'object') {
    for (const v of Object.values(o)) deepFreeze(v);
    Object.freeze(o);
  }
  return o;
}
