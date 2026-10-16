// Live with several streams at once, in a real browser (08 §8.4): the streams page lists two shows
// fed by two connections, each On air or Offline as its own connection says, and follows a change;
// Open goes to the show's console, whose overlay selector shows one member's panel (its actions and
// Simulate, kept in the address across a reload); an overlay outside a show opens on its own; and
// "Fed by" saves an overlay's connections with If-Match (a 412 says so), and every member's at once
// from the show's page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { startPlatform } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { browserSkip, launchBrowser } from './cdp.js';
import { until } from './connector-helpers.js';
import { fakeConnector } from './fixtures/connectors/fake.js';
import { defer, FIXTURE_TEMPLATES, memoryLogger, signedIn, tempDir, TESTBED } from './helpers.js';

const OWNER = { username: 'juan', password: 'correct horse battery staple' };
const SHOW = { date: '2026-10-17', timezone: 'America/Toronto' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const click = (page, selector, text) => page.eval(`(() => {
  const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((b) => b.textContent.trim() === ${JSON.stringify(text)} || b.getAttribute('aria-label') === ${JSON.stringify(text)});
  if (!el) throw new Error('nothing to click: ' + ${JSON.stringify(`${selector} ${text}`)});
  el.click();
})()`);
const cardText = (page, name) => page.eval(`[...document.querySelectorAll('[data-view] .stream-card')].find((c) => c.querySelector('h2').textContent === ${JSON.stringify(name)})?.innerText || ''`);
const toastSeen = (page, re) => page.waitFor(`[...document.querySelectorAll(".toast span")].some((s) => ${re}.test(s.textContent))`, 8000);

test('two streams at once: the streams page, a show\'s console and its overlays, an overlay alone, and Fed by', { skip: browserSkip, timeout: 180000 }, async (t) => {
  const twitch = fakeConnector({ id: 'fake', name: 'Direct' });
  const youtube = fakeConnector({ id: 'fake-yt', name: 'Direct YouTube', platform: 'youtube' });
  const root = tempDir(t);
  const config = loadConfig({ argv: ['--port', '0'], env: { SKP_DATA_DIR: path.join(root, 'data'), SKP_CONFIG_DIR: path.join(root, 'config') } });
  const platform = await startPlatform(config, { log: memoryLogger().log, scrypt: { N: 1024 }, templateDirs: [FIXTURE_TEMPLATES], connectors: { defs: [twitch.def, youtube.def] } });
  defer(t, () => platform.stop());
  await platform.auth.createOwner({ code: platform.auth.setupCode, ...OWNER }, { ip: '127.0.0.1' });
  const api = async (method, p, body, headers = {}) => {
    const res = await fetch(`${platform.url}/api/v1${p}`, { method, headers: signedIn(platform, { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }), body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null), etag: res.headers.get('etag') };
  };

  // Two connections, one per stream; each show's overlays bound to its own.
  const a = platform.connectors.create({ connector: 'fake', name: 'Main feed', config: { behaviour: 'push' } });
  const b = platform.connectors.create({ connector: 'fake-yt', name: 'Second feed', config: { behaviour: 'push' } });
  await until(() => twitch.live.length === 1 && youtube.live.length === 1, 5000, 'the connections running');
  const ctxA = twitch.live[0].ctx;
  const ctxB = youtube.live[0].ctx;
  ctxA.setHealth({ status: 'connected' });
  ctxB.setHealth({ status: 'connected' });
  for (const [slug, connections] of [['main-h', [a.id]], ['main-v', [a.id]], ['second-h', [b.id]], ['solo', 'all']]) platform.overlays.create({ slug, template: TESTBED, settings: {}, connections });
  const main = platform.shows.create({ name: 'Main room', overlays: ['main-h', 'main-v'], ...SHOW }, { actor: 'test' });
  platform.shows.create({ name: 'Second room', overlays: ['second-h'], ...SHOW }, { actor: 'test' });
  ctxA.setState('stream.twitch.live', true);
  ctxA.setState('viewers.twitch', 214);
  ctxB.setState('stream.youtube.live', false);

  const browser = await launchBrowser(t);
  const page = await browser.open(`${platform.url}/#/login`, { width: 1280, height: 900 });
  await page.waitFor('document.querySelector("input[name=username]")', 15000);
  assert.equal(await page.eval(`fetch('/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(${JSON.stringify(OWNER)}) }).then((r) => r.status)`), 200);
  const before = page.problems.length; // the sign-in page's own 401 for "who am I" is expected

  // ---- the streams page: each stream as its own connection says, running ones first --------------
  await page.goto(`${platform.url}/?signed=1#/live`);
  await page.waitFor('document.querySelectorAll("[data-view] .stream-card").length === 3', 15000);
  // solo is fed by every connection: on air too, so before the offline one.
  assert.deepEqual(await page.eval('[...document.querySelectorAll("[data-view] .stream-card h2")].map((x) => x.textContent)'), ['Main room', 'solo', 'Second room'], 'on air first');
  const mainCard = await cardText(page, 'Main room');
  assert.match(mainCard, /On air/);
  assert.match(mainCard, /214 viewers/);
  assert.match(mainCard, /Twitch · live · 214/);
  assert.match(mainCard, /Main feed: Connected/);
  assert.doesNotMatch(mainCard, /Second feed/);
  const second = await cardText(page, 'Second room');
  assert.match(second, /Offline/);
  assert.match(second, /YouTube · offline/);
  assert.doesNotMatch(second, /viewer/, 'no count is no count, not 0');
  assert.match(await cardText(page, 'solo'), /Overlay outside a show[\s\S]*On air[\s\S]*Main feed: Connected[\s\S]*Second feed: Connected/);
  // The badge says it in words, not colour alone.
  assert.deepEqual(await page.eval('[...document.querySelectorAll("[data-view] .stream-card .badge")].map((b) => b.textContent)'), ['On air', 'On air', 'Offline']);

  // The second stream goes live: its card follows (polled, or at once on a connection's change).
  ctxB.setState('stream.youtube.live', true);
  ctxB.setState('viewers.youtube', 30);
  await page.waitFor(`/On air[\\s\\S]*30 viewers/.test([...document.querySelectorAll('[data-view] .stream-card')].find((c) => c.querySelector('h2').textContent === 'Second room').innerText)`, 8000);

  // ---- Open: the show's console, with its status ---------------------------------------------------
  await click(page, '[data-view] .stream-card a', 'Open Main room');
  await page.waitFor(`location.hash === ${JSON.stringify(`#/live?show=${main.id}`)} && document.querySelector("[data-view] h1")?.textContent === "Main room" && !document.querySelector("[data-view] > .loading")`, 15000);
  await page.waitFor('document.querySelector("[data-view] .stream-status")?.innerText.includes("On air")', 8000);
  assert.match(await page.eval('document.querySelector("[data-view] .crumbs").innerText'), /All streams/);

  // The overlay selector: one member's panel, with its actions and Simulate, kept in the address.
  await page.waitFor('[...document.querySelectorAll("[data-view] button[aria-pressed]")].some((b) => b.getAttribute("aria-label") === "Overlay main-v")', 8000);
  await click(page, '[data-view] button', 'Overlay main-v');
  await page.waitFor('document.querySelector("[data-view] [role=group][aria-label=\'Actions of main-v\']")', 10000);
  assert.equal(await page.eval('location.hash'), `#/live?show=${main.id}&overlay=main-v`);
  const panel = await page.eval('document.querySelector("[data-view]").innerText');
  assert.match(panel, /Title card/);
  assert.match(panel, /Scenes belong to the show/);
  assert.match(panel, /Landscape · 1920 × 1080/);
  assert.equal(await page.eval('document.querySelectorAll("[data-view] .preview").length'), 1, 'one preview: the overlay\'s');
  assert.deepEqual(await page.eval('[...document.querySelectorAll("[data-view] [role=group][aria-label=\'Simulate on main-v\'] button")].map((b) => b.textContent)').then((x) => x.slice(0, 3)), ['Chat message', 'Follow', 'Subscription']);
  await click(page, '[data-view] [role=group][aria-label="Actions of main-v"] button', 'Title card');
  await toastSeen(page, '/main-v: Title card on air/');
  await click(page, '[data-view] [role=group][aria-label="Simulate on main-v"] button', 'Follow');
  await toastSeen(page, /Follow sent|doesn't show follows/);
  // A reload keeps the overlay chosen.
  await page.goto(`${platform.url}/?reload=1#/live?show=${main.id}&overlay=main-v`);
  await page.waitFor('document.querySelector("[data-view] [role=group][aria-label=\'Actions of main-v\']")', 15000);
  assert.equal(await page.eval('[...document.querySelectorAll("[data-view] button[aria-pressed=true]")].map((b) => b.textContent).join()'), 'main-v');
  // Back to the whole show: its scenes and previews again.
  await click(page, '[data-view] button', 'Whole show');
  await page.waitFor('document.querySelector("#live-previews") && !document.querySelector("[data-view] [role=group][aria-label=\'Actions of main-v\']")', 8000);
  assert.equal(await page.eval('location.hash'), `#/live?show=${main.id}`);

  // ---- an overlay outside a show, on its own ----------------------------------------------------
  await page.eval('location.hash = "#/live?overlay=solo"');
  await page.waitFor('document.querySelector("[data-view] h1")?.textContent === "solo" && document.querySelector("[data-view] [role=group][aria-label=\'Scenes of solo\']")', 15000);
  const solo = await page.eval('document.querySelector("[data-view]").innerText');
  assert.match(solo, /On air/);
  assert.match(solo, /Title card/);
  assert.match(solo, /Every connection, including new ones/);
  await click(page, '[data-view] [role=group][aria-label="Scenes of solo"] button', 'Be Right Back');
  await toastSeen(page, '/solo: scene changed to Be Right Back/');
  // A member asked for alone opens in its show's console.
  await page.eval('location.hash = "#/live?overlay=second-h"');
  await page.waitFor('document.querySelector("[data-view] h1")?.textContent === "Second room" && location.hash.endsWith("&overlay=second-h")', 15000);

  // ---- Fed by on the overlay's page: saved with If-Match; a 412 says it changed -------------------
  await page.send('Network.enable');
  const patches = [];
  const offNet = browser.cdp.on((m) => {
    if (m.method === 'Network.requestWillBeSent' && m.params.request.method === 'PATCH') patches.push({ url: m.params.request.url, ifMatch: m.params.request.headers['If-Match'] || m.params.request.headers['if-match'], body: m.params.request.postData });
  });
  t.after(offNet);
  const openFedBy = async () => {
    await page.eval('location.hash = "#/overlays/solo?tab=settings"');
    await page.waitFor('document.querySelector("#fed-by fieldset") && !document.querySelector("[data-view] > .loading")', 15000);
  };
  const chooseOnly = (name) => page.eval(`(() => {
    const box = document.querySelector('#fed-by');
    const only = [...box.querySelectorAll('label')].find((l) => l.textContent === 'Only these');
    document.getElementById(only.htmlFor).click();
    const l = [...box.querySelectorAll('label')].find((x) => x.textContent.startsWith(${JSON.stringify(name)}));
    document.getElementById(l.htmlFor).click();
  })()`);
  await page.eval('location.hash = "#/overlays"');
  await page.waitFor('document.querySelector("[data-view] h1")?.textContent === "Overlays"', 15000);
  await openFedBy();
  // Changed elsewhere meanwhile: the save is refused (412), said so, and the page shows it as it is.
  const now = await api('GET', '/overlays/solo');
  assert.equal((await api('PATCH', '/overlays/solo', { settings: { size: 4 } }, { 'if-match': now.etag })).status, 200);
  await chooseOnly('Second feed');
  await click(page, '#fed-by button', 'Save connections');
  await toastSeen(page, '/changed since you opened it/');
  assert.equal((await api('GET', '/overlays/solo')).body.connections, 'all', 'nothing saved over the other change');
  assert.equal(patches.at(-1).ifMatch, now.etag);
  // Again, on the page as it is now: saved.
  await page.waitFor('document.querySelector("#fed-by fieldset")', 8000);
  await sleep(200);
  await chooseOnly('Second feed');
  await click(page, '#fed-by button', 'Save connections');
  await toastSeen(page, '/"solo" is fed by Second feed now/');
  const saved = await api('GET', '/overlays/solo');
  assert.deepEqual(saved.body.connections, [b.id]);
  assert.match(patches.at(-1).ifMatch, /^"ovl_[0-9A-Z]+-r\d+"$/);
  assert.deepEqual(JSON.parse(patches.at(-1).body), { connections: [b.id] });
  await page.waitFor('document.querySelector("#fed-by").innerText.includes("Now: Only Second feed")', 8000);
  // Its stream now follows the second feed only.
  assert.deepEqual(saved.body.stream.connections.map((c) => c.name), ['Second feed']);

  // ---- Fed by for a whole show: every member at once, each with its own If-Match ------------------
  await page.eval(`location.hash = ${JSON.stringify(`#/shows/${main.id}?tab=details`)}`);
  await page.waitFor('[...document.querySelectorAll("[data-view] button")].some((b) => b.textContent === "Apply to every overlay")', 15000);
  assert.match(await page.eval('document.querySelector("[data-view]").innerText'), /Every overlay in the show: Only Main feed/);
  const count = patches.length;
  await page.eval(`(() => {
    const card = [...document.querySelectorAll('[data-view] section.card')].find((c) => c.querySelector('h2')?.textContent === 'Fed by');
    const all = [...card.querySelectorAll('label')].find((l) => l.textContent === 'All connections, including new ones');
    document.getElementById(all.htmlFor).click();
  })()`);
  await click(page, '[data-view] button', 'Apply to every overlay');
  await toastSeen(page, '/Every overlay in "Main room" is fed by every connection now/');
  assert.deepEqual(patches.slice(count).map((p) => [new URL(p.url).pathname.split('/').at(-1), /^"ovl_/.test(p.ifMatch)]).sort(), [[platform.overlays.resolve('main-h').doc.id, true], [platform.overlays.resolve('main-v').doc.id, true]].sort());
  for (const slug of ['main-h', 'main-v']) assert.equal((await api('GET', `/overlays/${slug}`)).body.connections, 'all', slug);
  assert.deepEqual(page.problems.slice(before).filter((p) => !p.startsWith('network:')), []);
});

test('the streams page on a phone: one column, no sideways scrolling; nothing to stream yet says what to do', { skip: browserSkip, timeout: 120000 }, async (t) => {
  const root = tempDir(t);
  const config = loadConfig({ argv: ['--port', '0'], env: { SKP_DATA_DIR: path.join(root, 'data'), SKP_CONFIG_DIR: path.join(root, 'config') } });
  const platform = await startPlatform(config, { log: memoryLogger().log, scrypt: { N: 1024 }, templateDirs: [FIXTURE_TEMPLATES] });
  defer(t, () => platform.stop());
  await platform.auth.createOwner({ code: platform.auth.setupCode, ...OWNER }, { ip: '127.0.0.1' });
  const browser = await launchBrowser(t);
  const page = await browser.open(`${platform.url}/#/login`, { width: 390, height: 844 });
  await page.waitFor('document.querySelector("input[name=username]")', 15000);
  assert.equal(await page.eval(`fetch('/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(${JSON.stringify(OWNER)}) }).then((r) => r.status)`), 200);
  const before = page.problems.length;
  await page.goto(`${platform.url}/?signed=1#/live`);
  await page.waitFor('document.querySelector("[data-view] .empty")', 15000);
  assert.match(await page.eval('document.querySelector("[data-view]").innerText'), /Nothing to go live with yet[\s\S]*Go to Templates[\s\S]*Go to Shows/);
  // One overlay: a card, a finger-sized Open, nothing sideways; the stream is Unknown (nothing feeds it).
  platform.overlays.create({ slug: 'alone', template: TESTBED, settings: {} });
  await page.waitFor('document.querySelector("[data-view] .stream-card")', 8000);
  const state = await page.eval('({ sideways: document.documentElement.scrollWidth > innerWidth + 1, open: document.querySelector("[data-view] .stream-card a.btn").getBoundingClientRect().height, text: document.querySelector("[data-view] .stream-card").innerText })');
  assert.equal(state.sideways, false);
  assert.ok(state.open >= 44, `Open is ${state.open} px tall`);
  assert.match(state.text, /Unknown[\s\S]*No connection feeds it/);
  assert.deepEqual(page.problems.slice(before), []);
});
