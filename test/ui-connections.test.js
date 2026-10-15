// The Connections page in a real browser (08 §8.7): setting up CTD Multi-Stream from its form
// (the guide, the address, the token in a password field never shown again) until it is running,
// and a device sign-in showing its code until the service says yes. Against pretend services on
// 127.0.0.1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { startPlatform } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { BUILTIN } from '../src/connectors/registry.js';
import { browserSkip, launchBrowser } from './cdp.js';
import { fakeConnector } from './fixtures/connectors/fake.js';
import { startFakeMultistream } from './fixtures/fake-multistream.mjs';
import { startFakeService } from './fixtures/fake-service.mjs';
import { defer, memoryLogger, tempDir } from './helpers.js';

const OWNER = { username: 'juan', password: 'correct horse battery staple' };

// Sets a labelled field's value as typing would.
const fill = (label, value) => `(() => {
  const l = [...document.querySelectorAll('label')].find((x) => x.textContent.trim() === ${JSON.stringify(label)});
  const input = document.getElementById(l.htmlFor);
  input.value = ${JSON.stringify(value)};
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return input.type;
})()`;

test('set up CTD Multi-Stream from the page until it runs; a device sign-in shows its code until approved', { skip: browserSkip, timeout: 120000 }, async (t) => {
  const ms = await startFakeMultistream();
  defer(t, () => ms.close());
  const svc = await startFakeService();
  defer(t, () => svc.close());
  svc.script.device = ['pending', 'ok'];
  const root = tempDir(t);
  const config = loadConfig({ argv: ['--port', '0'], env: { SKP_DATA_DIR: path.join(root, 'data'), SKP_CONFIG_DIR: path.join(root, 'config') } });
  const platform = await startPlatform(config, { log: memoryLogger().log, scrypt: { N: 1024 }, connectors: { defs: [...BUILTIN, fakeConnector({ name: 'Test service', auth: 'device-code' }).def], endpoints: { fake: svc.endpoints } } });
  defer(t, () => platform.stop());
  await platform.auth.createOwner({ code: platform.auth.setupCode, ...OWNER }, { ip: '127.0.0.1' });

  const browser = await launchBrowser(t);
  const page = await browser.open(`${platform.url}/#/login`, { width: 1280, height: 900 });
  await page.waitFor('document.querySelector("input[name=username]")', 15000);
  assert.equal(await page.eval(`fetch('/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(${JSON.stringify(OWNER)}) }).then((r) => r.status)`), 200);
  const before = page.problems.length; // the sign-in page's own 401 for "who am I" is expected
  await page.goto(`${platform.url}/?signed=1#/connections/new/ctd-multistream`);
  await page.waitFor('document.querySelector("form") && [...document.querySelectorAll("label")].some((l) => l.textContent.trim() === "API token")', 15000);
  assert.match(await page.eval('document.querySelector("[data-view]").innerText'), /Settings → API/);
  assert.equal(await page.eval(fill('API address', `${ms.url}/api/v1`)), 'text');
  assert.equal(await page.eval(fill('API token', ms.token)), 'password', 'a secret is a password field');
  await page.eval('document.querySelector("[data-view] form").requestSubmit()');
  await page.waitFor('location.hash.startsWith("#/connections/con_") && /Partly working|Connected/.test(document.querySelector("[data-view]").innerText)', 15000);
  const text = await page.eval('document.querySelector("[data-view]").innerText');
  assert.match(text, /Instagram: ended the live/);
  assert.match(text, /Twitch viewers\s+214/);
  assert.equal(await page.eval(`document.documentElement.outerHTML.includes(${JSON.stringify(ms.token)}) || [...document.querySelectorAll('input')].some((i) => i.value === ${JSON.stringify(ms.token)})`), false, 'the token never comes back');
  assert.deepEqual(page.problems.slice(before), []);

  // A device sign-in: the code, big, with a countdown; then signed in.
  const c = platform.connectors.create({ connector: 'fake', name: 'Test service', config: { behaviour: 'push', clientId: 'client-1' } });
  await page.eval(`location.hash = '#/connections/${c.id}'`);
  await page.waitFor('[...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "Authorize")', 15000);
  await page.eval('[...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Authorize").click()');
  await page.waitFor('document.querySelector(".device-code")?.textContent === "WDJB-MJHT" && /\\d+:\\d\\d/.test(document.querySelector(".countdown")?.textContent || "")', 15000);
  await page.waitFor('/Signed in as DPRTMNT/.test(document.querySelector("[data-view]").innerText)', 20000);
  assert.deepEqual(page.problems.slice(before), []);
});
