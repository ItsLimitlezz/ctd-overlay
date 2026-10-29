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
//   suggestedShow(overlay, shows, overlays) the show plainly its: its twin's, else one with no
//                                overlays yet (made before, its lineup typed in) → { show, why }
//   showNotice(ctx, { overlay, manifest, shows, overlays, compact, times, onAdded }) → the notice,
//                                with "Make a show from this overlay" and, once shows exist, "Add it
//                                to a show" ("Add it to <show>" first, said why, for the suggested
//                                one); times: the quiet line too
//   makeShow(ctx, overlay, { manifest }) the dialog: name, date, time zone, go-live (as New show
//                                has them, show-day.js newNight()), and the other overlays of its
//                                template in no show (its vertical twin), ticked; POST /shows, then
//                                the new show's Lineup. The Shows list opens it too, for an
//                                overlay it names as in no show
//   addToShow(ctx, overlay, { prefer }) pick a show (prefer, else the one its twin is in; one whose
//                                night has passed marked so) and PATCH its overlays with If-Match
//                                (H16) → the show
//   nightPassed(show), passedLine(ctx, show, { onMoved }) a show dated before its night now: the
//                                overlay page's line, with "Move it to <its next night>"
//
// Each overlay keeps what feeds it ("Fed by"): a show is fed by what feeds its overlays, so neither
// dialog changes it, and each says what feeds them.
import * as api from './api.js';
import { field, formDialog, h, mount, notice, run, toast } from './dom.js';
import { dateLabel, newNight, onWeekday, showDayNow, weekdayName } from './show-day.js';
import { fedByWords } from './streams.js';
import { timeInput, timeProblem } from './time-field.js';

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
// The show to put an overlay in, when one is plainly it: the show an overlay of its template is
// in (its twin: the two change scenes together only in one show), else a show with no overlays
// yet (made before, its lineup typed in). shows: as listed (live first, then the latest night);
// overlays: every overlay, for its twin. → { show, why } (why: in words), or undefined.
export function suggestedShow(overlay, shows = [], overlays = []) {
  const all = ordered(list(shows).filter((s) => s && typeof s.id === 'string'));
  const near = new Map(sameTemplate(overlay, list(overlays)).filter((o) => o.show).map((o) => [String(o.show).toLowerCase(), o]));
  const twinShow = all.find((s) => near.has(String(s.name).toLowerCase()));
  if (twinShow) return { show: twinShow, why: `"${near.get(String(twinShow.name).toLowerCase()).slug}", of the same template, is in "${twinShow.name}".` };
  const bare = all.find((s) => !list(s.overlays).length && !list(s.members).length);
  if (!bare) return undefined;
  const acts = list(bare.lineup).length;
  return { show: bare, why: `"${bare.name}" has ${acts ? `${plural(acts, 'act')} in its lineup and ` : ''}no overlays yet.` };
}

// compact: a stream card on Live (the sentence and the buttons only). times: also the quiet line of
// a template that reads only a show's times (the overlay's page; Live leaves it out). shows (as
// listed) and overlays: with a show plainly its (suggestedShow), "Add it to <show>" comes first,
// named and said why; else "Make a show from this overlay", with "Add it to a show" when there
// are shows (canAdd, when the list isn't at hand).
export function showNotice(ctx, { overlay, manifest, shows, overlays, canAdd = list(shows).length > 0, compact = false, times = false, onAdded } = {}) {
  const loud = needsShow(overlay, manifest);
  if (!loud && !(times && wantsShowTimes(overlay, manifest))) return null;
  const lines = loud
    ? [h('p', `${showWords(manifest)} This overlay isn't in one yet.`)]
    : [h('p.small.muted', `${showWords(manifest)} This overlay isn't in a show.`)];
  if (loud && !compact && namesActs(manifest)) lines.push(h('p', 'Until it is, a title card has no act to name, so it shows nothing.'));
  const suggested = ctx.can('timeline:write') ? suggestedShow(overlay, shows, overlays) : undefined;
  if (suggested) lines.push(h(loud ? 'p' : 'p.small.muted', `${suggested.why} Add this overlay to it, so its set times reach it.`));
  if (!ctx.can('timeline:write')) {
    if (loud) lines.push(h('p.small.muted', 'Your role can\'t make shows: an operator or a higher role can put it in one.'));
  } else {
    const make = h(loud && !suggested ? 'button.btn.primary' : 'button.btn', { type: 'button', onclick: () => run(make, () => makeShow(ctx, overlay, { manifest })) }, 'Make a show from this overlay');
    const add = canAdd || suggested ? h(loud && suggested ? 'button.btn.primary' : 'button.btn', { type: 'button', onclick: () => run(add, async () => {
      const show = await addToShow(ctx, overlay, { manifest, prefer: suggested?.show.id });
      if (show) onAdded?.(show);
    }) }, suggested ? `Add it to ${suggested.show.name}` : 'Add it to a show') : null;
    lines.push(h('div.row', suggested ? [add, make] : [make, add]));
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
  const name = h('input', { type: 'text', value: freeName(manifest?.name || overlay.slug, shows), maxlength: NAME_CHARS, required: true, autocomplete: 'off' });
  // The show's night now, as New show has it: after midnight, still the night before.
  const { date, tz, dateEl, tzEl } = newNight();
  const goLive = timeInput();
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
    tzEl,
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
      // Said in the box's own words (formDialog focuses it): "add AM or PM", never "like 22:30".
      const late = timeProblem(goLive.value, 'The go-live time');
      if (late) throw Object.assign(new Error(late), { field: goLive });
      return api.post('/api/v1/shows', {
        name: name.value.trim(),
        overlays: [overlay.id, ...ticked(boxes).map((o) => o.id)],
        date: date.value,
        timezone: tz.value.trim(),
        ...(goLive.value ? { goLive: goLive.value } : {}),
      });
    },
    onError: (err, { say }) => takenMeanwhile(err, { overlay, boxes, say, again: 'Create show', redraw: drawFed }),
  });
  if (!created?.id) return undefined;
  toast(`Created the show "${created.name}" with ${andList(list(created.members))}: add the night's acts and their set times.`, { ms: 6000 });
  ctx.navigate(`/shows/${api.seg(created.id)}?tab=lineup`);
  return created;
}

// ---- a show's night that has passed --------------------------------------------------------------
// A show dated before its night now (in its zone, with its day boundary), and not live: its
// countdown and set times are that night's. → { tonight, next } (its next night on the same
// weekday), or undefined.
export function nightPassed(show) {
  if (!show || show.live || !DATE.test(show.date || '')) return undefined;
  const tonight = showDayNow(show.timezone, show.dayBoundary || '12:00');
  return show.date < tonight ? { tonight, next: onWeekday(tonight, show.date) } : undefined;
}

// The line said where an overlay in such a show is (its page), with "Move it to Sat, Oct 31": the
// show's date, a PATCH with its If-Match (as the show's page does). onMoved() after, or after a
// refusal said (the show changed or went meanwhile), to read it again.
export function passedLine(ctx, show, { onMoved } = {}) {
  const p = nightPassed(show);
  if (!p) return null;
  const canWrite = ctx.can('timeline:write');
  const move = canWrite ? h('button.btn.small', { type: 'button', onclick: () => run(move, async () => {
    try {
      const moved = await api.patch(`/api/v1/shows/${api.seg(show.id)}`, { date: p.next }, { ifMatch: show });
      toast(`"${moved.name}" is on ${dateLabel(p.next, true)} now: its set times and cues moved with it.`);
    } catch (err) {
      if (err?.status !== 412 && err?.status !== 404) throw err;
      toast(err.status === 412 ? `"${show.name}" changed since this page read it: this is the latest. Move it again if you still want to.` : `"${show.name}" was deleted meanwhile.`, { kind: 'error', ms: 10000 });
    }
    onMoved?.();
  }) }, `Move it to ${dateLabel(p.next)}`) : null;
  return notice([
    `Its night, ${dateLabel(show.date, true)}, has passed: the countdown and set times are still that night's. `,
    canWrite ? `Move it to its next ${weekdayName(show.date)}, or plan the coming nights on the show's page.` : 'An operator moves it to its next night on the show\'s page.',
    move ? h('div.row', move) : null,
  ], 'warn');
}

// ---- Add it to a show ------------------------------------------------------------------------
// The shows as Shows lists them: live first, then the latest night.
const ordered = (shows) => [...shows].sort((a, b) => (b.live === true) - (a.live === true) || String(b.date).localeCompare(String(a.date)) || String(a.name).localeCompare(String(b.name)));
// Short (a phone's select cuts a long one): the night, "passed" for one gone by, the overlays.
const showLabel = (s) => `${s.name} · ${dateLabel(s.date)}${nightPassed(s) ? ' · passed' : ''} · ${plural(list(s.members).length, 'overlay')}`;

// prefer: the show to pick first (suggestedShow's), else the one an overlay of its template is in.
export async function addToShow(ctx, overlay, { manifest, prefer } = {}) {
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
  const showField = field('Show', pick, { hint: ' ' });
  // Under the select, for the show picked: its twin is there; its night has passed (in words: a
  // phone's select cuts the label short).
  const pickHint = () => {
    const s = shows.find((x) => x.id === pick.value);
    const words = [];
    if (twin && s?.id === twinShow.id) words.push(`"${twin.slug}", of the same template, is in "${twinShow.name}".`);
    if (nightPassed(s)) words.push(`Its night, ${dateLabel(s.date, true)}, has passed: the countdown and set times stay that night's until it is moved to its next night, on its page.`);
    const hint = showField.querySelector('.hint');
    hint.textContent = words.join(' ');
    hint.hidden = !words.length;
  };
  const drawPick = (keep) => {
    shows = ordered(shows);
    mount(pick, shows.map((s) => h('option', { value: s.id }, showLabel(s))));
    if (keep && shows.some((s) => s.id === keep)) pick.value = keep;
    pickHint();
  };
  pick.addEventListener('change', pickHint);
  drawPick(prefer || twinShow?.id);
  const boxes = twinBoxes(twinsOf(overlay, overlays));
  const parts = showParts(manifest);
  const body = h('div',
    h('p.muted', parts.length
      ? `Then ${lower(andList(parts.map((p) => p.text)))} ${verb(parts)} from that show, and its scenes change with the show's other overlays.`
      : 'Its scenes then change with the show\'s other overlays.'),
    showField,
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
    onError: async (err, { say }) => {
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
