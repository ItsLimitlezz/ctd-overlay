// The v0 importer (PLAN step 15; 11 "Migrating from v0"): a D/PRTMNT Stream Kit data directory
// (v0's /data) becomes a show on this platform.
//
//   kit.json (else live.json's cfg)  a show (date, go-live, lineup with its headliner) and one
//                                    TAKEOVER overlay in it, with the settings v0 showed
//   live.json video                  The Line's clip, in the media library, as the overlay's clip
//   rundown.json                     the timeline: cues from the lineup by v0's own recipe, and
//                                    v0's hand-made cues still to come that night
//   shows.json                       planned dates (09 §9.6), from today on
//   viewers.json                     Twitch and Kick credentials, encrypted, kept for the
//                                    connections of steps 16-17 (store collection
//                                    "pending_connections", one record per platform)
//
// Three parts. readV0 reads the directory, tolerantly: a missing file, a broken one or a field of
// the wrong type is skipped with a warning, never a crash (H17). mapV0 turns what was read into
// what will be made, with no platform: a pure function, which is also what a dry run shows.
// applyV0 makes it in an open data directory (app.js openData), with one audit entry per thing it
// creates or changes. Nothing in v0's files is trusted as a path: the clip is looked up by its base
// name in <dir>/uploads, and nowhere else. Secrets go only into the store, encrypted: never into
// the summary, the audit log or the logs.
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { MediaError, mediaUrl } from '../media/library.js';
import { resolveScene, ShowError } from '../shows/registry.js';
import { isDate, resolveTime } from '../shows/time.js';
import { resolveSettings, validateSettings } from '../templates/settings.js';

export const TAKEOVER = 'com.dprtmnt.takeover';
export const PENDING_CONNECTIONS = 'pending_connections';
// v0's rule: a time before noon belongs to the next day (server.js cueEpoch; H7).
const DAY_BOUNDARY = '12:00';
const FILE_BYTES = 16 * 1024 * 1024;
const NAME_CHARS = 80;
const SLOTS = 100;
const MANUAL_CUES = 500; // v0's hand-made cues a show takes (with the recipe's, under its cue limit)
const LABEL_CHARS = 120;
const CREDENTIAL_CHARS = 200; // what v0 kept (server.js /api/viewers)
const HOUR = 60 * 60 * 1000;
const CLIP = Symbol('the imported clip');

// What v0's Stream Kit used for a field its setup didn't have (public/shared/kit.js DEFAULT), so a
// field missing from an old kit.json shows here as it showed there. Never its sample lineup.
const V0 = Object.freeze({
  golive: '23:00', venue: 'DPRTMNT · TORONTO', tagline: 'SATURDAYS · LIVE FROM TORONTO', doors: 'DOORS 10:30PM',
  presents: 'D/PRTMNT PRESENTS', scanlines: true, ticker: ['DPRTMNT TAKEOVER', 'EVERY SATURDAY', 'TORONTO', 'DOORS 10:30PM'],
  cardSec: 7, npSec: 22, clubIntroMin: 5, npIntervalMin: 10, baseUrl: '', tickerOn: false, viewersMode: '', viewersText: '', event: '',
});
const EV = Object.freeze({ star: 'a', scan: 1, chip: 1, lockup: 1, sched: 1, np: 1, vu: 1, poster: 1, stinger: 0, headliner: '', addr: '' });
// v0's event packs (public/shared/events.js) and its star treatments.
const PACKS = { vikstarr: { artist: 'VIKKSTAR' } };
const STARS = { a: 'rake', b: 'rise', c: 'ghost', d: 'stamp' };
const V0_SCENES = ['auto', 'starting', 'program', 'brb', 'lineup', 'outro', 'intro', 'line', 'pov', 'headliner'];

export class ImportError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ImportError';
    this.code = code;
  }
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
// A value from a v0 file, for a message: short, on one line. A value too deep to write out (a list
// nested thousands of times overflows the stack) is named by its kind.
const quote = (v) => {
  let s;
  try { s = typeof v === 'string' ? `"${v}"` : JSON.stringify(v) ?? String(v); } catch { s = kind(v); }
  return (s.length > 60 ? `${s.slice(0, 57)}…` : s).replace(/[\x00-\x1f\x7f]/g, ' ');
};
const kind = (v) => (Array.isArray(v) ? 'a list' : v === null ? 'null' : typeof v === 'object' ? 'an object' : typeof v);
// A v0 value as text when it is text, a number or true/false; anything else is '' (String() of a
// deeply nested list overflows the stack too).
const textOf = (v) => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '');
// An instant JavaScript can hold (a Date beyond ±8.64e15 ms is invalid).
const isInstant = (v) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 8.64e15;
// A long list's messages: the first `max`, then only counted (a huge file can't flood the summary).
function bounded(push, max) {
  let n = 0;
  const say = (m) => (n++ < max ? push(m) : undefined);
  say.rest = () => Math.max(0, n - max);
  return say;
}
// JSON equality that ignores key order.
const sorted = (v) => (Array.isArray(v) ? v.map(sorted) : isObject(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])])) : v);
const same = (a, b) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// v0 wrote times as H:MM or HH:MM, 24-hour.
function hhmm(v) {
  const m = typeof v === 'string' ? /^\s*(\d{1,2}):(\d{2})\s*$/.exec(v) : null;
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return undefined;
  return `${m[1].padStart(2, '0')}:${m[2]}`;
}
// Minutes after the day boundary: the order of a night's times.
const nightOrder = (t) => (Number(t.slice(0, 2)) * 60 + Number(t.slice(3)) + 720) % 1440;

// The calendar date in a zone at an instant.
export function dateIn(timezone, t) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
// v0's kit page started a new setup on the coming Saturday (today, if it is one).
function nextSaturday(today) {
  const [y, m, d] = today.split('-').map(Number);
  const day = new Date(Date.UTC(y, m - 1, d));
  return new Date(Date.UTC(y, m - 1, d + ((6 - day.getUTCDay() + 7) % 7))).toISOString().slice(0, 10);
}

// live.json's cfg: encodeURIComponent(base64(UTF-8 JSON)), as v0's kit page made it.
export function decodeCfg(text) {
  try {
    const value = JSON.parse(Buffer.from(decodeURIComponent(text), 'base64').toString('utf8'));
    return isObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

// An older setup carried its event as a query string (evParams: "event=vikstarr&star=b&…"); and
// v0's kit page cleaned a setup's content once (_cmig): a ticker item dropped, the doors time
// fixed, the viewer setting moved out of the event options. A setup that never had that is
// cleaned here, as v0 would have on its next load.
export function upgradeSetup(input) {
  const s = { ...input };
  if (s.event === undefined && typeof s.evParams === 'string') {
    const q = new URLSearchParams(s.evParams);
    s.event = q.get('event') || '';
    const opts = {};
    for (const [k, v] of q) if (k !== 'event') opts[k] = /^[01]$/.test(v) ? Number(v) : v;
    if (s.evOpts === undefined) s.evOpts = opts;
  }
  delete s.evParams;
  if (s._cmig) return s;
  s._cmig = true;
  if (Array.isArray(s.ticker)) s.ticker = s.ticker.filter((t) => t !== 'NO PHONES ON THE FLOOR').map((t) => (t === 'DOORS 10PM' ? 'DOORS 10:30PM' : t));
  if (s.doors === 'DOORS 10PM') s.doors = 'DOORS 10:30PM';
  if (isObject(s.evOpts)) {
    const ev = { ...s.evOpts };
    const legacy = ev.viewers;
    if (legacy && !s.viewersMode) {
      if (/^(live|auto|1)$/i.test(textOf(legacy))) s.viewersMode = 'live';
      else {
        s.viewersMode = 'manual';
        s.viewersText = textOf(legacy);
      }
    }
    delete ev.viewers;
    s.evOpts = ev;
  }
  return s;
}

// ---- reading ------------------------------------------------------------------------------------
// { dir, kit, live, rundown, shows, viewers (each parsed, or undefined), found (the files read),
// uploads (names), crashLog, clip ({ file, name, size, original }), warnings }.
export function readV0(dir) {
  const root = path.resolve(String(dir));
  let st;
  try { st = statSync(root); } catch { throw new ImportError(`There is no directory ${root}.`, 'not-found'); }
  if (!st.isDirectory()) throw new ImportError(`${root} isn't a directory: give v0's data directory (the one with kit.json and live.json).`, 'not-a-directory');
  const warnings = [];
  const found = [];
  const json = (name) => {
    const file = path.join(root, name);
    let s;
    try { s = lstatSync(file); } catch { return undefined; }
    if (!s.isFile()) {
      warnings.push(`${name} isn't a plain file; skipped.`);
      return undefined;
    }
    if (s.size > FILE_BYTES) {
      warnings.push(`${name} is over ${FILE_BYTES / 1024 / 1024} MiB, which no v0 file is; skipped.`);
      return undefined;
    }
    found.push(name);
    try {
      return JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
    } catch (err) {
      warnings.push(`${name} isn't JSON (${err.message}); skipped.`);
      return undefined;
    }
  };
  const read = { dir: root, kit: json('kit.json'), live: json('live.json'), rundown: json('rundown.json'), shows: json('shows.json'), viewers: json('viewers.json'), found, warnings };
  const uploads = path.join(root, 'uploads');
  // uploads/ itself must be a directory in v0's: a link (or a Windows junction) could make "a
  // file in uploads/" any file the importer can read.
  let inside = false;
  try {
    inside = lstatSync(uploads).isDirectory() && realpathSync(uploads) === path.join(realpathSync(root), 'uploads');
  } catch { /* none */ }
  if (!inside && existsSync(uploads)) warnings.push(`uploads/ in ${root} isn't a directory of its own (a link?); nothing in it is imported.`);
  try {
    // What v0 kept there; .in-* are uploads it never finished.
    read.uploads = inside ? readdirSync(uploads, { withFileTypes: true }).filter((e) => e.isFile() && !e.name.startsWith('.')).map((e) => e.name) : [];
  } catch {
    read.uploads = [];
  }
  try { read.crashLog = lstatSync(path.join(root, 'crash.log')).isFile(); } catch { read.crashLog = false; }

  // The Line's clip: live.json's video.url names it, but only its base name is used, inside
  // uploads/, and only a plain file there (a link could point anywhere).
  const video = isObject(read.live) ? read.live.video : undefined;
  if (video !== undefined && video !== null) {
    const url = isObject(video) && typeof video.url === 'string' ? video.url : '';
    const base = url.split(/[?#]/)[0].split(/[\\/]/).pop();
    if (!base || base.startsWith('.')) warnings.push(`live.json's clip ${url ? quote(url) : '(it has no URL)'} doesn't name a file in uploads/; The Line's clip isn't imported.`);
    else if (!inside && existsSync(uploads)) warnings.push(`The Line's clip ${quote(base)} would be in uploads/, which isn't a directory of its own; it isn't imported.`);
    else {
      let s;
      try { s = lstatSync(path.join(uploads, base)); } catch { /* not there */ }
      if (s?.isFile()) read.clip = { file: path.join(uploads, base), name: base, size: s.size, original: typeof video.name === 'string' && video.name.trim() ? video.name.trim().slice(0, 100) : base };
      else warnings.push(`The Line's clip ${quote(base)} isn't a file in ${uploads}; it isn't imported.`);
    }
  }
  return read;
}

// ---- mapping ------------------------------------------------------------------------------------
// A setup's fields as v0 used them: the type v0 wrote, else (with a warning) v0's default.
function fieldsOf(setup, where, warn) {
  const out = {};
  const bad = (key, value, want) => warn(`${where}: ${key} is ${kind(value)} (${quote(value)}), not ${want}; v0's default is used.`);
  for (const key of ['golive', 'venue', 'tagline', 'doors', 'presents', 'baseUrl', 'viewersMode', 'viewersText', 'event']) {
    const v = setup[key];
    if (v === undefined || v === null) out[key] = V0[key];
    else if (typeof v === 'string') out[key] = v;
    else {
      bad(key, v, 'text');
      out[key] = V0[key];
    }
  }
  for (const key of ['scanlines', 'tickerOn']) {
    const v = setup[key];
    if (v === undefined || v === null) out[key] = V0[key];
    else if (typeof v === 'boolean' || v === 0 || v === 1) out[key] = Boolean(v);
    else {
      bad(key, v, 'true or false');
      out[key] = V0[key];
    }
  }
  for (const key of ['cardSec', 'npSec', 'clubIntroMin', 'npIntervalMin']) {
    const v = setup[key];
    if (v === undefined || v === null || v === '') out[key] = V0[key];
    else if ((typeof v === 'number' || typeof v === 'string') && Number.isFinite(Number(v))) out[key] = Number(v);
    else {
      bad(key, v, 'a number');
      out[key] = V0[key];
    }
  }
  if (setup.ticker === undefined || setup.ticker === null) out.ticker = V0.ticker;
  else if (Array.isArray(setup.ticker)) out.ticker = setup.ticker;
  else {
    bad('ticker', setup.ticker, 'a list');
    out.ticker = V0.ticker;
  }
  if (setup.evOpts === undefined || setup.evOpts === null) out.evOpts = { ...EV };
  else if (isObject(setup.evOpts)) out.evOpts = { ...EV, ...setup.evOpts };
  else {
    bad('evOpts', setup.evOpts, 'an object');
    out.evOpts = { ...EV };
  }
  return out;
}

// v0 slots { name, time, b2b, closer } → this platform's { time, name, b2b, closer }, in v0's
// order. byRaw maps a v0 position (what its hand-made cues name) to the imported slot's.
function lineupOf(lineup, where, skip, warn) {
  const slots = [];
  const byRaw = new Map();
  if (lineup === undefined || lineup === null) return { slots, byRaw };
  if (!Array.isArray(lineup)) {
    warn(`${where}: the lineup is ${kind(lineup)}, not a list; no acts imported.`);
    return { slots, byRaw };
  }
  // Past the act limit, entries are only counted, and past 20 messages so are the problems: a huge
  // file can't flood the summary or take minutes.
  const say = bounded(warn, 20);
  const pass = bounded(skip, 20);
  let over = 0;
  lineup.forEach((s, i) => {
    if (slots.length >= SLOTS) {
      over++;
      return undefined;
    }
    if (!isObject(s)) return say(`${where}: entry ${i + 1} is ${kind(s)}, not an act; skipped.`);
    if (s.name !== undefined && s.name !== null && typeof s.name !== 'string') return say(`${where}: act ${i + 1}'s name is ${kind(s.name)} (${quote(s.name)}); skipped.`);
    const name = typeof s.name === 'string' ? s.name.trim() : '';
    const time = hhmm(s.time);
    if (!name) return pass(`${where}: act ${i + 1}${time ? ` at ${time}` : ''} has no name.`);
    if (!time) return pass(`${where}: "${name}" has ${typeof s.time === 'string' && s.time.trim() ? `the time ${quote(s.time)}, which isn't HH:MM` : 'no time'}.`);
    const slot = { time, name: name.slice(0, NAME_CHARS).trim() };
    if (name.length > NAME_CHARS) say(`${where}: "${slot.name}…" is cut to ${NAME_CHARS} characters.`);
    if (typeof s.b2b === 'string' && s.b2b.trim()) slot.b2b = s.b2b.trim().slice(0, NAME_CHARS).trim();
    else if (s.b2b !== undefined && s.b2b !== null && typeof s.b2b !== 'string') say(`${where}: "${name}"'s b2b is ${kind(s.b2b)}; left out.`);
    if (s.closer === true || s.closer === 1) slot.closer = true;
    else if (s.closer !== undefined && s.closer !== null && s.closer !== false && s.closer !== 0) say(`${where}: "${name}"'s closer is ${kind(s.closer)} (${quote(s.closer)}), not true or false; not the closer.`);
    byRaw.set(i, slots.length);
    slots.push(slot);
    return undefined;
  });
  if (over) warn(`${where}: ${plural(over, 'more entry', 'more entries')} past the ${SLOTS}-act limit; left out.`);
  const more = say.rest() + pass.rest();
  if (more) warn(`${where}: ${plural(more, 'more problem')} like those above; those entries are left out or cut.`);
  return { slots, byRaw };
}

// The headliner (H8: not the closer) matched to the lineup as v0's overlay did (overlay.js
// vkFindSlot): lowercase, letters only, doubled letters collapsed; an exact match first, then a
// prefix, in time order. The slot's index, or -1.
const loose = (v) => String(v || '').toLowerCase().replace(/[^a-z]/g, '').replace(/(.)\1+/g, '$1');
export function matchHeadliner(slots, name) {
  const want = loose(name);
  if (!want) return -1;
  const order = slots.map((s, i) => ({ i, at: nightOrder(s.time) })).sort((a, b) => a.at - b.at || a.i - b.i);
  for (const { i } of order) if (loose(slots[i].name) === want) return i;
  for (const { i } of order) if (loose(slots[i].name).startsWith(want)) return i;
  return -1;
}

// The name the event options give, else the event's billed artist.
function headlinerOf(f, slots) {
  const own = typeof f.evOpts.headliner === 'string' ? f.evOpts.headliner.trim() : '';
  const name = own || (Object.hasOwn(PACKS, f.event) ? PACKS[f.event].artist : undefined);
  if (!name) return undefined;
  const slot = matchHeadliner(slots, name);
  return { name, source: own ? 'the event options' : 'the event\'s billed artist', slot, matched: slot >= 0 };
}

const flag = (v, fallback) => (v === undefined || v === null ? fallback : Boolean(v) && v !== '0');

// The overlay's settings as v0 showed them (the template's defaults are taken out later).
function settingsOf(f, look, headliner, where, warn) {
  const s = { look, venue: f.venue, tagline: f.tagline, doors: f.doors, presents: f.presents, ticker: f.tickerOn, viewers: f.viewersMode === 'live' };
  const items = [];
  for (const t of f.ticker) {
    if (typeof t === 'string' && t.trim()) items.push(t.trim());
    else warn(`${where}: the ticker item ${quote(t)} isn't text; left out.`);
  }
  s.tickerItems = items;
  if (look === 'event') {
    const o = f.evOpts;
    // The event look had its own scanline switch (evOpts.scan); the setup's was hidden there.
    s.scanlines = flag(o.scan, true);
    const star = (o.star === undefined || o.star === null ? 'a' : textOf(o.star)).toLowerCase();
    if (Object.hasOwn(STARS, star)) s.starStyle = STARS[star];
    else warn(`${where}: the star treatment ${quote(o.star)} isn't one of v0's (a to d); the template's is used.`);
    s.showPoster = flag(o.poster, true);
    s.chip = flag(o.chip, true);
    s.lockup = flag(o.lockup, true);
    s.vu = flag(o.vu, true);
    s.stinger = flag(o.stinger, false);
    if (typeof o.addr === 'string' && o.addr.trim()) s.address = o.addr.trim();
    // A headliner who isn't on the lineup still shows by name, as v0 did.
    if (headliner && !headliner.matched) s.headliner = headliner.name;
  } else s.scanlines = f.scanlines;
  return s;
}

// The values worth saving: those the template accepts that differ from its defaults. considered:
// the keys whose values it accepted (an existing overlay's other settings are kept).
export function settingsToSave(manifest, values, { where = 'the overlay', warn = () => {} } = {}) {
  const defaults = resolveSettings(manifest, {});
  const saved = {};
  const considered = new Set();
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) continue;
    const problems = validateSettings(manifest, { [key]: value });
    if (problems.length) {
      warn(`${where}: ${key} = ${quote(value)} doesn't fit the template (${problems.map((p) => `${p.path === `/${key}` ? '' : `${p.path} `}${p.message}`).join('; ')}); it keeps the template's default.`);
      continue;
    }
    considered.add(key);
    if (!same(value, defaults[key])) saved[key] = value;
  }
  return { saved, considered };
}

// Fits a mapping's settings to the template the overlay will use (its schema and defaults), with
// a warning for each value it refuses: overlay.saved and each plan's saved.
export function fitTemplate(map, manifest) {
  const warn = (m) => map.warnings.push(m);
  Object.assign(map.overlay, settingsToSave(manifest, map.overlay.settings, { where: 'the overlay', warn }));
  for (const p of map.plans) Object.assign(p, settingsToSave(manifest, p.settings, { where: `the plan for ${p.date}`, warn }));
  return map;
}

// v0's recipe (server.js buildRundownFromLineup): at each set's start the title card (the
// headliner's too: v0 had no headliner intro of its own), the Event Intro clubIntroMin in, now
// playing every npIntervalMin until the next set. Whole minutes, 1 to 240, as recipes are.
function recipeOf(f, look, warn) {
  const minutes = (key, fallback) => {
    const v = Math.max(1, Number(f[key]) || fallback);
    const m = Math.min(240, Math.round(v));
    if (m !== v) warn(`${key} ${v} becomes ${m} (whole minutes, at most 240).`);
    return m;
  };
  const np = look === 'event' && !flag(f.evOpts.np, true) ? null : minutes('npIntervalMin', 10);
  return { titleCard: true, introOffsetMin: minutes('clubIntroMin', 5), nowPlayingEveryMin: np, headliner: false };
}

// One of v0's hand-made cues as this platform's action, or why it can't be.
function cueAction(c, ctx) {
  const slotName = Number.isInteger(c.slot) && ctx.byRaw.has(c.slot) ? ctx.slots[ctx.byRaw.get(c.slot)].name : undefined;
  const act = (name, args) => ({ type: 'overlay.action', name, ...(args ? { args } : {}) });
  // v0's DJ cues also said who's on (live.currentSlot).
  const withSlot = (action) => ({ type: 'sequence', steps: [{ offsetMs: 0, action: { type: 'show.slot', slot: slotName } }, ...(action ? [{ offsetMs: 0, action }] : [])] });
  const a = c.action;
  switch (a) {
    case 'djtitle':
      return { action: slotName ? withSlot(act('titleCard', { name: slotName })) : act('titleCard') };
    case 'title':
      return { action: act('titleCard') };
    case 'djnp':
    case 'djon':
    case 'np': {
      if (!ctx.np) return slotName ? { action: withSlot(null) } : { why: 'now playing was off in v0\'s event look' };
      return { action: slotName ? withSlot(act('nowPlaying', { name: slotName })) : act('nowPlaying') };
    }
    case 'clubintro':
      return { action: { type: 'show.scene', scene: 'intro' } };
    case 'headliner':
      return { action: { type: 'show.scene', scene: 'headliner' } };
    case 'clip:play':
      return ctx.clip ? { action: { type: 'media.play', mediaId: CLIP } } : { why: 'it plays The Line\'s clip, which isn\'t imported' };
    case 'clip:stop':
      return { action: { type: 'media.stop' } };
    case 'sched:opening':
    case 'sched:onat':
      if (!ctx.sched) return { why: 'the opening and on-at chips were off in v0\'s event look' };
      return { action: act(a === 'sched:opening' ? 'chipOpening' : 'chipOnAt') };
    default: {
      const scene = typeof a === 'string' && a.startsWith('scene:') ? a.slice(6) : undefined;
      const known = scene && (ctx.manifest ? Boolean(resolveScene(ctx.manifest, scene)) : V0_SCENES.includes(scene));
      if (known) return { action: { type: 'show.scene', scene } };
      return { why: `this platform has nothing like ${quote(a)}` };
    }
  }
}

// What will be made, from what readV0 read. options: name, slug, timezone (IANA, already checked),
// timezoneSource (words for the summary), now, manifest (the template's: with it, only the
// settings that differ from its defaults are kept, as fitTemplate does).
export function mapV0(read, { name, slug = 'takeover', timezone, timezoneSource = '', now = Date.now(), manifest } = {}) {
  const warnings = [...read.warnings];
  const skipped = [];
  const notImported = [];
  const warn = (m) => warnings.push(m);
  const skip = (m) => skipped.push(m);

  // The setup: kit.json, else the one v0 last pushed to its overlays (live.json's cfg).
  let setup;
  let from;
  if (isObject(read.kit) && Object.keys(read.kit).length) {
    setup = read.kit;
    from = 'kit.json';
  } else {
    if (read.kit !== undefined) warn(`kit.json holds ${isObject(read.kit) ? 'nothing' : kind(read.kit)}; the setup comes from live.json.`);
    const cfg = isObject(read.live) ? read.live.cfg : undefined;
    if (typeof cfg === 'string' && cfg) {
      setup = decodeCfg(cfg);
      if (setup) from = 'live.json';
      else warn('live.json\'s cfg can\'t be decoded (it isn\'t base64 JSON); skipped.');
    }
  }
  if (!setup) throw new ImportError(`Nothing to import: ${read.dir} has no kit.json, and live.json has no setup (cfg). Is it v0's data directory (DATA_DIR, /data in its container)?`, 'nothing');
  setup = upgradeSetup(setup);
  const f = fieldsOf(setup, from, warn);
  const today = dateIn(timezone, now);

  // ---- the show
  let date = typeof setup.date === 'string' && isDate(setup.date) ? setup.date : undefined;
  if (!date) {
    date = nextSaturday(today);
    warn(`${from} ${setup.date === undefined ? 'has no date' : `has the date ${quote(setup.date)}, which isn't one`}; the show is on the coming Saturday, ${date}, as v0's kit page would have it.`);
  }
  const goLive = hhmm(f.golive);
  if (!goLive && f.golive.trim()) warn(`${from}: go-live ${quote(f.golive)} isn't HH:MM; the show has none.`);
  const venue = typeof setup.venue === 'string' ? setup.venue.trim() : '';
  let showName = (typeof name === 'string' && name.trim()) || venue || 'Imported show';
  if (showName.length > NAME_CHARS) {
    showName = showName.slice(0, NAME_CHARS).trim();
    warn(`The show's name is cut to ${NAME_CHARS} characters: "${showName}".`);
  }
  const { slots, byRaw } = lineupOf(setup.lineup, `${from} lineup`, skip, warn);
  const headliner = headlinerOf(f, slots);
  if (headliner?.matched) slots[headliner.slot].headliner = true;

  // ---- the overlay
  let look = 'takeover';
  if (f.event === 'vikstarr') look = 'event';
  else if (f.event) warn(`${from}: the event ${quote(f.event)} isn't one v0 had; the TAKEOVER look is used.`);
  const settings = settingsOf(f, look, headliner, 'the overlay', warn);
  const recipe = recipeOf(f, look, warn);
  const sched = !(look === 'event' && !flag(f.evOpts.sched, true));

  // ---- v0's hand-made cues still to come that night (its generated ones are made again by the
  // recipe). v0 kept each with the instant it resolved to; one more than 12 hours from tonight's
  // is another night's.
  const cues = [];
  let v0Generated = 0;
  const rd = read.rundown;
  const list = isObject(rd) ? rd.cues : undefined;
  if (rd !== undefined && !Array.isArray(list)) warn(`rundown.json has no list of cues (${isObject(rd) ? `its cues are ${kind(list)}` : `it is ${kind(rd)}`}); no cues imported from it.`);
  const ctx = { slots, byRaw, clip: Boolean(read.clip), np: recipe.nowPlayingEveryMin !== null, sched, manifest };
  // An operator set a handful a night: past MANUAL_CUES they are only counted, and past 20 messages
  // so are the skipped ones, so a huge rundown can't take minutes or flood the summary.
  const cueSay = bounded(warn, 20);
  const cuePass = bounded(skip, 20);
  let extraCues = 0;
  for (const c of Array.isArray(list) ? list : []) {
    if (!isObject(c)) {
      cueSay(`rundown.json: a cue is ${kind(c)}; skipped.`);
      continue;
    }
    if (c.auto === true) {
      v0Generated++;
      continue;
    }
    const at = hhmm(c.at);
    const label = typeof c.label === 'string' && c.label.trim() ? c.label.trim().slice(0, LABEL_CHARS) : undefined;
    const what = `v0's cue ${label ? quote(label) : quote(c.action)}${at ? ` at ${at}` : ''}`;
    if (!at) {
      cueSay(`${what}: its time ${quote(c.at)} isn't HH:MM; skipped.`);
      continue;
    }
    if (c.done === true) {
      cuePass(`${what}: it already happened.`);
      continue;
    }
    if (isInstant(c.epoch)) {
      const tonight = resolveTime(date, at, { timezone, dayBoundary: DAY_BOUNDARY }).at;
      if (Math.abs(c.epoch - tonight) > 12 * HOUR) {
        cuePass(`${what}: it was for another night (${dateIn(timezone, c.epoch - 12 * HOUR)}).`);
        continue;
      }
    }
    const r = cueAction(c, ctx);
    if (!r.action) {
      cuePass(`${what}: ${r.why}.`);
      continue;
    }
    if (cues.length >= MANUAL_CUES) {
      extraCues++;
      continue;
    }
    cues.push({ at, ...(label ? { label } : {}), action: r.action, v0: textOf(c.action) || kind(c.action) });
  }
  if (extraCues) warn(`rundown.json: ${plural(extraCues, 'more hand-made cue')} past the ${MANUAL_CUES} imported; left out.`);
  const moreCues = cueSay.rest() + cuePass.rest();
  if (moreCues) skip(`rundown.json: ${plural(moreCues, 'more cue')} skipped for the same kinds of reasons as those above.`);

  // ---- planned dates, from today on in the show's zone
  const plans = [];
  let pastPlans = 0;
  const byDate = isObject(read.shows) ? read.shows.byDate : undefined;
  if (read.shows !== undefined && !isObject(byDate)) warn('shows.json has no planned dates (byDate); none imported.');
  for (const day of Object.keys(isObject(byDate) ? byDate : {}).sort()) {
    const entry = byDate[day];
    if (!isDate(day)) {
      warn(`shows.json: ${quote(day)} isn't a date; skipped.`);
      continue;
    }
    if (day < today) {
      pastPlans++;
      continue;
    }
    const where = `the plan for ${day}`;
    if (day === date) {
      skip(`${where}: it is the show's own date (${from} is that night already).`);
      continue;
    }
    if (!isObject(entry) || !isObject(entry.setup)) {
      warn(`${where} has no setup; skipped.`);
      continue;
    }
    if (entry.activatedAt) {
      skip(`${where}: v0 had already loaded it.`);
      continue;
    }
    const ps = upgradeSetup(entry.setup);
    const pf = fieldsOf(ps, where, warn);
    const lineup = lineupOf(ps.lineup, `${where}, lineup`, skip, warn).slots;
    const ph = headlinerOf(pf, lineup);
    if (ph?.matched) lineup[ph.slot].headliner = true;
    const pLook = pf.event === 'vikstarr' ? 'event' : 'takeover';
    const pGoLive = hhmm(pf.golive);
    if (!pGoLive && pf.golive.trim()) warn(`${where}: go-live ${quote(pf.golive)} isn't HH:MM; it has none.`);
    const pRecipe = recipeOf(pf, pLook, () => {});
    if (pRecipe.introOffsetMin !== recipe.introOffsetMin || pRecipe.nowPlayingEveryMin !== recipe.nowPlayingEveryMin) {
      warn(`${where} had its own cue timings (Event Intro ${pRecipe.introOffsetMin} min in, now playing ${pRecipe.nowPlayingEveryMin === null ? 'off' : `every ${pRecipe.nowPlayingEveryMin} min`}); a plan keeps the show's.`);
    }
    plans.push({ date: day, goLive: pGoLive ?? null, dayBoundary: DAY_BOUNDARY, lineup, headliner: ph, look: pLook, settings: settingsOf(pf, pLook, ph, where, warn) });
  }

  // ---- credentials
  const connections = connectionsOf(read.viewers, warn);

  // ---- what isn't imported, and why
  const roster = Array.isArray(setup.roster) ? setup.roster.length : 0;
  if (roster) notImported.push(`the roster (${plural(roster, 'name')} for autocomplete): the lineup has the acts`);
  if (read.live !== undefined) notImported.push('v0\'s live state (its scene, REC timer, and title and now-playing counters): the show starts fresh');
  if (f.viewersMode === 'manual') notImported.push(`the typed viewer number${f.viewersText ? ` (${quote(f.viewersText)})` : ''}: only a real count is ever shown (H6)`);
  const others = read.uploads.filter((n) => n !== read.clip?.name).length;
  if (others) notImported.push(`${plural(others, 'other upload')} in uploads/: v0 used only The Line's clip (skp media add brings one in)`);
  if (read.crashLog) notImported.push('crash.log: this platform keeps its own');
  if (f.cardSec !== 7 || f.npSec !== 22) notImported.push(`v0's card durations (title card ${f.cardSec} s, now playing ${f.npSec} s): the template's are 7 s and 22 s`);
  if (f.baseUrl.trim()) notImported.push(`the address v0 put in OBS links (${quote(f.baseUrl.trim())}): this platform's is SKP_PUBLIC_URL`);

  const out = {
    dir: read.dir,
    from,
    found: read.found,
    show: { name: showName, date, ...(goLive ? { goLive } : {}), timezone, dayBoundary: DAY_BOUNDARY, lineup: slots },
    timezoneSource,
    headliner,
    overlay: { slug, look, settings },
    recipe,
    clip: read.clip,
    cues,
    v0Generated,
    plans,
    pastPlans,
    connections,
    skipped,
    notImported,
    warnings,
  };
  return manifest ? fitTemplate(out, manifest) : out;
}

// viewers.json → { platform, clientId, clientSecret, channel, enabled } for Twitch and Kick, as v0
// had them (Twitch needs all three; Kick only its channel slug).
function connectionsOf(viewers, warn) {
  if (viewers === undefined) return [];
  if (!isObject(viewers)) {
    warn(`viewers.json is ${kind(viewers)}, not an object; no credentials imported.`);
    return [];
  }
  const text = (v) => (typeof v === 'string' ? v.trim().slice(0, CREDENTIAL_CHARS) : '');
  const out = [];
  for (const [platform, channelKey, label] of [['twitch', 'login', 'Twitch'], ['kick', 'slug', 'Kick']]) {
    const c = viewers[platform];
    if (c === undefined || c === null) continue;
    if (!isObject(c)) {
      warn(`viewers.json: ${label} is ${kind(c)}, not an object; skipped.`);
      continue;
    }
    const conn = { platform, clientId: text(c.clientId), clientSecret: text(c.clientSecret), channel: text(c[channelKey]).toLowerCase(), enabled: viewers.enabled === true };
    if (!conn.clientId && !conn.clientSecret && !conn.channel) continue;
    if (platform === 'twitch' && !(conn.clientId && conn.clientSecret && conn.channel)) warn('viewers.json: Twitch is incomplete (it needs a client ID, a client secret and a login); kept as it is.');
    if (platform === 'kick' && !conn.channel) warn('viewers.json: Kick has no channel slug; kept as it is.');
    out.push(conn);
  }
  return out;
}

// ---- applying -----------------------------------------------------------------------------------
// The clip as an earlier import put it in the media library (same original name and size).
const clipIn = (media, clip) => media.list().find((d) => d.data.status === 'ready' && d.data.original?.name === clip.original && d.data.original?.size === clip.size);

// What the import meets in the data directory, before anything changes: the template the overlay
// will use, an overlay, a show or the clip already there, or why it can't go ahead (refusal:
// { code, message }). overlays, shows and media may be missing (a dry run with no data directory).
export function checkV0(map, { templates, overlays, shows, media }, { replace = false } = {}) {
  const out = {};
  if (map.clip && media) out.clip = clipIn(media, map.clip);
  const slug = map.overlay.slug;
  const existing = overlays?.resolve(slug);
  if (existing) {
    out.overlay = existing.doc;
    const pin = existing.doc.data.template;
    if (pin.id !== TAKEOVER) {
      out.refusal = { code: 'slug-taken', message: `The overlay "${slug}" uses ${pin.id}, not the TAKEOVER template; give the import another --slug.` };
      return out;
    }
    out.template = templates.get(pin.id, pin.version);
    if (!out.template) {
      out.refusal = { code: 'no-template', message: `The overlay "${slug}" uses ${pin.id}@${pin.version}, which isn't installed; install it, or give the import another --slug.` };
      return out;
    }
  } else {
    out.template = templates.versions(TAKEOVER)[0];
    if (!out.template) {
      out.refusal = { code: 'no-template', message: `The TAKEOVER template (${TAKEOVER}) isn't installed.` };
      return out;
    }
  }
  const list = shows ? shows.list() : [];
  out.show = list.find((s) => s.name.toLowerCase() === map.show.name.toLowerCase());
  if (out.show && !replace) {
    out.refusal = { code: 'show-exists', message: `There is already a show called "${out.show.name}". Import again with --replace to replace it (its cues and plans go with it), or give another --name.` };
    return out;
  }
  if (existing) {
    const holder = list.find((s) => s.overlays.includes(existing.doc.id));
    if (holder && holder.id !== out.show?.id) {
      out.refusal = { code: 'in-other-show', message: `The overlay "${slug}" is in the show "${holder.name}", and an overlay belongs to one show; give the import another --slug, or take it out of that show first.` };
      return out;
    }
  }
  // The new show as the show registry would refuse it (a lineup too large for its overlays, say),
  // before anything is written: --replace removes the old show only once the new one can be made.
  if (shows?.check) {
    const s = map.show;
    try {
      shows.check({ name: s.name, date: s.date, timezone: s.timezone, dayBoundary: s.dayBoundary, ...(s.goLive ? { goLive: s.goLive } : {}), lineup: s.lineup }, { replacing: out.show?.id });
    } catch (err) {
      if (!(err instanceof ShowError)) throw err;
      out.refusal = { code: err.code || 'invalid', message: `The show can't be made from v0's setup: ${err.message}${out.show ? ` The show "${out.show.name}" stays as it is.` : ''}` };
    }
  }
  return out;
}

// The overlay's saved settings after the import: v0's values that differ from the template's
// defaults, over what an existing overlay has (its other settings stay; a v0 value that is the
// default clears the one it had).
function merged(base, { saved, considered }) {
  const next = { ...base };
  for (const key of considered) {
    if (Object.hasOwn(saved, key)) next[key] = saved[key];
    else delete next[key];
  }
  return next;
}

// Makes the import in an open data directory: data is app.js openData's (templates, overlays,
// media, shows, timeline, store, secrets, audit). options: replace, actor (who the audit log
// names), now, base (the platform's address, for the overlay's OBS URLs). Returns what was done;
// throws ImportError for a refusal, before anything changes.
export async function applyV0(map, data, { replace = false, actor = 'cli', now = Date.now, base } = {}) {
  const { templates, overlays, media, shows, timeline, store, secrets, audit } = data;
  const check = checkV0(map, { templates, overlays, shows, media }, { replace });
  if (check.refusal) throw new ImportError(check.refusal.message, check.refusal.code);
  if (!map.overlay.considered) fitTemplate(map, check.template.manifest);
  const warnings = [];
  const skipped = [];
  const warn = (m) => warnings.push(m);
  const record = (action, target, details = {}) => audit.record({ action: `import.v0.${action}`, actor, target, ...details });
  const result = { warnings, skipped };

  // 1. The Line's clip, into the media library (converted for OBS like any upload). The same clip
  // imported before is used again.
  let clip;
  if (map.clip) {
    clip = check.clip;
    if (clip) result.clip = { id: clip.id, url: mediaUrl(clip), reused: true };
    else {
      try {
        clip = await media.add(map.clip.file, { name: map.clip.original, actor });
        record('media.add', clip.id, { name: clip.data.name, url: mediaUrl(clip), converted: clip.data.converted });
        result.clip = { id: clip.id, url: mediaUrl(clip), converted: clip.data.converted, ...(clip.data.note ? { note: clip.data.note } : {}) };
      } catch (err) {
        if (!(err instanceof MediaError)) throw err;
        clip = undefined;
        warn(`The Line's clip (${map.clip.name}) wasn't imported: ${err.message}`);
      }
    }
  }
  const withClip = (fit) => (clip ? { saved: { ...fit.saved, lineClip: mediaUrl(clip) }, considered: new Set([...fit.considered, 'lineClip']) } : fit);

  // 2. The overlay: made, or the TAKEOVER overlay already there with this slug, updated.
  const t = check.template;
  const slug = map.overlay.slug;
  const base0 = check.overlay?.data.settings || {};
  const settings = merged(base0, withClip(map.overlay));
  if (check.overlay) {
    const changed = !same(settings, base0);
    if (changed) {
      overlays.updateSettings(check.overlay.id, settings);
      record('overlay.update', slug, { template: `${t.id}@${t.version}`, settings: Object.keys(settings) });
    }
    result.overlay = { slug, template: `${t.id}@${t.version}`, created: false, changed, settings };
  } else {
    overlays.create({ slug, template: { id: t.id, version: t.version }, settings });
    record('overlay.create', slug, { template: `${t.id}@${t.version}`, settings: Object.keys(settings) });
    result.overlay = { slug, template: `${t.id}@${t.version}`, created: true, changed: true, settings };
  }

  // 3. The show, replacing the one of that name (with its cues and plans) when asked to.
  if (check.show) {
    shows.remove(check.show.id);
    record('show.delete', check.show.id, { name: check.show.name, replaced: true });
    const left = check.show.members.filter((m) => m !== slug);
    result.replaced = { id: check.show.id, name: check.show.name, ...(left.length ? { leftOut: left } : {}) };
  }
  const s = map.show;
  const created = shows.create({ name: s.name, overlays: [slug], date: s.date, timezone: s.timezone, dayBoundary: s.dayBoundary, ...(s.goLive ? { goLive: s.goLive } : {}), lineup: s.lineup }, { actor });
  record('show.create', created.id, { name: created.name, date: created.date, timezone: created.timezone, acts: created.lineup.length });

  // 4. The timeline: v0's recipe, then v0's own cues.
  const built = timeline.build(created.id, map.recipe);
  record('cues.build', created.id, { recipe: map.recipe, generated: built.filter((c) => c.generated).length });
  let manual = 0;
  for (const [i, c] of map.cues.entries()) {
    const name = c.label ? `"${c.label}"` : c.v0;
    if (c.action.mediaId === CLIP && !clip) {
      skipped.push(`v0's cue ${name} at ${c.at}: it plays The Line's clip, which wasn't imported.`);
      continue;
    }
    const action = c.action.mediaId === CLIP ? { ...c.action, mediaId: clip.id } : c.action;
    try {
      const cue = timeline.add(created.id, { at: c.at, action, ...(c.label ? { label: c.label } : {}) }, { actor });
      record('cue.add', cue.id, { show: created.id, at: c.at, type: action.type, v0: c.v0 });
      manual++;
    } catch (err) {
      if (!(err instanceof ShowError)) throw err;
      // The show is full: the rest would fail the same way, one by one.
      if (err.code === 'too-many') {
        const left = map.cues.length - i;
        warn(`${left === 1 ? 'v0\'s last cue wasn\'t' : `v0's last ${left} cues weren't`} added: ${err.message}`);
        break;
      }
      warn(`v0's cue ${name} at ${c.at} wasn't added: ${err.message}`);
    }
  }

  // 5. Planned dates. A plan's settings replace the overlay's when its day comes, and a plan without
  // any leaves the last plan's on air: so every plan carries the overlay's whole settings for its
  // night, the ones the show starts with included (the 24th's event look must not stay for the 31st).
  const plans = [];
  for (const p of map.plans) {
    const ps = merged(base0, withClip(p));
    const input = { date: p.date, goLive: p.goLive, dayBoundary: p.dayBoundary, lineup: p.lineup, overlaySettings: { [slug]: ps } };
    try {
      const plan = timeline.plans.add(created.id, input);
      // ownLook: its settings differ from the show's (the summary says so).
      const ownLook = !same(ps, settings);
      record('plan.add', plan.id, { show: created.id, date: p.date, acts: p.lineup.length, ownLook });
      plans.push({ id: plan.id, date: p.date, acts: p.lineup.length, ownLook, activateAt: plan.activateAt, ...(plan.activatedAt ? { activatedAt: plan.activatedAt } : {}) });
    } catch (err) {
      if (!(err instanceof ShowError)) throw err;
      warn(`The plan for ${p.date} wasn't added: ${err.message}`);
    }
  }

  // 6. Twitch and Kick, kept until connections exist (steps 16-17): the secret encrypted with the
  // record's id as associated data. One record per platform; importing again replaces it.
  const connections = [];
  for (const c of map.connections) {
    const id = c.platform;
    const had = store.get(PENDING_CONNECTIONS, id);
    store.put(PENDING_CONNECTIONS, id, {
      platform: c.platform,
      clientId: c.clientId,
      ...(c.clientSecret ? { clientSecret: secrets.encrypt(c.clientSecret, id) } : {}),
      channel: c.channel,
      enabled: c.enabled,
      from: 'v0',
      importedAt: new Date(now()).toISOString(),
    });
    record('connection.keep', id, { platform: c.platform, channel: c.channel, replaced: Boolean(had) });
    connections.push({ platform: c.platform, channel: c.channel, secret: Boolean(c.clientSecret) });
  }

  // A plan whose day has begun is the show already.
  const final = shows.get(created.id);
  const cues = timeline.list(created.id);
  Object.assign(result, {
    show: { id: final.id, name: final.name, date: final.date, timezone: final.timezone, ...(final.goLive ? { goLive: final.goLive } : {}), dayBoundary: final.dayBoundary, acts: final.lineup.length },
    cues: { generated: cues.filter((c) => c.generated).length, manual, total: cues.length },
    plans,
    connections,
    urls: base ? overlays.urls(slug, base) : undefined,
  });
  return result;
}

// ---- output -------------------------------------------------------------------------------------
// Each summary line is one line: v0's text can't break it or send the terminal control codes.
const clean = (s) => String(s).replace(/[\x00-\x1f\x7f]/g, ' ');
const platformName = (p) => (p === 'twitch' ? 'Twitch' : 'Kick');

// The import as JSON: what was made (or would be, with dryRun), never a secret.
export function importJson(map, result, { dryRun = false, check } = {}) {
  return {
    dryRun,
    ...(check?.refusal ? { refused: check.refusal } : {}),
    from: { dir: map.dir, setup: map.from, files: map.found },
    show: result?.show ?? { name: map.show.name, date: map.show.date, timezone: map.show.timezone, ...(map.show.goLive ? { goLive: map.show.goLive } : {}), dayBoundary: map.show.dayBoundary, acts: map.show.lineup.length },
    timezoneSource: map.timezoneSource,
    lineup: map.show.lineup,
    headliner: map.headliner ? { name: map.headliner.name, from: map.headliner.source, act: map.headliner.matched ? map.show.lineup[map.headliner.slot].name : null } : null,
    overlay: result?.overlay ?? { slug: map.overlay.slug, look: map.overlay.look, ...(check?.template ? { template: `${check.template.id}@${check.template.version}` } : {}), settings: map.overlay.saved ?? map.overlay.settings },
    clip: result?.clip ?? (check?.clip ? { id: check.clip.id, url: mediaUrl(check.clip), reused: true } : map.clip ? { name: map.clip.name, size: map.clip.size } : null),
    recipe: map.recipe,
    cues: result?.cues ?? { manual: map.cues.length },
    plans: result?.plans ?? map.plans.map((p) => ({ date: p.date, acts: p.lineup.length })),
    pastPlans: map.pastPlans,
    connections: result?.connections ?? map.connections.map((c) => ({ platform: c.platform, channel: c.channel, secret: Boolean(c.clientSecret) })),
    ...(result?.replaced ? { replaced: result.replaced } : {}),
    ...(result?.urls ? { urls: result.urls } : {}),
    skipped: [...map.skipped, ...(result?.skipped || [])],
    notImported: map.notImported,
    warnings: [...map.warnings, ...(result?.warnings || [])],
  };
}

// The import in plain words: what was imported, what was skipped and why, what to do next.
export function importSummary(map, result, { dryRun = false, check, note } = {}) {
  const lines = [];
  const out = (s = '') => lines.push(clean(s).trimEnd());
  const s = map.show;
  out(dryRun ? `A dry run: importing v0's data from ${map.dir} (the setup from ${map.from}) would do this.` : `Imported v0's data from ${map.dir} (the setup from ${map.from}).`);
  out();
  const date = result?.show.date ?? s.date;
  out(`Show "${s.name}": ${s.date}${s.goLive ? `, go-live ${s.goLive}` : ', no go-live'}, timezone ${s.timezone} (${map.timezoneSource}; v0 used its server's zone, so pass --timezone if that was another).`);
  out(`  Day boundary ${s.dayBoundary}: times before noon belong to the night before, as in v0.`);
  if (result?.replaced) out(`  It replaces the show of that name, with its cues and plans.${result.replaced.leftOut ? ` Its other overlays (${result.replaced.leftOut.join(', ')}) are in no show now.` : ''}`);
  if (result && date !== s.date) out(`  The plan for ${date} is the show already: its day has begun.`);
  const acts = s.lineup.map((x) => `${x.time} ${x.name}${x.b2b ? ` b2b ${x.b2b}` : ''}${x.headliner ? ' (headliner)' : ''}${x.closer ? ' (closer)' : ''}`);
  out(`  Lineup: ${acts.length ? `${plural(acts.length, 'act')}: ${acts.join(', ')}` : 'no acts'}.`);
  const h = map.headliner;
  if (!h) out('  Headliner: v0 named none (flag one on the lineup if the night has one).');
  else if (h.matched) out(`  Headliner: ${s.lineup[h.slot].name} (${h.source} named ${h.name}), flagged on the lineup; the closer stays the closer.`);
  else out(`  Headliner: ${h.source} named ${h.name}, who isn't on the lineup, so no act is flagged${map.overlay.look === 'event' ? ' (the overlay shows the name, as v0 did)' : ''}.`);
  out();

  const o = result?.overlay;
  const template = o?.template ?? (check?.template ? `${check.template.id}@${check.template.version}` : TAKEOVER);
  const what = o ? (o.created ? 'made' : o.changed ? 'updated (it was there already)' : 'there already, unchanged') : check?.overlay ? 'would be updated (it is there already)' : 'would be made';
  out(`Overlay "${map.overlay.slug}": ${what}, from ${template}, in ${map.overlay.look === 'event' ? 'the headliner event look' : 'the TAKEOVER look'}, on both canvases (horizontal and vertical).`);
  const keys = Object.keys(o?.settings ?? map.overlay.saved ?? map.overlay.settings);
  out(`  ${keys.length ? `Settings that differ from the template's: ${keys.join(', ')}` : 'Every setting as the template has it'}.`);
  if (result?.clip) out(`  The Line's clip: ${result.clip.url}${result.clip.reused ? ' (imported before, used again)' : result.clip.converted ? ' (converted for OBS)' : ''}.${result.clip.note ? ` ${result.clip.note}` : ''}`);
  else if (dryRun && check?.clip) out(`  The Line's clip: ${mediaUrl(check.clip)} (imported before, would be used again).`);
  else if (dryRun && map.clip) out(`  The Line's clip: ${map.clip.name} would go into the media library.`);
  out();

  const r = map.recipe;
  out(`Timeline: ${result ? `${plural(result.cues.generated, 'cue')} from the lineup` : 'cues from the lineup'}, made as v0 made them: a title card at each set's start, the Event Intro ${r.introOffsetMin} min in${r.nowPlayingEveryMin === null ? '' : `, now playing every ${r.nowPlayingEveryMin} min until the next set`}.`);
  if (result && result.cues.generated === 0 && s.lineup.length) out(`  None for now: the night of ${date} is over. They are made when a planned date becomes the show.`);
  const manual = result ? result.cues.manual : map.cues.length;
  out(`  ${dryRun ? 'It would add' : 'Added'} ${plural(manual, 'cue')} v0's operator set by hand${map.v0Generated ? `; v0's ${plural(map.v0Generated, 'generated cue')} are made again by the recipe` : ''}.`);
  out();

  const plans = result ? result.plans : map.plans;
  out(`Planned dates: ${plans.length ? plans.map((p) => `${p.date}${(result ? p.ownLook : p.look !== map.overlay.look) ? ' (with its own look)' : ''}${p.activatedAt ? ' (the show already)' : ''}`).join(', ') : 'none to come'}.`);
  if (map.pastPlans) out(`  ${plural(map.pastPlans, 'date')} in shows.json ${map.pastPlans === 1 ? 'is' : 'are'} past, and left out.`);
  const conns = result ? result.connections : map.connections.map((c) => ({ platform: c.platform, channel: c.channel }));
  if (conns.length) {
    out();
    out(`${conns.map((c) => platformName(c.platform)).join(' and ')} credentials ${dryRun ? 'would be kept' : 'are kept'}, encrypted, for when connections arrive (${conns.map((c) => `${platformName(c.platform)} channel ${c.channel || 'not set'}`).join(', ')}).`);
  }

  const lists = [['Skipped', [...map.skipped, ...(result?.skipped || [])]], ['Not imported', map.notImported], ['Warnings', [...map.warnings, ...(result?.warnings || [])]]];
  for (const [title, items] of lists) {
    if (!items.length) continue;
    out();
    out(`${title}:`);
    for (const x of items) out(`  - ${x}`);
  }
  out();
  if (dryRun) {
    if (note) out(note);
    if (check?.refusal) out(`It would be refused: ${check.refusal.message}`);
    out('Nothing changed (--dry-run). Run it again without --dry-run, with the platform stopped, to import.');
    return lines.join('\n');
  }
  out('Next:');
  out(`  1. Start the platform (npm start). The show is under Shows in the admin UI, or: skp show cues "${s.name.replace(/"/g, '\\"')}"`);
  out('  2. In OBS, point the browser sources at the overlay (v0\'s feed=h and feed=v links become these):');
  for (const u of result?.urls || []) out(`       ${u.canvas === 'v' ? 'vertical' : 'horizontal'}, ${u.width} x ${u.height}: ${u.url}`);
  out(`     skp overlay url ${map.overlay.slug} prints them again; from another computer, use this machine's address.`);
  out('  3. Run v0 next to it for one show, then retire v0.');
  return lines.join('\n');
}
