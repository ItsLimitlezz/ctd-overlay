// Shows (08 §8.1, 09): the overlays that change together, the night's lineup, the timeline the
// server runs by itself, and planned dates. Routes: /shows (list) and /shows/:id (detail, by id or
// name). Every time of a show is in the show's own time zone; the server resolves wall-clock times
// to instants (09 §9.2) and this page shows the instants it answers with. Edits send If-Match with
// the show (or cue, or plan) as the form read it (H16); destructive actions sit in a menu behind a
// confirmation (H20). Details also sets what feeds every overlay of the show at once ("Fed by":
// one change per overlay, each with its own If-Match), and whether the show follows OBS's scenes
// ("Follow OBS", obs.js).
//
// What v0's one setup did lives on a show here (set times, the countdown, who's on, the
// timeline), so the list says which overlays are in no show, and a show whose night has passed
// says so. A weekly show is quick to move on: dates have quick picks (Tonight, This Saturday, Next
// week), a lineup's names are offered from every lineup (GET /acts, v0's roster), and a plan has a
// lineup of its own, edited like the show's. Unsaved edits are never dropped without a word: a tab
// change asks first, and moving the show to its next night keeps them.
import * as api from '../api.js';
import { badge, clock, confirm, dialog, empty, every, field, h, menu, mount, notice, pageHead, run, statusDot, tabs, toast } from '../dom.js';
import { followObsCard } from '../obs.js';
import { bindingName, fedByForm, fedByWords } from '../streams.js';

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const GRACE_MS = 5 * 60 * 1000; // a cue more than this late is missed, not fired (09 §9.4, H5)
const DEFAULT_RECIPE = { titleCard: true, introOffsetMin: 5, nowPlayingEveryMin: 10, headliner: true };
const TAB_IDS = ['details', 'lineup', 'timeline', 'plans'];
// The cue actions this page offers, in plain words (09 §9.3). Sequences, connector actions and
// webhooks are shown but not made here.
const KINDS = [
  { type: 'overlay.action', label: 'Show a graphic (title card, now playing, an intro…)' },
  { type: 'show.scene', label: 'Change the scene' },
  { type: 'show.slot', label: 'Set who\'s on' },
  { type: 'media.play', label: 'Play a clip' },
  { type: 'media.stop', label: 'Stop the clip' },
];
const STATUS = {
  armed: ['Upcoming', undefined],
  fired: ['Done', 'ok'],
  missed: ['Missed', 'warn'],
  skipped: ['Skipped', undefined],
};
// The cards about an act (timeline.js ACT_CARDS, 09 §9.3): a cue picks the act, or whoever is on.
const ACT_CARDS = ['titleCard', 'nowPlaying', 'nowPlayingHold'];
// What a show gives its overlays and an overlay outside one doesn't have (registry.js SHOW_KEYS
// but the scene, which an overlay has of its own).
const SHOW_STATE = ['show.lineup', 'show.headliner', 'show.currentSlot', 'show.date', 'show.timezone', 'show.goLiveAt', 'show.recStartedAt'];
// Whether a template reads any of it: a key it consumes by name, or by a prefix ending in ".*".
const readsShow = (manifest) => (Array.isArray(manifest?.consumes?.state) ? manifest.consumes.state : [])
  .some((p) => typeof p === 'string' && SHOW_STATE.some((k) => p === k || (p.endsWith('.*') && k.startsWith(p.slice(0, -1)))));

// ---- small helpers ---------------------------------------------------------------------------
const fail = (message) => { throw new Error(message); };
const minutesOf = (t) => {
  const m = TIME.exec(t || '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
};
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const andList = (items) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

function browserZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}
// "(America/Toronto time)" when the show's zone isn't this device's.
const zoneNote = (tz) => (tz && tz !== browserZone() ? ` (${tz.replace(/_/g, ' ')} time)` : '');

// The wall clock of an instant in a zone: { year, month, day, hour, minute } as strings. A zone's
// formatter is made once (a timeline asks for hundreds of instants).
const wallFormats = new Map();
function partsIn(date, timeZone) {
  let fmt = wallFormats.get(timeZone);
  if (!fmt) {
    const opts = { hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' };
    try { fmt = new Intl.DateTimeFormat('en-US', { ...opts, timeZone }); } catch { fmt = new Intl.DateTimeFormat('en-US', opts); }
    wallFormats.set(timeZone, fmt);
  }
  const out = {};
  for (const p of fmt.formatToParts(date)) out[p.type] = p.value;
  if (out.hour === '24') out.hour = '00';
  return out;
}
const ymdIn = (date, tz) => { const p = partsIn(date, tz); return `${p.year}-${p.month}-${p.day}`; };
const hmIn = (date, tz) => { const p = partsIn(date, tz); return `${p.hour}:${p.minute}`; };

// A calendar date ("2026-10-17") as words: "Sat, Oct 17" or "Saturday, October 17, 2026".
function dateLabel(ymd, long = false) {
  const m = DATE.exec(ymd || '');
  if (!m) return ymd || '';
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  const opts = long ? { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' } : { weekday: 'short', day: 'numeric', month: 'short' };
  return new Intl.DateTimeFormat(undefined, { ...opts, timeZone: 'UTC' }).format(d);
}
function addDays(ymd, n) {
  const m = DATE.exec(ymd || '');
  if (!m) return ymd;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + n)).toISOString().slice(0, 10);
}
// A wall-clock time ("01:00") in this device's way of writing times: "1:00 AM".
function timeLabel(t) {
  const m = TIME.exec(t || '');
  if (!m) return t || '';
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }).format(new Date(Date.UTC(2000, 0, 1, Number(m[1]), Number(m[2]))));
}
// An instant in the show's zone: "Sat, Oct 17, 10:30 PM".
function instantLabel(iso, tz) {
  if (!iso) return '';
  try {
    return new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: tz }).format(new Date(iso));
  } catch {
    return new Date(iso).toLocaleString();
  }
}

// The show's day now, in its zone and with its day boundary (09 §9.2), on the server's clock:
// before the boundary it is still the night before, so at 1 AM on Sunday a Saturday show's
// "tonight" is Saturday.
function showDayNow(tz, boundary = '12:00') {
  const p = partsIn(new Date(api.serverNow()), tz);
  const today = `${p.year}-${p.month}-${p.day}`;
  return minutesOf(`${p.hour}:${p.minute}`) < (minutesOf(boundary) || 0) ? addDays(today, -1) : today;
}
const weekdayOf = (ymd) => {
  const m = DATE.exec(ymd || '');
  return m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay() : NaN;
};
const weekdayName = (ymd) => {
  const m = DATE.exec(ymd || '');
  return m ? new Intl.DateTimeFormat(undefined, { weekday: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))) : '';
};
// The first date on or after `from` that falls on the weekday of `like`.
const onWeekday = (from, like) => addDays(from, (weekdayOf(like) - weekdayOf(from) + 7) % 7);

// Quick picks under a date field (v0's "This Saturday"), for a weekly show: Tonight, the next night
// on the date's weekday, and a week after the date; a new show, with no weekday of its own yet, also
// gets the coming Friday and Saturday (weekdays: 5, 6). Tonight is the show's day now in the zone
// and with the day boundary the form has (zone(), boundary()). A plan, for a night still to come
// (future), gets no Tonight: its picks start tomorrow. The date is said in words beside them,
// weekday and all, which a date field doesn't show. Returns { words, row, refresh }.
function datePicks(input, { zone, boundary = () => '12:00', weekdays = [], future = false }) {
  const words = h('span.small', { 'aria-live': 'polite' });
  const row = h('div.row', { role: 'group', 'aria-label': 'Quick dates' });
  const pick = (ymd) => {
    input.value = ymd;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };
  function refresh() {
    const v = DATE.test(input.value) ? input.value : '';
    const tonight = showDayNow(zone(), boundary());
    const picks = future ? [] : [['Tonight', tonight]];
    const weekly = (ymd) => {
      const at = onWeekday(future ? addDays(tonight, 1) : tonight, ymd);
      if (!picks.some(([, d]) => d === at)) picks.push([`This ${weekdayName(ymd)}`, at]);
    };
    // A week's dates from a Sunday (2026-10-18): one for each weekday asked.
    for (const wd of weekdays) weekly(addDays('2026-10-18', wd));
    if (v) weekly(v);
    if (v) picks.push(['Next week', addDays(v, 7)]);
    mount(row, picks.map(([label, ymd]) => h('button.btn.small', {
      type: 'button', disabled: input.disabled, 'aria-pressed': String(ymd === v), 'aria-label': `${label}: ${dateLabel(ymd, true)}`, onclick: () => pick(ymd),
    }, label)));
    words.textContent = v ? `${dateLabel(v, true)}${v === tonight ? ': tonight' : v < tonight ? ': that night has passed' : ''}` : '';
  }
  input.addEventListener('input', refresh);
  input.addEventListener('change', refresh);
  refresh();
  return { words, row, refresh };
}
// A date field with its quick picks: the date in words under the field, then the picks.
function dateField(label, input, { hint, zone, boundary, weekdays, future }) {
  const picks = datePicks(input, { zone, boundary, weekdays, future });
  const el = field(label, input, { hint });
  input.after(picks.words, picks.row);
  el.refresh = picks.refresh;
  return el;
}

// The time zone control: a list of the zones this browser knows, or a text field where it can't
// list them. The current zone is always an option.
function zoneInput(value, { disabled } = {}) {
  let zones = [];
  try { zones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : []; } catch { zones = []; }
  if (!zones.length) return h('input', { type: 'text', value: value || '', autocomplete: 'off', spellcheck: 'false', placeholder: 'America/Toronto', disabled });
  const list = value && !zones.includes(value) ? [value, ...zones] : zones;
  const select = h('select', { disabled }, list.map((z) => h('option', { value: z }, z.replace(/_/g, ' '))));
  if (value) select.value = value;
  return select;
}

// A checkbox as a 44 px toggle button: the whole box is the label.
function toggle(text, checked, { disabled, onChange } = {}) {
  const input = h('input', { type: 'checkbox', checked: !!checked, disabled, onchange: (e) => onChange?.(e.target.checked) });
  // The box in its own span: a long label that wraps can't squeeze it.
  const el = h('label.btn', { 'aria-disabled': disabled ? 'true' : undefined }, h('span', input), h('span', text));
  el.input = input;
  return el;
}

// The overlays a show has, as toggles. An overlay is in one show at most (01 §1.3): one in
// another show can't be picked here. values() are the overlays' ids: a name can change elsewhere
// (a rename doesn't change the show's ETag), an id can't. An overlay known only by name (the list
// failed to load) goes by its name.
const overlayRef = (o) => o.id || o.slug;
function overlayPicker(overlays, { members = [], showName, disabled } = {}) {
  const mine = (o) => members.includes(o.id) || members.includes(o.slug);
  const items = overlays.map((o) => {
    const elsewhere = !!o.show && !mine(o) && (!showName || String(o.show).toLowerCase() !== showName.toLowerCase());
    const input = h('input', { type: 'checkbox', value: o.slug, checked: mine(o), disabled: disabled || elsewhere });
    const el = h('label.btn', { 'aria-disabled': disabled || elsewhere ? 'true' : undefined }, h('span', input), h('span', o.slug), elsewhere ? h('span.small.muted', `in "${o.show}"`) : null);
    return { o, input, el };
  });
  const el = h('fieldset',
    h('legend', 'Overlays in this show'),
    h('p.small.muted', 'A scene you take changes all of them together, like the horizontal and vertical feeds. An overlay belongs to one show at most: one that is in another show is greyed out until it leaves that show.'),
    items.length
      ? h('div.row', items.map((i) => i.el))
      : h('p.muted', 'There are no overlays yet. ', h('a', { href: '#/templates' }, 'Make one from a template'), ', then add it here.'));
  return { el, values: () => items.filter((i) => i.input.checked).map((i) => overlayRef(i.o)) };
}

// What the day boundary means for this show, in words (H7).
function boundaryWords(b, date) {
  const m = minutesOf(b);
  if (!m) return `The show's day starts at midnight: every time is on ${dateLabel(date)}.`;
  const example = m > 60 ? '01:00' : '00:00';
  return `Times before ${timeLabel(b)} belong to the next day: an act at ${timeLabel(example)} plays after midnight, on ${dateLabel(addDays(date, 1))}, not before doors.`;
}

// A choice from a list, or a text field when there is nothing to list. The current value is
// always an option.
function choice(options, value, { placeholder, disabled } = {}) {
  if (!options.length && (value === undefined || value === '')) return h('input', { type: 'text', autocomplete: 'off', spellcheck: 'false', placeholder, disabled });
  const list = value !== undefined && value !== '' && !options.some((o) => o.value === value) ? [...options, { value, label: value }] : options;
  const select = h('select', { disabled }, list.map((o) => h('option', { value: o.value }, o.label)));
  if (value !== undefined) select.value = value;
  return select;
}

// A form in a dialog that stays open while it saves: the primary button runs submit() (busy, no
// double tap), a problem shows in the dialog, and success closes it. Resolves with submit's
// result, or undefined when cancelled. onError(err, close) may handle an error itself (→ true).
function formDialog({ title, body, submitLabel = 'Save', focus, submit, onError }) {
  const message = h('div', { 'aria-live': 'polite' });
  let result;
  const pending = dialog({ title, body: h('div', body, message), actions: [{ label: 'Cancel', value: false }, { label: submitLabel, value: true, kind: 'primary' }] });
  const d = message.closest('dialog');
  const button = d?.querySelector('.form-actions .btn.primary');
  d?.addEventListener('click', async (e) => {
    if (!button || !button.contains(e.target)) return;
    // Ours, not the dialog's own handler (which would close it before the request is done).
    e.stopPropagation();
    e.preventDefault();
    mount(message);
    const out = await run(button, async () => (await submit()) ?? true, {
      onError: (err) => {
        if (onError?.(err, () => d.close())) return;
        mount(message, notice(err?.message || String(err), 'danger'));
        message.scrollIntoView?.({ block: 'nearest' });
      },
    });
    if (out !== undefined) {
      result = out;
      d.close();
    }
  }, true);
  focus?.focus();
  return pending.then(() => result);
}

// A slot as the API takes it (registry.js SLOT_FIELDS): nothing the server added.
function cleanSlot(s) {
  const out = { time: String(s?.time || ''), name: String(s?.name || '').trim() };
  const b2b = String(s?.b2b || '').trim();
  if (b2b) out.b2b = b2b;
  if (s?.headliner) out.headliner = true;
  if (s?.closer) out.closer = true;
  if (s?.logo) out.logo = s.logo;
  return out;
}
const lineupOf = (show) => (Array.isArray(show?.lineup) ? show.lineup : []).map(cleanSlot);
// The uploaded images a logo is picked from.
const imagesOf = (media) => media.filter((m) => m?.status === 'ready' && m.kind === 'image').map((m) => ({ value: m.url, label: m.name || m.url }));
// An act's name as names are told apart (timeline.js): letter case and spacing aside.
const actKey = (name) => String(name || '').trim().replace(/\s+/g, ' ').toLowerCase();

// The lineup editor, the show's (Lineup) and a plan's own (Plans): a fieldset per act (time, act,
// B2B, logo, headliner, closer), moved up and down or removed. The act and B2B fields offer the
// names of every lineup (acts: GET /acts, v0's roster), and a known act's latest logo comes with
// its name into a row that has none. rows: { time, name, b2b?, headliner?, closer?, logo?, orig? }
// (orig: the slot as the server resolved it, for the instant it starts), changed in place;
// night(): { date, boundary, timezone } as they are now; onChange() after each edit.
let editors = 0;
function lineupEditor({ rows, night, images, acts = [], disabled, onChange }) {
  const list = h('div.stack');
  const names = h('datalist', { id: `acts-${++editors}` }, acts.map((a) => h('option', { value: a.name })));
  const logos = new Map(acts.filter((a) => a.logo && images.some((i) => i.value === a.logo)).map((a) => [actKey(a.name), a.logo]));

  // When a row plays: the server's instant for a saved time; for a changed one, which day.
  function when(row) {
    const { date, boundary, timezone } = night();
    if (!TIME.test(row.time)) return [h('span', 'Set a time.')];
    const nextDay = minutesOf(row.time) < minutesOf(boundary);
    const out = [];
    if (row.orig && row.orig.time === row.time && row.orig.startAt) {
      out.push(h('span', `Starts ${instantLabel(row.orig.startAt, timezone)}${nextDay ? ', after midnight' : ''}.`));
      if (row.orig.clockGap) out.push(notice(`${timeLabel(row.time)} doesn't happen that night (the clocks go forward): it starts at ${clock(row.orig.startAt, timezone)} instead.`, 'warn'));
      if (row.orig.clockOverlap) out.push(notice(`${timeLabel(row.time)} happens twice that night (the clocks go back): it means the first one.`, 'warn'));
    } else {
      out.push(h('span', nextDay ? `After midnight: plays on ${dateLabel(addDays(date, 1))}.` : `Plays on ${dateLabel(date)}.`));
    }
    return out;
  }

  function move(i, by, focusKey) {
    const j = i + by;
    if (j < 0 || j >= rows.length) return;
    [rows[i], rows[j]] = [rows[j], rows[i]];
    draw();
    onChange();
    list.querySelector(`[data-key="${focusKey}-${j}"]`)?.focus();
  }

  function rowEl(row, i) {
    const whenEl = h('div.small.muted');
    const update = () => mount(whenEl, when(row));
    const label = () => row.name || `act ${i + 1}`;
    const legend = h('legend');
    let tools = null;
    // The row's heading and its buttons' names follow the act as it is typed.
    const relabel = () => {
      legend.textContent = `${i + 1}. ${row.name || 'New act'}`;
      if (!tools) return;
      tools.querySelector('[data-key^="up-"]').setAttribute('aria-label', `Move ${label()} up`);
      tools.querySelector('[data-key^="down-"]').setAttribute('aria-label', `Move ${label()} down`);
      tools.querySelector('summary').setAttribute('aria-label', `More for ${label()}`);
    };
    const time = h('input', { type: 'time', value: row.time, required: true, disabled, oninput: (e) => { row.time = e.target.value; update(); onChange(); } });
    const name = h('input', { type: 'text', value: row.name, maxlength: 80, required: true, autocomplete: 'off', list: names.id, disabled, oninput: (e) => { row.name = e.target.value; relabel(); onChange(); } });
    const b2b = h('input', { type: 'text', value: row.b2b || '', maxlength: 80, autocomplete: 'off', list: names.id, disabled, oninput: (e) => { row.b2b = e.target.value; onChange(); } });
    const logoOptions = [{ value: '', label: 'No logo (the name shows)' }, ...images];
    const logo = choice(logoOptions, row.logo || '', { disabled });
    logo.addEventListener('change', () => { row.logo = logo.value; onChange(); });
    // A known act picked or typed: its logo too, where the row has none.
    name.addEventListener('change', () => {
      const known = logos.get(actKey(row.name));
      if (row.logo || !known) return;
      row.logo = known;
      logo.value = known;
      onChange();
    });
    update();
    tools = disabled ? null : h('div.row',
      h('button.btn.small', { type: 'button', disabled: i === 0, dataset: { key: `up-${i}` }, onclick: () => move(i, -1, 'up') }, '↑ Up'),
      h('button.btn.small', { type: 'button', disabled: i === rows.length - 1, dataset: { key: `down-${i}` }, onclick: () => move(i, 1, 'down') }, '↓ Down'),
      menu('More', [{
        label: 'Remove this act', danger: true, onSelect: () => { rows.splice(i, 1); draw(); onChange(); toast(`Removed ${label()} from the lineup. Save to keep it that way.`); },
      }], { buttonClass: 'btn small' }));
    relabel();
    return h('fieldset',
      legend,
      h('div.grid',
        field('Time', time),
        field('Act', name, { hint: acts.length ? 'Names from your lineups are offered as you type.' : undefined }),
        field('B2B with', b2b, { hint: 'Optional: who plays with them.' }),
        field('Logo', logo, { hint: images.length ? 'An image uploaded in Media. Without one, the name shows.' : 'Upload logos in Media to pick one here. Without one, the name shows.' })),
      h('div.stack',
        h('div.row',
          toggle('Headliner', row.headliner, { disabled, onChange: (on) => { row.headliner = on; onChange(); } }),
          toggle('Closer', row.closer, { disabled, onChange: (on) => { row.closer = on; onChange(); } })),
        whenEl,
        tools));
  }

  function draw() {
    if (!rows.length) {
      mount(list, empty('No acts yet', disabled ? 'The lineup is empty.' : 'Add the night\'s acts with their start times.'));
      return;
    }
    mount(list, rows.map(rowEl));
  }
  draw();

  return {
    el: h('div', names, list),
    draw,
    add() {
      rows.push({ time: '', name: '' });
      draw();
      onChange();
      const sets = list.querySelectorAll('fieldset');
      sets[sets.length - 1]?.querySelector('input')?.focus();
    },
    // In the order of the night: from the day boundary on, so 01:00 comes after 23:00.
    sort() {
      const b = night().boundary;
      const key = (r) => (TIME.test(r.time) ? (minutesOf(r.time) - minutesOf(b) + 1440) % 1440 : Infinity);
      rows.sort((x, y) => key(x) - key(y));
      draw();
      onChange();
    },
  };
}

// The show's fields the Details tab edits, for comparing what changed.
const detailsOf = (show) => JSON.stringify([show?.name, show?.date, show?.timezone, show?.dayBoundary, show?.goLive || null, [...(show?.overlays || [])].sort()]);

// Everything the page lists, read defensively: a list that fails to load is an empty one.
async function loadAll(path) {
  try { return await api.all(path); } catch (err) { console.warn(err); return []; }
}

// What the members' templates offer (scenes, actions, timed scenes played as graphics) and the
// uploaded media, for naming cues and offering choices.
async function loadCatalog(show, overlays, media) {
  const members = overlays.filter((o) => (show.overlays || []).includes(o.id) || (show.members || []).includes(o.slug));
  // Each member's template at the version it is pinned to (04 §4.10), once per version.
  const pins = new Map();
  for (const o of members) {
    const { id, version } = o.template || {};
    if (typeof id === 'string' && typeof version === 'string') pins.set(`${id}@${version}`, { id, version });
  }
  const manifests = (await Promise.all([...pins.values()].map((t) => api.get(`/api/v1/templates/${api.seg(t.id)}/versions/${api.seg(t.version)}`).then((v) => v?.manifest, () => undefined)))).filter(Boolean);
  const scenes = new Map();
  const actions = new Map();
  const text = (v, fallback) => (typeof v === 'string' && v ? v : fallback);
  for (const m of manifests) for (const a of Array.isArray(m.actions) ? m.actions : []) if (a?.id && !actions.has(a.id)) actions.set(a.id, text(a.label, a.id));
  for (const m of manifests) {
    for (const s of Array.isArray(m.scenes) ? m.scenes : []) {
      if (!s?.id) continue;
      if (!scenes.has(s.id)) scenes.set(s.id, text(s.label, s.id));
      // A timed scene (an intro that returns by itself) is played by a cue like an action (09 §9.5).
      if (s.durationMs && s.then && !actions.has(s.id)) actions.set(s.id, text(s.label, s.id));
    }
  }
  const ready = media.filter((m) => m?.status === 'ready');
  return {
    scenes: [...scenes].map(([value, label]) => ({ value, label })),
    actions: [...actions].map(([value, label]) => ({ value, label })),
    clips: ready.filter((m) => m.kind === 'video' || m.kind === 'audio').map((m) => ({ value: m.id, label: m.name || m.id })),
    images: ready.filter((m) => m.kind === 'image').map((m) => ({ value: m.url, label: m.name || m.url })),
    sceneLabel: (id) => scenes.get(id) || id,
    actionLabel: (id) => actions.get(id) || id,
    mediaName: (id) => media.find((m) => m.id === id)?.name || 'a clip that is no longer uploaded',
  };
}

// v0's DJ cue (09 §9.3): an act put on, then its card, at one instant, as one cue: a sequence of
// the act's show.slot and its title card or now-playing. { slot, card }, or undefined.
function actPair(a) {
  const steps = a?.type === 'sequence' && Array.isArray(a.steps) && a.steps.length === 2 ? a.steps : undefined;
  if (!steps || steps.some((s) => s?.offsetMs !== 0)) return undefined;
  const [on, card] = steps.map((s) => s.action);
  if (on?.type !== 'show.slot' || typeof on.slot !== 'string' || card?.type !== 'overlay.action' || !ACT_CARDS.includes(card.name) || card.args?.name !== on.slot) return undefined;
  return { slot: on.slot, card };
}

// A cue's action in plain words.
function actionWords(a, cat, show) {
  switch (a?.type) {
    case 'show.scene': return `Change the scene to ${cat?.sceneLabel(a.scene) ?? a.scene}`;
    case 'overlay.action': return `${cat?.actionLabel(a.name) ?? a.name}${a.args?.name ? ` (${a.args.name})` : ''}`;
    case 'show.slot': return `Who's on: ${typeof a.slot === 'number' ? show?.lineup?.[a.slot]?.name ?? `act ${a.slot + 1}` : a.slot}`;
    case 'media.play': return `Play ${cat?.mediaName(a.mediaId) ?? 'a clip'}`;
    case 'media.stop': return a.mediaId ? `Stop ${cat?.mediaName(a.mediaId) ?? 'the clip'}` : 'Stop the clip';
    case 'sequence': {
      const pair = actPair(a);
      if (pair) return `${pair.slot} on, then ${cat?.actionLabel(pair.card.name) ?? pair.card.name}`;
      const steps = Array.isArray(a.steps) ? a.steps : [];
      return `${plural(steps.length, 'step')}: ${steps.map((s) => actionWords(s?.action, cat, show)).join(', then ')}`;
    }
    case 'connector.action': return 'A connection\'s action';
    case 'webhook': return 'Call a webhook';
    default: return a?.type ? String(a.type) : 'Does nothing';
  }
}

function recipeWords(r) {
  if (!r) return 'Not built from the lineup.';
  const parts = [];
  if (r.titleCard) parts.push('a title card when each act starts');
  if (r.headliner) parts.push('the headliner intro for the headliner');
  if (r.introOffsetMin) parts.push(`the Event Intro ${r.introOffsetMin} min in`);
  if (r.nowPlayingEveryMin) parts.push(`now playing every ${r.nowPlayingEveryMin} min`);
  return `Built from the lineup: who's on${parts.length ? `, ${andList(parts)}` : ''}. Changing the lineup updates these cues by itself.`;
}

// ---- the list --------------------------------------------------------------------------------
export async function list(view, ctx) {
  ctx.setTitle('Shows');
  const canWrite = ctx.can('timeline:write');
  const body = h('div');
  let free = []; // the overlays in no show that read one, as last drawn: New show picks the one
  const newButton = canWrite ? h('button.btn.primary', { type: 'button', onclick: () => run(newButton, () => newShow(ctx, { loose: free })) }, 'New show') : null;
  mount(view, pageHead('Shows', { actions: newButton ? [newButton] : [] }), body);

  let last;
  // Overlays in no show whose template reads a show (set times, the countdown, who's on: 02 §2.5)
  // get none of it: said here, where that is put right. A chat or alerts overlay needs no show.
  const manifests = new Map(); // "id@version" → its manifest, or null
  const pin = (o) => `${o.template?.id}@${o.template?.version}`;
  async function readManifests(overlays) {
    const wanted = [...new Set(overlays.filter((o) => o?.template?.id && !manifests.has(pin(o))).map(pin))];
    await Promise.all(wanted.map(async (key) => {
      const o = overlays.find((x) => pin(x) === key);
      const v = await api.get(`/api/v1/templates/${api.seg(o.template.id)}/versions/${api.seg(o.template.version)}`).catch(() => undefined);
      manifests.set(key, v?.manifest || null);
    }));
  }
  const loose = (overlays) => overlays.filter((o) => o?.slug && !o.show && readsShow(manifests.get(pin(o)))).map((o) => o.slug);
  const draw = (shows, overlays) => {
    free = loose(overlays);
    const make = (slug) => h('button.btn', { type: 'button', onclick: (e) => run(e.currentTarget, () => newShow(ctx, { overlay: slug })) }, `New show with ${slug}`);
    const one = free.length === 1;
    // Said with no show yet too: the first night is where it matters most.
    const looseNote = free.length ? notice([
      `${andList(free)} ${one ? 'is' : 'are'} in no show, so ${one ? 'it shows' : 'they show'} no set times, countdown or who's on. `,
      canWrite ? (shows.length ? `Add ${one ? 'it' : 'them'} to a show under its Details, or make a new show.` : `Make a show with ${one ? 'it' : 'them'}.`) : 'An operator adds overlays to a show under its Details.',
      canWrite && one ? h('div.row', make(free[0])) : null,
    ], 'warn') : null;
    if (!shows.length) {
      mount(body, looseNote, empty('No shows yet',
        'A show is a night: the overlays that change together (like a horizontal and a vertical feed), its lineup with the set times, the countdown to going live, and a timeline that runs by itself. An overlay shows none of these until it is in a show.',
        canWrite ? h('button.btn.primary', { type: 'button', onclick: (e) => run(e.currentTarget, () => newShow(ctx, { loose: free })) }, 'New show') : null));
      return;
    }
    const sorted = [...shows].sort((a, b) => (b.live === true) - (a.live === true) || String(b.date).localeCompare(String(a.date)) || String(a.name).localeCompare(String(b.name)));
    mount(body, looseNote, h('div.grid', sorted.map((s) => showCard(s))));
  };
  const refresh = async () => {
    const [shows, overlays] = await Promise.all([api.all('/api/v1/shows'), loadAll('/api/v1/overlays')]);
    await readManifests(overlays);
    const key = JSON.stringify([shows, loose(overlays)]);
    if (key === last) return;
    last = key;
    draw(shows, overlays);
  };
  await refresh();
  // Live badges stay current while the page is open.
  let first = true;
  const stop = every(15000, () => {
    if (first) { first = false; return undefined; }
    return refresh();
  });
  return () => stop();
}

function showCard(s) {
  const href = `#/shows/${api.seg(s.id)}`;
  const members = Array.isArray(s.members) ? s.members : [];
  const acts = Array.isArray(s.lineup) ? s.lineup.length : 0;
  return h('div.card.stack',
    h('div.card-head',
      statusDot(s.live ? 'ok' : undefined, s.live ? 'Live' : 'Not live'),
      h('h2', h('a', { href }, s.name || 'Untitled show')),
      h('div.actions', s.live ? badge('Live now', 'ok') : badge('Not live'))),
    h('p',
      h('strong', dateLabel(s.date)),
      s.goLiveAt ? ` · goes live ${clock(s.goLiveAt, s.timezone)}${zoneNote(s.timezone)}` : ' · no go-live time',
      h('br'),
      h('span.small.muted', `${plural(acts, 'act')} in the lineup`)),
    members.length
      ? h('div.chips', { 'aria-label': 'Overlays in this show' }, members.map((m) => h('span.chip', m)))
      : h('p.small.muted', 'No overlays yet.'),
    h('div.row', h('a.btn', { href }, 'Open')));
}

// opts.overlay: an overlay's slug to pick; without it, the one overlay in no show whose template
// reads a show (opts.loose: their slugs, as the list has them), if there is just one: a chat or a
// viewer count in no show needs none.
async function newShow(ctx, { overlay, loose = [] } = {}) {
  const overlays = await loadAll('/api/v1/overlays');
  const zone = browserZone();
  const free = overlays.filter((o) => o?.slug && !o.show && loose.includes(o.slug));
  const picked = overlays.find((o) => o?.slug === overlay && !o.show) || (free.length === 1 ? free[0] : undefined);
  const name = h('input', { type: 'text', maxlength: 80, required: true, autocomplete: 'off', placeholder: 'Saturday TAKEOVER' });
  const date = h('input', { type: 'date', value: showDayNow(zone), required: true });
  const tz = zoneInput(zone);
  const goLive = h('input', { type: 'time' });
  const picker = overlayPicker(overlays, { members: picked ? [picked.id] : [] });
  const dateEl = dateField('Date', date, { hint: 'The night of the show. Acts after midnight still belong to this date.', zone: () => tz.value.trim() || zone, weekdays: [5, 6] });
  tz.addEventListener('change', () => dateEl.refresh());
  const body = h('div',
    field('Name', name, { hint: 'What you call the night.' }),
    dateEl,
    field('Time zone', tz, { hint: 'Where the show happens. Its times are in this zone, wherever your phone is.' }),
    field('Goes live at', goLive, { hint: 'When the countdown ends and the show goes on air. Optional.' }),
    picker.el);
  const created = await formDialog({
    title: 'New show',
    body,
    submitLabel: 'Create show',
    focus: name,
    submit: () => {
      if (!name.value.trim()) fail('Give the show a name.');
      if (!DATE.test(date.value)) fail('Pick the date of the show.');
      if (!tz.value.trim()) fail('Pick the time zone.');
      if (goLive.value && !TIME.test(goLive.value)) fail('Set the go-live time as hours and minutes, like 22:30.');
      return api.post('/api/v1/shows', {
        name: name.value.trim(),
        overlays: picker.values(),
        date: date.value,
        timezone: tz.value.trim(),
        ...(goLive.value ? { goLive: goLive.value } : {}),
      });
    },
  });
  if (!created?.id) return;
  // Next: the acts and their set times.
  toast(`Created the show "${created.name}". Next: its lineup.`);
  ctx.navigate(`/shows/${api.seg(created.id)}?tab=lineup`);
}

// ---- one show --------------------------------------------------------------------------------
function missing(view, ref) {
  mount(view,
    pageHead('Show', { crumbs: [{ label: 'Shows', href: '#/shows' }] }),
    empty(`There is no show "${ref}"`, 'It may have been deleted or renamed.', h('a.btn.primary', { href: '#/shows' }, 'All shows')));
}

export async function detail(view, ctx) {
  const ref = ctx.params.id;
  let show;
  try {
    show = await api.get(`/api/v1/shows/${api.seg(ref)}`);
  } catch (err) {
    if (err.status === 404) {
      ctx.setTitle('Show');
      missing(view, ref);
      return undefined;
    }
    throw err;
  }
  ctx.setTitle(show.name);
  const canWrite = ctx.can('timeline:write');
  const canControl = ctx.can('overlays:control');
  const base = () => `/api/v1/shows/${api.seg(show.id)}`;
  const tz = () => show.timezone;
  let readAt = Date.now();
  let gone = false;
  let tabsEl; // the tabs, and the poll of the head: set at the end
  let stop;
  // Set by the open tab as it draws: reshow() draws it again for the show as it is now, keeping
  // what is being edited (else it is drawn afresh); unsaved() says what a tab change would lose
  // ('' when nothing), which is asked about first.
  let reshow;
  let unsaved;
  let leaving = false; // a tab change already agreed to (or one that loses nothing)
  function reopen() {
    leaving = true;
    try { tabsEl?.querySelector('[role=tab][aria-selected="true"]')?.click(); } finally { leaving = false; }
  }
  const redrawTab = () => (reshow ? reshow() : reopen());

  // The show as the server has it now (forms keep the copy they were made from, for If-Match).
  async function fresh(force = false) {
    if (force || Date.now() - readAt > 3000) {
      show = await api.get(base());
      readAt = Date.now();
      drawHead();
    }
    return show;
  }

  // ---- the head: name, whether it is live, Open in Live, and Delete in a menu ----
  const head = h('div');
  let headKey;
  function drawHead() {
    const members = Array.isArray(show.members) ? show.members : [];
    const acts = Array.isArray(show.lineup) ? show.lineup.length : 0;
    // A night that has passed (and isn't on air past its day): the countdown and set times are
    // that night's, which a weekly show left as it was shows without a word.
    const tonight = showDayNow(tz(), show.dayBoundary);
    const passed = !show.live && DATE.test(show.date || '') && show.date < tonight;
    // Redrawn only when what it shows changed, and never under its open menu.
    const key = JSON.stringify([show.name, show.live, show.date, show.goLiveAt, show.timezone, members, acts, passed && tonight]);
    if (key === headKey || head.querySelector('details.menu[open]')) return;
    headKey = key;
    ctx.setTitle(show.name);
    const more = canWrite ? menu('More', [{ label: 'Delete show', danger: true, onSelect: deleteShow }]) : null;
    mount(head,
      pageHead(show.name, {
        crumbs: [{ label: 'Shows', href: '#/shows' }],
        actions: [h('a.btn', { href: `#/live?show=${encodeURIComponent(show.id)}` }, 'Open in Live'), more].filter(Boolean),
      }),
      h('p.row',
        show.live ? badge('Live now', 'ok') : badge('Not live'),
        h('span', dateLabel(show.date, true)),
        h('span.muted', show.goLiveAt ? `goes live ${clock(show.goLiveAt, tz())}${zoneNote(tz())}` : 'no go-live time'),
        h('span.muted', `· ${plural(acts, 'act')}`)),
      members.length
        ? h('div.chips', { 'aria-label': 'Overlays in this show' }, members.map((m) => h('a.chip', { href: `#/overlays/${api.seg(m)}` }, m)))
        : notice('This show has no overlays yet: pick them under Details, so its scenes, lineup and timeline reach the stream.', 'warn'),
      passed ? passedNotice(tonight) : null);
  }

  // The show's night has passed: one tap moves it to its next night on the same weekday (an edit,
  // with If-Match); plans do it by themselves.
  function passedNotice(tonight) {
    const next = onWeekday(tonight, show.date);
    const move = canWrite ? h('button.btn.small', { type: 'button', onclick: (e) => run(e.currentTarget, () => moveTo(next)) }, `Move it to ${dateLabel(next)}`) : null;
    return notice([
      `Its night, ${dateLabel(show.date, true)}, has passed: the countdown and set times are still that night's. `,
      canWrite ? `Move it to its next ${weekdayName(show.date)}, or plan the coming nights under Plans.` : 'An operator moves it to its next night under Details.',
      move ? h('div.row', move) : null,
    ], 'warn');
  }
  async function moveTo(date) {
    try {
      show = await api.patch(base(), { date }, { ifMatch: show });
    } catch (err) {
      if (err.status === 404) { showGone({ changing: true }); return; }
      if (err.status !== 412) throw err;
      await fresh(true);
      toast('The show changed since you opened it: this is the latest. Move it again if you still want to.', { kind: 'error', ms: 10000 });
      redrawTab();
      return;
    }
    readAt = Date.now();
    toast(`"${show.name}" is on ${dateLabel(date, true)} now: its set times and cues moved with it.`);
    drawHead();
    // The tab open shows the new night (its forms are made from the show as read), with what is
    // being edited kept.
    redrawTab();
  }

  // Deleted elsewhere (a change found it gone, or a read did): say so in the page, not with the
  // server's words about an id, and stop what the page runs. A change that was refused says so too.
  function showGone({ changing = false } = {}) {
    if (gone) return;
    gone = true;
    stop?.();
    tabsEl?.destroy();
    if (changing) toast(`"${show.name}" was deleted meanwhile (someone else, or another tab): nothing was saved.`, { kind: 'error' });
    missing(view, show.name);
  }

  async function deleteShow() {
    const ok = await confirm({
      title: `Delete "${show.name}"?`,
      consequence: `Its timeline and planned dates are deleted with it. Its overlays stay, with their URLs and settings, and are no longer in a show${show.live ? ': the show is live now, and its overlays stop changing together' : ''}.`,
      confirmLabel: 'Delete show',
    });
    if (!ok) return;
    try {
      // As it was read (H16): a show edited meanwhile is looked at again before it goes.
      await api.del(base(), { ifMatch: show });
      toast(`Deleted the show "${show.name}"`);
      ctx.navigate('/shows');
    } catch (err) {
      if (err.status === 404) { toast(`"${show.name}" was already deleted.`); ctx.navigate('/shows'); return; }
      if (err.status !== 412) { toast(err); return; }
      await fresh(true).catch(() => {});
      toast('The show changed since you opened it: this is the latest. Delete it again if you still want to.', { kind: 'error', ms: 10000 });
    }
  }

  // ---- Details -------------------------------------------------------------------------------
  let health; // { list, error }: the connections "Fed by" offers (operators read them here)
  function detailsTab(panel) {
    let alive = true;
    mount(panel, h('p.loading', 'Loading…'));
    Promise.all([fresh(), loadAll('/api/v1/overlays'), api.get('/api/v1/system/health').then((r) => ({ list: Array.isArray(r?.connections) ? r.connections : [] }), (error) => ({ list: [], error }))]).then(([, overlays, h2]) => {
      health = h2;
      if (alive) drawDetails(panel, overlays);
    }).catch((err) => {
      if (!alive) return;
      if (err.status === 404) showGone();
      else mount(panel, notice(err.message, 'danger'));
    });
    return () => { alive = false; reshow = undefined; unsaved = undefined; };
  }

  function drawDetails(panel, overlays, kept) {
    const formShow = show;
    const disabled = !canWrite;
    const v = kept || {};
    const name = h('input', { type: 'text', value: v.name ?? formShow.name, maxlength: 80, required: true, autocomplete: 'off', disabled });
    const date = h('input', { type: 'date', value: v.date ?? formShow.date, required: true, disabled });
    const zone = zoneInput(v.timezone ?? formShow.timezone, { disabled });
    const boundary = h('input', { type: 'time', value: v.dayBoundary ?? (formShow.dayBoundary || '12:00'), required: true, disabled });
    const goLive = h('input', { type: 'time', value: v.goLive ?? (formShow.goLive || ''), disabled });
    // The overlays: those that failed to load are the show's own, by name.
    const known = overlays.length ? overlays : (formShow.members || []).map((slug) => ({ slug, show: formShow.name }));
    const serverMembers = [...(formShow.overlays || []), ...(formShow.members || [])];
    const initialMembers = known.filter((o) => serverMembers.includes(o.id) || serverMembers.includes(o.slug)).map(overlayRef);
    const picker = overlayPicker(known, { members: v.overlays || serverMembers, showName: formShow.name, disabled }); // kept: ids, as values() gives them
    const b = formShow.dayBoundary || '12:00';
    // The quick dates follow the zone and the day boundary as this form has them.
    const dateEl = dateField('Date', date, { hint: 'The night of the show. Acts after midnight still belong to it.', zone: () => zone.value.trim() || formShow.timezone, boundary: () => (TIME.test(boundary.value) ? boundary.value : b) });
    zone.addEventListener('change', () => dateEl.refresh());
    boundary.addEventListener('input', () => dateEl.refresh());
    const save = h('button.btn.primary', { type: 'button' }, 'Save details');
    // What the form has, and what the show it was made from has: different is unsaved.
    const values = () => ({ name: name.value, date: date.value, timezone: zone.value, dayBoundary: boundary.value, goLive: goLive.value, overlays: [...picker.values()].sort() });
    const saved = JSON.stringify({ name: formShow.name, date: formShow.date, timezone: formShow.timezone, dayBoundary: b, goLive: formShow.goLive || '', overlays: [...initialMembers].sort() });
    unsaved = () => (!disabled && JSON.stringify(values()) !== saved ? 'Your changes to the details are lost; the show stays as it was saved.' : '');
    // The show moved to another night (or changed elsewhere): edits made on details that are as
    // they were, the date aside, stay (on the new date, unless it was changed here); otherwise
    // the form stays as it is, and saving says what changed (H16).
    reshow = () => {
      if (!unsaved()) { drawDetails(panel, overlays); return; }
      if (detailsOf({ ...show, date: formShow.date }) !== detailsOf(formShow)) return;
      const { date: d, ...rest } = values();
      drawDetails(panel, overlays, { ...rest, overlays: picker.values(), ...(d !== formShow.date ? { date: d } : {}) });
    };

    save.addEventListener('click', () => run(save, async () => {
      const patch = {};
      const n = name.value.trim();
      if (!n) fail('Give the show a name.');
      if (!DATE.test(date.value)) fail('Pick the date of the show.');
      if (!zone.value.trim()) fail('Pick the time zone.');
      if (!TIME.test(boundary.value)) fail('Set the day boundary as hours and minutes, like 12:00.');
      if (goLive.value && !TIME.test(goLive.value)) fail('Set the go-live time as hours and minutes, like 22:30, or leave it empty.');
      if (n !== formShow.name) patch.name = n;
      if (date.value !== formShow.date) patch.date = date.value;
      if (zone.value.trim() !== formShow.timezone) patch.timezone = zone.value.trim();
      if (boundary.value !== formShow.dayBoundary) patch.dayBoundary = boundary.value;
      if ((goLive.value || null) !== (formShow.goLive || null)) patch.goLive = goLive.value || null;
      const members = picker.values();
      if ([...members].sort().join('\n') !== [...initialMembers].sort().join('\n')) patch.overlays = members;
      if (!Object.keys(patch).length) {
        toast('Nothing to save: nothing changed.');
        return;
      }
      try {
        show = await api.patch(base(), patch, { ifMatch: formShow });
      } catch (err) {
        if (err.status === 404) { showGone({ changing: true }); return; }
        if (err.status !== 412) throw err;
        // Edited meanwhile (H16; live control doesn't count): re-read it. If what this form edits
        // is as it was, the edit was elsewhere (the lineup tab, another user's members): the edits
        // stay here to save again. Otherwise the form shows the latest, to redo the change on.
        const before = detailsOf(formShow);
        await fresh(true);
        const same = detailsOf(show) === before;
        toast(same
          ? 'The show was edited since you opened it, but not these details. Your changes are still here: save again.'
          : 'These details changed since you opened them: this is the latest. Make your change again.', { kind: 'error', ms: 10000 });
        drawDetails(panel, overlays, same ? { name: name.value, date: date.value, timezone: zone.value, dayBoundary: boundary.value, goLive: goLive.value, overlays: picker.values() } : undefined);
        return;
      }
      readAt = Date.now();
      const words = { name: 'name', date: 'date', timezone: 'time zone', dayBoundary: 'day boundary', goLive: 'go-live time', overlays: 'overlays' };
      toast(`Saved the show's ${andList(Object.keys(patch).map((k) => words[k]))}.`);
      drawHead();
      drawDetails(panel, await loadAll('/api/v1/overlays'));
    }));

    const fedBox = h('div');
    drawFedBy(fedBox, overlays);
    const followBox = h('div');
    drawFollow(followBox, overlays);
    mount(panel, h('div.stack', h('div.card',
      h('h2', 'Details'),
      disabled ? notice('You can look at this show; changing it needs an operator or a higher role.') : null,
      h('div.grid',
        field('Name', name),
        dateEl,
        field('Time zone', zone, { hint: 'Where the show happens. Every time of the show is in this zone, wherever your phone is.' }),
        field('Day boundary', boundary, { hint: `When the show's day starts. ${boundaryWords(b, formShow.date)} An afternoon show sets it earlier, like ${timeLabel('06:00')}.` }),
        field('Goes live at', goLive, { hint: formShow.goLiveAt ? `When the countdown ends: ${instantLabel(formShow.goLiveAt, formShow.timezone)}${zoneNote(formShow.timezone)}. Leave empty for no go-live time.` : 'When the countdown ends and the show goes on air. Leave empty for no go-live time.' })),
      picker.el,
      canWrite ? h('div.form-actions', save) : null), fedBox, followBox));
  }

  // ---- Follow OBS (09 §9.7): OBS scene → the show's scene, saved with the show's If-Match ----
  async function drawFollow(box, overlays) {
    mount(box, h('section.card', h('h2', 'Follow OBS'), h('p.loading', 'Loading…')));
    let cat;
    try { cat = await loadCatalog(show, overlays, []); } catch (err) { mount(box, h('section.card', h('h2', 'Follow OBS'), notice(err.message, 'danger'))); return; }
    const reload = async () => {
      try { await fresh(true); } catch (err) { if (err.status === 404) { showGone(); return; } toast(err); return; }
      drawFollow(box, await loadAll('/api/v1/overlays'));
    };
    mount(box, (show.overlays || []).length
      ? followObsCard({ resource: show, path: base(), scenes: cat.scenes, what: 'show', canWrite, reload })
      : h('section.card', h('h2', 'Follow OBS'), h('p.muted', 'Pick the show\'s overlays first: then map OBS scenes to their scenes here.')));
  }

  // ---- Fed by: the connections every overlay of the show shows -------------------------------
  // A convenience over each overlay's own "Fed by": the same choice for all of them, one PATCH per
  // overlay with that overlay's If-Match (H16). Some may fail (one changed meanwhile): what was
  // saved and what wasn't is said overlay by overlay, and the card shows them as they are now.
  function drawFedBy(box, overlays, outcome) {
    const ids = new Set(show.overlays || []);
    const members = overlays.filter((o) => o && ids.has(o.id));
    const canBind = ctx.can('overlays:write');
    const bindingOf = (o) => (o.connections === 'all' || !Array.isArray(o.connections) ? 'all' : [...o.connections].sort());
    const parts = [h('h2', 'Fed by')];
    if (outcome) parts.push(outcome);
    if (!members.length) {
      parts.push(h('p.muted', 'Pick the show\'s overlays first: then choose here which connections feed all of them.'));
      mount(box, h('section.card.stack', parts));
      return;
    }
    const first = JSON.stringify(bindingOf(members[0]));
    const same = members.every((o) => JSON.stringify(bindingOf(o)) === first);
    parts.push(same
      ? h('p', `Every overlay in the show: ${fedByWords(bindingOf(members[0]), members[0].bound)}`)
      : h('div', h('p', 'Its overlays are fed differently now:'), h('ul', members.map((o) => h('li', `${o.slug}: ${fedByWords(bindingOf(o), o.bound)}`)))));
    if (health?.error) parts.push(notice(`The connections could not be read: ${health.error.message}`, 'warn'));
    if (!canBind) {
      parts.push(h('p.muted', 'Your role can\'t change what feeds the overlays.'));
      mount(box, h('section.card.stack', parts));
      return;
    }
    const apply = h('button.btn.primary', { type: 'button', disabled: same, onclick: () => saveAll() }, 'Apply to every overlay');
    const form = fedByForm({ connections: health?.list, value: same ? bindingOf(members[0]) : [], legend: 'Connections every overlay in the show shows', onChange: () => { apply.disabled = same && !form.changed(); } });
    async function saveAll() {
      const target = form.value();
      const want = JSON.stringify(target === 'all' ? 'all' : [...target].sort());
      await run(apply, async () => {
        const saved = [];
        const refused = [];
        for (const o of members) {
          if (JSON.stringify(bindingOf(o)) === want) continue;
          try {
            await api.patch(`/api/v1/overlays/${api.seg(o.id)}`, { connections: target }, { ifMatch: o });
            saved.push(o.slug);
          } catch (err) {
            refused.push({ slug: o.slug, why: err.status === 412 ? 'it changed since you opened this page' : err.status === 404 ? 'it was deleted meanwhile' : err.message });
          }
        }
        const latest = await loadAll('/api/v1/overlays');
        let note;
        if (refused.length) {
          note = notice([
            saved.length ? `Saved for ${andList(saved)}. ` : 'Nothing was saved. ',
            `Not saved for ${refused.map((r) => `${r.slug} (${r.why})`).join(', ')}. This is how they are now: choose again and apply.`,
          ], 'danger');
          toast(`Not every overlay was changed: ${refused.map((r) => r.slug).join(', ')} ${refused.length === 1 ? 'was' : 'were'} not.`, { kind: 'error', ms: 10000 });
        } else {
          toast(saved.length ? `Every overlay in "${show.name}" is fed by ${target === 'all' ? 'every connection' : target.length ? target.map((entry) => bindingName(health?.list, entry)).join(', ') : 'no connection'} now.` : 'Nothing to save: every overlay is fed so already.');
        }
        drawFedBy(box, latest, note);
      });
    }
    parts.push(h('p.small.muted', 'This changes each overlay of the show; an overlay\'s own page shows and changes it too.'), form.el, h('div.form-actions', apply));
    mount(box, h('section.card.stack', parts));
  }

  // ---- Lineup --------------------------------------------------------------------------------
  function lineupTab(panel) {
    let alive = true;
    mount(panel, h('p.loading', 'Loading…'));
    Promise.all([fresh(), loadAll('/api/v1/media'), loadAll('/api/v1/acts')]).then(([, media, acts]) => {
      if (!alive) return;
      drawLineup(panel, imagesOf(media), acts);
    }).catch((err) => {
      if (!alive) return;
      if (err.status === 404) showGone();
      else mount(panel, notice(err.message, 'danger'));
    });
    return () => { alive = false; reshow = undefined; unsaved = undefined; };
  }

  function drawLineup(panel, images, acts, keptRows) {
    const formShow = show;
    const disabled = !canWrite;
    const saved = Array.isArray(formShow.lineup) ? formShow.lineup : [];
    const rows = keptRows || saved.map((s) => ({ ...cleanSlot(s), orig: s }));
    const b = formShow.dayBoundary || '12:00';
    const original = JSON.stringify(lineupOf(formShow));
    const status = h('span.small.muted', { 'aria-live': 'polite' });
    const dirty = () => JSON.stringify(rows.map(cleanSlot)) !== original;
    const touched = () => {
      const changed = dirty();
      status.textContent = changed ? 'Unsaved changes' : '';
      undo.disabled = !changed;
    };
    unsaved = () => (dirty() ? 'Your changes to the lineup are lost; it stays as it was saved.' : '');
    // The show moved to another night (or changed elsewhere): edits made on the lineup as it still
    // is stay, on the show as it is now (its If-Match too), each act with the instant it starts on
    // the new night; otherwise the form stays as it is, and saving says what changed (H16).
    reshow = () => {
      if (!dirty()) drawLineup(panel, images, acts);
      else if (JSON.stringify(lineupOf(show)) === original) {
        const now = Array.isArray(show.lineup) ? show.lineup : [];
        drawLineup(panel, images, acts, rows.map((r) => ({ ...r, orig: r.orig && now.find((s) => s.time === r.orig.time && s.name === r.orig.name) })));
      }
    };
    const editor = lineupEditor({ rows, night: () => ({ date: formShow.date, boundary: b, timezone: formShow.timezone }), images, acts, disabled, onChange: () => touched() });
    const add = h('button.btn', { type: 'button', onclick: () => editor.add() }, 'Add an act');
    const sort = h('button.btn', { type: 'button', onclick: () => editor.sort() }, 'Sort by time');
    const undo = h('button.btn.ghost', { type: 'button', onclick: () => drawLineup(panel, images, acts) }, 'Undo changes');
    const save = h('button.btn.primary', { type: 'button' }, 'Save lineup');
    save.addEventListener('click', () => run(save, async () => {
      const lineup = rows.map(cleanSlot);
      const bad = lineup.findIndex((s) => !TIME.test(s.time) || !s.name);
      if (bad >= 0) fail(`Act ${bad + 1} needs a start time and a name.`);
      if (!dirty()) {
        toast('Nothing to save: the lineup is as it was.');
        return;
      }
      try {
        show = await api.patch(base(), { lineup }, { ifMatch: formShow });
      } catch (err) {
        if (err.status === 404) { showGone({ changing: true }); return; }
        if (err.status !== 412) throw err;
        // Edited meanwhile (H16; live control doesn't count): if the lineup itself is as it was,
        // the edit was elsewhere (the details), and the edits stay to save again; otherwise the
        // latest shows.
        await fresh(true);
        const same = JSON.stringify(lineupOf(show)) === original;
        toast(same
          ? 'The show was edited since you opened it, but not its lineup. Your changes are still here: save again.'
          : 'The lineup changed since you opened it: this is the latest. Make your change again.', { kind: 'error', ms: 10000 });
        drawLineup(panel, images, acts, same ? rows : undefined);
        return;
      }
      readAt = Date.now();
      const heads = lineup.filter((s) => s.headliner).length;
      toast(`Lineup saved: ${plural(lineup.length, 'act')}${show.recipe ? '; the timeline follows it' : ''}.${heads > 1 ? ' More than one act is the headliner: templates use the first.' : ''}`);
      drawHead();
      drawLineup(panel, images, await loadAll('/api/v1/acts'));
    }));

    mount(panel, h('div.card',
      h('div.card-head', h('h2', 'Lineup'), canWrite ? h('div.actions', sort) : null),
      notice(`${boundaryWords(b, formShow.date)} The day boundary is set in Details.`),
      h('p.small.muted', 'Headliner and closer are different things: the headliner is the billed act (the Starting Soon card and the headliner intro use it); the closer is whoever plays last. Flag each where it belongs, even when it\'s the same act.'),
      disabled ? notice('You can look at the lineup; changing it needs an operator or a higher role.') : null,
      editor.el,
      canWrite ? h('div.form-actions', status, undo, add, save) : null));
    touched();
  }

  // ---- Timeline ------------------------------------------------------------------------------
  let catalogKey;
  let catalogPromise;
  function catalog() {
    const key = JSON.stringify([show.overlays, show.members]);
    if (key !== catalogKey || !catalogPromise) {
      catalogKey = key;
      catalogPromise = Promise.all([loadAll('/api/v1/overlays'), loadAll('/api/v1/media')]).then(([o, m]) => loadCatalog(show, o, m)).catch((err) => {
        console.warn(err);
        catalogPromise = undefined;
        return loadCatalog(show, [], []);
      });
    }
    return catalogPromise;
  }

  function timelineTab(panel) {
    let alive = true;
    let lastKey;
    let cues = [];
    let cat;
    const listEl = h('div', h('p.loading', 'Loading…'));
    const recipeEl = h('p.small.muted');
    const actions = h('div.row');

    const busy = () => !!(panel.querySelector('details.menu[open]') || document.querySelector('dialog[open]'));
    async function load(force = false) {
      const [items, c] = await Promise.all([api.all(`${base()}/cues`), catalog()]);
      if (!alive) return;
      cat = c;
      const key = JSON.stringify(items);
      if (!force && (key === lastKey || busy())) return;
      lastKey = key;
      cues = items;
      draw();
    }
    const reload = () => load(true).catch((err) => toast(err));
    // The names and choices a dialog offers, if the first load hasn't brought them yet.
    const ready = async () => { if (!cat) cat = await catalog(); };

    function cueForm(cue) {
      const pair = actPair(cue?.action); // an act put on, then its card: edited as that card
      const a = pair ? pair.card : cue?.action;
      const fixed = a && !KINDS.some((k) => k.type === a.type); // a sequence (or a later kind): not edited here
      const initialAt = cue ? cue.time || hmIn(new Date(cue.at), tz()) : '';
      const b = show.dayBoundary || '12:00';
      const at = h('input', { type: 'time', value: initialAt, required: true });
      const kind = h('select', KINDS.map((k) => h('option', { value: k.type }, k.label)));
      kind.value = a && !fixed ? a.type : 'overlay.action';
      const graphic = choice(cat.actions, a?.type === 'overlay.action' ? a.name : undefined, { placeholder: 'titleCard' });
      // A title card or now-playing is about an act: one of the lineup, or whoever is on when it
      // fires; and it may put that act on as it shows (v0's DJ title card), as one cue.
      const lineupNames = [...new Set((Array.isArray(show.lineup) ? show.lineup : []).map((s) => s?.name).filter(Boolean))];
      const act = choice([{ value: '', label: 'Whoever is on then' }, ...lineupNames.map((n) => ({ value: n, label: n }))], a?.type === 'overlay.action' ? a.args?.name || '' : '');
      let putTouched = !!cue;
      const putOn = toggle('Put them on as it shows', !!pair, { onChange: () => { putTouched = true; } });
      const actField = field('Act', act, { hint: lineupNames.length ? 'The card shows this act. "Whoever is on then" follows who\'s on when it fires.' : 'The lineup is empty, so the card shows whoever is on. Add acts under Lineup to pick one.' });
      const putField = h('div.field', h('div.row', putOn), h('span.hint', 'Who\'s on changes to this act, then the card shows: like a set starting.'));
      const scene = choice(cat.scenes, a?.type === 'show.scene' ? a.scene : undefined, { placeholder: 'brb' });
      const transition = choice([{ value: 'fade', label: 'Fade' }, { value: 'cut', label: 'Cut' }], a?.type === 'show.scene' ? a.transition || 'fade' : 'fade');
      const acts = (Array.isArray(show.lineup) ? show.lineup : []).map((s) => s?.name).filter(Boolean);
      const actOptions = [...new Set(acts)].map((n) => ({ value: n, label: n }));
      if (a?.type === 'show.slot' && typeof a.slot === 'number') actOptions.push({ value: `#${a.slot}`, label: `${show.lineup?.[a.slot]?.name ?? 'The act'} (position ${a.slot + 1})` });
      const slot = choice(actOptions, a?.type === 'show.slot' ? (typeof a.slot === 'number' ? `#${a.slot}` : a.slot) : undefined, { placeholder: 'The act\'s name' });
      const clip = choice(cat.clips, a?.type === 'media.play' ? a.mediaId : undefined, { placeholder: 'med_…' });
      const stopClip = choice([{ value: '', label: 'Whatever is playing' }, ...cat.clips], a?.type === 'media.stop' ? a.mediaId || '' : '');
      const label = h('input', { type: 'text', value: cue?.label || '', maxlength: 120, autocomplete: 'off', placeholder: 'Headliner takeover' });
      const noMembers = !cat.scenes.length && !cat.actions.length;
      const groups = {
        'overlay.action': [field('Graphic', graphic, { hint: noMembers ? 'Add overlays to the show (Details) to pick from what their templates offer.' : 'What the show\'s templates offer. An intro takes over the screen, then returns to the show.' })],
        'show.scene': [field('Scene', scene, { hint: noMembers ? 'Add overlays to the show (Details) to pick from their scenes.' : undefined }), field('Transition', transition)],
        'show.slot': [field('Act', slot, { hint: actOptions.length ? 'The act stays the same if the lineup changes around it.' : 'The lineup is empty: add acts under Lineup first.' })],
        'media.play': [field('Clip', clip, { hint: cat.clips.length ? 'Plays on every overlay of the show.' : 'Upload a video or audio clip in Media first.' })],
        'media.stop': [field('Clip to stop', stopClip)],
      };
      const isCard = () => !fixed && kind.value === 'overlay.action' && ACT_CARDS.includes(graphic.value.trim());
      const sync = () => {
        for (const [type, els] of Object.entries(groups)) for (const el of els) el.hidden = fixed || kind.value !== type;
        // A new cue's title card puts its act on unless the operator says otherwise; a now-playing doesn't.
        if (!putTouched) putOn.input.checked = graphic.value.trim() === 'titleCard';
        actField.hidden = !isCard();
        putField.hidden = !isCard() || !act.value;
      };
      for (const el of [kind, graphic, act]) {
        el.addEventListener('change', sync);
        el.addEventListener('input', sync);
      }
      sync();
      const body = h('div',
        field('At', at, { hint: `A time of the show${zoneNote(tz())}. Times before ${timeLabel(b)} are the next day, after midnight.` }),
        fixed ? h('p', `It does: ${actionWords(a, cat, show)}. That can't be changed here; its time and name can.`) : field('It does', kind),
        groups['overlay.action'], actField, putField,
        Object.entries(groups).filter(([type]) => type !== 'overlay.action').flatMap(([, els]) => els),
        field('Name', label, { hint: 'Optional: how the cue shows in the list and on Live.' }));
      return {
        body,
        focus: at,
        initialAt,
        read() {
          const v = at.value.trim();
          if (!TIME.test(v)) fail('Set the time as hours and minutes, like 22:30.');
          let action;
          if (!fixed) {
            const type = kind.value;
            if (type === 'overlay.action') {
              const name = graphic.value.trim();
              if (!name) fail('Pick the graphic to show.');
              // The args the cue had for this graphic stay (they are its template's); a card's act is the form's.
              const args = a?.type === type && a.name === name && a.args ? { ...a.args } : {};
              const who = ACT_CARDS.includes(name) ? act.value : '';
              if (ACT_CARDS.includes(name)) {
                if (who !== args.name) delete args.b2b;
                delete args.name;
                if (who) args.name = who;
              }
              action = { type, name, ...(Object.keys(args).length ? { args } : {}) };
              if (who && putOn.input.checked) action = { type: 'sequence', steps: [{ offsetMs: 0, action: { type: 'show.slot', slot: who } }, { offsetMs: 0, action }] };
            } else if (type === 'show.scene') {
              if (!scene.value.trim()) fail('Pick the scene.');
              action = { type, scene: scene.value.trim(), transition: transition.value || 'fade' };
            } else if (type === 'show.slot') {
              const s = slot.value.trim();
              if (!s) fail('Pick the act.');
              action = { type, slot: s.startsWith('#') ? Number(s.slice(1)) : s };
            } else if (type === 'media.play') {
              if (!clip.value.trim()) fail('Pick the clip to play.');
              action = { type, mediaId: clip.value.trim() };
            } else {
              action = { type: 'media.stop', ...(stopClip.value ? { mediaId: stopClip.value } : {}) };
            }
          }
          return { at: v, action, label: label.value.trim() };
        },
      };
    }

    const lateNote = (cue) => (cue && Date.parse(cue.at) < api.serverNow() - GRACE_MS ? ' Its time has passed, so it won\'t fire by itself: use Fire now in its menu to show it.' : '');
    const nameOf = (cue) => cue.label || actionWords(cue.action, cat, show);

    async function addCue() {
      await ready();
      const form = cueForm();
      const cue = await formDialog({
        title: 'Add a cue',
        body: form.body,
        submitLabel: 'Add cue',
        focus: form.focus,
        submit: () => {
          const v = form.read();
          return api.post(`${base()}/cues`, { at: v.at, action: v.action, ...(v.label ? { label: v.label } : {}) });
        },
      });
      if (!cue?.id) return;
      toast(`Added "${nameOf(cue)}" at ${instantLabel(cue.at, tz())}.${lateNote(cue)}`, { ms: lateNote(cue) ? 9000 : undefined });
      reload();
    }

    async function editCue(cue) {
      await ready();
      const form = cueForm(cue);
      const out = await formDialog({
        title: 'Change the cue',
        body: form.body,
        submitLabel: 'Save cue',
        focus: form.focus,
        submit: () => {
          const v = form.read();
          const patch = {};
          if (v.at !== form.initialAt) patch.at = v.at;
          if (v.action && JSON.stringify(v.action) !== JSON.stringify(cue.action)) patch.action = v.action;
          if (v.label !== (cue.label || '')) patch.label = v.label;
          if (!Object.keys(patch).length) return { unchanged: true };
          return api.patch(`${base()}/cues/${api.seg(cue.id)}`, patch, { ifMatch: cue });
        },
        onError: (err, close) => {
          if (err?.status !== 412) return false;
          close();
          toast('This cue changed since you opened it (it may have fired): this is the latest. Make your change again.', { kind: 'error', ms: 10000 });
          reload();
          return true;
        },
      });
      if (!out) return;
      if (out.unchanged) { toast('Nothing to save: the cue is as it was.'); return; }
      toast(`Saved "${nameOf(out)}": ${instantLabel(out.at, tz())}.${lateNote(out)}`);
      reload();
    }

    async function deleteCue(cue) {
      const ok = await confirm({
        title: 'Delete this cue?',
        consequence: `"${nameOf(cue)}" at ${instantLabel(cue.at, tz())} won't fire.${cue.generated ? ' It was made from the lineup, and building again won\'t bring it back.' : ''}`,
        confirmLabel: 'Delete cue',
      });
      if (!ok) return;
      try {
        // As it was read (H16): a cue that fired or was changed meanwhile is looked at again first.
        await api.del(`${base()}/cues/${api.seg(cue.id)}`, { ifMatch: cue });
        toast(`Deleted the cue "${nameOf(cue)}"`);
      } catch (err) {
        if (err.status === 412) toast('This cue changed since you opened it (it may have fired): this is the latest. Delete it again if you still want to.', { kind: 'error', ms: 10000 });
        else if (err.status === 404) toast(`The cue "${nameOf(cue)}" was already deleted.`);
        else toast(err);
      }
      reload();
    }

    async function override(cue, op) {
      try {
        const out = await api.post(`${base()}/cues/${api.seg(cue.id)}/${op}`, {});
        const name = nameOf(cue);
        if (op === 'fire') {
          if (out?.error) toast(`Fired "${name}", but: ${out.error}`, { kind: 'error' });
          else toast(`Fired "${name}" now`);
        } else if (op === 'skip') toast(`Skipped "${name}": it won't fire.`);
        else toast(`"${name}" is armed again.${lateNote(cue)}`, { ms: lateNote(cue) ? 9000 : undefined });
      } catch (err) {
        toast(err);
      }
      reload();
    }

    async function build() {
      const r = { ...DEFAULT_RECIPE, ...(show.recipe || {}) };
      const titleCard = toggle('Title card as each act starts', r.titleCard);
      const headliner = toggle('Headliner intro', r.headliner);
      const intro = h('input', { type: 'number', min: 1, max: 240, step: 1, inputmode: 'numeric', value: r.introOffsetMin ?? '' });
      const nowPlaying = h('input', { type: 'number', min: 1, max: 240, step: 1, inputmode: 'numeric', value: r.nowPlayingEveryMin ?? '' });
      const acts = Array.isArray(show.lineup) ? show.lineup.length : 0;
      const minutes = (input, what) => {
        const v = input.value.trim();
        if (!v) return null;
        const n = Number(v);
        if (!Number.isInteger(n) || n < 1 || n > 240) fail(`${what}: whole minutes from 1 to 240, or empty for none.`);
        return n;
      };
      const body = h('div',
        h('p', `Makes cues from the lineup (${plural(acts, 'act')}): when each act starts, who's on, and what you pick below. Only what the overlays' templates offer is made.`),
        notice(show.recipe
          ? 'Cues it made before that are still to come are replaced. Cues you added or changed yourself stay as they are, one you deleted stays deleted, and nothing that already happened fires again.'
          : 'It adds to the cues already here; cues you added yourself stay as they are. From now on, changing the lineup updates these cues by itself.'),
        acts ? null : notice('The lineup is empty, so no cues are made yet: they come as you add acts.', 'warn'),
        // A night that has passed (a weekly show left on last week's date): nothing would be made.
        acts && show.lineup.every((s) => Date.parse(s?.startAt) < api.serverNow())
          ? notice(`Every act's time has passed (the show is on ${dateLabel(show.date, true)}), so no cue is made for them. Move the show to its next night under Details first, or build now: its cues follow when the date changes.`, 'warn') : null,
        h('div.field', h('div.row', titleCard, headliner), h('span.hint', 'The headliner gets its intro in place of the title card, which would cover it.')),
        h('div.grid',
          field('Event Intro, minutes into each set', intro, { hint: 'Empty for none.' }),
          field('Now playing, every … minutes', nowPlaying, { hint: 'Until the next act. Empty for none.' })),
        h('p.small.muted', 'After changing an overlay\'s template, build again, so the timeline uses what the new one offers.'));
      const out = await formDialog({
        title: 'Build the timeline from the lineup',
        body,
        submitLabel: show.recipe ? 'Build again' : 'Build timeline',
        submit: () => api.post(`${base()}/cues/build`, { recipe: {
          titleCard: titleCard.input.checked,
          headliner: headliner.input.checked,
          introOffsetMin: minutes(intro, 'Event Intro'),
          nowPlayingEveryMin: minutes(nowPlaying, 'Now playing'),
        } }),
      });
      if (!out) return;
      const made = (out.items || []).filter((c) => c.generated).length;
      const toCome = (out.items || []).filter((c) => c.generated && c.status === 'armed').length;
      if (acts && !toCome) toast(`Built from the lineup, but every act's time has passed: no cue is still to come. Move the show to its next night under Details, and its cues come with it.`, { kind: 'error', ms: 10000 });
      else toast(`Timeline built from the lineup: ${plural(made, 'cue')} from it.`);
      await fresh(true).catch(() => {});
      drawRecipe();
      reload();
    }

    async function stopBuilding() {
      const ok = await confirm({
        title: 'Stop building from the lineup?',
        consequence: 'Cues made from the lineup that are still to come are deleted, except ones you changed yourself. Cues that already happened stay in the list, and changing the lineup no longer changes the timeline.',
        confirmLabel: 'Stop building',
      });
      if (!ok) return;
      try {
        await api.post(`${base()}/cues/build`, { recipe: null });
        toast('The timeline is no longer built from the lineup.');
        await fresh(true).catch(() => {});
      } catch (err) {
        toast(err);
      }
      drawRecipe();
      reload();
    }

    // Re-arm all (v0's "Re-arm"): the cues still to come that were skipped or fired early fire
    // again at their time; what has passed stays as it is (09 §9.4).
    async function rearmAll() {
      const now = api.serverNow();
      const n = cues.filter((c) => c.status !== 'armed' && Date.parse(c.at) > now).length;
      if (!n) {
        toast('Nothing to re-arm: every cue still to come is armed.');
        return;
      }
      const ok = await confirm({
        title: `Re-arm ${plural(n, 'cue')} still to come?`,
        consequence: `${n === 1 ? 'The cue still to come that was skipped or fired early fires' : `The ${n} cues still to come that were skipped or fired early fire`} again at ${n === 1 ? 'its' : 'their'} time, with whatever they show. Cues whose time has passed stay as they are: re-arm one of those from its own menu.`,
        confirmLabel: n === 1 ? 'Re-arm it' : `Re-arm ${n} cues`,
        danger: false,
      });
      if (!ok) return;
      try {
        const out = await api.post(`${base()}/cues/rearm`, {});
        const k = Array.isArray(out?.items) ? out.items.length : 0;
        toast(k ? `Re-armed ${plural(k, 'cue')}: ${k === 1 ? 'it fires at its' : 'they fire at their'} time.` : 'Nothing to re-arm: every cue still to come is armed.');
      } catch (err) {
        toast(err);
      }
      reload();
    }

    function drawRecipe() {
      recipeEl.textContent = recipeWords(show.recipe);
      const items = [];
      const addBtn = h('button.btn', { type: 'button', onclick: addCue }, 'Add a cue');
      const buildBtn = h('button.btn.primary', { type: 'button', onclick: build }, 'Build from lineup');
      if (canWrite) items.push(addBtn, buildBtn);
      const more = [
        canControl ? { label: 'Re-arm all cues still to come', onSelect: rearmAll } : null,
        canWrite && show.recipe ? { label: 'Stop building from the lineup', danger: true, onSelect: stopBuilding } : null,
      ].filter(Boolean);
      if (more.length) items.push(menu('More', more, { ariaLabel: 'More for the timeline' }));
      mount(actions, items);
    }

    function draw() {
      if (!cues.length) {
        mount(listEl, empty('No cues yet',
          canWrite ? 'Cues put graphics, scenes and clips on the stream at their time, by themselves. Build them from the lineup, or add one.' : 'Cues put graphics, scenes and clips on the stream at their time, by themselves.',
          canWrite ? h('button.btn.primary', { type: 'button', onclick: build }, 'Build from lineup') : null,
          canWrite ? h('button.btn', { type: 'button', onclick: addCue }, 'Add a cue') : null));
        return;
      }
      const now = api.serverNow();
      const next = cues.find((c) => c.status === 'armed' && Date.parse(c.at) >= now);
      const days = new Map();
      for (const c of cues) {
        const day = ymdIn(new Date(c.at), tz());
        if (!days.has(day)) days.set(day, []);
        days.get(day).push(c);
      }
      // The hour the clocks go back happens twice (a 1:00 AM, then another): an instant in the
      // second one reads on the clock as the instant an hour (or half an hour) before it did.
      const wallOf = (t) => { const p = partsIn(new Date(t), tz()); return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`; };
      const again = (c) => {
        const t = Date.parse(c.at);
        return [60, 30].some((min) => wallOf(t - min * 60000) === wallOf(t));
      };
      mount(listEl, [...days].map(([day, items]) => h('section',
        h('h3', dateLabel(day, true)),
        h('ul.list', items.map((c) => cueRow(c, c === next, again(c)))))));
    }

    function cueRow(c, isNext, second) {
      const words = actionWords(c.action, cat, show);
      const [stateText, stateKind] = STATUS[c.status] || [c.status || 'Unknown', undefined];
      const name = c.label || words;
      const items = [
        canControl ? { label: 'Fire now', onSelect: () => override(c, 'fire') } : null,
        canControl && c.status === 'armed' ? { label: 'Skip', onSelect: () => override(c, 'skip') } : null,
        canControl && c.status !== 'armed' ? { label: 'Re-arm', onSelect: () => override(c, 'rearm') } : null,
        canWrite && c.status !== 'fired' ? { label: 'Change', onSelect: () => editCue(c) } : null,
        canWrite ? { label: 'Delete', danger: true, onSelect: () => deleteCue(c) } : null,
      ].filter(Boolean);
      const origin = c.generated ? (c.edited ? 'from the lineup, changed by hand' : 'from the lineup') : null;
      const detail = [c.label ? words : null, origin].filter(Boolean).join(' · ');
      return h('li',
        h('strong.nowrap', clock(c.at, tz())),
        h('div.grow',
          h('div', name, ' ', isNext ? badge('Next', 'accent') : badge(stateText, stateKind)),
          detail ? h('div.small.muted', detail.charAt(0).toUpperCase() + detail.slice(1)) : null,
          c.clockGap ? h('div.small', `The clocks go forward at ${timeLabel(c.time)} that night: it fires at ${clock(c.at, tz())}.`) : null,
          c.clockOverlap ? h('div.small', `${timeLabel(c.time)} happens twice that night (the clocks go back): it fires at the first.`) : null,
          second ? h('div.small', `The second ${clock(c.at, tz())} that night, after the clocks go back.`) : null,
          c.error ? h('div.small', `Note: ${c.error}`) : null),
        items.length ? menu('⋯', items, { buttonClass: 'btn small', ariaLabel: `More for ${name}` }) : null);
    }

    drawRecipe();
    mount(panel, h('div.card.stack',
      h('div.spread', h('h2', 'Timeline'), actions),
      h('p.muted', `Cues fire on the platform at their time, even with every browser closed. Times are in the show's time zone${zoneNote(tz())}. A cue more than 5 minutes late is marked missed instead of firing.`),
      recipeEl,
      listEl));
    // Cues change state as the night goes: kept current, but never redrawn under an open menu.
    const stop = every(5000, () => load().catch((err) => {
      if (alive && lastKey === undefined) mount(listEl, notice(err.message, 'danger'));
    }));
    return () => { alive = false; stop(); };
  }

  // ---- Plans ---------------------------------------------------------------------------------
  // Planned dates (09 §9.6): the list, and a plan's editor in the tab, as a lineup is too long for
  // a dialog: its date with quick picks, its go-live, and a lineup of its own (edited like the
  // show's) or the show's as it is that day. A plan is saved whole (PUT, with its If-Match); one
  // can also become the show now (v0's "Load now").
  function plansTab(panel) {
    let alive = true;
    let plans = [];
    const listEl = h('div', h('p.loading', 'Loading…'));
    const addButton = canWrite ? h('button.btn.primary', { type: 'button', onclick: (e) => run(e.currentTarget, () => edit()) }, 'Plan a date') : null;
    const listCard = h('div.card',
      h('div.card-head', h('h2', 'Planned dates'), addButton ? h('div.actions', addButton) : null),
      h('p.muted', 'Save the show for a future night, with its own lineup and go-live: at the start of that day, the platform makes it the show with no browser open. A plan never changes a show that is live; it waits until the show ends.'),
      listEl);

    // The plans, and the show as it is now (whether it is live says what a plan can do).
    async function load() {
      try {
        [plans] = await Promise.all([api.all(`${base()}/plans`), fresh(true).catch(() => {})]);
        if (alive) draw();
      } catch (err) {
        if (alive) mount(listEl, notice(err.message, 'danger'));
      }
    }
    function showList() {
      if (!alive) return;
      reshow = undefined;
      unsaved = undefined;
      mount(panel, listCard);
      load();
    }

    function draw() {
      if (!plans.length) {
        mount(listEl, empty('No planned dates',
          'Plan the show for another night, with its lineup: at the start of that day, it becomes the show by itself.',
          canWrite ? h('button.btn', { type: 'button', onclick: (e) => run(e.currentTarget, () => edit()) }, 'Plan a date') : null));
        return;
      }
      mount(listEl, h('ul.list', plans.map(planRow)));
    }

    function planRow(p) {
      const names = Array.isArray(p.lineup) ? p.lineup.map((s) => s?.name).filter(Boolean) : [];
      const lines = [
        p.goLive === null ? 'No go-live time that night' : p.goLive ? `Goes live at ${timeLabel(p.goLive)}` : 'Keeps the show\'s go-live time',
        Array.isArray(p.lineup) ? `Its own lineup: ${names.length > 6 ? `${names.slice(0, 5).join(', ')} and ${names.length - 5} more` : andList(names) || 'no acts'}` : 'Keeps the show\'s lineup',
      ];
      if (p.dayBoundary) lines.push(`Day boundary ${timeLabel(p.dayBoundary)}`);
      if (p.overlaySettings) lines.push(`Overlay settings for ${andList(Object.keys(p.overlaySettings))}`);
      const state = p.error ? badge('Not applied', 'danger') : p.activatedAt ? badge('Done', 'ok') : badge('Planned');
      const open = canWrite && !p.activatedAt;
      const items = [
        open ? { label: 'Change', onSelect: () => edit(p) } : null,
        // A plan never changes a show on air: offered once it isn't.
        open ? (show.live ? { label: 'Make it the show now (not while live)', disabled: true } : { label: 'Make it the show now', onSelect: () => applyNow(p) }) : null,
        canWrite ? { label: 'Delete plan', danger: true, onSelect: () => deletePlan(p) } : null,
      ].filter(Boolean);
      return h('li',
        h('div.grow',
          h('div', h('strong', dateLabel(p.date, true)), ' ', state),
          h('div.small.muted', lines.join(' · ')),
          h('div.small.muted', p.activatedAt ? `Became the show ${instantLabel(p.activatedAt, tz())}` : `Becomes the show ${instantLabel(p.activateAt, tz())}${zoneNote(tz())}`),
          p.error ? h('div.small', `Not applied: ${p.error}`) : null,
          Array.isArray(p.warnings) ? p.warnings.map((w) => h('div.small', `Note: ${w}`)) : null),
        items.length ? menu('⋯', items, { buttonClass: 'btn small', ariaLabel: `More for the plan of ${dateLabel(p.date, true)}` }) : null);
    }

    // A new plan's date: the show's next night on its weekday that is still to come and not planned.
    function nextNight() {
      const tonight = showDayNow(tz(), show.dayBoundary);
      let d = addDays(show.date, 7);
      for (let i = 0; i < 520 && (d < tonight || plans.some((p) => p.date === d && !p.activatedAt)); i++) d = addDays(d, 7);
      return d;
    }

    // The editor, for a new plan (none) or one to change: the uploaded images and every lineup's
    // names (the acts) first, as the Lineup tab has them.
    async function edit(plan) {
      const [media, acts] = await Promise.all([loadAll('/api/v1/media'), loadAll('/api/v1/acts')]);
      try {
        await fresh();
      } catch (err) {
        if (err.status === 404) showGone();
        else toast(err);
        return;
      }
      if (alive) drawPlan(plan, imagesOf(media), acts);
    }

    function drawPlan(plan, images, acts) {
      const isNew = !plan;
      const b = plan?.dayBoundary || show.dayBoundary || '12:00';
      const date = h('input', { type: 'date', value: plan?.date || nextNight(), required: true });
      const goLive = h('input', { type: 'time', value: plan?.goLive || '' });
      // A plan with no go-live that night (set from the command line) stays so until a time is set.
      let noGoLive = plan?.goLive === null;
      const rows = (Array.isArray(plan?.lineup) ? plan.lineup : []).map(cleanSlot);
      const night = () => ({ date: DATE.test(date.value) ? date.value : show.date, boundary: b, timezone: show.timezone });
      const editor = lineupEditor({ rows, night, images, acts, onChange: () => touched() });
      const own = toggle('A lineup of its own', Array.isArray(plan?.lineup), { onChange: () => { drawOwn(); touched(); } });
      const showActs = lineupOf(show);
      const copy = h('button.btn', { type: 'button', disabled: !showActs.length, onclick: () => copyShow() }, `Copy the show's lineup (${plural(showActs.length, 'act')})`);
      const add = h('button.btn', { type: 'button', onclick: () => editor.add() }, 'Add an act');
      const sort = h('button.btn', { type: 'button', onclick: () => editor.sort() }, 'Sort by time');
      const ownBox = h('div');
      function drawOwn() {
        mount(ownBox, own.input.checked
          ? [editor.el, h('div.row', add, sort, copy)]
          : h('p.muted', 'On that day the show keeps the lineup it has then.'));
      }
      async function copyShow() {
        if (rows.length && !(await confirm({
          title: 'Replace this plan\'s lineup?',
          consequence: `Its ${plural(rows.length, 'act')} give way to the show's ${plural(showActs.length, 'act')}, as the show has them now.`,
          confirmLabel: 'Replace lineup',
        }))) return;
        rows.splice(0, rows.length, ...showActs.map((s) => ({ ...s })));
        editor.draw();
        touched();
      }

      const state = () => JSON.stringify([date.value, goLive.value, noGoLive, own.input.checked, own.input.checked ? rows.map(cleanSlot) : []]);
      const initial = state();
      const status = h('span.small.muted', { 'aria-live': 'polite' });
      const touched = () => { status.textContent = state() !== initial ? 'Unsaved changes' : ''; };
      date.addEventListener('input', () => { editor.draw(); touched(); });
      goLive.addEventListener('input', () => { noGoLive = false; touched(); });
      // Another tab asks first, as Cancel does; the show moving to another night changes nothing here.
      unsaved = () => (state() === initial ? '' : isNew ? 'This plan isn\'t saved: what you set here is lost.' : 'Your changes are lost; the plan stays as it was saved.');
      reshow = () => {};

      async function leave() {
        const lost = unsaved();
        if (lost && !(await confirm({ title: 'Leave without saving?', consequence: lost, confirmLabel: 'Leave' }))) return;
        showList();
      }
      const cancel = h('button.btn.ghost', { type: 'button', onclick: () => leave() }, 'Cancel');
      const save = h('button.btn.primary', { type: 'button' }, isNew ? 'Save plan' : 'Save changes');
      save.addEventListener('click', () => run(save, async () => {
        if (!DATE.test(date.value)) fail('Pick the date.');
        if (goLive.value && !TIME.test(goLive.value)) fail('Set the go-live time as hours and minutes, like 22:30, or leave it empty.');
        if (!isNew && state() === initial) {
          toast('Nothing to save: the plan is as it was.');
          showList();
          return;
        }
        const body = { date: date.value };
        if (goLive.value) body.goLive = goLive.value;
        else if (noGoLive) body.goLive = null;
        if (own.input.checked) {
          const lineup = rows.map(cleanSlot);
          if (!lineup.length) fail('Add the night\'s acts, or turn off "A lineup of its own" to keep the show\'s.');
          const bad = lineup.findIndex((s) => !TIME.test(s.time) || !s.name);
          if (bad >= 0) fail(`Act ${bad + 1} needs a start time and a name.`);
          body.lineup = lineup;
        }
        // What this form doesn't change, as it was read: a plan is saved whole.
        if (plan?.dayBoundary) body.dayBoundary = plan.dayBoundary;
        if (plan?.overlaySettings) body.overlaySettings = plan.overlaySettings;
        // Its night has begun: saved, the plan is the show at once (as "Make it the show now"), or
        // as soon as REC ends while the show is live. Asked first.
        if (date.value === showDayNow(tz(), b)) {
          await fresh(true).catch(() => {});
          const ok = await confirm(show.live ? {
            title: `Plan ${dateLabel(date.value, true)} while the show is live?`,
            consequence: 'That night has begun: the plan waits while the show is live, and becomes the show as soon as REC ends.',
            confirmLabel: 'Save plan',
            danger: false,
          } : {
            title: 'Make it the show now?',
            consequence: `${dateLabel(date.value, true)} has begun, so the plan becomes the show as soon as it is saved: "${show.name}" takes ${andList(['its date', own.input.checked ? 'its lineup' : '', body.goLive !== undefined ? 'its go-live' : ''].filter(Boolean))} now. REC and who's on go back to before the show, and its cues follow the new night.`,
            confirmLabel: 'Save and make it the show',
          });
          if (!ok) return;
        }
        let saved;
        try {
          saved = isNew ? await api.post(`${base()}/plans`, body) : await api.put(`${base()}/plans/${api.seg(plan.id)}`, body, { ifMatch: plan });
        } catch (err) {
          if (err.code === 'plan-exists') fail(`There is already a plan for ${dateLabel(date.value, true)}: change that one (in its ⋯ menu), or delete it first.`);
          if (isNew || ![404, 409, 412].includes(err.status) || (err.status === 409 && err.code !== 'applied')) throw err;
          // Changed (H16), applied or deleted meanwhile: said, and shown as it is now.
          const latest = await api.get(`${base()}/plans/${api.seg(plan.id)}`).catch(() => undefined);
          if (!latest) {
            const showThere = await fresh(true).then(() => true, (e) => e.status !== 404);
            if (!showThere) { showGone({ changing: true }); return; }
          }
          toast(!latest ? 'This plan was deleted meanwhile: nothing was saved.'
            : latest.activatedAt ? 'This plan became the show meanwhile: nothing was saved. Plan that date again to change it.'
              : 'This plan changed since you opened it: this is the latest. Make your change again.', { kind: 'error', ms: 10000 });
          if (latest && !latest.activatedAt) drawPlan(latest, images, acts);
          else showList();
          return;
        }
        await fresh(true).catch(() => {}); // its day may have begun: then it is the show now
        toast(saved.activatedAt ? `The plan for ${dateLabel(saved.date, true)} is the show now: its day has begun.`
          : `${isNew ? 'Planned' : 'Saved the plan'} for ${dateLabel(saved.date, true)}: it becomes the show ${instantLabel(saved.activateAt, tz())}.`);
        showList();
      }));

      const heading = h('h2', { tabindex: '-1' }, isNew ? 'Plan a date' : `The plan for ${dateLabel(plan.date, true)}`);
      drawOwn();
      mount(panel, h('div.card',
        heading,
        h('p.muted', `At the start of that day (the day boundary, ${timeLabel(b)}${zoneNote(tz())}), the platform makes it the show: its date, and what you set here. A show that is live then isn't changed until it ends.`),
        h('div.grid',
          dateField('Date', date, { hint: 'A night still to come.', zone: tz, boundary: () => b, future: true }),
          field('Goes live at', goLive, { hint: noGoLive ? 'No go-live time that night, so no countdown: set one here, or leave it so.' : `Empty: the show keeps its go-live time${show.goLive ? ` (${timeLabel(show.goLive)})` : ''}.` })),
        h('div.field', h('div.row', own), h('span.hint', 'Its own acts and set times for that night; without, the show keeps its lineup as it is then.')),
        ownBox,
        plan?.overlaySettings ? h('p.small.muted', `It also sets the settings of ${andList(Object.keys(plan.overlaySettings))} on that day; those stay as they are.`) : null,
        h('div.form-actions', status, cancel, save)));
      heading.focus({ preventScroll: false });
    }

    // v0's "Load now": the plan is the show now, as at its day boundary (never while live).
    async function applyNow(p) {
      await fresh(true).catch(() => {});
      if (show.live) {
        toast('The show is live: a plan never changes a show on air. Make it the show once REC is reset, or let it come on its day.', { kind: 'error', ms: 10000 });
        load();
        return;
      }
      const ok = await confirm({
        title: `Make the plan for ${dateLabel(p.date, true)} the show now?`,
        consequence: `"${show.name}" becomes the night of ${dateLabel(p.date, true)} now${Array.isArray(p.lineup) ? ', with the plan\'s lineup in place of the one it has' : ''}${p.goLive !== undefined ? ' and the plan\'s go-live' : ''}. REC and who's on go back to before the show, its cues follow the new date, and the plan won't change the show again on its day.`,
        confirmLabel: 'Make it the show',
      });
      if (!ok) return;
      try {
        const out = await api.post(`${base()}/plans/${api.seg(p.id)}/apply`, {});
        await fresh(true).catch(() => {});
        if (out?.error) toast(`The plan wasn't applied: ${out.error}`, { kind: 'error', ms: 10000 });
        else toast(`"${show.name}" is the night of ${dateLabel(p.date, true)} now.`);
      } catch (err) {
        toast(err);
      }
      load();
    }

    async function deletePlan(p) {
      const ok = await confirm({
        title: `Delete the plan for ${dateLabel(p.date, true)}?`,
        consequence: p.activatedAt
          ? 'It has already been applied: it only leaves this list, and the show stays as it is.'
          : `On ${dateLabel(p.date, true)} the show won't change by itself: its date, lineup and go-live stay as they are then.`,
        confirmLabel: 'Delete plan',
      });
      if (!ok) return;
      try {
        await api.del(`${base()}/plans/${api.seg(p.id)}`);
        toast(`Deleted the plan for ${dateLabel(p.date, true)}`);
      } catch (err) {
        toast(err);
      }
      load();
    }

    showList();
    return () => { alive = false; reshow = undefined; unsaved = undefined; };
  }

  // ---- the page ------------------------------------------------------------------------------
  drawHead();
  const wanted = ctx.query.get('tab');
  tabsEl = tabs([
    { id: 'details', label: 'Details', render: detailsTab },
    { id: 'lineup', label: 'Lineup', render: lineupTab },
    { id: 'timeline', label: 'Timeline', render: timelineTab },
    { id: 'plans', label: 'Plans', render: plansTab },
  ], {
    selected: TAB_IDS.includes(wanted) ? wanted : 'details',
    // The tab in the address, so a reload comes back to it (no navigation: replaceState). Not
    // once the user has gone to another page while this one loaded: the address is theirs.
    onChange: (id) => { if (!gone && ctx.alive()) history.replaceState(null, '', `#/shows/${api.seg(show.id)}?tab=${id}`); },
  });
  // A tab change (a click, or the arrow keys) that would lose unsaved edits asks first, as the plan
  // editor's Cancel does; the tab itself again too, as that draws it afresh.
  const bar = tabsEl.querySelector('[role=tablist]');
  function guard(e, tab) {
    const lost = !leaving && tab && unsaved?.();
    if (!lost) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    confirm({ title: 'Leave without saving?', consequence: lost, confirmLabel: 'Leave' }).then((ok) => {
      if (!ok || gone) return;
      leaving = true;
      try { tab.focus(); tab.click(); } finally { leaving = false; }
    });
  }
  bar.addEventListener('click', (e) => guard(e, e.target.closest('[role=tab]')), true);
  bar.addEventListener('keydown', (e) => {
    const btns = [...bar.children];
    const i = btns.indexOf(document.activeElement);
    if (i >= 0 && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) guard(e, btns[(i + (e.key === 'ArrowRight' ? 1 : btns.length - 1)) % btns.length]);
  }, true);
  mount(view, head, tabsEl);

  // The head (live or not, the name) stays current; a show deleted elsewhere says so.
  let first = true;
  stop = every(15000, async () => {
    if (first) { first = false; return; }
    try {
      await fresh(true);
    } catch (err) {
      if (err.status !== 404) throw err;
      showGone();
    }
  });
  return () => {
    gone = true;
    stop();
    tabsEl.destroy();
  };
}
