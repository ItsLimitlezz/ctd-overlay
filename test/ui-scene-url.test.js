// A URL for one scene, in a real browser (04 §4.9, 08 §8.3): the overlay page's Add to OBS offers,
// for a scene picked, the URL at each canvas with ?scene= (its key kept), never a scene that returns
// by itself; that URL shows the scene whatever the show takes, and is no preview.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { startPlatform } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { browserSkip, launchBrowser } from './cdp.js';
import { defer, FIXTURE_TEMPLATES, memoryLogger, signedIn, tempDir, TESTBED } from './helpers.js';

const OWNER = { username: 'juan', password: 'correct horse battery staple' };
const opts = { skip: browserSkip, timeout: 120000 };

test('Add to OBS gives a URL for one scene at each canvas, and that URL stays on the scene', opts, async (t) => {
  const root = tempDir(t);
  const config = loadConfig({ argv: ['--port', '0'], env: { SKP_DATA_DIR: path.join(root, 'data'), SKP_CONFIG_DIR: path.join(root, 'config') } });
  const platform = await startPlatform(config, { log: memoryLogger().log, scrypt: { N: 1024 }, templateDirs: [FIXTURE_TEMPLATES] });
  defer(t, () => platform.stop());
  await platform.auth.createOwner({ code: platform.auth.setupCode, ...OWNER }, { ip: '127.0.0.1' });
  const overlay = platform.overlays.create({ slug: 'bed', template: TESTBED, settings: {} });
  const res = await fetch(`${platform.url}/api/v1/overlays/bed/url`, { headers: signedIn(platform) });
  const { urls } = await res.json();
  const pinned = (url, scene) => { const u = new URL(url); u.searchParams.set('scene', scene); return u.href; };

  const browser = await launchBrowser(t);
  const page = await browser.open(`${platform.url}/#/login`, { width: 1280, height: 900 });
  await page.waitFor('document.querySelector("input[name=username]")', 15000);
  assert.equal(await page.eval(`fetch('/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(${JSON.stringify(OWNER)}) }).then((r) => r.status)`), 200);
  await page.goto(`${platform.url}/?signed=1#/overlays/bed`);
  await page.waitFor('document.querySelector("details.scene-urls select")', 15000);

  const read = () => page.eval(`(() => {
    const box = document.querySelector('details.scene-urls');
    return {
      scenes: [...box.querySelectorAll('select option')].map((o) => o.value),
      urls: [...box.querySelectorAll('.copy-field input')].map((i) => i.value),
      labels: [...box.querySelectorAll('.copy-field input')].map((i) => i.getAttribute('aria-label')),
    };
  })()`);
  let seen = await read();
  // Every scene but Headliner (1 s, then Live): pinned, it would never return.
  assert.deepEqual(seen.scenes, ['starting', 'program', 'brb', 'lineup', 'outro', 'opener']);
  assert.deepEqual(seen.urls, urls.map((u) => pinned(u.url, 'starting')));
  assert.match(seen.urls[1], /[?&]canvas=v/);
  if (/[?&]key=/.test(urls[0].url)) assert.match(seen.urls[0], /[?&]key=/);

  await page.eval(`(() => { const s = document.querySelector('details.scene-urls select'); s.value = 'brb'; s.dispatchEvent(new Event('change')); })()`);
  seen = await read();
  assert.deepEqual(seen.urls, urls.map((u) => pinned(u.url, 'brb')));
  assert.match(seen.labels[0], /URL for Be Right Back$/);

  // The URL OBS gets: on BRB whatever the overlay takes, live, and no preview.
  const source = await browser.open(seen.urls[0], { width: 1920, height: 1080 });
  defer(t, () => source.close().catch(() => {}));
  await source.waitFor('window.SK && SK.scene === "brb"', 10000);
  assert.equal(await source.eval('SK.env.preview'), false);
  const take = await fetch(`${platform.url}/api/v1/overlays/${overlay.id}/scene`, { method: 'PUT', headers: signedIn(platform, { 'content-type': 'application/json' }), body: JSON.stringify({ scene: 'outro' }) });
  assert.equal(take.status, 200);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(await source.eval('SK.scene'), 'brb');
});
