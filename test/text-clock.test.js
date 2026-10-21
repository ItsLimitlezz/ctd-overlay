// The Text & Clock template (com.ctd.text-clock): its arithmetic on its own (clock.js, in a VM),
// then in a real browser on a server clock the test sets: the time of day in a time zone, a
// countdown that reaches zero and shows its words, a count-up, the stream's run time and a
// frame-accurate timecode from CTD Relay's stream.clock, settings that apply live, sample data,
// and nothing broken when the data is missing or odd.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { validateTemplate } from '../src/templates/registry.js';
import { browserSkip, launchBrowser } from './cdp.js';
import { defer, startWithOverlay } from './helpers.js';

const DIR = fileURLToPath(new URL('../templates/text-clock/', import.meta.url));
const TEXT_CLOCK = { id: 'com.ctd.text-clock', version: '1.0.0' };
const HOUR = 3600000;
const MIN = 60000;

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(readFileSync(path.join(DIR, 'clock.js'), 'utf8'), sandbox);
const T = sandbox.TextClock;

describe('the package and its arithmetic', () => {
  test('it validates with nothing to warn about, on both canvases, consuming the stream clock', () => {
    const result = validateTemplate(DIR);
    assert.deepEqual([result.errors, result.warnings], [[], []]);
    const manifest = JSON.parse(readFileSync(path.join(DIR, 'template.json'), 'utf8'));
    assert.equal(manifest.id, 'com.ctd.text-clock');
    assert.deepEqual(manifest.canvases.map((c) => `${c.id} ${c.width}x${c.height}`), ['h 1920x1080', 'v 1080x1920']);
    assert.ok(manifest.consumes.state.includes('stream.clock'));
    // Every clock reads the server's time: no Date.now() in the template.
    for (const file of ['template.js', 'clock.js']) assert.doesNotMatch(readFileSync(path.join(DIR, file), 'utf8'), /Date\.now\(/, file);
  });

  test('timecodes are HH:MM:SS:FF, non-drop-frame, at the feed\'s rate, hours past 24', () => {
    assert.equal(T.timecode(0, 30), '00:00:00:00');
    assert.equal(T.timecode(HOUR + 2 * MIN + 3000 + 500, 30), '01:02:03:15');
    assert.equal(T.timecode(999, 30), '00:00:00:29');
    assert.equal(T.timecode(999, 25), '00:00:00:24');
    assert.equal(T.timecode(999, 60), '00:00:00:59');
    assert.equal(T.timecode(33, 30), '00:00:00:00');
    assert.equal(T.timecode(34, 30), '00:00:00:01');
    assert.equal(T.timecode(30 * HOUR + 7, 30), '30:00:00:00');
    assert.equal(T.timecode(-5000, 30), '00:00:00:00', 'never negative');
    assert.equal(T.timecode(1500, 'x'), '00:00:01:15', 'an odd rate is 30');
    // The time of day as a timecode, in UTC and in a zone.
    const t = Date.parse('2026-10-17T22:15:30.400Z');
    assert.equal(T.timecodeOfDay(t, 'UTC', 30), '22:15:30:12');
    assert.equal(T.timecodeOfDay(t, 'America/New_York', 25), '18:15:30:10');
    assert.equal(T.timecode(undefined, 30), undefined);
  });

  test('lengths of time, the time of day in a zone, and wall times in a zone (clock changes too)', () => {
    assert.deepEqual([T.duration(0), T.duration(59999), T.duration(HOUR + 2 * MIN + 3000), T.duration(27 * HOUR + 4 * MIN + 5000), T.duration(-1)], ['00:00', '00:59', '1:02:03', '1d 03:04:05', '00:00']);
    assert.deepEqual([T.duration(500, { ceil: true }), T.duration(1000, { ceil: true }), T.duration(1001, { ceil: true })], ['00:01', '00:01', '00:02']);
    const t = Date.parse('2026-07-04T00:59:56.500Z');
    assert.equal(T.timeOfDay(t, 'America/New_York', { hour12: true }), '8:59:56 PM');
    assert.equal(T.timeOfDay(t, 'America/New_York', { hour12: false }), '20:59:56');
    assert.equal(T.timeOfDay(t, 'Asia/Kathmandu', { hour12: false, seconds: false }), '06:44');
    assert.equal(T.timeOfDay(Date.parse('2026-07-04T04:05:00Z'), 'America/New_York', { hour12: true }), '12:05:00 AM');
    assert.equal(T.timeOfDay(Date.parse('2026-07-04T16:05:00Z'), 'America/New_York', { hour12: true }), '12:05:00 PM');
    assert.equal(T.zone('Not/AZone'), undefined, 'an unknown zone is the browser\'s own');
    assert.equal(typeof T.timeOfDay(t, 'Not/AZone', {}), 'string', 'and never throws');
    assert.equal(T.timeOfDay('soon', 'UTC', {}), undefined);
    // Wall times: 21:00 in New York in summer; the hour that doesn't exist (spring) lands after
    // the change, the one that happens twice (autumn) on the first.
    assert.equal(new Date(T.zonedTime('2026-07-03', '21:00', 'America/New_York')).toISOString(), '2026-07-04T01:00:00.000Z');
    assert.equal(new Date(T.zonedTime('2026-03-08', '02:30', 'America/New_York')).toISOString(), '2026-03-08T07:30:00.000Z');
    assert.equal(new Date(T.zonedTime('2026-11-01', '01:30', 'America/New_York')).toISOString(), '2026-11-01T05:30:00.000Z');
    assert.equal(T.zonedTime('2026-13-45', '21:00', 'UTC'), undefined);
    // A time alone: the nearest one, so it counts down through the day and stays reached overnight.
    assert.equal(new Date(T.nearest('21:00', 'America/New_York', Date.parse('2026-07-04T14:00:00Z'))).toISOString(), '2026-07-05T01:00:00.000Z');
    assert.equal(new Date(T.nearest('21:00', 'America/New_York', Date.parse('2026-07-05T05:00:00Z'))).toISOString(), '2026-07-05T01:00:00.000Z');
  });
});

// ---- in a browser ------------------------------------------------------------------------------
let browser;
before(async () => { if (!browserSkip) browser = await launchBrowser(); });
after(async () => { if (browser) await browser.close(); });
const opts = { skip: browserSkip, timeout: 60000 };

// The server's clock, set by the test: this process's Date.now() is the platform's clock, so the
// platform (and through SK.clock every overlay page) runs from `iso` on, at the normal rate.
const realNow = Date.now;
function serverTime(t, iso) {
  const shift = Date.parse(iso) - realNow();
  Date.now = () => realNow() + shift;
  defer(t, () => { Date.now = realNow; }); // after the platform stops (cleanup runs last-first)
}

async function open(t, { settings = {}, state = {}, canvas, query = {} } = {}) {
  const ctx = await startWithOverlay(t, { slug: 'tc', template: TEXT_CLOCK, settings });
  for (const [key, value] of Object.entries(state)) ctx.platform.bus.setState(key, value);
  const vertical = canvas === 'v';
  const params = new URLSearchParams({ ...(vertical ? { canvas: 'v' } : {}), ...query }).toString();
  const page = await browser.open(`${ctx.base}${params ? `?${params}` : ''}`, vertical ? { width: 1080, height: 1920 } : { width: 1920, height: 1080 });
  defer(t, () => page.close().catch(() => {}));
  await page.waitFor('window.SK && SK.scene && document.querySelector("[data-tc] [data-clock]")', 10000);
  // The clock as shown, the server time it was worked out for, and the page's server time now.
  const clock = () => page.eval(`(() => {
    const c = document.querySelector('[data-clock]');
    const w = document.querySelector('[data-clockwrap]');
    const l = document.querySelector('[data-label]');
    return { text: c.textContent, at: Number(c.getAttribute('data-at')), now: SK.clock.now(), shown: !w.hidden, label: l.hidden ? null : l.textContent, zero: w.classList.contains('zero') };
  })()`);
  const lines = () => page.eval('[...document.querySelectorAll("[data-line]")].filter((e) => !e.hidden).map((e) => e.textContent)');
  const shows = (re) => page.waitFor(`${re}.test(document.querySelector("[data-clock]").textContent) && !document.querySelector("[data-clockwrap]").hidden`, 15000);
  const set = (s) => ctx.platform.overlays.updateSettings('tc', s);
  return { ...ctx, page, clock, lines, shows, set };
}

const NOTHING = /\b(undefined|null|NaN)\b|\[object /;

describe('Text & Clock in a browser', () => {
  test('the time of day in the chosen zone, on the server\'s clock, 12- or 24-hour; settings apply live', opts, async (t) => {
    serverTime(t, '2026-07-04T00:59:50.000Z'); // 8:59:50 PM in New York
    const settings = { mode: 'time', timezone: 'America/New_York', hour12: true, seconds: true, line1: 'MIAMI OR BUST', line2: 'Road to Miami · Day 3' };
    const { page, clock, lines, shows, set } = await open(t, { settings });
    await shows('/^8:59:5\\d PM$/');
    let c = await clock();
    assert.equal(c.text, T.timeOfDay(c.at, 'America/New_York', { hour12: true }));
    assert.ok(Math.abs(c.now - Date.now()) < 1000, 'the page runs on the server\'s clock, not its own');
    assert.deepEqual(await lines(), ['MIAMI OR BUST', 'Road to Miami · Day 3']);
    await shows('/^9:00:0\\d PM$/');
    // Another zone, 24 hours, no seconds, a label below; line 1 emptied: hidden.
    set({ ...settings, timezone: 'Asia/Tokyo', hour12: false, seconds: false, line1: '', label: 'TOKYO', labelPosition: 'below' });
    await shows('/^\\d\\d:\\d\\d$/');
    c = await clock();
    assert.equal(c.text, T.timeOfDay(c.at, 'Asia/Tokyo', { hour12: false, seconds: false }));
    assert.equal(c.label, 'TOKYO');
    assert.deepEqual(await lines(), ['Road to Miami · Day 3']);
    assert.equal(await page.eval('document.querySelector("[data-clockwrap]").classList.contains("below")'), true);
    // Look settings reach the page as they change.
    set({ ...settings, position: 'top-right', color: '#FFD23F', pill: false, size: 40 });
    await page.waitFor('document.querySelector("[data-tc]").getAttribute("data-h") === "end" && !document.querySelector("[data-tc]").classList.contains("pill")');
    assert.equal(await page.eval('getComputedStyle(document.querySelector(".l1")).color'), 'rgb(255, 210, 63)');
    assert.equal(await page.eval('getComputedStyle(document.querySelector(".l1")).fontSize'), '40px');
    assert.equal(await page.eval('document.querySelector("[data-tc]").getAttribute("data-align")'), 'right');
    assert.deepEqual(page.problems, []);
  });

  test('a countdown to a date and time in a zone reaches zero on time and shows its words', opts, async (t) => {
    serverTime(t, '2026-10-17T00:59:52.000Z'); // 06:29:52 in Kolkata
    const target = Date.parse('2026-10-17T01:00:00.000Z');
    const settings = { mode: 'countdown', timezone: 'Asia/Kolkata', targetDate: '2026-10-17', targetTime: '06:30', atZero: 'WE\'RE LIVE', label: 'STARTING IN', line1: 'MIAMI OR BUST' };
    const { page, clock, shows } = await open(t, { settings });
    await shows('/^00:0[1-8]$/');
    const c = await clock();
    assert.equal(c.text, T.duration(target - c.at, { ceil: true }));
    assert.deepEqual([c.label, c.zero], ['STARTING IN', false]);
    await shows('/^WE\'RE LIVE$/');
    assert.ok(Date.now() - target < 1000 && Date.now() >= target - 50, `on time: ${Date.now() - target} ms after`);
    assert.equal((await clock()).zero, true);
    assert.deepEqual(page.problems, []);
  });

  test('a count-up since a time, and a countdown with no time of its own runs to the show\'s go-live', opts, async (t) => {
    serverTime(t, '2026-10-17T01:31:00.000Z'); // 07:01:00 in Kolkata
    const since = Date.parse('2026-10-17T00:27:57.000Z'); // 05:57:57 there
    const settings = { mode: 'countup', timezone: 'Asia/Kolkata', targetDate: '2026-10-17', targetTime: '05:57:57' };
    const { clock, shows, set, platform, page } = await open(t, { settings });
    await shows('/^1:03:0\\d$/');
    const c = await clock();
    assert.equal(c.text, T.duration(c.at - since));
    // No time set: the go-live a show gives (or nothing to count, hidden).
    set({ mode: 'countdown' });
    await page.waitFor('document.querySelector("[data-clockwrap]").hidden');
    platform.bus.setState('show.goLiveAt', Date.now() + 10 * MIN);
    await shows('/^(09:5\\d|10:00)$/');
    assert.deepEqual(page.problems, []);
  });

  test('the stream\'s run time counts from CTD Relay\'s start, and shows "—" while there is none', opts, async (t) => {
    serverTime(t, '2026-10-17T03:00:00.000Z');
    const startedAt = Date.now() - (2 * HOUR + 3 * MIN + 4000);
    const { clock, shows, platform, page, set } = await open(t, { settings: { mode: 'runtime', label: 'ON AIR FOR' }, state: { 'stream.clock': { startedAt, fps: 30, offsetMs: 0, at: Date.now() } } });
    await shows('/^2:03:0\\d$/');
    const c = await clock();
    assert.equal(c.text, T.duration(c.at - startedAt));
    platform.bus.setState('stream.clock', { fps: 30, offsetMs: 0, at: Date.now() }); // the session stopped
    await shows('/^—$/');
    platform.bus.setState('stream.clock', { startedAt: 'yesterday', fps: 'fast' }); // nonsense: absent
    await new Promise((r) => setTimeout(r, 300));
    assert.equal((await clock()).text, '—');
    // Unknown to CTD Relay, a time set is the fallback.
    set({ mode: 'runtime', targetDate: '2026-10-17', targetTime: '02:00', timezone: 'UTC' });
    await shows('/^1:00:0\\d$/');
    assert.deepEqual(page.problems, []);
  });

  test('a timecode is HH:MM:SS:FF at the feed\'s rate, frame-accurate on every frame; UTC on CTD Relay\'s clock', opts, async (t) => {
    serverTime(t, '2026-10-17T03:00:00.000Z');
    const startedAt = Date.now() - (HOUR + 2 * MIN + 3500);
    const { page, clock, shows, platform, set } = await open(t, { settings: { mode: 'timecode', timecodeSource: 'run' }, state: { 'stream.clock': { startedAt, fps: 30, offsetMs: 0, at: Date.now() } } });
    await shows('/^01:02:0\\d:\\d\\d$/');
    const frames = new Set();
    for (let i = 0; i < 8; i++) {
      const c = await clock();
      assert.equal(c.text, T.timecode(c.at - startedAt, 30), 'exactly the frame of the time it shows');
      assert.ok(c.now - c.at < 250, `painted every frame, not once a second (${c.now - c.at} ms old)`);
      assert.ok(Number(c.text.slice(-2)) < 30);
      frames.add(c.text);
      await new Promise((r) => setTimeout(r, 45));
    }
    assert.ok(frames.size >= 4, `the frames move: ${[...frames]}`);
    // 25 fps from CTD Relay: frames 00–24.
    platform.bus.setState('stream.clock', { startedAt, fps: 25, offsetMs: 2000, at: Date.now() });
    await page.waitFor('(() => { const c = document.querySelector("[data-clock]"); return c.textContent.length === 11; })()');
    await new Promise((r) => setTimeout(r, 100));
    let c = await clock();
    assert.equal(c.text, T.timecode(c.at - startedAt, 25));
    // The time of day in UTC, on CTD Relay's clock (2 s ahead of this server's).
    set({ mode: 'timecode', timecodeSource: 'utc' });
    await shows('/^03:00:\\d\\d:\\d\\d$/');
    c = await clock();
    assert.equal(c.text, T.timecodeOfDay(c.at + 2000, 'UTC', 25));
    // Run time with no stream: "—", and nothing breaks.
    set({ mode: 'timecode', timecodeSource: 'run' });
    platform.bus.setState('stream.clock', undefined);
    await shows('/^—$/');
    assert.deepEqual(page.problems, []);
  });

  test('with no data at all every mode shows what it can and nothing breaks, on both canvases', opts, async (t) => {
    for (const canvas of ['h', 'v']) {
      const { page, clock, set } = await open(t, { canvas, settings: { line1: 'x'.repeat(200), position: 'bottom-right' } });
      const expect = { none: false, time: true, countdown: false, countup: false, runtime: '—', timecode: '—' };
      for (const [mode, want] of Object.entries(expect)) {
        set({ mode, line1: 'x'.repeat(200), position: 'bottom-right' });
        await page.waitFor(`document.querySelector("[data-clockwrap]").getAttribute("data-mode") === ${JSON.stringify(mode)}`);
        await new Promise((r) => setTimeout(r, 150));
        const c = await clock();
        assert.equal(c.shown, want !== false, `${canvas} ${mode}`);
        if (typeof want === 'string') assert.equal(c.text, want, `${canvas} ${mode}`);
        assert.doesNotMatch(await page.eval('document.querySelector("[data-skp-stage]").innerText'), NOTHING, `${canvas} ${mode}`);
        // A long line wraps inside the frame.
        const box = await page.eval('(() => { const r = document.querySelector("[data-box]").getBoundingClientRect(); return [r.left, r.right, r.top, r.bottom]; })()');
        const [w, h] = canvas === 'v' ? [1080, 1920] : [1920, 1080];
        assert.ok(box[0] >= 0 && box[1] <= w && box[2] >= 0 && box[3] <= h, `${canvas} ${mode}: inside the frame (${box})`);
      }
      assert.deepEqual(page.problems, [], canvas);
    }
  });

  test('sample data (?mock=1): lines, a label and a countdown to ten minutes from now; the run time from the sample stream', opts, async (t) => {
    const { page, clock, lines, shows } = await open(t, { query: { mock: '1' } });
    await shows('/^(09:\\d\\d|10:00)$/');
    assert.deepEqual(await lines(), ['MIAMI OR BUST', 'Road to Miami · Day 3']);
    assert.equal((await clock()).label, 'STARTING IN');
    assert.deepEqual(page.problems, []);
    const tc = await open(t, { canvas: 'v', settings: { mode: 'timecode' }, query: { mock: '1' } });
    await tc.shows('/^00:42:\\d\\d:\\d\\d$/');
    assert.deepEqual(tc.page.problems, []);
  });
});
