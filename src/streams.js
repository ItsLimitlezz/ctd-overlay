// A stream's status (the Live page's streams, 08 §8.4): what feeds an overlay or a show, and
// whether it is on air there. A stream is a show (its members run together), or an overlay outside
// one; what feeds it is its bindings (01 §1.3): "all", or connection ids. A show's are its members'
// together, and one member bound to "all" makes the show's "all".
//
//   { connections: [{ id, name, connector, status, detail? }],
//     onAir?: boolean, platforms: [{ platform, live?, title?, startedAt?, viewers?, stale? }],
//     profiles?: [{ connection, name, color?, status, startedAt? }], viewers?: number }
//
// - connections: the turned-on connections that feed it (every one for "all"), by name and status
//   only: whoever reads overlays or shows sees it, connections:read or not, so never a setting.
// - profiles: the CTD Multi-Stream profiles those connections follow (06 §6.11), from the ones
//   connected now: its status says live before any platform does (offline, starting, live,
//   stopping).
// - platforms: each platform those connections report on (stream.<platform>.live | title |
//   startedAt, viewers.<platform>), each value chosen as an overlay bound the same way sees it
//   (bus/index.js: fresh over held, direct over relay, the older connection), the core's own
//   values (a demo) left out. stale: a value shown is held through an error (02 §2.8).
// - onAir: true while any platform or profile is live; false when platforms or profiles said
//   whether they are and none is; absent when nothing says (no connection, no data yet):
//   "Unknown", never "Offline".
// - viewers: the platforms' counts added up when any is known; absent otherwise, never 0 (H6).
//
// It is worked out on each read, like a show's `live`: it never moves a resource's ETag.
import { bindingOf } from './overlays/registry.js';

const LIVE = /^stream\.([a-z0-9-]+)\.live$/;
const VIEWERS = /^viewers\.(?!total$|stale$)([a-z0-9-]+)$/;
const ORDER = ['twitch', 'youtube', 'kick', 'facebook', 'x', 'instagram', 'tiktok'];
const rank = (p) => (ORDER.includes(p) ? ORDER.indexOf(p) : ORDER.length);

export function createStreams({ bus, connections, store }) {
  // The turned-on connections bindings name ("all": every one), as the connector host sums them up.
  function fedBy(binding) {
    const list = connections?.summary() || [];
    return list.filter((c) => c.status !== 'disabled' && (binding === 'all' || binding.includes(c.id)));
  }

  // The status of a stream fed by binding ("all" or connection ids).
  function of(binding) {
    const feeding = fedBy(binding === 'all' || Array.isArray(binding) ? binding : []);
    const ids = new Set(feeding.map((c) => c.id));
    const allow = (owner) => ids.has(owner);
    const names = new Set();
    for (const id of ids) {
      for (const { key } of bus.stateOf(id)) {
        const m = LIVE.exec(key) || VIEWERS.exec(key);
        if (m) names.add(m[1]);
      }
    }
    const platforms = [...names].sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : 1)).map((platform) => {
      const read = (key) => bus.fromConnections(key, allow);
      const live = read(`stream.${platform}.live`);
      const title = read(`stream.${platform}.title`);
      const started = read(`stream.${platform}.startedAt`);
      const viewers = read(`viewers.${platform}`);
      const at = typeof started?.value === 'number' || typeof started?.value === 'string' ? new Date(started.value) : undefined;
      return {
        platform,
        ...(typeof live?.value === 'boolean' ? { live: live.value } : {}),
        ...(typeof title?.value === 'string' && title.value ? { title: title.value } : {}),
        ...(at && Number.isFinite(at.getTime()) ? { startedAt: at.toISOString() } : {}),
        ...(typeof viewers?.value === 'number' && Number.isFinite(viewers.value) && viewers.value >= 0 ? { viewers: Math.round(viewers.value) } : {}),
        ...([live, title, started, viewers].some((e) => e?.stale) ? { stale: true } : {}),
      };
    });
    const said = platforms.filter((p) => typeof p.live === 'boolean');
    const counts = platforms.filter((p) => p.viewers !== undefined);
    const profiles = feeding.filter((c) => c.profile && ['connected', 'degraded'].includes(c.status)).map((c) => ({
      connection: c.id,
      name: String(c.profile.name || ''),
      ...(typeof c.profile.color === 'string' ? { color: c.profile.color } : {}),
      status: c.profile.status,
      ...(typeof c.profile.startedAt === 'string' ? { startedAt: c.profile.startedAt } : {}),
    }));
    const live = said.some((p) => p.live) || profiles.some((p) => p.status === 'live');
    return {
      connections: feeding.map((c) => ({ id: c.id, name: c.name, connector: c.connector, status: c.status, ...(c.detail ? { detail: c.detail } : {}) })),
      ...(said.length || profiles.length ? { onAir: live } : {}),
      platforms,
      ...(profiles.length ? { profiles } : {}),
      ...(counts.length ? { viewers: counts.reduce((n, p) => n + p.viewers, 0) } : {}),
    };
  }

  // A show's members' bindings together: "all" if any member's is, else every id they name.
  function bindingOfShow(show) {
    const ids = new Set();
    for (const id of Array.isArray(show?.overlays) ? show.overlays : []) {
      const doc = store.get('overlays', id);
      if (!doc) continue;
      const b = bindingOf(doc);
      if (b === 'all') return 'all';
      for (const c of b) ids.add(c);
    }
    return [...ids];
  }

  return {
    of,
    ofOverlay: (doc) => of(bindingOf(doc)),
    ofShow: (show) => of(bindingOfShow(show)),
  };
}
