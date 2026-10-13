// The time rule (09 §9.2): wall-clock show times to instants, with the day boundary and the
// clock changes (H19: tested on a daylight-saving night).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDate, isTime, isTimezone, resolveTime, showDay } from '../src/shows/time.js';

const iso = (r) => new Date(r.at).toISOString();
const TO = { timezone: 'America/Toronto', dayBoundary: '12:00' };

test('a time before the day boundary is the next calendar day (a club night)', () => {
  assert.equal(iso(resolveTime('2026-08-28', '22:30', TO)), '2026-08-29T02:30:00.000Z'); // EDT, UTC-4
  assert.equal(iso(resolveTime('2026-08-28', '01:00', TO)), '2026-08-29T05:00:00.000Z');
  assert.equal(resolveTime('2026-08-28', '01:00', TO).day, '2026-08-29');
  assert.equal(resolveTime('2026-08-28', '12:00', TO).day, '2026-08-28', 'the boundary itself is the show\'s own day');
  assert.equal(resolveTime('2026-08-28', '11:59', TO).day, '2026-08-29');
  // An afternoon show sets an early boundary.
  assert.equal(resolveTime('2026-08-28', '07:00', { timezone: 'America/Toronto', dayBoundary: '06:00' }).day, '2026-08-28');
  // Year and month ends roll over.
  assert.equal(iso(resolveTime('2026-12-31', '01:00', TO)), '2027-01-01T06:00:00.000Z');
});

test('spring forward: a skipped time moves forward by the gap; fall back: a repeated time is the first one', () => {
  // Toronto, 2026-03-08 02:00 EST → 03:00 EDT. 02:30 doesn't exist: it becomes 03:30 EDT.
  const gap = resolveTime('2026-03-07', '02:30', TO);
  assert.equal(iso(gap), '2026-03-08T07:30:00.000Z');
  assert.deepEqual([gap.gap, gap.overlap], [true, false]);
  assert.equal(iso(resolveTime('2026-03-07', '01:59', TO)), '2026-03-08T06:59:00.000Z', 'just before: EST');
  assert.equal(iso(resolveTime('2026-03-07', '03:00', TO)), '2026-03-08T07:00:00.000Z', 'just after: EDT');
  // 2026-11-01 02:00 EDT → 01:00 EST. 01:30 happens twice: the first, in EDT.
  const twice = resolveTime('2026-10-31', '01:30', TO);
  assert.equal(iso(twice), '2026-11-01T05:30:00.000Z');
  assert.deepEqual([twice.gap, twice.overlap], [false, true]);
  assert.equal(iso(resolveTime('2026-10-31', '02:30', TO)), '2026-11-01T07:30:00.000Z', 'after the overlap: EST');
  // The other hemisphere, and a zone with a 30-minute offset and no clock changes.
  assert.equal(iso(resolveTime('2026-04-04', '02:30', { timezone: 'Australia/Sydney', dayBoundary: '12:00' })), '2026-04-04T15:30:00.000Z', 'Sydney falls back 5 April: first 02:30 is AEDT');
  assert.equal(iso(resolveTime('2026-08-28', '22:00', { timezone: 'Asia/Kolkata', dayBoundary: '12:00' })), '2026-08-28T16:30:00.000Z');
  assert.equal(iso(resolveTime('2026-08-28', '22:00', { timezone: 'UTC', dayBoundary: '12:00' })), '2026-08-28T22:00:00.000Z');
});

test('a show\'s day runs from its boundary to the next one, 23 or 25 hours on a clock-change night', () => {
  const normal = showDay('2026-08-28', TO);
  assert.equal(normal.end - normal.start, 24 * 3600000);
  const spring = showDay('2026-03-07', TO);
  assert.equal(spring.end - spring.start, 23 * 3600000);
  const fall = showDay('2026-10-31', TO);
  assert.equal(fall.end - fall.start, 25 * 3600000);
});

test('what counts as a date, a time and a timezone', () => {
  for (const ok of ['2026-08-28', '2024-02-29']) assert.equal(isDate(ok), true, ok);
  for (const bad of ['2026-02-29', '2026-13-01', '26-08-28', '2026-8-28', '', null]) assert.equal(isDate(bad), false, String(bad));
  for (const ok of ['00:00', '09:05', '23:59']) assert.equal(isTime(ok), true, ok);
  for (const bad of ['24:00', '9:05', '12:60', '12:00:00', '']) assert.equal(isTime(bad), false, bad);
  for (const ok of ['America/Toronto', 'UTC', 'Europe/London']) assert.equal(isTimezone(ok), true, ok);
  for (const bad of ['Mars/Olympus', '', 'EST5EDT,M3.2.0']) assert.equal(isTimezone(bad), false, bad);
});
