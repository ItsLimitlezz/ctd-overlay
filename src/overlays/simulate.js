// POST /api/v1/overlays/{id}/simulate (08 §8.5): sample events into one overlay, so a template
// author can watch each state without going live. Simulated envelopes carry
// src.connector = "simulator" and reach the targeted overlay only: never other overlays, the
// events API or webhooks. Simulated state (a track, a viewer count, the count gone absent) is
// held on that overlay's channel only, so the platform's real state is never touched, and for
// SIM_HOLD_MS at most: then (or at "reset") the overlay gets the real value back.
//
//   { "kind": "chat" | "follow" | "subscription" | "gift" | "raid" | "cheer" | "tip"
//            | "track" | "viewers" | "viewers-clear" | "media.play" | "media.stop" | "reset",
//     ...options }
//
// The answer says what was sent and whether the overlay takes it (its template consumes it).
//
// It needs overlays:control, like taking a scene (auth/routes.js), and a JSON body with the fields
// below only: a misspelt option is refused, not ignored (07 §7.11). The answer goes through the
// API's conventions, so an Idempotency-Key makes a button pressed twice send once (03 §3.1).
import { BusError } from '../bus/index.js';
import { ApiError } from '../http/api.js';
import { newId } from '../ids.js';

const BODY_LIMIT = 16 * 1024;
// Every option a kind below reads.
const FIELDS = ['kind', 'name', 'text', 'roles', 'months', 'count', 'viewers', 'bits', 'title', 'artist', 'value', 'url', 'mediaId'];
const SIM = { connector: 'simulator' };
export const SIM_HOLD_MS = 60000;
// 02 §2.3: the closed set of chat roles.
const ROLES = new Set(['broadcaster', 'moderator', 'vip', 'subscriber', 'member', 'verified', 'founder', 'artist', 'bot']);
const MEDIA_URL = /^\/media\/[A-Za-z0-9_-]+\/[^/\\?#\s]+$/;
let seq = 0;

const NAMES = ['Trapment', 'BIA', 'NightRaider', 'xX_long_display_name_that_wraps_Xx', 'Deecee'];
const user = (opts, i = seq) => {
  const name = typeof opts.name === 'string' && opts.name ? opts.name.slice(0, 60) : NAMES[i % NAMES.length];
  return { id: `twitch:sim${i}`, name, avatar: undefined };
};

// What each kind publishes: [{ type, data } for events, { state: { key: value } } for state].
const KINDS = {
  chat: (o) => [{ type: 'chat.message', data: chatMessage(o) }],
  follow: (o) => [alert('follow', o, {})],
  subscription: (o) => [alert('subscription', o, { amount: { value: int(o.months, 1, 1, 120), unit: 'months' }, tier: '1' })],
  gift: (o) => [alert('gift', o, { amount: { value: int(o.count, 25, 1, 1000), unit: 'count' } })],
  raid: (o) => [alert('raid', o, { amount: { value: int(o.viewers, 238, 1, 1000000), unit: 'viewers' } })],
  cheer: (o) => [alert('cheer', o, { amount: { value: int(o.bits, 500, 1, 1000000), unit: 'bits' } })],
  tip: (o) => [alert('tip', o, { amount: { value: '5.00', currency: 'USD' } })],
  track: (o) => [{ state: { 'music.nowPlaying': track(o) } }],
  viewers: (o) => [{ state: { 'viewers.total': int(o.value, 1159, 0, 100000000) } }],
  'viewers-clear': () => [{ state: { 'viewers.total': undefined } }],
  'media.play': (o) => (typeof o.url === 'string' && MEDIA_URL.test(o.url) ? [{ type: 'media.play', data: { mediaId: mediaId(o), url: o.url } }] : null),
  // Naming the clip is optional for a stop (02 §2.6): without it, whatever plays stops.
  'media.stop': (o) => [{ type: 'media.stop', data: { mediaId: mediaId(o), ...(typeof o.url === 'string' && MEDIA_URL.test(o.url) ? { url: o.url } : {}) } }],
  reset: () => [{ reset: true }],
};

// A media id as the library makes them (med_ and a ULID), or a stand-in: never the caller's
// arbitrary JSON.
const mediaId = (o) => (typeof o.mediaId === 'string' && /^med_[0-9A-Za-z]{1,40}$/.test(o.mediaId) ? o.mediaId : 'med_sim');

// A number or numeric string in range, else the fallback (never Number() of the caller's objects:
// a deeply nested array would recurse in its toString).
function int(v, fallback, min, max) {
  const n = typeof v === 'number' || typeof v === 'string' ? Number(v) : NaN;
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

function alert(kind, o, extra) {
  return { type: `alert.${kind}`, data: { kind, user: user(o), gift: null, ...extra } };
}

function chatMessage(o) {
  const text = typeof o.text === 'string' && o.text ? o.text.slice(0, 500) : 'that drop 🔥 PogChamp';
  const u = user(o);
  return {
    id: newId('msg'),
    channel: 'simulator',
    user: { ...u, login: u.name.toLowerCase(), color: '#16E0FF', roles: Array.isArray(o.roles) ? [...new Set(o.roles.filter((r) => ROLES.has(r)))] : ['subscriber'], badges: [] },
    text,
    fragments: [{ type: 'text', text }],
    reply: null,
    highlighted: false,
    action: false,
  };
}

function track(o) {
  const title = typeof o.title === 'string' && o.title ? o.title.slice(0, 200) : 'Strobe';
  return {
    title,
    artists: [typeof o.artist === 'string' && o.artist ? o.artist.slice(0, 200) : 'deadmau5'],
    durationMs: 637000,
    progressMs: 0,
    progressAt: Date.now(),
    playing: true,
    source: 'simulator',
  };
}

// api: the API's conventions (http/api.js). holdMs: how long simulated state lasts (tests shorten it).
export function simulateRoutes({ api, overlays, bus, log, holdMs = SIM_HOLD_MS }) {
  function simulate({ params, body }) {
    // By slug or by id.
    const found = overlays.resolve(params.ref) || overlays.resolve(overlays.list().find((d) => d.id === params.ref)?.data.slug);
    if (!found) throw new ApiError(404, 'not-found', `There is no overlay "${params.ref}".`);
    const make = body && typeof body === 'object' && Object.prototype.hasOwnProperty.call(KINDS, body.kind) ? KINDS[body.kind] : null;
    const items = make && make(body);
    if (!items) {
      throw new ApiError(422, 'invalid', `"kind" must be one of ${Object.keys(KINDS).join(', ')} (media.play needs a /media/… url).`);
    }
    seq++;
    const { channel } = found;
    const sent = [];
    for (const item of items) {
      if (item.reset) {
        const ended = channel.simulating;
        channel.endSimulation();
        sent.push({ reset: ended });
      } else if (item.state) {
        for (const [key, value] of Object.entries(item.state)) {
          const takes = channel.accepts({ type: 'state.changed', src: SIM, data: { key } });
          if (takes) channel.simulate(key, value, holdMs);
          sent.push({ state: key, delivered: takes, holdMs: takes ? holdMs : undefined });
        }
      } else {
        const takes = channel.accepts({ type: item.type, src: SIM, data: item.data });
        let env;
        try {
          env = bus.publish(item.type, item.data, { src: SIM, target: found.doc.id });
        } catch (err) {
          // What the caller sent doesn't make an envelope (too large): their mistake, not a crash.
          if (err instanceof BusError) throw new ApiError(422, 'invalid', err.message);
          throw err;
        }
        sent.push({ type: env.type, id: env.id, delivered: takes });
      }
    }
    log.info('simulated', { overlay: found.doc.data.slug, kind: body.kind });
    return { overlay: found.doc.data.slug, sent };
  }
  return [api.route({ method: 'POST', path: '/api/v1/overlays/:ref/simulate', scope: 'overlays:control', command: true, tag: 'Overlays', summary: 'Send sample events or state to one overlay (08 §8.5)', body: { limit: BODY_LIMIT, fields: FIELDS }, run: simulate })];
}
