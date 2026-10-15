// One connection, running (06 §6.1, 01 §1.7). The runner owns everything a connector instance
// leans on, so the instance can fail, hang or throw without touching anything else:
//
// - start: the definition's create(ctx) and its start(), caught, with 30 s to finish; a failure
//   stops the instance, holds its values (02 §2.8) and starts it again after 1 s, 2 s, 4 s … 5 min
//   (±20 %), or after the service's own Retry-After (a day at most). 60 s connected starts the count
//   over. A problem with the settings is an error with no retry until they are edited; a missing or
//   refused sign-in is needs-reauth, never retried in a loop.
// - generations: each start has a number; a callback from an instance that has been stopped (a
//   timer, a late promise, a request coming back) finds an old number and changes nothing.
// - holds (H6): on an error every value the connection set is marked stale (<key>.stale) and kept
//   120 s, then removed, unless the connector set it again meanwhile. A deliberate stop (disable,
//   edit, delete) removes them at once. Nothing is ever replaced by 0.
// - timers the instance makes (ctx.schedule, ctx.every) are the runner's: they stop with it, and a
//   callback that throws fails the instance instead of the process.
// - operations (start, stop, reload) run one at a time, in order.
import { BusError } from '../bus/index.js';
import { validate } from '../schema.js';
import { BACKOFF, MAX_WAIT_MS, nextDelay } from './backoff.js';
import { makeContext } from './context.js';
import { createDedupe } from './dedupe.js';
import { ConnectorError } from './errors.js';
import { createHealth } from './health.js';
import { createHttpClient } from './http.js';
import { createOAuthClient } from './oauth.js';
import { fieldsOf, withDefaults } from './records.js';
import { createTokenManager } from './tokens.js';

export const LIMITS = Object.freeze({
  holdMs: 120000, // 02 §2.8
  startMs: 30000,
  stopMs: 5000,
  stableMs: 60000, // connected this long: the backoff starts over
  actionMs: 10000,
  testMs: 10000,
  memoryFlushMs: 5000,
  publishPerSecond: 200, // events overlays play as they arrive
  quietPerSecond: 5000, // moderation and backfill (context.js)
});
const SECRET_MIN = 8; // shorter values aren't scrubbed: "true" or "1234" would mangle every log line

// env: what the host shares with every runner (createConnectorHost builds it).
export class ConnectionRunner {
  constructor(env, doc) {
    this.env = env;
    this.id = doc.id;
    this.doc = doc;
    this.generation = 0;
    this.instance = null;
    this.ctx = null;
    this.running = false; // an instance is (being) started
    this.attempt = 0;
    this.closed = false;
    this.instanceTimers = new Set();
    this.holds = new Map(); // key → when its hold ends
    this.holdTimer = null;
    this.restartTimer = null;
    this.stableTimer = null;
    this.ops = Promise.resolve();
    this.dedupe = createDedupe({ now: env.now });
    this.publishWindow = { start: 0, count: 0 };
    this.quietWindow = { start: 0, count: 0 };
    this.stats = { inboundAccepted: 0, inboundRefused: 0 };
    this.secretValues = [];
    this.tokens = null;
    const mem = env.records.memoryOf(doc.id);
    this.memory = { data: mem.memory && typeof mem.memory === 'object' ? mem.memory : {}, quota: mem.quota, dirty: false, timer: null };
    this.health = createHealth({
      connection: { id: doc.id, connector: doc.data.connector, name: doc.data.name },
      now: env.now, timers: env.timers, scrub: (s) => this.scrub(s), log: env.log,
      publish: (payload) => env.publish('system.connection', payload),
    });
  }

  get def() { return this.env.registry.get(this.doc.data.connector); }
  get src() { return { connector: this.doc.data.connector, connection: this.id }; }
  current(gen) { return !this.closed && gen === this.generation && this.running; }

  // ---- scrubbing ---------------------------------------------------------------------------------
  scrub(text) {
    let s = String(text ?? '');
    for (const v of [...this.secretValues, ...(this.tokens?.values() || [])]) {
      if (typeof v === 'string' && v.length >= SECRET_MIN) s = s.split(v).join('[redacted]');
    }
    return s;
  }
  scrubDeep(value, depth = 0) {
    if (typeof value === 'string') return this.scrub(value);
    if (depth > 6 || value === null || typeof value !== 'object') return value;
    if (value instanceof Error) return { name: value.name, message: this.scrub(value.message), ...(value.code ? { code: value.code } : {}) };
    if (Array.isArray(value)) return value.map((v) => this.scrubDeep(v, depth + 1));
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.scrubDeep(v, depth + 1)]));
  }

  // ---- operations, one at a time -------------------------------------------------------------
  queue(fn) {
    const run = this.ops.then(fn, fn);
    this.ops = run.catch((err) => this.env.log.error('a connection operation failed', { connection: this.id, err: this.scrubDeep(err) }));
    return run;
  }
  start() { return this.queue(() => this.startNow()); }
  stop(opts) { return this.queue(() => this.stopNow(opts)); }
  reload(doc) {
    return this.queue(async () => {
      await this.stopNow({ deliberate: true });
      if (doc) this.doc = doc;
      this.health.rename(this.doc.data.name);
      this.attempt = 0;
      await this.startNow();
    });
  }
  rename(doc) {
    this.doc = doc;
    this.health.rename(doc.data.name);
  }

  // ---- starting ------------------------------------------------------------------------------
  async startNow() {
    if (this.closed) return;
    this.cancelRestart();
    const def = this.def;
    if (!def) {
      this.health.set({ status: 'error', detail: `The connector "${this.doc.data.connector}" isn't in this version of the platform.` });
      return;
    }
    if (!this.doc.data.enabled) {
      this.health.set({ status: 'disabled' });
      return;
    }
    let secrets;
    try {
      secrets = this.env.records.secretsOf(this.doc);
    } catch {
      this.health.set({ status: 'error', detail: 'Its saved secrets can\'t be read (the data was restored without its master key?): enter them again.' });
      return;
    }
    this.secretValues = Object.values(secrets).filter((v) => typeof v === 'string');
    const config = withDefaults(def, this.doc.data.config);
    const problem = this.configProblem(def, config, secrets);
    if (problem) {
      this.health.set({ status: 'error', detail: `${problem} Change its settings to fix it.` });
      return;
    }
    this.tokens?.stop();
    this.tokens = def.oauth ? createTokenManager({
      id: this.id, records: this.env.records, now: this.env.now, timers: this.env.timers, log: this.env.log,
      oauth: () => this.oauthClient(def, config, secrets),
      onNeedsReauth: (reason) => this.onNeedsReauth(reason),
    }) : null;
    const info = this.env.records.tokenInfo(this.id);
    if (def.userAuth === 'required' && (info?.needsReauth || !this.tokens?.hasUser())) {
      const why = info?.needsReauth ? `Sign in again: ${info.needsReauth.reason}.` : `Sign in to ${def.name} to connect (Authorize).`;
      this.health.set({ status: 'needs-reauth', detail: why });
      return;
    }
    this.tokens?.start();
    this.launch(def, config, secrets);
  }

  // What's wrong with the settings, or undefined: what the schema requires, then the definition's
  // own check. Checked again at each start (a definition may have changed since they were saved).
  configProblem(def, config, secrets) {
    const { config: cf, required } = fieldsOf(def);
    const missing = required.filter((k) => (Object.hasOwn(cf, k) ? config[k] === undefined || config[k] === '' : !secrets[k]));
    if (missing.length) return `${missing.join(', ')} ${missing.length > 1 ? 'are' : 'is'} missing.`;
    for (const [k, v] of Object.entries(config)) {
      if (!Object.hasOwn(cf, k)) continue;
      const p = validate(cf[k], v)[0];
      if (p) return `${k} ${p.message}.`;
    }
    if (def.validate) {
      try {
        const said = def.validate(config, secrets);
        if (typeof said === 'string' && said) return this.scrub(said);
      } catch (err) {
        return `Its settings could not be checked (${this.scrub(err.message)}).`;
      }
    }
    return undefined;
  }

  oauthClient(def, config, secrets) {
    const o = this.env.oauthOf(def);
    const idField = o.client?.id || 'clientId';
    const secretField = o.client?.secret || 'clientSecret';
    const clientId = config[idField] ?? secrets[idField];
    if (!clientId) return null;
    return createOAuthClient({ oauth: o, clientId, clientSecret: secrets[secretField] ?? config[secretField], now: this.env.now, post: this.env.post });
  }

  launch(def, config, secrets) {
    const gen = ++this.generation;
    this.running = true;
    this.controller = new AbortController();
    this.health.set({ status: 'connecting' });
    this.http = createHttpClient({
      fetch: this.env.fetch, lookup: this.env.lookup, now: this.env.now, timers: this.env.timers, signal: this.controller.signal,
      auth: this.tokens?.auth || { header: async () => { throw new ConnectorError('This connector has no sign-in.', 'no-sign-in'); }, refresh: async () => {} },
      quota: { use: (n) => this.useQuota(n) }, scrub: (s) => this.scrub(s), log: this.env.log, allowHttp: this.env.allowHttp, random: this.env.random,
    });
    const ctx = makeContext(this, gen, { def, config, secrets });
    this.ctx = ctx;
    let inst;
    try {
      inst = def.create(ctx);
      if (!inst || typeof inst.start !== 'function') throw new TypeError(`${def.name}'s create(ctx) must return { start, stop }`);
    } catch (err) {
      this.failNow(gen, err);
      return;
    }
    this.instance = inst;
    const limit = this.timer(gen, LIMITS.startMs, () => this.failNow(gen, new Error(`It took longer than ${LIMITS.startMs / 1000} s to start.`)), true);
    Promise.resolve().then(() => inst.start()).then(() => {
      this.env.timers.clearTimeout(limit);
      if (!this.current(gen)) return;
      if (this.health.status === 'connecting') this.health.set({ status: 'connected' });
      this.stableTimer = this.env.timers.setTimeout(() => {
        this.stableTimer = null;
        if (this.current(gen) && ['connected', 'degraded'].includes(this.health.status)) this.attempt = 0;
      }, LIMITS.stableMs);
      this.stableTimer?.unref?.();
    }, (err) => {
      this.env.timers.clearTimeout(limit);
      this.failNow(gen, err);
    });
  }

  // A timer of this instance's: cleared when it stops; fn's failures fail the instance.
  timer(gen, ms, fn, raw = false, every = false) {
    const t = this.env.timers;
    let h;
    const tick = () => {
      if (!every) this.instanceTimers.delete(h);
      if (!this.current(gen)) return;
      if (raw) return fn();
      try {
        const out = fn();
        if (out && typeof out.then === 'function') out.then(undefined, (err) => this.failNow(gen, err));
      } catch (err) {
        this.failNow(gen, err);
      }
      return undefined;
    };
    const wait = Math.max(0, Math.min(Number(ms) || 0, 2 ** 31 - 1));
    h = every ? t.setInterval(tick, Math.max(wait, 100)) : t.setTimeout(tick, wait);
    h?.unref?.();
    this.instanceTimers.add(h);
    return h;
  }
  clearTimer(h) {
    if (!this.instanceTimers.has(h)) return;
    this.instanceTimers.delete(h);
    this.env.timers.clearTimeout(h);
    this.env.timers.clearInterval?.(h);
  }

  // ---- failing -------------------------------------------------------------------------------
  // The instance failed: stop it, hold its values, try again later (unless retry: false, or the
  // failure is a refused sign-in). retryAfterMs: what the service asked for (429, a quota).
  failNow(gen, err, { retryAfterMs, retry = true } = {}) {
    if (!this.current(gen)) return;
    const detail = this.describe(err);
    this.env.log.warn('a connection failed', { connection: this.id, connector: this.doc.data.connector, err: detail });
    this.teardown();
    this.hold();
    if (err?.code === 'needs-reauth') {
      this.health.set({ status: 'needs-reauth', detail: /sign in/i.test(detail) ? detail : `Sign in again: ${detail}` });
      return;
    }
    if (!retry) {
      this.health.set({ status: 'error', detail });
      return;
    }
    const asked = Math.min(Number(retryAfterMs ?? err?.retryAfterMs) || 0, MAX_WAIT_MS);
    const wait = Math.max(nextDelay(this.attempt++, { ...BACKOFF, random: this.env.random }), asked);
    this.health.set({ status: 'error', detail: `${detail}${/[.!?…)]$/.test(detail) ? '' : '.'} Trying again in ${waitWords(wait)}.` });
    this.scheduleRestart(wait);
  }

  // A sign-in or a credential the service refuses: no retry until someone signs in or edits it.
  reauthNow(gen, detail) {
    if (!this.current(gen)) return;
    this.teardown();
    this.hold();
    this.health.set({ status: 'needs-reauth', detail: this.scrub(detail) });
  }

  // A quota spent (06 §6.7): degraded, stopped until it resets, said in the detail.
  pauseUntil(gen, resetsAt, detail) {
    if (!this.current(gen)) return;
    this.teardown();
    this.hold();
    const wait = Math.min(Math.max(0, resetsAt - this.env.now()), MAX_WAIT_MS);
    this.memory.quota = { ...(this.memory.quota || {}), exhaustedUntil: resetsAt };
    this.memoryChanged();
    this.health.set({ status: 'degraded', detail: this.scrub(detail || `Its quota is used up until ${new Date(resetsAt).toISOString()}.`), quota: { ...(this.memory.quota || {}), resetsAt } });
    this.scheduleRestart(wait);
  }

  // Said by the token manager (a renewal refused, a second 401): the request that found it fails
  // with needs-reauth too, and finds this instance already stopped.
  onNeedsReauth(reason) {
    if (this.running) this.reauthNow(this.generation, `Sign in again: ${reason}.`);
  }

  describe(err) {
    const msg = err instanceof BusError || err instanceof TypeError ? `The connector made a mistake: ${err.message}` : err?.message || String(err);
    return this.scrub(msg).replace(/\s+/g, ' ').trim().slice(0, 280) || 'It failed.';
  }

  scheduleRestart(wait) {
    this.cancelRestart();
    this.restartTimer = this.env.timers.setTimeout(() => {
      this.restartTimer = null;
      if (!this.closed) this.start();
    }, wait);
    this.restartTimer?.unref?.();
  }
  cancelRestart() {
    if (this.restartTimer) this.env.timers.clearTimeout(this.restartTimer);
    this.restartTimer = null;
  }

  // Ends the current instance (no new state from it), whatever it is doing.
  teardown() {
    const inst = this.instance;
    this.generation++;
    this.running = false;
    this.instance = null;
    this.ctx = null;
    try { this.controller?.abort(); } catch { /* aborted */ }
    for (const h of this.instanceTimers) {
      this.env.timers.clearTimeout(h);
      this.env.timers.clearInterval?.(h);
    }
    this.instanceTimers.clear();
    if (this.stableTimer) this.env.timers.clearTimeout(this.stableTimer);
    this.stableTimer = null;
    if (!inst || typeof inst.stop !== 'function') return Promise.resolve();
    // stop() may hang or throw: it gets 5 s, then is left behind (its callbacks change nothing).
    return new Promise((resolve) => {
      const t = this.env.timers.setTimeout(resolve, LIMITS.stopMs);
      t?.unref?.();
      Promise.resolve().then(() => inst.stop()).catch((err) => this.env.log.warn('a connector failed to stop cleanly', { connection: this.id, err: this.describe(err) })).finally(() => {
        this.env.timers.clearTimeout(t);
        resolve();
      });
    });
  }

  // ---- holds (H6, 02 §2.8) -------------------------------------------------------------------
  hold(keys) {
    const bus = this.env.bus;
    const mine = bus.stateOf(this.id);
    if (!this.def?.holdOnError) {
      bus.clearOwner(this.id);
      return;
    }
    const until = this.env.now() + this.env.holdMs;
    for (const e of mine) {
      if (keys && !keys.includes(e.key)) continue;
      if (!e.stale || !this.holds.has(e.key)) this.holds.set(e.key, until);
      bus.setStale(e.key, this.id, true);
    }
    this.armHold();
  }
  armHold() {
    if (this.holdTimer) this.env.timers.clearTimeout(this.holdTimer);
    this.holdTimer = null;
    if (!this.holds.size) return;
    const next = Math.min(...this.holds.values());
    this.holdTimer = this.env.timers.setTimeout(() => this.expireHolds(), Math.max(0, next - this.env.now()));
    this.holdTimer?.unref?.();
  }
  expireHolds() {
    this.holdTimer = null;
    const t = this.env.now();
    const stale = new Map(this.env.bus.stateOf(this.id).map((e) => [e.key, e.stale]));
    for (const [key, until] of [...this.holds]) {
      if (!stale.get(key)) { this.holds.delete(key); continue; } // set again meanwhile: it stays
      if (until > t) continue;
      this.holds.delete(key);
      try { this.env.bus.setState(key, undefined, { src: this.src }); } catch (err) { this.env.log.error('a held value could not be removed', { connection: this.id, key, err: err.message }); }
    }
    this.armHold();
  }
  dropHolds() {
    if (this.holdTimer) this.env.timers.clearTimeout(this.holdTimer);
    this.holdTimer = null;
    this.holds.clear();
  }

  // ---- stopping ------------------------------------------------------------------------------
  // deliberate: an operator turned it off, edited or deleted it: its values go at once.
  // shutdown: the platform is stopping: nothing is held (the bus goes too), its memory is saved.
  async stopNow({ deliberate = true, shutdown = false, status = 'disabled' } = {}) {
    this.cancelRestart();
    this.tokens?.stop();
    const stopping = this.teardown();
    // Saved now: the instance can't change it any more, and a stop() that hangs mustn't lose it
    // (the platform gives itself 5 s to stop).
    this.flushMemory();
    if (deliberate || shutdown) {
      this.dropHolds();
      if (!shutdown) this.env.bus.clearOwner(this.id);
    }
    await stopping;
    if (!shutdown) this.health.set({ status });
  }

  async close({ shutdown = true } = {}) {
    await this.queue(() => this.stopNow({ shutdown }));
    this.closed = true;
    this.dropHolds();
    this.health.close();
    if (this.memory.timer) this.env.timers.clearTimeout(this.memory.timer);
  }

  // ---- memory and quota ----------------------------------------------------------------------
  memoryChanged() {
    this.memory.dirty = true;
    if (this.memory.timer) return;
    this.memory.timer = this.env.timers.setTimeout(() => {
      this.memory.timer = null;
      this.flushMemory();
    }, LIMITS.memoryFlushMs);
    this.memory.timer?.unref?.();
  }
  flushMemory() {
    if (!this.memory.dirty) return;
    this.memory.dirty = false;
    try {
      this.env.records.saveMemory(this.id, { memory: this.memory.data, ...(this.memory.quota ? { quota: this.memory.quota } : {}) });
    } catch (err) {
      this.env.log.error('a connection\'s memory could not be saved', { connection: this.id, err: err.message });
    }
  }
  useQuota(n) {
    const q = this.memory.quota || {};
    if (q.exhaustedUntil && q.exhaustedUntil > this.env.now()) throw new ConnectorError(`Its quota is used up until ${new Date(q.exhaustedUntil).toISOString()}.`, 'quota-exhausted', { retryAfterS: Math.ceil((q.exhaustedUntil - this.env.now()) / 1000) });
    if (q.resetsAt && Date.parse(q.resetsAt) <= this.env.now()) {
      q.used = 0;
      delete q.resetsAt;
    }
    q.used = (q.used || 0) + (Number.isInteger(n) && n > 0 ? n : 1);
    this.memory.quota = q;
    this.memoryChanged();
  }

  // ---- what the API asks -----------------------------------------------------------------------
  // { ok, health, checks: [{ name, ok, detail? }] }
  async test() {
    const def = this.def;
    const checks = [];
    if (!def) return { ok: false, health: this.health.view(), checks: [{ name: 'Connector', ok: false, detail: 'This connector isn\'t in this version of the platform.' }] };
    let secrets = {};
    try { secrets = this.env.records.secretsOf(this.doc); checks.push({ name: 'Saved secrets', ok: true }); } catch { checks.push({ name: 'Saved secrets', ok: false, detail: 'They can\'t be read: enter them again.' }); }
    const problem = this.configProblem(def, withDefaults(def, this.doc.data.config), secrets);
    checks.push({ name: 'Settings', ok: !problem, ...(problem ? { detail: problem } : {}) });
    if (def.userAuth !== 'none') {
      const signedIn = Boolean(this.tokens?.hasUser() ?? this.env.records.tokenInfo(this.id)?.signedIn);
      checks.push({ name: 'Signed in', ok: signedIn || def.userAuth === 'optional', ...(signedIn ? {} : { detail: 'Not signed in: Authorize.' }) });
    }
    if (!this.doc.data.enabled) checks.push({ name: 'Turned on', ok: false, detail: 'It is turned off.' });
    else if (this.instance && typeof this.instance.test === 'function') {
      try {
        const r = await withTimeout(Promise.resolve().then(() => this.instance.test()), LIMITS.testMs, this.env.timers);
        const list = Array.isArray(r) ? r : [r || { ok: true }];
        for (const c of list) checks.push({ name: typeof c.name === 'string' ? c.name : `Reaching ${def.name}`, ok: c.ok !== false, ...(c.detail ? { detail: this.scrub(String(c.detail)).slice(0, 300) } : {}) });
      } catch (err) {
        checks.push({ name: `Reaching ${def.name}`, ok: false, detail: err?.timeout ? `No answer within ${LIMITS.testMs / 1000} s.` : this.describe(err) });
      }
    } else {
      const ok = ['connected', 'degraded'].includes(this.health.status);
      checks.push({ name: 'Connected', ok, ...(this.health.view().detail ? { detail: this.health.view().detail } : {}) });
    }
    return { ok: checks.every((c) => c.ok), health: this.health.view(), checks };
  }

  async runAction(name, args = {}) {
    const def = this.def;
    const spec = def?.actions?.[name];
    if (!spec) throw new ConnectorError(`${def?.name || 'This connection'} has no action "${name}"${def?.actions ? ` (it has ${Object.keys(def.actions).join(', ')})` : ''}.`, 'not-found');
    if (args === null || typeof args !== 'object' || Array.isArray(args)) throw new ConnectorError('"args" is an object.', 'invalid');
    if (spec.args) {
      const p = validate(spec.args, args);
      if (p.length) throw new ConnectorError(`The action's arguments don't fit: ${p.map((x) => `${x.path} ${x.message}`).join('; ')}.`, 'invalid');
    }
    const fn = this.instance?.actions?.[name];
    if (!this.instance || !['connected', 'degraded'].includes(this.health.status) || typeof fn !== 'function') {
      throw new ConnectorError(`${this.doc.data.name} isn't connected (${this.health.status}${this.health.view().detail ? `: ${this.health.view().detail}` : ''}).`, 'not-connected');
    }
    try {
      const out = await withTimeout(Promise.resolve().then(() => fn(structuredClone(args))), LIMITS.actionMs, this.env.timers);
      return out === undefined ? null : JSON.parse(JSON.stringify(this.scrubDeep(out)));
    } catch (err) {
      if (err?.timeout) throw new ConnectorError(`${this.doc.data.name} didn't finish "${name}" within ${LIMITS.actionMs / 1000} s.`, 'timeout');
      if (err instanceof ConnectorError) throw err;
      throw new ConnectorError(`"${name}" failed: ${this.describe(err)}`, 'action-failed');
    }
  }

  // A delivery to POST /hooks/<connector>[/<connection>] (07 §7.9): the definition's inbound()
  // checks it against the raw body. A refused one is counted, never logged in full.
  async inbound(req) {
    const def = this.def;
    if (!def?.inbound) throw new ConnectorError('This connection takes no deliveries.', 'not-found');
    if (!this.ctx || !this.running) throw new ConnectorError(`${this.doc.data.name} isn't running.`, 'not-connected');
    let out;
    try {
      out = await withTimeout(Promise.resolve().then(() => def.inbound(this.ctx, req)), LIMITS.actionMs, this.env.timers);
    } catch (err) {
      this.env.log.warn('a delivery could not be handled', { connection: this.id, err: this.describe(err) });
      return { status: 500 };
    }
    const status = Number.isInteger(out?.status) ? out.status : 204;
    if (status === 401) this.stats.inboundRefused++;
    else if (status < 300) this.stats.inboundAccepted++;
    return { status, ...(out?.body !== undefined ? { body: out.body } : {}) };
  }

  view() {
    return { health: this.health.view(), ...(this.stats.inboundAccepted || this.stats.inboundRefused ? { deliveries: { accepted: this.stats.inboundAccepted, refused: this.stats.inboundRefused } } : {}) };
  }
}

export function withTimeout(promise, ms, timers) {
  return new Promise((resolve, reject) => {
    const t = timers.setTimeout(() => reject(Object.assign(new Error('timed out'), { timeout: true })), ms);
    t?.unref?.();
    promise.then((v) => { timers.clearTimeout(t); resolve(v); }, (e) => { timers.clearTimeout(t); reject(e); });
  });
}

function waitWords(ms) {
  if (ms < 60000) return `${Math.max(1, Math.round(ms / 1000))} s`;
  if (ms < 3600000) return `${Math.round(ms / 60000)} min`;
  return `${Math.round(ms / 3600000)} h`;
}
