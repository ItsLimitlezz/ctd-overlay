// What a connector may publish (06 §6.2): its capabilities decide the event types and state keys,
// and its platforms the src.platform it may put on them. A connector that tries anything else gets
// a TypeError, so a bug shows up at once instead of feeding overlays something nobody declared.
//
//   chat.read       chat.message, chat.message.deleted, chat.user.cleared, chat.cleared
//   alerts          alert.<kind>
//   viewers         viewers.<platform> (viewers.total and viewers.stale are worked out by the bus)
//   stream.status   stream.<platform>.live | title | startedAt, and stream.clock (the stream's
//                   start and frame rate on this server's clock, 02 §2.5.2)
//   music           music.nowPlaying
//   obs             obs.<key> state
//   every connector system.notice (operator-facing), and x-<vendor>.* if it names a vendor
// <key>.stale is never a connector's: the host marks values held through an error (02 §2.8).
import { CHAT_TYPES } from '../bus/names.js';

export const CAPABILITIES = Object.freeze(['chat.read', 'alerts', 'viewers', 'stream.status', 'music', 'obs']);
// The platforms a connection may speak for (02 §2.1 src.platform): the standard's, and those CTD
// Relay relays.
export const PLATFORMS = Object.freeze(['twitch', 'kick', 'youtube', 'facebook', 'x', 'instagram', 'tiktok', 'spotify', 'obs', 'custom']);

export function namesOf(def) {
  const caps = new Set(def.capabilities || []);
  const platforms = new Set(def.platforms || (def.platform ? [def.platform] : []));
  const vendor = def.vendor ? `x-${def.vendor}.` : undefined;
  const what = () => `${def.name} may publish ${[...caps].join(', ') || 'nothing but notices'}${platforms.size ? ` for ${[...platforms].join(', ')}` : ''}`;
  return {
    platforms,
    // The platform a key is about (viewers.twitch → twitch), or undefined.
    platformOf(key) {
      const m = /^(?:viewers|stream)\.([a-z0-9-]+)(?:\.|$)/.exec(key);
      return m && platforms.has(m[1]) ? m[1] : undefined;
    },
    event(type) {
      if (caps.has('chat.read') && CHAT_TYPES.has(type)) return;
      if (caps.has('alerts') && /^alert\.[a-z]+$/.test(type)) return;
      if (type === 'system.notice') return;
      if (vendor && type.startsWith(vendor)) return;
      throw new TypeError(`"${type}" isn't an event a ${def.name} connection may publish (${what()}).`);
    },
    state(key) {
      if (/\.stale$/.test(key)) throw new TypeError(`"${key}" is set by the connector host while a value is held through an error (02 §2.8); a connector never sets it.`);
      let m;
      if (caps.has('viewers') && (m = /^viewers\.([a-z0-9-]+)$/.exec(key)) && platforms.has(m[1])) return;
      if (caps.has('stream.status') && (m = /^stream\.([a-z0-9-]+)\.(live|title|startedAt)$/.exec(key)) && platforms.has(m[1])) return;
      if (caps.has('stream.status') && key === 'stream.clock') return;
      if (caps.has('music') && key === 'music.nowPlaying') return;
      if (caps.has('obs') && /^obs\.[A-Za-z][A-Za-z0-9]*$/.test(key)) return;
      if (vendor && key.startsWith(vendor)) return;
      throw new TypeError(`"${key}" isn't state a ${def.name} connection may set (${what()}).`);
    },
    platform(p) {
      if (!platforms.has(p)) throw new TypeError(`"${p}" isn't a platform a ${def.name} connection speaks for (${[...platforms].join(', ') || 'none'}).`);
    },
  };
}
