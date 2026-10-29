// Times typed as text (src/ui/time-field.js), the same in every browser: Safari's time box showed
// a placeholder AM/PM that looked set but wasn't, so a lineup typed there was refused as having no
// time. What people type is read ("9pm", "9:30 PM", "21:30", "2130"); "10:30" on a 12-hour clock
// asks for AM or PM instead of guessing; a time that can't be read is refused, never taken as
// empty or as morning, even after the lineup redraws. In a real browser: the lineup, Details and
// a template's time setting (Text & Clock) save the times typed, and a refusal says why, once (a
// second press doesn't stack the same toast), in the box's own words with the box focused, said
// right under it; Details' hints follow what is typed, and an act before the go-live is said.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { startPlatform } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { formatTime, parseTime, timeError, timeProblem, twelveHour } from '../src/ui/time-field.js';
import { browserSkip, launchBrowser } from './cdp.js';
import { defer, memoryLogger, tempDir } from './helpers.js';

const PASSWORD = 'correct horse battery staple';

test('what is typed is read as a time, on a 12-hour and a 24-hour clock', () => {
  const h12 = { h12: true };
  for (const [typed, want] of [
    ['9pm', '21:00'], ['9 PM', '21:00'], ['9:30 p.m.', '21:30'], ['9:30PM', '21:30'], ['12am', '00:00'], ['12:15 pm', '12:15'],
    ['1a', '01:00'], ['21:30', '21:30'], ['2130', '21:30'], ['0930', '09:30'], ['09:30', '09:30'], ['21h30', '21:30'], ['21h', '21:00'], ['0', '00:00'], ['00:05', '00:05'],
    ['21.30', '21:30'], ['10.30pm', '22:30'], ['9:30 PM', '21:30'], ['1030 pm', '22:30'],
  ]) assert.deepEqual(parseTime(typed, h12), { value: want }, typed);
  assert.match(parseTime('9:30', h12).error, /^Add AM or PM: 9:30 PM, or 9:30 AM\.$/);
  assert.match(parseTime('9', h12).error, /Add AM or PM: 9:00 PM/);
  // Without AM or PM, an hour from 1 to 12 is asked about however it's written.
  for (const typed of ['12', '10:30', '11:00', '12:30', '1030', '1130', '1200', '10.30']) assert.match(parseTime(typed, h12).error, /^Add AM or PM/, typed);
  // Seconds, where they're allowed (a template's time setting).
  assert.deepEqual(parseTime('21:30:15', { h12: true, seconds: true }), { value: '21:30:15' });
  assert.deepEqual(parseTime('9:30:15 pm', { h12: true, seconds: true }), { value: '21:30:15' });
  assert.match(parseTime('21:30:15', h12).error, /without seconds/);
  assert.equal(formatTime('21:30:15', h12), '9:30:15 PM');
  assert.equal(timeError('?10:30', h12), 'Add AM or PM: 10:30 PM, or 10:30 AM.');
  assert.equal(timeError('21:30', h12), undefined);
  assert.equal(timeError('', h12), undefined);
  assert.match(parseTime('13pm', h12).error, /the hour is 1 to 12/);
  assert.match(parseTime('25:00', h12).error, /There's no hour 25/);
  assert.match(parseTime('soon', h12).error, /"soon" isn't a time\. Type it like 9:30 PM\./);
  assert.match(parseTime('9:75pm', h12).error, /isn't a time/);
  assert.deepEqual(parseTime('  ', h12), { empty: true });
  // A 24-hour clock: no AM/PM needed.
  assert.deepEqual(parseTime('9:30', { h12: false }), { value: '09:30' });
  assert.deepEqual(parseTime('9', { h12: false }), { value: '09:00' });
  assert.match(parseTime('soon', { h12: false }).error, /like 21:30/);
  assert.equal(formatTime('21:30', h12), '9:30 PM');
  assert.equal(formatTime('00:05', h12), '12:05 AM');
  assert.equal(formatTime('12:00', h12), '12:00 PM');
  assert.equal(formatTime('21:30', { h12: false }), '21:30');
  assert.equal(formatTime('nope', h12), '');
  assert.equal(twelveHour('en-US'), true);
  assert.equal(twelveHour('en-GB'), false);
  // What a form says when it is sent: the box's own words, naming it; the words for an empty one
  // only when a time is needed; never a 24-hour example on a 12-hour clock.
  assert.equal(timeProblem('?10:30', 'Act 2, Headliner DJ', h12), 'Act 2, Headliner DJ: add AM or PM: 10:30 PM, or 10:30 AM.');
  assert.equal(timeProblem('?soon', 'The go-live time', h12), 'The go-live time: "soon" isn\'t a time. Type it like 9:30 PM.');
  assert.equal(timeProblem('', 'The go-live time', h12), undefined, 'optional');
  assert.equal(timeProblem('', 'Act 1', { ...h12, missing: 'Act 1 needs a start time.' }), 'Act 1 needs a start time.');
  assert.equal(timeProblem('22:30', 'Act 1', { ...h12, missing: 'x' }), undefined);
});

test('in a browser: the lineup and Details save the times typed; a time that can\'t be read is refused with why, once', { skip: browserSkip, timeout: 180000 }, async (t) => {
  const root = tempDir(t);
  const config = loadConfig({ argv: ['--port', '0'], env: { SKP_DATA_DIR: path.join(root, 'data'), SKP_CONFIG_DIR: path.join(root, 'config') } });
  const platform = await startPlatform(config, { log: memoryLogger().log, scrypt: { N: 1024 } });
  defer(t, () => platform.stop());
  const setup = await fetch(`${platform.url}/api/v1/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: platform.auth.setupCode, username: 'juan', password: PASSWORD }) });
  const cookie = setup.headers.get('set-cookie').split(';')[0];
  const { csrf } = await setup.json();
  const call = async (method, p, body) => {
    const r = await fetch(`${platform.url}/api/v1${p}`, { method, headers: { cookie, 'x-skp-csrf': csrf, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const show = (await call('POST', '/shows', { name: 'Night', overlays: [], date: '2026-10-31', timezone: 'America/Toronto', lineup: [{ time: '21:00', name: 'Trapment' }] })).body;

  const browser = await launchBrowser(t);
  const page = await browser.open(`${platform.url}/#/login`, { width: 1280, height: 900 });
  await page.send('Emulation.setLocaleOverride', { locale: 'en-US' });
  await page.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await page.goto(`${platform.url}/?l=1#/login`);
  await page.waitFor('document.querySelector("input[name=username]")', 15000);
  assert.equal(await page.eval(`fetch('/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'juan', password: ${JSON.stringify(PASSWORD)} }) }).then((r) => r.status)`), 200);
  await page.goto(`${platform.url}/?signed=1#/shows/${show.id}?tab=lineup`);
  await page.waitFor('document.querySelector("[data-view] input.time-field")', 15000);
  const before = page.problems.length;

  // Types into the nth time box (select all, then the text, as a person would), then leaves it.
  const type = async (n, text) => {
    await page.eval(`(() => { const i = document.querySelectorAll('[data-view] input.time-field')[${n}]; i.focus(); i.select(); })()`);
    await page.send('Input.insertText', { text });
    await page.eval(`document.querySelectorAll('[data-view] input.time-field')[${n}].dispatchEvent(new Event('change', { bubbles: true }))`);
  };
  const box = (n) => page.eval(`(() => { const i = document.querySelectorAll('[data-view] input.time-field')[${n}]; return { shown: Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').get.call(i), value: i.value, invalid: i.getAttribute('aria-invalid'), why: i.validationMessage }; })()`);
  const press = (label) => page.eval(`[...document.querySelectorAll('[data-view] button')].find((b) => b.textContent.trim() === ${JSON.stringify(label)}).click()`);
  const toasts = () => page.eval('[...document.querySelectorAll(".toast span")].map((s) => s.textContent)');

  assert.deepEqual(await box(0), { shown: '9:00 PM', value: '21:00', invalid: null, why: '' }, 'a saved time, as this browser writes it');
  // 10:30 without AM or PM: asked, not guessed (never saved as morning), and the act says so.
  await type(0, '10:30');
  const asked = await box(0);
  assert.deepEqual([asked.value, asked.invalid], ['?10:30', 'true'], 'refused, not taken as empty or as 10:30 AM');
  assert.match(asked.why, /Add AM or PM/);
  // Said right under its box (a phone's keyboard hides the foot of the row), not at the foot.
  const said = (n) => page.eval(`(() => { const i = document.querySelectorAll('[data-view] input.time-field')[${n}]; const m = i.nextElementSibling; return m?.classList.contains('time-error') && !m.hidden ? m.textContent : ''; })()`);
  assert.equal(await said(0), 'Add AM or PM: 10:30 PM, or 10:30 AM.');
  assert.equal((await page.eval('document.querySelector("[data-view] fieldset").innerText')).match(/Add AM or PM/g).length, 1, 'once');
  // A redraw (adding an act) keeps it as typed, still asked: not turned into 10:30 AM.
  await press('Add an act');
  await page.waitFor('document.querySelectorAll("[data-view] input.time-field").length === 2', 5000);
  const redrawn = await box(0);
  assert.deepEqual([redrawn.shown, redrawn.value, redrawn.invalid], ['10:30', '?10:30', 'true']);
  await page.eval('document.querySelectorAll("[data-view] input.time-field")[1].focus()');
  await press('Save lineup');
  await press('Save lineup');
  await page.waitFor('document.querySelector(".toast.error")', 5000);
  await new Promise((r) => setTimeout(r, 300));
  // In the box's own words, naming the act; the focus on the box, not lost.
  assert.deepEqual(await toasts(), ['Act 1, Trapment: add AM or PM: 10:30 PM, or 10:30 AM.'], 'said once, not stacked');
  assert.equal(await page.eval('document.activeElement === document.querySelectorAll("[data-view] input.time-field")[0]'), true);
  assert.equal((await call('GET', `/shows/${show.id}`)).body.lineup[0].time, '21:00', 'nothing saved');
  // 10:30pm: read, written out in full; the new act's row goes; saved as 22:30.
  await type(0, '10:30pm');
  assert.deepEqual(await box(0), { shown: '10:30 PM', value: '22:30', invalid: null, why: '' });
  await page.eval('[...document.querySelectorAll("[data-view] details.menu summary")].at(-1).click()');
  await page.eval('[...document.querySelectorAll("[data-view] details.menu[open] button")].find((b) => b.textContent.trim() === "Remove this act").click()');
  await page.waitFor('document.querySelectorAll("[data-view] input.time-field").length === 1', 5000);
  await press('Save lineup');
  await page.waitFor('[...document.querySelectorAll(".toast span")].some((s) => s.textContent.startsWith("Lineup saved"))', 5000);
  assert.equal((await call('GET', `/shows/${show.id}`)).body.lineup[0].time, '22:30');

  // Details: goes live at, typed; a time that can't be read is refused, not cleared.
  await page.eval(`location.hash = ${JSON.stringify(`#/shows/${show.id}?tab=details`)}`);
  await page.waitFor('[...document.querySelectorAll("[data-view] button")].some((b) => b.textContent.trim() === "Save details")', 15000);
  const goLiveIndex = await page.eval('[...document.querySelectorAll("[data-view] input.time-field")].findIndex((i) => document.querySelector(`label[for="${i.id}"]`)?.textContent === "Goes live at")');
  assert.ok(goLiveIndex >= 0, 'the go-live box');
  await type(goLiveIndex, 'soon');
  // Said under the box once it's left, and tied to it for screen readers.
  const under = await page.eval(`(() => { const i = document.querySelectorAll('[data-view] input.time-field')[${goLiveIndex}]; const m = i.nextElementSibling; return { text: m?.textContent, hidden: m?.hidden, tied: (i.getAttribute('aria-describedby') || '').split(' ').includes(m?.id) }; })()`);
  assert.deepEqual(under, { text: '"soon" isn\'t a time. Type it like 9:30 PM.', hidden: false, tied: true });
  await press('Save details');
  await page.waitFor('[...document.querySelectorAll(".toast.error span")].some((s) => s.textContent === "The go-live time: \\"soon\\" isn\'t a time. Type it like 9:30 PM.")', 5000);
  assert.equal((await call('GET', `/shows/${show.id}`)).body.goLive, undefined, 'nothing saved');
  // The hints follow the form, not the show as saved: the night, the boundary, the go-live; an act
  // set before the go-live is said.
  const hintOf = (label) => page.eval(`(() => { const l = [...document.querySelectorAll('[data-view] label')].find((x) => x.textContent === ${JSON.stringify(label)}); return document.getElementById(l.htmlFor).closest('.field').querySelector('.hint').textContent; })()`);
  await type(goLiveIndex, '11pm');
  assert.match(await hintOf('Goes live at'), /^When the countdown ends: Sat, Oct 31, 11:00 PM\./);
  assert.match(await page.eval('document.querySelector("[data-view] .card").innerText'), /Trapment starts at 10:30 PM, before the show goes live at 11:00 PM: on Auto the countdown covers their set\./);
  const setDate = (ymd) => page.eval(`(() => { const d = document.querySelector('[data-view] input[type=date]'); d.value = ${JSON.stringify(ymd)}; d.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await setDate('2026-11-07');
  assert.match(await hintOf('Goes live at'), /^When the countdown ends: Sat, Nov 7, 11:00 PM\./);
  assert.match(await hintOf('Day boundary'), /plays after midnight, on Sun, Nov 8,/);
  await type(goLiveIndex, '1:30 am');
  assert.match(await hintOf('Goes live at'), /^When the countdown ends: Sun, Nov 8, 1:30 AM\./, 'before the day boundary: the next day');
  await setDate('2026-10-31');
  await type(goLiveIndex, '1030 pm');
  assert.equal((await box(goLiveIndex)).shown, '10:30 PM');
  assert.equal(await page.eval(`document.querySelectorAll('[data-view] input.time-field')[${goLiveIndex}].nextElementSibling.hidden`), true, 'the words go once it\'s right');
  await press('Save details');
  await page.waitFor('[...document.querySelectorAll(".toast span")].some((s) => s.textContent.startsWith("Saved the show\'s"))', 5000);
  const saved = (await call('GET', `/shows/${show.id}`)).body;
  assert.equal(saved.goLive, '22:30');
  assert.equal(saved.goLiveAt, '2026-11-01T02:30:00.000Z', 'Sat Oct 31, 10:30 PM in Toronto');

  // A template's time setting (Text & Clock's countdown time): the same box, the settings form
  // saying what's wrong.
  platform.overlays.create({ slug: 'clock', template: { id: 'com.ctd.text-clock', version: '1.0.0' }, settings: { mode: 'countdown' } });
  await page.eval('location.hash = "#/overlays/clock?tab=settings"');
  await page.waitFor('[...document.querySelectorAll("[data-view] button")].some((b) => b.textContent.trim() === "Save settings")', 15000);
  await page.eval('document.querySelectorAll("[data-view] details").forEach((d) => { d.open = true; })');
  const clockIndex = await page.eval('[...document.querySelectorAll("[data-view] input.time-field")].findIndex((i) => /^Time \\(countdown/.test(document.querySelector(`label[for="${i.id}"]`)?.textContent || ""))');
  assert.ok(clockIndex >= 0, 'the countdown time box');
  await type(clockIndex, '6:30');
  await press('Save settings');
  await page.waitFor('document.querySelector("[data-view]").innerText.includes("Add AM or PM: 6:30 PM, or 6:30 AM.")', 5000);
  assert.equal((await call('GET', '/overlays/clock')).body.settings.targetTime, undefined, 'nothing saved');
  await type(clockIndex, '6:30 am');
  await press('Save settings');
  await page.waitFor('[...document.querySelectorAll(".toast span")].some((s) => s.textContent.startsWith("Settings saved"))', 5000);
  assert.equal((await call('GET', '/overlays/clock')).body.settings.targetTime, '06:30');

  // A phone: the boxes fit.
  await page.resize(390, 844);
  assert.equal(await page.eval('document.documentElement.scrollWidth > innerWidth + 1'), false);
  assert.deepEqual(page.problems.slice(before).filter((p) => !p.startsWith('network:')), []);
});
