// Streams in the admin UI: a show's or an overlay's stream status as people read it (on air or not,
// the CTD Multi-Stream profile it follows, each platform, viewers, what feeds it), and the "Fed by"
// choice of connections. Live, Overlays
// and Shows use these. A stream's status comes from the API (`stream` on a show or an overlay,
// src/streams.js): onAir true, false, or absent when nothing says, which is "Unknown", never
// "Offline"; viewers absent when no count is known, never 0 (H6).
import { badge, field, h, mount } from './dom.js';

export const PLATFORMS = { twitch: 'Twitch', youtube: 'YouTube', kick: 'Kick', facebook: 'Facebook', x: 'X', instagram: 'Instagram', tiktok: 'TikTok', custom: 'Other' };
export const platformName = (p) => PLATFORMS[p] || p;
// A connection's status in words, with the colour of its dot (never the colour alone).
const CONNECTION = {
  connected: ['ok', 'Connected'],
  degraded: ['warn', 'Partly working'],
  connecting: ['warn', 'Connecting…'],
  'needs-reauth': ['danger', 'Needs signing in'],
  error: ['danger', 'Not working'],
  disabled: [undefined, 'Turned off'],
};
export const connectionWords = (status) => CONNECTION[status] || [undefined, status || 'Unknown'];
const numbers = new Intl.NumberFormat();
const list = (v) => (Array.isArray(v) ? v : []);

// On air, Offline or Unknown, as text and a badge kind.
export function airOf(stream) {
  if (stream?.onAir === true) return { text: 'On air', kind: 'ok' };
  if (stream?.onAir === false) return { text: 'Offline' };
  return { text: 'Unknown', kind: 'warn' };
}
export const isRunning = (stream, rec) => stream?.onAir === true || rec === true;
export const viewersText = (n) => `${numbers.format(n)} viewer${n === 1 ? '' : 's'}`;

// "Twitch · live · 214", "YouTube · offline", "Kick · 12 viewers"; "(held)" while a value is held
// through an error.
function platformText(p) {
  const parts = [platformName(p.platform)];
  if (p.live === true) parts.push('live');
  else if (p.live === false) parts.push('offline');
  if (Number.isFinite(p.viewers)) parts.push(p.live === undefined ? viewersText(p.viewers) : numbers.format(p.viewers));
  return `${parts.join(' · ')}${p.stale ? ' (held)' : ''}`;
}

// A CTD Multi-Stream profile's status in words (06 §6.11).
const PROFILE = { live: 'Live', starting: 'Starting', stopping: 'Stopping', offline: 'Offline' };
export const profileWords = (status) => PROFILE[status] || 'Unknown';

// A profile as a chip: its colour (never alone: its name and status are the words), "DPRTMNT · Live".
export function profileChip(p) {
  const dot = h('span.dot', { 'aria-hidden': 'true' });
  if (typeof p?.color === 'string' && /^#[0-9A-Fa-f]{6}$/.test(p.color)) dot.style.background = p.color;
  return h('span.chip', dot, `${p?.name || 'A profile'} · ${profileWords(p?.status)}`);
}

// A connection as a chip: its dot, its name and status in words; what is wrong, when something is.
export function connectionChip(c) {
  const [kind, words] = connectionWords(c?.status);
  return h('span.chip', h('span.dot', { class: kind, 'aria-hidden': 'true' }), `${c?.name || 'A connection'}: ${words}${c?.detail && c?.status !== 'connected' ? ` (${c.detail})` : ''}`);
}

// A stream's status, drawn again only when it changed: { el, update(stream, { rec, compact }) }.
// rec: the show's REC is running. compact: a card on the streams page (no title line).
export function streamStatus({ compact = false } = {}) {
  const el = h('div.stack.stream-status', { 'aria-live': compact ? undefined : 'polite' });
  let key;
  function update(stream, { rec = false } = {}) {
    const next = JSON.stringify([stream ?? null, rec]);
    if (next === key) return;
    key = next;
    const air = airOf(stream);
    const platforms = list(stream?.platforms);
    const connections = list(stream?.connections);
    const profiles = list(stream?.profiles);
    const title = platforms.find((p) => p.title)?.title;
    mount(el,
      h('div.row',
        badge(air.text, air.kind),
        rec ? badge('REC', 'danger') : null,
        Number.isFinite(stream?.viewers) ? h('strong', viewersText(stream.viewers)) : null,
        !compact && title ? h('span.muted.truncate', title) : null),
      profiles.length ? h('div.chips', { role: 'list', 'aria-label': 'CTD Multi-Stream profiles' }, profiles.map((p) => { const chip = profileChip(p); chip.setAttribute('role', 'listitem'); return chip; })) : null,
      platforms.length ? h('div.chips', { role: 'list', 'aria-label': 'Platforms' }, platforms.map((p) => h('span.chip', { role: 'listitem' }, platformText(p)))) : null,
      connections.length
        ? h('div.chips', { role: 'list', 'aria-label': 'Fed by' }, connections.map((c) => { const chip = connectionChip(c); chip.setAttribute('role', 'listitem'); return chip; }))
        : h('p.small.muted', 'No connection feeds it, so whether it is on air is unknown.'),
      connections.length && !platforms.length ? h('p.small.muted', 'Its connections haven\'t said whether it is live yet.') : null);
  }
  return { el, update };
}

// "Fed by": every connection (made later too), or only some. connections: [{ id, name, status }]
// (GET /api/v1/system/health, which operators can read); value: "all" or ids. Returns { el,
// value(), changed() }.
let fedSeq = 0;
// A radio button and its words, on one line a finger tall (field() lays out checkboxes so).
const radio = (label, input) => h('div.field.check', input, h('label', { for: input.id }, label));
export function fedByForm({ connections, value, disabled = false, legend = 'Fed by', onChange }) {
  const name = `fedby-${++fedSeq}`;
  const known = list(connections);
  const chosen = value === 'all' ? [] : list(value);
  // A connection named in the bindings but not listed (deleted meanwhile): kept, so saving doesn't
  // drop it without the user seeing it.
  const items = [...known, ...chosen.filter((id) => !known.some((c) => c.id === id)).map((id) => ({ id, name: id, status: 'unknown' }))];
  const all = h('input', { type: 'radio', name, id: `${name}-all`, value: 'all', checked: value === 'all', disabled });
  const some = h('input', { type: 'radio', name, id: `${name}-some`, value: 'some', checked: value !== 'all', disabled });
  const boxes = items.map((c) => {
    const [, words] = connectionWords(c.status);
    const input = h('input', { type: 'checkbox', value: c.id, checked: chosen.includes(c.id) });
    return { c, input, el: field(`${c.name} (${words})`, input) };
  });
  const sync = () => {
    for (const b of boxes) b.input.disabled = disabled || all.checked;
  };
  const changed = () => { sync(); onChange?.(); };
  all.addEventListener('change', changed);
  some.addEventListener('change', changed);
  for (const b of boxes) b.input.addEventListener('change', changed);
  sync();
  const el = h('fieldset',
    h('legend', legend),
    radio('All connections, including new ones', all),
    radio('Only these', some),
    boxes.length
      ? h('div.fed-by-list', boxes.map((b) => b.el))
      : h('p.small.muted', 'There are no connections yet: an owner or admin adds them in Connections.'),
    h('p.small.muted', 'Two streams at once: feed each stream\'s overlays from its own connection (a CTD Multi-Stream each, say), so each shows its own chat, alerts and viewers.'));
  const current = () => (all.checked ? 'all' : boxes.filter((b) => b.input.checked).map((b) => b.c.id));
  const same = (x) => JSON.stringify(x === 'all' ? x : [...x].sort());
  return {
    el,
    value: current,
    changed: () => same(current()) !== same(value === 'all' ? 'all' : chosen),
  };
}

// What feeds an overlay, in a sentence: "Every connection, including new ones" or the names.
export function fedByWords(binding, bound) {
  if (binding === 'all') return 'Every connection, including new ones.';
  const names = list(bound).map((c) => c.name).filter(Boolean);
  if (!list(binding).length) return 'No connection: it shows sample data and the show only.';
  return `Only ${names.length ? names.join(', ') : `${list(binding).length} connection${list(binding).length === 1 ? '' : 's'}`}.`;
}
