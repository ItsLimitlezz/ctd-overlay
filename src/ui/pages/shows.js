// Shows (08 §8.1, 09): the overlays that change together, the night's lineup, the timeline the
// server runs by itself, and planned dates. Routes: /shows (list) and /shows/:id (detail, by id or
// name). Every time of a show is in the show's own time zone; the server resolves wall-clock times
// to instants (09 §9.2) and this page shows the instants it answers with. Edits send If-Match with
// the show (or cue) as the form read it (H16); destructive actions sit in a menu behind a
// confirmation (H20). Details also sets what feeds every overlay of the show at once ("Fed by":
// one change per overlay, each with its own If-Match).
import * as api from '../api.js';
import { badge, clock, confirm, dialog, empty, every, field, h, menu, mount, notice, pageHead, run, statusDot, tabs, toast } from '../dom.js';
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

// The wall clock of an instant in a zone: { year, month, day, hour, minute } as strings.
function partsIn(date, timeZone) {
  const opts = { hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' };
  let fmt;
  try { fmt = new Intl.DateTimeFormat('en-US', { ...opts, timeZone }); } catch { fmt = new Intl.DateTimeFormat('en-US', opts); }
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
const todayIn = (tz) => ymdIn(new Date(), tz);

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

// A cue's action in plain words.
function actionWords(a, cat, show) {
  switch (a?.type) {
    case 'show.scene': return `Change the scene to ${cat?.sceneLabel(a.scene) ?? a.scene}`;
    case 'overlay.action': return `${cat?.actionLabel(a.name) ?? a.name}${a.args?.name ? ` (${a.args.name})` : ''}`;
    case 'show.slot': return `Who's on: ${typeof a.slot === 'number' ? show?.lineup?.[a.slot]?.name ?? `act ${a.slot + 1}` : a.slot}`;
    case 'media.play': return `Play ${cat?.mediaName(a.mediaId) ?? 'a clip'}`;
    case 'media.stop': return a.mediaId ? `Stop ${cat?.mediaName(a.mediaId) ?? 'the clip'}` : 'Stop the clip';
    case 'sequence': {
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
  const newButton = canWrite ? h('button.btn.primary', { type: 'button', onclick: () => run(newButton, () => newShow(ctx)) }, 'New show') : null;
  mount(view, pageHead('Shows', { actions: newButton ? [newButton] : [] }), body);

  let last;
  const draw = (shows) => {
    if (!shows.length) {
      mount(body, empty('No shows yet',
        'A show is a night: the overlays that change together (like a horizontal and a vertical feed), its lineup, and a timeline that runs by itself.',
        canWrite ? h('button.btn.primary', { type: 'button', onclick: (e) => run(e.currentTarget, () => newShow(ctx)) }, 'New show') : null));
      return;
    }
    const sorted = [...shows].sort((a, b) => (b.live === true) - (a.live === true) || String(b.date).localeCompare(String(a.date)) || String(a.name).localeCompare(String(b.name)));
    mount(body, h('div.grid', sorted.map((s) => showCard(s))));
  };
  const refresh = async () => {
    const shows = await api.all('/api/v1/shows');
    const key = JSON.stringify(shows);
    if (key === last) return;
    last = key;
    draw(shows);
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

async function newShow(ctx) {
  const overlays = await loadAll('/api/v1/overlays');
  const zone = browserZone();
  const name = h('input', { type: 'text', maxlength: 80, required: true, autocomplete: 'off', placeholder: 'Saturday TAKEOVER' });
  const date = h('input', { type: 'date', value: todayIn(zone), required: true });
  const tz = zoneInput(zone);
  const goLive = h('input', { type: 'time' });
  const picker = overlayPicker(overlays);
  const body = h('div',
    field('Name', name, { hint: 'What you call the night.' }),
    field('Date', date, { hint: 'The night of the show. Acts after midnight still belong to this date.' }),
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
  toast(`Created the show "${created.name}"`);
  ctx.navigate(`/shows/${api.seg(created.id)}`);
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
    // Redrawn only when what it shows changed, and never under its open menu.
    const key = JSON.stringify([show.name, show.live, show.date, show.goLiveAt, show.timezone, members, acts]);
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
        : notice('This show has no overlays yet: pick them under Details, so its scenes, lineup and timeline reach the stream.', 'warn'));
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
    return () => { alive = false; };
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
    const save = h('button.btn.primary', { type: 'button' }, 'Save details');

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
    mount(panel, h('div.stack', h('div.card',
      h('h2', 'Details'),
      disabled ? notice('You can look at this show; changing it needs an operator or a higher role.') : null,
      h('div.grid',
        field('Name', name),
        field('Date', date, { hint: 'The night of the show. Acts after midnight still belong to it.' }),
        field('Time zone', zone, { hint: 'Where the show happens. Every time of the show is in this zone, wherever your phone is.' }),
        field('Day boundary', boundary, { hint: `When the show's day starts. ${boundaryWords(b, formShow.date)} An afternoon show sets it earlier, like ${timeLabel('06:00')}.` }),
        field('Goes live at', goLive, { hint: formShow.goLiveAt ? `Now: ${instantLabel(formShow.goLiveAt, formShow.timezone)}${zoneNote(formShow.timezone)}. Leave empty for no countdown.` : 'When the countdown ends and the show goes on air. Leave empty for no countdown.' })),
      picker.el,
      canWrite ? h('div.form-actions', save) : null), fedBox));
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
    Promise.all([fresh(), loadAll('/api/v1/media')]).then(([, media]) => {
      if (!alive) return;
      const images = media.filter((m) => m?.status === 'ready' && m.kind === 'image').map((m) => ({ value: m.url, label: m.name || m.url }));
      drawLineup(panel, images);
    }).catch((err) => {
      if (!alive) return;
      if (err.status === 404) showGone();
      else mount(panel, notice(err.message, 'danger'));
    });
    return () => { alive = false; };
  }

  function drawLineup(panel, images, keptRows) {
    const formShow = show;
    const disabled = !canWrite;
    const saved = Array.isArray(formShow.lineup) ? formShow.lineup : [];
    const rows = keptRows || saved.map((s) => ({ ...cleanSlot(s), orig: s }));
    const b = formShow.dayBoundary || '12:00';
    const original = JSON.stringify(lineupOf(formShow));
    const status = h('span.small.muted', { 'aria-live': 'polite' });
    const list = h('div.stack');
    const dirty = () => JSON.stringify(rows.map(cleanSlot)) !== original;
    const touched = () => {
      const changed = dirty();
      status.textContent = changed ? 'Unsaved changes' : '';
      undo.disabled = !changed;
    };

    // When a row plays: the server's instant for a saved time; for a changed one, which day.
    function when(row) {
      if (!TIME.test(row.time)) return [h('span', 'Set a time.')];
      const nextDay = minutesOf(row.time) < minutesOf(b);
      const out = [];
      if (row.orig && row.orig.time === row.time && row.orig.startAt) {
        out.push(h('span', `Starts ${instantLabel(row.orig.startAt, formShow.timezone)}${nextDay ? ', after midnight' : ''}.`));
        if (row.orig.clockGap) out.push(notice(`${timeLabel(row.time)} doesn't happen that night (the clocks go forward): it starts at ${clock(row.orig.startAt, formShow.timezone)} instead.`, 'warn'));
        if (row.orig.clockOverlap) out.push(notice(`${timeLabel(row.time)} happens twice that night (the clocks go back): it means the first one.`, 'warn'));
      } else {
        out.push(h('span', nextDay ? `After midnight: plays on ${dateLabel(addDays(formShow.date, 1))}.` : `Plays on ${dateLabel(formShow.date)}.`));
      }
      return out;
    }

    function move(i, by, focusKey) {
      const j = i + by;
      if (j < 0 || j >= rows.length) return;
      [rows[i], rows[j]] = [rows[j], rows[i]];
      drawRows();
      touched();
      list.querySelector(`[data-key="${focusKey}-${j}"]`)?.focus();
    }

    function rowEl(row, i) {
      const whenEl = h('div.small.muted');
      const update = () => mount(whenEl, when(row));
      const label = () => row.name || `act ${i + 1}`;
      const time = h('input', { type: 'time', value: row.time, required: true, disabled, oninput: (e) => { row.time = e.target.value; update(); touched(); } });
      const name = h('input', { type: 'text', value: row.name, maxlength: 80, required: true, autocomplete: 'off', disabled, oninput: (e) => { row.name = e.target.value; touched(); } });
      const b2b = h('input', { type: 'text', value: row.b2b || '', maxlength: 80, autocomplete: 'off', disabled, oninput: (e) => { row.b2b = e.target.value; touched(); } });
      const logoOptions = [{ value: '', label: 'No logo (the name shows)' }, ...images];
      const logo = choice(logoOptions, row.logo || '', { disabled });
      logo.addEventListener('change', () => { row.logo = logo.value; touched(); });
      update();
      const tools = canWrite ? h('div.row',
        h('button.btn.small', { type: 'button', disabled: i === 0, 'aria-label': `Move ${label()} up`, dataset: { key: `up-${i}` }, onclick: () => move(i, -1, 'up') }, '↑ Up'),
        h('button.btn.small', { type: 'button', disabled: i === rows.length - 1, 'aria-label': `Move ${label()} down`, dataset: { key: `down-${i}` }, onclick: () => move(i, 1, 'down') }, '↓ Down'),
        menu('More', [{
          label: 'Remove this act', danger: true, onSelect: () => { rows.splice(i, 1); drawRows(); touched(); toast(`Removed ${label()} from the lineup. Save to keep it that way.`); },
        }], { buttonClass: 'btn small', ariaLabel: `More for ${label()}` })) : null;
      return h('fieldset',
        h('legend', `${i + 1}. ${row.name || 'New act'}`),
        h('div.grid',
          field('Time', time),
          field('Act', name),
          field('B2B with', b2b, { hint: 'Optional: who plays with them.' }),
          field('Logo', logo, { hint: images.length ? 'An image uploaded in Media. Without one, the name shows.' : 'Upload logos in Media to pick one here. Without one, the name shows.' })),
        h('div.stack',
          h('div.row',
            toggle('Headliner', row.headliner, { disabled, onChange: (on) => { row.headliner = on; touched(); } }),
            toggle('Closer', row.closer, { disabled, onChange: (on) => { row.closer = on; touched(); } })),
          whenEl,
          tools));
    }

    function drawRows() {
      if (!rows.length) {
        mount(list, empty('No acts yet', canWrite ? 'Add the night\'s acts with their start times.' : 'The lineup is empty.'));
        return;
      }
      mount(list, rows.map(rowEl));
    }

    const add = h('button.btn', { type: 'button', onclick: () => {
      rows.push({ time: '', name: '' });
      drawRows();
      touched();
      const sets = list.querySelectorAll('fieldset');
      sets[sets.length - 1]?.querySelector('input')?.focus();
    } }, 'Add an act');
    const sort = h('button.btn', { type: 'button', onclick: () => {
      // In the order of the night: from the day boundary on, so 01:00 comes after 23:00.
      const key = (r) => (TIME.test(r.time) ? (minutesOf(r.time) - minutesOf(b) + 1440) % 1440 : Infinity);
      rows.sort((x, y) => key(x) - key(y));
      drawRows();
      touched();
    } }, 'Sort by time');
    const undo = h('button.btn.ghost', { type: 'button', onclick: () => drawLineup(panel, images) }, 'Undo changes');
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
        drawLineup(panel, images, same ? rows : undefined);
        return;
      }
      readAt = Date.now();
      const heads = lineup.filter((s) => s.headliner).length;
      toast(`Lineup saved: ${plural(lineup.length, 'act')}${show.recipe ? '; the timeline follows it' : ''}.${heads > 1 ? ' More than one act is the headliner: templates use the first.' : ''}`);
      drawHead();
      drawLineup(panel, images);
    }));

    drawRows();
    mount(panel, h('div.card',
      h('div.card-head', h('h2', 'Lineup'), canWrite ? h('div.actions', sort) : null),
      notice(`${boundaryWords(b, formShow.date)} The day boundary is set in Details.`),
      h('p.small.muted', 'Headliner and closer are different things: the headliner is the billed act (the Starting Soon card and the headliner intro use it); the closer is whoever plays last. Flag each where it belongs, even when it\'s the same act.'),
      disabled ? notice('You can look at the lineup; changing it needs an operator or a higher role.') : null,
      list,
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
      const a = cue?.action;
      const fixed = a && !KINDS.some((k) => k.type === a.type); // a sequence (or a later kind): not edited here
      const initialAt = cue ? cue.time || hmIn(new Date(cue.at), tz()) : '';
      const b = show.dayBoundary || '12:00';
      const at = h('input', { type: 'time', value: initialAt, required: true });
      const kind = h('select', KINDS.map((k) => h('option', { value: k.type }, k.label)));
      kind.value = a && !fixed ? a.type : 'overlay.action';
      const graphic = choice(cat.actions, a?.type === 'overlay.action' ? a.name : undefined, { placeholder: 'titleCard' });
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
      const sync = () => { for (const [type, els] of Object.entries(groups)) for (const el of els) el.hidden = fixed || kind.value !== type; };
      kind.addEventListener('change', sync);
      sync();
      const body = h('div',
        field('At', at, { hint: `A time of the show${zoneNote(tz())}. Times before ${timeLabel(b)} are the next day, after midnight.` }),
        fixed ? h('p', `It does: ${actionWords(a, cat, show)}. That can't be changed here; its time and name can.`) : field('It does', kind),
        Object.values(groups).flat(),
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
              action = { type, name, ...(a?.type === type && a.name === name && a.args ? { args: a.args } : {}) };
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
      toast(`Timeline built from the lineup: ${plural(made, 'cue')} from it.`);
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

    function drawRecipe() {
      recipeEl.textContent = recipeWords(show.recipe);
      const items = [];
      const addBtn = h('button.btn', { type: 'button', onclick: addCue }, 'Add a cue');
      const buildBtn = h('button.btn.primary', { type: 'button', onclick: build }, 'Build from lineup');
      if (canWrite) items.push(addBtn, buildBtn);
      if (canWrite && show.recipe) items.push(menu('More', [{ label: 'Stop building from the lineup', danger: true, onSelect: stopBuilding }]));
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
      mount(listEl, [...days].map(([day, items]) => h('section',
        h('h3', dateLabel(day, true)),
        h('ul.list', items.map((c) => cueRow(c, c === next))))));
    }

    function cueRow(c, isNext) {
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
  function plansTab(panel) {
    let alive = true;
    const listEl = h('div', h('p.loading', 'Loading…'));
    const addButton = canWrite ? h('button.btn.primary', { type: 'button', onclick: () => addPlan() }, 'Plan a date') : null;

    async function load() {
      try {
        const plans = await api.all(`${base()}/plans`);
        if (alive) draw(plans);
      } catch (err) {
        if (alive) mount(listEl, notice(err.message, 'danger'));
      }
    }

    function draw(plans) {
      if (!plans.length) {
        mount(listEl, empty('No planned dates',
          'Plan the show for another night: at the start of that day, it becomes the show by itself.',
          canWrite ? h('button.btn', { type: 'button', onclick: () => addPlan() }, 'Plan a date') : null));
        return;
      }
      mount(listEl, h('ul.list', plans.map(planRow)));
    }

    function planRow(p) {
      const lines = [];
      lines.push(p.goLive ? `Goes live at ${timeLabel(p.goLive)}` : 'Keeps the show\'s go-live time');
      lines.push(Array.isArray(p.lineup) ? `Its own lineup: ${plural(p.lineup.length, 'act')}` : 'Keeps the show\'s lineup');
      if (p.dayBoundary) lines.push(`Day boundary ${timeLabel(p.dayBoundary)}`);
      if (p.overlaySettings) lines.push(`Overlay settings for ${andList(Object.keys(p.overlaySettings))}`);
      const state = p.error ? badge('Not applied', 'danger') : p.activatedAt ? badge('Done', 'ok') : badge('Planned');
      const items = canWrite ? [{ label: 'Delete plan', danger: true, onSelect: () => deletePlan(p) }] : [];
      return h('li',
        h('div.grow',
          h('div', h('strong', dateLabel(p.date, true)), ' ', state),
          h('div.small.muted', lines.join(' · ')),
          h('div.small.muted', p.activatedAt ? `Became the show ${instantLabel(p.activatedAt, tz())}` : `Becomes the show ${instantLabel(p.activateAt, tz())}${zoneNote(tz())}`),
          p.error ? h('div.small', `Not applied: ${p.error}`) : null,
          Array.isArray(p.warnings) ? p.warnings.map((w) => h('div.small', `Note: ${w}`)) : null),
        items.length ? menu('⋯', items, { buttonClass: 'btn small', ariaLabel: `More for the plan of ${dateLabel(p.date, true)}` }) : null);
    }

    async function addPlan() {
      const date = h('input', { type: 'date', value: addDays(show.date, 7), required: true });
      const goLive = h('input', { type: 'time', value: show.goLive || '' });
      const acts = Array.isArray(show.lineup) ? show.lineup.length : 0;
      const copy = toggle(`Copy tonight's lineup (${plural(acts, 'act')})`, false, { disabled: !acts });
      const body = h('div',
        h('p.muted', `At the start of that day (the day boundary, ${timeLabel(show.dayBoundary || '12:00')}), the platform makes it the show: its date, and what you set here. A show that is live then isn't changed until it ends.`),
        field('Date', date),
        field('Goes live at', goLive, { hint: 'Empty: the show keeps its go-live time.' }),
        copy,
        h('p.small.muted', 'Without the lineup, the show keeps the lineup it has on that day.'));
      const plan = await formDialog({
        title: 'Plan a date',
        body,
        submitLabel: 'Save plan',
        focus: date,
        submit: () => {
          if (!DATE.test(date.value)) fail('Pick the date.');
          if (goLive.value && !TIME.test(goLive.value)) fail('Set the go-live time as hours and minutes, like 22:30, or leave it empty.');
          return api.post(`${base()}/plans`, {
            date: date.value,
            ...(goLive.value ? { goLive: goLive.value } : {}),
            ...(copy.input.checked ? { lineup: lineupOf(show) } : {}),
          });
        },
      });
      if (!plan?.id) return;
      toast(`Planned for ${dateLabel(plan.date, true)}: it becomes the show ${instantLabel(plan.activateAt, tz())}.`);
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

    mount(panel, h('div.card',
      h('div.card-head', h('h2', 'Planned dates'), addButton ? h('div.actions', addButton) : null),
      h('p.muted', 'Save the show for a future night: at the start of that day, the platform makes it the show — date, lineup and go-live — with no browser open. A plan never changes a show that is live; it waits until the show ends.'),
      listEl));
    load();
    return () => { alive = false; };
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
