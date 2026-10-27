// A show's day and its date field, as Shows' New show has them (shows.js), for a show made outside
// Shows ("Make a show from this overlay", show-from-overlay.js). The same rules, so the two dialogs
// pick the same night:
//
//   browserZone()                        this device's time zone ('UTC' when it can't say)
//   showDayNow(zone, boundary = '12:00') the show's day now, in its zone and with its day boundary
//                                        (09 §9.2): at 1 AM on Sunday a Saturday show's "tonight"
//                                        is Saturday
//   dateLabel(ymd, long)                 "Sat, Oct 17", or "Saturday, October 17, 2026"
//   dateField(label, input, { hint, zone, boundary, weekdays }) → the field with its date in words
//                                        and its quick picks (Tonight, This Saturday, Next week);
//                                        .refresh() after the zone changes
//   zoneInput(value)                     the zones this browser knows, or a text field
import * as api from './api.js';
import { field, h, mount } from './dom.js';

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const minutesOf = (t) => {
  const m = TIME.exec(t || '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
};

export function browserZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}

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

const dayOf = (ymd) => {
  const m = DATE.exec(ymd || '');
  return m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : undefined;
};
export function dateLabel(ymd, long = false) {
  const d = dayOf(ymd);
  if (!d) return ymd || '';
  const opts = long ? { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' } : { weekday: 'short', day: 'numeric', month: 'short' };
  return new Intl.DateTimeFormat(undefined, { ...opts, timeZone: 'UTC' }).format(d);
}
function addDays(ymd, n) {
  const d = dayOf(ymd);
  return d ? new Date(d.getTime() + n * 86400000).toISOString().slice(0, 10) : ymd;
}

// On the server's clock: before the boundary it is still the night before.
export function showDayNow(tz, boundary = '12:00') {
  const p = partsIn(new Date(api.serverNow()), tz);
  const today = `${p.year}-${p.month}-${p.day}`;
  return minutesOf(`${p.hour}:${p.minute}`) < (minutesOf(boundary) || 0) ? addDays(today, -1) : today;
}
const weekdayOf = (ymd) => dayOf(ymd)?.getUTCDay() ?? NaN;
const weekdayName = (ymd) => {
  const d = dayOf(ymd);
  return d ? new Intl.DateTimeFormat(undefined, { weekday: 'long', timeZone: 'UTC' }).format(d) : '';
};
// The first date on or after `from` that falls on the weekday of `like`.
const onWeekday = (from, like) => addDays(from, (weekdayOf(like) - weekdayOf(from) + 7) % 7);

// Quick picks under a date field: Tonight, the next night on the date's weekday, a week after the
// date, and the coming nights of `weekdays` (5, 6: Friday and Saturday). The date in words beside
// them, weekday and all, which a date field doesn't show.
function datePicks(input, { zone, boundary = () => '12:00', weekdays = [] }) {
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
    const picks = [['Tonight', tonight]];
    const weekly = (ymd) => {
      const at = onWeekday(tonight, ymd);
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
export function dateField(label, input, { hint, zone, boundary, weekdays }) {
  const picks = datePicks(input, { zone, boundary, weekdays });
  const el = field(label, input, { hint });
  input.after(picks.words, picks.row);
  el.refresh = picks.refresh;
  return el;
}

// The current zone is always an option.
export function zoneInput(value) {
  let zones = [];
  try { zones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : []; } catch { zones = []; }
  if (!zones.length) return h('input', { type: 'text', value: value || '', autocomplete: 'off', spellcheck: 'false', placeholder: 'America/Toronto' });
  const select = h('select', (value && !zones.includes(value) ? [value, ...zones] : zones).map((z) => h('option', { value: z }, z.replace(/_/g, ' '))));
  if (value) select.value = value;
  return select;
}
