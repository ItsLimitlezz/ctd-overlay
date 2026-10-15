// Shows (01 §1.3, 09 §9.1): overlays that share a scene, the operator's triggers, and the show
// state their templates read. A horizontal and a vertical feed are two members of one show, so a
// take changes both together, and a trigger lands on both on the same server-time frame.
//
//   store collection "shows"           one record per show (id show_…)
//   store collection "overlay_scenes"  the scene of each overlay outside a show (id = overlay id)
//
// What a show publishes to each member, as that overlay's own state (02 §2.5): show.scene,
// show.lineup (each slot with startAt, the instant its time resolves to, 09 §9.2), show.headliner,
// show.currentSlot, show.date, show.goLiveAt and show.recStartedAt. Two shows never share state.
//
// Everything is timed on the server: a scene with durationMs + then (04 §4.2) schedules its
// return as part of the take, kept in the record so a restart mid-intro still returns; a trigger
// carries startAt = now + TRIGGER_LEAD_MS so every member starts it on the same frame; REC is
// anchored when the show first goes live (taking its program scene, or "auto" reaching go-live)
// and cleared by taking its starting scene, as v0 did. A show is live while REC runs, for 12 hours
// at most (LIVE_MS, v0's rule: a show still "on air" after that was left so), which is what
// automatic template upgrades wait for (04 §4.13).
//
// A scene is named by its id or by its core (04 §4.2), so a take, a timed scene's "then" and a
// button work across templates: each member gets the name its own template knows.
import { newId } from '../ids.js';
import { ConflictError } from '../store/index.js';
import { isDate, isTime, isTimezone, resolveTime } from './time.js';

export const TRIGGER_LEAD_MS = 250;
export const LIVE_MS = 12 * 60 * 60 * 1000;
const NAME_CHARS = 80;
const SLOTS = 100;
const ARGS_BYTES = 4096;
const ARGS_DEPTH = 16;
const LOGO_CHARS = 500;
// What a show publishes goes to each member as a state.changed envelope of at most 64 KiB, value
// and previous value together (02 §2.9): a lineup larger than this is refused before it is saved.
export const LINEUP_BYTES = 24 * 1024;
const SCENE_ID = /^[a-z][a-z0-9-]{0,39}$/;
const TRANSITION = /^[a-z][a-z0-9-]{0,39}$/;
const OVERLAY_ID = /^ovl_[0-9A-Z]{26}$/;
const LOGO = /^(\/media\/[A-Za-z0-9_-]+\/[^/\\?#%\s]+|https:\/\/\S+)$/;
const SLOT_FIELDS = ['time', 'name', 'b2b', 'headliner', 'closer', 'logo'];
// What the show resource adds to each slot (09 §9.1–9.2): taken and ignored on a write, so a
// lineup read, edited and sent back whole goes through.
const SLOT_RESOLVED = ['startAt', 'clockGap', 'clockOverlap'];
const SHOW_KEYS = ['show.scene', 'show.lineup', 'show.headliner', 'show.currentSlot', 'show.date', 'show.goLiveAt', 'show.recStartedAt'];

// A template's scene by id, else by core (04 §4.2).
export function resolveScene(manifest, name) {
  if (typeof name !== 'string' || !name) return undefined;
  const scenes = manifest?.scenes || [];
  return scenes.find((s) => s.id === name) || scenes.find((s) => s.core === name);
}
const coreOf = (def) => def && (def.core || def.id);

// Whether args are within ARGS_BYTES and ARGS_DEPTH: stringifying very deep input would overflow
// the stack, so depth is checked first.
function argsFit(args) {
  const deep = (v, d) => d > ARGS_DEPTH || (v && typeof v === 'object' && Object.values(v).some((x) => deep(x, d + 1)));
  if (deep(args, 0)) return false;
  try { return Buffer.byteLength(JSON.stringify(args)) <= ARGS_BYTES; } catch { return false; }
}

export class ShowError extends Error {
  constructor(message, code, status = 422) {
    super(message);
    this.name = 'ShowError';
    this.code = code;
    this.status = status;
  }
}

// passive: a look at the shows that changes nothing (a dry run): no catching up at startup.
export function createShows({ store, bus, overlays, templates, log, now = Date.now, timers = { setTimeout, clearTimeout }, passive = false }) {
  const returns = new Map(); // show id or overlay id → timer for a timed scene's return
  const goLives = new Map(); // show id → timer for REC at go-live
  let stopped = false;

  function* all() {
    for (let after = ''; ;) {
      const page = store.list('shows', { after, limit: 1000 });
      yield* page;
      if (page.length < 1000) break;
      after = page[page.length - 1].id;
    }
  }

  // ---- reading -------------------------------------------------------------------------------
  function find(ref) {
    if (typeof ref !== 'string' || !ref) return undefined;
    if (/^show_[0-9A-Z]{26}$/.test(ref)) return store.get('shows', ref);
    const lower = ref.toLowerCase();
    return [...all()].find((d) => d.data.name.toLowerCase() === lower);
  }
  function get(ref) {
    const doc = find(ref);
    if (!doc) throw new ShowError(`There is no show "${ref}".`, 'not-found', 404);
    return doc;
  }
  const showOf = (overlayId) => [...all()].find((d) => d.data.overlays.includes(overlayId));
  const isLive = (data, t = now()) => typeof data.recStartedAt === 'number' && t - data.recStartedAt < LIVE_MS;

  // Members that still exist, with their template (a removed overlay is skipped).
  function members(data) {
    return data.overlays.map((id) => {
      const doc = store.get('overlays', id);
      if (!doc) return undefined;
      const r = overlays.resolve(doc.data.slug);
      return r && { id, slug: doc.data.slug, channel: r.channel, manifest: r.template?.manifest };
    }).filter(Boolean);
  }

  // A show's revision as an edit sees it (its ETag, H16): it moves when what PATCH changes does
  // (name, members, date, zone, day boundary, go-live, lineup), not with the night's live control
  // (a scene, who's on, REC), so an operator editing the lineup mid-show isn't refused at every
  // act change. stateRev moves with every change, for a client that follows the show.
  const editRev = (d) => d.editRev ?? 1;

  // The show as the API shows it: its record, its resolved times, and whether it is live.
  function view(doc) {
    const { editRev: _, ...d } = doc.data;
    return {
      id: doc.id,
      rev: editRev(doc.data),
      stateRev: doc.rev,
      ...d,
      live: isLive(d),
      goLiveAt: d.goLive ? resolveTime(d.date, d.goLive, d).at : undefined,
      lineup: lineupAt(d),
      members: members(d).map((m) => m.slug),
    };
  }

  // Lineup slots with startAt (09 §9.1), flagging a time a clock change moved or doubled (09 §9.2).
  function lineupAt(d) {
    return (d.lineup || []).map((s) => {
      const r = resolveTime(d.date, s.time, d);
      return { ...s, startAt: r.at, ...(r.gap ? { clockGap: true } : {}), ...(r.overlap ? { clockOverlap: true } : {}) };
    });
  }

  // ---- what members see --------------------------------------------------------------------
  function stateOf(d) {
    const lineup = lineupAt(d).map(({ clockGap, clockOverlap, ...s }) => s);
    const head = lineup.find((s) => s.headliner);
    return {
      'show.scene': d.scene,
      'show.lineup': lineup,
      'show.headliner': head ? head.name : undefined,
      'show.currentSlot': Number.isInteger(d.currentSlot) && d.currentSlot < lineup.length ? d.currentSlot : undefined,
      'show.date': d.date,
      'show.goLiveAt': d.goLive ? resolveTime(d.date, d.goLive, d).at : undefined,
      'show.recStartedAt': typeof d.recStartedAt === 'number' ? d.recStartedAt : undefined,
    };
  }

  function publish(doc) {
    const state = stateOf(doc.data);
    for (const m of members(doc.data)) {
      for (const [key, value] of Object.entries(state)) m.channel.setLocalState(key, value);
      overlays.refreshBound(m.id); // settings bound to show.headliner follow it (04 §4.3)
    }
  }

  // An overlay that leaves a show: its show state goes, and its own scene comes back, with its
  // return if that scene is a timed one (at once, if it fell due while the overlay was away).
  function release(overlayId) {
    const doc = store.get('overlays', overlayId);
    const r = doc && overlays.resolve(doc.data.slug);
    if (!r) return;
    for (const key of SHOW_KEYS) r.channel.setLocalState(key, undefined);
    const own = store.get('overlay_scenes', overlayId);
    if (own) r.channel.setLocalState('show.scene', own.data.scene);
    overlays.refreshBound(overlayId);
    if (own) armOverlay(overlayId, own.data);
  }

  // Refuses a show whose state couldn't reach its members (too large), before anything is saved.
  function checkPublishable(data) {
    const state = stateOf(data);
    for (const [key, value] of Object.entries(state)) {
      const bytes = value === undefined ? 0 : Buffer.byteLength(JSON.stringify(value));
      if (bytes > LINEUP_BYTES) {
        throw new ShowError(`The show's ${key.slice(5)} is too large to send to its overlays (${Math.ceil(bytes / 1024)} KiB; at most ${LINEUP_BYTES / 1024} KiB): use fewer slots, or shorter names and logo URLs.`, 'too-large');
      }
    }
  }

  // ---- validation --------------------------------------------------------------------------
  function clean(input, { partial = false, id } = {}) {
    const out = {};
    const bad = (msg) => { throw new ShowError(msg, 'invalid'); };
    if (!partial || input.name !== undefined) {
      if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > NAME_CHARS) bad(`"name" is required, at most ${NAME_CHARS} characters.`);
      out.name = input.name.trim();
      const same = [...all()].find((d) => d.id !== id && d.data.name.toLowerCase() === out.name.toLowerCase());
      if (same) throw new ShowError(`There is already a show called "${same.data.name}".`, 'name-taken', 409);
    }
    if (!partial || input.overlays !== undefined) {
      if (!Array.isArray(input.overlays) || input.overlays.length > 20) bad('"overlays" must be a list of at most 20 overlays (slugs or ids).');
      const ids = [];
      const held = (id && store.get('shows', id)?.data.overlays) || [];
      for (const ref of input.overlays) {
        const r = typeof ref === 'string' ? overlays.resolve(ref) || (OVERLAY_ID.test(ref) ? overlays.resolve(store.get('overlays', ref)?.data.slug) : undefined) : undefined;
        // One of this show's overlays deleted since, in a list read and sent back: it is left out.
        if (!r && held.includes(ref)) continue;
        if (!r) throw new ShowError(`There is no overlay "${ref}".`, 'no-overlay', 422);
        if (ids.includes(r.doc.id)) continue;
        const other = showOf(r.doc.id);
        if (other && other.id !== id) throw new ShowError(`"${r.doc.data.slug}" is already in the show "${other.data.name}"; an overlay belongs to one show at most (01 §1.3).`, 'in-other-show', 409);
        ids.push(r.doc.id);
      }
      out.overlays = ids;
    }
    if (!partial || input.date !== undefined) {
      if (!isDate(input.date)) bad('"date" must be a date, YYYY-MM-DD.');
      out.date = input.date;
    }
    if (!partial || input.timezone !== undefined) {
      if (!isTimezone(input.timezone)) bad('"timezone" must be an IANA time zone name, such as America/Toronto.');
      out.timezone = new Intl.DateTimeFormat('en-US', { timeZone: input.timezone }).resolvedOptions().timeZone;
    }
    for (const key of ['dayBoundary', 'goLive']) {
      if (input[key] === undefined) continue;
      if (input[key] === null && key === 'goLive') { out.goLive = null; continue; }
      if (!isTime(input[key])) bad(`"${key}" must be a time, HH:MM.`);
      out[key] = input[key];
    }
    if (!partial && out.dayBoundary === undefined) out.dayBoundary = '12:00';
    if (input.lineup !== undefined) out.lineup = cleanLineup(input.lineup, bad);
    else if (!partial) out.lineup = [];
    return out;
  }

  function cleanLineup(lineup, bad) {
    if (!Array.isArray(lineup) || lineup.length > SLOTS) bad(`"lineup" must be a list of at most ${SLOTS} slots.`);
    const str = (v, what, max) => {
      if (v === undefined) return undefined;
      if (typeof v !== 'string' || v.length > max) bad(`a slot's "${what}" must be text, at most ${max} characters.`);
      return v.trim() || undefined;
    };
    return lineup.map((s, i) => {
      if (!s || typeof s !== 'object' || Array.isArray(s)) bad(`slot ${i + 1} must be an object.`);
      // What a slot is, and nothing else (07 §7.11: unknown fields are refused, not dropped).
      const unknown = Object.keys(s).filter((k) => !SLOT_FIELDS.includes(k) && !SLOT_RESOLVED.includes(k));
      if (unknown.length) throw new ShowError(`slot ${i + 1}: unknown field${unknown.length > 1 ? 's' : ''} ${unknown.join(', ')}; a slot has ${SLOT_FIELDS.join(', ')}.`, 'unknown-field');
      if (!isTime(s.time)) bad(`slot ${i + 1}: "time" must be HH:MM.`);
      const name = str(s.name, 'name', 80);
      if (!name) bad(`slot ${i + 1}: "name" is required.`);
      const slot = { time: s.time, name };
      const b2b = str(s.b2b, 'b2b', 80);
      if (b2b) slot.b2b = b2b;
      if (s.headliner === true) slot.headliner = true;
      if (s.closer === true) slot.closer = true;
      if (s.logo !== undefined && s.logo !== null && s.logo !== '') {
        if (typeof s.logo !== 'string' || s.logo.length > LOGO_CHARS || !LOGO.test(s.logo)) bad(`slot ${i + 1}: "logo" must be uploaded media (/media/…) or an https URL, at most ${LOGO_CHARS} characters.`);
        slot.logo = s.logo;
      }
      return slot;
    });
  }

  // ---- changes -----------------------------------------------------------------------------
  // Listeners for a show's changes (its lineup, date, members, recipe): the timeline rebuilds
  // its generated cues and plans re-arm. fn(showId, { removed }).
  const listeners = new Set();
  function notify(id, info = {}) {
    for (const fn of listeners) {
      try { fn(id, info); } catch (err) { log.error('a show change listener failed', { show: id, err }); }
    }
  }

  function create(input, { actor = 'operator' } = {}) {
    const data = clean(input || {});
    checkPublishable(data);
    const doc = store.put('shows', newId('show'), { ...data, scene: undefined, actor, createdAt: new Date(now()).toISOString(), editRev: 1 }, { ifRev: 0 });
    publish(doc);
    arm(doc);
    log.info('show created', { show: doc.id, name: data.name, overlays: data.overlays.length });
    notify(doc.id);
    return view(doc);
  }

  // ifRev: the edit revision the change was made on (If-Match); a stale one is a conflict.
  function update(ref, patch, { ifRev } = {}) {
    const doc = get(ref);
    if (ifRev !== undefined && ifRev !== editRev(doc.data)) throw new ConflictError('shows', doc.id, editRev(doc.data), ifRev);
    const data = clean(patch || {}, { partial: true, id: doc.id });
    const next = { ...doc.data, ...data, editRev: editRev(doc.data) + 1 };
    if (next.goLive === null) delete next.goLive;
    // Who's on follows the act through a lineup edit (an act added above it moves its position),
    // and is cleared if the act is gone.
    if (data.lineup && Number.isInteger(doc.data.currentSlot)) {
      const was = doc.data.lineup[doc.data.currentSlot];
      let at = was ? next.lineup.findIndex((s) => s.time === was.time && s.name === was.name) : -1;
      if (at < 0 && was) at = next.lineup.findIndex((s) => s.name === was.name);
      if (at < 0) delete next.currentSlot;
      else next.currentSlot = at;
    }
    if (Number.isInteger(next.currentSlot) && next.currentSlot >= next.lineup.length) delete next.currentSlot;
    checkPublishable(next);
    const saved = store.put('shows', doc.id, next, { ifRev: doc.rev });
    for (const left of doc.data.overlays.filter((o) => !next.overlays.includes(o))) release(left);
    publish(saved);
    // A go-live moved into the past while "auto" is on air counts from then.
    arm(saved, { catchUp: ['goLive', 'date', 'timezone', 'dayBoundary'].some((k) => data[k] !== undefined) });
    notify(doc.id);
    return view(store.get('shows', doc.id) || saved);
  }

  // Checks a new show without making it: throws as create() would for its fields (an import that
  // replaces a show checks the new one before the old one goes). Its overlays are the caller's to
  // check; replacing: the show it will replace, whose name doesn't count as taken.
  function check(input, { replacing } = {}) {
    const data = clean({ ...(input || {}), overlays: [] }, { id: replacing });
    checkPublishable(data);
    return data;
  }

  // Checks a change without making it (a planned show's, 09 §9.6): throws as update() would, and
  // returns the change as update() would store it.
  function validate(ref, patch) {
    const doc = get(ref);
    return clean(patch || {}, { partial: true, id: doc.id });
  }

  function remove(ref) {
    const doc = get(ref);
    store.delete('shows', doc.id);
    disarm(doc.id);
    for (const o of doc.data.overlays) release(o);
    notify(doc.id, { removed: true });
    return { id: doc.id, name: doc.data.name };
  }

  // The recipe the timeline generates cues from (09 §9.5), validated by the timeline; null clears.
  function setRecipe(ref, recipe) {
    const doc = get(ref);
    const next = { ...doc.data };
    if (recipe) next.recipe = recipe;
    else delete next.recipe;
    const saved = store.put('shows', doc.id, next);
    notify(doc.id);
    return view(saved);
  }

  // What the members' templates offer under a name: an action, a scene (a timed one is played
  // like an action, 09 §9.5), or neither; and whether the show is on its program now (no scene
  // taken yet, or one whose core is program or auto), which a timed scene played by a cue needs.
  function offers(ref, name) {
    const doc = get(ref);
    const list = members(doc.data);
    const action = list.some((m) => m.manifest?.actions?.some((a) => a.id === name));
    const scene = sceneDef(list, name);
    const core = coreOf(sceneDef(list, doc.data.scene));
    return {
      action,
      scene: !!scene,
      timed: !!(scene && scene.durationMs && scene.then),
      onProgram: doc.data.scene === undefined || core === 'program' || core === 'auto',
      current: doc.data.scene,
    };
  }

  // The operator's clip on every member (02 §2.6).
  function media(ref, kind, data) {
    const doc = get(ref);
    const list = members(doc.data);
    for (const m of list) bus.publish(kind === 'play' ? 'media.play' : 'media.stop', data, { target: m.id });
    log.info(kind === 'play' ? 'clip played' : 'clip stopped', { show: doc.id, ...data });
    return { overlays: list.map((m) => m.slug) };
  }

  // A scene's definition in the members' templates (by id, else by core): the first that has it.
  function sceneDef(list, scene) {
    for (const m of list) {
      const def = resolveScene(m.manifest, scene);
      if (def) return def;
    }
    return undefined;
  }

  // The name each member knows a scene by: its own id for it, else the scene's core (which the
  // SDK resolves to the member's own scene, 04 §4.2), else the name as taken.
  function nameFor(m, scene, def) {
    if (resolveScene(m.manifest, scene)) return scene;
    const core = def?.core;
    return core && resolveScene(m.manifest, core) ? core : scene;
  }

  // Takes a scene on every member (or one standalone overlay): the take event with its
  // transition, then the scene state (02 §2.6), and, for a timed scene, its return.
  function takeOn(targets, scene, transition, prev, def) {
    for (const m of targets) {
      const name = nameFor(m, scene, def);
      const before = prev === undefined ? undefined : nameFor(m, prev, sceneDef(targets, prev));
      bus.publish('show.scene.changed', { scene: name, ...(before ? { prev: before } : {}), transition }, { target: m.id });
      m.channel.setLocalState('show.scene', name);
    }
  }

  function checkScene(list, scene, transition) {
    if (!list.length) throw new ShowError('The show has no overlays to take a scene on; add some first.', 'no-members');
    if (typeof scene !== 'string' || !SCENE_ID.test(scene)) throw new ShowError('"scene" must be a scene id.', 'invalid');
    if (typeof transition !== 'string' || !TRANSITION.test(transition)) throw new ShowError('"transition" must be a transition id (cut, fade, or one the template declares).', 'invalid');
    const def = sceneDef(list, scene);
    if (!def) throw new ShowError(`No member's template has a scene "${scene}".`, 'unknown-scene');
    return def;
  }

  function take(ref, scene, { transition = 'fade', actor = 'operator', returning = false } = {}) {
    const doc = get(ref);
    const list = members(doc.data);
    const def = checkScene(list, scene, transition);
    const t = now();
    const core = coreOf(def);
    const next = { ...doc.data, scene, sceneTakenAt: t };
    delete next.sceneReturn;
    if (def.durationMs && def.then) next.sceneReturn = { at: t + def.durationMs, then: def.then, from: scene };
    // REC (v0's rule): on air from the first program take; back to before the show on starting;
    // under "auto", from go-live once it has come (and not more than LIVE_MS ago).
    let recChanged = false;
    if (core === 'program' && !isLive(next, t)) { next.recStartedAt = t; recChanged = true; }
    if (core === 'starting' && next.recStartedAt !== undefined) { delete next.recStartedAt; recChanged = true; }
    if (core === 'auto') {
      const at = goLiveOf(next);
      if (dueGoLive(next, at, t)) { next.recStartedAt = at; recChanged = true; }
    }
    const saved = store.put('shows', doc.id, next);
    takeOn(list, scene, transition, doc.data.scene, def);
    if (recChanged) for (const m of list) m.channel.setLocalState('show.recStartedAt', saved.data.recStartedAt);
    arm(saved);
    log.info(returning ? 'timed scene returned' : 'scene taken', { show: doc.id, scene, transition, actor });
    return view(saved);
  }

  // One-shot trigger to every member whose template declares the action (04 §4.6).
  function trigger(ref, name, { args = {}, actor = 'operator' } = {}) {
    const doc = get(ref);
    return fire(members(doc.data), name, args, { show: doc.id, actor });
  }

  function fire(list, name, args, context) {
    if (typeof name !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(name)) throw new ShowError('The action must be an action id.', 'invalid');
    if (!args || typeof args !== 'object' || Array.isArray(args) || !argsFit(args)) {
      throw new ShowError(`"args" must be an object of at most ${ARGS_BYTES} bytes, nested at most ${ARGS_DEPTH} deep.`, 'invalid');
    }
    const takers = list.map((m) => ({ m, action: m.manifest?.actions?.find((a) => a.id === name) })).filter((x) => x.action);
    if (!takers.length) throw new ShowError(`No template here has an action "${name}".`, 'unknown-action');
    const startAt = now() + TRIGGER_LEAD_MS;
    for (const { m, action } of takers) {
      bus.publish('show.trigger', { name, args, startAt, durationMs: action.durationMs ?? 7000 }, { target: m.id });
    }
    log.info('triggered', { ...context, action: name, members: takers.length });
    return { action: name, startAt, overlays: takers.map((x) => x.m.slug) };
  }

  function setSlot(ref, slot) {
    const doc = get(ref);
    let index = slot;
    if (typeof slot === 'string') index = doc.data.lineup.findIndex((s) => s.name.toLowerCase() === slot.toLowerCase());
    if (slot !== null && (!Number.isInteger(index) || index < 0 || index >= doc.data.lineup.length)) {
      throw new ShowError(`"slot" must be a lineup position (0 to ${doc.data.lineup.length - 1}), an act's name, or null.`, 'invalid');
    }
    const next = { ...doc.data };
    if (slot === null) delete next.currentSlot;
    else next.currentSlot = index;
    const saved = store.put('shows', doc.id, next);
    for (const m of members(saved.data)) m.channel.setLocalState('show.currentSlot', saved.data.currentSlot);
    return view(saved);
  }

  function rec(ref, action) {
    const doc = get(ref);
    if (action !== 'start' && action !== 'reset') throw new ShowError('"action" must be "start" or "reset".', 'invalid');
    const next = { ...doc.data };
    if (action === 'start') next.recStartedAt = now();
    else delete next.recStartedAt;
    const saved = store.put('shows', doc.id, next);
    for (const m of members(saved.data)) m.channel.setLocalState('show.recStartedAt', saved.data.recStartedAt);
    arm(saved);
    return view(store.get('shows', doc.id) || saved);
  }

  // ---- overlays outside a show --------------------------------------------------------------
  function standalone(ref) {
    const r = (typeof ref === 'string' && overlays.resolve(ref)) || (typeof ref === 'string' && OVERLAY_ID.test(ref) ? overlays.resolve(store.get('overlays', ref)?.data.slug) : undefined);
    if (!r) throw new ShowError(`There is no overlay "${ref}".`, 'not-found', 404);
    return { id: r.doc.id, slug: r.doc.data.slug, channel: r.channel, manifest: r.template?.manifest };
  }

  function takeOverlay(ref, scene, { transition = 'fade', actor = 'operator', returning = false } = {}) {
    const m = standalone(ref);
    const show = showOf(m.id);
    if (show) throw new ShowError(`"${m.slug}" is in the show "${show.data.name}": take the scene on the show, so its members stay together.`, 'in-show', 409);
    const def = checkScene([m], scene, transition);
    const t = now();
    const prev = store.get('overlay_scenes', m.id)?.data.scene;
    const record = { scene, takenAt: t };
    if (def.durationMs && def.then) record.sceneReturn = { at: t + def.durationMs, then: def.then, from: scene };
    store.put('overlay_scenes', m.id, record);
    takeOn([m], scene, transition, prev, def);
    armOverlay(m.id, record);
    log.info(returning ? 'timed scene returned' : 'scene taken', { overlay: m.slug, scene, transition, actor });
    return { overlay: m.slug, scene };
  }

  function fireOverlay(ref, name, { args = {}, actor = 'operator' } = {}) {
    const m = standalone(ref);
    return fire([m], name, args, { overlay: m.slug, actor });
  }

  // ---- server-side timing ------------------------------------------------------------------
  function disarm(key) {
    timers.clearTimeout(returns.get(key));
    returns.delete(key);
    timers.clearTimeout(goLives.get(key));
    goLives.delete(key);
  }

  // A timed scene's return, and REC at go-live while "auto" is on air. catchUp: also anchor REC at
  // a go-live that has passed, at startup (the platform was down then) and when go-live itself
  // changes (moved into the past); never on a REC reset, which is the operator's.
  function arm(doc, { catchUp = false } = {}) {
    disarm(doc.id);
    if (stopped) return;
    const d = doc.data;
    if (d.sceneReturn) {
      const { at, then, from } = d.sceneReturn;
      const run = () => {
        returns.delete(doc.id);
        const cur = store.get('shows', doc.id);
        if (!cur || cur.data.scene !== from || !cur.data.sceneReturn) return; // taken away meanwhile
        try { take(doc.id, then, { transition: 'fade', actor: 'platform', returning: true }); } catch (err) { log.warn('a timed scene could not return', { show: doc.id, then, err: err.message }); }
      };
      // Already due (the platform was down when it was): now.
      if (at <= now()) run();
      else returns.set(doc.id, schedule(run, at - now(), () => rearmShow(doc.id)));
    }
    // REC at go-live while a scene whose core is "auto" is on air: by a timer when go-live is
    // still to come, at once when it has passed (the platform was down then, or go-live was moved
    // into the past) and the show isn't already live for it.
    const goLiveAt = goLiveOf(d);
    if (goLiveAt === undefined || coreOf(sceneDef(members(d), d.scene)) !== 'auto') return;
    if (goLiveAt <= now()) {
      if (catchUp && dueGoLive(d, goLiveAt, now())) goLive(doc.id, goLiveAt);
      return;
    }
    goLives.set(doc.id, schedule(() => {
      goLives.delete(doc.id);
      const cur = store.get('shows', doc.id);
      if (!cur || goLiveOf(cur.data) !== goLiveAt || coreOf(sceneDef(members(cur.data), cur.data.scene)) !== 'auto' || !dueGoLive(cur.data, goLiveAt, now())) return;
      goLive(doc.id, goLiveAt);
    }, goLiveAt - now(), () => rearmShow(doc.id)));
  }
  const goLiveOf = (d) => (d.goLive ? resolveTime(d.date, d.goLive, d).at : undefined);
  // Go-live counts while it is less than LIVE_MS ago, and REC doesn't already run for it (from
  // earlier this night, or started by hand since): REC from last week doesn't.
  const dueGoLive = (d, at, t) => at !== undefined && at <= t && t - at < LIVE_MS && !isLive(d, at);
  function goLive(id, at) {
    const cur = store.get('shows', id);
    const saved = store.put('shows', id, { ...cur.data, recStartedAt: at });
    for (const m of members(saved.data)) m.channel.setLocalState('show.recStartedAt', at);
    log.info('show live at go-live', { show: id, goLiveAt: new Date(at).toISOString() });
  }
  function rearmShow(id) {
    const cur = store.get('shows', id);
    if (cur) arm(cur);
  }

  function armOverlay(id, record) {
    timers.clearTimeout(returns.get(id));
    returns.delete(id);
    if (stopped || !record.sceneReturn) return;
    const { at, then, from } = record.sceneReturn;
    const run = () => {
      returns.delete(id);
      const cur = store.get('overlay_scenes', id);
      if (!cur || cur.data.scene !== from || showOf(id)) return;
      try { takeOverlay(id, then, { actor: 'platform', returning: true }); } catch (err) { log.warn('a timed scene could not return', { overlay: id, then, err: err.message }); }
    };
    if (at <= now()) run();
    else returns.set(id, schedule(run, at - now(), () => { const cur = store.get('overlay_scenes', id); if (cur) armOverlay(id, cur.data); }));
  }

  // setTimeout caps a delay at 2^31 - 1 ms (24.8 days); longer waits (a go-live weeks away) are
  // re-armed from the record when that much has passed.
  const MAX_DELAY = 2 ** 31 - 1;
  function schedule(fn, ms, rearm) {
    const handle = ms > MAX_DELAY ? timers.setTimeout(rearm, MAX_DELAY) : timers.setTimeout(fn, Math.max(0, ms));
    handle?.unref?.();
    return handle;
  }

  // At startup: every show's state to its members, standalone scenes back on their overlays, and
  // the timers armed (a return already due happens now). One show that can't be published never
  // keeps the platform (or a command line opening the data directory) from starting. A passive
  // look does none of it: catching up writes (REC at a go-live that passed, a return due).
  for (const doc of passive ? [] : all()) {
    try {
      publish(doc);
      arm(doc, { catchUp: true });
    } catch (err) {
      log.error('a show could not be restored at startup; fix or delete it', { show: doc.id, name: doc.data.name, err: err.message });
    }
  }
  for (const own of passive ? [] : store.list('overlay_scenes', { limit: 1000 })) {
    if (showOf(own.id)) continue;
    const doc = store.get('overlays', own.id);
    const r = doc && overlays.resolve(doc.data.slug);
    if (!r) continue;
    try {
      r.channel.setLocalState('show.scene', own.data.scene);
      armOverlay(own.id, own.data);
    } catch (err) {
      log.error('an overlay\'s scene could not be restored at startup', { overlay: own.id, err: err.message });
    }
  }

  return {
    list: () => [...all()].map(view),
    get: (ref) => view(get(ref)),
    create,
    update,
    remove,
    take,
    trigger,
    setSlot,
    rec,
    takeOverlay,
    fireOverlay,
    validate,
    check,
    setRecipe,
    offers,
    media,
    onChanged(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    // Whether the overlay is in a show that is live now: automatic template upgrades wait.
    onAir(overlayId) {
      const show = showOf(overlayId);
      return !!show && isLive(show.data);
    },
    stop() {
      stopped = true;
      for (const key of [...returns.keys(), ...goLives.keys()]) disarm(key);
    },
  };
}
