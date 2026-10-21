// Follow OBS (06 §6.9, 09 §9.7): a show, or an overlay outside a show, takes the scene mapped to the
// OBS program scene as OBS changes it. The operator switches once, in OBS, and the graphics follow.
//
// What OBS shows comes from the state its connection sets for each feed (06 §6.11: CTD Relay's
// profiles): obs.scene.landscape and obs.scene.vertical, { scene, sceneUuid?, appId, since }. A
// show's or an overlay's `followObs` (mapping.js) says what follows what:
//
// - canvas: the OBS canvas that drives it. A show shares one scene across its members (its
//   landscape and vertical overlays take every scene together), so one canvas drives it: the main
//   (landscape) one by default; a vertical show or overlay follows the vertical canvas.
// - source: whose OBS ("<connection>" or "<connection>/<profile>", a feed as bindings name it).
//   Absent: the one feed of the show's (overlay's) connections that has OBS scenes; with none or
//   several, nothing is followed until one is picked (the API refuses turning it on while several
//   are there, the UI asks).
// - map: OBS scene → one of the members' scenes, matched by the scene's uuid, else its name (a scene
//   renamed in OBS keeps its uuid; one made again keeps its name); otherwise: the scene for an OBS
//   scene not in the map; absent, such a scene changes nothing.
//
// Only a real change acts: the scene a feed shows for the canvas moved to another one (Relay's
// resend of an unchanged scene changes no state); the first scene a feed shows after a start
// changes nothing. A mapped scene that is on already isn't taken again (a timed scene isn't
// restarted). The operator's own takes still work: the next change in OBS applies again. Each take
// is logged and in the audit log (action obs.follow, actor "obs"), and the show (the overlay) says
// so (sceneByObs: { at, obsScene, canvas, source }) until another take.
//
// The OBS scenes each feed has shown since the platform started (newest first, OBS_SEEN per canvas)
// are kept in memory, so the settings can offer the scenes OBS really has (seen()).
import { listAllows } from '../bus/owners.js';
import { bindingOf } from '../overlays/registry.js';
import { CANVASES, mappedScene } from './mapping.js';

const OBS_SEEN = 30;
const identity = (v) => (v && typeof v === 'object' && typeof v.scene === 'string' ? `${v.sceneUuid || ''}\n${v.scene}` : undefined);

// record(action, details): the audit log. passive: a look at the data that changes nothing.
export function createObsFollow({ bus, store, shows, overlays, log, record = () => {}, passive = false }) {
  const last = new Map(); // "<owner>\n<canvas>" → the identity of the scene it showed last
  const seen = new Map(); // owner → { landscape: [{ scene, sceneUuid? }], vertical: [...] }, newest first

  function note(owner, canvas, value) {
    const s = seen.get(owner) || { landscape: [], vertical: [] };
    const same = (x) => (value.sceneUuid && x.sceneUuid === value.sceneUuid) || (x.scene === value.scene && (x.sceneUuid || '') === (value.sceneUuid || ''));
    s[canvas] = [{ scene: value.scene, ...(value.sceneUuid ? { sceneUuid: value.sceneUuid } : {}) }, ...s[canvas].filter((x) => !same(x))].slice(0, OBS_SEEN);
    seen.set(owner, s);
  }

  // The feeds that have OBS scenes now, of those binding allows (an overlay's bindings, a show's
  // members' together, or [source]).
  function candidates(binding) {
    const owners = new Set();
    for (const canvas of CANVASES) for (const e of bus.entriesOf(`obs.scene.${canvas}`)) if (e.owner) owners.add(e.owner);
    return [...owners].filter((o) => binding === 'all' || listAllows(Array.isArray(binding) ? binding : [], o)).sort();
  }
  // A show's members' bindings together: "all" if any member's is (as streams.js does).
  function bindingOfShow(overlayIds) {
    const ids = new Set();
    for (const id of Array.isArray(overlayIds) ? overlayIds : []) {
      const doc = store.get('overlays', id);
      if (!doc) continue;
      const b = bindingOf(doc);
      if (b === 'all') return 'all';
      for (const c of b) ids.add(c);
    }
    return [...ids];
  }
  // Whose OBS a followObs follows with these bindings: the one candidate, else undefined.
  function followed(follow, binding) {
    const list = candidates(follow?.source ? [follow.source] : binding);
    return list.length === 1 ? list[0] : undefined;
  }

  function act(owner, canvas, value) {
    const why = { obsScene: value.scene, canvas, source: owner };
    const inShows = new Set();
    for (const show of shows.list()) {
      for (const id of show.overlays || []) inShows.add(id);
      const f = show.followObs;
      if (!f?.enabled || f.canvas !== canvas || followed(f, bindingOfShow(show.overlays)) !== owner) continue;
      const scene = mappedScene(f, value);
      if (!scene || scene === show.scene) continue;
      try {
        shows.take(show.id, scene, { actor: 'obs', obs: why });
        record('obs.follow', { actor: 'obs', target: show.id, show: show.name, scene, ...why });
      } catch (err) {
        log.warn('OBS changed scene, but the show could not follow', { show: show.id, scene, ...why, err: err.message });
      }
    }
    for (const doc of overlays.list()) {
      const f = doc.data.followObs;
      if (!f?.enabled || f.canvas !== canvas || inShows.has(doc.id) || followed(f, bindingOf(doc)) !== owner) continue;
      const scene = mappedScene(f, value);
      if (!scene || scene === store.get('overlay_scenes', doc.id)?.data.scene) continue;
      try {
        shows.takeOverlay(doc.id, scene, { actor: 'obs', obs: why });
        record('obs.follow', { actor: 'obs', target: doc.data.slug, scene, ...why });
      } catch (err) {
        log.warn('OBS changed scene, but the overlay could not follow', { overlay: doc.data.slug, scene, ...why, err: err.message });
      }
    }
  }

  function check(canvas) {
    for (const { owner, value } of bus.entriesOf(`obs.scene.${canvas}`)) {
      const id = identity(value);
      if (!owner || !id) continue;
      const k = `${owner}\n${canvas}`;
      const was = last.get(k);
      if (was === id) continue;
      last.set(k, id);
      note(owner, canvas, value);
      if (was !== undefined && !passive) act(owner, canvas, value);
    }
  }

  for (const canvas of CANVASES) check(canvas);
  const off = bus.onState((keys) => {
    for (const canvas of CANVASES) if (keys.includes(`obs.scene.${canvas}`)) check(canvas);
  });

  return {
    candidates,
    bindingOfShow,
    followed,
    // The OBS scenes a feed has shown since the platform started, newest first, per canvas.
    seen: (owner) => structuredClone(seen.get(owner) || { landscape: [], vertical: [] }),
    stop: off,
  };
}
