// The bus (01 §1.2): owns all live data. Connectors and the core publish events and set state;
// the bus stamps each envelope with an ID and server time, keeps current state and a moderated
// chat buffer, and routes every envelope to the overlay channels that may see it and to
// API-level subscribers (the /api/v1/events stream, the overlays' bound settings, later webhooks).
//
// State is kept per owner: the core ('') and each connection (src.connection) have their own value
// for a key, so two accounts on one platform, or a relay (CTD Multi-Stream) beside a direct
// connector, never overwrite each other. A connection that follows several streams at its service
// (CTD Multi-Stream's profiles) sets each one's values as a feed of its own, "<connection>/<profile>"
// (src.profile; owners.js): what is done to a connection (cleared, ranked) is done to its feeds. Each overlay sees the one value its bindings allow
// (01 §1.3), chosen by one rule everywhere (resolve()):
//   1. the core's own value, if it set one (the demo, a test, PUT /state from an app);
//   2. a fresh value over one held through an error (02 §2.8);
//   3. a direct connection over a relay (setRank(owner, 1));
//   4. the older connection (connection ids sort by creation time).
// Some keys are worked out rather than set (02 §2.5, §2.8): viewers.total is the sum of the
// viewers.<platform> values the overlay sees (one per platform), viewers.stale is true while any of
// those is held through an error, and <key>.stale is true while the value shown for <key> is held.
// A value the core sets for one of them wins over the worked-out one. Installation-wide (GET
// /api/v1/state, the /events stream) is the same rule with every connection allowed.
import { ulid as defaultIdgen } from '../ids.js';
import { silentLogger } from '../log.js';
import { Channel, changeData } from './channel.js';
import { KEY, TYPE } from './names.js';
import { connectionOf, isOfConnection, ownerOf } from './owners.js';

export class BusError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'BusError';
    this.code = code;
  }
}

const MAX_ENVELOPE_BYTES = 64 * 1024; // 02 §2.9
const CHAT_BUFFER = 200; // the most any template may ask for (02 §2.3)
const CORE = Object.freeze({ connector: 'core' });
const ALL = () => true;
// viewers.<platform>: what viewers.total adds up (not total or stale themselves).
const VIEWERS = /^viewers\.(?!total$|stale$)[a-z0-9-]+$/;

export { ownerOf };
const PROFILE = /^[^\s/]{1,100}$/;

export function createBus({ now = Date.now, idgen = defaultIdgen, timers = { setTimeout, clearTimeout }, log = silentLogger } = {}) {
  const state = new Map(); // key → Map(owner → { value, src, ts, stale? })
  const ranks = new Map(); // owner → rank: 0 direct (the default), 1 a relay
  const viewerKeys = new Set(); // viewers.<platform> keys someone has a value for
  const channels = new Map();
  const globalSubs = new Set();
  const watchers = new Set(); // told the keys whose values may have changed for someone
  let chat = []; // chat.message envelopes still visible after moderation, oldest first
  let alertQueue; // set by useAlertQueue(); without one, alerts go straight to overlays
  let lastId = idgen(now());

  // ---- choosing the value a set of owners shows ----------------------------------------------
  // A feed ranks as its connection does (a CTD Multi-Stream profile is a relay like it).
  const rank = (owner) => ranks.get(owner) ?? ranks.get(connectionOf(owner)) ?? 0;
  // The owners of a connection's values: itself and its feeds ('' only for the core).
  const ownersUnder = (owners, owner) => [...owners.keys()].filter((o) => (owner ? isOfConnection(o, owner) : o === ''));
  // a beats b (both connection entries): fresh over stale, direct over relay, older connection.
  const beats = (a, b) => (Boolean(a.e.stale) !== Boolean(b.e.stale) ? !a.e.stale
    : rank(a.owner) !== rank(b.owner) ? rank(a.owner) < rank(b.owner)
      : a.owner < b.owner);
  function pick(key, allow) {
    const owners = state.get(key);
    if (!owners) return undefined;
    const core = owners.get('');
    if (core) return core;
    return best(owners, allow)?.e;
  }
  // The connection entry that wins among owners passing allow (rules 2–4): { owner, e }.
  function best(owners, allow) {
    let top;
    for (const [owner, e] of owners) {
      if (!owner || !allow(owner)) continue;
      const c = { owner, e };
      if (!top || beats(c, top)) top = c;
    }
    return top;
  }
  // { value, src, stale? } that owners passing allow(owner) show for key, set or worked out.
  function resolve(key, allow = ALL) {
    const direct = pick(key, allow);
    if (direct) return direct;
    if (key === 'viewers.total') {
      let sum = 0;
      let any = false;
      for (const k of viewerKeys) {
        const e = pick(k, allow);
        if (e && typeof e.value === 'number' && Number.isFinite(e.value)) {
          sum += e.value;
          any = true;
        }
      }
      return any ? { value: sum, src: CORE } : undefined;
    }
    if (key === 'viewers.stale') {
      for (const k of viewerKeys) if (pick(k, allow)?.stale) return { value: true, src: CORE };
      return undefined;
    }
    if (key.endsWith('.stale')) return pick(key.slice(0, -6), allow)?.stale ? { value: true, src: CORE } : undefined;
    return undefined;
  }
  // Every key that may have a value for someone: what is set, and what is worked out from it.
  function* visibleKeys() {
    for (const [key, owners] of state) {
      yield key;
      for (const e of owners.values()) {
        if (e.stale) { yield `${key}.stale`; break; }
      }
    }
    if (viewerKeys.size) {
      if (!state.has('viewers.total')) yield 'viewers.total';
      if (!state.has('viewers.stale')) yield 'viewers.stale';
    }
  }
  // The keys a change of key can change for someone.
  const affectedBy = (key) => (VIEWERS.test(key) ? [key, `${key}.stale`, 'viewers.total', 'viewers.stale'] : [key, `${key}.stale`]);
  const text = (e) => (e === undefined ? undefined : JSON.stringify(e.value));

  // Makes a change to the per-owner state of keys (mutate) and tells everyone whose view of it
  // moved: the API-level subscribers (installation-wide), each channel (as its overlay sees it) and
  // the watchers. Returns the installation-wide envelope for the first key, or null when that
  // didn't change.
  function change(keys, mutate, src = CORE) {
    const key = keys[0];
    const affected = [...new Set(keys.flatMap(affectedBy))];
    const before = affected.map((k) => text(resolve(k)));
    const seen = [...channels.values()].map((ch) => [ch, ch.peek(affected)]);
    mutate();
    let main = null;
    affected.forEach((k, i) => {
      const after = resolve(k);
      if (text(after) === before[i]) return;
      const env = bus.envelope('state.changed', changeData(k, after?.value, before[i] === undefined ? undefined : JSON.parse(before[i])), after?.src ?? (k === key ? src : CORE));
      if (k === key) main = env;
      for (const fn of globalSubs) {
        try { fn(env); } catch (err) { log.error('bus subscriber failed', { err }); }
      }
    });
    for (const [ch, was] of seen) {
      try { ch.stateChanged(affected, was, src); } catch (err) { log.error('a channel could not take a state change', { channel: ch.id, err }); }
    }
    for (const fn of watchers) {
      try { fn(affected); } catch (err) { log.error('bus state watcher failed', { err }); }
    }
    return main;
  }

  function setEntry(key, owner, entry) {
    let owners = state.get(key);
    if (!owners) state.set(key, (owners = new Map()));
    owners.set(owner, entry);
    if (VIEWERS.test(key)) viewerKeys.add(key);
  }
  function dropEntry(key, owner) {
    const owners = state.get(key);
    if (!owners) return;
    owners.delete(owner);
    if (!owners.size) {
      state.delete(key);
      viewerKeys.delete(key);
    }
  }

  const bus = {
    now,
    timers,
    log,
    cursor: () => lastId,

    // Builds a stamped envelope without routing it (channels use this for their own updates).
    envelope(type, data, src = CORE) {
      lastId = idgen(now());
      return { id: lastId, type, ts: now(), src, data };
    },

    // Publishes an event. `target` sends it to one channel only and nowhere else (the simulator,
    // 08 §8.5). `backfill` (chat.message only): history from before this process heard it (a
    // connector catching up after a restart): it goes into the chat buffer, which snapshots show,
    // but is never sent live, so overlays don't play minutes of old chat at once.
    publish(type, data = {}, { src = CORE, target, backfill = false } = {}) {
      if (typeof type !== 'string' || !TYPE.test(type)) throw new BusError(`"${type}" isn't a registered event type or a custom.* / x-<vendor>.* type`, 'bad-type');
      if (type === 'state.changed') throw new BusError('use setState() to change state', 'bad-type');
      checkSrc(src);
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new BusError('event data must be a JSON object', 'bad-data');
      const env = bus.envelope(type, toJson(data), src);
      checkSize(env);
      if (target !== undefined) {
        const ch = channels.get(target);
        if (ch && ch.accepts(env)) {
          // A simulated alert waits its turn like a real one (05 §5.5).
          if (queued(env)) alertQueue.enqueue(env, [target]);
          else ch.offer(env);
        }
        return env;
      }
      if (type.startsWith('chat.')) moderate(env);
      if (backfill && type === 'chat.message') return env;
      route(env);
      return env;
    },

    // Sets a state key for src's owner (src.connection, or the core); `undefined` removes it (a
    // missing value is absent, never null or 0, 02 §2.8). A value set again clears its stale mark.
    // Returns the installation-wide state.changed envelope when the value shown installation-wide
    // changed, else null.
    setState(key, value, { src = CORE } = {}) {
      if (typeof key !== 'string' || !KEY.test(key)) throw new BusError(`bad state key "${key}"`, 'bad-key');
      checkSrc(src);
      // null means "no value" too: a key without a value is absent, never null (02 §2.2). Checked
      // after the JSON round trip, which turns NaN, Infinity and an invalid Date into null.
      let json = value === undefined ? undefined : toJson(value);
      if (json === null) json = undefined;
      const owner = ownerOf(src);
      const current = state.get(key)?.get(owner);
      if (!current && json === undefined) return null;
      if (current && !current.stale && JSON.stringify(current.value) === JSON.stringify(json)) return null;
      // Size-checked before anything is stored: a refused change must leave the old value, not
      // keep a new one that no overlay was ever told about.
      if (json !== undefined) {
        checkSize({ id: lastId, type: 'state.changed', ts: now(), src, data: changeData(key, json, resolve(key)?.value) });
        checkSize({ id: lastId, type: 'state.changed', ts: now(), src, data: changeData(key, json, current?.value) });
      }
      return change([key], () => {
        if (json === undefined) dropEntry(key, owner);
        else setEntry(key, owner, { value: json, src, ts: now() });
      }, src);
    },

    // Marks owner's value for key as held through an error (02 §2.8), or fresh again. The value
    // stays; the connector host takes it away when the hold runs out.
    setStale(key, owner, stale = true) {
      const e = state.get(key)?.get(owner);
      if (!e || Boolean(e.stale) === Boolean(stale)) return false;
      change([key], () => {
        if (stale) e.stale = true;
        else delete e.stale;
      }, e.src);
      return true;
    },

    // Takes every value an owner set away (a connection stopped on purpose, or deleted): a
    // connection's id takes its feeds' values too ("<id>/<profile>"); a feed's, that feed's only.
    clearOwner(owner) {
      let n = 0;
      for (const [key, owners] of [...state]) {
        const mine = ownersUnder(owners, owner);
        if (!mine.length) continue;
        const src = owners.get(mine[0]).src;
        change([key], () => { for (const o of mine) dropEntry(key, o); }, src);
        n += mine.length;
      }
      return n;
    },

    // What an owner has set now (that owner only, not its feeds): [{ key, value, stale? }].
    stateOf(owner) {
      const out = [];
      for (const [key, owners] of state) {
        const e = owners.get(owner);
        if (e) out.push({ key, value: structuredClone(e.value), ...(e.stale ? { stale: true } : {}) });
      }
      return out;
    },

    // What a connection and its feeds have set now: [{ owner, key, value, src, stale? }].
    connectionState(connId) {
      const out = [];
      for (const [key, owners] of state) {
        for (const o of ownersUnder(owners, connId)) {
          const e = owners.get(o);
          out.push({ owner: o, key, value: structuredClone(e.value), src: e.src, ...(e.stale ? { stale: true } : {}) });
        }
      }
      return out;
    },

    // What the connections passing allow(owner) say for key, by rules 2–4 (the core's own value
    // left out: a stream's status is what its connections report, not what a demo set):
    // { value, owner, stale? }, or undefined.
    fromConnections(key, allow = ALL) {
      const owners = state.get(key);
      const top = owners && best(owners, allow);
      return top && { value: structuredClone(top.e.value), owner: top.owner, ...(top.e.stale ? { stale: true } : {}) };
    },

    // 1 for a relay (CTD Multi-Stream): a direct connection's value wins a tie with it. A
    // connection's rank is its feeds' too.
    setRank(owner, r = 0) {
      const next = r ? 1 : 0;
      if ((ranks.get(owner) || 0) === next) return;
      const set = () => {
        if (next) ranks.set(owner, next);
        else ranks.delete(owner);
      };
      const keys = [...state].filter(([, owners]) => ownersUnder(owners, owner).length).map(([key]) => key);
      if (keys.length) change(keys, set);
      else set();
    },

    // The value shown installation-wide.
    getState(key) {
      const e = resolve(key);
      return e ? structuredClone(e.value) : undefined;
    },

    // { value, src, stale? } as stored (not a copy), for owners passing allow; channels use it.
    resolve,
    stateEntry: (key) => resolve(key),
    visibleKeys,
    // [key, { value, src }] of everything shown installation-wide, worked-out keys included.
    *stateEntries() {
      for (const key of visibleKeys()) {
        const e = resolve(key);
        if (e) yield [key, e];
      }
    },
    // Everything shown installation-wide, as { key: value } (GET /api/v1/state).
    stateView() {
      const out = {};
      for (const [key, e] of bus.stateEntries()) out[key] = structuredClone(e.value);
      return out;
    },
    chatRecent: () => chat,

    // A deleted connection's chat (its feeds' too) leaves the buffer: a new overlay's snapshot
    // doesn't show it.
    purgeChat(owner) {
      const before = chat.length;
      chat = chat.filter((m) => (owner ? !isOfConnection(ownerOf(m.src), owner) : ownerOf(m.src) !== ''));
      return before - chat.length;
    },

    // The channel for an overlay, created on first use; calling again updates what it consumes
    // and which connections it is bound to.
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
      alertQueue?.forget(id);
    },

    // The alert queue alerts go through on their way to overlays (src/alerts/queue.js).
    useAlertQueue(q) { alertQueue = q; },
    // Sends env to one channel, if it is still there and accepts it (the alert queue's delivery).
    deliver(id, env) {
      const ch = channels.get(id);
      if (ch && ch.accepts(env)) ch.offer(env);
    },

    // Every routed envelope (not targeted or channel-only ones), installation-wide, for API-level
    // consumers.
    subscribeAll(fn) {
      globalSubs.add(fn);
      return () => globalSubs.delete(fn);
    },

    // fn(keys) after any change to the state behind keys, whoever's view of it moved (an
    // overlay's x-skp-bind setting follows the value that overlay sees, 04 §4.3).
    onState(fn) {
      watchers.add(fn);
      return () => watchers.delete(fn);
    },

    close() {
      for (const ch of channels.values()) ch.close();
      channels.clear();
      globalSubs.clear();
      watchers.clear();
    },
  };

  // An alert goes through the queue unless it already has its display window.
  const queued = (env) => Boolean(alertQueue) && env.type.startsWith('alert.') && !env.data.display;

  function route(env) {
    if (queued(env)) {
      // Alerts go to overlays through the alert queue, which gives each its display window when
      // its turn comes (05 §5.5); API-level subscribers get them as they arrive.
      const ids = [];
      for (const [id, ch] of channels) if (ch.accepts(env)) ids.push(id);
      if (ids.length) alertQueue.enqueue(env, ids);
    } else {
      for (const ch of channels.values()) {
        if (ch.accepts(env)) ch.offer(env);
      }
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
  // A feed of a connection (06 §6.11): the profile it follows at its service.
  if (src.profile !== undefined && (typeof src.profile !== 'string' || !PROFILE.test(src.profile) || !src.connection)) {
    throw new BusError('src.profile is a profile id (no spaces or "/", at most 100 characters) of the connection that sends it', 'bad-src');
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
