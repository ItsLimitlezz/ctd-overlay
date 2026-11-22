// Where the admin UI shows the addresses the OBS plugin can add overlays at (app.js shareBase):
// Settings → Security lists the local network one (SKP_HOSTS) and the public one (SKP_PUBLIC_URL)
// with which is the default for apps, and a CTD Relay connection's card says what it shares at.
// Against a pretend CTD Relay on 127.0.0.1, in a real browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { startPlatform } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { browserSkip, launchBrowser } from './cdp.js';
import { until } from './connector-helpers.js';
import { startFakeMultistream } from './fixtures/fake-multistream.mjs';
import { defer, FIXTURE_TEMPLATES, memoryLogger, signedIn, tempDir } from './helpers.js';

const OWNER = { username: 'juan', password: 'correct horse battery staple' };
const LAN = 'http://192.168.1.50:4850';
const PUBLIC = 'https://overlays.example.com';
const viewText = 'document.querySelector("[data-view]").innerText';

async function open(t, env) {
  const ms = await startFakeMultistream();
  defer(t, () => ms.close());
  const root = tempDir(t);
  const config = loadConfig({ argv: ['--port', '0'], env: { SKP_DATA_DIR: path.join(root, 'data'), SKP_CONFIG_DIR: path.join(root, 'config'), SKP_HOST: '127.0.0.1', ...env } });
  const platform = await startPlatform(config, { log: memoryLogger().log, scrypt: { N: 1024 }, templateDirs: [FIXTURE_TEMPLATES] });
  defer(t, () => platform.stop());
  await platform.auth.createOwner({ code: platform.auth.setupCode, ...OWNER }, { ip: '127.0.0.1' });
  const browser = await launchBrowser(t);
  // The platform answers only to its own names: 127.0.0.1 is one of them in every mode.
  const page = await browser.open(`${platform.url}/#/login`, { width: 390, height: 844 });
  await page.waitFor('document.querySelector("input[name=username]")', 15000);
  assert.equal(await page.eval(`fetch('/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(${JSON.stringify(OWNER)}) }).then((r) => r.status)`), 200);
  return { ms, platform, page };
}

test('Settings → Security and the CTD Relay card show both addresses, and which one apps get by default', { skip: browserSkip, timeout: 120000 }, async (t) => {
  const { ms, platform, page } = await open(t, { SKP_EXPOSURE: 'lan', SKP_HOSTS: '192.168.1.50:4850', SKP_PUBLIC_URL: PUBLIC });
  await page.goto(`${platform.url}/?signed=1#/settings/security`);
  await page.waitFor('/Overlays on the internet/.test(document.querySelector("[data-view]")?.innerText || "")', 15000);
  const text = await page.eval(viewText);
  assert.match(text, new RegExp(`Overlays on your network\\s+${LAN.replace(/[.]/g, '\\.')}`));
  assert.match(text, new RegExp(`Overlays on the internet\\s+${PUBLIC.replace(/[.]/g, '\\.')}\\s+default for apps`));

  // A connection that shares its overlays with the OBS plugin through CTD Relay says where.
  platform.overlays.create({ slug: 'chat', template: { id: 'com.dprtmnt.chat', version: '1.0.0' }, settings: {}, connections: 'all' });
  const H = signedIn(platform, { 'content-type': 'application/json' });
  const made = await fetch(`${platform.url}/api/v1/connections`, { method: 'POST', headers: H, body: JSON.stringify({ connector: 'ctd-multistream', config: { baseUrl: `${ms.url}/api/v1` }, secrets: { token: ms.addToken({ profileId: 'p-dprtmnt' }) } }) });
  assert.equal(made.status, 201);
  const conn = await made.json();
  await until(() => platform.connectors.get(conn.id).info?.hub?.status === 'shared', 10000, 'shared');
  await page.eval(`location.hash = "#/connections/${conn.id}"`);
  await page.waitFor('/Shared with the OBS plugin/.test(document.querySelector("[data-view]")?.innerText || "")', 15000);
  const card = await page.eval(viewText);
  assert.ok(card.includes(`Local network: ${LAN}`), card);
  assert.ok(card.includes(`Public (internet): ${PUBLIC} (default for apps)`), card);
});

test('Settings → Security without a public address says how to set one', { skip: browserSkip, timeout: 120000 }, async (t) => {
  const { platform, page } = await open(t, { SKP_EXPOSURE: 'lan', SKP_HOSTS: '192.168.1.50:4850' });
  await page.goto(`${platform.url}/?signed=1#/settings/security`);
  await page.waitFor('/Overlays on the internet/.test(document.querySelector("[data-view]")?.innerText || "")', 15000);
  const text = await page.eval(viewText);
  assert.match(text, /Overlays on your network\s+http:\/\/192\.168\.1\.50:4850\s+default for apps/);
  assert.match(text, /Overlays on the internet\s+Not set: set SKP_PUBLIC_URL \(https:\/\/\)/);
});
