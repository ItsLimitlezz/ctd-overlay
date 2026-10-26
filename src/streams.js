// A stream's status (the Live page's streams, 08 §8.4): what feeds an overlay or a show, and
// whether it is on air there. A stream is a show (its members run together), or an overlay outside
// one; what feeds it is its bindings (01 §1.3): "all", or connection ids, whole or one of their
// profiles ("<connection>/<profile>", bus/owners.js). A show's are its members' together, and one
// member bound to "all" makes the show's "all".
//
//   { connections: [{ id, name, connector, status, detail? }],
//     onAir?: boolean, platforms: [{ platform, live?, title?, startedAt?, viewers?, stale? }],
//     profiles?: [{ connection, profile, name, color?, status, startedAt? }], viewers?: number,
//     obs?: [{ source, name, landscape?, vertical?, streaming?, recording?, stale?, seen?, scenes? }] }
//
// - connections: the turned-on connections that feed it (every one for "all"), by name and status
//   only: whoever reads overlays or shows sees it, connections:read or not, so never a setting.
// - profiles: the CTD Relay profiles those connections follow (06 §6.11), from the ones
//   connected now, each on its own: a connection that follows every profile gives all of them when
//   bound whole, else the ones named. Its status says live before any platform does (offline,
//   starting, live, stopping; "missing" for a profile named that the connection doesn't follow
//   any more). A binding to one profile reports that profile's platforms and viewers only.
// - platforms: each platform those connections report on (stream.<platform>.live | title |
//   startedAt, viewers.<platform>), each value chosen as an overlay bound the same way sees it
//   (bus/index.js: fresh over held, direct over relay, the older connection), the core's own
//   values (a demo) left out. stale: a value shown is held through an error (02 §2.8).
// - onAir: true while any platform or profile is live; false when platforms or profiles said
//   whether they are and none is; absent when nothing says (no connection, no data yet):
//   "Unknown", never "Offline".
// - viewers: the platforms' counts added up when any is known; absent otherwise, never 0 (H6).
// - obs: per feed that says anything about OBS (source: "<connection>" or "<connection>/<profile>",
//   name "Relay · DPRTMNT"): each canvas's program scene { scene, sceneUuid?, since? }, streaming
//   and recording, stale while held through an error, and seen: { landscape, vertical }, the OBS
//   scenes it has shown since the platform started, newest first (Follow OBS's choices); scenes:
//   { landscape?, vertical? }, each canvas's whole scene list in OBS's order when the plugin sends it.
//
// It is worked out on each read, like a show's `live`: it never moves a resource's ETag.
import { connectionOf, profileOf } from './bus/owners.js';
import { bindingOf, scopeOf } from './overlays/registry.js';

const LIVE = /^stream\.([a-z0-9-]+)\.live$/;
const OBS = /^obs\.(scene\.(landscape|vertical)|streaming|recording)$/;
const OBS_LIST = /^obs\.scenes\.(landscape|vertical)$/;
const VIEWERS = /^viewers\.(?!total$|stale$)([a-z0-9-]+)$/;
const ORDER = ['twitch', 'youtube', 'kick', 'facebook', 'x', 'instagram', 'tiktok'];
const rank = (p) => (ORDER.includes(p) ? ORDER.indexOf(p) : ORDER.length);

// obs: Follow OBS (src/obs/follow.js), for the OBS scenes each feed has shown.
export function createStreams({ bus, connections, store, obs }) {
  // The turned-on connections bindings name ("all": every one), whole or by profile, as the
  // connector host sums them up.
  function fedBy(binding) {
    const list = connections?.summary() || [];
    return list.filter((c) => c.status !== 'disabled' && scopeOf(binding, c.id) !== undefined);
  }

  // The status of a stream fed by binding ("all", or connection ids and "<connection>/<profile>").
  function of(binding) {
    const b = binding === 'all' || Array.isArray(binding) ? binding : [];
    const feeding = fedBy(b);
    // Per connection, what of it feeds the stream: null (all of it), or the profiles named.
    const scopes = new Map(feeding.map((c) => [c.id, scopeOf(b, c.id)]));
    const allow = (owner) => {
      const conn = connectionOf(owner);
      if (!scopes.has(conn)) return false;
      const s = scopes.get(conn);
      return s === null || s.includes(profileOf(owner));
    };
    const names = new Set();
    for (const id of scopes.keys()) {
      for (const { owner, key } of bus.connectionState(id)) {
        if (!allow(owner)) continue;
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
    // Each profile on its own ("DPRTMNT · Live", "Miami or Bust · Offline"): a connection's one, or
    // those of every-profile connections it takes (all of them, or the ones named; one named that
    // the connection doesn't follow now is "missing").
    const profiles = [];
    for (const c of feeding) {
      if (!['connected', 'degraded'].includes(c.status)) continue;
      const known = Array.isArray(c.profiles) ? c.profiles : [];
      const s = scopes.get(c.id);
      const take = c.everyProfile ? (s === null ? known : known.filter((p) => s.includes(p.id))) : known.slice(0, 1);
      for (const p of take) {
        profiles.push({
          connection: c.id,
          profile: p.id,
          name: String(p.name || ''),
          ...(typeof p.color === 'string' ? { color: p.color } : {}),
          status: p.status,
          ...(typeof p.startedAt === 'string' ? { startedAt: p.startedAt } : {}),
        });
      }
      if (c.everyProfile && s) for (const id of s.filter((x) => !known.some((p) => p.id === x))) profiles.push({ connection: c.id, profile: id, name: id, status: 'missing' });
    }
    // OBS, as each feed of it says (CTD Relay's OBS events, 06 §6.11): its canvases' program
    // scenes, streaming and recording; and the scenes it has shown (for Follow OBS's settings).
    const obsOut = [];
    for (const c of feeding) {
      const byOwner = new Map();
      const lists = new Map(); // owner → { landscape?, vertical? }, each canvas's scene list
      for (const { owner, key, value, stale } of bus.connectionState(c.id)) {
        const l = OBS_LIST.exec(key);
        if (l && allow(owner) && Array.isArray(value)) {
          const scenes = value.filter((s) => s && typeof s.scene === 'string').map((s) => ({ scene: s.scene, ...(typeof s.sceneUuid === 'string' ? { sceneUuid: s.sceneUuid } : {}) }));
          lists.set(owner, { ...lists.get(owner), [l[1]]: scenes });
        }
        const m = OBS.exec(key);
        if (!m || !allow(owner)) continue;
        if (!byOwner.has(owner)) byOwner.set(owner, {});
        const e = byOwner.get(owner);
        if (stale) e.stale = true;
        if (m[2] && value && typeof value === 'object' && typeof value.scene === 'string') {
          const since = typeof value.since === 'number' ? new Date(value.since) : undefined;
          e[m[2]] = { scene: value.scene, ...(typeof value.sceneUuid === 'string' ? { sceneUuid: value.sceneUuid } : {}), ...(since && Number.isFinite(since.getTime()) ? { since: since.toISOString() } : {}) };
        } else if (!m[2] && typeof value === 'boolean') e[m[1]] = value;
      }
      for (const [owner, e] of [...byOwner].sort(([a], [b]) => (a < b ? -1 : 1))) {
        if (!e.landscape && !e.vertical && e.streaming === undefined && e.recording === undefined) continue;
        const p = profileOf(owner);
        const pname = p && (Array.isArray(c.profiles) ? c.profiles : []).find((x) => x.id === p)?.name;
        const seen = obs?.seen(owner);
        obsOut.push({ source: owner, name: p ? `${c.name} · ${pname || p}` : c.name, ...e, ...(seen && (seen.landscape.length || seen.vertical.length) ? { seen } : {}), ...(lists.has(owner) ? { scenes: lists.get(owner) } : {}) });
      }
    }
    const live = said.some((p) => p.live) || profiles.some((p) => p.status === 'live');
    // A connection's health as this stream sees it: fed by only some of an every-profile
    // connection's profiles, only their trouble counts (Miami or Bust's Instagram going down isn't
    // DPRTMNT's problem).
    const healthOf = (c) => {
      const s = scopes.get(c.id);
      if (!c.everyProfile || s === null || !['connected', 'degraded'].includes(c.status)) return { status: c.status, ...(c.detail ? { detail: c.detail } : {}) };
      const mine = (Array.isArray(c.profiles) ? c.profiles : []).filter((p) => s.includes(p.id) && p.detail).map((p) => p.detail);
      return mine.length ? { status: 'degraded', detail: mine.join(' · ') } : { status: 'connected' };
    };
    return {
      connections: feeding.map((c) => ({ id: c.id, name: c.name, connector: c.connector, ...healthOf(c) })),
      ...(said.length || profiles.length ? { onAir: live } : {}),
      platforms,
      ...(profiles.length ? { profiles } : {}),
      ...(counts.length ? { viewers: counts.reduce((n, p) => n + p.viewers, 0) } : {}),
      ...(obsOut.length ? { obs: obsOut } : {}),
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
