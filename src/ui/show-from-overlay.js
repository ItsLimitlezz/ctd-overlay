// An overlay that reads a show but is in none (08 §8.3, §8.4). Set times, who's on, the countdown,
// REC and title cards live on a show (09 §9.1), and its overlays read them as show.* state (02 §2.5,
// src/shows/registry.js). An overlay outside a show gets none of it and its template draws nothing
// for them, so the overlay's page and Live say so, with the way to put it in one:
//
//   showParts(manifest)          what its template reads from a show, in words ([] for nothing)
//   showWords(manifest)          the same as a sentence: "Set times, the countdown, REC and title
//                                cards come from a show."; for a template that reads only a
//                                show's times, "With no time of its own, the countdown runs to a
//                                show's go-live."
//   sampleWords(manifest)        what Sample data makes up of it in the preview (src/sdk/mock.js)
//   readsLineup(manifest)        it reads who's on, which only a show has
//   needsShow(overlay, manifest) it reads who's on and is in no show: said loudly, on its page and
//                                on Live
//   wantsShowTimes(overlay, manifest) it reads only a show's times (a clock's countdown to the
//                                go-live) and is in no show: it may well have a time of its own,
//                                so it is said quietly, on its page only
//   namesActs(manifest)          its title cards (its actions) name the act on now, from a show
//   showNotice(ctx, { overlay, manifest, canAdd, compact, times, onAdded }) → the notice, with
//                                "Make a show from this overlay" and (canAdd: shows exist) "Add it
//                                to a show"; times: the quiet line too
//   makeShow(ctx, overlay, { manifest }) the dialog: name, date, time zone, go-live, and the other
//                                overlays of its template in no show (its vertical twin), ticked;
//                                POST /shows, then the new show's Lineup
//   addToShow(ctx, overlay)      pick a show (the one its twin is in first) and PATCH its overlays
//                                with If-Match (H16) → the show
//
// Each overlay keeps what feeds it ("Fed by"): a show is fed by what feeds its overlays, so neither
// dialog changes it, and each says what feeds them.
import * as api from './api.js';
import { dialog, field, h, mount, notice, run, toast } from './dom.js';
import { browserZone, dateField, dateLabel, showDayNow, zoneInput } from './show-day.js';
import { fedByWords } from './streams.js';

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME_CHARS = 80;
const list = (v) => (Array.isArray(v) ? v : []);
const andList = (items) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const fail = (message) => { throw new Error(message); };
const upper = (s) => `${s[0]?.toUpperCase() || ''}${s.slice(1)}`;
const lower = (s) => `${s[0]?.toLowerCase() || ''}${s.slice(1)}`;

// ---- what a template reads from a show -------------------------------------------------------
// What a show publishes to each member, but its scene: an overlay outside a show has its own.
const LINEUP_KEYS = ['show.lineup', 'show.currentSlot', 'show.headliner'];
// A key matched by consumes.state: an exact name, or a prefix ending in ".*" (src/bus/names.js).
const reads = (manifest, key) => list(manifest?.consumes?.state).some((p) => typeof p === 'string' && (p === key || (p.endsWith('.*') && key.startsWith(p.slice(0, -1)))));
export const readsLineup = (manifest) => LINEUP_KEYS.some((k) => reads(manifest, k));
// A title card names the act on now: a template that reads who's on and has actions.
export const namesActs = (manifest) => readsLineup(manifest) && list(manifest?.actions).length > 0;
const countsDown = (manifest) => reads(manifest, 'show.goLiveAt');
const countsUp = (manifest) => reads(manifest, 'show.recStartedAt');

// A template that reads who's on is a show's (TAKEOVER): its REC is the show's. One that reads only
// the times is a clock: what it counts up from is when the show went live.
export function showParts(manifest) {
  const lineup = readsLineup(manifest);
  const parts = [];
  if (lineup) parts.push({ text: 'set times', many: true });
  if (countsDown(manifest)) parts.push({ text: 'the countdown' });
  if (countsUp(manifest)) parts.push({ text: lineup ? 'REC' : 'the count-up' });
  if (namesActs(manifest)) parts.push({ text: 'title cards', many: true });
  return parts;
}
const verb = (parts) => (parts.length > 1 || parts[0]?.many ? 'come' : 'comes');

export function showWords(manifest) {
  const parts = showParts(manifest);
  if (!parts.length) return '';
  if (readsLineup(manifest)) return `${upper(andList(parts.map((p) => p.text)))} ${verb(parts)} from a show.`;
  const down = countsDown(manifest);
  const up = countsUp(manifest);
  return `With no time of its own, ${down && up ? 'the countdown runs to a show\'s go-live, and the count-up from when it went live'
    : down ? 'the countdown runs to a show\'s go-live' : 'the count-up runs from when a show went live'}.`;
}

export function sampleWords(manifest) {
  const parts = showParts(manifest);
  if (!parts.length) return '';
  if (readsLineup(manifest)) return `Sample data makes up ${andList(parts.map((p) => p.text))} here. On air this overlay has none of it until it is in a show.`;
  const down = countsDown(manifest);
  const up = countsUp(manifest);
  return `Sample data makes up a show's times here. With no time of its own, on air this overlay has nothing to count ${down && up ? 'to or from' : down ? 'to' : 'from'} until it is in a show.`;
}

export const needsShow = (overlay, manifest) => !!overlay && !overlay.show && readsLineup(manifest);
export const wantsShowTimes = (overlay, manifest) => !!overlay && !overlay.show && !readsLineup(manifest) && showParts(manifest).length > 0;

// ---- the notice ------------------------------------------------------------------------------
// compact: a stream card on Live (the sentence and the buttons only). times: also the quiet line of
// a template that reads only a show's times (the overlay's page; Live leaves it out).
export function showNotice(ctx, { overlay, manifest, canAdd = false, compact = false, times = false, onAdded } = {}) {
  const loud = needsShow(overlay, manifest);
  if (!loud && !(times && wantsShowTimes(overlay, manifest))) return null;
  const lines = loud
    ? [h('p', `${showWords(manifest)} This overlay isn't in one yet.`)]
    : [h('p.small.muted', `${showWords(manifest)} This overlay isn't in a show.`)];
  if (loud && !compact && namesActs(manifest)) lines.push(h('p', 'Until it is, a title card has no act to name, so it shows nothing.'));
  if (!ctx.can('timeline:write')) {
    if (loud) lines.push(h('p.small.muted', 'Your role can\'t make shows: an operator or a higher role can put it in one.'));
  } else {
    const make = h(loud ? 'button.btn.primary' : 'button.btn', { type: 'button', onclick: () => run(make, () => makeShow(ctx, overlay, { manifest })) }, 'Make a show from this overlay');
    const add = canAdd ? h('button.btn', { type: 'button', onclick: () => run(add, async () => {
      const show = await addToShow(ctx, overlay, { manifest });
      if (show) onAdded?.(show);
    }) }, 'Add it to a show') : null;
    lines.push(h('div.row', make, add));
  }
  if (!loud) return h('div.show-times', lines);
  const el = notice(lines, 'warn');
  el.classList.add('needs-show');
  return el;
}

// A name no show has yet: the template's ("D/PRTMNT TAKEOVER"), else with a number after it.
function freeName(base, shows) {
  const taken = new Set(shows.map((s) => String(s?.name || '').toLowerCase()));
  const name = String(base || '').trim().slice(0, NAME_CHARS) || 'Tonight';
  if (!taken.has(name.toLowerCase())) return name;
  for (let n = 2; n < 100; n++) {
    const next = `${name.slice(0, NAME_CHARS - 4)} ${n}`;
    if (!taken.has(next.toLowerCase())) return next;
  }
  return '';
}

// The other overlays of the same template: those in no show come along (its vertical twin, say).
const sameTemplate = (overlay, overlays) => overlays.filter((o) => o && o.id !== overlay.id && o.template?.id === overlay.template?.id);
const twinsOf = (overlay, overlays) => sameTemplate(overlay, overlays).filter((o) => !o.show);

// What feeds the overlays, in words: each keeps its own.
const bindingOf = (o) => (o.connections === 'all' || !Array.isArray(o.connections) ? 'all' : [...o.connections].sort());
function fedNote(members) {
  const key = (o) => JSON.stringify(bindingOf(o));
  if (members.every((o) => key(o) === key(members[0]))) {
    return h('p.small.muted', `What feeds ${members.length > 1 ? 'them' : 'it'} stays as it is (Fed by): ${lower(fedByWords(bindingOf(members[0]), members[0].bound))}`);
  }
  return h('div.small.muted',
    h('p', 'They are fed differently, and each keeps what feeds it (Fed by):'),
    h('ul', members.map((o) => h('li', `${o.slug}: ${lower(fedByWords(bindingOf(o), o.bound))}`))),
    h('p', 'The show\'s Details can feed them all the same way.'));
}

// A form in a dialog that stays open while it saves (as Shows' New show): the primary button runs
// submit() (busy, no double tap), a problem shows in the dialog, success closes it. onError(err,
// say) may handle a problem itself (say(node) shows it) → true. It opens at its top, its title and
// what it is about in view, with the focus on `focus`. Resolves with submit's result, or undefined
// when cancelled.
function formDialog({ title, body, submitLabel, focus, submit, onError }) {
  const message = h('div', { 'aria-live': 'polite' });
  let result;
  const pending = dialog({ title, body: h('div', body, message), actions: [{ label: 'Cancel', value: false }, { label: submitLabel, value: true, kind: 'primary' }] });
  const d = message.closest('dialog');
  const button = d?.querySelector('.form-actions .btn.primary');
  const say = (node) => {
    mount(message, node);
    message.scrollIntoView?.({ block: 'nearest' });
  };
  d?.addEventListener('click', async (e) => {
    if (!button || !button.contains(e.target)) return;
    // Ours, not the dialog's own handler (which would close it before the request is done).
    e.stopPropagation();
    e.preventDefault();
    mount(message);
    let problem;
    const out = await run(button, async () => (await submit()) ?? true, { onError: (err) => { problem = err; } });
    if (problem) {
      if (!(await onError?.(problem, say))) say(notice(problem?.message || String(problem), 'danger'));
      return;
    }
    if (out !== undefined) {
      result = out;
      d.close();
    }
  }, true);
  // dialog() focused Cancel, at the bottom, which scrolled a tall dialog down past its title.
  focus?.focus({ preventScroll: true });
  if (d) d.scrollTop = 0;
  return pending.then(() => result);
}

// A ticked checkbox for each twin, with its name as the label.
const twinBoxes = (twins) => twins.map((o) => {
  const input = h('input', { type: 'checkbox', value: o.slug, checked: true });
  return { o, input, el: field(o.slug, input) };
});
const ticked = (boxes) => boxes.filter((b) => b.input.checked && !b.input.disabled).map((b) => b.o);

// A twin put in another show while the dialog was open (409, an overlay is in one show at most,
// 01 §1.3): it is read again, left out (unticked, greyed, "in "Sneaky" now"), and said in plain
// words, not the server's. The overlay itself, in a show now, is said too: there is nothing left to
// do here. again: the dialog's button, to press again for the rest. → true when handled.
async function takenMeanwhile(err, { overlay, boxes, say, again, redraw }) {
  if (err?.status !== 409 || err?.code !== 'in-other-show') return false;
  let overlays = [];
  try { overlays = await api.all('/api/v1/overlays'); } catch { /* said below, without names */ }
  const now = new Map(overlays.map((o) => [o.id, o]));
  const self = now.get(overlay.id);
  if (self?.show) {
    say(notice([`"${overlay.slug}" is in the show "${self.show}" now (someone else, or another tab, put it there), so nothing was changed. `, h('a', { href: `#/shows/${api.seg(self.show)}` }, 'Open that show'), '.'], 'danger'));
    return true;
  }
  const gone = [];
  for (const b of boxes) {
    const show = now.get(b.o.id)?.show;
    if (!show) continue;
    if (!b.input.disabled) gone.push(`"${b.o.slug}" is in the show "${show}" now`);
    b.input.checked = false;
    b.input.disabled = true;
    const label = b.el.querySelector('label');
    if (label) label.textContent = `${b.o.slug} (in "${show}" now)`;
  }
  redraw?.();
  say(notice(gone.length
    ? `${andList(gone)}, so ${gone.length === 1 ? 'it is' : 'they are'} left out. Press ${again} again for the rest.`
    : 'One of these overlays is in another show now (someone else, or another tab, put it there), so nothing was changed. Close this and open it again.', 'danger'));
  return true;
}

// ---- Make a show from this overlay -----------------------------------------------------------
export async function makeShow(ctx, overlay, { manifest } = {}) {
  const [overlays, shows] = await Promise.all([
    api.all('/api/v1/overlays'),
    ctx.can('timeline:read') ? api.all('/api/v1/shows').catch(() => []) : [],
  ]);
  const zone = browserZone();
  const name = h('input', { type: 'text', value: freeName(manifest?.name || overlay.slug, shows), maxlength: NAME_CHARS, required: true, autocomplete: 'off' });
  // The show's day now, as New show has it: after midnight, still the night before.
  const date = h('input', { type: 'date', value: showDayNow(zone), required: true });
  const tz = zoneInput(zone);
  const goLive = h('input', { type: 'time' });
  const dateEl = dateField('Date', date, { hint: 'The night of the show. Acts after midnight still belong to this date.', zone: () => tz.value.trim() || zone, weekdays: [5, 6] });
  // Tonight follows the zone chosen, until the date is picked (by hand or a quick pick).
  let datePicked = false;
  date.addEventListener('input', () => { datePicked = true; });
  tz.addEventListener('change', () => {
    if (!datePicked && tz.value.trim()) date.value = showDayNow(tz.value.trim());
    dateEl.refresh();
  });
  const self = h('input', { type: 'checkbox', checked: true, disabled: true });
  const boxes = twinBoxes(twinsOf(overlay, overlays));
  const fed = h('div');
  const drawFed = () => mount(fed, fedNote([overlay, ...ticked(boxes)]));
  for (const b of boxes) b.input.addEventListener('change', drawFed);
  drawFed();
  const body = h('div',
    h('p.muted', 'A show is the night: its date, when it goes live, and the lineup with each act\'s set time. Its overlays show them all, and change scenes together.'),
    field('Name', name, { hint: 'What you call the night.' }),
    dateEl,
    field('Time zone', tz, { hint: 'Where the show happens. Its times are in this zone, wherever your phone is.' }),
    field('Goes live at', goLive, { hint: 'When the countdown ends and the show goes on air. Optional.' }),
    h('fieldset',
      h('legend', 'Overlays in the show'),
      field(`${overlay.slug} (this overlay)`, self),
      boxes.map((b) => b.el),
      h('p.small.muted', boxes.length
        ? 'The other overlays of this template that aren\'t in a show yet, like its vertical twin, come along. Untick one to leave it out.'
        : 'Add more later, under the show\'s Details.'),
      fed));
  const created = await formDialog({
    title: `Make a show from "${overlay.slug}"`,
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
        overlays: [overlay.id, ...ticked(boxes).map((o) => o.id)],
        date: date.value,
        timezone: tz.value.trim(),
        ...(goLive.value ? { goLive: goLive.value } : {}),
      });
    },
    onError: (err, say) => takenMeanwhile(err, { overlay, boxes, say, again: 'Create show', redraw: drawFed }),
  });
  if (!created?.id) return undefined;
  toast(`Created the show "${created.name}" with ${andList(list(created.members))}: add the night's acts and their set times.`, { ms: 6000 });
  ctx.navigate(`/shows/${api.seg(created.id)}?tab=lineup`);
  return created;
}

// ---- Add it to a show ------------------------------------------------------------------------
// The shows as Shows lists them: live first, then the latest night.
const ordered = (shows) => [...shows].sort((a, b) => (b.live === true) - (a.live === true) || String(b.date).localeCompare(String(a.date)) || String(a.name).localeCompare(String(b.name)));
const showLabel = (s) => `${s.name} · ${dateLabel(s.date)} · ${plural(list(s.members).length, 'overlay')}`;

export async function addToShow(ctx, overlay, { manifest } = {}) {
  const [listed, overlays] = await Promise.all([api.all('/api/v1/shows'), api.all('/api/v1/overlays')]);
  let shows = listed;
  if (!shows.length) {
    toast('There are no shows yet: make one from this overlay.');
    return undefined;
  }
  // The show an overlay of its template is in comes first (its landscape twin's, say): the two
  // change scenes together only in the same show.
  const near = new Map(sameTemplate(overlay, overlays).filter((o) => o.show).map((o) => [String(o.show).toLowerCase(), o]));
  const twinShow = ordered(shows).find((s) => near.has(String(s.name).toLowerCase()));
  const twin = twinShow && near.get(String(twinShow.name).toLowerCase());
  const pick = h('select');
  const drawPick = (keep) => {
    shows = ordered(shows);
    mount(pick, shows.map((s) => h('option', { value: s.id }, showLabel(s))));
    if (keep && shows.some((s) => s.id === keep)) pick.value = keep;
  };
  drawPick(twinShow?.id);
  const boxes = twinBoxes(twinsOf(overlay, overlays));
  const parts = showParts(manifest);
  const body = h('div',
    h('p.muted', parts.length
      ? `Then ${lower(andList(parts.map((p) => p.text)))} ${verb(parts)} from that show, and its scenes change with the show's other overlays.`
      : 'Its scenes then change with the show\'s other overlays.'),
    field('Show', pick, { hint: twin ? `"${twin.slug}", of the same template, is in "${twinShow.name}".` : undefined }),
    boxes.length ? h('fieldset',
      h('legend', 'Also add'),
      boxes.map((b) => b.el),
      h('p.small.muted', 'The other overlays of this template that aren\'t in a show yet, like its vertical twin.')) : null,
    h('p.small.muted', 'Each overlay keeps what feeds it (Fed by): a show is fed by what feeds its overlays.'));
  const added = await formDialog({
    title: `Add "${overlay.slug}" to a show`,
    body,
    submitLabel: 'Add to show',
    focus: pick,
    submit: () => {
      const show = shows.find((s) => s.id === pick.value) || fail('Pick a show.');
      const adding = [overlay.id, ...ticked(boxes).map((o) => o.id)];
      // As the list read it (H16): a show changed meanwhile is a 412, never overwritten.
      return api.patch(`/api/v1/shows/${api.seg(show.id)}`, { overlays: [...new Set([...list(show.overlays), ...adding])] }, { ifMatch: show });
    },
    // Changed or deleted meanwhile: say so, show the shows as they are now, and let it be done again.
    onError: async (err, say) => {
      if (await takenMeanwhile(err, { overlay, boxes, say, again: 'Add to show' })) return true;
      if (err?.status !== 412 && err?.status !== 404) return false;
      const was = shows.find((s) => s.id === pick.value);
      try { shows = await api.all('/api/v1/shows'); } catch { /* the list as it was */ }
      drawPick(pick.value);
      say(notice(err.status === 412
        ? `"${was?.name || 'The show'}" changed since you opened this (someone else, or another tab), so nothing was added. This is it as it is now: add it again.`
        : `"${was?.name || 'The show'}" was deleted meanwhile, so nothing was added. Pick another show.`, 'danger'));
      return true;
    },
  });
  if (!added?.id) return undefined;
  const names = [overlay.slug, ...ticked(boxes).map((o) => o.slug)];
  toast(`${andList(names.map((n) => `"${n}"`))} ${names.length > 1 ? 'are' : 'is'} in the show "${added.name}" now.`);
  return added;
}
