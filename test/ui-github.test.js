// Connect GitHub in the admin UI, in a real browser (08, 04 §4.13): a private repository's install
// fails with a link to Settings → Integrations; a token saved there shows whose it is and never
// itself; then Templates → Install → Test lists the releases, and the one picked installs. GitHub
// is the fake on 127.0.0.1 (fixtures/fake-github.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { startPlatform } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { browserSkip, launchBrowser } from './cdp.js';
import { startFakeGithub } from './fixtures/fake-github.mjs';
import { defer, DIAG_DIR, memoryLogger, packTemplate, tempDir } from './helpers.js';

const PASSWORD = 'correct horse battery staple';
const REPO = 'ItsLimitlezz/miamiorbust-live';
const ID = 'com.itslimitlezz.miami-or-bust';
const TOKEN = 'github_pat_11AAAAAAA0123456789_abcdefghijklmnopqrstuvwxyzABCDEFGHIJ';
const opts = { skip: browserSkip, timeout: 180000 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const click = (page, selector, text) => page.eval(`(() => {
  const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((b) => b.textContent.trim() === ${JSON.stringify(text)} || b.getAttribute('aria-label') === ${JSON.stringify(text)});
  if (!el) throw new Error('nothing to click: ' + ${JSON.stringify(`${selector} ${text}`)});
  el.click();
})()`);
const type = (page, selector, value) => page.eval(`(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) throw new Error('no field ' + ${JSON.stringify(selector)});
  el.value = ${JSON.stringify(value)};
  el.dispatchEvent(new Event('input', { bubbles: true }));
})()`);
const text = (page, selector) => page.eval(`[...document.querySelectorAll(${JSON.stringify(selector)})].map((e) => e.textContent).join('\\n')`);

test('Settings → Integrations → GitHub: a private repository says to connect, a token saved there shows whose it is, and Templates → Install → Test → a release installs', opts, async (t) => {
  const gh = await startFakeGithub();
  defer(t, () => gh.close());
  gh.repo(REPO, { private: true });
  gh.release(REPO, 'overlay-v1.0.0', { assets: [{ name: 'miami-or-bust-1.0.0.zip', data: packTemplate(DIAG_DIR, { manifest: { id: ID, name: 'Miami or Bust', version: '1.0.0' } }) }] });
  gh.release(REPO, 'overlay-v1.1.0-rc.1', { prerelease: true, assets: [{ name: 'miami-or-bust-1.1.0-rc.1.zip', data: 'not yet' }] });
  gh.token(TOKEN, { login: 'ItsLimitlezz', repos: [REPO] });

  const root = tempDir(t);
  const config = loadConfig({ argv: ['--port', '0'], env: { SKP_DATA_DIR: path.join(root, 'data'), SKP_CONFIG_DIR: path.join(root, 'config') } });
  const platform = await startPlatform(config, { log: memoryLogger().log, scrypt: { N: 1024 }, fetch: gh.fetch, lookup: gh.lookup });
  defer(t, () => platform.stop());
  const made = await fetch(`${platform.url}/api/v1/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: platform.auth.setupCode, username: 'juan', password: PASSWORD }) });
  assert.equal(made.status, 201);

  const browser = await launchBrowser(t);
  const page = await browser.open(`${platform.url}/#/login`, { width: 1280, height: 900 });
  await page.waitFor('document.querySelector("input[name=username]")', 15000);
  await page.eval(`(() => {
    document.querySelector('input[name=username]').value = 'juan';
    document.querySelector('input[name=password]').value = ${JSON.stringify(PASSWORD)};
    document.querySelector('form').requestSubmit();
  })()`);
  await page.waitFor('location.hash.startsWith("#/live") && document.querySelector("[data-view] h1")', 15000);
  const go = async (route, ready = 'true') => {
    await page.eval(`location.hash = ${JSON.stringify(`#${route}`)}`);
    await page.waitFor(`!document.querySelector("[data-view] > .loading") && !document.querySelector("[data-view] p.loading") && document.querySelector("[data-view] h1") && (${ready})`, 15000);
  };
  const openInstall = async () => {
    await click(page, '[data-view] button', 'Install template');
    await page.waitFor('document.querySelector("dialog[open] [role=tab]")', 5000);
    await click(page, 'dialog[open] [role=tab]', 'From GitHub or a link');
    await type(page, 'dialog[open] input[name=url]', REPO);
    await click(page, 'dialog[open] button', 'Test');
  };

  // Not connected: Test says the repository is private, with a link to where to connect.
  await go('/templates');
  await openInstall();
  await page.waitFor('[...document.querySelectorAll("dialog[open] .notice.danger")].some((n) => /private or the GitHub token can.t read it/.test(n.textContent))', 10000);
  await click(page, 'dialog[open] a', 'Connect GitHub in Settings');
  await page.waitFor('location.hash === "#/settings/integrations" && !document.querySelector("dialog[open]") && document.querySelector("input[name=github-token]")', 10000);
  assert.match(await text(page, '[data-view] section.card'), /Not connected: public repositories only/);

  // The token: saved, checked by the server, never shown again.
  assert.equal(await page.eval('document.querySelector("input[name=github-token]").type'), 'password');
  await type(page, 'input[name=github-token]', TOKEN);
  await page.eval('document.querySelector("input[name=github-token]").form.requestSubmit()');
  await page.waitFor('[...document.querySelectorAll("[data-view] strong")].some((s) => s.textContent === "Connected as @ItsLimitlezz")', 10000);
  const html = await page.eval('document.documentElement.outerHTML + [...document.querySelectorAll("input")].map((i) => i.value).join(" ")');
  assert.ok(!html.includes(TOKEN) && !html.includes(TOKEN.slice(11)), 'the token is not on the page');
  assert.match(await text(page, '[data-view] section.card'), /Using the token saved here/);
  assert.equal(await page.eval('document.querySelector("input[name=github-token]")'), null, 'no token field once connected (Replace token opens one)');
  // Reloaded, it is still only whose.
  await page.goto(`${platform.url}/?r=1#/settings/integrations`);
  await page.waitFor('[...document.querySelectorAll("[data-view] strong")].some((s) => s.textContent === "Connected as @ItsLimitlezz")', 15000);
  assert.ok(!(await page.eval('document.documentElement.outerHTML')).includes(TOKEN.slice(11)));

  // Templates → Install → Test: the releases, the newest published one and its file chosen.
  await go('/templates');
  await openInstall();
  await page.waitFor('[...document.querySelectorAll("dialog[open] .notice.ok")].some((n) => n.textContent === "Can read ItsLimitlezz/miamiorbust-live (private) as @ItsLimitlezz.")', 10000);
  const releases = await page.eval('[...document.querySelectorAll("dialog[open] input[type=radio]")].map((r) => [r.value, r.checked])');
  assert.deepEqual(releases, [['overlay-v1.1.0-rc.1', false], ['overlay-v1.0.0', true], ['miami-or-bust-1.0.0.zip', true]]);
  assert.match(await text(page, 'dialog[open] fieldset'), /Pre-release/);
  await sleep(50);
  await click(page, 'dialog[open] button', 'Install');
  await page.waitFor(`location.hash === ${JSON.stringify(`#/templates/${ID}`)}`, 15000);
  const receipt = platform.templates.get(ID, '1.0.0')?.receipt?.source;
  assert.deepEqual([receipt?.repo, receipt?.tag, receipt?.asset], [REPO, 'overlay-v1.0.0', 'miami-or-bust-1.0.0.zip']);
  assert.ok(gh.to('objects.githubusercontent.com').length && gh.to('objects.githubusercontent.com').every((q) => !q.headers.authorization), 'the signed link gets no token');
  assert.deepEqual(page.problems.filter((p) => !p.startsWith('network:')), []);
});

test('installing a release with "Install its new releases" ticked lets the repository update a template first installed from a file', opts, async (t) => {
  const gh = await startFakeGithub();
  defer(t, () => gh.close());
  const zip = (version) => packTemplate(DIAG_DIR, { manifest: { id: ID, name: 'Miami or Bust', version } });
  gh.repo(REPO, { private: true });
  gh.release(REPO, 'overlay-v1.0.0', { assets: [{ name: 'miami-or-bust-1.0.0.zip', data: zip('1.0.0') }] });
  gh.token(TOKEN, { login: 'ItsLimitlezz', repos: [REPO] });
  const root = tempDir(t);
  const config = loadConfig({ argv: ['--port', '0'], env: { SKP_DATA_DIR: path.join(root, 'data'), SKP_CONFIG_DIR: path.join(root, 'config') } });
  const platform = await startPlatform(config, { log: memoryLogger().log, scrypt: { N: 1024 }, fetch: gh.fetch, lookup: gh.lookup });
  defer(t, () => platform.stop());
  const made = await fetch(`${platform.url}/api/v1/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: platform.auth.setupCode, username: 'juan', password: PASSWORD }) });
  assert.equal(made.status, 201);
  const browser = await launchBrowser(t);
  const page = await browser.open(`${platform.url}/#/login`, { width: 1280, height: 900 });
  await page.waitFor('document.querySelector("input[name=username]")', 15000);
  await page.eval(`(() => {
    document.querySelector('input[name=username]').value = 'juan';
    document.querySelector('input[name=password]').value = ${JSON.stringify(PASSWORD)};
    document.querySelector('form').requestSubmit();
  })()`);
  await page.waitFor('location.hash.startsWith("#/live") && document.querySelector("[data-view] h1")', 15000);
  // Signed in: the token saved and the template uploaded as a file, through the API as the page would.
  const call = (method, p, body, headers = {}) => page.eval(`(async () => {
    const s = await (await fetch('/api/v1/auth/session')).json();
    const r = await fetch(${JSON.stringify(p)}, { method: ${JSON.stringify(method)}, headers: { 'x-skp-csrf': s.csrf, ...${JSON.stringify(headers)} }, body: ${body} });
    return r.status;
  })()`);
  assert.equal(await call('PUT', '/api/v1/integrations/github/token', `JSON.stringify({ token: ${JSON.stringify(TOKEN)} })`, { 'content-type': 'application/json' }), 200);
  const b64 = zip('1.0.0').toString('base64');
  assert.equal(await call('POST', '/api/v1/templates', `Uint8Array.from(atob(${JSON.stringify(b64)}), (c) => c.charCodeAt(0))`, { 'content-type': 'application/octet-stream', 'x-skp-filename': 'miami-or-bust-1.0.0.zip' }), 201);

  // The same release from GitHub, following the repository.
  await page.eval('location.hash = "#/templates"');
  await page.waitFor('[...document.querySelectorAll("[data-view] button")].some((b) => b.textContent.trim() === "Install template")', 15000);
  await click(page, '[data-view] button', 'Install template');
  await page.waitFor('document.querySelector("dialog[open] [role=tab]")', 5000);
  await click(page, 'dialog[open] [role=tab]', 'From GitHub or a link');
  await type(page, 'dialog[open] input[name=url]', REPO);
  await click(page, 'dialog[open] button', 'Test');
  await page.waitFor('document.querySelectorAll("dialog[open] input[type=radio]:checked").length === 2', 10000);
  await page.eval('[...document.querySelectorAll("dialog[open] input[type=checkbox]")].find((c) => /new releases/i.test(c.closest("label")?.textContent || "")).click()');
  await sleep(50);
  await click(page, 'dialog[open] button', 'Install');
  await page.waitFor('!document.querySelector("dialog[open]")', 15000);
  const until = async (fn, ms, what) => { const end = Date.now() + ms; while (!(await fn())) { if (Date.now() > end) throw new Error(`timed out: ${what}`); await sleep(50); } };
  await until(() => platform.sources.list().some((s) => s.data.repo === REPO), 10000, 'the repository followed');
  assert.equal(platform.sources.list().find((s) => s.data.repo === REPO).data.claim, ID, 'it may update the template installed from a file');

  // Its next release installs.
  gh.release(REPO, 'overlay-v1.1.0', { assets: [{ name: 'miami-or-bust-1.1.0.zip', data: zip('1.1.0') }] });
  await platform.sources.check(undefined, { force: true });
  assert.ok(platform.templates.get(ID, '1.1.0'), '1.1.0 installed from the followed repository');
});
