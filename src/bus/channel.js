// One channel per overlay: what that overlay is allowed to see, a replay buffer so a client
// that reconnects resumes without gaps (01 §1.5), and its own state.changed rate limit
// (02 §2.9). Channels keep buffering while no client is connected; that's the point.
//
// Bindings (01 §1.3): 'all' (every connection, including ones made later: the default) or a list
// of connection ids. Events from a connection the overlay isn't bound to never reach it; for state
// the bus works out the one value the bound connections show (bus/index.js resolve()), and the
// channel sends a change only when that value moves.
import { ULID_PATTERN } from '../ids.js';
import { CHAT_TYPES, OPERATOR_ONLY, RUNTIME_KEYS, RUNTIME_TYPES, compilePatterns } from './names.js';

// Keep at least 120 s or 500 envelopes, whichever is more (01 §1.5). The hard cap bounds memory
// during a chat flood; a client that falls that far behind gets 410 and re-fetches the snapshot,
// which is always safe.
const KEEP_MS = 120000;
const KEEP_COUNT = 500;
const HARD_CAP = 5000;
const COALESCE_MS = 100; // at most 10 state.changed per key per second (02 §2.9)
const MAX_ENVELOPE_BYTES = 64 * 1024; // 02 §2.9
const ENVELOPE_OVERHEAD = 256; // id, type, ts and src around the data
const CHAT_DEFAULT = 50;
const CHAT_MAX = 200;
const SIMULATOR = Object.freeze({ connector: 'simulator' });
const CORE = Object.freeze({ connector: 'core' });

export class Channel {
  #bus;
  #buffer = [];
  #droppedUpTo;
  #subs = new Set();
  #closers = new Set();
  #local = new Map(); // channel-only state (overlay.settings, show.*), key → value
  #sim = new Map(); // simulated state (08 §8.5), key → { value (undefined: absent), timer }
  #lastEmit = new Map(); // key → { at, json }
  #pending = new Map(); // key → { timer, value, src }
  #closed = false;
  #all = true; // bound to every connection
  #bound = new Set(); // else these
  #configured = false;
  #allow = (owner) => owner === '' || this.#all || this.#bound.has(owner);

  constructor(bus, id, spec) {
    this.#bus = bus;
    this.id = id;
    this.#droppedUpTo = bus.cursor(); // nothing before this channel existed can be replayed
    this.configure(spec);
  }

  // consumes: { state: [patterns], events: [patterns], chat: { recent, max } | undefined }
  // connections: 'all' or the ids of the connections bound to this overlay (01 §1.3); unbound data
  // never reaches it. A change of bindings sends the overlay every value that moved with it: a
  // count from a connection no longer bound goes, one from a newly bound connection arrives.
  configure({ consumes = {}, connections = 'all' } = {}) {
    this.wantsState = compilePatterns(consumes.state, 'state pattern');
    this.wantsEvent = compilePatterns(consumes.events, 'event pattern');
    this.chat = consumes.chat ? { recent: clamp(consumes.chat.recent ?? CHAT_DEFAULT, 0, CHAT_MAX) } : null;
    this.wantsAlerts = this.wantsEvent.patterns.some((p) => p === 'alert.*' || p.startsWith('alert.'));
    const all = connections === 'all';
    const bound = new Set(Array.isArray(connections) ? connections : []);
    const rebind = this.#configured && (all !== this.#all || (!all && (bound.size !== this.#bound.size || [...bound].some((c) => !this.#bound.has(c)))));
    const before = rebind ? this.#busView() : undefined;
    this.#all = all;
    this.#bound = bound;
    this.#configured = true;
    if (!before) return;
    const after = this.#busView();
    for (const key of new Set([...before.keys(), ...after.keys()])) {
      if (before.get(key) === after.get(key) || this.#sim.has(key)) continue;
      const prev = before.get(key);
      this.#offerState(changeData(key, after.has(key) ? JSON.parse(after.get(key)) : undefined, prev === undefined ? undefined : JSON.parse(prev)), CORE);
    }
  }

  // 'all', or the bound connections' ids.
  get connections() { return this.#all ? 'all' : [...this.#bound]; }

  bound(src) {
    return !src?.connection || this.#all || this.#bound.has(src.connection);
  }

  consumesKey(key) {
    return RUNTIME_KEYS.has(key) || this.wantsState(key);
  }

  accepts(env) {
    if (!this.bound(env.src)) return false;
    const { type } = env;
    if (OPERATOR_ONLY.has(type)) return false;
    if (RUNTIME_TYPES.has(type)) return true;
    if (type === 'state.changed') return this.consumesKey(env.data.key);
    if (CHAT_TYPES.has(type)) return Boolean(this.chat);
    if (type === 'alerts.cut') return this.wantsAlerts;
    return this.wantsEvent(type);
  }

  // Called by the bus for every event this channel accepts.
  offer(env) {
    if (this.#closed) return;
    if (env.type === 'state.changed') {
      if (this.#sim.has(env.data.key)) return; // held back while simulated; sent when that ends
      return this.#offerState(env.data, env.src, env);
    }
    this.#emit(env);
  }

  // What this overlay shows for keys now (JSON text, or undefined), simulations aside: the bus
  // asks before a state change and hands it back to stateChanged() after.
  peek(keys) {
    return keys.map((k) => {
      const v = this.#real(k);
      return v === undefined ? undefined : JSON.stringify(v);
    });
  }

  // After a state change: sends each of keys whose shown value moved from `before` (peek()).
  stateChanged(keys, before, src = CORE) {
    if (this.#closed) return;
    keys.forEach((key, i) => {
      const after = this.#real(key);
      const text = after === undefined ? undefined : JSON.stringify(after);
      if (text === before[i] || this.#sim.has(key)) return;
      const from = this.#local.has(key) ? CORE : this.#bus.resolve(key, this.#allow)?.src ?? src;
      this.#offerState(changeData(key, after, before[i] === undefined ? undefined : JSON.parse(before[i])), from);
    });
  }

  // Simulated state (08 §8.5): this overlay sees `value` for `key` (undefined: absent) instead of
  // the real value, for holdMs, after which the real value comes back on its own. A simulation
  // left running on a live overlay must never hide the real viewer count for the rest of the show.
  simulate(key, value, holdMs) {
    if (this.#closed) return;
    const text = value === undefined ? undefined : JSON.stringify(value);
    let json = text === undefined ? undefined : JSON.parse(text);
    if (json === null) json = undefined;
    const data = changeData(key, json);
    if (Buffer.byteLength(JSON.stringify(data)) + ENVELOPE_OVERHEAD > MAX_ENVELOPE_BYTES) {
      throw Object.assign(new Error(`${key} is too large to send to an overlay (02 §2.9)`), { code: 'too-large' });
    }
    const held = this.#sim.get(key);
    if (held) this.#bus.timers.clearTimeout(held.timer);
    const timer = this.#bus.timers.setTimeout(() => this.endSimulation(key), holdMs);
    timer.unref?.();
    this.#sim.set(key, { value: json, timer });
    this.#offerState(data, SIMULATOR, undefined, true);
  }

  // Ends the simulation of one key (or all of them): the overlay gets the real value again.
  endSimulation(key) {
    for (const k of key === undefined ? [...this.#sim.keys()] : [key]) {
      const held = this.#sim.get(k);
      if (!held) continue;
      this.#bus.timers.clearTimeout(held.timer);
      this.#sim.delete(k);
      if (!this.#closed) this.#offerState(changeData(k, this.visibleState(k)), CORE, undefined, true);
    }
  }

  get simulating() { return [...this.#sim.keys()]; }

  // Channel-only state: never global, never sent to other overlays or API subscribers. Kept as a
  // JSON copy like bus state, and null after the round trip (NaN, Infinity, an invalid Date) is
  // absent, never null (02 §2.2). Removed, the key shows the bus's value again, if any.
  // A change that wouldn't fit in one envelope (02 §2.9) is refused before anything is kept. While
  // the key is simulated nothing is sent: the end of the simulation sends what is real then.
  setLocalState(key, value) {
    const text = value === undefined ? undefined : JSON.stringify(value);
    let json = text === undefined ? undefined : JSON.parse(text);
    if (json === null) json = undefined;
    const prev = this.#local.get(key);
    if (JSON.stringify(prev) === JSON.stringify(json)) return;
    const data = changeData(key, json, prev);
    if (Buffer.byteLength(JSON.stringify(data)) + ENVELOPE_OVERHEAD > MAX_ENVELOPE_BYTES) {
      throw Object.assign(new Error(`${key} is too large to send to an overlay (02 §2.9)`), { code: 'too-large' });
    }
    if (json === undefined) this.#local.delete(key);
    else this.#local.set(key, json);
    if (this.#sim.has(key)) return;
    const shown = json === undefined ? this.#busValue(key) : json;
    this.#offerState(shown === json ? data : changeData(key, shown, prev), CORE, undefined, true);
  }

  // One state key as this overlay sees it (its own state first, then global state it consumes
  // from connections bound to it), or undefined: what an x-skp-bind setting may read.
  // real: leave simulated state out (what x-skp-bind settings read: a simulation never becomes
  // part of an overlay's settings, 08 §8.5).
  visibleState(key, { real = false } = {}) {
    if (!real && this.#sim.has(key)) return structuredClone(this.#sim.get(key).value);
    const v = this.#real(key);
    return v === undefined ? undefined : structuredClone(v);
  }

  snapshot() {
    const state = {};
    for (const key of this.#bus.visibleKeys()) {
      if (!this.consumesKey(key) || this.#local.has(key)) continue;
      const e = this.#bus.resolve(key, this.#allow);
      if (e) state[key] = structuredClone(e.value);
    }
    for (const [key, value] of this.#local) state[key] = structuredClone(value);
    for (const [key, { value }] of this.#sim) {
      if (value === undefined) delete state[key];
      else state[key] = structuredClone(value);
    }
    const snap = { cursor: this.#bus.cursor(), ts: this.#bus.now(), state };
    if (this.chat) {
      const recent = this.#bus.chatRecent().filter((env) => this.bound(env.src));
      snap.chat = { recent: this.chat.recent ? recent.slice(-this.chat.recent).map((env) => structuredClone(env.data)) : [] };
    }
    return snap;
  }

  // Everything after `cursor`, or { gone: true } when the buffer no longer reaches back that far
  // (the client must re-fetch the snapshot; 410 at the HTTP layer).
  since(cursor) {
    if (typeof cursor !== 'string' || !ULID_PATTERN.test(cursor) || cursor < this.#droppedUpTo) return { gone: true };
    // A cursor newer than anything this bus has issued comes from before a restart whose clock
    // stepped back. Accepting it would filter out every new envelope and freeze the overlay.
    if (cursor > this.#bus.cursor()) return { gone: true };
    const envelopes = this.#buffer.filter((env) => env.id > cursor);
    return { envelopes, cursor: envelopes.length ? envelopes[envelopes.length - 1].id : cursor };
  }

  // fn gets each envelope; onClose runs if the channel goes away (the overlay was deleted), so a
  // live stream can end instead of hanging silently.
  subscribe(fn, onClose) {
    this.#subs.add(fn);
    if (onClose) this.#closers.add(onClose);
    return () => {
      this.#subs.delete(fn);
      if (onClose) this.#closers.delete(onClose);
    };
  }

  get subscriberCount() { return this.#subs.size; }
  get bufferSize() { return this.#buffer.length; }

  // Forgets the replay buffer and ends every open stream, but keeps the channel and its local
  // state. Clients reconnect and re-sync from a fresh snapshot, which is how an overlay's template
  // upgrade reaches pages already open: they see the new build and reload (01 §1.4).
  reset() {
    this.#buffer = [];
    this.#droppedUpTo = this.#bus.cursor();
    this.#subs.clear();
    const closers = [...this.#closers];
    this.#closers.clear();
    for (const fn of closers) {
      try { fn(); } catch (err) { this.#bus.log.error('channel close handler failed', { channel: this.id, err }); }
    }
  }

  close() {
    this.#closed = true;
    for (const p of this.#pending.values()) this.#bus.timers.clearTimeout(p.timer);
    this.#pending.clear();
    for (const s of this.#sim.values()) this.#bus.timers.clearTimeout(s.timer);
    this.#sim.clear();
    this.#subs.clear();
    const closers = [...this.#closers];
    this.#closers.clear();
    for (const fn of closers) {
      try { fn(); } catch (err) { this.#bus.log.error('channel close handler failed', { channel: this.id, err }); }
    }
  }

  // A key's value as the overlay shows it, simulations aside: its own state, else the bus's value
  // from the connections bound to it, if it consumes the key.
  #real(key) {
    if (this.#local.has(key)) return this.#local.get(key);
    return this.#busValue(key);
  }

  #busValue(key) {
    if (!this.consumesKey(key)) return undefined;
    return this.#bus.resolve(key, this.#allow)?.value;
  }

  // The bus's values this overlay shows (keys its own state doesn't cover), as JSON text.
  #busView() {
    const view = new Map();
    for (const key of this.#bus.visibleKeys()) {
      if (this.#local.has(key) || !this.consumesKey(key)) continue;
      const e = this.#bus.resolve(key, this.#allow);
      if (e) view.set(key, JSON.stringify(e.value));
    }
    return view;
  }

  // local: channel-only state, which the channel always accepts.
  #offerState(data, src, env, local = false) {
    const { key } = data;
    const now = this.#bus.now();
    const last = this.#lastEmit.get(key);
    const pending = this.#pending.get(key);
    if (pending) {
      pending.value = data.value;
      pending.src = src;
      pending.local = local;
      return;
    }
    if (!last || now - last.at >= COALESCE_MS) {
      this.#lastEmit.set(key, { at: now, json: JSON.stringify(data.value) });
      // prev may be a value other than the one the bus measured (another connection's): past
      // 64 KiB with it, the change goes without it (prev is optional).
      const fits = env || data.prev === undefined || Buffer.byteLength(JSON.stringify(data)) + ENVELOPE_OVERHEAD <= MAX_ENVELOPE_BYTES;
      this.#emit(env || this.#bus.envelope('state.changed', fits ? data : changeData(key, data.value), src));
      return;
    }
    // Inside the window: hold the latest value and send it when the window ends.
    const timer = this.#bus.timers.setTimeout(() => this.#flush(key), last.at + COALESCE_MS - now);
    this.#pending.set(key, { timer, value: data.value, src, local });
  }

  #flush(key) {
    const pending = this.#pending.get(key);
    this.#pending.delete(key);
    if (!pending || this.#closed) return;
    // What the channel accepts may have changed while the value waited (an upgrade that no longer
    // consumes the key, a connection unbound): judge it again.
    if (!pending.local && !(this.consumesKey(key) && this.bound(pending.src))) return;
    const last = this.#lastEmit.get(key);
    const json = JSON.stringify(pending.value);
    if (last && last.json === json) return; // it changed back; the client already has this value
    this.#lastEmit.set(key, { at: this.#bus.now(), json });
    // prev is what this client last got, which the size checks on the way in didn't see: when it
    // would push the envelope past 64 KiB (02 §2.9), the change goes without it (prev is optional).
    const prev = last && last.json !== undefined ? JSON.parse(last.json) : undefined;
    let data = changeData(key, pending.value, prev);
    if (prev !== undefined && Buffer.byteLength(JSON.stringify(data)) + ENVELOPE_OVERHEAD > MAX_ENVELOPE_BYTES) data = changeData(key, pending.value);
    this.#emit(this.#bus.envelope('state.changed', data, pending.src));
  }

  #emit(env) {
    this.#buffer.push(env);
    const now = this.#bus.now();
    while (
      this.#buffer.length > HARD_CAP ||
      (this.#buffer.length > KEEP_COUNT && now - this.#buffer[0].ts > KEEP_MS)
    ) {
      this.#droppedUpTo = this.#buffer.shift().id;
    }
    for (const fn of this.#subs) {
      try { fn(env); } catch (err) { this.#bus.log.error('channel subscriber failed', { channel: this.id, err }); }
    }
  }
}

export function changeData(key, value, prev) {
  const data = { key };
  if (value !== undefined) data.value = value;
  if (prev !== undefined) data.prev = prev;
  return data;
}

function clamp(n, lo, hi) {
  const v = Number.isInteger(n) ? n : lo;
  return Math.min(hi, Math.max(lo, v));
}
