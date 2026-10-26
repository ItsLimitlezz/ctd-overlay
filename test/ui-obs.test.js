// Follow OBS in a real browser (PLAN step 18): a show fed by a CTD Relay profile whose OBS reports
// its scenes. The show's Details has a "Follow OBS" card listing the scenes OBS has shown (from the
// state, the one on now marked), maps them to the show's scenes and saves with If-Match; OBS then
// changes scene and the show follows. Live shows what OBS shows on the stream card and in the show's
// console ("OBS · landscape: … · Streaming"), and says the scene was set by OBS. An overlay outside
// a show has the same card on its Scenes tab; when the plugin sends a canvas's whole scene list, the
// card lists every scene in OBS's order. On a phone nothing scrolls sideways.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { startPlatform } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { browserSkip, launchBrowser } from './cdp.js';
import { until } from './connector-helpers.js';
import { startFakeMultistream } from './fixtures/fake-multistream.mjs';
import { defer, FIXTURE_TEMPLATES, memoryLogger, signedIn, tempDir, TESTBED } from './helpers.js';

const OWNER = { username: 'juan', password: 'correct horse battery staple' };
const SHOW = { date: '2026-10-17', timezone: 'America/Toronto' };
const toastSeen = (page, re) => page.waitFor(`[...document.querySelectorAll(".toast span")].some((s) => ${re}.test(s.textContent))`, 8000);
// Picks an option of the select labelled so (its aria-label, or its field's label).
const choose = (page, label, value) => page.eval(`(() => {
  const s = [...document.querySelectorAll('[data-view] select')].find((x) => x.getAttribute('aria-label') === ${JSON.stringify(label)} || document.querySelector('label[for="' + x.id + '"]')?.textContent === ${JSON.stringify(label)});
  if (!s) throw new Error('no select ' + ${JSON.stringify(label)});
  s.value = ${JSON.stringify(value)};
  s.dispatchEvent(new Event('change', { bubbles: true }));
})()`);
const tick = (page, label) => page.eval(`(() => {
  const l = [...document.querySelectorAll('[data-view] label')].find((x) => x.textContent === ${JSON.stringify(label)});
  if (!l) throw new Error('no box ' + ${JSON.stringify(label)});
  document.getElementById(l.htmlFor).click();
})()`);

test('Follow OBS: the card lists the scenes OBS has shown and saves a mapping; the show follows; Live shows OBS and says who set the scene', { skip: browserSkip, timeout: 180000 }, async (t) => {
  const ms = await startFakeMultistream();
  defer(t, () => ms.close());
  ms.obsScene({ canvas: 'landscape', scene: 'Live', sceneUuid: 'u-live', atMs: 1, emit: false });
  ms.obsScene({ canvas: 'vertical', scene: 'Main V', atMs: 1, emit: false });
  ms.obsOutput({ output: 'main', canvas: 'landscape', state: 'live', emit: false });
  const root = tempDir(t);
  const config = loadConfig({ argv: ['--port', '0'], env: { SKP_DATA_DIR: path.join(root, 'data'), SKP_CONFIG_DIR: path.join(root, 'config') } });
  const platform = await startPlatform(config, { log: memoryLogger().log, scrypt: { N: 1024 }, templateDirs: [FIXTURE_TEMPLATES], connectors: { random: () => 0.5 } });
  defer(t, () => platform.stop());
  await platform.auth.createOwner({ code: platform.auth.setupCode, ...OWNER }, { ip: '127.0.0.1' });
  const api = async (method, p, body, headers = {}) => {
    const res = await fetch(`${platform.url}/api/v1${p}`, { method, headers: signedIn(platform, { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }), body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null), etag: res.headers.get('etag') };
  };
  const token = ms.addToken({ profileId: null });
  const conn = (await api('POST', '/connections', { connector: 'ctd-multistream', config: { baseUrl: `${ms.url}/api/v1` }, secrets: { token } })).body;
  await until(() => ['connected', 'degraded'].includes(platform.connectors.get(conn.id).health.status) && platform.connectors.get(conn.id).info?.profiles?.length === 2 && platform.bus.entriesOf('obs.scene.landscape').length === 1, 8000, 'the connection and its OBS');
  const feed = `${conn.id}/default`;
  for (const slug of ['room-h', 'room-v']) platform.overlays.create({ slug, template: TESTBED, settings: {}, connections: [feed] });
  platform.overlays.create({ slug: 'solo', template: TESTBED, settings: {}, connections: [feed] });
  const show = platform.shows.create({ name: 'Miami', overlays: ['room-h', 'room-v'], ...SHOW }, { actor: 'test' });
  // OBS goes to BRB once: the card lists both scenes it has shown.
  ms.obsScene({ canvas: 'landscape', scene: 'BRB', sceneUuid: 'u-brb', previous: 'Live', atMs: 2 });
  await until(() => platform.bus.entriesOf('obs.scene.landscape')[0]?.value.scene === 'BRB', 5000, 'BRB');

  const browser = await launchBrowser(t);
  const page = await browser.open(`${platform.url}/#/login`, { width: 1280, height: 900 });
  await page.waitFor('document.querySelector("input[name=username]")', 15000);
  assert.equal(await page.eval(`fetch('/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(${JSON.stringify(OWNER)}) }).then((r) => r.status)`), 200);
  const before = page.problems.length;

  // ---- the show's Details: Follow OBS --------------------------------------------------------------
  await page.goto(`${platform.url}/?signed=1#/shows/${show.id}?tab=details`);
  await page.waitFor('document.querySelector("#follow-obs select[aria-label=\'Scene for the OBS scene Live\']")', 15000);
  const card = await page.eval('document.querySelector("#follow-obs").innerText');
  assert.match(card, /Following Relay · Miami or Bust: the landscape canvas shows "BRB" now/);
  assert.match(card, /BRB \(on now\)[\s\S]*Live/, 'the scenes OBS has shown, from the state, the one on now marked');
  assert.equal(await page.eval('document.querySelector("#follow-obs .btn.primary").disabled'), true, 'nothing to save yet');
  await tick(page, 'Follow OBS scenes');
  await choose(page, 'Scene for the OBS scene Live', 'program');
  await choose(page, 'Scene for the OBS scene BRB', 'brb');
  // A scene OBS hasn't shown yet, typed in.
  await page.eval(`(() => { const i = document.querySelector('#follow-obs input[type=text]'); i.value = 'Lineup Cam'; i.dispatchEvent(new Event('input')); })()`);
  await page.eval('[...document.querySelectorAll("#follow-obs button")].find((b) => b.textContent === "Add").click()');
  await choose(page, 'Scene for the OBS scene Lineup Cam', 'lineup');
  await page.eval('document.querySelector("#follow-obs .btn.primary").click()');
  await toastSeen(page, '/Following OBS: 3 scenes mapped on the landscape canvas/');
  const saved = (await api('GET', `/shows/${show.id}`)).body;
  assert.deepEqual(saved.followObs, { enabled: true, canvas: 'landscape', map: [
    { obsScene: 'BRB', obsSceneUuid: 'u-brb', scene: 'brb' },
    { obsScene: 'Live', obsSceneUuid: 'u-live', scene: 'program' },
    { obsScene: 'Lineup Cam', scene: 'lineup' },
  ] });

  // OBS changes scene: the show follows.
  ms.obsScene({ canvas: 'landscape', scene: 'Live', sceneUuid: 'u-live', previous: 'BRB', atMs: 3 });
  await until(() => platform.shows.get(show.id).scene === 'program', 5000, 'the show follows OBS');

  // ---- Live: the stream card and the console show OBS; the console says OBS set the scene ---------
  await page.eval('location.hash = "#/live"');
  await page.waitFor('[...document.querySelectorAll("[data-view] .stream-card")].some((c) => /OBS · landscape: Live · vertical: Main V · Streaming/.test(c.innerText))', 15000);
  await page.eval(`location.hash = ${JSON.stringify(`#/live?show=${show.id}`)}`);
  await page.waitFor('document.querySelector("[data-view] .stream-status")?.innerText.includes("OBS · landscape: Live")', 15000);
  await page.waitFor('/Program: Set by OBS \\(Live, landscape\\)/.test(document.querySelector("[data-view] .obs-note")?.textContent || "")', 8000);
  // The operator takes a scene: OBS's note goes.
  await page.eval('[...document.querySelectorAll("[data-view] [role=group][aria-label=Scenes] button")].find((b) => b.textContent === "Be Right Back").click()');
  await page.waitFor('document.querySelector("[data-view] .obs-note").hidden', 8000);

  // ---- an overlay outside a show: the card on its Scenes tab --------------------------------------
  await page.eval('location.hash = "#/overlays/solo?tab=scenes"');
  await page.waitFor('document.querySelector("#follow-obs select[aria-label=\'Scene for the OBS scene Live\']")', 15000);
  await tick(page, 'Follow OBS scenes');
  await choose(page, 'Canvas', 'vertical');
  await page.waitFor('document.querySelector("#follow-obs select[aria-label=\'Scene for the OBS scene Main V\']")', 5000);
  await choose(page, 'Scene for the OBS scene Main V', 'program');
  await page.eval('document.querySelector("#follow-obs .btn.primary").click()');
  await toastSeen(page, '/Following OBS: 1 scene mapped on the vertical canvas/');
  assert.deepEqual((await api('GET', '/overlays/solo')).body.followObs, { enabled: true, canvas: 'vertical', map: [{ obsScene: 'Main V', scene: 'program' }] });

  // A newer plugin sends the canvas's whole scene list: every scene is listed, in OBS's order,
  // including those OBS hasn't shown yet.
  ms.obsScene({ canvas: 'vertical', scene: 'Main V', scenes: [{ name: 'Intro V' }, { name: 'Main V' }, { name: 'BRB V' }], atMs: 4 });
  await until(() => platform.bus.entriesOf('obs.scenes.vertical')[0]?.value.length === 3, 5000, 'the vertical list');
  await page.goto(`${platform.url}/?signed=2#/overlays/solo?tab=scenes`);
  await page.waitFor('document.querySelector("#follow-obs select[aria-label=\'Scene for the OBS scene Intro V\']")', 15000);
  assert.match(await page.eval('document.querySelector("#follow-obs").innerText'), /Every scene in Relay · Miami or Bust's OBS on this canvas[\s\S]*Intro V[\s\S]*Main V \(on now\)[\s\S]*BRB V/);

  // ---- a phone: the card in one column, nothing sideways -----------------------------------------
  await page.resize(390, 844);
  await page.eval(`location.hash = ${JSON.stringify(`#/shows/${show.id}?tab=details`)}`);
  await page.waitFor('document.querySelector("#follow-obs select[aria-label=\'Scene for the OBS scene Live\']")', 15000);
  assert.equal(await page.eval('document.documentElement.scrollWidth > innerWidth + 1'), false, 'no sideways scrolling');
  assert.deepEqual(page.problems.slice(before).filter((p) => !p.startsWith('network:')), []);
});
