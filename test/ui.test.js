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
import { DIAG, DIAG_DIR, defer, memoryLogger, packTemplate, signedIn, tempDir } from './helpers.js';

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
  // No live data: there is no overlay behind it, so these answer as for any unknown slug (03 §3.4).
  for (const p of ['snapshot', 'poll', 'stream']) assert.equal((await ui('GET', `/o/${encodeURIComponent(slug)}/${p}`)).status, 401, p);
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

// What every page keeps to, read in the page: a card in a grid sits level with its row, thumbnails
// and previews use the shared classes (no style set from script for what styles.css covers), the
// menus of a list are named apart, and an overlay's frame stays light in a dark admin (or
// see-through scenes would show white instead of the checkerboard).
const LAYOUT = `(() => {
  const view = document.querySelector('[data-view]');
  const cards = [...view.querySelectorAll('.grid > .card')];
  return {
    pushed: cards.filter((c) => getComputedStyle(c).marginTop !== '0px' || c.style.marginTop).map((c) => c.textContent.slice(0, 40)),
    unnamed: [...view.querySelectorAll('li details.menu > summary, article details.menu > summary, fieldset details.menu > summary')].filter((s) => !s.getAttribute('aria-label')).map((s) => s.textContent),
    styled: [...view.querySelectorAll('.thumb, .preview')].filter((el) => el.style.objectFit || el.style.display || el.style.colorScheme).length,
    frames: [...view.querySelectorAll('.preview iframe')].map((f) => getComputedStyle(f).colorScheme),
  };
})()`;

test('the pages use each overlay\'s own template version and the gallery\'s summaries, on the shared styles', { skip: browserSkip, timeout: 180000 }, async (t) => {
  const platform = await start(t);
  const ui = await owner(platform);
  // Two versions of a template; the overlay stays on the first, whose scenes and settings differ.
  const accent = { type: 'string', title: 'Accent', maxLength: 32, default: '#16e0ff' };
  const sample = (version, scenes, properties) => packTemplate(DIAG_DIR, { manifest: { id: 'dev.skp.sample', name: 'Sample', version, scenes, settings: { type: 'object', properties } } });
  platform.templates.install(sample('1.0.0', [{ id: 'program', label: 'First scene', core: 'program' }], { accent }), { actor: 'test' });
  platform.templates.install(sample('2.0.0', [{ id: 'program', label: 'Second scene', core: 'program' }, { id: 'later', label: 'Only in two' }], { accent, extra: { type: 'string', title: 'Only in version two' } }), { actor: 'test' });
  platform.overlays.create({ slug: 'old', template: { id: 'dev.skp.sample', version: '1.0.0' }, settings: {} });
  // Media with a picture (an image) and a placeholder (a font); a token and a user, for their lists.
  const { csrf } = (await ui('GET', '/auth/session')).body;
  for (const [name, body, type] of [['logo.png', PNG, 'image/png'], ['type.woff2', Buffer.concat([Buffer.from('wOF2'), Buffer.alloc(60)]), 'font/woff2']]) {
    const res = await fetch(`${platform.url}/api/v1/media?name=${name}`, { method: 'POST', headers: { cookie: ui.cookie, 'x-skp-csrf': csrf, 'content-type': type }, body });
    assert.equal(res.status, 201, name);
  }
  assert.equal((await ui('POST', '/tokens', { name: 'obs', scopes: ['overlays:read'] })).status, 201);
  assert.equal((await ui('POST', '/users', { username: 'op', password: PASSWORD, role: 'operator' })).status, 201);
  assert.equal((await ui('PUT', '/auth/preferences', { theme: 'dark' })).status, 200);

  const browser = await launchBrowser(t);
  const page = await browser.open(`${platform.url}/#/login`, { width: 1280, height: 900 });
  await page.waitFor('document.querySelector("input[name=username]")', 15000);
  assert.equal(await page.eval(`fetch('/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'juan', password: ${JSON.stringify(PASSWORD)} }) }).then((r) => r.status)`), 200);
  await page.goto(`${platform.url}/?signed=1#/live`);
  const before = page.problems.length;
  const asked = () => page.eval('performance.getEntriesByType("resource").map((e) => new URL(e.name).pathname).filter((p) => p.startsWith("/api/v1/templates/"))');
  const click = (selector, text) => page.eval(`[...document.querySelectorAll(${JSON.stringify(selector)})].find((b) => b.textContent.trim() === ${JSON.stringify(text)}).click()`);
  async function visit(route, ready) {
    if (route) await page.eval(`location.hash = ${JSON.stringify(`#${route}`)}`);
    const where = route || '/live';
    await page.waitFor(`document.documentElement.dataset.theme === "dark" && !document.querySelector("[data-view] > .loading") && (${ready})`, 15000);
    const layout = await page.eval(LAYOUT);
    assert.deepEqual(layout.pushed, [], `${where}: cards in a grid sit level`);
    assert.deepEqual(layout.unnamed, [], `${where}: the menus of a list are named apart`);
    assert.equal(layout.styled, 0, `${where}: thumbnails and previews use the shared classes`);
    assert.ok(layout.frames.every((s) => s === 'light'), `${where}: overlay frames stay light (${layout.frames})`);
    return page.eval('document.querySelector("[data-view]").innerText');
  }

  // Live with no show: each overlay's controls are its own version's scenes.
  let text = await visit(undefined, '[...document.querySelectorAll("[data-view] .pad button")].length');
  assert.match(text, /First scene/);
  assert.doesNotMatch(text, /Second scene|Only in two/);

  // The overlay's page: its version's settings and scenes, with no word about another version's.
  text = await visit('/overlays/old', 'document.querySelector("[data-view] h1")?.textContent === "old" && document.querySelector("[data-view] .inline-form select")');
  assert.match(text, /Accent/);
  assert.match(text, /Update available/);
  assert.doesNotMatch(text, /Only in version two|newest installed/);
  assert.deepEqual(await page.eval('[...document.querySelectorAll("[data-view] .inline-form select option")].map((o) => o.textContent)'), ['As on air', 'First scene']);
  const read = await asked();
  assert.ok(read.includes('/api/v1/templates/dev.skp.sample/versions/1.0.0'), read.join(', '));
  assert.ok(!read.includes('/api/v1/templates/dev.skp.sample'), 'not the newest version\'s manifest');
  // The upgrade names the new version's settings as its form does.
  await page.eval('document.querySelector("#tab-version").click()');
  await page.waitFor('[...document.querySelectorAll("[data-view] button")].some((b) => b.textContent === "Upgrade…")');
  await click('[data-view] button', 'Upgrade…');
  await page.waitFor('document.querySelector("dialog[open]")?.innerText.includes("From version 1.0.0 to 2.0.0")', 10000);
  assert.match(await page.eval('document.querySelector("dialog[open]").innerText'), /New setting "Only in version two"/);
  await click('dialog[open] button', 'Cancel');

  // The gallery: one request for every card (author, tags, canvases and pictures come with it).
  await page.eval('performance.clearResourceTimings()');
  text = await visit('/templates', 'document.querySelectorAll("[data-view] .grid > .card").length === 6'); // the 5 bundled and the sample
  assert.deepEqual((await asked()).filter((p) => p.split('/').length === 5 && !p.endsWith('/sources')), [], 'no request per template');
  assert.match(text, /By CTD Overlay/);
  assert.match(text, /16:9 · 9:16/);
  assert.ok(await page.eval('(() => { const imgs = [...document.querySelectorAll("[data-view] img.thumb")]; return imgs.length >= 2 && imgs.every((i) => i.classList.contains("contain") && getComputedStyle(i).objectFit === "contain"); })()'), 'whole pictures, not cropped');
  await page.eval('(() => { const q = document.querySelector("input[name=q]"); q.value = "test"; q.dispatchEvent(new Event("input")); })()');
  assert.deepEqual(await page.eval('[...document.querySelectorAll("[data-view] .grid h2")].map((x) => x.textContent).sort()'), ['Diagnostic', 'Sample'], 'a tag finds its templates');
  await visit('/templates/dev.skp.sample', 'document.querySelector("[data-view] .preview iframe")');

  // A show of it: the timeline offers, and Live takes, the pinned version's scenes.
  assert.equal((await ui('POST', '/shows', { name: 'Night', overlays: ['old'], date: '2026-10-17', timezone: 'America/Toronto', lineup: [{ time: '21:00', name: 'Opener' }] })).status, 201);
  await visit('/shows/Night?tab=lineup', 'document.querySelector("[data-view] fieldset details.menu")');
  assert.equal(await page.eval('document.querySelector("[data-view] fieldset details.menu > summary").getAttribute("aria-label")'), 'More for Opener');
  await page.eval('document.querySelector("#tab-timeline").click()');
  await page.waitFor('[...document.querySelectorAll("[data-view] button")].some((b) => b.textContent === "Add a cue")', 10000);
  await click('[data-view] button', 'Add a cue');
  await page.waitFor('document.querySelector("dialog[open] select")', 10000);
  const offered = await page.eval('[...document.querySelectorAll("dialog[open] option")].map((o) => o.textContent)');
  assert.ok(offered.includes('First scene') && !offered.includes('Second scene') && !offered.includes('Only in two'), offered.join(', '));
  await click('dialog[open] button', 'Cancel');
  text = await visit('/live', '[...document.querySelectorAll("[data-view] .pad button")].some((b) => b.textContent.includes("First scene"))');
  assert.doesNotMatch(text, /Second scene|Only in two/);

  // Media: a picture whole, a placeholder centred, its menus named, the drop outline a class.
  await visit('/media', 'document.querySelector("[data-view] img.thumb") && document.querySelector("[data-view] .thumb.icon")');
  const media = await page.eval(`(() => {
    const view = document.querySelector('[data-view]');
    const icon = view.querySelector('.thumb.icon');
    return {
      fit: getComputedStyle(view.querySelector('img.thumb')).objectFit,
      icon: [getComputedStyle(icon).display, getComputedStyle(icon).justifyContent, icon.textContent],
      named: [...view.querySelectorAll('details.menu > summary')].map((s) => s.getAttribute('aria-label')).sort(),
    };
  })()`);
  assert.deepEqual(media, { fit: 'contain', icon: ['flex', 'center', 'Font'], named: ['More for logo.png', 'More for type.woff2'] });
  const drop = await page.eval(`(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['x'], 'a.png', { type: 'image/png' }));
    document.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
    const view = document.querySelector('[data-view]');
    return { on: view.classList.contains('dropping'), outline: getComputedStyle(view).outlineStyle, inline: view.style.outline };
  })()`);
  assert.deepEqual(drop, { on: true, outline: 'dashed', inline: '' });
  await page.waitFor('!document.querySelector("[data-view]").classList.contains("dropping")', 3000);

  // Settings' lists: each menu says whose it is.
  await visit('/settings/users', 'document.querySelector("[data-view] li details.menu")');
  assert.equal(await page.eval('document.querySelector("[data-view] li details.menu > summary").getAttribute("aria-label")'), 'More for op');
  await visit('/settings/tokens', 'document.querySelector("[data-view] li details.menu")');
  await visit('/settings/account', 'document.querySelector("[data-view] li details.menu")'); // where you're signed in
  assert.deepEqual(page.problems.slice(before), []);
});
