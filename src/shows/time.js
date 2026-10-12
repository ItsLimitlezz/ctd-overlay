// The time rule (09 §9.2): a show's wall-clock times ("01:00") become instants once, here, on the
// server, in the show's own timezone; clients only ever see instants.
//
// - A time before the day boundary belongs to the next calendar day: with date 2026-08-28 and a
//   12:00 boundary, 01:00 is 2026-08-29 01:00 (a club night).
// - A time the clocks skip (spring forward) moves forward by the length of the gap: 02:30 becomes
//   03:30. A time that happens twice (fall back) means the first occurrence. This is Temporal's
//   "compatible" disambiguation.
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DAY = 24 * 60 * 60 * 1000;

export const isTime = (s) => typeof s === 'string' && TIME.test(s);
export function isDate(s) {
  const m = typeof s === 'string' && DATE.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}
export function isTimezone(tz) {
  if (typeof tz !== 'string' || !tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const formatters = new Map();
// The zone's offset from UTC at an instant, in ms (positive east of Greenwich).
function offsetAt(timezone, t) {
  let f = formatters.get(timezone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    formatters.set(timezone, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(t)).filter((x) => x.type !== 'literal').map((x) => [x.type, Number(x.value)]));
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour === 24 ? 0 : p.hour, p.minute, p.second);
  return wall - Math.floor(t / 1000) * 1000;
}

// The instant a wall-clock time (as a UTC-based ms number) is in the zone: { at, gap, overlap }.
function fromWall(timezone, wall) {
  const before = offsetAt(timezone, wall - DAY);
  const after = offsetAt(timezone, wall + DAY);
  const valid = [...new Set([wall - before, wall - after])].filter((t) => t + offsetAt(timezone, t) === wall).sort((a, b) => a - b);
  if (valid.length) return { at: valid[0], overlap: valid.length > 1, gap: false };
  // Skipped: read with the offset in force before the jump, which lands as far past it as the
  // time was into it.
  return { at: wall - before, overlap: false, gap: true };
}

// The instant `time` ("HH:MM") resolves to for a show on `date` ("YYYY-MM-DD") in `timezone`,
// with its day boundary ("HH:MM"): { at (epoch ms), day (the calendar date it falls on), gap,
// overlap } so the admin UI can flag times that fell in a clock change (09 §9.2).
export function resolveTime(date, time, { timezone, dayBoundary = '12:00' }) {
  const d = DATE.exec(date);
  const t = TIME.exec(time);
  const b = TIME.exec(dayBoundary);
  if (!d || !t || !b) throw new TypeError(`can't resolve ${date} ${time} (boundary ${dayBoundary})`);
  const nextDay = Number(t[1]) * 60 + Number(t[2]) < Number(b[1]) * 60 + Number(b[2]);
  const day = new Date(Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]) + (nextDay ? 1 : 0)));
  const wall = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), Number(t[1]), Number(t[2]));
  return { ...fromWall(timezone, wall), day: day.toISOString().slice(0, 10) };
}

// A show's calendar day as it begins (its day boundary) and ends (the next day's boundary), as
// instants: the window in which its times fall.
export function showDay(date, { timezone, dayBoundary = '12:00' }) {
  const start = resolveTime(date, dayBoundary, { timezone, dayBoundary: '00:00' }).at;
  const next = new Date(Date.UTC(...date.split('-').map((n, i) => Number(n) - (i === 1 ? 1 : 0))) + DAY).toISOString().slice(0, 10);
  return { start, end: resolveTime(next, dayBoundary, { timezone, dayBoundary: '00:00' }).at };
}
