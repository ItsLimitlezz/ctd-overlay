// The timeline (09 §9.3–9.6): a show runs itself. Each show has cues, actions at absolute
// instants, and the server fires them on its own clock, with every browser closed, through a
// restart mid-show.
//
//   store collection "cues"        one record per cue (id cue_…): { showId, at (epoch ms), time?,
//                                  night?, label?, action, status, order, generated?, key?,
//                                  edited?, removed?, firedAt?, error?, prev?, stepsDone? }
//   store collection "show_plans"  a show's configuration saved for a future date (id plan_…)
//
// Scheduler rules (09 §9.4): it ticks every second and fires each armed cue whose time has come;
// a cue more than five minutes late is marked missed, never fired, so a wrong date or a restart
// after downtime can't replay a night's graphics at once; a cue is written as fired before its
// effect is published, so a crash can't fire it twice; the operator can fire now, skip or re-arm,
// and each of those goes to the audit log (07 §7.12). What fell due while the platform was down
// waits a few seconds after startup, so the overlays' pages are back to see it, and its lateness
// is judged as of startup.
//
// One rule above the others: nothing that happened fires again by itself. A cue set at a time of
// the show ("01:00") belongs to the show's night: it moves when the show's date, zone or day
// boundary changes; a new night arms it again only for a time still to come (a past one is
// missed), and going back to a night gives back what happened on it. A cue set at an instant (an
// ISO date-time) stays where it is.
//
// A recipe (09 §9.5) generates cues from the lineup: at each slot's start, that act is on and its
// title card shows (the headliner's own intro instead, where the template has one); the Event
// Intro some minutes in; now-playing every few minutes until the next slot. Generated cues are
// kept by a key (the slot's time and act, and what the cue does), so a lineup edit rebuilds them:
// a cue that still exists keeps its status; one whose time has passed is never made again by a
// rebuild (only a night's first build catches up the last five minutes); one that no longer
// exists goes if it was still to come and stays as history if it happened; one the operator
// edited stays theirs, and one they deleted stays deleted. Only what the members' templates offer
// is generated: an action, or a timed scene played as one, which plays only while the show is on
// its program (it would take the operator off a BRB otherwise; fired by hand, it plays anyway).
// What the templates offer is read when the show changes or is built: after changing a member's
// template, build again.
//
// A planned show (09 §9.6) is activated at the day boundary of its date, in the show's zone and
// with its boundary as they are then: its lineup and times become the show's, overlay settings it
// carries are applied to the show's members, and the timeline rebuilds. A plan never changes a
// show on air: it waits. Plans more than 14 days past are pruned, with the cues of past nights.
import { newId } from '../ids.js';
import { mediaUrl } from '../media/library.js';
import { jsonBytes, SAVED_BYTES, validateSettings } from '../templates/settings.js';
import { ShowError } from './registry.js';
import { isDate, isTime, resolveTime, showDay } from './time.js';

export const TICK_MS = 1000;
export const GRACE_MS = 5 * 60 * 1000;
export const RECONNECT_MS = 5000; // overlay pages retry every 0.7 s while the server is down
export const PLAN_KEEP_MS = 14 * 24 * 60 * 60 * 1000;
export const DEFAULT_RECIPE = Object.freeze({ titleCard: true, introOffsetMin: 5, nowPlayingEveryMin: 10, headliner: true });
export const MAX_CUES = 2000;
const MAX_STEPS = 20;
const LAST_SLOT_MS = 2 * 60 * 60 * 1000; // now-playing for the last act runs this long at most
const DAY_MS = 24 * 60 * 60 * 1000;
const PLAN_RETRY_MS = 5 * 60 * 1000; // a plan whose show is on air looks again this often
const PLAN_AHEAD_DAYS = 3 * 366;
const LATER = { 'connector.action': 'step 16, with connectors', webhook: 'step 20, with webhooks' };
const ACTION_ID = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;
const SCENE_ID = /^[a-z][a-z0-9-]{0,39}$/;
const MEDIA_ID = /^med_[0-9A-Z]{26}$/;
const CUE_ID = /^cue_[0-9A-Z]{26}$/;
const ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-](\d{2}):(\d{2}))$/;
const MAX_DELAY = 2 ** 31 - 1;

export function createTimeline({ store, shows, overlays, media, log, now = Date.now, timers = { setInterval, clearInterval, setTimeout, clearTimeout }, record = () => {} }) {
  const armed = new Map(); // cue id → { showId, at, order }: what the tick looks at
  const planTimers = new Map(); // plan id → timer
  const stepTimers = new Map(); // cue id → Set of timers for the later steps of its sequence
  let ticker = null;
  let lastPrune = 0;
  let startedAt = -Infinity;
  const heldAtStart = new Set(); // armed cues that fell due while the platform was down
  let resume = null; // the timer that goes on with sequences a stop cut short
  let stopped = false;

  function* list(collection) {
    for (let after = ''; ;) {
      const page = store.list(collection, { after, limit: 1000 });
      yield* page;
      if (page.length < 1000) break;
      after = page[page.length - 1].id;
    }
  }
  const cuesOf = (showId) => [...list('cues')].filter((c) => c.data.showId === showId);
  const bad = (msg) => { throw new ShowError(msg, 'invalid'); };
  const arm = (doc) => armed.set(doc.id, { showId: doc.data.showId, at: doc.data.at, order: doc.data.order || 0 });
  function stopSteps(id) {
    for (const h of stepTimers.get(id) || []) timers.clearTimeout(h);
    stepTimers.delete(id);
  }
  function drop(id) {
    store.delete('cues', id);
    armed.delete(id);
    stopSteps(id);
  }
  // Saves a cue and keeps the scheduler's view of it in step.
  function save(id, data) {
    const doc = store.put('cues', id, data);
    if (doc.data.status === 'armed' && !doc.data.removed) arm(doc);
    else armed.delete(id);
    return doc;
  }

  // ---- cues ----------------------------------------------------------------------------------
  // A cue as the API shows it (cue.schema.json): instants as ISO strings.
  function view(doc) {
    const d = doc.data;
    return {
      id: doc.id,
      rev: doc.rev,
      at: new Date(d.at).toISOString(),
      order: d.order || 0,
      ...(d.time ? { time: d.time } : {}),
      ...(d.clock ? { [d.clock === 'gap' ? 'clockGap' : 'clockOverlap']: true } : {}),
      ...(d.label ? { label: d.label } : {}),
      action: d.action,
      status: d.status,
      ...(d.generated ? { generated: true } : {}),
      ...(d.edited ? { edited: true } : {}),
      ...(d.firedAt ? { firedAt: new Date(d.firedAt).toISOString() } : {}),
      ...(d.error ? { error: d.error } : {}),
    };
  }

  function cleanAction(action, depth = 0) {
    if (!action || typeof action !== 'object' || Array.isArray(action)) bad('"action" must be an object with a "type".');
    const { type } = action;
    if (Object.hasOwn(LATER, type)) throw new ShowError(`"${type}" cues arrive in ${LATER[type]}.`, 'not-yet');
    switch (type) {
      case 'show.scene':
        if (typeof action.scene !== 'string' || !SCENE_ID.test(action.scene)) bad('a show.scene cue needs "scene", a scene id.');
        if (action.transition !== undefined && (typeof action.transition !== 'string' || !SCENE_ID.test(action.transition))) bad('"transition" must be a transition id (cut, fade, or one the template declares).');
        return { type, scene: action.scene, ...(action.transition ? { transition: action.transition } : {}) };
      case 'overlay.action': {
        if (typeof action.name !== 'string' || !ACTION_ID.test(action.name)) bad('an overlay.action cue needs "name", an action id.');
        const args = action.args ?? {};
        let size = Infinity;
        try { size = Buffer.byteLength(JSON.stringify(args)); } catch { /* too deep to measure: too large */ }
        if (!args || typeof args !== 'object' || Array.isArray(args) || size > 4096) bad('"args" must be an object of at most 4096 bytes.');
        return { type, name: action.name, ...(Object.keys(args).length ? { args } : {}) };
      }
      case 'show.slot':
        // A position, or an act's name (which follows the act through lineup edits).
        if (typeof action.slot === 'string' ? !action.slot.trim() || action.slot.length > 80 : !Number.isInteger(action.slot) || action.slot < 0) bad('a show.slot cue needs "slot": an act\'s name, or a lineup position.');
        return { type, slot: typeof action.slot === 'string' ? action.slot.trim() : action.slot };
      case 'media.play': {
        const doc = typeof action.mediaId === 'string' && MEDIA_ID.test(action.mediaId) ? media.get(action.mediaId) : undefined;
        if (!doc) bad('a media.play cue needs "mediaId", an uploaded file (skp media list).');
        return { type, mediaId: action.mediaId };
      }
      case 'media.stop':
        if (action.mediaId !== undefined && (typeof action.mediaId !== 'string' || !MEDIA_ID.test(action.mediaId))) bad('"mediaId" is a media id (med_…).');
        return { type, ...(action.mediaId ? { mediaId: action.mediaId } : {}) };
      case 'sequence': {
        if (depth > 0) bad('a sequence can\'t hold another sequence.');
        if (!Array.isArray(action.steps) || !action.steps.length || action.steps.length > MAX_STEPS) bad(`a sequence needs "steps": 1 to ${MAX_STEPS}.`);
        const steps = action.steps.map((s) => {
          if (!s || !Number.isInteger(s.offsetMs) || s.offsetMs < 0 || s.offsetMs > 60 * 60 * 1000) bad('each step needs "offsetMs", 0 to an hour.');
          return { offsetMs: s.offsetMs, action: cleanAction(s.action, depth + 1) };
        });
        return { type, steps: steps.sort((a, b) => a.offsetMs - b.offsetMs) };
      }
      default:
        return bad(`"action.type" must be one of show.scene, overlay.action, show.slot, media.play, media.stop or sequence (${Object.keys(LATER).join(' and ')} come later).`);
    }
  }

  function cleanLabel(label) {
    if (label === undefined || label === null || label === '') return undefined;
    if (typeof label !== 'string' || label.length > 120) bad('"label" is text, at most 120 characters.');
    return label.trim() || undefined;
  }

  // When a cue is: a time of the show ("01:00"), resolved like the lineup's (09 §9.2) and kept
  // with the night it is for, or an ISO date-time with its offset (a real one: no 30 February).
  function when(show, at) {
    if (typeof at === 'string' && isTime(at)) {
      const r = resolveTime(show.date, at, show);
      return { at: r.at, time: at, night: show.date, ...(r.gap ? { clock: 'gap' } : r.overlap ? { clock: 'overlap' } : {}) };
    }
    const m = typeof at === 'string' ? ISO.exec(at) : null;
    const t = m ? Date.parse(at) : NaN;
    const real = m && isDate(`${m[1]}-${m[2]}-${m[3]}`) && Number(m[4]) < 24 && Number(m[5]) < 60 && Number(m[6] ?? 0) < 60 && (!m[8] || (Number(m[8]) < 24 && Number(m[9]) < 60));
    if (!real || !Number.isFinite(t)) bad('"at" must be a time of the show (HH:MM) or an instant with its offset (2026-10-17T02:30:00Z).');
    return { at: t };
  }

  function add(showRef, input, { actor = 'operator' } = {}) {
    const show = shows.get(showRef);
    if (!input || typeof input !== 'object' || Array.isArray(input)) bad('A cue is an object: { at, action, label? }.');
    if (cuesOf(show.id).filter((c) => !c.data.removed).length >= MAX_CUES) throw new ShowError(`A show has at most ${MAX_CUES} cues.`, 'too-many', 409);
    const label = cleanLabel(input.label);
    const data = { showId: show.id, ...when(show, input.at), action: cleanAction(input.action), status: 'armed', order: 0, ...(label ? { label } : {}), actor };
    const doc = store.put('cues', newId('cue'), data, { ifRev: 0 });
    arm(doc);
    log.info('cue added', { show: show.id, cue: doc.id, at: new Date(data.at).toISOString(), action: data.action.type, actor });
    return view(doc);
  }

  function cueOf(showRef, cueId) {
    const show = shows.get(showRef);
    const doc = typeof cueId === 'string' && CUE_ID.test(cueId) ? store.get('cues', cueId) : undefined;
    if (!doc || doc.data.showId !== show.id || doc.data.removed) throw new ShowError(`The show has no cue "${cueId}".`, 'not-found', 404);
    return { show, doc };
  }

  // An edit by hand: a generated cue keeps its key (so a rebuild doesn't make it again) but the
  // recipe leaves it as the operator left it. An edit that changes nothing changes nothing.
  function update(showRef, cueId, patch) {
    const { show, doc } = cueOf(showRef, cueId);
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) bad('The change is an object: { at?, action?, label? }.');
    if (doc.data.status === 'fired') throw new ShowError('That cue has fired; re-arm it to change it.', 'fired', 409);
    const next = { ...doc.data };
    if (patch.at !== undefined) {
      const w = when(show, patch.at);
      delete next.time;
      delete next.clock;
      if (!next.generated) delete next.night; // a generated cue stays the night's it was made for
      next.at = w.at;
      if (w.time) Object.assign(next, { time: w.time, night: show.date, ...(w.clock ? { clock: w.clock } : {}) });
    }
    if (patch.action !== undefined) next.action = cleanAction(patch.action);
    if (patch.label !== undefined) {
      const label = cleanLabel(patch.label);
      if (label) next.label = label;
      else delete next.label;
    }
    const same = JSON.stringify(next) === JSON.stringify(doc.data);
    if (same) return view(doc);
    if (next.generated) next.edited = true;
    return view(save(doc.id, next));
  }

  // A generated cue the operator deletes stays deleted (kept as a hidden marker, so a rebuild
  // doesn't make it again); any other is removed.
  function remove(showRef, cueId) {
    const { doc } = cueOf(showRef, cueId);
    stopSteps(doc.id);
    if (doc.data.generated) save(doc.id, { ...doc.data, removed: true });
    else drop(doc.id);
    return { id: doc.id };
  }

  // Operator overrides (09 §9.4), always available, and recorded. Skipping a sequence that is
  // playing stops its remaining steps.
  function override(showRef, cueId, op, { actor = 'operator' } = {}) {
    const { show, doc } = cueOf(showRef, cueId);
    let result;
    if (op === 'fire') result = fire(doc, { manual: true, actor });
    else if (op === 'skip') {
      if (doc.data.status === 'fired' && stepTimers.has(doc.id)) {
        stopSteps(doc.id);
        result = view(save(doc.id, { ...doc.data, stepsDone: doc.data.action.steps.length, error: 'its remaining steps were skipped' }));
      } else if (doc.data.status !== 'armed') {
        throw new ShowError(`Only an armed cue can be skipped; this one is ${doc.data.status}.`, 'not-armed', 409);
      } else result = view(save(doc.id, { ...doc.data, status: 'skipped' }));
    } else if (op === 'rearm') {
      const next = { ...doc.data, status: 'armed' };
      for (const k of ['firedAt', 'error', 'stepsDone']) delete next[k];
      stopSteps(doc.id);
      result = view(save(doc.id, next));
    } else throw new ShowError('The override is fire, skip or rearm.', 'invalid');
    log.info(`cue ${op === 'fire' ? 'fired by hand' : op === 'skip' ? 'skipped' : 're-armed'}`, { show: show.id, cue: doc.id, actor });
    record(`cue.${op}`, { actor, target: doc.id, show: show.id, type: doc.data.action.type });
    return result;
  }

  // Fires a cue: written as fired first (durable before visible), then its effect.
  function fire(doc, { manual = false, actor = 'timeline' } = {}) {
    armed.delete(doc.id);
    stopSteps(doc.id);
    const data = { ...doc.data, status: 'fired', firedAt: now() };
    delete data.error;
    if (data.action.type === 'sequence') data.stepsDone = 0;
    else delete data.stepsDone;
    let saved = store.put('cues', doc.id, data);
    try {
      if (data.action.type === 'sequence') saved = runSteps(saved, { actor, manual });
      else apply(doc.data.showId, doc.data.action, { actor, manual });
      log.info('cue fired', { show: doc.data.showId, cue: doc.id, action: doc.data.action.type, manual, actor, lateMs: Math.max(0, now() - doc.data.at) });
    } catch (err) {
      saved = noteError(doc.id, err);
    }
    return view(saved);
  }

  function noteError(id, err, prefix = '') {
    const cur = store.get('cues', id);
    const error = `${prefix}${err instanceof ShowError ? err.message : `failed: ${err.message}`}`;
    if (err instanceof ShowError) log.warn('a cue fired but did nothing', { cue: id, err: error });
    else log.error('a cue\'s action failed', { cue: id, err });
    return cur ? store.put('cues', id, { ...cur.data, error: cur.data.error ? `${cur.data.error}; ${error}` : error }) : cur;
  }

  // A sequence's steps, each written as done before it is applied, so a restart in the middle
  // goes on from the next one (resume) and never repeats one; a step that fails doesn't stop the
  // others.
  function runSteps(doc, { actor, manual }) {
    const { steps } = doc.data.action;
    let cur = doc;
    for (let i = cur.data.stepsDone || 0; i < steps.length; i++) {
      const at = cur.data.firedAt + steps[i].offsetMs;
      if (at > now()) {
        schedule(cur.id, i, at, { actor, manual });
        continue;
      }
      if (now() - at > GRACE_MS) {
        cur = store.put('cues', cur.id, { ...cur.data, stepsDone: i + 1 });
        cur = noteError(cur.id, new ShowError('it was due while the platform was down', 'missed'), `step ${i + 1}: `);
        continue;
      }
      cur = store.put('cues', cur.id, { ...cur.data, stepsDone: i + 1 });
      try { apply(cur.data.showId, steps[i].action, { actor, manual }); } catch (err) { cur = noteError(cur.id, err, `step ${i + 1}: `); }
    }
    return cur;
  }

  function schedule(id, i, at, { actor, manual }) {
    const h = timers.setTimeout(() => {
      stepTimers.get(id)?.delete(h);
      if (stepTimers.get(id)?.size === 0) stepTimers.delete(id);
      if (stopped) return;
      const cur = store.get('cues', id);
      if (!cur || cur.data.removed || cur.data.status !== 'fired' || (cur.data.stepsDone || 0) !== i) return;
      const saved = store.put('cues', id, { ...cur.data, stepsDone: i + 1 });
      try { apply(saved.data.showId, saved.data.action.steps[i].action, { actor, manual }); } catch (err) { noteError(id, err, `step ${i + 1}: `); }
      // The next one, now this one is done (its own timer may already be set).
      const next = store.get('cues', id);
      if (next && i + 1 < next.data.action.steps.length && !stepTimers.has(id)) runSteps(next, { actor, manual });
    }, Math.max(0, at - now()));
    h?.unref?.();
    if (!stepTimers.has(id)) stepTimers.set(id, new Set());
    stepTimers.get(id).add(h);
  }

  function apply(showId, action, { actor, manual }) {
    switch (action.type) {
      case 'show.scene':
        shows.take(showId, action.scene, { transition: action.transition || 'fade', actor });
        return;
      case 'overlay.action': {
        // An action, or a timed scene played as one (the Event Intro, a headliner intro): that
        // takes the show's scene, so on its own it plays only from program.
        const offer = shows.offers(showId, action.name);
        if (!offer.action && offer.timed) {
          if (!offer.onProgram && !manual) throw new ShowError(`Not shown: the show was on "${offer.current}", and "${action.name}" plays from the program scene only.`, 'not-on-program');
          shows.take(showId, action.name, { transition: 'fade', actor });
        } else shows.trigger(showId, action.name, { args: action.args || {}, actor });
        return;
      }
      case 'show.slot':
        shows.setSlot(showId, action.slot);
        return;
      case 'media.play': {
        const doc = media.get(action.mediaId);
        if (!doc) throw new ShowError(`The clip ${action.mediaId} is no longer uploaded.`, 'no-media');
        if (doc.data.status !== 'ready') throw new ShowError(`The clip ${action.mediaId} isn't ready (${doc.data.status}).`, 'no-media');
        shows.media(showId, 'play', { mediaId: action.mediaId, url: mediaUrl(doc) });
        return;
      }
      case 'media.stop':
        shows.media(showId, 'stop', action.mediaId ? { mediaId: action.mediaId } : {});
        return;
      default:
        throw new ShowError(`a cue of type ${action.type} can't fire yet`, 'not-yet');
    }
  }

  // The scheduler: every armed cue whose time has come fires, in time order (at one instant, a
  // slot before its title card); one more than the grace window late is missed. What fell due
  // while the platform was down waits RECONNECT_MS after startup, judged late as of startup.
  function tick() {
    if (stopped) return;
    const t = now();
    const due = [...armed].filter(([, c]) => c.at <= t).sort(([ia, a], [ib, b]) => a.at - b.at || a.order - b.order || (ia < ib ? -1 : 1));
    for (const [id, c] of due) {
      const doc = store.get('cues', id);
      if (!doc || doc.data.status !== 'armed' || doc.data.removed) { armed.delete(id); continue; }
      if (doc.data.at !== c.at) { arm(doc); continue; } // moved meanwhile
      const whileDown = heldAtStart.has(id) && c.at < startedAt;
      const late = (whileDown ? startedAt : t) - c.at;
      if (late > GRACE_MS) {
        heldAtStart.delete(id);
        save(id, { ...doc.data, status: 'missed' });
        log.warn('a cue was more than five minutes late and was not fired', { show: c.showId, cue: id, at: new Date(c.at).toISOString() });
        continue;
      }
      if (whileDown && t < startedAt + RECONNECT_MS) continue; // the overlays' pages first
      heldAtStart.delete(id);
      fire(doc);
    }
  }

  // ---- the recipe (09 §9.5) -------------------------------------------------------------------
  function cleanRecipe(recipe) {
    if (recipe === null) return null;
    if (recipe !== undefined && (typeof recipe !== 'object' || Array.isArray(recipe))) bad('"recipe" is an object, or null to stop generating.');
    const r = { ...DEFAULT_RECIPE };
    for (const key of Object.keys(DEFAULT_RECIPE)) if (recipe?.[key] !== undefined) r[key] = recipe[key];
    if (typeof r.titleCard !== 'boolean' || typeof r.headliner !== 'boolean') bad('"titleCard" and "headliner" are true or false.');
    for (const key of ['introOffsetMin', 'nowPlayingEveryMin']) {
      if (r[key] !== null && (!Number.isInteger(r[key]) || r[key] < 1 || r[key] > 240)) bad(`"${key}" is whole minutes, 1 to 240, or null for none.`);
    }
    return r;
  }

  // The cues a recipe makes from the show's lineup, each with its key: the slot's time and act,
  // and what the cue does (now-playing by its minutes into the set, so another interval keeps
  // the ones it shares).
  function generated(show) {
    const r = show.recipe;
    if (!r) return [];
    const cache = new Map();
    const offered = (name) => {
      if (!cache.has(name)) {
        const o = shows.offers(show.id, name);
        cache.set(name, o.action || o.timed);
      }
      return cache.get(name);
    };
    const slots = show.lineup.map((s, index) => ({ ...s, index })).sort((a, b) => a.startAt - b.startAt || a.index - b.index);
    const out = [];
    const cue = (key, at, label, action, order) => out.push({ key, at, label, action, order });
    const seen = new Map();
    slots.forEach((s, i) => {
      const base = `${s.time}|${s.name}`;
      seen.set(base, (seen.get(base) || 0) + 1);
      const id = seen.get(base) > 1 ? `${base}#${seen.get(base)}` : base;
      const end = slots.slice(i + 1).find((x) => x.startAt > s.startAt)?.startAt ?? s.startAt + LAST_SLOT_MS;
      // Who's on, by name: it stays the same act if slots are added or removed above it.
      cue(`${id}:slot`, s.startAt, `${s.name} on`, { type: 'show.slot', slot: seen.get(base) > 1 ? s.index : s.name }, 0);
      if (r.headliner && s.headliner && offered('headliner')) cue(`${id}:headliner`, s.startAt, `${s.name}: headliner intro`, { type: 'overlay.action', name: 'headliner' }, 1);
      else if (r.titleCard && offered('titleCard')) cue(`${id}:title`, s.startAt, `${s.name}: title card`, { type: 'overlay.action', name: 'titleCard', args: { name: s.name } }, 1);
      if (r.introOffsetMin !== null && offered('intro')) {
        const at = s.startAt + r.introOffsetMin * 60000;
        if (at < end) cue(`${id}:intro`, at, `${s.name}: Event Intro`, { type: 'overlay.action', name: 'intro' }, 2);
      }
      if (r.nowPlayingEveryMin !== null && offered('nowPlaying')) {
        for (let k = 1; k <= 100; k++) {
          const min = k * r.nowPlayingEveryMin;
          if (s.startAt + min * 60000 >= end) break;
          cue(`${id}:np@${min}`, s.startAt + min * 60000, `${s.name}: now playing`, { type: 'overlay.action', name: 'nowPlaying', args: { name: s.name } }, 3);
        }
      }
    });
    return out.sort((a, b) => a.at - b.at || a.order - b.order);
  }

  // Brings a show's cues in line with it after a change (see the rules at the top).
  function follow(showId) {
    let show;
    try { show = shows.get(showId); } catch { return; }
    const t = now();
    // 1. Cues at a time of the show follow its date and zone.
    for (const doc of cuesOf(show.id).filter((c) => c.data.time && !c.data.removed)) {
      const d = doc.data;
      if (d.night !== show.date && d.generated) continue; // another night's: below
      const r = resolveTime(show.date, d.time, show);
      const next = { ...d, at: r.at };
      delete next.clock;
      if (r.gap || r.overlap) next.clock = r.gap ? 'gap' : 'overlap';
      if (d.night !== show.date) {
        // Another night: what happened on this one is kept; going back to a night gives back
        // what happened on it; otherwise a time still to come is armed, and a past one missed.
        const happened = d.status === 'armed' ? undefined : { night: d.night, status: d.status, ...(d.firedAt ? { firedAt: d.firedAt } : {}), ...(d.error ? { error: d.error } : {}) };
        for (const k of ['firedAt', 'error', 'stepsDone', 'prev']) delete next[k];
        if (d.prev?.night === show.date) Object.assign(next, { status: d.prev.status }, d.prev.firedAt ? { firedAt: d.prev.firedAt } : {}, d.prev.error ? { error: d.prev.error } : {});
        else next.status = r.at > t ? 'armed' : 'missed';
        if (happened) next.prev = happened;
        next.night = show.date;
      } else if (d.status === 'missed' && r.at > t && r.at !== d.at) next.status = 'armed'; // moved to come again
      if (JSON.stringify(next) !== JSON.stringify(d)) save(doc.id, next);
    }
    // 2. Generated cues: another night's still to come go (what happened stays, as history).
    const own = cuesOf(show.id).filter((c) => c.data.generated);
    for (const doc of own.filter((c) => c.data.night !== show.date && c.data.status === 'armed' && !c.data.removed)) drop(doc.id);
    if (!show.recipe) return; // nothing is generated; build(null) cleared what was to come
    const tonight = own.filter((c) => c.data.night === show.date && store.get('cues', c.id));
    const rebuilding = tonight.length > 0;
    const want = new Map(generated(show).map((c) => [c.key, c]));
    for (const stale of tonight) {
      const doc = store.get('cues', stale.id); // as step 1 left it
      const d = doc.data;
      const w = d.key ? want.get(d.key) : undefined;
      if (d.key) want.delete(d.key);
      if (d.removed) continue;
      if (!w) {
        if (d.edited) {
          // Its slot is gone, but the operator's edit stands: theirs now.
          const next = { ...d };
          for (const k of ['generated', 'key', 'edited']) delete next[k];
          save(doc.id, next);
        } else if (d.status === 'armed') drop(doc.id);
        else if (d.key) {
          // It happened: kept as history, and no longer matched.
          const next = { ...d };
          delete next.key;
          save(doc.id, next);
        }
        continue;
      }
      if (d.edited) continue;
      const moved = d.at !== w.at || d.order !== w.order || d.label !== w.label || JSON.stringify(d.action) !== JSON.stringify(w.action);
      if (d.status === 'armed' && moved) save(doc.id, { ...d, at: w.at, order: w.order, label: w.label, action: w.action });
      else if (d.status === 'missed' && w.at > t) save(doc.id, { ...d, at: w.at, order: w.order, label: w.label, action: w.action, status: 'armed' });
    }
    // 3. What is new: armed if still to come; a night's first build also catches up the last
    // GRACE_MS; a rebuild never makes a cue whose time has passed.
    let room = MAX_CUES - cuesOf(show.id).filter((c) => !c.data.removed).length;
    for (const w of want.values()) {
      if (!(w.at > t || (!rebuilding && t - w.at <= GRACE_MS))) continue;
      if (room-- <= 0) {
        log.warn('a show\'s recipe makes more cues than a show can hold; the latest were left out', { show: show.id, max: MAX_CUES });
        break;
      }
      arm(store.put('cues', newId('cue'), { showId: show.id, at: w.at, night: show.date, label: w.label, action: w.action, status: 'armed', order: w.order, generated: true, key: w.key, actor: 'recipe' }, { ifRev: 0 }));
    }
  }

  // POST /shows/{id}/cues/build: sets the show's recipe (the one it has, or the default, unless
  // given) and builds. null stops generating: the generated cues still to come go (except ones the
  // operator edited), and what happened stays, as history.
  function build(showRef, recipe) {
    const show = shows.get(showRef);
    const r = cleanRecipe(recipe === undefined ? show.recipe || undefined : recipe);
    shows.setRecipe(show.id, r); // the show's change listener rebuilds
    if (r === null) {
      for (const c of cuesOf(show.id).filter((x) => x.data.generated && !x.data.edited && (x.data.status === 'armed' || x.data.removed))) drop(c.id);
    }
    return listCues(show.id);
  }

  function listCues(showRef) {
    const show = shows.get(showRef);
    return cuesOf(show.id).filter((c) => !c.data.removed).sort((a, b) => a.data.at - b.data.at || (a.data.order || 0) - (b.data.order || 0) || (a.id < b.id ? -1 : 1)).map(view);
  }

  // ---- planned shows (09 §9.6) ---------------------------------------------------------------
  const PLAN_FIELDS = ['goLive', 'dayBoundary', 'lineup'];
  // When a plan's day starts and ends: in the show's zone and with its boundary as they are now
  // (the plan's own boundary if it carries one).
  function dayOf(plan, show) {
    return showDay(plan.date, { timezone: show.timezone, dayBoundary: plan.changes.dayBoundary || show.dayBoundary });
  }
  function planView(doc) {
    const d = doc.data;
    let activateAt = d.activateAt;
    try { activateAt = dayOf(d, shows.get(d.showId)).start; } catch { /* the show is gone */ }
    return {
      id: doc.id,
      rev: doc.rev,
      date: d.date,
      ...d.changes,
      ...(d.overlaySettings ? { overlaySettings: d.overlaySettings } : {}),
      activateAt: new Date(activateAt).toISOString(),
      ...(d.activatedAt ? { activatedAt: new Date(d.activatedAt).toISOString() } : {}),
      ...(d.error ? { error: d.error } : {}),
      ...(d.warnings?.length ? { warnings: d.warnings } : {}),
    };
  }

  function addPlan(showRef, input) {
    const show = shows.get(showRef);
    if (!input || typeof input !== 'object' || Array.isArray(input) || !isDate(input.date)) bad('A plan needs "date", YYYY-MM-DD.');
    const unknown = Object.keys(input).filter((k) => k !== 'date' && k !== 'overlaySettings' && !PLAN_FIELDS.includes(k));
    if (unknown.length) bad(`A plan carries ${PLAN_FIELDS.join(', ')} and overlaySettings; not ${unknown.join(', ')}.`);
    const picked = {};
    for (const k of PLAN_FIELDS) if (input[k] !== undefined) picked[k] = input[k];
    const changes = shows.validate(show.id, picked); // refused as the show would refuse it
    let overlaySettings;
    if (input.overlaySettings !== undefined) {
      if (!input.overlaySettings || typeof input.overlaySettings !== 'object' || Array.isArray(input.overlaySettings)) bad('"overlaySettings" maps overlay slugs to their settings.');
      for (const [slug, settings] of Object.entries(input.overlaySettings)) {
        if (!show.members.includes(slug)) bad(`"${slug}" isn't one of the show's overlays.`);
        const r = overlays.resolve(slug);
        const problems = !settings || typeof settings !== 'object' || Array.isArray(settings) ? [{ path: '', message: 'must be an object' }]
          : jsonBytes(settings) > SAVED_BYTES ? [{ path: '', message: `is over ${SAVED_BYTES / 1024} KiB` }]
            : r?.template ? validateSettings(r.template.manifest, settings) : [];
        if (problems.length) bad(`The settings for "${slug}" don't fit its template: ${problems.map((p) => `${p.path} ${p.message}`.trim()).join('; ')}.`);
      }
      overlaySettings = input.overlaySettings;
    }
    const plan = { showId: show.id, date: input.date, changes, ...(overlaySettings ? { overlaySettings } : {}) };
    const day = dayOf(plan, show);
    if (day.end <= now()) bad('That date is over; a plan is for a show still to come.');
    if (day.start - now() > PLAN_AHEAD_DAYS * DAY_MS) bad('A plan is for the next three years at most.');
    const clash = [...list('show_plans')].find((p) => p.data.showId === show.id && p.data.date === input.date && !p.data.activatedAt);
    if (clash) throw new ShowError(`The show already has a plan for ${input.date}; delete it first.`, 'plan-exists', 409);
    const doc = store.put('show_plans', newId('plan'), { ...plan, activateAt: day.start }, { ifRev: 0 });
    log.info('show planned', { show: show.id, plan: doc.id, date: input.date, activateAt: new Date(day.start).toISOString() });
    armPlan(doc);
    return planView(store.get('show_plans', doc.id) || doc);
  }

  function listPlans(showRef) {
    const show = shows.get(showRef);
    return [...list('show_plans')].filter((p) => p.data.showId === show.id).sort((a, b) => (a.data.date < b.data.date ? -1 : a.data.date > b.data.date ? 1 : 0)).map(planView);
  }

  function dropPlan(id) {
    store.delete('show_plans', id);
    timers.clearTimeout(planTimers.get(id));
    planTimers.delete(id);
  }

  function removePlan(showRef, planId) {
    const show = shows.get(showRef);
    const doc = typeof planId === 'string' && /^plan_[0-9A-Z]{26}$/.test(planId) ? store.get('show_plans', planId) : undefined;
    if (!doc || doc.data.showId !== show.id) throw new ShowError(`The show has no plan "${planId}".`, 'not-found', 404);
    dropPlan(doc.id);
    return { id: doc.id };
  }

  // The plan becomes the show: its date and changes, its members' settings, REC and who's on back
  // to before the show; the timeline rebuilds (the show notifies). Never while the show is live.
  function activate(planId) {
    planTimers.delete(planId);
    if (stopped) return;
    const doc = store.get('show_plans', planId);
    if (!doc || doc.data.activatedAt) return;
    const d = doc.data;
    let before;
    try { before = shows.get(d.showId); } catch { return; }
    if (before.live) {
      log.info('a planned show waits for the show to be off air', { show: d.showId, plan: planId });
      const h = timers.setTimeout(() => activate(planId), PLAN_RETRY_MS);
      h?.unref?.();
      planTimers.set(planId, h);
      return;
    }
    // Marked first: the show's change below notifies, and must not activate this plan again.
    const marked = store.put('show_plans', planId, { ...d, activatedAt: now() });
    const warnings = [];
    try {
      for (const [slug, settings] of Object.entries(d.overlaySettings || {})) {
        if (!before.members.includes(slug)) {
          warnings.push(`${slug}: no longer one of the show's overlays; its settings were left alone`);
          continue;
        }
        try { overlays.updateSettings(slug, settings); } catch (err) { warnings.push(`${slug}: ${err.message}`); }
      }
      if (before.recStartedAt !== undefined) shows.rec(d.showId, 'reset');
      if (before.currentSlot !== undefined) shows.setSlot(d.showId, null);
      shows.update(d.showId, { ...d.changes, date: d.date });
      if (warnings.length) store.put('show_plans', planId, { ...marked.data, warnings });
      log.info('planned show activated', { show: d.showId, plan: planId, date: d.date, warnings: warnings.length });
    } catch (err) {
      store.put('show_plans', planId, { ...marked.data, error: err.message, ...(warnings.length ? { warnings } : {}) });
      log.warn('a planned show was not activated', { show: d.showId, plan: planId, err: err.message });
    }
  }

  // Arms a plan for the start of its day as the show is now. If its day has begun (the platform
  // was down at the boundary): now, if the day isn't over, else it is marked as passed.
  function armPlan(doc) {
    timers.clearTimeout(planTimers.get(doc.id));
    planTimers.delete(doc.id);
    if (stopped || doc.data.activatedAt) return;
    let day;
    try { day = dayOf(doc.data, shows.get(doc.data.showId)); } catch { return; }
    if (day.start !== doc.data.activateAt) doc = store.put('show_plans', doc.id, { ...doc.data, activateAt: day.start });
    const wait = day.start - now();
    if (wait <= 0) {
      if (day.end > now()) activate(doc.id);
      else store.put('show_plans', doc.id, { ...doc.data, activatedAt: now(), error: 'its day passed while the platform was down' });
      return;
    }
    const h = wait > MAX_DELAY
      ? timers.setTimeout(() => { planTimers.delete(doc.id); const cur = store.get('show_plans', doc.id); if (cur) armPlan(cur); }, MAX_DELAY)
      : timers.setTimeout(() => activate(doc.id), wait);
    h?.unref?.();
    planTimers.set(doc.id, h);
  }

  // A show's plans, in date order; of those whose day has already begun, only the latest is the
  // show (the others are marked as passed by it).
  function armPlans(showId) {
    const mine = [...list('show_plans')].filter((p) => (!showId || p.data.showId === showId) && !p.data.activatedAt).sort((a, b) => (a.data.date < b.data.date ? -1 : 1));
    const begun = new Map(); // show id → its latest plan whose day has begun
    for (const p of mine) {
      let day;
      try { day = dayOf(p.data, shows.get(p.data.showId)); } catch { continue; }
      if (day.start <= now() && day.end > now()) begun.set(p.data.showId, p.id);
    }
    for (const p of mine) {
      const latest = begun.get(p.data.showId);
      if (latest && p.id !== latest && p.data.date < store.get('show_plans', latest).data.date) {
        timers.clearTimeout(planTimers.get(p.id));
        planTimers.delete(p.id);
        store.put('show_plans', p.id, { ...p.data, activatedAt: now(), error: `the plan for ${store.get('show_plans', latest).data.date} came after it while the platform was down` });
        continue;
      }
      armPlan(store.get('show_plans', p.id));
    }
  }

  // Plans past their keep, and generated cues and history of nights more than PLAN_KEEP_MS ago.
  function prune() {
    lastPrune = now();
    for (const p of [...list('show_plans')]) if (p.data.activateAt + PLAN_KEEP_MS < now()) dropPlan(p.id);
    for (const c of [...list('cues')]) {
      if (c.data.status !== 'armed' && c.data.at + PLAN_KEEP_MS < now() && (c.data.generated || c.data.removed)) drop(c.id);
    }
  }

  // ---- startup -------------------------------------------------------------------------------
  for (const c of list('cues')) if (c.data.status === 'armed' && !c.data.removed) arm(c);
  const unlisten = shows.onChanged((showId, { removed } = {}) => {
    if (removed) {
      for (const c of cuesOf(showId)) drop(c.id);
      for (const p of [...list('show_plans')].filter((x) => x.data.showId === showId)) dropPlan(p.id);
      return;
    }
    follow(showId);
    if (!stopped && ticker) armPlans(showId); // its zone or boundary may have moved its plans
  });

  return {
    list: listCues,
    get: (showRef, cueId) => view(cueOf(showRef, cueId).doc),
    add,
    update,
    remove,
    override,
    build,
    plans: { list: listPlans, add: addPlan, remove: removePlan },
    tick,
    // Ticks every second (09 §9.4), from now. Sequences cut short by a stop go on once the
    // overlays' pages are back, plans are armed, and old plans and nights' cues are pruned hourly.
    start() {
      if (stopped || ticker) return;
      startedAt = now();
      for (const [id, c] of armed) if (c.at < startedAt) heldAtStart.add(id);
      prune();
      armPlans();
      resume = timers.setTimeout(() => {
        resume = null;
        if (stopped) return;
        for (const c of list('cues')) {
          const d = c.data;
          if (d.status === 'fired' && d.action.type === 'sequence' && !d.removed && (d.stepsDone || 0) < d.action.steps.length && !stepTimers.has(c.id)) runSteps(c, { actor: 'timeline', manual: false });
        }
      }, RECONNECT_MS);
      resume?.unref?.();
      tick();
      ticker = timers.setInterval(() => {
        tick();
        if (now() - lastPrune >= 60 * 60 * 1000) prune();
      }, TICK_MS);
      ticker?.unref?.();
    },
    stop() {
      stopped = true;
      timers.clearInterval(ticker);
      ticker = null;
      timers.clearTimeout(resume);
      resume = null;
      for (const h of planTimers.values()) timers.clearTimeout(h);
      planTimers.clear();
      for (const id of [...stepTimers.keys()]) stopSteps(id);
      unlisten();
    },
  };
}
