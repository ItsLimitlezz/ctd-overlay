// An overlay whose template reads a show (set times, the countdown, REC, title cards) but that is in
// none, in a real browser (08 §8.3, §8.4): its page says so first, and Sample data says what it
// makes up; "Make a show from this overlay" picks the show's night as New show does, brings its
// twin of the same template along (one put in another show meanwhile is left out, in plain words)
// and lands on the new show's Lineup; "Add it to a show" picks the show its template's other
// overlay is in and sends the show's If-Match (a 412 says so, and adding again works); Live says it
// on the overlay's card and first in its console, offers "Add it to a show" once a show exists, and
// says a title card was sent with no act to name; a clock that reads only a show's times gets a
// quiet line on its page and nothing on Live; on a phone nothing scrolls sideways; a role that
// can't make shows reads it without the buttons. And copy is per overlay: a saved change is offered
// to the other overlays of the template in the show it is in now, only the settings that changed
// and their version has, each with its own If-Match, a 412 on one said plainly and offered again,
// a version that can't take a value said plainly and not offered again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { startPlatform } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { browserSkip, launchBrowser } from './cdp.js';
import { defer, DIAG, DIAG_DIR, FIXTURE_TEMPLATES, memoryLogger, packTemplate, signedIn, tempDir, TESTBED } from './helpers.js';

const OWNER = { username: 'juan', password: 'correct horse battery staple' };
const SHOW = { date: '2026-10-17', timezone: 'America/Toronto' };
const opts = { skip: browserSkip, timeout: 180000 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A platform with the fixture templates, its owner signed in in a browser page.
async function start(t, { width = 1280, height = 900, phone = false } = {}) {
  const root = tempDir(t);
  const config = loadConfig({ argv: ['--port', '0'], env: { SKP_DATA_DIR: path.join(root, 'data'), SKP_CONFIG_DIR: path.join(root, 'config') } });
  const platform = await startPlatform(config, { log: memoryLogger().log, scrypt: { N: 1024 }, templateDirs: [FIXTURE_TEMPLATES] });
  defer(t, () => platform.stop());
  await platform.auth.createOwner({ code: platform.auth.setupCode, ...OWNER }, { ip: '127.0.0.1' });
  const api = async (method, p, body, headers = {}) => {
    const res = await fetch(`${platform.url}/api/v1${p}`, { method, headers: signedIn(platform, { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }), body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null), etag: res.headers.get('etag') };
  };
  const browser = await launchBrowser(t);
  const page = await browser.open(`${platform.url}/#/login`, { width, height });
  if (phone) {
    await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: true });
    await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  }
  await page.waitFor('document.querySelector("input[name=username]")', 15000);
  assert.equal(await page.eval(`fetch('/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(${JSON.stringify(OWNER)}) }).then((r) => r.status)`), 200);
  const before = page.problems.length; // the sign-in page's own 401 for "who am I" is expected
  // Every request that changes something, with its If-Match.
  await page.send('Network.enable');
  const changes = [];
  const off = browser.cdp.on((m) => {
    if (m.method !== 'Network.requestWillBeSent' || !['PATCH', 'POST'].includes(m.params.request.method)) return;
    const r = m.params.request;
    changes.push({ method: r.method, path: new URL(r.url).pathname, ifMatch: r.headers['If-Match'] || r.headers['if-match'], body: r.postData ? JSON.parse(r.postData) : undefined });
  });
  t.after(off);
  const problems = () => page.problems.slice(before).filter((p) => !p.startsWith('network:'));
  return { platform, api, browser, page, changes, problems };
}

const go = async (page, route, ready = 'true') => {
  await page.eval(`location.hash = ${JSON.stringify(`#${route}`)}`);
  await page.waitFor(`!document.querySelector("[data-view] > .loading") && document.querySelector("[data-view] h1") && (${ready})`, 15000);
};
const click = (page, selector, text) => page.eval(`(() => {
  const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((b) => b.textContent.trim() === ${JSON.stringify(text)} || b.getAttribute('aria-label') === ${JSON.stringify(text)});
  if (!el) throw new Error('nothing to click: ' + ${JSON.stringify(`${selector} ${text}`)});
  el.click();
})()`);
const toastSeen = (page, re) => page.waitFor(`[...document.querySelectorAll(".toast span")].some((s) => ${re}.test(s.textContent))`, 8000);
const viewText = (page) => page.eval('document.querySelector("[data-view]").innerText');
// The notice of an overlay that reads a show but is in none, where it is on the page.
const needsText = (page, root = '[data-view]') => page.eval(`[...document.querySelectorAll(${JSON.stringify(`${root} .needs-show`)})].map((n) => n.innerText).join('\\n---\\n')`);
const boxesIn = (page, selector) => page.eval(`[...document.querySelectorAll(${JSON.stringify(`${selector} input[type=checkbox]`)})].map((i) => [document.querySelector('label[for="' + i.id + '"]')?.textContent, i.checked, i.disabled])`);

test('an overlay that reads a show but is in none: its page says so first, Sample data says it is made up, and "Make a show from this overlay" brings its twin and lands on the Lineup', opts, async (t) => {
  const { platform, api, page, changes, problems } = await start(t);
  for (const slug of ['tk-h', 'tk-v']) platform.overlays.create({ slug, template: TESTBED, settings: {} });
  platform.overlays.create({ slug: 'diag', template: DIAG, settings: {} });
  // A show that has nothing to do with them, for "Add it to a show" (and a name taken).
  platform.shows.create({ name: 'Testbed', overlays: [], ...SHOW }, { actor: 'test' });
  await page.goto(`${platform.url}/?signed=1#/overlays/tk-h`);
  await page.waitFor('document.querySelector("[data-view] .needs-show")', 15000);

  // What the templates read from a show, in words: the TAKEOVER, a clock, a chat.
  const words = await page.eval(`import('/ui/show-from-overlay.js').then(async (m) => {
    const read = async (id) => (await (await fetch('/api/v1/templates/' + id)).json()).manifest;
    return [m.showWords(await read('com.dprtmnt.takeover')), m.showWords(await read('com.ctd.text-clock')), m.showWords(await read('com.dprtmnt.chat'))];
  })`);
  assert.deepEqual(words, ['Set times, the countdown, REC and title cards come from a show.', 'With no time of its own, the countdown runs to a show\'s go-live, and the count-up from when it went live.', '']);

  // The notice: in plain words, before the previews and tabs, with both ways into a show.
  const notice = await needsText(page);
  assert.match(notice, /^Set times, the countdown, REC and title cards come from a show\. This overlay isn't in one yet\.\n+Until it is, a title card has no act to name, so it shows nothing\./);
  assert.equal(await page.eval('!!(document.querySelector("[data-view] .needs-show").compareDocumentPosition(document.querySelector("[data-view] [role=tablist]")) & Node.DOCUMENT_POSITION_FOLLOWING)'), true, 'above the tabs');
  assert.deepEqual(await page.eval('[...document.querySelectorAll("[data-view] .needs-show button")].map((b) => b.textContent)'), ['Make a show from this overlay', 'Add it to a show']);
  // Sample data fills in a lineup, a countdown, REC and title cards: the preview says they are made up.
  assert.equal(await page.eval('[...document.querySelectorAll("[data-view] .notice")].some((n) => /Sample data makes up/.test(n.textContent))'), false);
  await page.eval('(() => { const l = [...document.querySelectorAll("[data-view] label")].find((x) => x.textContent === "Sample data"); document.getElementById(l.htmlFor).click(); })()');
  await page.waitFor('[...document.querySelectorAll("[data-view] .notice")].some((n) => n.offsetParent && n.textContent === "Sample data makes up set times, the countdown, REC and title cards here. On air this overlay has none of it until it is in a show.")', 5000);

  // A template that reads nothing of a show: no notice.
  await go(page, '/overlays/diag', 'document.querySelector("[data-view] [role=tablist]")');
  assert.equal(await needsText(page), '');

  // ---- Make a show from this overlay ------------------------------------------------------------
  await go(page, '/overlays/tk-h', 'document.querySelector("[data-view] .needs-show")');
  await click(page, '[data-view] .needs-show button', 'Make a show from this overlay');
  await page.waitFor('document.querySelector("dialog[open] fieldset")', 8000);
  const dialog = await page.eval(`(() => {
    const d = document.querySelector('dialog[open]');
    const byLabel = (text) => { const l = [...d.querySelectorAll('label')].find((x) => x.textContent === text); return document.getElementById(l.htmlFor); };
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    // The show's night now: before noon (a show's day boundary), still the night before.
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit' }).formatToParts(new Date()).map((x) => [x.type, x.value]));
    const tonight = new Date(Date.UTC(+p.year, +p.month - 1, +p.day - (+p.hour < 12 ? 1 : 0))).toISOString().slice(0, 10);
    const date = byLabel('Date');
    return {
      title: d.querySelector('h2').textContent, name: byLabel('Name').value, date: date.value, tonight, words: date.nextElementSibling.textContent,
      picks: [...d.querySelectorAll('[aria-label="Quick dates"] button')].map((b) => [b.textContent, b.getAttribute('aria-pressed')]),
      zone: byLabel('Time zone').value, browserZone: zone, goLive: byLabel('Goes live at').value, text: d.innerText,
      top: d.scrollTop, titleInView: d.querySelector('h2').getBoundingClientRect().top >= d.getBoundingClientRect().top, focused: document.activeElement === byLabel('Name'),
    };
  })()`);
  assert.equal(dialog.title, 'Make a show from "tk-h"');
  assert.deepEqual([dialog.top, dialog.titleInView, dialog.focused], [0, true, true], 'it opens at its top, on the name');
  assert.equal(dialog.name, 'Testbed 2', 'the template\'s name, one no show has');
  assert.equal(dialog.date, dialog.tonight, 'the show\'s night now, in its zone, as New show has it');
  assert.match(dialog.words, /: tonight$/, 'the date in words');
  assert.deepEqual(dialog.picks[0], ['Tonight', 'true']);
  assert.equal(dialog.zone, dialog.browserZone, 'this device\'s zone, as New show has it');
  assert.equal(dialog.goLive, '');
  assert.match(dialog.text, /What feeds them stays as it is \(Fed by\): every connection, including new ones\./);
  // The overlay itself (not a choice), and its twin of the same template, ticked; not the others.
  assert.deepEqual(await boxesIn(page, 'dialog[open] fieldset'), [['tk-h (this overlay)', true, true], ['tk-v', true, false]]);
  const type = (label, value) => page.eval(`(() => {
    const d = document.querySelector('dialog[open]');
    const l = [...d.querySelectorAll('label')].find((x) => x.textContent === ${JSON.stringify(label)});
    const i = document.getElementById(l.htmlFor);
    i.value = ${JSON.stringify(value)};
    i.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  // A name another show has: said in the dialog, which stays open with what was typed.
  await type('Name', 'testbed');
  await click(page, 'dialog[open] button', 'Create show');
  await page.waitFor('[...document.querySelectorAll("dialog[open] .notice.danger")].some((n) => n.textContent === "There is already a show called \\"Testbed\\".")', 8000);
  await type('Name', 'Testbed 2');
  await type('Goes live at', '22:30');
  await click(page, 'dialog[open] button', 'Create show');
  await page.waitFor('!document.querySelector("dialog[open]") && /^#\\/shows\\/show_[0-9A-Z]+\\?tab=lineup$/.test(location.hash) && document.querySelector("#tab-lineup")?.getAttribute("aria-selected") === "true"', 15000);
  await toastSeen(page, '/Created the show "Testbed 2" with tk-h and tk-v: add the night.s acts and their set times\\./');
  const id = await page.eval('location.hash.split("/")[2].split("?")[0]');
  const show = (await api('GET', `/shows/${id}`)).body;
  assert.deepEqual([...show.members].sort(), ['tk-h', 'tk-v']);
  assert.equal(show.goLive, '22:30');
  assert.equal(show.timezone, dialog.browserZone);
  assert.equal(show.date, dialog.tonight);
  const post = changes.filter((c) => c.method === 'POST' && c.path === '/api/v1/shows').at(-1);
  assert.deepEqual(post.body.overlays, [platform.overlays.resolve('tk-h').doc.id, platform.overlays.resolve('tk-v').doc.id]);
  // What feeds them is theirs, unchanged.
  for (const slug of ['tk-h', 'tk-v']) assert.equal((await api('GET', `/overlays/${slug}`)).body.connections, 'all');

  // In the show now: no notice; the page says where its set times are edited.
  await go(page, '/overlays/tk-h', 'document.querySelector("[data-view] [role=tablist]")');
  assert.equal(await needsText(page), '');
  assert.match(await viewText(page), /In the show Testbed 2[\s\S]*Set times, the countdown, REC and title cards come from a show\. Edit them on the show: Lineup \(the acts and their set times\), Details \(the date and go-live time\)\./);
  assert.equal(await page.eval('[...document.querySelectorAll("[data-view] p a")].find((a) => a.textContent === "Lineup").getAttribute("href")'), `#/shows/${id}?tab=lineup`);
  assert.deepEqual(problems(), []);
});

test('"Add it to a show" picks the show its template\'s other overlay is in and sends the show\'s If-Match: a show changed meanwhile says so and adds nothing; adding again works', opts, async (t) => {
  const { platform, api, page, changes, problems } = await start(t);
  platform.overlays.create({ slug: 'room', template: TESTBED, settings: {} });
  for (const slug of ['solo-h', 'solo-v']) platform.overlays.create({ slug, template: TESTBED, settings: {} });
  const night = platform.shows.create({ name: 'Night', overlays: ['room'], ...SHOW, lineup: [{ time: '22:00', name: 'Opener' }] }, { actor: 'test' });
  // A later night with nothing in it: listed first, but not where its template's overlay is.
  platform.shows.create({ name: 'Sneaky', overlays: [], ...SHOW, date: '2026-10-31' }, { actor: 'test' });
  await page.goto(`${platform.url}/?signed=1#/overlays/solo-h`);
  await page.waitFor('document.querySelector("[data-view] .needs-show")', 15000);
  await click(page, '[data-view] .needs-show button', 'Add it to a show');
  await page.waitFor('document.querySelector("dialog[open] select")', 8000);
  const d = await page.eval('(() => { const s = document.querySelector("dialog[open] select"); return { title: document.querySelector("dialog[open] h2").textContent, options: [...s.options].map((o) => o.textContent), picked: s.value, hint: document.getElementById(s.getAttribute("aria-describedby"))?.textContent, intro: document.querySelector("dialog[open] .dialog-body p").textContent, top: document.querySelector("dialog[open]").scrollTop }; })()');
  assert.equal(d.title, 'Add "solo-h" to a show');
  assert.deepEqual(d.options, ['Sneaky · Sat, Oct 31 · 0 overlays', 'Night · Sat, Oct 17 · 1 overlay']);
  assert.equal(d.picked, night.id, 'the show "room" is in: overlays of one template change scenes together');
  assert.equal(d.hint, '"room", of the same template, is in "Night".');
  assert.equal(d.intro, 'Then set times, the countdown, REC and title cards come from that show, and its scenes change with the show\'s other overlays.');
  assert.equal(d.top, 0);
  assert.deepEqual(await boxesIn(page, 'dialog[open] fieldset'), [['solo-v', true, false]], 'its twin, ticked');

  // The show is edited elsewhere while the dialog is open: the change is refused, said, nothing added.
  const now = await api('GET', `/shows/${night.id}`);
  assert.equal((await api('PATCH', `/shows/${night.id}`, { lineup: [{ time: '22:00', name: 'Opener' }, { time: '23:00', name: 'Closer' }] }, { 'if-match': now.etag })).status, 200);
  await click(page, 'dialog[open] button', 'Add to show');
  await page.waitFor('[...document.querySelectorAll("dialog[open] .notice.danger")].some((n) => /"Night" changed since you opened this \\(someone else, or another tab\\), so nothing was added\\. This is it as it is now: add it again\\./.test(n.textContent))', 8000);
  assert.deepEqual((await api('GET', `/shows/${night.id}`)).body.members, ['room']);
  const first = changes.filter((c) => c.method === 'PATCH' && c.path === `/api/v1/shows/${night.id}`);
  assert.equal(first.length, 1);
  assert.equal(first[0].ifMatch, now.etag, 'the show as the dialog read it');

  // Again, on the show as it is now: added, with its twin, and the page shows it in the show.
  await sleep(100);
  await click(page, 'dialog[open] button', 'Add to show');
  await page.waitFor('!document.querySelector("dialog[open]")', 8000);
  await toastSeen(page, '/"solo-h" and "solo-v" are in the show "Night" now\\./');
  const after = (await api('GET', `/shows/${night.id}`)).body;
  assert.deepEqual(after.members, ['room', 'solo-h', 'solo-v']);
  assert.equal(after.lineup.length, 2, 'the other change stays');
  const second = changes.filter((c) => c.method === 'PATCH' && c.path === `/api/v1/shows/${night.id}`)[1];
  assert.notEqual(second.ifMatch, first[0].ifMatch);
  assert.match(second.ifMatch, /^"show_[0-9A-Z]+-r\d+"$/);
  assert.deepEqual(second.body, { overlays: ['room', 'solo-h', 'solo-v'].map((s) => platform.overlays.resolve(s).doc.id) });
  await page.waitFor('/In the show Night/.test(document.querySelector("[data-view] p.row")?.innerText || "") && !document.querySelector("[data-view] .needs-show")', 8000);
  assert.deepEqual(problems(), []);
});

test('Live: an overlay that reads a show but is in none says so on its card and first in its console, and why a title card shows nothing; on a phone nothing scrolls sideways', opts, async (t) => {
  const { platform, api, page, changes, problems } = await start(t, { width: 390, height: 844, phone: true });
  for (const slug of ['solo-h', 'solo-v']) platform.overlays.create({ slug, template: TESTBED, settings: {} });
  platform.overlays.create({ slug: 'diag', template: DIAG, settings: {} });
  platform.overlays.create({ slug: 'room', template: TESTBED, settings: {} });
  const night = platform.shows.create({ name: 'Night', overlays: ['room'], ...SHOW }, { actor: 'test' });

  // ---- the streams page: the card says it; another template's card and the show's don't ------
  await page.goto(`${platform.url}/?signed=1#/live`);
  await page.waitFor('document.querySelectorAll("[data-view] .stream-card").length === 4 && document.querySelectorAll("[data-view] .stream-card .needs-show").length === 2', 15000);
  const card = (name) => page.eval(`(() => { const c = [...document.querySelectorAll('[data-view] .stream-card')].find((x) => x.querySelector('h2').textContent === ${JSON.stringify(name)}); return { text: c.innerText, buttons: [...c.querySelectorAll('.needs-show button')].map((b) => [b.textContent, Math.round(b.getBoundingClientRect().height)]) }; })()`);
  const solo = await card('solo-h');
  assert.match(solo.text, /Overlay outside a show[\s\S]*Set times, the countdown, REC and title cards come from a show\. This overlay isn't in one yet\./);
  assert.doesNotMatch(solo.text, /Until it is/, 'the card keeps to one sentence');
  assert.deepEqual(solo.buttons.map((b) => b[0]), ['Make a show from this overlay', 'Add it to a show']);
  for (const [label, height] of solo.buttons) assert.ok(height >= 44, `${label}: ${height} px`);
  assert.deepEqual((await card('diag')).buttons, []);
  assert.deepEqual((await card('Night')).buttons, []);
  assert.equal(await page.eval('document.documentElement.scrollWidth > innerWidth + 1'), false, 'no sideways scrolling');
  // The polls leave it as it is (a button keeps its place and focus).
  const button = await page.eval('(() => { window.__solo = [...document.querySelectorAll("[data-view] .stream-card .needs-show button")][0]; return !!window.__solo; })()');
  assert.ok(button);
  await sleep(3500);
  assert.equal(await page.eval('window.__solo.isConnected'), true);

  // ---- its console: the notice first, the actions say why a title card shows nothing --------
  await page.eval('location.hash = "#/live?overlay=solo-h"');
  await page.waitFor('document.querySelector("[data-view] h1")?.textContent === "solo-h" && document.querySelector("[data-view] .needs-show") && document.querySelector("[data-view] [role=group][aria-label=\'Actions of solo-h\']")', 15000);
  const consoleNotice = await needsText(page);
  assert.match(consoleNotice, /^Set times, the countdown, REC and title cards come from a show\. This overlay isn't in one yet\.\n+Until it is, a title card has no act to name, so it shows nothing\./);
  assert.equal(await page.eval('!!(document.querySelector("[data-view] .needs-show").compareDocumentPosition(document.querySelector("[data-view] .stream-status")) & Node.DOCUMENT_POSITION_FOLLOWING)'), true, 'before the stream\'s status');
  assert.match(await page.eval('[...document.querySelectorAll("[data-view] section.card")].find((c) => c.querySelector("h2")?.textContent === "Actions").innerText'), /Title card[\s\S]*This overlay isn't in a show, so these have no act to name: a title card shows nothing\./);
  assert.equal(await page.eval('document.documentElement.scrollWidth > innerWidth + 1'), false, 'no sideways scrolling');

  // Added to a show from here: its console is the show's, with it chosen.
  await click(page, '[data-view] .needs-show button', 'Add it to a show');
  await page.waitFor('document.querySelector("dialog[open] select")', 8000);
  assert.equal(await page.eval('document.querySelector("dialog[open]").scrollWidth <= document.querySelector("dialog[open]").clientWidth + 1 && document.documentElement.scrollWidth <= innerWidth + 1'), true, 'the dialog fits');
  await click(page, 'dialog[open] button', 'Add to show');
  await page.waitFor(`location.hash === ${JSON.stringify(`#/live?show=${night.id}&overlay=solo-h`)} && document.querySelector("[data-view] h1")?.textContent === "Night"`, 15000);
  assert.deepEqual((await api('GET', `/shows/${night.id}`)).body.members, ['room', 'solo-h', 'solo-v']);
  assert.match(changes.find((c) => c.method === 'PATCH').ifMatch, /^"show_[0-9A-Z]+-r\d+"$/);
  // In its show's console the panel says nothing of it any more.
  await page.waitFor('document.querySelector("[data-view] [role=group][aria-label=\'Actions of solo-h\']")', 10000);
  assert.equal(await needsText(page), '');
  assert.doesNotMatch(await viewText(page), /no act to name/);

  // Back on the streams page: only diag is left outside, and says nothing.
  await page.eval('location.hash = "#/live"');
  await page.waitFor('document.querySelectorAll("[data-view] .stream-card").length === 2', 15000);
  assert.equal(await page.eval('document.querySelectorAll("[data-view] .stream-card .needs-show").length'), 0);

  // "Make a show" from a card, on the phone: the dialog fits, and lands on the new show's Lineup.
  platform.overlays.create({ slug: 'late', template: TESTBED, settings: {} });
  await page.waitFor('document.querySelectorAll("[data-view] .stream-card .needs-show").length === 1', 10000);
  await click(page, '[data-view] .stream-card .needs-show button', 'Make a show from this overlay');
  await page.waitFor('document.querySelector("dialog[open] fieldset")', 8000);
  const fits = await page.eval('(() => { const d = document.querySelector("dialog[open]"); const r = d.getBoundingClientRect(); return { left: r.left, right: r.right, width: innerWidth, sideways: d.scrollWidth > d.clientWidth + 1 }; })()');
  assert.ok(fits.left >= 0 && fits.right <= fits.width && !fits.sideways, JSON.stringify(fits));
  await click(page, 'dialog[open] button', 'Create show');
  await page.waitFor('/^#\\/shows\\/show_[0-9A-Z]+\\?tab=lineup$/.test(location.hash) && document.querySelector("#tab-lineup")?.getAttribute("aria-selected") === "true"', 15000);
  assert.equal(await page.eval('document.documentElement.scrollWidth > innerWidth + 1'), false, 'the Lineup on a phone');
  assert.deepEqual(problems(), []);
});

test('copy is per overlay: a saved change is offered to the show\'s other overlays of the template, only what changed, each with its If-Match; a 412 on one is said and offered again', opts, async (t) => {
  const { platform, api, page, changes, problems } = await start(t);
  platform.overlays.create({ slug: 'trio-h', template: TESTBED, settings: { size: 5 } });
  platform.overlays.create({ slug: 'trio-v', template: TESTBED, settings: { size: 7 } });
  platform.overlays.create({ slug: 'trio-sq', template: TESTBED, settings: { size: 3 } });
  platform.overlays.create({ slug: 'trio-diag', template: DIAG, settings: {} });
  platform.shows.create({ name: 'Trio', overlays: ['trio-h', 'trio-v', 'trio-sq', 'trio-diag'], ...SHOW }, { actor: 'test' });
  // Not in the show: never offered.
  platform.overlays.create({ slug: 'elsewhere', template: TESTBED, settings: {} });

  await page.goto(`${platform.url}/?signed=1#/overlays/trio-h?tab=settings`);
  await page.waitFor('document.querySelector("[data-view] .form-actions .btn.primary")', 15000);
  assert.match(await viewText(page), /These settings are this overlay's own: trio-sq and trio-v, also in "Trio", have their own\. When you save, you can change them the same way\./);
  const setAccent = (value) => page.eval(`(() => {
    const l = [...document.querySelectorAll('[data-view] label')].find((x) => x.textContent.trim() === 'Accent');
    const i = document.getElementById(l.htmlFor);
    i.value = ${JSON.stringify(value)};
    i.dispatchEvent(new Event('input', { bubbles: true }));
    i.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await setAccent('#ff0000');
  await click(page, '[data-view] .form-actions button', 'Save settings');
  await toastSeen(page, '/Settings saved/');
  await page.waitFor('document.querySelector("[data-view] .also-change")', 8000);
  assert.equal(await page.eval('document.querySelector("[data-view] .also-change p").textContent'), 'trio-v and trio-sq (also in "Trio") have their own Accent: change them the same way?');
  assert.deepEqual(await page.eval('[...document.querySelectorAll("[data-view] .also-change button")].map((b) => b.textContent)'), ['Also change: trio-v, trio-sq', 'Leave them as they are']);

  // trio-sq is changed elsewhere before the offer is taken: trio-v changes, trio-sq is refused.
  const sq = await api('GET', '/overlays/trio-sq');
  assert.equal((await api('PATCH', '/overlays/trio-sq', { settings: { size: 4 } }, { 'if-match': sq.etag })).status, 200);
  const count = changes.length;
  await click(page, '[data-view] .also-change button', 'Also change: trio-v, trio-sq');
  await page.waitFor('[...document.querySelectorAll("[data-view] .also-box .notice.danger")].some((n) => n.textContent === "Changed on trio-v. Not changed on trio-sq (it changed since this page read it: someone else, or another tab).")', 8000);
  await toastSeen(page, '/Not every overlay was changed: trio-sq was not\\./');
  assert.deepEqual((await api('GET', '/overlays/trio-v')).body.settings, { size: 7, accent: '#ff0000' }, 'only what changed');
  assert.deepEqual((await api('GET', '/overlays/trio-sq')).body.settings, { size: 4 }, 'nothing over the other change');
  const sent = changes.slice(count).filter((c) => c.method === 'PATCH');
  assert.deepEqual(sent.map((c) => c.path.split('/').at(-1)), ['trio-v', 'trio-sq'].map((s) => platform.overlays.resolve(s).doc.id));
  assert.match(sent[0].ifMatch, /^"ovl_[0-9A-Z]+-r\d+"$/);
  assert.equal(sent[1].ifMatch, sq.etag, 'trio-sq as the offer read it');
  // Offered again on trio-sq as it is now: taken, only the accent.
  assert.deepEqual(await page.eval('[...document.querySelectorAll("[data-view] .also-change button")].map((b) => b.textContent)'), ['Also change: trio-sq', 'Leave it as it is']);
  await click(page, '[data-view] .also-change button', 'Also change: trio-sq');
  await toastSeen(page, '/Changed on trio-sq too\\./');
  assert.deepEqual((await api('GET', '/overlays/trio-sq')).body.settings, { size: 4, accent: '#ff0000' });
  await page.waitFor('!document.querySelector("[data-view] .also-box").children.length', 5000);
  for (const slug of ['trio-diag', 'elsewhere']) assert.deepEqual((await api('GET', `/overlays/${slug}`)).body.settings, {}, `${slug} is not offered`);

  // A change the others already hold is not offered; "Leave them as they are" clears the offer.
  await setAccent('#00ff00');
  await click(page, '[data-view] .form-actions button', 'Save settings');
  await page.waitFor('document.querySelector("[data-view] .also-change")?.textContent.includes("trio-v and trio-sq")', 8000);
  await click(page, '[data-view] .also-change button', 'Leave them as they are');
  await page.waitFor('!document.querySelector("[data-view] .also-change")', 5000);
  assert.equal((await api('GET', '/overlays/trio-v')).body.settings.accent, '#ff0000', 'left as it was');
  assert.deepEqual(problems(), []);
});

test('a role that can\'t make shows reads the notice, without its buttons', opts, async (t) => {
  const { platform, page, problems } = await start(t);
  platform.overlays.create({ slug: 'tk-h', template: TESTBED, settings: {} });
  // The owner adds a viewer, who signs in on this browser.
  assert.equal(await page.eval(`(async () => {
    const { csrf } = await (await fetch('/api/v1/auth/session')).json();
    const made = await fetch('/api/v1/users', { method: 'POST', headers: { 'content-type': 'application/json', 'x-skp-csrf': csrf }, body: JSON.stringify({ username: 'vi', password: ${JSON.stringify(OWNER.password)}, role: 'viewer' }) });
    const login = await fetch('/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'vi', password: ${JSON.stringify(OWNER.password)} }) });
    return [made.status, login.status].join();
  })()`), '201,200');
  await page.goto(`${platform.url}/?signed=2#/overlays/tk-h`);
  await page.waitFor('document.querySelector("[data-view] .needs-show")', 15000);
  assert.match(await needsText(page), /This overlay isn't in one yet\.[\s\S]*Your role can't make shows: an operator or a higher role can put it in one\./);
  assert.equal(await page.eval('document.querySelectorAll("[data-view] .needs-show button").length'), 0);
  await page.eval('location.hash = "#/live"');
  await page.waitFor('document.querySelector("[data-view] .stream-card .needs-show")', 15000);
  assert.equal(await page.eval('document.querySelectorAll("[data-view] .stream-card .needs-show button").length'), 0);
  assert.deepEqual(problems(), []);
});

test('copy offered on a phone: the offer fits and nothing scrolls sideways', opts, async (t) => {
  const { platform, page, problems } = await start(t, { width: 390, height: 844, phone: true });
  platform.overlays.create({ slug: 'takeover-landscape', template: TESTBED, settings: {} });
  platform.overlays.create({ slug: 'takeover-vertical', template: TESTBED, settings: {} });
  platform.shows.create({ name: 'Saturday TAKEOVER', overlays: ['takeover-landscape', 'takeover-vertical'], ...SHOW }, { actor: 'test' });
  await page.goto(`${platform.url}/?signed=1#/overlays/takeover-landscape?tab=settings`);
  await page.waitFor('document.querySelector("[data-view] .form-actions .btn.primary")', 15000);
  await page.eval(`(() => {
    const l = [...document.querySelectorAll('[data-view] label')].find((x) => x.textContent.trim() === 'Accent');
    const i = document.getElementById(l.htmlFor);
    i.value = '#16e0ff';
    i.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await click(page, '[data-view] .form-actions button', 'Save settings');
  await page.waitFor('document.querySelector("[data-view] .also-change")', 8000);
  const state = await page.eval('({ sideways: document.documentElement.scrollWidth > innerWidth + 1, buttons: [...document.querySelectorAll("[data-view] .also-change button")].map((b) => { const r = b.getBoundingClientRect(); return [b.textContent, Math.round(r.height), r.right <= innerWidth]; }) })');
  assert.equal(state.sideways, false);
  for (const [label, height, inside] of state.buttons) assert.ok(height >= 44 && inside, `${label}: ${height} px, inside ${inside}`);
  assert.deepEqual(problems(), []);
});

const CLOCK = { id: 'com.ctd.text-clock', version: '1.0.0' };
// A label's control in the open dialog.
const inDialog = (label) => `[...document.querySelectorAll('dialog[open] label')].map((l) => l.textContent === ${JSON.stringify(label)} && document.getElementById(l.htmlFor)).find(Boolean)`;

test('Live: a show made meanwhile offers "Add it to a show" in the console; a title card outside a show says it was sent with no act to name; a clock that reads only a show\'s times gets a quiet line on its page and nothing on Live', opts, async (t) => {
  const { platform, api, page, changes, problems } = await start(t);
  platform.overlays.create({ slug: 'lone', template: TESTBED, settings: {} });
  platform.overlays.create({ slug: 'clock', template: CLOCK, settings: {} });
  await page.goto(`${platform.url}/?signed=1#/live?overlay=lone`);
  await page.waitFor('document.querySelector("[data-view] .needs-show") && document.querySelector("[data-view] [role=group][aria-label=\'Actions of lone\']")', 15000);
  const buttons = () => page.eval('[...document.querySelectorAll("[data-view] .needs-show button")].map((b) => b.textContent)');
  assert.deepEqual(await buttons(), ['Make a show from this overlay'], 'no show to add it to yet');

  // A title card: sent with no act named, and said so, not "on air".
  await click(page, '[data-view] [role=group][aria-label="Actions of lone"] button', 'Title card');
  await toastSeen(page, '/^lone: Title card sent\\. It has no act to name until the overlay is in a show\\.$/');
  const fired = changes.filter((c) => c.method === 'POST' && c.path.endsWith('/actions/titleCard'));
  assert.equal(fired.length, 1);
  assert.deepEqual(fired[0].body, {});

  // A show made meanwhile (another tab, another phone): the console offers to add it there.
  platform.shows.create({ name: 'Later', overlays: [], ...SHOW }, { actor: 'test' });
  await page.waitFor('[...document.querySelectorAll("[data-view] .needs-show button")].some((b) => b.textContent === "Add it to a show")', 10000);
  assert.deepEqual(await buttons(), ['Make a show from this overlay', 'Add it to a show']);

  // The streams page: the clock may have a time of its own, so its card says nothing of a show.
  await page.eval('location.hash = "#/live"');
  await page.waitFor('document.querySelectorAll("[data-view] .stream-card").length === 3 && document.querySelectorAll("[data-view] .stream-card .needs-show").length === 1', 15000);
  const clockCard = await page.eval('[...document.querySelectorAll("[data-view] .stream-card")].find((c) => c.querySelector("h2").textContent === "clock").innerText');
  assert.doesNotMatch(clockCard, /show\.|from a show|Make a show/);

  // Its page: a quiet line, not the warning, with the ways into a show; Sample data says what it makes up.
  await go(page, '/overlays/clock', 'document.querySelector("[data-view] h1")?.textContent === "clock" && document.querySelector("[data-view] .show-times")');
  assert.equal(await needsText(page), '');
  const quiet = await page.eval('({ text: document.querySelector("[data-view] .show-times p").textContent, buttons: [...document.querySelectorAll("[data-view] .show-times button")].map((b) => [b.textContent, b.classList.contains("primary")]) })');
  assert.equal(quiet.text, 'With no time of its own, the countdown runs to a show\'s go-live, and the count-up from when it went live. This overlay isn\'t in a show.');
  assert.deepEqual(quiet.buttons, [['Make a show from this overlay', false], ['Add it to a show', false]]);
  await page.eval('(() => { const l = [...document.querySelectorAll("[data-view] label")].find((x) => x.textContent === "Sample data"); document.getElementById(l.htmlFor).click(); })()');
  await page.waitFor('[...document.querySelectorAll("[data-view] .notice")].some((n) => n.offsetParent && n.textContent === "Sample data makes up a show\'s times here. With no time of its own, on air this overlay has nothing to count to or from until it is in a show.")', 5000);

  // In a show: where its go-live time is set.
  const later = (await api('GET', '/shows/Later'));
  assert.equal((await api('PATCH', `/shows/${later.body.id}`, { overlays: [platform.overlays.resolve('clock').doc.id] }, { 'if-match': later.etag })).status, 200);
  await go(page, '/overlays');
  await go(page, '/overlays/clock', 'document.querySelector("[data-view] h1")?.textContent === "clock" && /In the show Later/.test(document.querySelector("[data-view] p.row")?.innerText || "")');
  assert.equal(await page.eval('!!document.querySelector("[data-view] .show-times")'), false);
  assert.match(await viewText(page), /With no time of its own, the countdown runs to the show's go-live, and the count-up from when it went live\. Its go-live time is on the show: Details \(the date and go-live time\)\./);
  assert.deepEqual(problems(), []);
});

test('Make a show on a phone opens at its top; a twin put in another show meanwhile is left out, said in plain words, and the rest is made', opts, async (t) => {
  const { platform, api, page, problems } = await start(t, { width: 390, height: 844, phone: true });
  for (const slug of ['tk-h', 'tk-v']) platform.overlays.create({ slug, template: TESTBED, settings: {} });
  await page.goto(`${platform.url}/?signed=1#/overlays/tk-h`);
  await page.waitFor('document.querySelector("[data-view] .needs-show")', 15000);
  await click(page, '[data-view] .needs-show button', 'Make a show from this overlay');
  await page.waitFor('document.querySelector("dialog[open] fieldset")', 8000);
  const opened = await page.eval(`(() => {
    const d = document.querySelector('dialog[open]');
    return { top: d.scrollTop, title: d.querySelector('h2').getBoundingClientRect().top - d.getBoundingClientRect().top, focused: document.activeElement === ${inDialog('Name')}, sideways: d.scrollWidth > d.clientWidth + 1 || document.documentElement.scrollWidth > innerWidth + 1 };
  })()`);
  assert.deepEqual(opened.top, 0, 'its title and what a show is, in view');
  assert.ok(opened.title >= 0, JSON.stringify(opened));
  assert.equal(opened.focused, true);
  assert.equal(opened.sideways, false);
  assert.deepEqual(await boxesIn(page, 'dialog[open] fieldset'), [['tk-h (this overlay)', true, true], ['tk-v', true, false]]);

  // Meanwhile, elsewhere, tk-v goes into another show: refused (an overlay is in one show at
  // most), said in plain words, tk-v left out.
  assert.equal((await api('POST', '/shows', { name: 'Sneaky', overlays: ['tk-v'], ...SHOW })).status, 201);
  await click(page, 'dialog[open] button', 'Create show');
  await page.waitFor('[...document.querySelectorAll("dialog[open] .notice.danger")].some((n) => n.textContent === "\\"tk-v\\" is in the show \\"Sneaky\\" now, so it is left out. Press Create show again for the rest.")', 8000);
  const text = await page.eval('document.querySelector("dialog[open]").innerText');
  assert.doesNotMatch(text, /§|01 /, 'no reference to the standard');
  assert.match(text, /What feeds it stays as it is \(Fed by\)/, 'said for tk-h alone');
  assert.deepEqual(await boxesIn(page, 'dialog[open] fieldset'), [['tk-h (this overlay)', true, true], ['tk-v (in "Sneaky" now)', false, true]]);
  await click(page, 'dialog[open] button', 'Create show');
  await page.waitFor('!document.querySelector("dialog[open]") && /^#\\/shows\\/show_[0-9A-Z]+\\?tab=lineup$/.test(location.hash)', 15000);
  const id = await page.eval('location.hash.split("/")[2].split("?")[0]');
  assert.deepEqual((await api('GET', `/shows/${id}`)).body.members, ['tk-h']);
  assert.deepEqual((await api('GET', '/shows/Sneaky')).body.members, ['tk-v'], 'left where it was');
  assert.deepEqual(problems(), []);
});

test('Make a show picks the show\'s night as New show does: before noon it is still the night before, in the zone chosen', opts, async (t) => {
  const { platform, page, problems } = await start(t);
  platform.overlays.create({ slug: 'tk-h', template: TESTBED, settings: {} });
  // A zone where it is morning now and one where it is afternoon (somewhere it is always both).
  const ZONES = ['Pacific/Kiritimati', 'Pacific/Tongatapu', 'Pacific/Auckland', 'Pacific/Noumea', 'Australia/Brisbane', 'Asia/Tokyo', 'Asia/Shanghai', 'Asia/Bangkok', 'Asia/Dhaka', 'Asia/Karachi', 'Asia/Dubai', 'Europe/Moscow', 'Europe/Athens', 'Europe/Paris', 'Europe/London', 'UTC', 'Atlantic/Azores', 'America/Noronha', 'America/Sao_Paulo', 'America/Halifax', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu', 'Pacific/Pago_Pago'];
  const local = (zone) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit' }).formatToParts(new Date()).map((x) => [x.type, x.value]));
    return { hour: Number(p.hour), day: `${p.year}-${p.month}-${p.day}` };
  };
  const dayBefore = (ymd) => new Date(Date.parse(`${ymd}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
  const morning = ZONES.find((z) => local(z).hour >= 1 && local(z).hour <= 10);
  const afternoon = ZONES.find((z) => local(z).hour >= 13 && local(z).hour <= 22);
  assert.ok(morning && afternoon, `${morning} ${afternoon}`);
  await page.send('Emulation.setTimezoneOverride', { timezoneId: morning });
  await page.goto(`${platform.url}/?signed=1#/overlays/tk-h`);
  await page.waitFor('document.querySelector("[data-view] .needs-show")', 15000);
  await click(page, '[data-view] .needs-show button', 'Make a show from this overlay');
  await page.waitFor('document.querySelector("dialog[open] fieldset")', 8000);
  const read = () => page.eval(`(() => {
    const date = ${inDialog('Date')};
    return { zone: ${inDialog('Time zone')}.value, date: date.value, words: date.nextElementSibling.textContent, tonight: document.querySelector('dialog[open] [aria-label="Quick dates"] button').getAttribute('aria-pressed') };
  })()`);
  let now = await read();
  assert.equal(now.zone, morning);
  assert.equal(now.date, dayBefore(local(morning).day), `${morning} at ${local(morning).hour}h: the night before`);
  assert.match(now.words, /: tonight$/);
  assert.equal(now.tonight, 'true');
  // Another zone, the date not picked by hand: the show's night there.
  await page.eval(`(() => { const s = ${inDialog('Time zone')}; s.value = ${JSON.stringify(afternoon)}; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  now = await read();
  assert.equal(now.date, local(afternoon).day, `${afternoon} at ${local(afternoon).hour}h: today`);
  assert.match(now.words, /: tonight$/);
  await click(page, 'dialog[open] button', 'Cancel');
  await page.waitFor('!document.querySelector("dialog[open]")', 5000);

  // New show, on Shows, picks the same night in this device's zone.
  await go(page, '/shows', 'document.querySelector("[data-view] h1")?.textContent === "Shows"');
  await click(page, '[data-view] button', 'New show');
  await page.waitFor('document.querySelector("dialog[open]")', 8000);
  assert.equal(await page.eval(`${inDialog('Date')}.value`), dayBefore(local(morning).day));
  assert.deepEqual(problems(), []);
});

test('Also change: offered on the show the overlay is in now, only the settings the other overlay\'s version has; a value its version can\'t take is said plainly and not offered again', opts, async (t) => {
  const { platform, api, page, problems } = await start(t);
  // dev.review.copy 1.1.0 adds a tagline and allows a larger size than 1.0.0.
  const COPY = 'dev.review.copy';
  const pack = (version, more) => packTemplate(DIAG_DIR, { manifest: { id: COPY, name: 'Copy', version, consumes: { state: ['custom.*'] }, settings: { type: 'object', additionalProperties: false, properties: { accent: { type: 'string', title: 'Accent' }, ...more } } } });
  platform.templates.install(pack('1.0.0', { size: { type: 'integer', title: 'Size', minimum: 1, maximum: 5 } }), { actor: 'test' });
  platform.templates.install(pack('1.1.0', { size: { type: 'integer', title: 'Size', minimum: 1, maximum: 10 }, tagline: { type: 'string', title: 'Tagline' } }), { actor: 'test' });
  platform.overlays.create({ slug: 'copy-h', template: { id: COPY, version: '1.1.0' }, settings: {} });
  platform.overlays.create({ slug: 'copy-v', template: { id: COPY, version: '1.0.0' }, settings: { size: 2 } });
  platform.shows.create({ name: 'Copy test', overlays: ['copy-h', 'copy-v'], ...SHOW }, { actor: 'test' });
  for (const slug of ['x-h', 'x-v', 'y-v']) platform.overlays.create({ slug, template: TESTBED, settings: {} });
  const showA = platform.shows.create({ name: 'Show A', overlays: ['x-h', 'x-v'], ...SHOW }, { actor: 'test' });
  const setField = (label, value) => page.eval(`(() => {
    const l = [...document.querySelectorAll('[data-view] label')].find((x) => x.textContent.trim() === ${JSON.stringify(label)});
    const i = document.getElementById(l.htmlFor);
    i.value = ${JSON.stringify(value)};
    i.dispatchEvent(new Event('input', { bubbles: true }));
    i.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  const save = async () => {
    await click(page, '[data-view] .form-actions button', 'Save settings');
    await toastSeen(page, '/Settings saved/');
  };
  const offer = () => page.eval('[...document.querySelectorAll("[data-view] .also-change p")].map((p) => p.textContent)');

  // ---- moved to another show while its page was open: the show it is in now ------------------
  await page.goto(`${platform.url}/?signed=1#/overlays/x-h?tab=settings`);
  await page.waitFor('document.querySelector("[data-view] .form-actions .btn.primary")', 15000);
  const a = await api('GET', `/shows/${showA.id}`);
  assert.equal((await api('PATCH', `/shows/${showA.id}`, { overlays: [platform.overlays.resolve('x-v').doc.id] }, { 'if-match': a.etag })).status, 200);
  assert.equal((await api('POST', '/shows', { name: 'Show B', overlays: ['x-h', 'y-v'], ...SHOW })).status, 201);
  await setField('Accent', '#ff0000');
  await save();
  await page.waitFor('document.querySelector("[data-view] .also-change")', 8000);
  assert.deepEqual(await offer(), ['y-v (also in "Show B") has its own Accent: change it the same way?']);
  await click(page, '[data-view] .also-change button', 'Also change: y-v');
  await toastSeen(page, '/Changed on y-v too\\./');
  assert.equal((await api('GET', '/overlays/y-v')).body.settings.accent, '#ff0000');
  assert.deepEqual((await api('GET', '/overlays/x-v')).body.settings, {}, 'no longer in its show');

  // ---- an older version: only what it has, and what it lacks said -----------------------------
  await go(page, '/overlays/copy-h?tab=settings', 'document.querySelector("[data-view] h1")?.textContent === "copy-h" && document.querySelector("[data-view] .form-actions .btn.primary")');
  await setField('Accent', '#00ff00');
  await setField('Tagline', 'Every Saturday');
  await save();
  await page.waitFor('document.querySelector("[data-view] .also-change")', 8000);
  const lacks = 'copy-v is on an older version of the template (1.0.0), which has no Tagline: upgrade copy-v to set it there.';
  assert.deepEqual(await offer(), ['copy-v (also in "Copy test") has its own Accent: change it the same way?', lacks]);
  await click(page, '[data-view] .also-change button', 'Also change: copy-v');
  await toastSeen(page, '/Changed on copy-v too\\./');
  assert.deepEqual((await api('GET', '/overlays/copy-v')).body.settings, { size: 2, accent: '#00ff00' }, 'only what its version has');
  // Only what it lacks changed: nothing to offer, and why.
  await setField('Tagline', 'Every other Saturday');
  await save();
  await page.waitFor(`[...document.querySelectorAll("[data-view] .also-box > p")].some((p) => p.textContent === ${JSON.stringify(lacks)})`, 8000);
  assert.equal(await page.eval('!!document.querySelector("[data-view] .also-change")'), false);

  // ---- a value its version can't take: refused, said plainly, not offered again ---------------
  await setField('Size', '8');
  await save();
  await page.waitFor('document.querySelector("[data-view] .also-change")', 8000);
  assert.deepEqual(await offer(), ['copy-v (also in "Copy test") has its own Size: change it the same way?']);
  await click(page, '[data-view] .also-change button', 'Also change: copy-v');
  await page.waitFor('[...document.querySelectorAll("[data-view] .also-box .notice.danger")].some((n) => n.textContent === "Nothing was changed. Not changed on copy-v (its version of the template, 1.0.0, can\'t take that value).")', 8000);
  await toastSeen(page, '/Not every overlay was changed: copy-v was not\\./');
  await sleep(500);
  assert.equal(await page.eval('!!document.querySelector("[data-view] .also-change")'), false, 'not offered again');
  assert.deepEqual((await api('GET', '/overlays/copy-v')).body.settings, { size: 2, accent: '#00ff00' });
  assert.deepEqual(problems(), []);
});
