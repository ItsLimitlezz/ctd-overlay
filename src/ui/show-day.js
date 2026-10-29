// A show's day and its date field (09 §9.2), for Shows (shows.js) and for a show made outside it
// ("Make a show from this overlay", show-from-overlay.js). One set of rules, so every dialog picks
// the same night:
//
//   browserZone()                        this device's time zone ('UTC' when it can't say)
//   partsIn(date, zone)                  the wall clock of an instant in a zone: { year, month, day,
//                                        hour, minute } as strings
//   showDayNow(zone, boundary = '12:00') the show's day now, in its zone and with its day boundary:
//                                        at 1 AM on Sunday a Saturday show's "tonight" is Saturday
//   dateLabel(ymd, long)                 "Sat, Oct 17", or "Saturday, October 17, 2026"
//   addDays(ymd, n), weekdayName(ymd), onWeekday(from, like)  dates as "2026-10-17"
//   dateField(label, input, { hint, zone, boundary, weekdays, future }) → the field with its date
//                                        in words and its quick picks (Tonight, This Saturday, Next
//                                        week); .refresh() after the zone changes
//   zoneInput(value, { disabled })       the zones this browser knows, or a text field
//   newNight()                           a new show's date and time zone, as New show and "Make a
//                                        show from this overlay" have them: { date, tz, dateEl,
//                                        tzEl }
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

// A zone's formatter is made once (a timeline asks for hundreds of instants).
const wallFormats = new Map();
export function partsIn(date, timeZone) {
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
export function addDays(ymd, n) {
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
export const weekdayName = (ymd) => {
  const d = dayOf(ymd);
  return d ? new Intl.DateTimeFormat(undefined, { weekday: 'long', timeZone: 'UTC' }).format(d) : '';
};
// The first date on or after `from` that falls on the weekday of `like`.
export const onWeekday = (from, like) => addDays(from, (weekdayOf(like) - weekdayOf(from) + 7) % 7);

// Quick picks under a date field (v0's "This Saturday"), for a weekly show: Tonight, the next night
// on the date's weekday, and the week after that night; a new show, with no weekday of its own yet,
// also gets the coming Friday and Saturday (weekdays: 5, 6). Tonight is the show's day now in the
// zone and with the day boundary the form has (zone(), boundary()). A plan, for a night still to
// come (future), gets no Tonight: its picks start tomorrow, so on a Monday a Monday plan's are
// "Next Monday" and "In two weeks". Every pick counts from tonight, never from the date in the
// field: the one picked shows as pressed, and pressing it again changes nothing. The date is said
// in words beside them, weekday and all, which a date field doesn't show.
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
    // A week or more from tonight: "Next", not "This".
    const later = (ymd) => ymd >= addDays(tonight, 7);
    const weekly = (ymd) => {
      const at = onWeekday(future ? addDays(tonight, 1) : tonight, ymd);
      if (!picks.some(([, d]) => d === at)) picks.push([`${later(at) ? 'Next' : 'This'} ${weekdayName(ymd)}`, at]);
      return at;
    };
    // A week's dates from a Sunday (2026-10-18): one for each weekday asked.
    for (const wd of weekdays) weekly(addDays('2026-10-18', wd));
    if (v) {
      const after = addDays(weekly(v), 7);
      picks.push([later(addDays(after, -7)) ? 'In two weeks' : 'Next week', after]);
    }
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
export function dateField(label, input, { hint, zone, boundary, weekdays, future }) {
  const picks = datePicks(input, { zone, boundary, weekdays, future });
  const el = field(label, input, { hint });
  input.after(picks.words, picks.row);
  el.refresh = picks.refresh;
  return el;
}

// The time zone control: a list of the zones this browser knows, or a text field where it can't
// list them. The current zone is always an option.
export function zoneInput(value, { disabled } = {}) {
  let zones = [];
  try { zones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : []; } catch { zones = []; }
  if (!zones.length) return h('input', { type: 'text', value: value || '', autocomplete: 'off', spellcheck: 'false', placeholder: 'America/Toronto', disabled });
  const list = value && !zones.includes(value) ? [value, ...zones] : zones;
  const select = h('select', { disabled }, list.map((z) => h('option', { value: z }, z.replace(/_/g, ' '))));
  if (value) select.value = value;
  return select;
}

// A new show's night: this device's zone, and the show's day now there (after midnight, still the
// night before), with the quick picks of a weekly show. The date follows the zone chosen until it
// is picked, by hand or with a quick pick. dateEl and tzEl are the fields.
export function newNight() {
  const zone = browserZone();
  const date = h('input', { type: 'date', value: showDayNow(zone), required: true });
  const tz = zoneInput(zone);
  const dateEl = dateField('Date', date, { hint: 'The night of the show. Acts after midnight still belong to this date.', zone: () => tz.value.trim() || zone, weekdays: [5, 6] });
  let picked = false;
  date.addEventListener('input', () => { picked = true; });
  tz.addEventListener('change', () => {
    if (!picked && tz.value.trim()) date.value = showDayNow(tz.value.trim());
    dateEl.refresh();
  });
  const tzEl = field('Time zone', tz, { hint: 'Where the show happens. Its times are in this zone, wherever your phone is.' });
  return { date, tz, dateEl, tzEl };
}
