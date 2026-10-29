// One overlay on the Live page (08 §8.4): what an operator needs of it on the night, without
// leaving Live. Its preview (one, lite and on tap on a phone, H13), its URLs for OBS with their
// canvas sizes, its template's actions, Simulate, what feeds it, and its scenes: its own outside a
// show; inside one, scenes are the show's (members share them; the API refuses a scene on a member).
//
// overlayPanel(ctx, { ref, show, onWholeShow, onOverlay, onAdded }) → { el, needs, stop }. show:
// the show's name when the overlay is in one. onOverlay(overlay): each time it is read (every 3 s),
// for the page's status. needs: outside a show, when its template reads who's on from one (set
// times, title cards), the notice that says so with "Make a show from this overlay" and "Add it to
// a show" once there is a show (show-from-overlay.js; "Add it to <show>" first for the one plainly
// its), for the page to put first; onAdded(show) once it is in one. A template that reads only a
// show's times (a clock) gets no notice here.
// Everything here is a command (no If-Match, README H16) but "Fed by", which links to the overlay's
// settings, where it is edited.
//
// An action pressed says what it did (firedText, the show's console too): a timed one is on air,
// a held card until hidden, Hide and Stop done, any other sent; outside a show, a card that names
// the act on now is sent with no act to name. Play The Line's clip with no clip chosen says so
// (withoutMedia), and an action the overlay's settings draw nothing for (TAKEOVER's chips outside
// its event look, action-needs.js) is sent, "but it shows nothing", with why (readDrawn), said
// under the buttons too (quietLine).
import * as api from '../api.js';
import { drawnOnlySo, MEDIA_ACTIONS, notDrawn } from '../action-needs.js';
import { badge, copyField, empty, every, field, h, mount, notice, preview, run, toast } from '../dom.js';
import { byObsWords } from '../obs.js';
import { needsShow, showNotice, suggestedShow } from '../show-from-overlay.js';
import { connectionChip, fedByWords } from '../streams.js';
import { SIMULATIONS } from './overlays.js';

const POLL_MS = 3000;
const list = (v) => (Array.isArray(v) ? v : []);
const andList = (items) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

// ---- what an action's button says it did ---------------------------------------------------
// The cards that name the act on now (the server's list is ACT_CARDS in src/shows/timeline.js, which
// the UI can't import): fired from a button, with no act named, one names whoever is on, which
// only a show has.
export const ACT_CARDS = ['titleCard', 'nowPlaying', 'nowPlayingHold'];
// An action that plays the media a setting names (TAKEOVER's Play The Line's clip, action-needs.js):
// with none chosen it plays nothing, which is said instead of "sent".
export { MEDIA_ACTIONS };
// What an action did, after its label: a timed one (durationMs in the manifest) is on air for its
// time; a card with no time stays until hidden (Now playing held); any other (Hide, Play, Stop) is
// sent, and what it does is its template's.
export const firedWords = (a) => (a?.durationMs > 0 ? 'on air' : ACT_CARDS.includes(a?.id) ? 'on air until hidden' : 'sent');
// The whole sentence, its label first: an untimed one labelled "Hide …" or "Stop …" says it is done
// ("Title card and now playing hidden", "The Line's clip stopped"), which its template does at once.
export function firedText(a) {
  const label = a?.label || a?.id || 'The action';
  const m = !(a?.durationMs > 0) && !ACT_CARDS.includes(a?.id) ? /^(Hide|Stop) (.+)$/.exec(label) : null;
  return m ? `${m[2][0].toUpperCase()}${m[2].slice(1)} ${m[1] === 'Hide' ? 'hidden' : 'stopped'}` : `${label} ${firedWords(a)}`;
}
// Of the overlays an action reached (refs), those with no media chosen for it, read now (a clip
// chosen a moment ago counts): [] when it plays none, or their settings can't be read.
export async function withoutMedia(name, refs) {
  const media = MEDIA_ACTIONS[name];
  if (!media) return [];
  const read = await Promise.all(list(refs).map((ref) => api.get(`/api/v1/overlays/${api.seg(ref)}`).catch(() => undefined)));
  return read.filter((o) => {
    const s = o?.resolvedSettings || o?.settings;
    return !!s && typeof s === 'object' && !(typeof s[media.setting] === 'string' && s[media.setting].trim());
  });
}

// The overlays an action reached (refs), read now: [{ overlay, why }], why when it shows nothing
// for it with its settings as they are (action-needs.js notDrawn: TAKEOVER's chips outside its
// event look). [] for an action no template draws only so (nothing is read).
export async function readDrawn(name, refs) {
  if (!drawnOnlySo(name)) return [];
  const read = await Promise.all(list(refs).map((ref) => api.get(`/api/v1/overlays/${api.seg(ref)}`).catch(() => undefined)));
  return read.filter(Boolean).map((overlay) => ({ overlay, why: notDrawn(overlay, name) }));
}
// The actions the overlays show nothing for now (every one of them that has it: members, each
// { overlay, manifest }), in a line: "Opening DJ chip and Headliner on-at chip show nothing now:
// the chips show in the Headliner event look only." '' for none.
export function quietLine(actions, members) {
  const byWhy = new Map();
  for (const a of actions) {
    const having = members.filter((m) => list(m.manifest?.actions).some((x) => x?.id === a.id));
    const whys = having.map((m) => notDrawn(m.overlay, a.id));
    if (!having.length || !whys.every(Boolean)) continue;
    if (!byWhy.has(whys[0])) byWhy.set(whys[0], []);
    byWhy.get(whys[0]).push(a.label || a.id);
  }
  return [...byWhy].map(([why, labels]) => `${andList(labels)} ${labels.length === 1 ? 'shows' : 'show'} nothing now: ${why}.`).join(' ');
}

const shapeOf = (w, hh) => (!w || !hh ? undefined : w > hh ? 'Landscape' : w < hh ? 'Vertical' : 'Square');
// "Landscape · 1920 × 1080": the template's name for the canvas, else its shape, and its size.
const canvasLabel = (c, manifest) => {
  const name = list(manifest?.canvases).find((m) => m?.id === c.canvas)?.label || shapeOf(c.width, c.height) || c.canvas || 'Canvas';
  return c.width ? `${name} · ${c.width} × ${c.height}` : name;
};

export function overlayPanel(ctx, { ref, show, onWholeShow, onOverlay, onAdded } = {}) {
  const canControl = ctx.can('overlays:control');
  const canPreview = ctx.can('overlays:read');
  const canWrite = ctx.can('overlays:write');
  const el = h('div.stack', h('p.loading', 'Loading…'));
  const needs = h('div', { hidden: true });
  let stopped = false;
  let box; // the preview
  let stopPoll;
  let overlay;
  let manifest;
  let known = { shows: [], overlays: [] }; // outside a show: the shows and overlays, for the notice
  let drawNoAct = () => {}; // the Actions card's lines (title cards with no act, what shows nothing), once drawn

  async function load() {
    const path = `/api/v1/overlays/${api.seg(ref)}`;
    overlay = await api.get(path);
    const t = overlay.template || {};
    const [urls, pinned, others] = await Promise.all([
      canPreview ? api.get(`${path}/url`).then((r) => ({ list: list(r?.urls).filter((u) => typeof u?.url === 'string') }), (error) => ({ list: [], error })) : { list: [] },
      typeof t.id === 'string' && typeof t.version === 'string' ? api.get(`/api/v1/templates/${api.seg(t.id)}/versions/${api.seg(t.version)}`).catch(() => undefined) : undefined,
      // Outside a show: the shows to add it to, and the one plainly its (its twin's, or one with no
      // overlays yet).
      !show && !overlay.show ? readShows() : known,
    ]);
    manifest = pinned?.manifest;
    known = others;
    return { urls, manifest };
  }
  async function readShows() {
    if (!ctx.can('timeline:read')) return known;
    const [shows, overlays] = await Promise.all([api.all('/api/v1/shows').catch(() => known.shows), api.all('/api/v1/overlays').catch(() => known.overlays)]);
    return { shows, overlays };
  }

  // ---- outside a show, a template that reads one: the notice, until it is in one -------------
  // Drawn again only when it changes (a button pressed keeps its focus through the polls): when a
  // show is made meanwhile, it offers "Add it to a show" too, and the show plainly its first.
  let needsKey;
  const needsOn = () => !show && needsShow(overlay, manifest);
  function drawNeeds() {
    const on = needsOn();
    const suggested = on ? suggestedShow(overlay, known.shows, known.overlays) : undefined;
    const key = on ? JSON.stringify([overlay.id, known.shows.length > 0, suggested?.show.id, suggested?.why]) : '';
    if (key === needsKey) return;
    needsKey = key;
    needs.hidden = !on;
    mount(needs, on ? showNotice(ctx, { overlay, manifest, shows: known.shows, overlays: known.overlays, onAdded }) : null);
  }

  function gone() {
    box?.unload();
    stopPoll?.();
    needs.hidden = true;
    mount(needs);
    mount(el, h('div.card', empty(`There is no overlay "${ref}"`, 'It was renamed or deleted meanwhile.', h('a.btn.primary', { href: '#/live' }, 'All streams'))));
  }

  // ---- the scene OBS took last, outside a show (Follow OBS, 09 §9.7) --------------------------
  const obsNote = h('p.small.obs-note', { hidden: true });
  function drawObsNote() {
    const words = byObsWords(overlay?.sceneByObs);
    obsNote.hidden = !words;
    if (obsNote.textContent !== (words || '')) obsNote.textContent = words || '';
  }

  // ---- what feeds it (edited in its settings) ------------------------------------------------
  const fedBody = h('div.stack');
  let fedKey;
  function drawFed() {
    const key = JSON.stringify([overlay.connections, overlay.bound]);
    if (key === fedKey) return;
    fedKey = key;
    const bound = list(overlay.bound);
    mount(fedBody,
      h('p', fedByWords(overlay.connections === 'all' ? 'all' : list(overlay.connections), bound)),
      bound.length ? h('div.chips', bound.map(connectionChip)) : null,
      canWrite ? h('p', h('a', { href: `#/overlays/${api.seg(overlay.slug)}?tab=settings` }, 'Change what feeds it'), h('span.small.muted', ' (in its settings, under Fed by)')) : null);
  }

  function draw({ urls, manifest }) {
    const slug = overlay.slug;
    const path = () => `/api/v1/overlays/${api.seg(overlay.id)}`;
    const ok = overlay.status === 'ok';
    const button = (label, fn, done, extra = {}) => {
      const b = h('button.btn', { type: 'button', disabled: !canControl, ...extra, onclick: () => run(b, fn, { done }) }, label);
      return b;
    };

    // ---- head and preview --------------------------------------------------------------------
    const canvases = urls.list;
    let at = 0;
    const previewSlot = h('div.overlay-preview');
    const showPreview = () => {
      box?.unload();
      const c = canvases[at];
      box = preview(c.url, { width: c.width > 0 ? c.width : 1920, height: c.height > 0 ? c.height : 1080, title: `Preview of ${slug}, ${canvasLabel(c, manifest)}` });
      mount(previewSlot, box);
    };
    const pick = canvases.length > 1
      ? h('select', { onchange: () => { at = Number(pick.value) || 0; showPreview(); } }, canvases.map((c, i) => h('option', { value: String(i) }, canvasLabel(c, manifest))))
      : null;
    const head = h('section.card.stack',
      h('div.card-head', h('h2.truncate', slug),
        !ok ? badge(overlay.status === 'template-missing' ? 'Template missing' : 'Template can\'t run', 'danger') : null,
        h('div.actions', h('a.btn.ghost', { href: `#/overlays/${api.seg(slug)}` }, 'All settings'))),
      h('p.small.muted', `${manifest?.name || overlay.template?.id || 'Unknown template'}${overlay.template?.version ? ` · version ${overlay.template.version}` : ''}`),
      !ok ? notice('Its template isn\'t usable, so OBS shows nothing: open its settings to fix it.', 'danger')
        : !canPreview ? h('p.muted', 'Your role can\'t open the overlay\'s preview.')
          : urls.error ? notice(`The preview could not be read: ${urls.error.message}`, 'warn')
            : canvases.length ? [pick ? h('div.inline-form', field('Canvas in the preview', pick)) : null, previewSlot] : h('p.muted', 'This overlay has no canvas to preview.'));
    if (ok && canPreview && canvases.length) showPreview();

    // ---- add to OBS --------------------------------------------------------------------------
    const obs = canPreview && canvases.length ? h('section.card.stack',
      h('h2', 'Add to OBS'),
      canvases.map((c) => {
        const label = canvasLabel(c, manifest);
        const copier = copyField(c.url, { label: 'Copy', copied: `${label.split(' · ')[0]} URL of "${slug}" copied: paste it into an OBS browser source.` });
        copier.querySelector('input')?.setAttribute('aria-label', `${label} URL of ${slug}`);
        copier.querySelector('button')?.setAttribute('aria-label', `Copy the ${label} URL of ${slug}`);
        return h('div', h('h3', label), copier, h('p.small.muted', c.width ? `A Browser source, Width ${c.width}, Height ${c.height}.` : 'A Browser source at your canvas size.'));
      })) : null;

    // ---- scenes: its own, or the show's ------------------------------------------------------
    const scenes = list(manifest?.scenes).filter((s) => s && typeof s.id === 'string');
    const scenesCard = h('section.card.stack', h('h2', 'Scenes'), show ? null : obsNote,
      show
        ? [h('p', `Scenes belong to the show: taking one changes every overlay in "${show}" together.`),
          onWholeShow ? h('div.row', h('button.btn', { type: 'button', onclick: () => onWholeShow() }, 'Take scenes on the whole show')) : null]
        : !manifest ? h('p.muted', 'Its template isn\'t available, so there are no scenes to take.')
          : scenes.length ? h('div.pad', { role: 'group', 'aria-label': `Scenes of ${slug}` },
            scenes.map((s) => button(s.durationMs > 0 && s.then ? `${s.label || s.id} · ${Math.round(s.durationMs / 1000)} s` : s.label || s.id, () => api.put(`${path()}/scene`, { scene: s.id }), `${slug}: scene changed to ${s.label || s.id}`)))
            : h('p.muted', 'Its template has no scenes.'));

    // ---- actions -----------------------------------------------------------------------------
    // Fired with no act named ({}): a title card names the act on now, which only a show has. Outside
    // one, such a card is said to be sent with no act to name, and any other action to be sent (what
    // it reads of a show isn't there either), not on air; in one, what it did (firedWords).
    const actions = list(manifest?.actions).filter((a) => a && typeof a.id === 'string');
    const cards = actions.filter((a) => ACT_CARDS.includes(a.id)).map((a) => a.label || a.id);
    const noAct = h('p.small.muted', cards.length ? `This overlay isn't in a show, so ${andList(cards)} ${cards.length === 1 ? 'has no act to name: it shows' : 'have no act to name: they show'} nothing.` : '');
    const said = (a) => {
      const label = a.label || a.id;
      if (!needsOn()) return `${slug}: ${firedText(a)}`;
      if (ACT_CARDS.includes(a.id)) return `${slug}: ${label} sent. It has no act to name until the overlay is in a show.`;
      // A timed one (a chip) reads the show too: sent, never on air; Hide and Stop work as in one.
      return a.durationMs > 0 ? `${slug}: ${label} sent` : `${slug}: ${firedText(a)}`;
    };
    const fire = (a) => {
      const b = h('button.btn', { type: 'button', disabled: !canControl, onclick: async () => {
        const out = await run(b, async () => {
          await api.post(`${path()}/actions/${api.seg(a.id)}`, {});
          const [unset, drawn] = await Promise.all([withoutMedia(a.id, [overlay.id]), readDrawn(a.id, [overlay.id])]);
          return { unset, quiet: drawn.filter((x) => x.why) };
        });
        if (!out) return;
        if (out.unset.length) toast(`${slug}: ${MEDIA_ACTIONS[a.id].what} isn't set, so nothing plays. Choose one in the overlay's settings.`, { kind: 'error' });
        else if (out.quiet.length) toast(`${slug}: ${a.label || a.id} sent, but it shows nothing: ${out.quiet[0].why}.`);
        else toast(said(a));
      } }, a.label || a.id);
      return b;
    };
    // Actions its settings draw nothing for now (TAKEOVER's chips outside the event look): said
    // under the buttons, kept with its settings as it is read again.
    const quiet = h('p.small.muted', { hidden: true });
    const actionsCard = h('section.card.stack', h('h2', 'Actions'),
      actions.length
        ? [h('div.pad', { role: 'group', 'aria-label': `Actions of ${slug}` }, actions.map(fire)), noAct, quiet]
        : h('p.muted', manifest ? 'Its template has no actions.' : 'Its template isn\'t available, so there are no actions.'));
    drawNoAct = () => {
      noAct.hidden = !(needsOn() && cards.length);
      const words = quietLine(actions, [{ overlay, manifest }]);
      quiet.hidden = !words;
      if (quiet.textContent !== words) quiet.textContent = words;
    };

    // ---- simulate (08 §8.5) ------------------------------------------------------------------
    const sims = SIMULATIONS.map((item) => {
      const b = h('button.btn', { type: 'button', disabled: !canControl, onclick: async () => {
        const body = { kind: item.kind, ...(item.body ? item.body() : {}) };
        const answer = await run(b, () => api.post(`${path()}/simulate`, body));
        if (!answer) return;
        const takes = list(answer.sent).some((s) => s.delivered);
        toast(takes ? item.done(body) : `This template doesn't show ${item.what}, so nothing changes.`);
      } }, item.label);
      return b;
    });
    const reset = h('button.btn', { type: 'button', disabled: !canControl, onclick: async () => {
      const answer = await run(reset, () => api.post(`${path()}/simulate`, { kind: 'reset' }));
      if (answer) toast(list(answer.sent).some((s) => s.reset) ? 'Test ended: the overlay shows the real values again.' : 'Nothing was being tested: the overlay already shows the real values.');
    } }, 'Reset');
    const simCard = h('section.card.stack', h('h2', 'Simulate'),
      h('p.small.muted', `A sample event to "${slug}" only, to see how it looks: nothing reaches other overlays, the show or webhooks.`),
      h('div.pad', { role: 'group', 'aria-label': `Simulate on ${slug}` }, sims),
      h('div.row', reset, h('span.small.muted', 'A viewer count or track you send lasts a minute, or until Reset.')));

    drawFed();
    drawObsNote();
    drawNeeds();
    drawNoAct();
    mount(el,
      head,
      h('div.grid.wide', h('div.stack', scenesCard, actionsCard), h('div.stack', simCard, h('section.card', h('h2', 'Fed by'), fedBody))),
      obs);
  }

  // Read again every 3 s: what feeds it, and its status for the page; while the notice is on,
  // whether there is a show to add it to now.
  async function refresh() {
    if (stopped) return;
    try {
      overlay = await api.get(`/api/v1/overlays/${api.seg(overlay.id)}`);
    } catch (err) {
      if (!stopped && err.status === 404) gone();
      return;
    }
    if (stopped) return;
    if (needsOn() && ctx.can('timeline:read')) {
      known = await readShows();
      if (stopped) return;
    }
    drawFed();
    drawObsNote();
    drawNeeds();
    drawNoAct();
    onOverlay?.(overlay);
  }

  load().then((data) => {
    if (stopped) return;
    draw(data);
    onOverlay?.(overlay);
    let first = true;
    stopPoll = every(POLL_MS, () => {
      if (first) { first = false; return undefined; }
      return refresh();
    });
  }, (err) => {
    if (stopped || err.status === 401) return;
    if (err.status === 404) gone();
    else mount(el, notice(err.message, 'danger'));
  });

  return {
    el,
    needs,
    stop() {
      stopped = true;
      stopPoll?.();
      box?.unload();
    },
  };
}
