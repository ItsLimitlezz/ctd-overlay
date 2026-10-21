// What a connector instance gets (06 §6.1): everything it may do, and nothing else. Each context
// belongs to one start of one connection (a generation): once that instance is stopped, its
// context still answers but changes nothing, so a late timer or a request coming back after a
// restart can't publish into the new one.
//
//   ctx.connection   { id, name, connector, config (defaults applied), secrets } (frozen copies)
//   ctx.platform     the definition's main platform
//   ctx.publish(type, data, { platform, dedupeKey, backfill, profile })   an event (names.js decides
//                            which); profile: for one of the streams it follows at its service (a
//                            CTD Relay profile), a feed of its own that overlays are bound
//                            to as "<connection>/<profile>" (bus/owners.js)
//   ctx.room(n?)             resolves once n more events (1) may be published this second
//   ctx.recentChat({ profile }?)   this connection's (that feed's) chat messages still in the chat
//                            buffer, oldest first
//   ctx.setState(key, value, { platform, profile })              state; undefined removes it
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
//   ctx.setInfo(key, value)  what it tells about itself, on the connection (`info`, 16 KiB): the
//                            profile it follows, what it shares; kept through an error
//   ctx.suggestName(name)    the connection's name, while nobody has named it (records.js)
//   ctx.overlays             for a definition that sharesOverlays: the overlays bound to it, their
//                            URLs for OBS, and making one (share.js)
import { MEMORY_BYTES } from './records.js';
import { LIMITS } from './runner.js';
import { namesOf } from './names.js';

const HEALTH_FROM_CONNECTOR = new Set(['connected', 'degraded', 'connecting']);
const QUIET = new Set(['chat.message.deleted', 'chat.user.cleared', 'chat.cleared']); // moderation

export function makeContext(runner, gen, { def, config, secrets }) {
  const live = () => runner.current(gen);
  const names = namesOf(def);
  const env = runner.env;
  // profile: a feed of this connection (a CTD Relay profile it follows, bus/owners.js).
  const src = (platform, profile) => ({ connector: def.id, connection: runner.id, ...(platform ? { platform } : {}), ...(profile ? { profile } : {}) });
  const profileFor = (profile) => {
    if (profile === undefined || profile === null) return undefined;
    if (typeof profile !== 'string' || !/^[^\s/]{1,100}$/.test(profile)) throw new TypeError(`"${profile}" isn't a profile id (no spaces or "/", at most 100 characters).`);
    return profile;
  };
  const scrubbed = (fn) => (msg, context) => fn(runner.scrub(msg), context === undefined ? undefined : runner.scrubDeep(context));
  const log = { debug: scrubbed(env.log.debug), info: scrubbed(env.log.info), warn: scrubbed(env.log.warn), error: scrubbed(env.log.error) };

  function platformFor(platform, key) {
    const p = platform ?? (key ? names.platformOf(key) : undefined) ?? def.platform;
    if (p !== undefined) names.platform(p);
    return p;
  }

  // A guard against a connector at fault, not a feature: at most 200 events a second that overlays
  // play as they arrive, and 5000 that they don't (moderation, and history going into the chat
  // buffer: a whole /clear or a whole replay at once). Past that publish throws, which fails the
  // instance (a webhook gets a 500 and sends it again), so nothing is lost without anyone
  // knowing: the event isn't marked seen, and a connector that keeps a cursor hasn't moved it.
  // A connector reading a fast feed waits for room (ctx.room) instead.
  const budget = (quiet) => {
    const w = quiet ? runner.quietWindow : runner.publishWindow;
    const t = env.now();
    if (t - w.start >= 1000) Object.assign(w, { start: t, count: 0 });
    return w;
  };
  function admit(quiet) {
    const w = budget(quiet);
    const limit = quiet ? LIMITS.quietPerSecond : LIMITS.publishPerSecond;
    if (w.count >= limit) throw Object.assign(new Error(`It tried to publish more than ${limit} events in one second; the rest were refused.`), { code: 'flood' });
    w.count++;
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

    publish(type, data = {}, { platform, dedupeKey, backfill = false, profile } = {}) {
      names.event(type);
      const p = platformFor(platform);
      const feed = profileFor(profile);
      if (!live()) return undefined;
      const keyed = dedupeKey !== undefined && dedupeKey !== null;
      if (keyed && runner.dedupe.has(dedupeKey)) return undefined;
      const history = backfill && type === 'chat.message';
      admit(history || QUIET.has(type));
      const out = env.bus.publish(type, data, { src: src(p, feed), backfill: history });
      // Marked seen only once it is published: one that was refused can come again.
      if (keyed) runner.dedupe.seen(dedupeKey);
      runner.health.event();
      return out;
    },

    room(n = 1) {
      const w = budget(false);
      if (w.count + n <= LIMITS.publishPerSecond) return Promise.resolve();
      return new Promise((resolve) => {
        const t = env.timers.setTimeout(resolve, Math.max(0, w.start + 1000 - env.now()));
        t?.unref?.();
      });
    },

    // Copies, so a connector can work out what a moderation event removes (the lines a platform's
    // /clear takes, say) from what overlays may still show, across restarts of its instance.
    // profile: one feed's only.
    recentChat: ({ profile } = {}) => env.bus.chatRecent().filter((m) => m.src?.connection === runner.id && (profile === undefined || m.src.profile === profile)).map((m) => structuredClone(m.data)),

    setState(key, value, { platform, profile } = {}) {
      names.state(key);
      const p = platformFor(platform, key);
      const feed = profileFor(profile);
      if (!live()) return undefined;
      return env.bus.setState(key, value, { src: src(p, feed) });
    },

    hold(keys) {
      if (!live()) return;
      runner.hold(keys === undefined ? undefined : [].concat(keys));
    },

    // A stopped instance only asks: what it has seen it never published.
    seen: (key) => (live() ? runner.dedupe.seen(key) : runner.dedupe.has(key)),

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

    setInfo(key, value) {
      if (typeof key !== 'string' || !/^[a-z][A-Za-z0-9]{0,39}$/.test(key)) throw new TypeError(`"${key}" isn't a name for ctx.setInfo (camelCase).`);
      runner.setInfo(gen, key, value);
    },
    suggestName(name) {
      if (live() && typeof name === 'string') env.suggestName?.(runner.id, name);
    },
    overlays: def.sharesOverlays && env.share ? overlaysFor(runner, gen, live, env) : undefined,

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

// ctx.overlays: share.js's capability for this connection, through this instance only: a listener
// it adds ends when it stops, and a stopped instance makes nothing.
function overlaysFor(runner, gen, live, env) {
  const share = env.share.forConnection({ id: runner.id, get name() { return runner.doc.data.name; } });
  return Object.freeze({
    get baseUrl() { return share.baseUrl; },
    get baseProblem() { return share.baseProblem; },
    list: () => share.list(),
    onChange(fn) {
      if (!live()) return () => {};
      const off = share.onChange(() => {
        if (!live()) return;
        try { fn(); } catch (err) { runner.failNow(gen, err); }
      });
      runner.disposers.add(off);
      return () => { off(); runner.disposers.delete(off); };
    },
    create(spec) {
      if (!live()) throw new Error('The connection stopped.');
      return share.create(spec);
    },
  });
}

function deepFreeze(o) {
  if (o && typeof o === 'object') {
    for (const v of Object.values(o)) deepFreeze(v);
    Object.freeze(o);
  }
  return o;
}
