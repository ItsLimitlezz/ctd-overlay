// The timeline (09 §9.3–9.6): a show runs itself. Each show has cues, actions at absolute
// instants, and the server fires them on its own clock, with every browser closed, through a
// restart mid-show.
//
//   store collection "cues"        one record per cue (id cue_…): { showId, at (epoch ms), time?,
//                                  night?, label?, action, status, order, generated?, key?,
//                                  edited?, firedAt?, error? }
//   store collection "show_plans"  a show's configuration saved for a future date (id plan_…)
//
// Scheduler rules (09 §9.4): it ticks every second and fires each armed cue whose time has come;
// a cue more than five minutes late is marked missed, never fired, so a wrong date or a restart
// after downtime can't replay a night's graphics at once; a cue is written as fired before its
// effect is published, so a crash can't fire it twice; the operator can fire now, skip or re-arm,
// and each of those is recorded (operations.log until the audit log, step 11).
//
// A cue set at a time of the show ("01:00") belongs to the show's night: it moves when the show's
// date, zone or day boundary changes, and a new night (another date) arms it again. A cue set at
// an instant (an ISO date-time) stays where it is.
//
// A recipe (09 §9.5) generates cues from the lineup: at each slot's start, that slot is on and its
// title card shows (the headliner's own intro instead, where the template has one); the Event
// Intro some minutes in; now-playing every few minutes until the next slot. Generated cues are
// kept by a key (the slot and what they do), so a lineup edit rebuilds them without firing again
// what already happened; a cue the operator edited stays as they left it; another night starts
// afresh. Only what the members' templates offer is generated: an action, or a timed scene played
// as one, which plays only while the show is on its program (it would take the operator off a
// BRB otherwise; fired by hand, it plays anyway).
//
// A planned show (09 §9.6) is activated at the day boundary of its date: its lineup and times
// become the show's, overlay settings it carries are applied, and the timeline rebuilds. Plans
// more than 14 days past are pruned.
import { newId } from '../ids.js';
import { mediaUrl } from '../media/library.js';
import { jsonBytes, SAVED_BYTES, validateSettings } from '../templates/settings.js';
import { ShowError } from './registry.js';
import { isDate, isTime, resolveTime, showDay } from './time.js';

export const TICK_MS = 1000;
export const GRACE_MS = 5 * 60 * 1000;
export const PLAN_KEEP_MS = 14 * 24 * 60 * 60 * 1000;
export const DEFAULT_RECIPE = Object.freeze({ titleCard: true, introOffsetMin: 5, nowPlayingEveryMin: 10, headliner: true });
export const MAX_CUES = 2000;
const MAX_STEPS = 20;
const LAST_SLOT_MS = 2 * 60 * 60 * 1000; // now-playing for the last act runs this long at most
const DAY_MS = 24 * 60 * 60 * 1000;
const PLAN_RETRY_MS = 5 * 60 * 1000; // a plan whose show is on air looks again this often
const LATER = { 'connector.action': 'step 16, with connectors', webhook: 'step 20, with webhooks' };
const ACTION_ID = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;
const SCENE_ID = /^[a-z][a-z0-9-]{0,39}$/;
const MAX_DELAY = 2 ** 31 - 1;

export function createTimeline({ store, shows, overlays, media, log, now = Date.now, timers = { setInterval, clearInterval, setTimeout, clearTimeout }, record = () => {} }) {
  const armed = new Map(); // cue id → { showId, at, order }: what the tick looks at
  const planTimers = new Map(); // plan id → timer
  const stepTimers = new Set(); // the later steps of sequences in progress
  let ticker = null;
  let lastPrune = 0;
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
  const drop = (id) => { store.delete('cues', id); armed.delete(id); };

  // ---- cues ----------------------------------------------------------------------------------
  // A cue as the API shows it (cue.schema.json): instants as ISO strings.
  function view(doc) {
    const d = doc.data;
    return {
      id: doc.id,
      at: new Date(d.at).toISOString(),
      ...(d.time ? { time: d.time } : {}),
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
        if (!args || typeof args !== 'object' || Array.isArray(args) || Buffer.byteLength(JSON.stringify(args)) > 4096) bad('"args" must be an object of at most 4096 bytes.');
        return { type, name: action.name, ...(Object.keys(args).length ? { args } : {}) };
      }
      case 'show.slot':
        if (!Number.isInteger(action.slot) || action.slot < 0) bad('a show.slot cue needs "slot", a lineup position.');
        return { type, slot: action.slot };
      case 'media.play': {
        const doc = typeof action.mediaId === 'string' ? media.get(action.mediaId) : undefined;
        if (!doc) bad('a media.play cue needs "mediaId", an uploaded file (skp media list).');
        return { type, mediaId: action.mediaId };
      }
      case 'media.stop':
        if (action.mediaId !== undefined && typeof action.mediaId !== 'string') bad('"mediaId" is a media id.');
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
  // with the night it is for, or an ISO date-time.
  function when(show, at) {
    if (typeof at === 'string' && isTime(at)) return { at: resolveTime(show.date, at, show).at, time: at, night: show.date };
    const t = typeof at === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(at) ? Date.parse(at) : NaN;
    if (!Number.isFinite(t)) bad('"at" must be a time of the show (HH:MM) or an instant with its offset (2026-10-17T02:30:00Z).');
    return { at: t };
  }

  function add(showRef, input, { actor = 'operator' } = {}) {
    const show = shows.get(showRef);
    if (!input || typeof input !== 'object' || Array.isArray(input)) bad('A cue is an object: { at, action, label? }.');
    if (cuesOf(show.id).length >= MAX_CUES) throw new ShowError(`A show has at most ${MAX_CUES} cues.`, 'too-many', 409);
    const label = cleanLabel(input.label);
    const data = { showId: show.id, ...when(show, input.at), action: cleanAction(input.action), status: 'armed', order: 0, ...(label ? { label } : {}), actor };
    const doc = store.put('cues', newId('cue'), data, { ifRev: 0 });
    arm(doc);
    log.info('cue added', { show: show.id, cue: doc.id, at: new Date(data.at).toISOString(), action: data.action.type, actor });
    return view(doc);
  }

  function cueOf(showRef, cueId) {
    const show = shows.get(showRef);
    const doc = typeof cueId === 'string' && /^cue_[0-9A-Z]{26}$/.test(cueId) ? store.get('cues', cueId) : undefined;
    if (!doc || doc.data.showId !== show.id) throw new ShowError(`The show has no cue "${cueId}".`, 'not-found', 404);
    return { show, doc };
  }

  // An edit by hand: a generated cue keeps its key (so a rebuild doesn't make it again) but the
  // recipe leaves it as the operator left it.
  function update(showRef, cueId, patch) {
    const { show, doc } = cueOf(showRef, cueId);
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) bad('The change is an object: { at?, action?, label? }.');
    if (doc.data.status === 'fired') throw new ShowError('That cue has fired; re-arm it to change it.', 'fired', 409);
    const next = { ...doc.data };
    if (patch.at !== undefined) {
      const w = when(show, patch.at);
      delete next.time;
      if (!next.generated) delete next.night; // a generated cue stays the night's it was made for
      next.at = w.at;
      if (w.time) Object.assign(next, { time: w.time, night: show.date });
    }
    if (patch.action !== undefined) next.action = cleanAction(patch.action);
    if (patch.label !== undefined) {
      const label = cleanLabel(patch.label);
      if (label) next.label = label;
      else delete next.label;
    }
    if (next.generated) next.edited = true;
    const saved = store.put('cues', doc.id, next);
    if (saved.data.status === 'armed') arm(saved);
    return view(saved);
  }

  function remove(showRef, cueId) {
    const { doc } = cueOf(showRef, cueId);
    drop(doc.id);
    return { id: doc.id };
  }

  // Operator overrides (09 §9.4), always available, and recorded.
  function override(showRef, cueId, op, { actor = 'operator' } = {}) {
    const { show, doc } = cueOf(showRef, cueId);
    let result;
    if (op === 'fire') result = fire(doc, { manual: true, actor });
    else if (op === 'skip') {
      if (doc.data.status !== 'armed') throw new ShowError(`Only an armed cue can be skipped; this one is ${doc.data.status}.`, 'not-armed', 409);
      armed.delete(doc.id);
      result = view(store.put('cues', doc.id, { ...doc.data, status: 'skipped' }));
    } else if (op === 'rearm') {
      const next = { ...doc.data, status: 'armed' };
      delete next.firedAt;
      delete next.error;
      const saved = store.put('cues', doc.id, next);
      arm(saved);
      result = view(saved);
    } else throw new ShowError('The override is fire, skip or rearm.', 'invalid');
    log.info(`cue ${op === 'fire' ? 'fired by hand' : op === 'skip' ? 'skipped' : 're-armed'}`, { show: show.id, cue: doc.id, actor });
    record(`cue.${op}`, { show: show.id, cue: doc.id, action: doc.data.action.type, actor });
    return result;
  }

  // Fires a cue: written as fired first (durable before visible), then its effect.
  function fire(doc, { manual = false, actor = 'timeline' } = {}) {
    armed.delete(doc.id);
    const data = { ...doc.data, status: 'fired', firedAt: now() };
    delete data.error;
    let saved = store.put('cues', doc.id, data);
    try {
      apply(doc.data.showId, doc.data.action, { actor, manual });
      log.info('cue fired', { show: doc.data.showId, cue: doc.id, action: doc.data.action.type, manual, actor, lateMs: Math.max(0, now() - doc.data.at) });
    } catch (err) {
      const error = err instanceof ShowError ? err.message : `failed: ${err.message}`;
      saved = store.put('cues', doc.id, { ...saved.data, error });
      if (err instanceof ShowError) log.warn('a cue fired but did nothing', { show: doc.data.showId, cue: doc.id, err: error });
      else log.error('a cue\'s action failed', { show: doc.data.showId, cue: doc.id, err });
    }
    return view(saved);
  }

  function apply(showId, action, { actor, manual }) {
    switch (action.type) {
      case 'show.scene':
        shows.take(showId, action.scene, { transition: action.transition || 'fade', actor });
        return;
      case 'overlay.action': {
        // An action, or a timed scene played as one (the Event Intro, a headliner intro): that
        // takes the show's scene, so on its own it waits for no one but plays only on program.
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
      case 'sequence':
        // The steps after the first are timed from here; a restart in the middle of a sequence
        // drops what remains of it (the cue fired).
        for (const step of action.steps) {
          if (step.offsetMs === 0) {
            apply(showId, step.action, { actor, manual });
            continue;
          }
          const h = timers.setTimeout(() => {
            stepTimers.delete(h);
            if (stopped) return;
            try { apply(showId, step.action, { actor, manual }); } catch (err) { log.warn('a step of a sequence did nothing', { show: showId, step: step.action.type, err: err.message }); }
          }, step.offsetMs);
          h?.unref?.();
          stepTimers.add(h);
        }
        return;
      default:
        throw new ShowError(`a cue of type ${action.type} can't fire yet`, 'not-yet');
    }
  }

  // The scheduler: every armed cue whose time has come fires, in time order (at one instant, a
  // slot before its title card); one more than the grace window late is missed.
  function tick() {
    if (stopped) return;
    const t = now();
    const due = [...armed].filter(([, c]) => c.at <= t).sort(([ia, a], [ib, b]) => a.at - b.at || a.order - b.order || (ia < ib ? -1 : 1));
    for (const [id, c] of due) {
      const doc = store.get('cues', id);
      if (!doc || doc.data.status !== 'armed') { armed.delete(id); continue; }
      if (doc.data.at !== c.at) { arm(doc); continue; } // moved meanwhile
      if (t - c.at > GRACE_MS) {
        armed.delete(id);
        store.put('cues', id, { ...doc.data, status: 'missed' });
        log.warn('a cue was more than five minutes late and was not fired', { show: c.showId, cue: id, at: new Date(c.at).toISOString() });
        continue;
      }
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

  // The cues a recipe makes from the show's lineup, each with its key.
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
    // A slot is known by its time and act (not its position, which an inserted slot shifts); the
    // same act twice at one time is told apart by count.
    const seen = new Map();
    slots.forEach((s, i) => {
      const base = `${s.time}|${s.name}`;
      seen.set(base, (seen.get(base) || 0) + 1);
      const id = seen.get(base) > 1 ? `${base}#${seen.get(base)}` : base;
      const end = slots.slice(i + 1).find((x) => x.startAt > s.startAt)?.startAt ?? s.startAt + LAST_SLOT_MS;
      cue(`${id}:slot`, s.startAt, `${s.name} on`, { type: 'show.slot', slot: s.index }, 0);
      if (r.headliner && s.headliner && offered('headliner')) cue(`${id}:headliner`, s.startAt, `${s.name}: headliner intro`, { type: 'overlay.action', name: 'headliner' }, 1);
      else if (r.titleCard && offered('titleCard')) cue(`${id}:title`, s.startAt, `${s.name}: title card`, { type: 'overlay.action', name: 'titleCard', args: { name: s.name } }, 1);
      if (r.introOffsetMin !== null && offered('intro')) {
        const at = s.startAt + r.introOffsetMin * 60000;
        if (at < end) cue(`${id}:intro`, at, `${s.name}: Event Intro`, { type: 'overlay.action', name: 'intro' }, 2);
      }
      if (r.nowPlayingEveryMin !== null && offered('nowPlaying')) {
        const every = r.nowPlayingEveryMin * 60000;
        for (let k = 1; s.startAt + k * every < end && k <= 100; k++) {
          cue(`${id}:np:${k}`, s.startAt + k * every, `${s.name}: now playing`, { type: 'overlay.action', name: 'nowPlaying', args: { name: s.name } }, 3);
        }
      }
    });
    return out.sort((a, b) => a.at - b.at || a.order - b.order);
  }

  // Brings a show's cues in line with it after a change. Cues at a time of the show follow its
  // date and zone, and are armed again for a new night. Generated cues are rebuilt from the
  // lineup: one that still exists keeps its id and, once fired, skipped or missed, its status;
  // one the operator edited stays as they left it (or, if its slot is gone, stays as theirs);
  // one that no longer exists goes; another night's go, as the night starts afresh.
  function follow(showId) {
    let show;
    try { show = shows.get(showId); } catch { return; }
    const mine = cuesOf(show.id);
    for (const doc of mine.filter((c) => c.data.time)) {
      const at = resolveTime(show.date, doc.data.time, show).at;
      if (doc.data.night !== show.date) {
        if (doc.data.generated) continue; // another night's: goes below
        const next = { ...doc.data, at, night: show.date, status: 'armed' };
        delete next.firedAt;
        delete next.error;
        arm(store.put('cues', doc.id, next));
      } else if (doc.data.at !== at) {
        const saved = store.put('cues', doc.id, { ...doc.data, at });
        if (saved.data.status === 'armed') arm(saved);
      }
    }
    const own = mine.filter((c) => c.data.generated);
    for (const doc of own.filter((c) => c.data.night !== show.date)) drop(doc.id);
    // Without a recipe nothing is generated, and what was stays (build(null) clears what is to come).
    if (!show.recipe) return;
    const want = new Map(generated(show).map((c) => [c.key, c]));
    let made = 0;
    for (const doc of own.filter((c) => c.data.night === show.date)) {
      const w = want.get(doc.data.key);
      want.delete(doc.data.key);
      if (!w && doc.data.edited) {
        const next = { ...doc.data };
        for (const k of ['generated', 'key', 'edited', 'time', 'night']) delete next[k];
        store.put('cues', doc.id, next);
      } else if (!w) drop(doc.id);
      else if (!doc.data.edited && doc.data.status === 'armed' && (doc.data.at !== w.at || doc.data.order !== w.order || doc.data.label !== w.label || JSON.stringify(doc.data.action) !== JSON.stringify(w.action))) {
        arm(store.put('cues', doc.id, { ...doc.data, at: w.at, order: w.order, label: w.label, action: w.action }));
      }
    }
    const room = MAX_CUES - cuesOf(show.id).length;
    for (const w of want.values()) {
      if (made >= room) {
        log.warn('a show\'s recipe makes more cues than a show can hold; the latest were left out', { show: show.id, max: MAX_CUES });
        break;
      }
      // One already past the grace window (a recipe set mid-show) is missed from the start.
      const status = w.at + GRACE_MS < now() ? 'missed' : 'armed';
      const doc = store.put('cues', newId('cue'), { showId: show.id, at: w.at, night: show.date, label: w.label, action: w.action, status, order: w.order, generated: true, key: w.key, actor: 'recipe' }, { ifRev: 0 });
      if (status === 'armed') arm(doc);
      made++;
    }
  }

  // POST /shows/{id}/cues/build: sets the show's recipe (the one it has, or the default, unless
  // given) and builds. null stops generating: the generated cues still to come go, and what
  // happened stays, as history.
  function build(showRef, recipe) {
    const show = shows.get(showRef);
    const r = cleanRecipe(recipe === undefined ? show.recipe || undefined : recipe);
    shows.setRecipe(show.id, r); // the show's change listener rebuilds
    if (r === null) {
      for (const c of cuesOf(show.id).filter((x) => x.data.generated && !x.data.edited && x.data.status === 'armed')) drop(c.id);
    }
    return listCues(show.id);
  }

  function listCues(showRef) {
    const show = shows.get(showRef);
    return cuesOf(show.id).sort((a, b) => a.data.at - b.data.at || (a.data.order || 0) - (b.data.order || 0) || (a.id < b.id ? -1 : 1)).map(view);
  }

  // ---- planned shows (09 §9.6) ---------------------------------------------------------------
  const PLAN_FIELDS = ['goLive', 'dayBoundary', 'lineup'];
  function planView(doc) {
    const d = doc.data;
    return {
      id: doc.id,
      date: d.date,
      ...d.changes,
      ...(d.overlaySettings ? { overlaySettings: d.overlaySettings } : {}),
      activateAt: new Date(d.activateAt).toISOString(),
      ...(d.activatedAt ? { activatedAt: new Date(d.activatedAt).toISOString() } : {}),
      ...(d.error ? { error: d.error } : {}),
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
    const activateAt = showDay(input.date, { timezone: show.timezone, dayBoundary: changes.dayBoundary || show.dayBoundary }).start;
    if (activateAt + DAY_MS <= now()) bad('That date is over; a plan is for a show still to come.');
    const clash = [...list('show_plans')].find((p) => p.data.showId === show.id && p.data.date === input.date && !p.data.activatedAt);
    if (clash) throw new ShowError(`The show already has a plan for ${input.date}; delete it first.`, 'plan-exists', 409);
    const doc = store.put('show_plans', newId('plan'), { showId: show.id, date: input.date, changes, ...(overlaySettings ? { overlaySettings } : {}), activateAt }, { ifRev: 0 });
    log.info('show planned', { show: show.id, plan: doc.id, date: input.date, activateAt: new Date(activateAt).toISOString() });
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

  // The plan becomes the show: its date and changes, its overlays' settings, REC back to before
  // the show; the timeline rebuilds (the show notifies).
  function activate(planId) {
    planTimers.delete(planId);
    if (stopped) return;
    const doc = store.get('show_plans', planId);
    if (!doc || doc.data.activatedAt) return;
    const d = doc.data;
    let before;
    try { before = shows.get(d.showId); } catch { return; }
    // A plan never changes a show on air (last night's can run past the day boundary): it waits.
    if (before.live) {
      log.info('a planned show waits for the show to be off air', { show: d.showId, plan: planId });
      const h = timers.setTimeout(() => activate(planId), PLAN_RETRY_MS);
      h?.unref?.();
      planTimers.set(planId, h);
      return;
    }
    try {
      for (const [slug, settings] of Object.entries(d.overlaySettings || {})) {
        try { overlays.updateSettings(slug, settings); } catch (err) { log.warn('a planned show\'s overlay settings were not applied', { plan: planId, overlay: slug, err: err.message }); }
      }
      if (before.recStartedAt !== undefined) shows.rec(d.showId, 'reset');
      shows.update(d.showId, { ...d.changes, date: d.date });
      store.put('show_plans', planId, { ...d, activatedAt: now() });
      log.info('planned show activated', { show: d.showId, plan: planId, date: d.date });
    } catch (err) {
      store.put('show_plans', planId, { ...d, activatedAt: now(), error: err.message });
      log.warn('a planned show was not activated', { show: d.showId, plan: planId, err: err.message });
    }
  }

  function armPlan(doc) {
    timers.clearTimeout(planTimers.get(doc.id));
    planTimers.delete(doc.id);
    if (stopped || doc.data.activatedAt) return;
    const wait = doc.data.activateAt - now();
    // Its day has begun (the platform was down at the boundary): now, if the day isn't over.
    if (wait <= 0) {
      if (doc.data.activateAt + DAY_MS > now()) activate(doc.id);
      return;
    }
    const h = wait > MAX_DELAY
      ? timers.setTimeout(() => { planTimers.delete(doc.id); const cur = store.get('show_plans', doc.id); if (cur) armPlan(cur); }, MAX_DELAY)
      : timers.setTimeout(() => activate(doc.id), wait);
    h?.unref?.();
    planTimers.set(doc.id, h);
  }

  function prunePlans() {
    lastPrune = now();
    for (const p of [...list('show_plans')]) if (p.data.activateAt + PLAN_KEEP_MS < now()) dropPlan(p.id);
  }

  // ---- startup -------------------------------------------------------------------------------
  for (const c of list('cues')) if (c.data.status === 'armed') arm(c);
  const unlisten = shows.onChanged((showId, { removed } = {}) => {
    if (removed) {
      for (const c of cuesOf(showId)) drop(c.id);
      for (const p of [...list('show_plans')].filter((x) => x.data.showId === showId)) dropPlan(p.id);
      return;
    }
    follow(showId);
  });

  return {
    list: listCues,
    add,
    update,
    remove,
    override,
    build,
    plans: { list: listPlans, add: addPlan, remove: removePlan },
    tick,
    // Ticks every second (09 §9.4): the first one now, so what fell due while the platform was
    // down is handled (or missed) at once. Plans are armed, and old ones pruned hourly.
    start() {
      if (stopped || ticker) return;
      prunePlans();
      for (const p of list('show_plans')) armPlan(p);
      tick();
      ticker = timers.setInterval(() => {
        tick();
        if (now() - lastPrune >= 60 * 60 * 1000) prunePlans();
      }, TICK_MS);
      ticker?.unref?.();
    },
    stop() {
      stopped = true;
      timers.clearInterval(ticker);
      ticker = null;
      for (const h of planTimers.values()) timers.clearTimeout(h);
      planTimers.clear();
      for (const h of stepTimers) timers.clearTimeout(h);
      stepTimers.clear();
      unlisten();
    },
  };
}
