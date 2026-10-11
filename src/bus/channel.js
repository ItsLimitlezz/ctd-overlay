// One channel per overlay: what that overlay is allowed to see, a replay buffer so a client
// that reconnects resumes without gaps (01 §1.5), and its own state.changed rate limit
// (02 §2.9). Channels keep buffering while no client is connected; that's the point.
import { ULID_PATTERN } from '../ids.js';
import { CHAT_TYPES, OPERATOR_ONLY, RUNTIME_KEYS, RUNTIME_TYPES, compilePatterns } from './names.js';

// Keep at least 120 s or 500 envelopes, whichever is more (01 §1.5). The hard cap bounds memory
// during a chat flood; a client that falls that far behind gets 410 and re-fetches the snapshot,
// which is always safe.
const KEEP_MS = 120000;
const KEEP_COUNT = 500;
const HARD_CAP = 5000;
const COALESCE_MS = 100; // at most 10 state.changed per key per second (02 §2.9)
const CHAT_DEFAULT = 50;
const CHAT_MAX = 200;

export class Channel {
  #bus;
  #buffer = [];
  #droppedUpTo;
  #subs = new Set();
  #closers = new Set();
  #local = new Map(); // channel-only state (overlay.settings, show.*), key → value
  #lastEmit = new Map(); // key → { at, json }
  #pending = new Map(); // key → { timer, value, src }
  #closed = false;

  constructor(bus, id, spec) {
    this.#bus = bus;
    this.id = id;
    this.#droppedUpTo = bus.cursor(); // nothing before this channel existed can be replayed
    this.configure(spec);
  }

  // consumes: { state: [patterns], events: [patterns], chat: { recent, max } | undefined }
  // connections: IDs of the connections bound to this overlay (01 §1.3); unbound data never
  // reaches it.
  configure({ consumes = {}, connections = [] } = {}) {
    this.wantsState = compilePatterns(consumes.state, 'state pattern');
    this.wantsEvent = compilePatterns(consumes.events, 'event pattern');
    this.chat = consumes.chat ? { recent: clamp(consumes.chat.recent ?? CHAT_DEFAULT, 0, CHAT_MAX) } : null;
    this.wantsAlerts = this.wantsEvent.patterns.some((p) => p === 'alert.*' || p.startsWith('alert.'));
    this.connections = new Set(connections);
  }

  bound(src) {
    return !src?.connection || this.connections.has(src.connection);
  }

  accepts(env) {
    if (!this.bound(env.src)) return false;
    const { type } = env;
    if (OPERATOR_ONLY.has(type)) return false;
    if (RUNTIME_TYPES.has(type)) return true;
    if (type === 'state.changed') return RUNTIME_KEYS.has(env.data.key) || this.wantsState(env.data.key);
    if (CHAT_TYPES.has(type)) return Boolean(this.chat);
    if (type === 'alerts.cut') return this.wantsAlerts;
    return this.wantsEvent(type);
  }

  // Called by the bus for every envelope this channel accepts.
  offer(env) {
    if (this.#closed) return;
    if (env.type === 'state.changed') return this.#offerState(env.data, env.src, env);
    this.#emit(env);
  }

  // Channel-only state: never global, never sent to other overlays or API subscribers.
  setLocalState(key, value) {
    const prev = this.#local.get(key);
    if (JSON.stringify(prev) === JSON.stringify(value)) return;
    if (value === undefined) this.#local.delete(key);
    else this.#local.set(key, structuredClone(value));
    this.#offerState(changeData(key, value, prev), { connector: 'core' });
  }

  snapshot() {
    const state = {};
    for (const [key, entry] of this.#bus.stateEntries()) {
      if ((RUNTIME_KEYS.has(key) || this.wantsState(key)) && this.bound(entry.src)) state[key] = structuredClone(entry.value);
    }
    for (const [key, value] of this.#local) state[key] = structuredClone(value);
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

  close() {
    this.#closed = true;
    for (const p of this.#pending.values()) this.#bus.timers.clearTimeout(p.timer);
    this.#pending.clear();
    this.#subs.clear();
    const closers = [...this.#closers];
    this.#closers.clear();
    for (const fn of closers) {
      try { fn(); } catch (err) { this.#bus.log.error('channel close handler failed', { channel: this.id, err }); }
    }
  }

  #offerState(data, src, env) {
    const { key } = data;
    const now = this.#bus.now();
    const last = this.#lastEmit.get(key);
    const pending = this.#pending.get(key);
    if (pending) {
      pending.value = data.value;
      pending.src = src;
      return;
    }
    if (!last || now - last.at >= COALESCE_MS) {
      this.#lastEmit.set(key, { at: now, json: JSON.stringify(data.value) });
      this.#emit(env || this.#bus.envelope('state.changed', data, src));
      return;
    }
    // Inside the window: hold the latest value and send it when the window ends.
    const timer = this.#bus.timers.setTimeout(() => this.#flush(key), last.at + COALESCE_MS - now);
    this.#pending.set(key, { timer, value: data.value, src });
  }

  #flush(key) {
    const pending = this.#pending.get(key);
    this.#pending.delete(key);
    if (!pending || this.#closed) return;
    const last = this.#lastEmit.get(key);
    const json = JSON.stringify(pending.value);
    if (last && last.json === json) return; // it changed back; the client already has this value
    this.#lastEmit.set(key, { at: this.#bus.now(), json });
    const prev = last && last.json !== undefined ? JSON.parse(last.json) : undefined;
    this.#emit(this.#bus.envelope('state.changed', changeData(key, pending.value, prev), pending.src));
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
