// A show night set up in the admin UI (08, 09), in a real browser: what v0's one setup did, on a
// show. An overlay in no show says so (with no show yet too) and makes a show, which starts on its
// countdown; dates have quick picks in the show's zone and day boundary; a lineup's names come from
// every lineup (v0's roster) with their logos; the timeline is built from it, a card picks its act
// (and puts them on), all cues still to come are re-armed at once, and a time the clocks repeat
// says which it is; a plan has a lineup of its own, changed with If-Match and made the show by hand
// (not while live), for a night still to come; a night that has passed says so and moves on,
// keeping unsaved edits; a tab change that would lose edits asks first. With no console error, and
// at a phone's width with no sideways scrolling.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { startPlatform } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { browserSkip, launchBrowser } from './cdp.js';
import { defer, memoryLogger, signedIn, tempDir } from './helpers.js';

const PASSWORD = 'correct horse battery staple';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
// The TAKEOVER template that ships with the platform, at the version it ships at.
const TAKEOVER = { id: 'com.dprtmnt.takeover', version: JSON.parse(readFileSync(new URL('../templates/takeover/template.json', import.meta.url), 'utf8')).version };
const ZONE = 'America/Toronto';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const opts = { skip: browserSkip, timeout: 240000 };

// ---- dates, as the page works them out (09 §9.2): the show's day now, in its zone ----------------
function wall(t, timeZone) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: (Number(p.hour) % 24) * 60 + Number(p.minute) };
}
const addDays = (ymd, n) => new Date(Date.UTC(...ymd.split('-').map((v, i) => Number(v) - (i === 1 ? 1 : 0))) + n * 86400000).toISOString().slice(0, 10);
const weekday = (ymd) => new Date(`${ymd}T00:00:00Z`).getUTCDay();
const tonight = (boundary = 12 * 60) => {
  const w = wall(Date.now(), ZONE);
  return w.minutes < boundary ? addDays(w.date, -1) : w.date;
};
const onWeekday = (from, like) => addDays(from, (weekday(like) - weekday(from) + 7) % 7);

async function start(t) {
  const root = tempDir(t);
  const config = loadConfig({ argv: ['--port', '0'], env: { SKP_DATA_DIR: path.join(root, 'data'), SKP_CONFIG_DIR: path.join(root, 'config') } });
  const platform = await startPlatform(config, { log: memoryLogger().log, scrypt: { N: 1024 } });
  defer(t, () => platform.stop());
  return platform;
}

// The owner, signed in from Node as another device would be: call(method, path, body, headers).
async function owner(platform) {
  const res = await fetch(`${platform.url}/api/v1/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: platform.auth.setupCode, username: 'juan', password: PASSWORD }) });
  assert.ok(res.ok);
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const { csrf } = await res.json();
  return async (method, p, body, headers = {}) => {
    const raw = Buffer.isBuffer(body);
    const out = await fetch(`${platform.url}/api/v1${p}`, {
      method,
      headers: { cookie, 'x-skp-csrf': csrf, ...(body !== undefined ? { 'content-type': raw ? 'image/png' : 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
    });
    const text = await out.text();
    let json;
    try { json = JSON.parse(text); } catch { json = text; }
    return { status: out.status, body: json, etag: out.headers.get('etag') };
  };
}
// The platform's own token (no If-Match needed): another operator's change, made meanwhile.
const other = (platform, method, p, body, headers = {}) => fetch(`${platform.url}/api/v1${p}`, { method, headers: signedIn(platform, { 'content-type': 'application/json', ...headers }), body: body === undefined ? undefined : JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

// The browser, signed in as the owner (the app stays the same document), at a route. page.browser
// opens more pages (an overlay's) in the same browser.
async function openSignedIn(t, platform, route, { width = 1280, height = 900 } = {}) {
  const browser = await launchBrowser(t);
  const page = await browser.open(`${platform.url}/#/login`, { width, height });
  page.browser = browser;
  await page.waitFor('document.querySelector("input[name=username]")', 15000);
  await page.eval(`(() => {
    document.querySelector('input[name=username]').value = 'juan';
    document.querySelector('input[name=password]').value = ${JSON.stringify(PASSWORD)};
    document.querySelector('form').requestSubmit();
  })()`);
  await page.waitFor('location.hash.startsWith("#/live") && document.querySelector("[data-view] h1")', 15000);
  if (route) await go(page, route);
  return page;
}
async function go(page, route, ready = 'true') {
  await page.eval(`location.hash = ${JSON.stringify(`#${route}`)}`);
  await page.waitFor(`!document.querySelector("[data-view] > .loading") && document.querySelector("[data-view] h1") && (${ready})`, 15000);
}
const click = (page, selector, text) => page.eval(`(() => {
  const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((b) => !b.closest('[hidden]') && (b.textContent.trim() === ${JSON.stringify(text)} || b.getAttribute('aria-label') === ${JSON.stringify(text)}));
  if (!el) throw new Error('nothing to click: ' + ${JSON.stringify(`${selector} ${text}`)});
  el.click();
})()`);
// Opens the menu whose button is named so (the one that has the item) and chooses the item.
const choose = async (page, menuName, item) => {
  await page.eval(`(() => {
    const d = [...document.querySelectorAll('[data-view] details.menu')].find((x) => {
      const s = x.querySelector('summary');
      return (s.getAttribute('aria-label') || s.textContent.trim()) === ${JSON.stringify(menuName)}
        && [...x.querySelectorAll('[role=menuitem]')].some((b) => b.textContent.trim() === ${JSON.stringify(item)});
    });
    if (!d) throw new Error('no menu ' + ${JSON.stringify(`${menuName} with ${item}`)});
    d.open = true;
  })()`);
  await sleep(50);
  await click(page, '[data-view] details.menu[open] [role=menuitem]', item);
};
// A field typed into, as a person would: its value, then input and change.
const type = (page, selector, value, nth = 0) => page.eval(`(() => {
  const el = [...document.querySelectorAll(${JSON.stringify(selector)})].filter((x) => !x.closest('[hidden]'))[${nth}];
  if (!el) throw new Error('no field ' + ${JSON.stringify(selector)});
  el.value = ${JSON.stringify(value)};
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
})()`);
const text = (page, selector = '[data-view]') => page.eval(`[...document.querySelectorAll(${JSON.stringify(selector)})].map((e) => e.innerText).join('\\n')`);
const sideways = (page) => page.eval('document.documentElement.scrollWidth > innerWidth + 1');
// Console errors and CSP violations; a refused request's "Failed to load resource" is expected here.
const problems = (page) => page.problems.filter((p) => !p.startsWith('network:'));

async function logo(call) {
  const up = await call('POST', '/media?name=vik.png', Buffer.from(PNG, 'base64'));
  assert.equal(up.status, 201, JSON.stringify(up.body));
  for (let i = 0; i < 100 && (await call('GET', `/media/${up.body.id}`)).body.status !== 'ready'; i++) await sleep(50);
  return up.body.url;
}

test('a TAKEOVER night from nothing: the overlay in no show makes one, quick dates, a lineup from the roster, the timeline built, the show\'s state on the overlay', opts, async (t) => {
  const platform = await start(t);
  const call = await owner(platform);
  const vikLogo = await logo(call);
  // Last week's show, on another overlay: its acts are the roster. The new overlay is in no show.
  platform.overlays.create({ slug: 'last', template: TAKEOVER, settings: {} });
  assert.equal((await call('POST', '/shows', { name: 'Last week', overlays: ['last'], date: '2026-10-17', timezone: ZONE, lineup: [{ time: '23:00', name: 'VIKKSTAR', logo: vikLogo }, { time: '22:00', name: 'Manzone', b2b: 'strong' }] })).status, 201);
  platform.overlays.create({ slug: 'tk', template: TAKEOVER, settings: {} });
  // A viewer count in no show: its template reads nothing of a show, so nothing is said of it.
  platform.overlays.create({ slug: 'count', template: { id: 'dev.skp.viewers', version: platform.templates.versions('dev.skp.viewers')[0].version }, settings: {} });
  const page = await openSignedIn(t, platform, '/shows', { });
  await page.waitFor('document.querySelector("[data-view] .notice")', 10000);
  assert.match(await text(page, '[data-view] .notice'), /^tk is in no show, so it shows no set times, countdown or who's on/);

  // New show, from the notice: tk picked, tonight's date (in the zone, after the day boundary).
  await click(page, '[data-view] button', 'New show with tk');
  await page.waitFor('document.querySelector("dialog[open] input[type=date]")', 10000);
  assert.deepEqual(await page.eval('Object.fromEntries([...document.querySelectorAll("dialog[open] input[type=checkbox]")].map((c) => [c.value, [c.checked, c.disabled]]))'), { last: [false, true], tk: [true, false], count: [false, false] });
  await type(page, 'dialog[open] select', ZONE);
  const night = tonight();
  // The quick picks, in the zone picked: tonight, a week on, and the coming night on a past
  // date's weekday.
  await click(page, 'dialog[open] button', 'Tonight');
  assert.equal(await page.eval('document.querySelector("dialog[open] input[type=date]").value'), night);
  assert.match(await text(page, 'dialog[open]'), /: tonight/);
  await click(page, 'dialog[open] button', 'Next week');
  assert.equal(await page.eval('document.querySelector("dialog[open] input[type=date]").value'), addDays(night, 7));
  await type(page, 'dialog[open] input[type=date]', '2026-10-17');
  assert.match(await text(page, 'dialog[open]'), /Saturday, October 17, 2026: that night has passed/);
  const saturday = onWeekday(night, '2026-10-17');
  if (saturday !== night) await click(page, 'dialog[open] button', 'This Saturday');
  else await click(page, 'dialog[open] button', 'Tonight');
  assert.equal(await page.eval('document.querySelector("dialog[open] input[type=date]").value'), saturday);
  await type(page, 'dialog[open] input[type=text]', 'Saturday TAKEOVER');
  await type(page, 'dialog[open] input[type=time]', '22:00');
  await click(page, 'dialog[open] button', 'Create show');
  // Then its lineup.
  await page.waitFor('location.hash.includes("tab=lineup") && document.querySelector("[data-view] h1")?.textContent === "Saturday TAKEOVER"', 10000);
  const show = (await call('GET', '/shows/Saturday TAKEOVER')).body;
  assert.deepEqual([show.date, show.timezone, show.goLive, show.members], [saturday, ZONE, '22:00', ['tk']]);

  // The lineup: names offered from every lineup, partners too; a known act brings its logo.
  await page.waitFor('[...document.querySelectorAll("[data-view] button")].some((b) => b.textContent === "Add an act")', 10000);
  assert.deepEqual(await page.eval('[...document.querySelectorAll("[data-view] datalist option")].map((o) => o.value).sort()'), ['Manzone', 'VIKKSTAR', 'strong']);
  for (const [i, [time, name]] of [['22:30', 'Manzone'], ['01:00', 'VIKKSTAR'], ['03:00', 'Deecee']].entries()) {
    await click(page, '[data-view] button', 'Add an act');
    await type(page, '[data-view] fieldset input[type=time]', time, i);
    await type(page, '[data-view] fieldset input[type=text][list]', name, i * 2);
  }
  assert.equal(await page.eval('document.querySelector("[data-view] fieldset input[type=text][list]").getAttribute("list") === document.querySelector("[data-view] datalist").id'), true);
  assert.deepEqual(await page.eval('[...document.querySelectorAll("[data-view] fieldset select")].map((s) => s.value)'), ['', vikLogo, ''], 'VIKKSTAR\'s logo came with the name');
  await page.eval('[...document.querySelectorAll("[data-view] fieldset")][1].querySelector("label.btn input").click()'); // headliner
  await page.eval('[...[...document.querySelectorAll("[data-view] fieldset")][2].querySelectorAll("label.btn input")][1].click()'); // closer
  await click(page, '[data-view] button', 'Save lineup');
  await page.waitFor('[...document.querySelectorAll(".toast span")].some((t) => t.textContent.startsWith("Lineup saved"))', 10000);
  const lined = (await call('GET', `/shows/${show.id}`)).body;
  assert.deepEqual(lined.lineup.map(({ startAt, clockGap, clockOverlap, ...s }) => s), [{ time: '22:30', name: 'Manzone' }, { time: '01:00', name: 'VIKKSTAR', headliner: true, logo: vikLogo }, { time: '03:00', name: 'Deecee', closer: true }]);

  // The timeline, built from the lineup.
  await page.eval('document.querySelector("#tab-timeline").click()');
  await page.waitFor('[...document.querySelectorAll("[data-view] button")].some((b) => b.textContent === "Build from lineup")', 10000);
  await click(page, '[data-view] button', 'Build from lineup');
  await page.waitFor('document.querySelector("dialog[open]")', 5000);
  await click(page, 'dialog[open] button', 'Build timeline');
  await page.waitFor('[...document.querySelectorAll(".toast span")].some((t) => t.textContent.startsWith("Timeline built"))', 10000);
  const cues = (await call('GET', `/shows/${show.id}/cues?limit=200`)).body.items;
  assert.ok(cues.some((c) => c.action.name === 'titleCard' && c.action.args?.name === 'Manzone'), 'a title card for each act');
  assert.ok(cues.some((c) => c.action.name === 'headliner'), 'the headliner\'s intro');

  // What tk is sent: the countdown's go-live, the lineup with its instants, the headliner.
  const state = platform.overlays.resolve('tk').channel.snapshot().state;
  assert.equal(state['show.goLiveAt'], Date.parse(lined.goLiveAt));
  assert.equal(state['show.date'], saturday);
  assert.deepEqual(state['show.lineup'].map((s) => [s.name, s.startAt]), lined.lineup.map((s) => [s.name, Date.parse(s.startAt)]));
  assert.equal(state['show.headliner'], 'VIKKSTAR');

  // Details: the date in words, the quick picks in the show's zone.
  await page.eval('document.querySelector("#tab-details").click()');
  await page.waitFor('[...document.querySelectorAll("[data-view] button")].some((b) => b.textContent === "Save details")', 10000);
  assert.match(await text(page), new RegExp(`${new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${saturday}T00:00:00Z`))}`));
  await click(page, '[data-view] button', 'Next week');
  await click(page, '[data-view] button', 'Save details');
  await page.waitFor('[...document.querySelectorAll(".toast span")].some((t) => t.textContent.includes("Saved the show\'s date"))', 10000);
  assert.equal((await call('GET', `/shows/${show.id}`)).body.date, addDays(saturday, 7));
  assert.equal(platform.overlays.resolve('tk').channel.snapshot().state['show.date'], addDays(saturday, 7), 'the overlay follows');

  // The list: tk is in a show now; nothing says otherwise.
  await go(page, '/shows', 'document.querySelector("[data-view] .grid")');
  assert.equal(await page.eval('!!document.querySelector("[data-view] .notice")'), false);
  assert.deepEqual(problems(page), []);
});

test('the first night: with no show yet, the overlay in no show is named and New show picks it; the show starts on its countdown', opts, async (t) => {
  const platform = await start(t);
  const call = await owner(platform);
  platform.overlays.create({ slug: 'tk', template: TAKEOVER, settings: {} });
  platform.overlays.setKeyRequired('tk', false);
  platform.overlays.create({ slug: 'count', template: { id: 'dev.skp.viewers', version: platform.templates.versions('dev.skp.viewers')[0].version }, settings: {} });
  const page = await openSignedIn(t, platform, '/shows');
  await page.waitFor('document.querySelector("[data-view] .notice")', 10000);
  assert.match(await text(page, '[data-view] .notice'), /^tk is in no show, so it shows no set times, countdown or who's on\. Make a show with it\./);
  assert.match(await text(page), /No shows yet/);
  assert.deepEqual(await page.eval('[...document.querySelectorAll("[data-view] .notice button")].map((b) => b.textContent)'), ['New show with tk']);
  // The page's own New show picks it too: the one overlay in no show that reads a show.
  await click(page, '[data-view] button', 'New show');
  await page.waitFor('document.querySelector("dialog[open] input[type=date]")', 10000);
  assert.deepEqual(await page.eval('Object.fromEntries([...document.querySelectorAll("dialog[open] input[type=checkbox]")].map((c) => [c.value, c.checked]))'), { tk: true, count: false });
  await type(page, 'dialog[open] select', ZONE);
  await click(page, 'dialog[open] button', 'Tonight');
  await click(page, 'dialog[open] button', 'Next week'); // a week on: its go-live is still to come
  await type(page, 'dialog[open] input[type=text]', 'Saturday TAKEOVER');
  await type(page, 'dialog[open] input[type=time]', '22:00');
  await click(page, 'dialog[open] button', 'Create show');
  await page.waitFor('location.hash.includes("tab=lineup")', 10000);
  const show = (await call('GET', '/shows/Saturday TAKEOVER')).body;
  assert.deepEqual([show.date, show.scene, show.live, show.members], [addDays(tonight(), 7), 'auto', false, ['tk']]);
  // The overlay shows the countdown to go-live (Starting Soon), not the live scene.
  const overlay = await page.browser.open(`${platform.url}/o/tk`, { width: 1920, height: 1080 });
  defer(t, () => overlay.close().catch(() => {}));
  await overlay.waitFor('window.SK && SK.scene === "auto" && document.body.innerText.includes("STARTING SOON")', 15000);
  assert.deepEqual(problems(page), []);
});

test('the timeline: a card picks its act and puts them on as one cue, changed and fired; re-arm all says what it does', opts, async (t) => {
  const platform = await start(t);
  const call = await owner(platform);
  platform.overlays.create({ slug: 'tk', template: TAKEOVER, settings: {} });
  // Tomorrow, from midnight: every time of the night is still to come.
  const date = addDays(wall(Date.now(), ZONE).date, 1);
  const made = await call('POST', '/shows', { name: 'Night', overlays: ['tk'], date, timezone: ZONE, dayBoundary: '00:00', lineup: [{ time: '22:30', name: 'Manzone' }, { time: '23:30', name: 'VIKKSTAR', headliner: true }, { time: '23:50', name: 'Deecee', closer: true }] });
  assert.equal(made.status, 201);
  const id = made.body.id;
  const triggers = [];
  platform.overlays.resolve('tk').channel.subscribe((env) => { if (env.type === 'show.trigger') triggers.push(env.data); });
  const page = await openSignedIn(t, platform, `/shows/${id}?tab=timeline`);
  await page.waitFor('[...document.querySelectorAll("[data-view] button")].some((b) => b.textContent === "Add a cue")', 10000);

  // A title card about VIKKSTAR, putting them on: one cue (v0's DJ title card).
  await click(page, '[data-view] button', 'Add a cue');
  await page.waitFor('document.querySelector("dialog[open] select")', 10000);
  const visible = () => page.eval('[...document.querySelectorAll("dialog[open] .field")].filter((f) => !f.hidden && !f.closest("[hidden]")).map((f) => f.querySelector("label")?.textContent.trim()).filter(Boolean)');
  await type(page, 'dialog[open] input[type=time]', '23:58');
  // A now-playing held until hidden is about an act too.
  await type(page, 'dialog[open] select', 'nowPlayingHold', 1);
  assert.ok((await visible()).includes('Act'), 'a held now-playing is about an act');
  await type(page, 'dialog[open] select', 'titleCard', 1);
  assert.ok((await visible()).includes('Act'), 'a title card is about an act');
  assert.deepEqual(await page.eval('[...[...document.querySelectorAll("dialog[open] select")][2].options].map((o) => o.textContent)'), ['Whoever is on then', 'Manzone', 'VIKKSTAR', 'Deecee']);
  assert.equal(await page.eval('[...document.querySelectorAll("dialog[open] label.btn")].some((l) => !l.closest("[hidden]") && l.textContent.includes("Put them on"))'), false, 'whoever is on: nobody to put on');
  await type(page, 'dialog[open] select', 'VIKKSTAR', 2);
  assert.equal(await page.eval('[...document.querySelectorAll("dialog[open] label.btn")].find((l) => !l.closest("[hidden]") && l.textContent.includes("Put them on"))?.querySelector("input").checked'), true, 'a title card puts its act on unless told otherwise');
  await click(page, 'dialog[open] button', 'Add cue');
  await page.waitFor('!document.querySelector("dialog[open]")', 10000);
  let cue = (await call('GET', `/shows/${id}/cues`)).body.items.find((c) => c.time === '23:58');
  assert.deepEqual(cue.action, { type: 'sequence', steps: [{ offsetMs: 0, action: { type: 'show.slot', slot: 'VIKKSTAR' } }, { offsetMs: 0, action: { type: 'overlay.action', name: 'titleCard', args: { name: 'VIKKSTAR' } } }] });
  await page.waitFor('document.querySelector("[data-view]").innerText.includes("VIKKSTAR on, then DJ title card")', 10000);

  // Changed: it is the same form (the act, put on); now a now-playing about Deecee, nobody put on.
  await choose(page, 'More for VIKKSTAR on, then DJ title card', 'Change');
  await page.waitFor('document.querySelector("dialog[open] select")', 10000);
  assert.deepEqual(await page.eval('[...document.querySelectorAll("dialog[open] select")].map((s) => s.value).slice(0, 3)'), ['overlay.action', 'titleCard', 'VIKKSTAR']);
  await type(page, 'dialog[open] select', 'nowPlaying', 1);
  await type(page, 'dialog[open] select', 'Deecee', 2);
  assert.equal(await page.eval('[...document.querySelectorAll("dialog[open] label.btn")].find((l) => !l.closest("[hidden]") && l.textContent.includes("Put them on")).querySelector("input").checked'), true, 'as it was saved');
  await page.eval('[...document.querySelectorAll("dialog[open] label.btn")].find((l) => !l.closest("[hidden]") && l.textContent.includes("Put them on")).querySelector("input").click()');
  await click(page, 'dialog[open] button', 'Save cue');
  await page.waitFor('!document.querySelector("dialog[open]")', 10000);
  cue = (await call('GET', `/shows/${id}/cues/${cue.id}`)).body;
  assert.deepEqual(cue.action, { type: 'overlay.action', name: 'nowPlaying', args: { name: 'Deecee' } });
  // Fired by hand: the card is about Deecee, whoever is on.
  await page.waitFor('document.querySelector("[data-view]").innerText.includes("Now playing (Deecee)")', 10000);
  await choose(page, 'More for Now playing (Deecee)', 'Fire now');
  for (let i = 0; i < 100 && !triggers.length; i++) await sleep(50);
  assert.deepEqual(triggers.map((d) => [d.name, d.args]), [['nowPlaying', { name: 'Deecee' }]]);

  // Re-arm all: the cue fired early and one skipped fire again at their time, after a
  // confirmation that says so.
  await call('POST', '/shows/Night/cues/build', {});
  const generated = (await call('GET', '/shows/Night/cues?limit=200')).body.items.filter((c) => c.generated);
  assert.equal((await call('POST', `/shows/Night/cues/${generated[0].id}/skip`, {})).body.status, 'skipped');
  await page.eval('document.querySelector("#tab-details").click()');
  await page.eval('document.querySelector("#tab-timeline").click()');
  await page.waitFor('document.querySelector("[data-view] ul.list") && document.querySelector("[data-view] details.menu > summary[aria-label=\'More for the timeline\']")', 10000);
  await choose(page, 'More for the timeline', 'Re-arm all cues still to come');
  await page.waitFor('document.querySelector("dialog[open]")', 5000);
  assert.match(await text(page, 'dialog[open]'), /Re-arm 2 cues still to come\?[\s\S]*The 2 cues still to come that were skipped or fired early fire again at their time[\s\S]*Cues whose time has passed stay as they are/);
  await click(page, 'dialog[open] button', 'Re-arm 2 cues');
  await page.waitFor('[...document.querySelectorAll(".toast span")].some((t) => t.textContent.startsWith("Re-armed 2 cues"))', 10000);
  const after = (await call('GET', '/shows/Night/cues?limit=200')).body.items;
  assert.ok(after.every((c) => c.status === 'armed'), 'every cue still to come is armed');
  assert.deepEqual(platform.audit.list({ action: 'cue' }).items.filter((e) => e.action === 'cue.rearm-all').map((e) => [e.actor, e.details.cues]), [['juan', 2]]);
  // With nothing to re-arm, it says so and asks nothing.
  await page.waitFor('![...document.querySelectorAll("[data-view] li .badge")].some((b) => ["Skipped", "Done"].includes(b.textContent))', 10000);
  await choose(page, 'More for the timeline', 'Re-arm all cues still to come');
  await page.waitFor('[...document.querySelectorAll(".toast span")].some((t) => t.textContent.startsWith("Nothing to re-arm"))', 5000);
  assert.equal(await page.eval('!!document.querySelector("dialog[open]")'), false);

  // The night the clocks go back (Toronto, 1 November 2026): of two cues at 1:30 AM, the one in
  // the hour that repeats says it is the second.
  const fall = (await call('POST', '/shows', { name: 'Fall back', overlays: [], date: '2026-10-31', timezone: ZONE })).body;
  for (const at of ['2026-11-01T05:30:00Z', '2026-11-01T06:30:00Z']) assert.equal((await call('POST', `/shows/${fall.id}/cues`, { at, action: { type: 'show.scene', scene: 'brb' } })).status, 201);
  await go(page, `/shows/${fall.id}?tab=timeline`, 'document.querySelectorAll("[data-view] ul.list li").length === 2');
  const rows = await page.eval('[...document.querySelectorAll("[data-view] ul.list li")].map((li) => li.innerText)');
  assert.doesNotMatch(rows[0], /The second/);
  assert.match(rows[1], /The second 1:30\sAM that night, after the clocks go back\./);
  assert.deepEqual(problems(page), []);
});

test('a plan has a lineup of its own: planned, changed (If-Match), made the show now; a night that has passed moves on; at a phone\'s width', opts, async (t) => {
  const platform = await start(t);
  const call = await owner(platform);
  platform.overlays.create({ slug: 'tk', template: TAKEOVER, settings: {} });
  const date = tonight();
  const made = await call('POST', '/shows', { name: 'Weekly', overlays: ['tk'], date, timezone: ZONE, goLive: '22:00', lineup: [{ time: '22:30', name: 'Manzone' }, { time: '01:00', name: 'VIKKSTAR', headliner: true }] });
  const id = made.body.id;
  const page = await openSignedIn(t, platform, `/shows/${id}?tab=plans`, { width: 390, height: 844 });
  await page.waitFor('[...document.querySelectorAll("[data-view] button")].some((b) => b.textContent === "Plan a date")', 10000);

  // A new plan: next week, its own lineup copied from the show's and changed.
  await click(page, '[data-view] .card-head button', 'Plan a date');
  await page.waitFor('document.querySelector("[data-view] h2")?.textContent === "Plan a date"', 10000);
  assert.equal(await page.eval('document.querySelector("[data-view] input[type=date]").value'), addDays(date, 7), 'the show\'s next week');
  assert.match(await text(page), /On that day the show keeps the lineup it has then/);
  await page.eval('[...document.querySelectorAll("[data-view] label.btn")].find((l) => l.textContent.includes("A lineup of its own")).querySelector("input").click()');
  await click(page, '[data-view] button', 'Copy the show\'s lineup (2 acts)');
  await page.waitFor('document.querySelectorAll("[data-view] fieldset").length === 2', 5000);
  await type(page, '[data-view] fieldset input[type=text][list]', 'UNDERCOVER', 0);
  assert.equal(await sideways(page), false, 'the plan editor fits a phone');
  await click(page, '[data-view] button', 'Save plan');
  await page.waitFor('[...document.querySelectorAll(".toast span")].some((t) => t.textContent.startsWith("Planned for"))', 10000);
  let [plan] = (await call('GET', `/shows/${id}/plans`)).body.items;
  assert.deepEqual([plan.date, plan.goLive, plan.lineup.map((s) => s.name)], [addDays(date, 7), undefined, ['UNDERCOVER', 'VIKKSTAR']]);
  await page.waitFor('document.querySelector("[data-view]").innerText.includes("Its own lineup: UNDERCOVER and VIKKSTAR")', 10000);

  // Its date planned again: said in words, with what to do instead. Cancel asks first.
  await click(page, '[data-view] .card-head button', 'Plan a date');
  await page.waitFor('document.querySelector("[data-view] h2")?.textContent === "Plan a date"', 10000);
  assert.equal(await page.eval('document.querySelector("[data-view] input[type=date]").value'), addDays(date, 14), 'the next night not planned yet');
  await type(page, '[data-view] input[type=date]', addDays(date, 7));
  await click(page, '[data-view] button', 'Save plan');
  await page.waitFor('[...document.querySelectorAll(".toast span")].some((t) => /^There is already a plan for \\w+day, .+: change that one \\(in its ⋯ menu\\), or delete it first\\.$/.test(t.textContent))', 10000);
  await click(page, '[data-view] button', 'Cancel');
  await page.waitFor('document.querySelector("dialog[open]")', 5000);
  await click(page, 'dialog[open] button', 'Leave');
  await page.waitFor('document.querySelector("[data-view] h2")?.textContent === "Planned dates"', 10000);

  // While the show is live, a plan can't be made the show: the menu says so instead of offering it.
  assert.equal((await call('POST', `/shows/${id}/rec`, { action: 'start' })).status, 200);
  await page.eval('document.querySelector("#tab-plans").click()');
  await page.waitFor('[...document.querySelectorAll("[data-view] [role=menuitem]")].some((b) => b.textContent === "Make it the show now (not while live)" && b.disabled)', 10000);
  assert.equal((await call('POST', `/shows/${id}/rec`, { action: 'reset' })).status, 200);

  // Changed: a go-live of its own. Someone else changes it meanwhile: said, and shown as it is now.
  const planMenu = () => page.eval('document.querySelector("[data-view] li details.menu > summary").getAttribute("aria-label")');
  assert.match(await planMenu(), /^More for the plan of /);
  await choose(page, await planMenu(), 'Change');
  await page.waitFor('document.querySelectorAll("[data-view] fieldset").length === 2', 10000);
  await type(page, '[data-view] input[type=time]:not(fieldset input)', '23:00');
  assert.equal((await other(platform, 'PUT', `/shows/${id}/plans/${plan.id}`, { date: plan.date, lineup: [{ time: '23:00', name: 'GUEST' }] })).status, 200);
  await click(page, '[data-view] button', 'Save changes');
  await page.waitFor('[...document.querySelectorAll(".toast span")].some((t) => t.textContent.startsWith("This plan changed since you opened it"))', 10000);
  assert.deepEqual(await page.eval('[...document.querySelectorAll("[data-view] fieldset")].map((f) => f.querySelector("input[type=text][list]").value)'), ['GUEST'], 'the latest, to change again');
  await type(page, '[data-view] input[type=time]:not(fieldset input)', '23:00');
  // Another tab asks first, as Cancel does: cancelled, the change is still here.
  await page.eval('document.querySelector("#tab-lineup").click()');
  await page.waitFor('document.querySelector("dialog[open]")', 5000);
  assert.match(await text(page, 'dialog[open]'), /Leave without saving\?[\s\S]*Your changes are lost; the plan stays as it was saved/);
  await click(page, 'dialog[open] button', 'Cancel');
  await page.waitFor('!document.querySelector("dialog[open]")', 5000);
  assert.equal(await page.eval('document.querySelector("#tab-plans").getAttribute("aria-selected")'), 'true');
  assert.equal(await page.eval('document.querySelector("[data-view] input[type=time]:not(fieldset input)").value'), '23:00');
  await click(page, '[data-view] button', 'Save changes');
  await page.waitFor('[...document.querySelectorAll(".toast span")].some((t) => t.textContent.startsWith("Saved the plan"))', 10000);
  [plan] = (await call('GET', `/shows/${id}/plans`)).body.items;
  assert.deepEqual([plan.goLive, plan.lineup.map((s) => s.name)], ['23:00', ['GUEST']]);

  // Made the show now (v0's "Load now"), after a confirmation that says what changes.
  await page.waitFor('document.querySelector("[data-view] li details.menu")', 10000);
  await choose(page, await planMenu(), 'Make it the show now');
  await page.waitFor('document.querySelector("dialog[open]")', 5000);
  assert.match(await text(page, 'dialog[open]'), /with the plan's lineup in place of the one it has/);
  await click(page, 'dialog[open] button', 'Make it the show');
  await page.waitFor('[...document.querySelectorAll(".toast span")].some((t) => t.textContent.includes("is the night of"))', 10000);
  const now = (await call('GET', `/shows/${id}`)).body;
  assert.deepEqual([now.date, now.goLive, now.lineup.map((s) => s.name)], [plan.date, '23:00', ['GUEST']]);
  assert.equal(platform.overlays.resolve('tk').channel.snapshot().state['show.lineup'][0].name, 'GUEST');

  // A plan is for a night still to come: no Tonight among its dates, and tonight's date typed in
  // asks first, as it would be the show at once.
  await page.waitFor('[...document.querySelectorAll("[data-view] .card-head button")].some((b) => b.textContent === "Plan a date")', 10000);
  await click(page, '[data-view] .card-head button', 'Plan a date');
  await page.waitFor('document.querySelector("[data-view] h2")?.textContent === "Plan a date"', 10000);
  const picks = await page.eval('[...document.querySelectorAll("[data-view] [aria-label=\'Quick dates\'] button")].map((b) => b.textContent)');
  assert.ok(!picks.includes('Tonight') && picks.includes('Next week'), picks.join(', '));
  await type(page, '[data-view] input[type=date]', tonight());
  await click(page, '[data-view] button', 'Save plan');
  await page.waitFor('document.querySelector("dialog[open]")', 5000);
  assert.match(await text(page, 'dialog[open]'), /Make it the show now\?[\s\S]*has begun, so the plan becomes the show as soon as it is saved/);
  await click(page, 'dialog[open] button', 'Cancel');
  await page.waitFor('!document.querySelector("dialog[open]")', 5000);
  assert.equal((await call('GET', `/shows/${id}/plans`)).body.items.length, 1, 'nothing saved');
  // Left for another tab, agreed to: that tab opens.
  await page.eval('document.querySelector("#tab-details").click()');
  await page.waitFor('document.querySelector("dialog[open]")', 5000);
  assert.match(await text(page, 'dialog[open]'), /This plan isn't saved/);
  await click(page, 'dialog[open] button', 'Leave');
  await page.waitFor('[...document.querySelectorAll("[data-view] button")].some((b) => b.textContent === "Save details")', 10000);

  // A night that has passed: the page says so, and moves it to its next night in one tap.
  const past = addDays(date, -7);
  const read = await call('GET', `/shows/${id}`);
  assert.equal((await call('PATCH', `/shows/${id}`, { date: past }, { 'if-match': read.etag })).status, 200);
  await page.eval('location.reload()');
  await page.waitFor('document.querySelector("[data-view] .notice")?.innerText.includes("has passed")', 15000);
  assert.equal(await sideways(page), false);
  // Changed on another device meanwhile: moving it is refused (If-Match), and the tab open (the
  // details, with nothing unsaved) shows the show as it is now.
  await page.waitFor('[...document.querySelectorAll("[data-view] button")].some((b) => b.textContent === "Save details")', 10000);
  assert.equal((await other(platform, 'PATCH', `/shows/${id}`, { goLive: '21:30' })).status, 200);
  await click(page, '[data-view] .notice button', await page.eval('document.querySelector("[data-view] .notice button").textContent'));
  await page.waitFor('[...document.querySelectorAll(".toast span")].some((t) => t.textContent.startsWith("The show changed since you opened it"))', 10000);
  await page.waitFor('document.querySelector("[data-view] input[type=time]:not([required])")?.value === "21:30"', 5000);
  // Building its timeline now would make nothing: the dialog says so before.
  await page.eval('document.querySelector("#tab-timeline").click()');
  await page.waitFor('[...document.querySelectorAll("[data-view] button")].some((b) => b.textContent === "Build from lineup")', 10000);
  await click(page, '[data-view] button', 'Build from lineup');
  await page.waitFor('document.querySelector("dialog[open]")', 5000);
  assert.match(await text(page, 'dialog[open]'), /Every act's time has passed .*so no cue is made for them/);
  await click(page, 'dialog[open] button', 'Cancel');
  // An act added on the Lineup tab and not saved yet: its heading follows the name as it is typed,
  // and moving the show to its next night keeps it, on the new night, to save there.
  await page.eval('document.querySelector("#tab-lineup").click()');
  await page.waitFor('[...document.querySelectorAll("[data-view] button")].some((b) => b.textContent === "Add an act")', 10000);
  await click(page, '[data-view] button', 'Add an act');
  await type(page, '[data-view] fieldset input[type=time]', '02:30', 1);
  await type(page, '[data-view] fieldset input[type=text][list]', 'LATE ADD', 2);
  assert.deepEqual(await page.eval('[...document.querySelectorAll("[data-view] fieldset legend")].map((l) => l.textContent)'), ['1. GUEST', '2. LATE ADD']);
  assert.equal(await page.eval('!!document.querySelector("[data-view] fieldset summary[aria-label=\'More for LATE ADD\']")'), true);
  await click(page, '[data-view] .notice button', await page.eval('document.querySelector("[data-view] .notice button").textContent'));
  await page.waitFor('[...document.querySelectorAll(".toast span")].some((t) => t.textContent.includes("its set times and cues moved with it"))', 10000);
  const moved = onWeekday(tonight(), past);
  assert.equal((await call('GET', `/shows/${id}`)).body.date, moved);
  await page.waitFor('!document.querySelector("[data-view]").innerText.includes("has passed")', 5000);
  const short = (ymd) => new Intl.DateTimeFormat('en-US', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${ymd}T00:00:00Z`));
  assert.deepEqual(await page.eval('[...document.querySelectorAll("[data-view] fieldset")].map((f) => f.querySelector("input[type=text][list]").value)'), ['GUEST', 'LATE ADD'], 'the unsaved act is still here');
  const lineupText = await text(page);
  assert.match(lineupText, /Unsaved changes/);
  assert.ok(lineupText.includes(`Starts ${short(moved)},`), 'a saved act starts on the new night');
  assert.ok(lineupText.includes(`After midnight: plays on ${short(addDays(moved, 1))}.`), 'the new act too');
  // Saved on the show as it is now (its If-Match moved with it): no conflict.
  await click(page, '[data-view] button', 'Save lineup');
  await page.waitFor('[...document.querySelectorAll(".toast span")].some((t) => t.textContent.startsWith("Lineup saved"))', 10000);
  assert.deepEqual((await call('GET', `/shows/${id}`)).body.lineup.map((s) => s.name), ['GUEST', 'LATE ADD']);

  // Every tab fits a phone.
  for (const tab of ['details', 'lineup', 'timeline', 'plans']) {
    await page.eval(`document.querySelector("#tab-${tab}").click()`);
    await sleep(400);
    assert.equal(await sideways(page), false, `${tab} at 390 px`);
  }
  assert.deepEqual(problems(page), []);
});
