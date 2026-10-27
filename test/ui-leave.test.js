// Leaving a page with edits not saved yet (app.js, ctx.guardLeave), in a real browser: a link in the
// navigation and the browser's Back ask "Leave without saving?" with what would be lost; Stay keeps
// the page as it was (the edits, the address, nothing drawn again) and Leave goes; one question at
// a time (a Back pressed while one is open, the router's or a tab change's, is put back); nothing
// is asked when nothing changed, nor once it is saved; a reload gets the browser's own question
// only while something isn't saved; the history stays as the browser had it (Back, then Cancel or
// Leave; a page's own move). On a show's Lineup, Details and plan editor, and on an overlay's
// Settings tab (its settings, Fed by, its role in OBS) at a phone's width, from its menu. And a
// session that ends signs in again to the page it was on, its query too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { startPlatform } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { browserSkip, launchBrowser } from './cdp.js';
import { defer, FIXTURE_TEMPLATES, memoryLogger, signedIn, tempDir, TESTBED } from './helpers.js';

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
  const problems = () => page.problems.slice(before).filter((p) => !p.startsWith('network:'));
  return { platform, api, browser, page, problems };
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
const type = (page, selector, value, nth = 0) => page.eval(`(() => {
  const el = [...document.querySelectorAll(${JSON.stringify(selector)})].filter((x) => !x.closest('[hidden]'))[${nth}];
  if (!el) throw new Error('no field ' + ${JSON.stringify(selector)});
  el.value = ${JSON.stringify(value)};
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
})()`);
const buttonSeen = (text) => `[...document.querySelectorAll("[data-view] button")].some((b) => b.textContent === ${JSON.stringify(text)})`;
const toastSeen = (page, start) => page.waitFor(`[...document.querySelectorAll(".toast span")].some((s) => s.textContent.startsWith(${JSON.stringify(start)}))`, 10000);
// The question asked, in words, once it is open.
const question = async (page) => {
  await page.waitFor('document.querySelector("dialog[open]")', 5000);
  return page.eval('document.querySelector("dialog[open]").innerText');
};
// Answered once the dialog is gone (its close event handled, the answer given), not only shut.
const answer = async (page, label) => {
  await click(page, 'dialog[open] button', label);
  await page.waitFor('!document.querySelector("dialog")', 5000);
};
const open = (page) => page.eval('document.querySelectorAll("dialog[open]").length');
const hash = (page) => page.eval('location.hash');
// The browser's Back, done once the address has changed and the app has had its say (its
// listener runs before the one counted here), and settled: a move the app undoes (Forward, for a
// Back away from edits not saved) is one more change, a moment later.
const back = async (page) => {
  const n = await page.eval('window.__moves ??= 0, addEventListener("hashchange", () => { window.__moves += 1; }, { once: true }), window.__moves');
  await page.eval('history.back()');
  await page.waitFor(`window.__moves > ${n}`, 5000);
  await sleep(300);
};
// History moved (Back or Forward, the app's undo included) until the address is `want`, the page
// there drawn.
const settled = async (page, want) => {
  await page.waitFor(`location.hash === ${JSON.stringify(want)} && !document.querySelector("[data-view] > .loading") && document.querySelector("[data-view] h1")`, 10000);
  await sleep(300);
  assert.equal(await page.eval('location.hash'), want, 'and it stays there');
};
// Whether a reload or closing the tab would ask now: what the page's beforeunload listeners do
// with the event the browser sends then.
const unloadAsks = (page) => page.eval('(() => { const e = new Event("beforeunload", { cancelable: true }); dispatchEvent(e); return e.defaultPrevented; })()');

test('a show with edits not saved: a link and Back ask first, Stay keeps them and the address, Leave goes; one question at a time; nothing asked once saved, nor with nothing changed', opts, async (t) => {
  const { platform, api, page, problems } = await start(t);
  platform.overlays.create({ slug: 'tk', template: TESTBED, settings: {} });
  const night = platform.shows.create({ name: 'Night', overlays: ['tk'], ...SHOW, lineup: [{ time: '22:30', name: 'Manzone' }] }, { actor: 'test' });
  // Somewhere to go Back to: Live, Overlays, Live, then the show's Lineup.
  await page.goto(`${platform.url}/?signed=1#/live`);
  await page.waitFor('document.querySelector("[data-view] h1")', 15000);
  await go(page, '/overlays');
  await go(page, '/live');
  const lineup = `#/shows/${night.id}?tab=lineup`;
  await go(page, lineup.slice(1), buttonSeen('Add an act'));
  assert.equal(await unloadAsks(page), false, 'nothing changed: a reload asks nothing');

  await type(page, '[data-view] fieldset input[type=text][list]', 'MANZONE');
  await page.eval('window.__act = document.querySelector("[data-view] fieldset input[type=text][list]")');
  assert.equal(await unloadAsks(page), true, 'a reload asks while the lineup isn\'t saved');

  // A link in the navigation: asked, with what is lost, before the address changes.
  await click(page, '[data-nav] a', 'Live');
  assert.match(await question(page), /^Leave without saving\?\s+Your changes to the lineup are lost; it stays as it was saved\./);
  assert.equal(await hash(page), lineup);
  // Back while it is open: put back, not asked again.
  await back(page);
  assert.deepEqual([await open(page), await hash(page)], [1, lineup]);
  // Stay: the page as it was, the edit in the same field (nothing drawn again).
  await answer(page, 'Cancel');
  assert.deepEqual(await page.eval('[location.hash, window.__act.isConnected, window.__act.value, document.querySelector("[data-view] h1").textContent]'), [lineup, true, 'MANZONE', 'Night']);

  // Back: asked once the address has changed, which is put back while it asks; Stay keeps it all.
  await back(page);
  assert.match(await question(page), /Your changes to the lineup are lost/);
  assert.equal(await hash(page), lineup);
  await answer(page, 'Cancel');
  assert.deepEqual(await page.eval('[location.hash, window.__act.isConnected, window.__act.value]'), [lineup, true, 'MANZONE']);

  // A tab change asks the same question; a Back while that is open isn't asked about twice.
  await page.eval('document.querySelector("#tab-details").click()');
  assert.match(await question(page), /Your changes to the lineup are lost/);
  await back(page);
  assert.deepEqual([await open(page), await hash(page)], [1, lineup]);
  await answer(page, 'Cancel');
  assert.deepEqual(await page.eval('[document.querySelector("#tab-lineup").getAttribute("aria-selected"), window.__act.isConnected, window.__act.value]'), ['true', true, 'MANZONE']);

  // Leave: it goes, without the edit.
  await click(page, '[data-nav] a', 'Overlays');
  await question(page);
  await answer(page, 'Leave');
  await page.waitFor('location.hash === "#/overlays" && document.querySelector("[data-view] h1")?.textContent === "Overlays"', 10000);
  assert.equal(await unloadAsks(page), false, 'nothing to lose there');
  assert.equal((await api('GET', `/shows/${night.id}`)).body.lineup[0].name, 'Manzone');

  // Saved: nothing is asked, by a link or a reload.
  await go(page, lineup.slice(1), buttonSeen('Add an act'));
  await type(page, '[data-view] fieldset input[type=text][list]', 'MANZONE');
  await click(page, '[data-view] button', 'Save lineup');
  await toastSeen(page, 'Lineup saved');
  assert.equal(await unloadAsks(page), false);
  await click(page, '[data-nav] a', 'Live');
  await page.waitFor('location.hash === "#/live" && !document.querySelector("[data-view] > .loading")', 10000);
  assert.equal(await open(page), 0);
  assert.equal((await api('GET', `/shows/${night.id}`)).body.lineup[0].name, 'MANZONE');

  // The details say what they lose, and a page's own link (the crumb) asks too.
  await go(page, `/shows/${night.id}?tab=details`, buttonSeen('Save details'));
  await type(page, '[data-view] input[type=text]', 'Night out');
  await click(page, '[data-view] .crumbs a', 'Shows');
  assert.match(await question(page), /Your changes to the details are lost; the show stays as it was saved\./);
  await answer(page, 'Leave');
  await page.waitFor('location.hash === "#/shows" && document.querySelector("[data-view] h1")?.textContent === "Shows"', 10000);
  assert.equal((await api('GET', `/shows/${night.id}`)).body.name, 'Night');

  // A plan: opened and left as it was, nothing is asked; with a go-live typed in, it is.
  await go(page, `/shows/${night.id}?tab=plans`, buttonSeen('Plan a date'));
  await click(page, '[data-view] .card-head button', 'Plan a date');
  await page.waitFor('document.querySelector("[data-view] h2")?.textContent === "Plan a date"', 10000);
  assert.equal(await unloadAsks(page), false);
  await type(page, '[data-view] input.time-field', '23:00');
  assert.equal(await unloadAsks(page), true);
  await click(page, '[data-nav] a', 'Live');
  assert.match(await question(page), /This plan isn't saved: what you set here is lost\./);
  await answer(page, 'Cancel');
  assert.equal(await page.eval('document.querySelector("[data-view] input.time-field").value'), '23:00');
  // The plan editor's own Cancel asks it too, and back on the list nothing is left to ask about.
  await click(page, '[data-view] button', 'Cancel');
  await question(page);
  await answer(page, 'Leave');
  await page.waitFor('document.querySelector("[data-view] h2")?.textContent === "Planned dates"', 10000);
  assert.equal(await unloadAsks(page), false);
  await click(page, '[data-nav] a', 'Live');
  await page.waitFor('location.hash === "#/live"', 10000);
  assert.equal(await open(page), 0);
  assert.deepEqual(problems(), []);
});

test('leaving asks without breaking the history: Back then Cancel keeps every entry, Leave lands where Back went, and a page\'s own move is undone with Back, then made', opts, async (t) => {
  const { platform, page, problems } = await start(t);
  const night = platform.shows.create({ name: 'Night', overlays: [], ...SHOW, lineup: [{ time: '22:30', name: 'Manzone' }] }, { actor: 'test' });
  const lineup = `#/shows/${night.id}?tab=lineup`;
  // Live, Overlays, Media, then the show's Lineup.
  await page.goto(`${platform.url}/?signed=1#/live`);
  await page.waitFor('document.querySelector("[data-view] h1")', 15000);
  await go(page, '/overlays');
  await go(page, '/media');
  await go(page, lineup.slice(1), buttonSeen('Add an act'));
  const edit = async () => {
    await page.waitFor(buttonSeen('Add an act'), 10000);
    await type(page, '[data-view] fieldset input[type=text][list]', 'MANZONE');
  };
  const move = (how) => page.eval(how);

  // Back, then Cancel: the page, its edit and its address; and no entry lost: with nothing unsaved,
  // Back goes to Media, then Overlays.
  await edit();
  await move('history.back()');
  assert.match(await question(page), /Your changes to the lineup are lost/);
  await settled(page, lineup);
  await answer(page, 'Cancel');
  assert.equal(await page.eval('document.querySelector("[data-view] fieldset input[type=text][list]").value'), 'MANZONE');
  await click(page, '[data-view] button', 'Undo changes');
  await move('history.back()');
  await settled(page, '#/media');
  await move('history.back()');
  await settled(page, '#/overlays');

  // Forward to the Lineup again; Back, then Leave: on Media, and Back from there is Overlays, not
  // the Lineup just left.
  await move('history.forward()');
  await settled(page, '#/media');
  await move('history.forward()');
  await settled(page, lineup);
  await edit();
  await move('history.back()');
  await question(page);
  await answer(page, 'Leave');
  await settled(page, '#/media');
  assert.equal(await page.eval('document.querySelector("[data-view] h1").textContent'), 'Media');
  await move('history.back()');
  await settled(page, '#/overlays');

  // The page's own move (ctx.navigate, a new entry): Cancel undoes it, Leave makes it; Back from
  // there is the Lineup it left, then Media: nothing doubled.
  await move('history.forward()');
  await settled(page, '#/media');
  await move('history.forward()');
  await settled(page, lineup);
  await edit();
  await move('import("/ui/app.js").then((m) => m.navigate("/connections"))');
  await question(page);
  await settled(page, lineup);
  await answer(page, 'Cancel');
  assert.equal(await page.eval('document.querySelector("[data-view] fieldset input[type=text][list]").value'), 'MANZONE');
  await move('import("/ui/app.js").then((m) => m.navigate("/connections"))');
  await question(page);
  await answer(page, 'Leave');
  await settled(page, '#/connections');
  await move('history.back()');
  await settled(page, lineup);
  await move('history.back()');
  await settled(page, '#/media');
  assert.deepEqual(problems(), []);
});

test('signing in again after the session ends comes back to the page as it was, its query too', opts, async (t) => {
  const { platform, page, problems } = await start(t);
  const night = platform.shows.create({ name: 'Night', overlays: [], ...SHOW }, { actor: 'test' });
  const consoleHash = `#/live?show=${night.id}`;
  await page.goto(`${platform.url}/?signed=1${consoleHash}`);
  await page.waitFor('document.querySelector("[data-view] h1")?.textContent === "Night"', 15000);
  // The session ends (its cookie gone): the console's next read is refused, and sign-in asked for.
  await page.send('Network.clearBrowserCookies');
  await page.waitFor('location.hash.startsWith("#/login") && document.querySelector("input[name=username]")', 15000);
  assert.equal(await page.eval('new URLSearchParams(location.hash.split("?")[1]).get("next")'), `/live?show=${night.id}`);
  await page.eval(`(() => {
    document.querySelector('input[name=username]').value = ${JSON.stringify(OWNER.username)};
    document.querySelector('input[name=password]').value = ${JSON.stringify(OWNER.password)};
    document.querySelector('form').requestSubmit();
  })()`);
  await page.waitFor(`location.hash === ${JSON.stringify(consoleHash)} && document.querySelector("[data-view] h1")?.textContent === "Night"`, 15000);
  assert.deepEqual(problems(), []);
});

test('a reload while the lineup isn\'t saved gets the browser\'s own question: staying keeps the edit; once it is saved, the page reloads without one', opts, async (t) => {
  const { platform, browser, page, problems } = await start(t);
  const night = platform.shows.create({ name: 'Night', overlays: [], ...SHOW, lineup: [{ time: '22:30', name: 'Manzone' }] }, { actor: 'test' });
  await page.goto(`${platform.url}/?signed=1#/shows/${night.id}?tab=lineup`);
  await page.waitFor(buttonSeen('Add an act'), 15000);
  // The browser asks only on a page someone has used: a real tap first.
  for (const kind of ['mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type: kind, x: 5, y: 5, button: 'left', clickCount: 1 });
  await type(page, '[data-view] fieldset input[type=text][list]', 'MANZONE');
  await page.eval('window.__act = document.querySelector("[data-view] fieldset input[type=text][list]")');
  const dialogs = [];
  const off = browser.cdp.on((m) => { if (m.method === 'Page.javascriptDialogOpening') dialogs.push(m.params.type); });
  t.after(off);
  const reloading = page.send('Runtime.evaluate', { expression: 'location.reload()' }).catch(() => {});
  for (let i = 0; i < 100 && !dialogs.length; i++) await sleep(50);
  assert.deepEqual(dialogs, ['beforeunload']);
  await page.send('Page.handleJavaScriptDialog', { accept: false });
  await reloading;
  assert.deepEqual(await page.eval('[window.__act?.isConnected, window.__act?.value]'), [true, 'MANZONE'], 'stayed, with the edit');

  await click(page, '[data-view] button', 'Save lineup');
  await toastSeen(page, 'Lineup saved');
  await page.eval('window.__before = true');
  await page.send('Runtime.evaluate', { expression: 'location.reload()' }).catch(() => {});
  await page.waitFor('!window.__before && document.querySelector("[data-view] h1")?.textContent === "Night"', 15000);
  assert.deepEqual(dialogs, ['beforeunload'], 'no question once saved');
  assert.deepEqual(problems(), []);
});

test('an overlay\'s settings not saved: leaving asks from the phone\'s menu, whichever tab is open; Fed by and its role are named too; saved, nothing is asked', opts, async (t) => {
  const { platform, api, page, problems } = await start(t, { width: 390, height: 844, phone: true });
  platform.overlays.create({ slug: 'tk-h', template: TESTBED, settings: {} });
  await page.goto(`${platform.url}/?signed=1#/overlays/tk-h?tab=settings`);
  await page.waitFor('document.querySelector("[data-view] .form-actions .btn.primary")', 15000);
  assert.equal(await unloadAsks(page), false, 'nothing changed');
  const accent = `(() => { const l = [...document.querySelectorAll('[data-view] label')].find((x) => x.textContent.trim() === 'Accent'); return document.getElementById(l.htmlFor); })()`;
  await page.eval(`(() => {
    const i = ${accent};
    i.value = '#ff0000';
    i.dispatchEvent(new Event('input', { bubbles: true }));
    i.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  assert.equal(await unloadAsks(page), true, 'a reload asks while the settings aren\'t saved');

  // From the phone's menu: asked, the menu closed behind the question, nothing sideways.
  await page.eval('document.querySelector("[data-menu-toggle]").click()');
  await click(page, '[data-nav] a', 'Shows');
  assert.match(await question(page), /^Leave without saving\?\s+Your changes to its settings are lost; the overlay stays as it was saved\./);
  assert.deepEqual(await page.eval('[document.querySelector("[data-nav]").classList.contains("open"), document.documentElement.scrollWidth > innerWidth + 1, (() => { const r = document.querySelector("dialog[open]").getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; })()]'), [false, false, true]);
  await answer(page, 'Cancel');
  assert.equal(await hash(page), '#/overlays/tk-h?tab=settings');

  // Another tab of the page: the edit stays, and leaving still asks.
  await page.eval('document.querySelector("#tab-scenes").click()');
  await click(page, '[data-nav] a', 'Live');
  await question(page);
  await answer(page, 'Cancel');
  await page.eval('document.querySelector("#tab-settings").click()');
  assert.equal(await page.eval(`${accent}.value`), '#ff0000');

  // What feeds it and its role, not saved either: named too.
  await page.eval('(() => { const l = [...document.querySelectorAll("[data-view] label")].find((x) => x.textContent === "Only these"); document.getElementById(l.htmlFor).click(); })()');
  await type(page, '[data-view] #role input', 'main');
  await click(page, '[data-nav] a', 'Live');
  assert.match(await question(page), /Your changes to its settings, what feeds it and its role in OBS are lost; the overlay stays as it was saved\./);
  await answer(page, 'Cancel');

  // Saved, and the others put back as they were: nothing is asked.
  await click(page, '[data-view] .form-actions button', 'Save settings');
  await toastSeen(page, 'Settings saved');
  await page.eval('(() => { const l = [...document.querySelectorAll("[data-view] label")].find((x) => x.textContent === "All connections, including new ones"); document.getElementById(l.htmlFor).click(); })()');
  await type(page, '[data-view] #role input', '');
  assert.equal(await unloadAsks(page), false);
  await click(page, '[data-nav] a', 'Shows');
  await page.waitFor('location.hash === "#/shows" && document.querySelector("[data-view] h1")?.textContent === "Shows"', 10000);
  assert.equal(await open(page), 0);
  assert.equal((await api('GET', '/overlays/tk-h')).body.settings.accent, '#ff0000');
  assert.deepEqual(problems(), []);
});
