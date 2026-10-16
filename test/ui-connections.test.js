// The Connections page in a real browser (08 §8.7): setting up CTD Multi-Stream with Connect (the
// address only, the code to approve until CTD Multi-Stream says yes, then connected and following
// its profile), or from its form (the token in a password field never shown again, the profile to
// pick), and a device sign-in showing its code until the service says yes; a connection that
// follows every profile lists each on its card, and an overlay's "Fed by" offers each profile.
// Against pretend services on 127.0.0.1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { startPlatform } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { BUILTIN } from '../src/connectors/registry.js';
import { browserSkip, launchBrowser } from './cdp.js';
import { until } from './connector-helpers.js';
import { fakeConnector } from './fixtures/connectors/fake.js';
import { startFakeMultistream } from './fixtures/fake-multistream.mjs';
import { startFakeService } from './fixtures/fake-service.mjs';
import { defer, FIXTURE_TEMPLATES, memoryLogger, signedIn, tempDir, TESTBED } from './helpers.js';

const OWNER = { username: 'juan', password: 'correct horse battery staple' };

// Sets a labelled field's value as typing would (the first one with that label, inside root).
const fill = (label, value, root = 'body') => `(() => {
  const l = [...document.querySelector(${JSON.stringify(root)}).querySelectorAll('label')].find((x) => x.textContent.trim() === ${JSON.stringify(label)});
  const input = document.getElementById(l.htmlFor);
  input.value = ${JSON.stringify(value)};
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return input.type;
})()`;

const click = (text) => `[...document.querySelectorAll("button")].find((b) => b.textContent.trim() === ${JSON.stringify(text)}).click()`;
const viewText = 'document.querySelector("[data-view]").innerText';
// A checkbox or radio by the start of its label's words, inside root: { checked, disabled }, or clicked.
const box = (start, root = '#fed-by') => `[...document.querySelector(${JSON.stringify(root)}).querySelectorAll('label')].map((l) => document.getElementById(l.htmlFor)).find((i) => i && document.querySelector('label[for="' + i.id + '"]').textContent.startsWith(${JSON.stringify(start)}))`;
const boxState = (start) => `(() => { const i = ${box(start)}; return i ? [i.checked, i.disabled] : null; })()`;

test('Connect to CTD Multi-Stream: the code until it is approved there, then connected, named after its profile and following it', { skip: browserSkip, timeout: 120000 }, async (t) => {
  const ms = await startFakeMultistream();
  defer(t, () => ms.close());
  const root = tempDir(t);
  const config = loadConfig({ argv: ['--port', '0'], env: { SKP_DATA_DIR: path.join(root, 'data'), SKP_CONFIG_DIR: path.join(root, 'config') } });
  const platform = await startPlatform(config, { log: memoryLogger().log, scrypt: { N: 1024 } });
  defer(t, () => platform.stop());
  await platform.auth.createOwner({ code: platform.auth.setupCode, ...OWNER }, { ip: '127.0.0.1' });
  const browser = await launchBrowser(t);
  const page = await browser.open(`${platform.url}/#/login`, { width: 390, height: 844 });
  await page.waitFor('document.querySelector("input[name=username]")', 15000);
  assert.equal(await page.eval(`fetch('/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(${JSON.stringify(OWNER)}) }).then((r) => r.status)`), 200);
  const before = page.problems.length;
  await page.goto(`${platform.url}/?signed=1#/connections/new/ctd-multistream`);
  await page.waitFor('[...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "Connect")', 15000);
  const setup = await page.eval(viewText);
  assert.match(setup, /pick the profile/);
  assert.match(setup, /Paste a token instead/);
  assert.equal(await page.eval(fill('API address', `${ms.url}/api/v1`)), 'url');
  await page.eval(click('Connect'));
  // The code, big, with its countdown and where to approve it.
  await page.waitFor('location.hash.startsWith("#/connections/con_") && document.querySelector(".device-code") && /\\d+:\\d\\d/.test(document.querySelector(".countdown")?.textContent || "")', 15000);
  const p = ms.pairings.at(-1);
  assert.equal(await page.eval('document.querySelector(".device-code").textContent'), p.code);
  assert.match(await page.eval(viewText), /Approve this code in CTD Multi-Stream → Settings → API, and pick the profile/);
  assert.match(await page.eval('[...document.querySelectorAll("a")].find((a) => /Settings → API/.test(a.textContent))?.href'), new RegExp(`/settings\\?tab=api&pair=${p.id}$`));
  assert.equal(await page.eval(`document.documentElement.outerHTML.includes(${JSON.stringify(p.secret)})`), false, 'the poll secret never reaches the page');
  // Approved there for DPRTMNT: connected, named after it, its status shown.
  const token = ms.approve({ profileId: 'p-dprtmnt' });
  await page.waitFor('/Follows the profile DPRTMNT/.test(document.querySelector("[data-view]").innerText) && /DPRTMNT · Offline/.test(document.querySelector("[data-view]").innerText)', 20000);
  await page.waitFor('document.querySelector("h1")?.textContent.includes("Multi-Stream · DPRTMNT")', 10000);
  assert.match(await page.eval(viewText), /Shared with the OBS plugin|Not shared with the OBS plugin/);
  assert.equal(await page.eval(`document.documentElement.outerHTML.includes(${JSON.stringify(token)})`), false, 'the token never reaches the page');
  ms.setProfileStatus('p-dprtmnt', 'live');
  await page.waitFor('/DPRTMNT · Live/.test(document.querySelector("[data-view]").innerText)', 20000);
  assert.equal(await page.eval('document.documentElement.scrollWidth > innerWidth + 1'), false, 'no sideways scrolling on a phone');
  assert.deepEqual(page.problems.slice(before), []);
});

test('set up CTD Multi-Stream with a pasted token until it runs, its profile to pick; a device sign-in shows its code until approved', { skip: browserSkip, timeout: 120000 }, async (t) => {
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
  await page.waitFor('document.querySelector("details") && [...document.querySelectorAll("details label")].some((l) => l.textContent.trim() === "API token")', 15000);
  assert.match(await page.eval('document.querySelector("[data-view]").innerText'), /Settings → API/);
  await page.eval('document.querySelector("details").open = true');
  assert.equal(await page.eval(fill('API address', `${ms.url}/api/v1`, 'details')), 'text');
  assert.equal(await page.eval(fill('API token', ms.token, 'details')), 'password', 'a secret is a password field');
  await page.eval('document.querySelector("details form").requestSubmit()');
  await page.waitFor('location.hash.startsWith("#/connections/con_") && /Partly working/.test(document.querySelector("[data-view]").innerText)', 15000);
  const text = await page.eval('document.querySelector("[data-view]").innerText');
  assert.match(text, /Instagram \(Miami or Bust\): ended the live/);
  assert.match(text, /What it feeds now\s+Miami or Bust[\s\S]*Twitch viewers\s+214[\s\S]*DPRTMNT\s+Kick live\s+No/, 'its values, profile by profile');
  assert.equal(await page.eval(`document.documentElement.outerHTML.includes(${JSON.stringify(ms.token)}) || [...document.querySelectorAll('input')].some((i) => i.value === ${JSON.stringify(ms.token)})`), false, 'the token never comes back');
  // The token reads every profile: it follows every one, unless one is picked in its settings.
  await page.waitFor('[...document.querySelectorAll("select")].some((s) => [...s.options].map((o) => o.textContent).join() === "Default: Every profile,Every profile,Miami or Bust,DPRTMNT")', 15000);
  assert.match(await page.eval(viewText), /Follows every profile: Miami or Bust, DPRTMNT\./);
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

test('a connection that follows every profile: its card lists each profile with its status; "Fed by" offers each profile, and saves "<connection>/<profile>" with If-Match', { skip: browserSkip, timeout: 120000 }, async (t) => {
  const ms = await startFakeMultistream();
  defer(t, () => ms.close());
  const root = tempDir(t);
  const config = loadConfig({ argv: ['--port', '0'], env: { SKP_DATA_DIR: path.join(root, 'data'), SKP_CONFIG_DIR: path.join(root, 'config') } });
  const platform = await startPlatform(config, { log: memoryLogger().log, scrypt: { N: 1024 }, templateDirs: [FIXTURE_TEMPLATES] });
  defer(t, () => platform.stop());
  await platform.auth.createOwner({ code: platform.auth.setupCode, ...OWNER }, { ip: '127.0.0.1' });
  const conn = platform.connectors.create({ connector: 'ctd-multistream', config: { baseUrl: `${ms.url}/api/v1` }, secrets: { token: ms.addToken({ profileId: null }) } });
  await until(() => platform.connectors.get(conn.id).info?.profiles?.length === 2 && ['connected', 'degraded'].includes(platform.connectors.get(conn.id).health.status), 8000, 'following every profile');
  platform.overlays.create({ slug: 'tk', template: TESTBED, settings: {}, connections: [conn.id] });

  const browser = await launchBrowser(t);
  const page = await browser.open(`${platform.url}/#/login`, { width: 390, height: 844 });
  await page.waitFor('document.querySelector("input[name=username]")', 15000);
  assert.equal(await page.eval(`fetch('/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(${JSON.stringify(OWNER)}) }).then((r) => r.status)`), 200);
  const before = page.problems.length;
  // The card: every profile it follows, each with its status.
  await page.goto(`${platform.url}/?signed=1#/connections`);
  await page.waitFor('/Miami or Bust · Live/.test(document.querySelector("[data-view]").innerText) && /DPRTMNT · Offline/.test(document.querySelector("[data-view]").innerText)', 15000);
  assert.match(await page.eval(viewText), /Follows every CTD Multi-Stream profile \(2\), each a stream of its own/);
  ms.setProfileStatus('p-dprtmnt', 'live');
  await page.waitFor('/DPRTMNT · Live/.test(document.querySelector("[data-view]").innerText)', 20000);
  assert.equal(await page.eval('document.documentElement.scrollWidth > innerWidth + 1'), false, 'no sideways scrolling on a phone');

  // Fed by: the whole connection ticked, its profiles shown as included.
  await page.send('Network.enable');
  const patches = [];
  const off = browser.cdp.on((m) => {
    if (m.method === 'Network.requestWillBeSent' && m.params.request.method === 'PATCH') patches.push({ ifMatch: m.params.request.headers['If-Match'] || m.params.request.headers['if-match'], body: m.params.request.postData });
  });
  t.after(off);
  await page.eval('location.hash = "#/overlays/tk?tab=settings"');
  await page.waitFor('document.querySelector("#fed-by fieldset") && !document.querySelector("[data-view] > .loading")', 15000);
  assert.deepEqual(await page.eval(boxState('All its profiles, including new ones')), [true, false]);
  assert.deepEqual(await page.eval(boxState('Multi-Stream · DPRTMNT')), [true, true], 'included, so ticked and not changeable');
  assert.deepEqual(await page.eval(boxState('Multi-Stream · Miami or Bust')), [true, true]);
  assert.match(await page.eval('document.querySelector("#fed-by").innerText'), /Multi-Stream · DPRTMNT \(Live\)\s*— included/);
  // Only DPRTMNT: untick the whole connection, tick DPRTMNT.
  await page.eval(`(${box('All its profiles, including new ones')}).click()`);
  assert.deepEqual(await page.eval(boxState('Multi-Stream · DPRTMNT')), [false, false]);
  await page.eval(`(${box('Multi-Stream · DPRTMNT')}).click()`);
  const etag = (await (await fetch(`${platform.url}/api/v1/overlays/tk`, { headers: signedIn(platform) })).headers.get('etag'));
  await page.eval('[...document.querySelectorAll("#fed-by button")].find((b) => b.textContent.trim() === "Save connections").click()');
  await page.waitFor('[...document.querySelectorAll(".toast span")].some((s) => /"tk" is fed by Multi-Stream · DPRTMNT now/.test(s.textContent))', 8000);
  assert.deepEqual(platform.overlays.resolve('tk').doc.data.connections, [`${conn.id}/p-dprtmnt`]);
  assert.deepEqual(JSON.parse(patches.at(-1).body), { connections: [`${conn.id}/p-dprtmnt`] });
  assert.equal(patches.at(-1).ifMatch, etag);
  await page.waitFor('document.querySelector("#fed-by").innerText.includes("Now: Only Multi-Stream · DPRTMNT.")', 8000);
  assert.deepEqual(await page.eval(boxState('Multi-Stream · DPRTMNT')), [true, false]);
  assert.deepEqual(await page.eval(boxState('Multi-Stream · Miami or Bust')), [false, false]);
  assert.deepEqual(page.problems.slice(before).filter((p) => !p.startsWith('network:')), []);
});
