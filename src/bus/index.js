// The bus (01 §1.2): owns all live data. Connectors and the core publish events and set state;
// the bus stamps each envelope with an ID and server time, keeps current state and a moderated
// chat buffer, and routes every envelope to the overlay channels that may see it and to
// API-level subscribers (the /api/v1/events stream and webhooks, later steps).
import { ulid as defaultIdgen } from '../ids.js';
import { silentLogger } from '../log.js';
import { Channel, changeData } from './channel.js';
import { KEY, TYPE } from './names.js';

export class BusError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'BusError';
    this.code = code;
  }
}

const MAX_ENVELOPE_BYTES = 64 * 1024; // 02 §2.9
const CHAT_BUFFER = 200; // the most any template may ask for (02 §2.3)

export function createBus({ now = Date.now, idgen = defaultIdgen, timers = { setTimeout, clearTimeout }, log = silentLogger } = {}) {
  const state = new Map(); // key → { value, src, ts }
  const channels = new Map();
  const globalSubs = new Set();
  let chat = []; // chat.message envelopes still visible after moderation, oldest first
  let lastId = idgen(now());

  const bus = {
    now,
    timers,
    log,
    cursor: () => lastId,

    // Builds a stamped envelope without routing it (channels use this for coalesced updates).
    envelope(type, data, src = { connector: 'core' }) {
      lastId = idgen(now());
      return { id: lastId, type, ts: now(), src, data };
    },

    // Publishes an event. `target` sends it to one channel only and nowhere else (the simulator,
    // 08 §8.5).
    publish(type, data = {}, { src = { connector: 'core' }, target } = {}) {
      if (typeof type !== 'string' || !TYPE.test(type)) throw new BusError(`"${type}" isn't a registered event type or a custom.* / x-<vendor>.* type`, 'bad-type');
      if (type === 'state.changed') throw new BusError('use setState() to change state', 'bad-type');
      checkSrc(src);
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new BusError('event data must be a JSON object', 'bad-data');
      const env = bus.envelope(type, toJson(data), src);
      checkSize(env);
      if (target !== undefined) {
        const ch = channels.get(target);
        if (ch && ch.accepts(env)) ch.offer(env);
        return env;
      }
      if (type.startsWith('chat.')) moderate(env);
      route(env);
      return env;
    },

    // Sets a state key; `undefined` removes it (a missing value is absent, never null or 0,
    // 02 §2.8). Publishes state.changed only when the value actually changes.
    setState(key, value, { src = { connector: 'core' } } = {}) {
      if (typeof key !== 'string' || !KEY.test(key)) throw new BusError(`bad state key "${key}"`, 'bad-key');
      checkSrc(src);
      // null means "no value" too: a key without a value is absent, never null (02 §2.2).
      const json = value === undefined || value === null ? undefined : toJson(value);
      const current = state.get(key);
      if (JSON.stringify(current?.value) === JSON.stringify(json)) return null;
      if (json === undefined) state.delete(key);
      else state.set(key, { value: json, src, ts: now() });
      const env = bus.envelope('state.changed', changeData(key, json, current?.value), src);
      checkSize(env);
      route(env);
      return env;
    },

    getState(key) {
      const entry = state.get(key);
      return entry ? structuredClone(entry.value) : undefined;
    },

    stateEntries: () => state.entries(),
    chatRecent: () => chat,

    // The channel for an overlay, created on first use; calling again updates what it consumes.
    channel(id, spec) {
      let ch = channels.get(id);
      if (ch) {
        if (spec) ch.configure(spec);
      } else {
        ch = new Channel(bus, id, spec);
        channels.set(id, ch);
      }
      return ch;
    },

    removeChannel(id) {
      channels.get(id)?.close();
      channels.delete(id);
    },

    // Every routed envelope (not targeted or channel-only ones), for API-level consumers.
    subscribeAll(fn) {
      globalSubs.add(fn);
      return () => globalSubs.delete(fn);
    },

    close() {
      for (const ch of channels.values()) ch.close();
      channels.clear();
      globalSubs.clear();
    },
  };

  function route(env) {
    for (const ch of channels.values()) {
      if (ch.accepts(env)) ch.offer(env);
    }
    for (const fn of globalSubs) {
      try { fn(env); } catch (err) { log.error('bus subscriber failed', { err }); }
    }
  }

  // Keeps the chat buffer in step with deletions, bans and clears (02 §2.3).
  function moderate(env) {
    const { type, data } = env;
    if (type === 'chat.message') {
      chat.push(env);
      if (chat.length > CHAT_BUFFER) chat = chat.slice(-CHAT_BUFFER);
    } else if (type === 'chat.message.deleted') {
      chat = chat.filter((m) => m.data.id !== data.messageId);
    } else if (type === 'chat.user.cleared') {
      chat = chat.filter((m) => m.data.user?.id !== data.userId);
    } else if (type === 'chat.cleared') {
      chat = []; // "remove everything", as clients do (02 §2.3)
    }
  }

  return bus;
}

function checkSrc(src) {
  if (!src || typeof src.connector !== 'string' || !src.connector) {
    throw new BusError('src.connector is required', 'bad-src');
  }
}

// A JSON round trip: rejects what can't be serialized and detaches the value from the caller.
function toJson(value) {
  let text;
  try { text = JSON.stringify(value); } catch (err) { throw new BusError(`value must be JSON: ${err.message}`, 'bad-data'); }
  if (text === undefined) throw new BusError('value must be JSON', 'bad-data');
  return JSON.parse(text);
}

function checkSize(env) {
  const bytes = Buffer.byteLength(JSON.stringify(env));
  if (bytes > MAX_ENVELOPE_BYTES) throw new BusError(`envelope is ${bytes} bytes; the limit is 64 KiB (02 §2.9)`, 'too-large');
}
