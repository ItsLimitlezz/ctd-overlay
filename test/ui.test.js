// The admin UI (08): its files, served no-store under the admin CSP; per-user appearance and the
// installation's name and logo; a template's preview with sample data before any overlay uses it;
// and the UI itself in a real browser, at desktop and phone width, with no console error, no CSP
// violation and no sideways scrolling on any page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startPlatform } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { browserSkip, launchBrowser } from './cdp.js';
import { DIAG, defer, memoryLogger, signedIn, tempDir } from './helpers.js';

const PASSWORD = 'correct horse battery staple';
const UI_DIR = fileURLToPath(new URL('../src/ui/', import.meta.url));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

async function start(t) {
  const root = tempDir(t);
  const config = loadConfig({ argv: ['--port', '0'], env: { SKP_DATA_DIR: path.join(root, 'data'), SKP_CONFIG_DIR: path.join(root, 'config') } });
  const { log } = memoryLogger();
  const platform = await startPlatform(config, { log, scrypt: { N: 1024 } });
  defer(t, () => platform.stop());
  return platform;
}

// The owner, signed in as a browser is: a session cookie and its CSRF token.
async function owner(platform) {
  const made = await fetch(`${platform.url}/api/v1/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: platform.auth.setupCode, username: 'juan', password: PASSWORD }) });
  const cookie = made.headers.get('set-cookie').split(';')[0];
  const { csrf } = await made.json();
  const call = (method, p, body, headers = {}) => fetch(`${platform.url}${p.startsWith('/') && !p.startsWith('/api') && !p.startsWith('/o/') ? `/api/v1${p}` : p}`, { method, headers: { cookie, 'x-skp-csrf': csrf, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
    .then(async (res) => {
      const text = await res.text();
      let json;
      try { json = JSON.parse(text); } catch { json = text; }
      return { status: res.status, body: json, headers: res.headers };
    });
  call.cookie = cookie;
  return call;
}

// A raw request, so the path reaches the server exactly as written (fetch would normalize it).
function rawGet(base, rawPath) {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: u.port, path: rawPath, method: 'GET' }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

const uiFiles = (dir = UI_DIR) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? uiFiles(path.join(dir, e.name)) : [path.join(dir, e.name)]));

test('the admin UI is served from src/ui: no-store, the admin CSP, and nothing outside it', async (t) => {
  const platform = await start(t);
  const index = await fetch(`${platform.url}/`);
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-type'), /^text\/html/);
  assert.equal(index.headers.get('cache-control'), 'no-store', 'H14');
  assert.match(index.headers.get('content-security-policy'), /default-src 'self'/);
  assert.match(index.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(await index.text(), /<script type="module" src="\/ui\/app\.js"><\/script>/);

  // Every file of the UI is served with its type.
  for (const file of uiFiles()) {
    const rel = path.relative(UI_DIR, file).split(path.sep).join('/');
    if (rel === 'README.md') continue;
    const res = await fetch(`${platform.url}/ui/${rel}`);
    assert.equal(res.status, 200, rel);
    assert.equal(res.headers.get('cache-control'), 'no-store', rel);
    const type = { js: /^text\/javascript/, css: /^text\/css/, html: /^text\/html/, svg: /^image\/svg\+xml/ }[rel.split('.').pop()];
    assert.match(res.headers.get('content-type'), type, rel);
    await res.arrayBuffer();
  }
  // Nothing else: not the README, not a dot file, not a step outside.
  for (const p of ['/ui/README.md', '/ui/.env', '/ui/%2e%2e/app.js', '/ui/..%2fapp.js', '/ui/..%5capp.js', '/ui/pages/..%2f..%2fhttp%2fui.js', '/ui/%2e%2e%2f%2e%2e%2fpackage.json', '/ui/nope.js']) {
    assert.equal((await rawGet(platform.url, p)).status, 404, p);
  }
});

test('the UI keeps to its CSP and its conventions: no inline styles or scripts, no HTML from strings', () => {
  for (const file of uiFiles()) {
    const rel = path.relative(UI_DIR, file);
    const text = readFileSync(file, 'utf8');
    if (file.endsWith('.js')) {
      assert.doesNotMatch(text, /\.innerHTML\s*=|outerHTML\s*=|insertAdjacentHTML|document\.write\(/, `${rel}: build DOM with h()`);
      assert.doesNotMatch(text, /setAttribute\(\s*['"]style['"]|\bstyle:\s*['"]/, `${rel}: no style attributes (the CSP refuses them); use the CSSOM`);
      assert.doesNotMatch(text, /\beval\(|new Function\(/, `${rel}: no eval`);
      assert.doesNotMatch(text, /(?:\bimport\s*\(?\s*|\bfrom\s+|\bfetch\(\s*|\bEventSource\(\s*)['"`]https?:/, `${rel}: nothing loads from another origin`);
    }
    if (file.endsWith('.html')) {
      assert.doesNotMatch(text, /\sstyle=|<script(?![^>]*\bsrc=)|\son[a-z]+=|(?:src|href)="https?:/i, `${rel}: no inline style, script or handler, nothing from another origin`);
    }
  }
});

test('appearance is per user (08 §8.6): theme, accent and density, checked', async (t) => {
  const platform = await start(t);
  const ui = await owner(platform);
  assert.deepEqual((await ui('GET', '/auth/session')).body.user.preferences, {});
  const set = await ui('PUT', '/auth/preferences', { theme: 'dark', accent: '#FF8800', density: 'compact' });
  assert.equal(set.status, 200);
  assert.deepEqual(set.body, { theme: 'dark', accent: '#ff8800', density: 'compact' });
  assert.deepEqual((await ui('GET', '/auth/session')).body.user.preferences, { theme: 'dark', accent: '#ff8800', density: 'compact' });
  // Partial: only what is sent changes; null puts the accent back to the default.
  assert.deepEqual((await ui('PUT', '/auth/preferences', { accent: null })).body, { theme: 'dark', density: 'compact' });
  for (const bad of [{ theme: 'neon' }, { accent: 'red' }, { accent: '#fff' }, { density: 'tiny' }]) {
    assert.equal((await ui('PUT', '/auth/preferences', bad)).status, 422, JSON.stringify(bad));
  }
  assert.equal((await ui('PUT', '/auth/preferences', { fontSize: 20 })).status, 422, 'unknown fields are refused');
  // A person's, not a token's or the command line's.
  const local = await fetch(`${platform.url}/api/v1/auth/preferences`, { method: 'PUT', headers: signedIn(platform, { 'content-type': 'application/json' }), body: JSON.stringify({ theme: 'light' }) });
  assert.notEqual(local.status, 200);
  // Another user's are their own.
  await ui('POST', '/users', { username: 'op', password: PASSWORD, role: 'operator' });
  const login = await fetch(`${platform.url}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'op', password: PASSWORD }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const session = await (await fetch(`${platform.url}/api/v1/auth/session`, { headers: { cookie } })).json();
  assert.deepEqual(session.user.preferences, {});
});

test('the installation\'s name and logo: anyone signed in reads them, only the owner sets them', async (t) => {
  const platform = await start(t);
  const ui = await owner(platform);
  assert.deepEqual((await ui('GET', '/system/settings')).body, {});
  assert.equal((await fetch(`${platform.url}/api/v1/system/settings`)).status, 401);
  const media = await fetch(`${platform.url}/api/v1/media?name=logo.png`, { method: 'POST', headers: { cookie: ui.cookie, 'x-skp-csrf': (await ui('GET', '/auth/session')).body.csrf, 'content-type': 'image/png' }, body: PNG });
  assert.equal(media.status, 201);
  const logo = (await media.json()).url;
  const set = await ui('PUT', '/system/settings', { name: '  D/PRTMNT  ', logo });
  assert.deepEqual([set.status, set.body], [200, { name: 'D/PRTMNT', logo }]);
  assert.deepEqual((await ui('GET', '/system/settings')).body, { name: 'D/PRTMNT', logo });
  for (const bad of [{ name: 'x'.repeat(61) }, { name: 5 }, { logo: 'https://example.com/a.png' }, { logo: '/media/../etc/passwd' }]) {
    assert.equal((await ui('PUT', '/system/settings', bad)).status, 422, JSON.stringify(bad));
  }
  assert.deepEqual((await ui('PUT', '/system/settings', { logo: null })).body, { name: 'D/PRTMNT' });
  assert.deepEqual((await ui('PUT', '/system/settings', { name: '' })).body, {});
  // An operator may not.
  await ui('POST', '/users', { username: 'op', password: PASSWORD, role: 'operator' });
  const login = await fetch(`${platform.url}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'op', password: PASSWORD }) });
  const { csrf } = await login.json();
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const refused = await fetch(`${platform.url}/api/v1/system/settings`, { method: 'PUT', headers: { cookie, 'x-skp-csrf': csrf, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'mine' }) });
  assert.equal(refused.status, 403);
});

test('a template previews with sample data before any overlay uses it (08 §8.2), for someone signed in only', async (t) => {
  const platform = await start(t);
  const ui = await owner(platform);
  const slug = `~p.${DIAG.id}@${DIAG.version}`;
  const url = `/o/${encodeURIComponent(slug)}?canvas=h`;
  assert.equal((await fetch(`${platform.url}${url}`)).status, 401, 'not signed in');
  const page = await ui('GET', url);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /sandbox allow-scripts/, 'the overlay CSP, not the admin one');
  const meta = JSON.parse(/<meta name="skp" content="([^"]*)"/.exec(page.body)[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#39;/g, '\'').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
  assert.equal(meta.mock, true, 'sample data, always');
  assert.equal(meta.slug, slug);
  // Its files, through its build.
  const css = /\/o\/[^"']+\/t\/[0-9a-f]+\/[^"']+/.exec(page.body);
  if (css) assert.equal((await fetch(`${platform.url}${css[0].replace(/&amp;/g, '&')}`)).status, 200);
  // No live data: there is no overlay behind it.
  for (const p of ['snapshot', 'poll', 'stream']) assert.equal((await ui('GET', `/o/${encodeURIComponent(slug)}/${p}`)).status, 404, p);
  // A version that isn't installed, or a slug shaped like a preview's without a template.
  assert.equal((await ui('GET', `/o/${encodeURIComponent(`~p.${DIAG.id}@9.9.9`)}`)).status, 404);
  assert.equal((await ui('GET', `/o/${encodeURIComponent('~p.nope@1.0.0')}`)).status, 404);
  // A token without templates:read is refused.
  const token = await ui('POST', '/tokens', { name: 'obs', scopes: ['overlays:read'] });
  const refused = await fetch(`${platform.url}${url}`, { headers: { authorization: `Bearer ${token.body.token}` } });
  assert.equal(refused.status, 403);
});

test('the admin UI in a browser: sign in, every section, desktop and phone, with no errors', { skip: browserSkip, timeout: 240000 }, async (t) => {
  const platform = await start(t);
  const ui = await owner(platform);
  platform.overlays.create({ slug: 'diag', template: DIAG, settings: {} });
  assert.equal((await ui('POST', '/shows', { name: 'Night', overlays: ['diag'], date: '2026-10-17', timezone: 'America/Toronto', goLive: '21:00', lineup: [{ time: '21:00', name: 'Opener' }, { time: '23:00', name: 'Headliner', headliner: true }] })).status, 201);
  // Sign out: the browser signs in itself.
  const browser = await launchBrowser(t);
  const page = await browser.open(`${platform.url}/`, { width: 1280, height: 900 });
  await page.waitFor('location.hash.startsWith("#/login") && document.querySelector("input[name=username]")', 15000);
  await page.eval(`(() => {
    document.querySelector('input[name=username]').value = 'juan';
    document.querySelector('input[name=password]').value = ${JSON.stringify(PASSWORD)};
    document.querySelector('form').requestSubmit();
  })()`);
  await page.waitFor('location.hash === "#/live" && !document.querySelector("[data-view] > .loading")', 15000);
  assert.equal(await page.eval('document.querySelector("[data-shell]").hidden'), false, 'the shell shows once signed in');

  const sections = ['/live', '/overlays', '/overlays/diag', '/templates', `/templates/${DIAG.id}`, '/shows', '/shows/Night', '/connections', '/media', '/settings', '/settings/account', '/settings/tokens', '/settings/about'];
  for (const [width, height] of [[1280, 900], [390, 844]]) {
    await page.resize(width, height);
    for (const route of sections) {
      const before = page.problems.length;
      await page.eval(`location.hash = ${JSON.stringify(`#${route}`)}`);
      // A page may settle on its canonical address (a show by name opens as /shows/<id>).
      const section = `#/${route.split('/')[1]}`;
      await page.waitFor(`location.hash.startsWith(${JSON.stringify(section)}) && !document.querySelector("[data-view] > .loading")`, 15000);
      await new Promise((r) => setTimeout(r, 400));
      const state = await page.eval('({ text: document.querySelector("[data-view]").innerText, h1: document.querySelectorAll("[data-view] h1").length, sideways: document.documentElement.scrollWidth > innerWidth + 1 })');
      assert.doesNotMatch(state.text, /This page could not load/, `${route} at ${width}px: ${state.text.slice(0, 300)}`);
      assert.equal(state.h1, 1, `${route} at ${width}px has one h1`);
      assert.equal(state.sideways, false, `${route} at ${width}px scrolls sideways`);
      assert.deepEqual(page.problems.slice(before), [], `${route} at ${width}px`);
    }
  }
  // On a phone the navigation is a menu.
  assert.equal(await page.eval('getComputedStyle(document.querySelector("[data-nav]")).display'), 'none');
  await page.eval('document.querySelector("[data-menu-toggle]").click()');
  assert.equal(await page.eval('getComputedStyle(document.querySelector("[data-nav]")).display'), 'flex');
  assert.equal(await page.eval('document.querySelector("[data-menu-toggle]").getAttribute("aria-expanded")'), 'true');

  // A theme chosen in Settings applies at once and follows the user.
  await ui('PUT', '/auth/preferences', { theme: 'dark', accent: '#ff8800' });
  await page.goto(`${platform.url}/?reload=1#/live`); // a new document: a hash alone wouldn't load
  await page.waitFor('document.documentElement.dataset.theme === "dark"', 10000);
  assert.equal(await page.eval('document.documentElement.style.getPropertyValue("--accent")'), '#ff8800');

  // A session that ends (signed out elsewhere, expired) sends the page to sign in again.
  await page.eval(`fetch('/api/v1/auth/session').then((r) => r.json()).then((s) => fetch('/api/v1/auth/logout', { method: 'POST', headers: { 'x-skp-csrf': s.csrf, 'content-type': 'application/json' }, body: '{}' })).then((r) => r.status)`);
  await page.eval('location.hash = "#/overlays"');
  await page.waitFor('location.hash.startsWith("#/login") && document.querySelector("input[name=username]")', 15000);
  assert.equal(await page.eval('document.querySelector("[data-shell]").hidden'), true);
});
