// The show-night console (08 §8.4), the default landing page: built for a phone held in one hand,
// under pressure. Several streams can run at once (a show each, or an overlay outside a show, each
// fed by its own connections), so Live opens on all of them:
//
//   #/live                          every stream as a card: on air, offline or unknown, its
//                                   platforms and viewers, what feeds it, REC; running ones first
//   #/live?show=<id>[&overlay=<s>]  one show: its status, then the whole show (previews of its
//                                   overlays, its scenes and the templates' actions, who's on, REC,
//                                   the timeline with its next cue) or one of its overlays
//                                   (live-overlay.js), remembered in the address
//   #/live?overlay=<slug>           an overlay outside a show, on its own: the same overlay panel,
//                                   with its own scenes
//
// An overlay outside a show whose template reads who's on from one (set times, title cards, and its
// countdown and REC) says so on its card and first in its console, with "Make a show from this
// overlay" and "Add it to a show" (show-from-overlay.js): its title cards have no act to name until
// it is in one. A clock that reads only a show's times may have its own, so Live says nothing of it.
//
// Everything here is a command (no If-Match, README H16). The streams page polls every 3 s, and at
// once when a connection's status changes; a show's console polls the show and its cues every 2 s,
// and updates the page in place, so focus, scroll and loaded previews stay; countdowns tick every
// second in server time.
import * as api from '../api.js';
import { badge, clock, confirm, countdown, empty, every, field, h, isPhone, menu, mount, notice, pageHead, preview, run, toast } from '../dom.js';
import { byObsWords } from '../obs.js';
import { needsShow, showNotice, showWords } from '../show-from-overlay.js';
import { isRunning, streamStatus } from '../streams.js';
import { overlayPanel } from './live-overlay.js';

const PREVIEWS_KEY = 'skp.live.previews';
const CUES_KEY = 'skp.live.cues';
const SHOW_POLL_MS = 2000;
const STREAMS_POLL_MS = 3000;
const MEMBERS_RETRY_MS = 10000;
const MAX_LIVE_PREVIEWS = 2; // H13
const PREVIEW_BASIS_H = 90; // px: the height previews are laid out at before they grow
const PREVIEW_MAX_H = 280; // px: the tallest they grow
const GRACE_MS = 5 * 60 * 1000; // a cue later than this is missed, not fired (09 §9.4)
const COOL_MS = 1200; // after "Trigger now", "Skip" or "Next act": a double tap can't hit the next one
const NO_CONTROL = 'Your role can watch the show here but not run it, so its buttons are off. Ask the owner or an admin to make you an operator.';

// Per-viewer conveniences (the show chosen, which panels are open): nothing breaks if they're lost.
const remembered = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* a private window: not remembered */ } },
};

const list = (v) => (Array.isArray(v) ? v : []);
const instant = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? t : undefined; };
const actName = (s) => (s?.b2b ? `${s.name} b2b ${s.b2b}` : s?.name || 'An act');
const set = (el, text) => { if (el.textContent !== text) el.textContent = text; };
// A scene button's text: a timed scene (it returns by itself) says for how long, kept on one line.
const sceneText = (s) => (s.seconds ? `${s.label} · ${s.seconds} s` : s.label);
// A countdown to something still to come, rounded up: "0:01" until it is due, never "0:00" before.
const until = (ms) => countdown(Math.ceil(ms / 1000) * 1000);
function clockBadge() {
  const b = badge('Clock change', 'warn');
  b.title = 'This time falls on a daylight-saving clock change; it is shown as it will happen.';
  return b;
}

// What the members' templates offer: their scenes, named by core when they have one so a take
// reaches every member under the name its own template knows (04 §4.2), and their actions.
function catalog(manifests) {
  const unique = [...new Set(manifests.filter((m) => m && typeof m === 'object'))];
  const scenes = [];
  const actions = [];
  for (const m of unique) {
    for (const s of list(m.scenes)) {
      if (!s || typeof s.id !== 'string') continue;
      const key = typeof s.core === 'string' && s.core ? s.core : s.id;
      if (scenes.some((x) => x.key === key)) continue;
      scenes.push({ key, label: s.label || s.id, core: key !== s.id || !!s.core, seconds: s.durationMs > 0 && s.then ? Math.round(s.durationMs / 1000) : undefined });
    }
    for (const a of list(m.actions)) {
      if (!a || typeof a.id !== 'string' || actions.some((x) => x.key === a.id)) continue;
      actions.push({ key: a.id, label: a.label || a.id });
    }
  }
  // A scene name (an id or a core) as the button that takes it: by id first, then by core.
  const keyOf = (name) => {
    if (typeof name !== 'string' || !name) return undefined;
    for (const m of unique) {
      const def = list(m.scenes).find((s) => s?.id === name) || list(m.scenes).find((s) => s?.core === name);
      if (def) return def.core || def.id;
    }
    return name;
  };
  return {
    scenes,
    actions,
    sceneKey: keyOf,
    sceneLabel: (name) => scenes.find((s) => s.key === keyOf(name))?.label || name || 'a scene',
    actionLabel: (name) => actions.find((a) => a.key === name)?.label,
  };
}

// Each overlay's template manifest, from the version it is pinned to (04 §4.10): its scenes and
// actions, which may not be the newest version's. One request per template version.
const pinnedKey = (o) => (typeof o?.template?.id === 'string' && typeof o.template.version === 'string' ? `${o.template.id}@${o.template.version}` : undefined);
async function pinnedManifests(overlays, read = (p) => p) {
  const pins = new Map();
  for (const o of overlays) {
    const key = pinnedKey(o);
    if (key && !pins.has(key)) pins.set(key, o.template);
  }
  const found = await Promise.all([...pins.values()].map((t) => read(api.get(`/api/v1/templates/${api.seg(t.id)}/versions/${api.seg(t.version)}`))));
  const manifests = new Map([...pins.keys()].map((key, i) => [key, found[i]?.manifest]));
  return (o) => manifests.get(pinnedKey(o));
}

// The show's members: each overlay, its template's manifest and its URLs (one per canvas).
// complete is false when something couldn't be read for a reason that may pass (offline, busy).
async function loadMembers(slugs, { urls }) {
  let complete = true;
  const quiet = (promise) => promise.catch((err) => {
    if (![403, 404].includes(err?.status)) complete = false;
    return undefined;
  });
  const [overlays, links] = await Promise.all([
    Promise.all(slugs.map((slug) => quiet(api.get(`/api/v1/overlays/${api.seg(slug)}`)))),
    Promise.all(slugs.map((slug) => (urls ? quiet(api.get(`/api/v1/overlays/${api.seg(slug)}/url`)) : undefined))),
  ]);
  const manifestOf = await pinnedManifests(overlays, quiet);
  return {
    complete,
    members: slugs.map((slug, i) => ({ slug, overlay: overlays[i], manifest: manifestOf(overlays[i]), urls: list(links[i]?.urls) })),
  };
}

const ALL_STREAMS = { label: 'All streams', href: '#/live' };
const liveHref = ({ show, overlay } = {}) => `/live${show ? `?show=${encodeURIComponent(show)}${overlay ? `&overlay=${encodeURIComponent(overlay)}` : ''}` : overlay ? `?overlay=${encodeURIComponent(overlay)}` : ''}`;

export async function live(view, ctx) {
  ctx.setTitle('Live');
  const show = ctx.query.get('show');
  const overlay = ctx.query.get('overlay');
  if (show) return openShow(view, ctx, show, overlay || undefined);
  if (overlay) return overlayConsole(view, ctx, overlay);
  return streams(view, ctx);
}

// A page Live can't draw (the request failed): the problem, and Try again.
function failed(view, ctx, title, err) {
  mount(view, pageHead(title, { crumbs: [ALL_STREAMS] }), notice(err.message, 'danger'),
    h('div.row', h('button.btn.primary', { type: 'button', onclick: () => ctx.navigate(`${location.hash.slice(1)}`, { replace: true }) }, 'Try again')));
}

// A show by id or name (as ?show= has it).
async function openShow(view, ctx, wanted, overlay) {
  let shows;
  try {
    shows = await api.all('/api/v1/shows');
  } catch (err) {
    if (err.status === 401) return undefined; // signing in again
    failed(view, ctx, 'Live', err);
    return undefined;
  }
  const lower = String(wanted).toLowerCase();
  const show = shows.find((s) => s.id === wanted) || shows.find((s) => typeof s.name === 'string' && s.name.toLowerCase() === lower);
  if (!ctx.alive()) return undefined;
  if (!show) {
    mount(view, pageHead(`There is no show "${wanted}"`, { crumbs: [ALL_STREAMS] }),
      h('div.card', empty('It may have been deleted or renamed.', 'Every show and overlay that can go live is on the streams page.', h('a.btn.primary', { href: '#/live' }, 'All streams'))));
    return undefined;
  }
  return showConsole(view, ctx, show, shows, {
    overlay,
    switchTo: (id) => ctx.navigate(liveHref({ show: id })),
    reopen: () => ctx.navigate('/live', { replace: true }),
  });
}

// ---- every stream ------------------------------------------------------------------------------
// A card per show, and per overlay outside a show: on air or not, its platforms, viewers and
// connections, REC; running ones (on air, or REC) first. Read every 3 s, and soon after a
// connection's status changes (system.connection, for whoever may read events).
async function streams(view, ctx) {
  const canShows = ctx.can('timeline:read');
  let stopped = false;
  const cards = new Map(); // key → its card, kept while the stream exists
  let order = '';
  let lastOk = Date.now();
  let loaded = false;
  let showsExist = false;
  const grid = h('div.grid');
  const emptyBox = h('div', { hidden: true });
  const problemBox = h('div', { hidden: true });
  const intro = h('p.muted', 'A stream is a show (its overlays run together) or an overlay outside a show. Each is fed by its own connections, so several can be on air at once. Running streams come first.');

  // The pinned template of each overlay outside a show, read once per version: whether it reads a
  // show (set times, the countdown, title cards) that it isn't in.
  const manifests = new Map(); // "id@version" → its manifest (null: none)
  async function learnManifests(overlays) {
    if (!ctx.can('templates:read')) return;
    const wanted = new Map();
    for (const o of overlays) {
      const key = pinnedKey(o);
      if (key && !manifests.has(key)) wanted.set(key, o.template);
    }
    await Promise.all([...wanted].map(async ([key, t]) => {
      try {
        manifests.set(key, (await api.get(`/api/v1/templates/${api.seg(t.id)}/versions/${api.seg(t.version)}`))?.manifest || null);
      } catch (err) {
        if (err?.status === 404) manifests.set(key, null); // not installed: the card says nothing of it
      }
    }));
  }

  async function read() {
    const [shows, overlays] = await Promise.all([canShows ? api.all('/api/v1/shows') : [], api.all('/api/v1/overlays')]);
    const outside = overlays.filter((o) => o && typeof o.slug === 'string' && !o.show);
    await learnManifests(outside);
    showsExist = shows.length > 0;
    const all = [
      ...shows.filter((s) => s && typeof s.id === 'string').map((s) => ({
        key: `show:${s.id}`, show: true, name: s.name || 'Show', stream: s.stream, rec: instant(s.recStartedAt) !== undefined,
        overlays: list(s.members).length, href: `#${liveHref({ show: s.id })}`,
      })),
      ...outside.map((o) => ({
        key: `overlay:${o.id}`, show: false, name: o.slug, stream: o.stream, rec: false, overlays: 1, href: `#${liveHref({ overlay: o.slug })}`,
        overlay: o, manifest: manifests.get(pinnedKey(o)) || undefined,
      })),
    ];
    return all.map((s, i) => ({ s, i }))
      .sort((a, b) => Number(isRunning(b.s.stream, b.s.rec)) - Number(isRunning(a.s.stream, a.s.rec)) || a.i - b.i)
      .map((x) => x.s);
  }

  function card(key) {
    const c = { status: streamStatus({ compact: true }) };
    c.title = h('h2.truncate');
    c.meta = h('p.small.muted');
    c.needs = h('div.needs-show-slot', { hidden: true });
    c.open = h('a.btn.primary', {}, 'Open');
    c.el = h('article.card.stream-card', h('div.card-head', c.title), c.meta, c.status.el, c.needs, h('div.open', c.open));
    cards.set(key, c);
    return c;
  }
  // An overlay outside a show whose template reads one: the notice, drawn again only when it
  // changes (a button pressed keeps its focus through the polls).
  function drawNeeds(c, s) {
    const on = !s.show && needsShow(s.overlay, s.manifest);
    const key = on ? JSON.stringify([s.overlay.id, s.overlay.slug, showWords(s.manifest), showsExist]) : '';
    if (key === c.needsKey) return;
    c.needsKey = key;
    c.needs.hidden = !on;
    mount(c.needs, on ? showNotice(ctx, { overlay: s.overlay, manifest: s.manifest, canAdd: showsExist, compact: true, onAdded: () => refresh() }) : null);
  }
  function draw(all) {
    const keys = new Set(all.map((s) => s.key));
    for (const [key, c] of cards) if (!keys.has(key)) { c.el.remove(); cards.delete(key); }
    const els = all.map((s) => {
      const c = cards.get(s.key) || card(s.key);
      set(c.title, s.name);
      set(c.meta, s.show ? `Show · ${s.overlays} overlay${s.overlays === 1 ? '' : 's'}` : 'Overlay outside a show');
      c.open.setAttribute('href', s.href);
      c.open.setAttribute('aria-label', `Open ${s.name}`);
      c.status.update(s.stream, { rec: s.rec });
      drawNeeds(c, s);
      return c.el;
    });
    // Moved only when the order changed: moving a card takes the focus off its button.
    const next = all.map((s) => s.key).join('\n');
    if (next !== order) {
      order = next;
      grid.append(...els);
    }
    grid.hidden = !all.length;
    emptyBox.hidden = all.length > 0;
    intro.hidden = !all.length;
  }

  let problemText = '';
  function setProblem(err) {
    const text = err ? (loaded ? `${err.message} Showing what was known at ${new Date(lastOk).toLocaleTimeString()}.` : err.message) : '';
    if (text === problemText) return;
    problemText = text;
    problemBox.hidden = !text;
    mount(problemBox, text ? notice(text, 'danger') : null);
  }
  async function refresh() {
    if (stopped) return;
    let all;
    try {
      all = await read();
    } catch (err) {
      if (!stopped && err.status !== 401) setProblem(err);
      return;
    }
    if (stopped) return;
    loaded = true;
    lastOk = Date.now();
    setProblem(null);
    draw(all);
  }

  mount(emptyBox, h('div.card', empty('Nothing to go live with yet',
    'A stream is a show, or an overlay on its own. Make an overlay from a template, then put overlays that run together in a show.',
    h('a.btn.primary', { href: '#/templates' }, 'Go to Templates'), h('a.btn', { href: '#/shows' }, 'Go to Shows'))));
  await refresh();
  if (!ctx.alive()) return () => { stopped = true; };
  mount(view, pageHead('Live'), h('div.stack', problemBox, intro, grid, emptyBox));

  let soon;
  const stops = [every(STREAMS_POLL_MS, (() => { let first = true; return () => { if (first) { first = false; return undefined; } return refresh(); }; })())];
  if (ctx.can('events:read')) {
    stops.push(api.events(['system.connection'], () => {
      clearTimeout(soon);
      soon = setTimeout(refresh, 300);
    }));
  }
  return () => {
    stopped = true;
    clearTimeout(soon);
    for (const stop of stops) stop();
  };
}

// ---- an overlay outside a show -----------------------------------------------------------------
async function overlayConsole(view, ctx, ref) {
  let overlay;
  try {
    overlay = await api.get(`/api/v1/overlays/${api.seg(ref)}`);
  } catch (err) {
    if (err.status === 401) return undefined;
    if (err.status !== 404) { failed(view, ctx, 'Live', err); return undefined; }
    mount(view, pageHead(`There is no overlay "${ref}"`, { crumbs: [ALL_STREAMS] }),
      h('div.card', empty('It may have been renamed or deleted.', 'Every show and overlay that can go live is on the streams page.', h('a.btn.primary', { href: '#/live' }, 'All streams'))));
    return undefined;
  }
  if (!ctx.alive()) return undefined;
  // In a show: its console, with this overlay chosen.
  if (overlay.show && ctx.can('timeline:read')) {
    ctx.navigate(liveHref({ show: overlay.show, overlay: overlay.slug }), { replace: true });
    return undefined;
  }
  ctx.setTitle(overlay.slug);
  const canControl = ctx.can('overlays:control');
  const status = streamStatus();
  status.update(overlay.stream);
  const alerts = alertsCard(ctx, { queue: overlay.id });
  // Put in a show from here: its console is the show's now, with this overlay chosen.
  const panel = overlayPanel(ctx, {
    ref: overlay.id,
    onOverlay: (o) => status.update(o.stream),
    onAdded: (show) => ctx.navigate(liveHref({ show: show.id, overlay: overlay.slug })),
  });
  mount(view,
    pageHead(overlay.slug, { crumbs: [ALL_STREAMS] }),
    h('div.stack',
      canControl ? null : notice(NO_CONTROL, 'warn'),
      // Set times, the countdown and title cards need a show: said first (show-from-overlay.js).
      panel.needs,
      h('section.card', h('h2.sr-only', 'Stream status'), status.el),
      alerts.el,
      panel.el));
  return () => {
    alerts.stop();
    panel.stop();
  };
}

// ---- the console of one show -------------------------------------------------------------------
async function showConsole(view, ctx, first, shows, { switchTo, reopen, overlay: wantedOverlay }) {
  const canControl = ctx.can('overlays:control');
  const canPreview = ctx.can('overlays:read');
  const base = `/api/v1/shows/${api.seg(first.id)}`;
  const showHref = `#/shows/${api.seg(first.id)}`;
  let show = first;
  let stopped = false;
  let cmdSeq = 0; // a poll that started before a command finished is not applied
  const timers = new Set();

  const [initialCues, loaded] = await Promise.all([
    api.all(`${base}/cues`).then((items) => ({ items }), (err) => ({ err })),
    loadMembers(list(show.members), { urls: canPreview }),
  ]);
  let cues = list(initialCues.items);
  let members = loaded.members;
  let membersKey = list(show.members).join('\n');
  let membersComplete = loaded.complete;
  let membersTriedAt = Date.now();
  let cat = catalog(members.map((m) => m.manifest));
  let nextCue;

  const tz = () => show.timezone;
  // A cue's or an act's time, in the show's zone; with the day when it isn't tonight's.
  const when = (iso) => {
    const t = instant(iso);
    if (t === undefined) return '';
    if (Math.abs(t - api.serverNow()) < 12 * 60 * 60 * 1000) return clock(iso, tz());
    try {
      return new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: tz() }).format(new Date(t));
    } catch {
      return new Date(t).toLocaleString();
    }
  };
  const cueLabel = (cue) => {
    if (cue?.label) return cue.label;
    const a = cue?.action;
    switch (a?.type) {
      case 'show.scene': return `Scene: ${cat.sceneLabel(a.scene)}`;
      case 'overlay.action': return cat.actionLabel(a.name) || cat.sceneLabel(a.name);
      case 'show.slot': return `${typeof a.slot === 'string' ? a.slot : list(show.lineup)[a.slot]?.name || 'An act'} on`;
      case 'media.play': return 'Play a clip';
      case 'media.stop': return 'Stop the clip';
      case 'sequence': return `A sequence of ${list(a.steps).length} steps`;
      default: return 'A cue';
    }
  };

  // ---- commands --------------------------------------------------------------------------------
  const setDisabled = (b, v) => { if (!b.classList.contains('busy') && !b.dataset.cool) b.disabled = v; };
  function cooldown(buttons, after) {
    for (const b of buttons) {
      b.disabled = true;
      b.dataset.cool = '1';
    }
    const t = setTimeout(() => {
      timers.delete(t);
      for (const b of buttons) delete b.dataset.cool;
      if (!stopped) after();
    }, COOL_MS);
    timers.add(t);
  }
  async function command(button, fn, opts) {
    if (!canControl || stopped) return undefined;
    cmdSeq += 1;
    const out = await run(button, fn, opts);
    cmdSeq += 1;
    if (out !== undefined && !stopped) refreshShow();
    return out;
  }

  // ---- head ------------------------------------------------------------------------------------
  let select;
  if (shows.length > 1) {
    select = h('select', { name: 'show', onchange: () => { select.disabled = true; switchTo(select.value); } },
      shows.map((s) => h('option', { value: s.id, selected: s.id === show.id }, s.name)));
  }
  const head = pageHead(show.name || 'Show', {
    crumbs: [ALL_STREAMS],
    actions: [select ? h('div.inline-form', field('Show', select)) : null, h('a.btn.ghost', { href: showHref }, 'Show details')].filter(Boolean),
  });
  const titleEl = head.querySelector('h1');
  const problemBox = h('div', { hidden: true });

  // ---- status: REC, go-live, and the stream: on air, platforms, viewers, connections -----------
  const recBadge = badge('REC', 'danger');
  const recTime = h('span.countdown', '0:00');
  const recOff = h('span.muted', 'REC is not running');
  const recStart = h('button.btn', { type: 'button', disabled: !canControl, onclick: async () => {
    const out = await command(recStart, () => api.post(`${base}/rec`, { action: 'start' }), { done: 'REC started' });
    if (out) applyShow(out);
  } }, 'Start REC');
  const recMenu = menu('REC options', [
    { label: 'Restart REC from 0:00', danger: true, disabled: !canControl, onSelect: () => recAgain('start') },
    { label: 'Reset REC', danger: true, disabled: !canControl, onSelect: () => recAgain('reset') },
  ]);
  async function recAgain(action) {
    const ok = await confirm(action === 'start'
      ? { title: 'Restart REC from 0:00?', consequence: 'The REC timecode on the overlays starts again from 0:00, and the time counted so far is lost.', confirmLabel: 'Restart REC' }
      : { title: 'Reset REC?', consequence: 'The REC timecode stops and disappears from the overlays, and the show counts as off air until REC starts again.', confirmLabel: 'Reset REC' });
    if (!ok || stopped) return;
    const out = await command(null, () => api.post(`${base}/rec`, { action }), { done: action === 'start' ? 'REC restarted from 0:00' : 'REC reset: the show is off air' });
    if (out) applyShow(out);
  }
  const goLiveChip = h('span.chip', { hidden: true });
  const stream = streamStatus();
  const statusCard = h('div.card',
    h('h2.sr-only', 'Show status'),
    h('div.stack',
      h('div.spread', h('div.row', recBadge, recTime, recOff, goLiveChip), h('div.row', recStart, recMenu)),
      stream.el));

  // ---- previews (H13: lite and on tap on a phone; at most two live at once) --------------------
  let previewsOpen = (() => {
    const v = remembered.get(PREVIEWS_KEY);
    return v === 'open' ? true : v === 'closed' ? false : !isPhone();
  })();
  const previewsBody = h('div#live-previews');
  const previewsToggle = h('button.btn.ghost', { type: 'button', 'aria-controls': 'live-previews', onclick: () => {
    previewsOpen = !previewsOpen;
    remembered.set(PREVIEWS_KEY, previewsOpen ? 'open' : 'closed');
    buildPreviews();
  } });
  const previewsHead = h('div.card-head', h('h2', 'Previews'), h('div.actions', previewsToggle));
  const previewsCard = h('div.card', previewsHead, previewsBody);
  let cells = []; // { item, box, el }
  let liveCells = []; // the cells whose preview is loaded, oldest first
  const previewBox = (item, eager) => preview(item.url, { width: item.width, height: item.height, eager, title: `${item.slug} preview, ${item.width} × ${item.height}` });
  function noteLive(cell) {
    if (!cell.box.querySelector('iframe') || liveCells.includes(cell)) return;
    liveCells.push(cell);
    while (liveCells.length > MAX_LIVE_PREVIEWS) {
      const old = liveCells.shift();
      const fresh = previewBox(old.item, false);
      old.box.unload();
      old.box.replaceWith(fresh);
      old.box = fresh;
    }
  }
  function unloadPreviews() {
    for (const c of cells) c.box.unload?.();
    cells = [];
    liveCells = [];
  }
  function buildPreviews() {
    unloadPreviews();
    if (selected) return mount(previewsBody); // one overlay chosen: its panel has its preview
    set(previewsToggle, previewsOpen ? 'Hide' : 'Show');
    previewsToggle.setAttribute('aria-label', previewsOpen ? 'Hide previews' : 'Show previews'); // apart from All cues' Show
    previewsToggle.setAttribute('aria-expanded', String(previewsOpen));
    previewsBody.hidden = !previewsOpen;
    previewsHead.style.marginBottom = previewsOpen ? '' : '0'; // closed, the card is its head alone
    if (!previewsOpen) return mount(previewsBody);
    const items = members.flatMap((m) => m.urls.filter((u) => typeof u?.url === 'string').map((u) => ({
      slug: m.slug, url: u.url, width: u.width > 0 ? u.width : 1920, height: u.height > 0 ? u.height : 1080,
    })));
    if (!items.length) {
      return mount(previewsBody, h('p.muted', !members.length ? 'The show has no overlays to preview yet.' : canPreview ? 'The overlays\' addresses could not be read.' : 'Your role can\'t open the overlays\' addresses.'));
    }
    // Side by side at one height: each cell's basis and growth follow its canvas's width-to-height
    // ratio (an H and a V share a line even at 320 px), and no cell grows past PREVIEW_MAX_H tall.
    const row = h('div.row');
    row.style.alignItems = 'flex-start';
    cells = items.map((item, i) => {
      const cell = { item, box: previewBox(item, i < MAX_LIVE_PREVIEWS ? undefined : false) };
      cell.el = h('div', { onclick: () => noteLive(cell) }, cell.box, h('div.small.truncate', item.slug), h('div.small.muted', `${item.width} × ${item.height}`));
      const ratio = item.width / item.height;
      cell.el.style.flex = `${ratio} 1 ${Math.round(ratio * PREVIEW_BASIS_H)}px`;
      cell.el.style.maxWidth = `${Math.round(ratio * PREVIEW_MAX_H)}px`;
      cell.el.style.minWidth = '0';
      return cell;
    });
    mount(row, cells.map((c) => c.el));
    mount(previewsBody, row);
    for (const c of cells) noteLive(c);
    return undefined;
  }

  // ---- the whole show, or one of its overlays --------------------------------------------------
  // "Whole show" is the console as it always was; an overlay's own panel (live-overlay.js) has its
  // preview, URLs, actions and Simulate. The choice is kept in the address (&overlay=), so a reload
  // keeps it.
  let selected; // the slug of the overlay chosen, or undefined for the whole show
  let panel; // its panel: { el, stop }
  const selectorBox = h('div.row', { role: 'group', 'aria-label': 'Whole show or one overlay' });
  const wholeBox = h('div.stack');
  const overlayBox = h('div');
  let selectorKey;
  function buildSelector() {
    const slugs = members.filter((m) => m.overlay).map((m) => m.slug);
    const key = slugs.join('\n');
    if (key === selectorKey) return;
    selectorKey = key;
    const choice = (label, slug, aria) => h('button.btn', { type: 'button', 'aria-pressed': String(selected === slug), 'aria-label': aria, dataset: { overlay: slug || '' }, onclick: () => choose(slug) }, label);
    mount(selectorBox, slugs.length ? [choice('Whole show', undefined), slugs.map((s) => choice(s, s, `Overlay ${s}`))] : null);
    selectorBox.hidden = !slugs.length;
    if (selected && !slugs.includes(selected)) choose(undefined);
  }
  function choose(slug, { initial = false } = {}) {
    if (slug === selected && !initial) return;
    selected = slug;
    for (const b of selectorBox.querySelectorAll('button')) b.setAttribute('aria-pressed', String((b.dataset.overlay || undefined) === slug));
    panel?.stop();
    panel = undefined;
    wholeBox.hidden = !!slug;
    if (slug) {
      const m = members.find((x) => x.slug === slug);
      panel = overlayPanel(ctx, { ref: m?.overlay?.id || slug, show: show.name || 'this show', onWholeShow: () => {
        choose(undefined);
        selectorBox.querySelector('button')?.focus(); // the panel that had the focus is gone
      } });
      mount(overlayBox, panel.el);
      if (!initial) buildPreviews(); // unloads the whole show's
    } else {
      mount(overlayBox);
      if (!initial) buildPreviews();
    }
    if (!initial && ctx.alive()) history.replaceState(null, '', `#${liveHref({ show: show.id, overlay: slug })}`);
  }

  // ---- scenes ----------------------------------------------------------------------------------
  const scenesBody = h('div.stack');
  const returnNote = h('div.small.muted', { hidden: true });
  // The scene OBS took last (Follow OBS, 09 §9.7), until another take.
  const obsNote = h('div.small.obs-note', { hidden: true });
  const scenesCard = h('div.card', h('div.card-head', h('h2', 'Scenes')), h('div.stack', scenesBody, obsNote, returnNote));
  let sceneButtons = new Map();
  function sceneButton(s) {
    const b = h('button.btn', { type: 'button', 'aria-pressed': 'false', disabled: !canControl, onclick: async () => {
      const out = await command(b, () => api.put(`${base}/scene`, { scene: s.key }), { done: `Scene changed to ${s.label}` });
      if (out) applyShow(out);
    } }, sceneText(s));
    sceneButtons.set(s.key, b);
    return b;
  }
  function buildScenes() {
    sceneButtons = new Map();
    if (!members.length) {
      return mount(scenesBody, h('p.muted', 'This show has no overlays yet. ', h('a', { href: showHref }, 'Add them on the show\'s page'), '.'));
    }
    if (!cat.scenes.length) {
      return mount(scenesBody, h('p.muted', membersComplete ? 'The show\'s templates have no scenes to take.' : 'The scenes could not be read yet; trying again.'));
    }
    const core = cat.scenes.filter((s) => s.core);
    const extras = cat.scenes.filter((s) => !s.core);
    return mount(scenesBody,
      core.length ? h('div.pad', { role: 'group', 'aria-label': 'Scenes' }, core.map(sceneButton)) : null,
      extras.length ? h('div', h('h3', 'Extras'), h('div.pad', { role: 'group', 'aria-label': 'Extras' }, extras.map(sceneButton))) : null);
  }
  function renderScenes() {
    const active = cat.sceneKey(show.scene);
    for (const [key, b] of sceneButtons) b.setAttribute('aria-pressed', String(key === active));
    const byObs = byObsWords(show.sceneByObs, tz());
    obsNote.hidden = !byObs;
    set(obsNote, byObs ? `${cat.sceneLabel(show.scene)}: ${byObs}` : '');
  }

  // ---- actions ---------------------------------------------------------------------------------
  const actionsBody = h('div');
  const actionsCard = h('div.card', h('div.card-head', h('h2', 'Actions')), actionsBody);
  function buildActions() {
    if (!cat.actions.length) {
      return mount(actionsBody, h('p.muted', members.length ? 'The show\'s templates have no actions.' : 'Actions appear once the show has overlays.'));
    }
    return mount(actionsBody, h('div.pad', { role: 'group', 'aria-label': 'Actions' }, cat.actions.map((a) => {
      const b = h('button.btn', { type: 'button', disabled: !canControl, onclick: () => command(b, () => api.post(`${base}/triggers/${api.seg(a.key)}`, {}), { done: `${a.label} on air` }) }, a.label);
      return b;
    })));
  }

  // ---- timeline: the next cue ------------------------------------------------------------------
  const nextLabel = h('strong');
  const nextWhen = h('div.small.muted');
  const nextCount = h('div.countdown.nowrap');
  const nextFire = h('button.btn.primary', { type: 'button', disabled: !canControl, onclick: () => cueOp(nextCue, 'fire', nextFire, true) }, 'Trigger now');
  const nextSkip = h('button.btn', { type: 'button', disabled: !canControl, onclick: () => cueOp(nextCue, 'skip', nextSkip, true) }, 'Skip');
  const nextBox = h('div.stack',
    h('div.spread', h('div', h('div.small.muted', 'Next cue'), h('div', nextLabel), nextWhen), nextCount),
    h('div.row', nextFire, nextSkip));
  const nextEmptyText = h('span');
  const nextEmptyLink = h('a', { href: showHref }, 'Build one from the lineup on the show\'s page');
  const nextEmpty = h('p.muted', { hidden: true }, nextEmptyText, nextEmptyLink);
  const lastLine = h('div.small.muted', { hidden: true });
  const cuesProblem = h('div', { hidden: true });
  const timelineCard = h('div.card', h('div.card-head', h('h2', 'Timeline')), h('div.stack', cuesProblem, nextBox, nextEmpty, lastLine));
  function showCuesProblem(err) {
    cuesProblem.hidden = !err;
    mount(cuesProblem, err ? notice(`The timeline could not be read: ${err.message}`, 'warn') : null);
  }
  function renderNext() {
    nextCue = cues.find((c) => c?.status === 'armed');
    nextBox.hidden = !nextCue;
    nextEmpty.hidden = !!nextCue;
    if (nextCue) {
      set(nextLabel, cueLabel(nextCue));
      set(nextWhen, `At ${when(nextCue.at)}${nextCue.clockGap || nextCue.clockOverlap ? ' (on a clock change)' : ''}`);
    } else {
      set(nextEmptyText, cues.length ? 'Nothing else is scheduled.' : 'No timeline for this show yet. ');
      nextEmptyLink.hidden = cues.length > 0;
    }
    setDisabled(nextFire, !canControl || !nextCue);
    setDisabled(nextSkip, !canControl || !nextCue);
    const last = cues.filter((c) => c?.status === 'fired' && instant(c.firedAt) !== undefined).sort((a, b) => instant(b.firedAt) - instant(a.firedAt))[0];
    lastLine.hidden = !last;
    if (last) set(lastLine, `Last: ${cueLabel(last)} at ${when(last.firedAt)}${last.error ? `. It didn't play: ${last.error}` : ''}`);
  }
  async function cueOp(cue, op, button, cool) {
    if (!cue || stopped) return;
    const label = cueLabel(cue);
    const out = await command(button, () => api.post(`${base}/cues/${api.seg(cue.id)}/${op}`, {}));
    if (!out || stopped) return;
    if (cool) cooldown([nextFire, nextSkip], renderNext);
    if (op === 'fire') {
      if (out.error) toast(`"${label}" didn't play: ${out.error}`, { kind: 'error' });
      else toast(`"${label}" triggered`);
    } else if (op === 'skip') {
      toast(`"${label}" skipped`);
    } else {
      const late = api.serverNow() - (instant(out.at) ?? api.serverNow());
      if (late > GRACE_MS) toast(`"${label}" is back on the timeline, but its time has passed, so it will be marked missed. Use Trigger now to play it.`, { ms: 8000 });
      else if (late > 0) toast(`"${label}" is back on the timeline: it plays now.`);
      else toast(`"${label}" is back on the timeline for ${when(out.at)}`);
    }
    cues = cues.map((c) => (c?.id === out.id ? out : c));
    renderTimeline();
  }

  // ---- timeline: every cue ---------------------------------------------------------------------
  let cuesOpen = remembered.get(CUES_KEY) === 'open';
  const cueCount = h('span.muted');
  const cueList = h('ul.list#live-cues');
  const cueEmpty = h('p.muted', { hidden: true }, 'No cues yet.');
  const cuesToggle = h('button.btn.ghost', { type: 'button', 'aria-controls': 'live-cues', onclick: () => {
    cuesOpen = !cuesOpen;
    remembered.set(CUES_KEY, cuesOpen ? 'open' : 'closed');
    renderCues();
  } });
  const cuesHead = h('div.card-head', h('h2', 'All cues'), cueCount, h('div.actions', cuesToggle));
  const cuesCard = h('div.card', cuesHead, cueList, cueEmpty);
  const rows = new Map(); // cue id → its row, kept while the cue exists
  function cueRow(id) {
    const row = { cue: undefined };
    row.time = h('span.small.nowrap');
    row.label = h('span');
    row.state = h('span.badge');
    row.clock = clockBadge();
    row.error = h('div.small.muted', { hidden: true });
    row.menu = menu('More', [
      { label: 'Trigger now', disabled: !canControl, onSelect: () => cueOp(row.cue, 'fire') },
      { label: 'Skip', disabled: !canControl, onSelect: () => cueOp(row.cue, 'skip') },
      { label: 'Put back on the timeline', disabled: !canControl, onSelect: () => cueOp(row.cue, 'rearm') },
    ]);
    [row.fireItem, row.skipItem, row.rearmItem] = row.menu.querySelectorAll('[role="menuitem"]');
    row.summary = row.menu.querySelector('summary');
    row.li = h('li', row.time, h('div.grow', h('div', row.label, ' ', row.state, ' ', row.clock), row.error), row.menu);
    rows.set(id, row);
    return row;
  }
  const STATES = { fired: ['Done', 'ok'], skipped: ['Skipped'], missed: ['Missed', 'warn'] };
  function updateRow(row, cue, isNext) {
    row.cue = cue;
    const label = cueLabel(cue);
    set(row.time, when(cue.at));
    set(row.label, label);
    const [text, kind] = cue.status === 'armed' ? (isNext ? ['Next', 'accent'] : ['Upcoming']) : STATES[cue.status] || [String(cue.status || 'Unknown')];
    set(row.state, text);
    row.state.className = kind ? `badge ${kind}` : 'badge';
    row.clock.hidden = !(cue.clockGap || cue.clockOverlap);
    row.error.hidden = !cue.error;
    set(row.error, cue.error ? `It didn't play: ${cue.error}` : '');
    if (row.skipItem) row.skipItem.hidden = cue.status !== 'armed';
    if (row.rearmItem) row.rearmItem.hidden = cue.status !== 'skipped' && cue.status !== 'missed';
    row.summary?.setAttribute('aria-label', `More for ${label}`);
  }
  function renderCues() {
    set(cuesToggle, cuesOpen ? 'Hide' : 'Show');
    cuesToggle.setAttribute('aria-label', cuesOpen ? 'Hide all cues' : 'Show all cues');
    cuesToggle.setAttribute('aria-expanded', String(cuesOpen));
    const ids = new Set();
    const order = [];
    for (const cue of cues) {
      if (!cue || typeof cue.id !== 'string') continue;
      ids.add(cue.id);
      const row = rows.get(cue.id) || cueRow(cue.id);
      updateRow(row, cue, cue === nextCue);
      order.push(row.li);
    }
    for (const [id, row] of rows) {
      if (!ids.has(id)) {
        row.li.remove();
        rows.delete(id);
      }
    }
    // Moved only when the order changed: moving a row takes the focus off it.
    if (order.length !== cueList.children.length || order.some((li, i) => cueList.children[i] !== li)) cueList.append(...order);
    set(cueCount, `(${order.length})`);
    cueList.hidden = !cuesOpen || !order.length;
    cueEmpty.hidden = !cuesOpen || order.length > 0;
    cuesHead.style.marginBottom = cuesOpen ? '' : '0';
  }
  function renderTimeline() {
    renderNext();
    renderCues();
    tick();
  }

  // ---- who's on --------------------------------------------------------------------------------
  const onNow = h('p', { 'aria-live': 'polite' });
  const nextAct = h('button.btn.primary', { type: 'button', disabled: !canControl, onclick: async () => {
    const next = nextActOf();
    if (!next) return;
    const out = await setSlot(next.i, nextAct, actName(next.s));
    if (out) cooldown([nextAct], renderLineup);
  } }, 'Next act');
  const nobody = h('button.btn', { type: 'button', disabled: !canControl, onclick: () => setSlot(null, nobody) }, 'Nobody on');
  const slotControls = h('div.row', nextAct, nobody);
  const lineupList = h('ul.list');
  const lineupEmpty = h('p.muted', { hidden: true }, 'The lineup is empty. ', h('a', { href: showHref }, 'Add acts on the show\'s page'), '.');
  const lineupCard = h('div.card', h('div.card-head', h('h2', 'Who\'s on')), h('div.stack', onNow, slotControls, lineupList, lineupEmpty));
  let lineupKey;
  let slotRows = [];
  const slotOrder = () => list(show.lineup).map((s, i) => ({ s, i })).filter((x) => x.s && typeof x.s === 'object')
    .sort((a, b) => (instant(a.s.startAt) ?? 0) - (instant(b.s.startAt) ?? 0) || a.i - b.i);
  const currentSlot = () => (Number.isInteger(show.currentSlot) && show.currentSlot >= 0 && show.currentSlot < list(show.lineup).length ? show.currentSlot : undefined);
  function nextActOf() {
    const ord = slotOrder();
    const cur = currentSlot();
    const at = cur === undefined ? -1 : ord.findIndex((x) => x.i === cur);
    return ord[at + 1];
  }
  async function setSlot(index, button, name) {
    const out = await command(button, () => api.put(`${base}/slot`, { slot: index }), { done: index === null ? 'Nobody is on now' : `${name} is on` });
    if (out) applyShow(out);
    return out;
  }
  function buildLineup() {
    const focused = slotRows.findIndex((r) => r.li.contains(document.activeElement));
    slotRows = slotOrder().map(({ s, i }) => {
      const name = actName(s);
      const put = h('button.btn', { type: 'button', disabled: !canControl, 'aria-label': `Put ${name} on`, onclick: () => setSlot(i, put, name) }, 'Put on');
      const on = badge('On now', 'accent');
      const li = h('li',
        h('span.small.muted.nowrap', when(s.startAt) || s.time || ''),
        h('span.grow', h('span', name), s.headliner ? [' ', badge('Headliner')] : null, s.closer ? [' ', badge('Closer')] : null, s.clockGap || s.clockOverlap ? [' ', clockBadge()] : null),
        on, put);
      return { i, li, put, on };
    });
    mount(lineupList, slotRows.map((r) => r.li));
    if (focused >= 0) slotRows[Math.min(focused, slotRows.length - 1)]?.put.focus();
  }
  function renderLineup() {
    const lineup = list(show.lineup);
    const key = JSON.stringify([tz(), lineup.map((s) => [s?.name, s?.b2b, s?.time, s?.startAt, s?.headliner, s?.closer, s?.clockGap, s?.clockOverlap])]);
    if (key !== lineupKey) {
      lineupKey = key;
      buildLineup();
    }
    const cur = currentSlot();
    for (const r of slotRows) {
      r.on.hidden = r.i !== cur;
      r.put.hidden = r.i === cur;
    }
    const empty = lineup.length === 0;
    for (const el of [onNow, slotControls, lineupList]) el.hidden = empty;
    lineupEmpty.hidden = !empty;
    set(onNow, cur === undefined ? 'Nobody is on.' : `On now: ${actName(lineup[cur])}`);
    const next = nextActOf();
    set(nextAct, next ? `Next act: ${actName(next.s)}` : 'Last act is on');
    setDisabled(nextAct, !canControl || !next);
    setDisabled(nobody, !canControl || cur === undefined);
  }

  // ---- state from the server -------------------------------------------------------------------
  function renderStatus() {
    // On air is what the show's connections say (show.stream); REC (show.live) is its own row.
    stream.update(show.stream);
    const recOn = instant(show.recStartedAt) !== undefined;
    recBadge.hidden = !recOn;
    recTime.hidden = !recOn;
    recOff.hidden = recOn;
    recStart.hidden = recOn;
    recMenu.hidden = !recOn;
  }
  // Every second: REC, go-live, the next cue's countdown and a timed scene's return, in server time.
  function tick() {
    const now = api.serverNow();
    const rec = instant(show.recStartedAt);
    if (rec !== undefined) set(recTime, countdown(Math.max(0, now - rec)));
    const goLive = instant(show.goLiveAt);
    goLiveChip.hidden = goLive === undefined;
    if (goLive !== undefined) {
      const at = clock(show.goLiveAt, tz());
      set(goLiveChip, goLive > now && show.live !== true ? `Goes live at ${at} · in ${until(goLive - now)}` : `Go-live ${at}`);
    }
    if (nextCue) {
      const ms = (instant(nextCue.at) ?? now) - now;
      set(nextCount, ms > 0 ? `in ${until(ms)}` : 'due now');
    }
    const ret = show.sceneReturn;
    const back = instant(ret?.at);
    const returning = back !== undefined && back > now && cat.sceneKey(ret.from) === cat.sceneKey(show.scene);
    returnNote.hidden = !returning;
    if (returning) set(returnNote, `Back to ${cat.sceneLabel(ret.then)} in ${until(back - now)}`);
  }
  // A show as the API answered it (a poll, or a command's answer); an older one is ignored. stateRev
  // moves with every change, live control included (rev, the ETag, only with edits).
  function applyShow(next) {
    if (!next || typeof next !== 'object' || next.id !== show.id) return false;
    if (Number.isInteger(next.stateRev) && Number.isInteger(show.stateRev) && next.stateRev < show.stateRev) return false;
    show = next;
    set(titleEl, show.name || 'Show');
    const option = select && [...select.options].find((o) => o.value === show.id);
    if (option) set(option, show.name || 'Show');
    reloadMembers();
    renderStatus();
    renderScenes();
    renderLineup();
    renderTimeline();
    return true;
  }
  // Members added or removed (or not all read last time): their templates and previews again.
  let reloading = false;
  async function reloadMembers() {
    const slugs = list(show.members);
    const key = slugs.join('\n');
    if (reloading || (key === membersKey && (membersComplete || Date.now() - membersTriedAt < MEMBERS_RETRY_MS))) return;
    reloading = true;
    membersTriedAt = Date.now();
    try {
      const next = await loadMembers(slugs, { urls: canPreview });
      if (stopped) return;
      const urlsChanged = JSON.stringify(members.map((m) => [m.slug, m.urls])) !== JSON.stringify(next.members.map((m) => [m.slug, m.urls]));
      members = next.members;
      membersKey = key;
      membersComplete = next.complete;
      cat = catalog(members.map((m) => m.manifest));
      buildSelector();
      buildScenes();
      buildActions();
      if (urlsChanged) buildPreviews();
      renderScenes();
      renderTimeline();
    } finally {
      reloading = false;
    }
  }

  let lastOk = Date.now();
  let problemText = '';
  function setProblem(err) {
    const text = err ? `${err.message} Showing what was known at ${new Date(lastOk).toLocaleTimeString()}.` : '';
    if (text === problemText) return;
    problemText = text;
    problemBox.hidden = !text;
    mount(problemBox, text ? notice(text, 'danger') : null);
  }
  // The show and its cues are read side by side, each on its own: cues that can't be read (no
  // timeline:read, a hiccup) leave the scenes, REC and the lineup updating, and the other way round.
  async function refreshShow() {
    if (stopped) return;
    const seq = cmdSeq;
    const [showR, cuesR] = await Promise.allSettled([api.get(base), api.all(`${base}/cues`)]);
    if (stopped) return;
    const err = showR.status === 'rejected' ? showR.reason : undefined;
    if (err?.status === 401 || cuesR.reason?.status === 401) return;
    if (err?.status === 404) {
      stopped = true;
      toast('That show was deleted.', { kind: 'error' });
      reopen();
      return;
    }
    if (err) setProblem(err);
    else {
      lastOk = Date.now();
      setProblem(null);
    }
    showCuesProblem(cuesR.status === 'rejected' ? cuesR.reason : null);
    if (seq !== cmdSeq) return; // a command answered meanwhile: the next poll is newer
    if (cuesR.status === 'fulfilled') cues = list(cuesR.value);
    if (err || !applyShow(showR.value)) renderTimeline();
  }
  // ---- the page --------------------------------------------------------------------------------
  const alerts = alertsCard(ctx, { queue: show.id });
  mount(wholeBox,
    previewsCard,
    h('div.grid.wide', h('div.stack', scenesCard, actionsCard), h('div.stack', timelineCard, lineupCard)),
    cuesCard);
  mount(view,
    head,
    h('div.stack',
      canControl ? null : notice(NO_CONTROL, 'warn'),
      problemBox,
      statusCard,
      selectorBox,
      alerts.el,
      wholeBox,
      overlayBox));
  buildSelector();
  if (wantedOverlay && members.some((m) => m.overlay && m.slug === wantedOverlay)) choose(wantedOverlay, { initial: true });
  buildScenes();
  buildActions();
  buildPreviews();
  showCuesProblem(initialCues.err);
  renderStatus();
  renderScenes();
  renderLineup();
  renderTimeline();

  let skipFirst = true; // the page was just read; the poll starts 2 s from now
  const stops = [
    every(SHOW_POLL_MS, () => {
      if (skipFirst) { skipFirst = false; return undefined; }
      return refreshShow();
    }),
    every(1000, tick),
    alerts.stop,
  ];
  return () => {
    stopped = true;
    for (const stop of stops) stop();
    for (const t of timers) clearTimeout(t);
    timers.clear();
    unloadPreviews();
    panel?.stop();
  };
}

// ---- the alert queue (05 §5.5) -------------------------------------------------------------------
// What is on screen and what waits, with Skip, Replay and Pause: in one stream's queue (queue: the
// show's id, or the overlay's outside a show), else in every queue. Pause holds every stream's.
// Polled every 2 s while the page is open. Returns { el, stop }.
const ALERT_WORDS = { follow: 'Follow', subscription: 'Sub', gift: 'Gifted subs', cheer: 'Cheer', kicks: 'Kicks', raid: 'Raid', membership: 'Membership', superchat: 'Super Chat', tip: 'Tip' };
const alertText = (a) => `${ALERT_WORDS[a.kind] || 'Alert'}${a.user ? ` from ${a.user}` : ''}`;

function alertsCard(ctx, { queue } = {}) {
  const canControl = ctx.can('overlays:control');
  const pausedBadge = badge('Paused', 'warn');
  pausedBadge.hidden = true;
  const body = h('div.stack');
  const pauseBtn = h('button.btn', { type: 'button', disabled: !canControl }, 'Pause alerts');
  let state = { paused: false, queues: [] };
  const el = h('div.card', h('div.card-head', h('h2', 'Alerts'), pausedBadge, h('div.actions', pauseBtn)), body);
  pauseBtn.onclick = () => run(pauseBtn, async () => {
    state = await api.post(`/api/v1/alerts/${state.paused ? 'resume' : 'pause'}`, {});
    render();
  }, { done: () => (state.paused ? 'Alerts paused: they wait until you resume' : 'Alerts resumed') });

  function render() {
    pausedBadge.hidden = !state.paused;
    pauseBtn.textContent = state.paused ? 'Resume alerts' : 'Pause alerts';
    const queues = list(state.queues).filter((q) => queue === undefined || q?.queue === queue);
    const note = queue !== undefined ? h('p.small.muted', 'Pause holds the alerts of every stream, not only this one.') : null;
    if (!queues.length) {
      mount(body, h('p.muted', `No alerts yet tonight${queue !== undefined ? ' on this stream' : ''}. Each one plays in turn here when it arrives (try Simulate on an overlay).`), note);
      return;
    }
    mount(body, note, queues.map((q) => {
      const showing = list(q.showing);
      const waiting = list(q.waiting);
      const skip = h('button.btn', { type: 'button', disabled: !canControl || !showing.length, 'aria-label': `Skip the alert on screen in ${q.name}` }, 'Skip');
      skip.onclick = () => run(skip, async () => { state = await api.post('/api/v1/alerts/skip', { queue: q.queue }); render(); }, { done: 'Alert skipped' });
      const replay = h('button.btn', { type: 'button', disabled: !canControl, 'aria-label': `Replay the last alert in ${q.name}` }, 'Replay last');
      replay.onclick = () => run(replay, async () => { state = await api.post('/api/v1/alerts/replay', { queue: q.queue }); render(); }, { done: 'The last alert plays again' });
      return h('div.stack',
        queues.length > 1 ? h('h3', q.kind === 'show' ? `Show: ${q.name}` : q.name) : null,
        h('p', showing.length ? `On screen: ${showing.map(alertText).join(', ')}` : 'Nothing on screen'),
        h('p.small.muted', waiting.length ? `Waiting (${waiting.length}): ${waiting.slice(0, 5).map(alertText).join(', ')}${waiting.length > 5 ? ', …' : ''}` : 'Nothing waiting'),
        h('div.row', skip, replay));
    }));
  }

  async function refresh() {
    try {
      state = await api.get('/api/v1/alerts');
      render();
    } catch (err) {
      if (err.status !== 401) mount(body, notice(err.message, 'danger'));
    }
  }
  render();
  refresh();
  const stop = every(SHOW_POLL_MS, refresh);
  return { el, stop };
}
