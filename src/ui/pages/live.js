// The show-night console (08 §8.4), the default landing page: built for a phone held in one hand,
// under pressure. One show at a time: previews of its overlays, its scenes and the templates'
// actions, who's on, REC, and the timeline with its next cue. With no show yet, it controls the
// overlays outside a show.
//
// Everything here is a command (no If-Match, README H16). It polls the show and its cues every 2 s
// and the viewer count every 5 s, and updates the page in place, so focus, scroll and loaded
// previews stay; countdowns tick every second in server time.
import * as api from '../api.js';
import { badge, clock, confirm, countdown, empty, every, field, h, isPhone, menu, mount, notice, pageHead, preview, run, toast } from '../dom.js';

const SHOW_KEY = 'skp.live.show';
const PREVIEWS_KEY = 'skp.live.previews';
const CUES_KEY = 'skp.live.cues';
const SHOW_POLL_MS = 2000;
const STATE_POLL_MS = 5000;
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
const numbers = new Intl.NumberFormat();
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

// The show day a show is on now, in its zone: before its day boundary, the night before's (09 §9.2).
function showDayNow(show) {
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: show.timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date(api.serverNow())).map((p) => [p.type, p.value]));
    const date = `${parts.year}-${parts.month}-${parts.day}`;
    if (typeof show.dayBoundary === 'string' && `${parts.hour}:${parts.minute}` < show.dayBoundary) {
      const d = new Date(`${date}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() - 1);
      return d.toISOString().slice(0, 10);
    }
    return date;
  } catch {
    return undefined;
  }
}

// Which show: the one asked for (?show=), the one chosen last time, one on air, tonight's, the first.
function pickShow(shows, wanted) {
  const find = (ref) => ref && shows.find((s) => s.id === ref || (typeof s.name === 'string' && s.name.toLowerCase() === String(ref).toLowerCase()));
  return find(wanted) || find(remembered.get(SHOW_KEY)) || shows.find((s) => s.live === true) || shows.find((s) => s.date && s.date === showDayNow(s)) || shows[0];
}

export async function live(view, ctx) {
  ctx.setTitle('Live');
  const page = { gone: false, seq: 0, stop: undefined };
  const open = async (wanted) => {
    const seq = ++page.seq;
    page.stop?.();
    page.stop = undefined;
    const stop = await start(view, ctx, { wanted, switchTo, reopen });
    if (page.gone || seq !== page.seq) stop?.();
    else page.stop = stop;
  };
  const reopen = () => open().catch((err) => toast(err));
  const switchTo = (id) => {
    remembered.set(SHOW_KEY, id);
    open(id).catch((err) => toast(err));
  };
  await open(ctx.query.get('show') || undefined);
  return () => {
    page.gone = true;
    page.stop?.();
    page.stop = undefined;
  };
}

async function start(view, ctx, opts) {
  let shows;
  try {
    shows = await api.all('/api/v1/shows');
  } catch (err) {
    if (err.status === 401) return undefined; // signing in again
    mount(view, pageHead('Live'), notice(err.message, 'danger'),
      h('div.row', h('button.btn.primary', { type: 'button', onclick: () => opts.reopen() }, 'Try again')));
    return undefined;
  }
  if (!shows.length) return standalone(view, ctx);
  return showConsole(view, ctx, pickShow(shows, opts.wanted), shows, opts);
}

// ---- the console of one show -------------------------------------------------------------------
async function showConsole(view, ctx, first, shows, { switchTo, reopen }) {
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
    crumbs: [{ label: 'Live' }],
    actions: [select ? h('div.inline-form', field('Show', select)) : null, h('a.btn.ghost', { href: showHref }, 'Show details')].filter(Boolean),
  });
  const titleEl = head.querySelector('h1');
  const problemBox = h('div', { hidden: true });

  // ---- status: REC, on air, go-live, viewers ---------------------------------------------------
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
  const airDot = h('span.dot', { 'aria-hidden': 'true' });
  const airText = h('span', 'Off air');
  const goLiveChip = h('span.chip', { hidden: true });
  const viewersChip = h('span.chip', { hidden: true });
  const statusCard = h('div.card',
    h('h2.sr-only', 'Show status'),
    h('div.stack',
      h('div.spread', h('div.row', recBadge, recTime, recOff), h('div.row', recStart, recMenu)),
      h('div.chips', h('span.chip', airDot, airText), goLiveChip, viewersChip)));

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

  // ---- scenes ----------------------------------------------------------------------------------
  const scenesBody = h('div.stack');
  const returnNote = h('div.small.muted', { hidden: true });
  const scenesCard = h('div.card', h('div.card-head', h('h2', 'Scenes')), h('div.stack', scenesBody, returnNote));
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
    const live = show.live === true;
    airDot.className = live ? 'dot ok' : 'dot';
    set(airText, live ? 'On air' : 'Off air');
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
  // The viewer count, only when it is known and current (H6: never a wrong number).
  async function refreshState() {
    if (stopped) return;
    let total;
    try {
      const state = await api.get('/api/v1/state');
      const value = state?.['viewers.total'];
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && state['viewers.stale'] !== true) total = Math.round(value);
    } catch { /* unknown: hidden */ }
    if (stopped) return;
    viewersChip.hidden = total === undefined;
    if (total !== undefined) set(viewersChip, `${numbers.format(total)} viewer${total === 1 ? '' : 's'}`);
  }

  // ---- the page --------------------------------------------------------------------------------
  mount(view,
    head,
    h('div.stack',
      canControl ? null : notice(NO_CONTROL, 'warn'),
      problemBox,
      statusCard,
      previewsCard,
      h('div.grid.wide', h('div.stack', scenesCard, actionsCard), h('div.stack', timelineCard, lineupCard)),
      cuesCard));
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
  ];
  if (ctx.can('events:read')) stops.push(every(STATE_POLL_MS, refreshState));
  return () => {
    stopped = true;
    for (const stop of stops) stop();
    for (const t of timers) clearTimeout(t);
    timers.clear();
    unloadPreviews();
  };
}

// ---- no show yet: the overlays outside a show --------------------------------------------------
async function standalone(view, ctx) {
  const canControl = ctx.can('overlays:control');
  let overlays = [];
  let problem;
  try {
    overlays = (await api.all('/api/v1/overlays')).filter((o) => o && typeof o.slug === 'string' && !o.show);
  } catch (err) {
    if (err.status === 401) return undefined;
    problem = err;
  }
  const manifestOf = await pinnedManifests(overlays, (p) => p.catch(() => undefined));
  mount(view,
    pageHead('Live'),
    h('div.stack',
      canControl ? null : notice(NO_CONTROL, 'warn'),
      h('div.card', empty('No show yet',
        'A show is the overlays that change together on the night, with the lineup and the timeline. Make one in Shows; until then, control each overlay on its own here.',
        h('a.btn.primary', { href: '#/shows' }, 'Go to Shows'), h('a.btn', { href: '#/overlays' }, 'Go to Overlays'))),
      h('section',
        h('h2', 'Overlays outside a show'),
        problem ? notice(problem.message, 'danger')
          : overlays.length ? h('div.grid.wide', overlays.map((o) => overlayControls(o, manifestOf(o), canControl)))
            : h('p.muted', 'No overlays yet. Make one from a template in Templates.'))));
  return undefined;
}

function overlayControls(overlay, manifest, canControl) {
  const slug = overlay.slug;
  const path = `/api/v1/overlays/${api.seg(slug)}`;
  const cat = catalog([manifest]);
  const button = (label, fn, done) => {
    const b = h('button.btn', { type: 'button', disabled: !canControl, onclick: () => run(b, fn, { done }) }, label);
    return b;
  };
  const status = overlay.status && overlay.status !== 'ok'
    ? badge(overlay.status === 'template-missing' ? 'Template missing' : 'Template can\'t load', 'warn')
    : null;
  return h('div.card',
    h('div.card-head', h('h3', slug), status),
    h('div.stack',
      !manifest ? h('p.muted', 'Its template isn\'t available, so there is nothing to control here.') : null,
      cat.scenes.length
        ? h('div', h('p.small.muted', 'Scenes'), h('div.pad', { role: 'group', 'aria-label': `Scenes of ${slug}` },
          cat.scenes.map((s) => button(sceneText(s), () => api.put(`${path}/scene`, { scene: s.key }), `${slug}: scene changed to ${s.label}`))))
        : manifest ? h('p.muted', 'Its template has no scenes.') : null,
      cat.actions.length
        ? h('div', h('p.small.muted', 'Actions'), h('div.pad', { role: 'group', 'aria-label': `Actions of ${slug}` },
          cat.actions.map((a) => button(a.label, () => api.post(`${path}/actions/${api.seg(a.key)}`, {}), `${slug}: ${a.label} on air`))))
        : null));
}
