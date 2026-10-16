// The admin UI (08) in a real browser, in the situations a night brings: a tab whose session was
// replaced by another tab, a page left while it still loads, a sign-out mid-upload, a list read
// before someone else changed it, keyboard use of menus and dialogs, a phone's narrow screen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { startPlatform } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { browserSkip, launchBrowser } from './cdp.js';
import { DIAG, DIAG_DIR, defer, memoryLogger, packTemplate, tempDir } from './helpers.js';

const PASSWORD = 'correct horse battery staple';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const opts = { skip: browserSkip, timeout: 180000 };

async function start(t) {
  const root = tempDir(t);
  const config = loadConfig({ argv: ['--port', '0'], env: { SKP_DATA_DIR: path.join(root, 'data'), SKP_CONFIG_DIR: path.join(root, 'config') } });
  const platform = await startPlatform(config, { log: memoryLogger().log, scrypt: { N: 1024 } });
  defer(t, () => platform.stop());
  return platform;
}

// A person signed in from Node, as another device would be: call(method, path, body, headers).
async function session(platform, username, setup) {
  const res = setup
    ? await fetch(`${platform.url}/api/v1/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: platform.auth.setupCode, username, password: PASSWORD }) })
    : await fetch(`${platform.url}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password: PASSWORD }) });
  assert.ok(res.ok, `${username}: ${res.status}`);
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const { csrf } = await res.json();
  const call = async (method, p, body, headers = {}) => {
    const raw = Buffer.isBuffer(body);
    const out = await fetch(`${platform.url}/api/v1${p}`, {
      method,
      headers: { cookie, 'x-skp-csrf': csrf, ...(body !== undefined ? { 'content-type': raw ? 'image/png' : 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
    });
    const text = await out.text();
    let json;
    try { json = JSON.parse(text); } catch { json = text; }
    return { status: out.status, body: json, etag: out.headers.get('etag') };
  };
  return call;
}

// The owner (made at setup), and an operator and an admin.
async function people(platform) {
  const owner = await session(platform, 'juan', true);
  for (const [username, role] of [['op', 'operator'], ['ad', 'admin']]) {
    assert.equal((await owner('POST', '/users', { username, password: PASSWORD, role })).status, 201);
  }
  return owner;
}

async function openPage(t, platform, { width = 1280, height = 900 } = {}) {
  const browser = await launchBrowser(t);
  const page = await browser.open(`${platform.url}/#/login`, { width, height });
  // Focus and focusin as in a focused window, so the tests can follow the keyboard focus.
  await page.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  return { browser, page };
}

// Signs in with the sign-in form (the app stays the same document), then opens a route.
async function signIn(page, username, route) {
  await page.waitFor('document.querySelector("input[name=username]")', 15000);
  await page.eval(`(() => {
    document.querySelector('input[name=username]').value = ${JSON.stringify(username)};
    document.querySelector('input[name=password]').value = ${JSON.stringify(PASSWORD)};
    document.querySelector('form').requestSubmit();
  })()`);
  await page.waitFor('location.hash.startsWith("#/live") && document.querySelector("[data-view] h1")', 15000);
  if (route) await go(page, route);
}

async function go(page, route, ready = 'true') {
  await page.eval(`location.hash = ${JSON.stringify(`#${route}`)}`);
  await page.waitFor(`!document.querySelector("[data-view] > .loading") && document.querySelector("[data-view] h1") && (${ready})`, 15000);
}

const click = (page, selector, text) => page.eval(`(() => {
  const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((b) => b.textContent.trim() === ${JSON.stringify(text)} || b.getAttribute('aria-label') === ${JSON.stringify(text)});
  if (!el) throw new Error('nothing to click: ' + ${JSON.stringify(`${selector} ${text}`)});
  el.click();
})()`);
// Opens the menu whose button is named so (the one that has the item) and chooses the item.
const choose = async (page, menuName, item) => {
  await page.eval(`(() => {
    const d = [...document.querySelectorAll('[data-view] details.menu')].find((x) => {
      const s = x.querySelector('summary');
      return (s.getAttribute('aria-label') || s.textContent.trim()) === ${JSON.stringify(menuName)}
        && [...x.querySelectorAll('[role=menuitem]')].some((b) => b.textContent.trim() === ${JSON.stringify(item)});
    });
    if (!d) throw new Error('no menu ' + ${JSON.stringify(`${menuName} with ${item}`)});
    d.open = true;
  })()`);
  await sleep(50);
  await click(page, '[data-view] details.menu[open] [role=menuitem]', item);
};
const toasts = (page) => page.eval('[...document.querySelectorAll(".toast span")].map((t) => t.textContent)');
const active = (page) => page.eval('(() => { const a = document.activeElement; return a ? `${a.tagName} ${(a.getAttribute("aria-label") || a.textContent || "").trim().slice(0, 60)}` : null; })()');
// Console errors and CSP violations; a refused request's "Failed to load resource" is expected here.
const problems = (page) => page.problems.filter((p) => !p.startsWith('network:'));

async function press(page, key, { shift = false } = {}) {
  const codes = { Tab: 9, Enter: 13, Escape: 27, End: 35, Home: 36, ArrowUp: 38, ArrowDown: 40 };
  const modifiers = shift ? 8 : 0;
  await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code: key, windowsVirtualKeyCode: codes[key], modifiers });
  if (key === 'Enter') await page.send('Input.dispatchKeyEvent', { type: 'char', text: '\r', key, modifiers });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: codes[key], modifiers });
  await sleep(60);
}

test('another tab signing in again renews the token: a change goes through; someone else signing in stops it (C1)', opts, async (t) => {
  const platform = await start(t);
  const owner = await people(platform);
  const { browser, page } = await openPage(t, platform);
  await signIn(page, 'juan', '/settings/appearance');

  // Another tab of the same browser signs in again: a new session and token in the shared cookie.
  const other = await browser.open(`${platform.url}/#/login`);
  const login = (who) => other.eval(`fetch('/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: ${JSON.stringify(who)}, password: ${JSON.stringify(PASSWORD)} }) }).then((r) => r.status)`);
  assert.equal(await login('juan'), 200);
  const change = (theme) => page.eval(`import('/ui/api.js').then((api) => api.put('/api/v1/auth/preferences', { theme: ${JSON.stringify(theme)} })).then((r) => 'saved ' + r.theme, (e) => e.message)`);
  assert.equal(await change('dark'), 'saved dark', 'the change is sent again with the new token');
  assert.equal((await owner('GET', '/auth/session')).body.user.preferences.theme, 'dark');

  // Someone else signs in there: this tab's change is not made for them, nor for juan.
  assert.equal(await login('op'), 200);
  assert.match(await change('light'), /^op signed in on this browser, in another tab, so nothing was changed/);
  assert.equal((await owner('GET', '/auth/session')).body.user.preferences.theme, 'dark');
  // The app redraws for op: their account, without the owner's Users tab.
  await page.waitFor('[...document.querySelectorAll(".toast span")].some((s) => s.textContent.startsWith("op signed in"))', 10000);
  await go(page, '/settings/account', 'document.querySelector("[data-view] dl.kv")');
  assert.match(await page.eval('document.querySelector("[data-view] dl.kv").innerText'), /Username\s+op/);
  assert.equal(await page.eval('!!document.querySelector("#tab-users")'), false);
  assert.deepEqual(problems(page), []);
});

test('a page left while it still loads draws nothing over the next one and leaves the address alone (U1)', opts, async (t) => {
  const platform = await start(t);
  const owner = await people(platform);
  platform.overlays.create({ slug: 'diag', template: DIAG, settings: {} });
  const show = await owner('POST', '/shows', { name: 'Night', overlays: ['diag'], date: '2026-10-17', timezone: 'America/Toronto', lineup: [{ time: '21:00', name: 'Opener' }] });
  assert.equal(show.status, 201);
  const { page } = await openPage(t, platform);
  await signIn(page, 'juan', '/connections');
  // Every page's module loaded once, as a user who has been around would have.
  for (const r of ['/live', '/overlays', `/shows/${show.body.id}`, '/templates', '/connections']) await go(page, r);

  await page.send('Network.enable');
  await page.send('Network.emulateNetworkConditions', { offline: false, latency: 600, downloadThroughput: -1, uploadThroughput: -1 });
  for (const [from, to, title] of [['/live', '/overlays', 'Overlays'], [`/shows/${show.body.id}`, '/connections', 'Connections'], ['/templates', '/connections', 'Connections']]) {
    await page.eval(`location.hash = ${JSON.stringify(`#${from}`)}`);
    await sleep(250);
    await page.eval(`location.hash = ${JSON.stringify(`#${to}`)}`);
    await page.waitFor(`document.querySelector("[data-view] h1")?.textContent === ${JSON.stringify(title)}`, 20000);
    await sleep(7000); // the left page's requests answer meanwhile
    const state = await page.eval('({ hash: location.hash, h1: [...document.querySelectorAll("h1")].map((x) => x.textContent), frames: document.querySelectorAll("iframe").length, title: document.title, mains: document.querySelectorAll("main").length })');
    assert.deepEqual(state, { hash: `#${to}`, h1: [title], frames: 0, title: state.title, mains: 1 }, `${from} then ${to}`);
    assert.ok(state.title.startsWith(title), `${from} then ${to}: the title is ${state.title}`);
  }
  await page.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  // The skip link moves to the page, not to a route.
  await page.eval('document.querySelector(".skip").click()');
  assert.equal(await page.eval('location.hash'), '#/connections');
  assert.equal(await page.eval('document.activeElement === document.querySelector("[data-view]")'), true);
  assert.deepEqual(problems(page), []);
});

test('signing out mid-upload drops the queue: the next person neither sends nor sees the files (S1)', opts, async (t) => {
  const platform = await start(t);
  const owner = await people(platform);
  const { browser, page } = await openPage(t, platform);
  await signIn(page, 'juan', '/media');

  // Uploads wait at the network, so one is still going when juan signs out.
  const posts = [];
  const off = browser.cdp.on((msg) => {
    if (msg.method !== 'Fetch.requestPaused') return;
    const p = msg.params;
    if (p.request.method === 'POST') posts.push(p);
    else page.send('Fetch.continueRequest', { requestId: p.requestId }).catch(() => {});
  });
  t.after(off);
  await page.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/v1/media?*', requestStage: 'Request' }] });
  await page.eval(`(() => {
    const bytes = Uint8Array.from(atob(${JSON.stringify(PNG)}), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    for (const name of ['secret-one.png', 'secret-two.png']) dt.items.add(new File([bytes], name, { type: 'image/png' }));
    const input = document.querySelector('[data-view] input[type=file]');
    input.files = dt.files;
    input.dispatchEvent(new Event('change'));
  })()`);
  await page.waitFor('document.querySelector("[data-view]").innerText.includes("Uploading secret-one.png")', 10000);
  assert.equal(posts.length, 1);

  await go(page, '/settings/account', '[...document.querySelectorAll("[data-view] button")].some((b) => b.textContent === "Sign out")');
  await click(page, '[data-view] button', 'Sign out');
  await page.waitFor('location.hash.startsWith("#/login") && document.querySelector("input[name=username]")', 10000);
  await signIn(page, 'ad', '/media');
  // The first upload's request answers late (juan's session is over): nothing comes of it.
  await page.send('Fetch.continueRequest', { requestId: posts[0].requestId }).catch(() => {});
  await sleep(1500);
  assert.equal(posts.length, 1, 'the second file is never sent');
  const text = await page.eval('document.querySelector("[data-view]").innerText + document.querySelector("[data-toasts]").innerText');
  assert.doesNotMatch(text, /secret-|Uploading/);
  assert.equal(await page.eval('location.hash'), '#/media', 'ad stays signed in');
  assert.deepEqual((await owner('GET', '/media')).body.items, []);
  await page.send('Fetch.disable');
  assert.deepEqual(problems(page), []);
});

test('menus and dialogs by keyboard: arrow keys, the consequence read, the focus given back (U2, U15, U17, U20)', opts, async (t) => {
  const platform = await start(t);
  await people(platform);
  platform.overlays.create({ slug: 'diag', template: DIAG, settings: {} });
  const { page } = await openPage(t, platform);
  await signIn(page, 'juan', '/overlays/diag');

  const listeners = async () => {
    const { result } = await page.send('Runtime.evaluate', { expression: 'document' });
    const { listeners: list } = await page.send('DOMDebugger.getEventListeners', { objectId: result.objectId });
    return list.filter((l) => l.type === 'click').length;
  };
  const clicksBefore = await listeners();

  await page.eval('document.querySelector(".page-head details.menu > summary").focus()');
  await press(page, 'Enter');
  assert.equal(await active(page), 'BUTTON Rename…', 'opening focuses the first item');
  await press(page, 'ArrowDown');
  assert.match(await active(page), /^BUTTON Require the key in the URL/);
  await press(page, 'End');
  assert.equal(await active(page), 'BUTTON Delete overlay…');
  await press(page, 'Home');
  assert.equal(await active(page), 'BUTTON Rename…');
  await press(page, 'ArrowUp');
  assert.equal(await active(page), 'BUTTON Delete overlay…', 'up from the first is the last');
  await press(page, 'Enter');
  await page.waitFor('document.querySelector("dialog[open]")', 5000);
  const described = await page.eval('(() => { const d = document.querySelector("dialog[open]"); return document.getElementById(d.getAttribute("aria-describedby"))?.textContent; })()');
  assert.match(described, /OBS sources using this overlay's URL will stop working/);
  await press(page, 'Escape');
  await page.waitFor('!document.querySelector("dialog[open]")', 5000);
  assert.equal(await active(page), 'SUMMARY More', 'the focus is back on the menu');

  // A button that stays busy while its dialog is open gets the focus back once it is free.
  await go(page, '/shows', '[...document.querySelectorAll("[data-view] button")].some((b) => b.textContent === "New show")');
  await page.eval('[...document.querySelectorAll("[data-view] button")].find((b) => b.textContent === "New show").focus()');
  await press(page, 'Enter');
  await page.waitFor('document.querySelector("dialog[open]")', 5000);
  await press(page, 'Escape');
  await page.waitFor('document.activeElement?.textContent === "New show"', 5000);

  // Leaving a page with a menu open leaves no listener behind.
  await go(page, '/overlays/diag');
  await page.eval('document.querySelector(".page-head details.menu").open = true');
  await sleep(50);
  await go(page, '/connections');
  assert.equal(await listeners(), clicksBefore);
  assert.deepEqual(problems(page), []);
});

test('on a phone every menu opens on the screen, and the targets are a finger wide (U6, U14)', opts, async (t) => {
  const platform = await start(t);
  const owner = await people(platform);
  platform.overlays.create({ slug: 'diag', template: DIAG, settings: {} });
  const show = await owner('POST', '/shows', { name: 'Night', overlays: ['diag'], date: '2026-10-17', timezone: 'America/Toronto', lineup: [{ time: '21:00', name: 'Opener' }, { time: '22:00', name: 'Closer', closer: true }] });
  assert.equal((await owner('POST', `/shows/${show.body.id}/cues/build`, { recipe: { titleCard: true, headliner: true, introOffsetMin: 5, nowPlayingEveryMin: 10 } })).status, 200);
  const { page } = await openPage(t, platform, { width: 390, height: 844 });
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await signIn(page, 'juan');
  for (const route of [`/shows/${show.body.id}?tab=timeline`, `/shows/${show.body.id}?tab=lineup`, '/overlays/diag', '/settings/account']) {
    await go(page, route, 'document.querySelector("[data-view] details.menu")');
    const off = await page.eval(`(async () => {
      const out = [];
      for (const d of [...document.querySelectorAll('[data-view] details.menu')].filter((x) => x.getBoundingClientRect().width)) {
        d.scrollIntoView({ block: 'center' });
        d.open = true;
        await new Promise((r) => setTimeout(r, 30));
        const r = d.querySelector('.menu-list').getBoundingClientRect();
        if (r.left < 0 || r.right > innerWidth) out.push(d.querySelector('summary').textContent + ' ' + Math.round(r.left) + '..' + Math.round(r.right));
        d.open = false;
      }
      return out;
    })()`);
    assert.deepEqual(off, [], `${route}: menus off the screen`);
  }
  // The member chips, a toast's Dismiss, a checkbox with its words: 44 px.
  await go(page, `/shows/${show.body.id}`, 'document.querySelector("[data-view] a.chip")');
  await page.eval('import("/ui/dom.js").then((d) => d.toast("Scene changed to BRB"))');
  const sizes = await page.eval(`(() => {
    const box = (el) => { const r = el.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; };
    return { chip: box(document.querySelector('[data-view] a.chip'))[1], dismiss: box(document.querySelector('.toast button')) };
  })()`);
  assert.ok(sizes.chip >= 44, `chip ${sizes.chip}`);
  assert.ok(sizes.dismiss[0] >= 44 && sizes.dismiss[1] >= 44, `dismiss ${sizes.dismiss}`);
  await go(page, '/overlays/diag', 'document.querySelector("[data-view] .field.check")');
  const check = await page.eval('(() => { const f = document.querySelector("[data-view] .field.check"); const r = f.querySelector("label").getBoundingClientRect(); return Math.round(r.height); })()');
  assert.ok(check >= 44, `Sample data row ${check}`);
  assert.deepEqual(problems(page), []);
});

test('the look: field edges and placeholders read in both themes, the focus stops below the header (U4, U5, U12)', opts, async (t) => {
  const platform = await start(t);
  const owner = await people(platform);
  const { page } = await openPage(t, platform, { width: 1280, height: 700 });
  await signIn(page, 'juan', '/settings/appearance');
  await page.waitFor('document.querySelector("[data-view] input[placeholder]")', 10000);
  for (const theme of ['light', 'dark']) {
    // Two frames after the switch, and the placeholder read on a fresh copy of the field: Chrome
    // on macOS keeps answering a drawn field's ::placeholder colour from before the switch (the
    // light grey on the dark field), though it paints the new one.
    const ratios = await page.eval(`(async () => {
      document.documentElement.dataset.theme = ${JSON.stringify(theme)};
      void document.body.offsetHeight;
      for (let i = 0; i < 2; i++) await new Promise((r) => requestAnimationFrame(r));
      const rgb = (c) => (/rgba?\\(([^)]+)\\)/.exec(c)?.[1] || '0,0,0').split(/[ ,/]+/).filter(Boolean).map(Number);
      const lum = (c) => { const [r, g, b] = rgb(c).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
      const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return Math.round(((x + 0.05) / (y + 0.05)) * 100) / 100; };
      const input = document.querySelector('[data-view] input[placeholder]');
      const s = getComputedStyle(input);
      const fresh = input.cloneNode();
      fresh.value = '';
      input.after(fresh);
      const placeholder = getComputedStyle(fresh, '::placeholder').color;
      fresh.remove();
      return {
        edgeOnField: ratio(s.borderTopColor, s.backgroundColor),
        edgeOnPage: ratio(s.borderTopColor, getComputedStyle(document.body).backgroundColor),
        placeholder: ratio(placeholder, s.backgroundColor),
      };
    })()`);
    assert.ok(ratios.edgeOnField >= 3 && ratios.edgeOnPage >= 3, `${theme}: field edges ${JSON.stringify(ratios)}`);
    assert.ok(ratios.placeholder >= 4.5, `${theme}: placeholder ${JSON.stringify(ratios)}`);
  }
  await page.eval('delete document.documentElement.dataset.theme');
  // Shift+Tab up a long page from its end: no control it focuses is under the sticky header.
  const lineup = Array.from({ length: 8 }, (_, i) => ({ time: `${String(18 + Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`, name: `Act ${i + 1}` }));
  const show = await owner('POST', '/shows', { name: 'Long', overlays: [], date: '2026-10-17', timezone: 'UTC', lineup });
  await go(page, `/shows/${show.body.id}?tab=lineup`, 'document.querySelectorAll("[data-view] fieldset").length === 8');
  await page.eval(`(() => {
    window.scrollTo(0, document.documentElement.scrollHeight);
    const all = [...document.querySelectorAll('[data-view] button, [data-view] a[href], [data-view] input, [data-view] select, [data-view] summary')].filter((e) => e.getBoundingClientRect().height && !e.disabled);
    all[all.length - 1].focus();
  })()`);
  const hidden = [];
  for (let i = 0; i < 40; i++) {
    await press(page, 'Tab', { shift: true });
    const s = await page.eval('(() => { const a = document.activeElement; if (!document.querySelector("[data-view]").contains(a)) return null; const r = a.getBoundingClientRect(); return { top: Math.round(r.top), header: Math.round(document.querySelector("header.top").getBoundingClientRect().bottom), name: (a.getAttribute("aria-label") || a.textContent || a.value || "").trim().slice(0, 30) }; })()');
    if (s && s.top < s.header) hidden.push(s);
  }
  assert.deepEqual(hidden, [], 'focused under the header');
  assert.deepEqual(problems(page), []);
});

test('installing a template from a file sends its file name (C8)', opts, async (t) => {
  const platform = await start(t);
  await people(platform);
  const pkg = packTemplate(DIAG_DIR, { manifest: { id: 'dev.skp.named', name: 'Named', version: '1.0.0' } });
  const { browser, page } = await openPage(t, platform);
  await signIn(page, 'juan', '/templates');
  await page.send('Network.enable');
  const sent = [];
  const off = browser.cdp.on((m) => {
    if (m.method === 'Network.requestWillBeSent' && m.params.request.method === 'POST' && new URL(m.params.request.url).pathname === '/api/v1/templates') sent.push(m.params.request.headers['x-skp-filename']);
  });
  t.after(off);
  await click(page, '[data-view] button', 'Install template');
  await page.waitFor('document.querySelector("dialog[open] input[type=file]")', 5000);
  await page.eval(`(() => {
    const bytes = Uint8Array.from(atob(${JSON.stringify(pkg.toString('base64'))}), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'Night pack – v1.skp', { type: 'application/zip' }));
    const input = document.querySelector('dialog[open] input[type=file]');
    input.files = dt.files;
    input.dispatchEvent(new Event('change'));
  })()`);
  await page.waitFor('[...document.querySelectorAll("dialog[open] button")].some((b) => b.textContent === "Install" && !b.disabled)', 10000);
  await click(page, 'dialog[open] button', 'Install');
  await page.waitFor('location.hash === "#/templates/dev.skp.named"', 10000);
  assert.deepEqual(sent, ['Night pack _ v1.skp'], 'its name, with what a header can\'t carry as _');
  assert.deepEqual(problems(page), []);
});

test('polling runs one loop however often the tab is hidden and shown (U7)', opts, async (t) => {
  const platform = await start(t);
  await people(platform);
  const { page } = await openPage(t, platform);
  await signIn(page, 'juan', '/connections');
  const out = await page.eval(`(async () => {
    const { every } = await import('/ui/dom.js');
    let state = 'visible';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
    let calls = 0;
    let running = 0;
    let most = 0;
    const stop = every(300, async () => {
      calls += 1;
      running += 1;
      most = Math.max(most, running);
      await new Promise((r) => setTimeout(r, 200));
      running -= 1;
    });
    for (let i = 0; i < 5; i++) {
      const c = calls;
      while (calls === c) await new Promise((r) => setTimeout(r, 5));
      state = 'hidden'; document.dispatchEvent(new Event('visibilitychange'));
      await new Promise((r) => setTimeout(r, 20));
      state = 'visible'; document.dispatchEvent(new Event('visibilitychange'));
    }
    const mark = calls;
    await new Promise((r) => setTimeout(r, 3000));
    const rate = calls - mark;
    stop();
    delete document.visibilityState;
    return { most, rate };
  })()`, 60000);
  assert.equal(out.most, 1, 'never two at once');
  assert.ok(out.rate <= 8, `one loop: about 6 calls in 3 s, got ${out.rate}`);
});

test('Live keeps updating when the timeline can\'t be read (U13), and its toggles are told apart (U16)', opts, async (t) => {
  const platform = await start(t);
  const owner = await people(platform);
  platform.overlays.create({ slug: 'diag', template: DIAG, settings: {} });
  const show = await owner('POST', '/shows', { name: 'Night', overlays: ['diag'], date: '2026-10-17', timezone: 'America/Toronto', lineup: [{ time: '21:00', name: 'Opener' }] });
  const { browser, page } = await openPage(t, platform);
  await signIn(page, 'juan');
  // Every read of the cues fails from now on.
  const off = browser.cdp.on((msg) => {
    if (msg.method !== 'Fetch.requestPaused') return;
    const body = Buffer.from(JSON.stringify({ type: 'about:blank', title: 'Forbidden', status: 403, detail: 'Not today.' })).toString('base64');
    page.send('Fetch.fulfillRequest', { requestId: msg.params.requestId, responseCode: 403, responseHeaders: [{ name: 'content-type', value: 'application/problem+json' }], body }).catch(() => {});
  });
  t.after(off);
  await page.send('Fetch.enable', { patterns: [{ urlPattern: '*/cues?*', requestStage: 'Request' }] });
  await go(page, `/live?show=${show.body.id}`, 'document.querySelector("[data-view] .countdown")');
  assert.equal((await owner('POST', `/shows/${show.body.id}/rec`, { action: 'start' })).status, 200);
  await page.waitFor('[...document.querySelectorAll("[data-view] .badge")].some((b) => b.textContent === "REC" && !b.hidden)', 8000);
  assert.match(await page.eval('document.querySelector("[data-view]").innerText'), /The timeline could not be read: Not today\./);
  const toggles = await page.eval('[...document.querySelectorAll("[data-view] button[aria-controls]")].map((b) => b.getAttribute("aria-label"))');
  assert.equal(new Set(toggles).size, toggles.length, toggles.join(', '));
  await page.send('Fetch.disable');
  assert.deepEqual(problems(page), []);
});

test('a list read before someone else changed it: users (C2), a show\'s members (U9), deletes with If-Match (U10)', opts, async (t) => {
  const platform = await start(t);
  const owner = await people(platform);
  platform.overlays.create({ slug: 'diag', template: DIAG, settings: {} });
  platform.overlays.create({ slug: 'other', template: DIAG, settings: {} });
  const show = await owner('POST', '/shows', { name: 'Night', overlays: ['diag'], date: '2026-10-17', timezone: 'America/Toronto', lineup: [{ time: '21:00', name: 'Opener' }] });
  const { browser, page } = await openPage(t, platform);
  await signIn(page, 'juan', '/settings/users');

  // op signs in elsewhere: their account's ETag moves. The first change says so; the next one works.
  await session(platform, 'op');
  const changeRole = async () => {
    await choose(page, 'More for op', 'Change role…');
    await page.waitFor('document.querySelector("dialog[open] select")', 5000);
    await page.eval('(() => { const s = document.querySelector("dialog[open] select"); s.value = "viewer"; document.querySelector("dialog[open] button[type=submit]").click(); })()');
  };
  await changeRole();
  await page.waitFor('[...document.querySelectorAll(".toast span")].some((s) => s.textContent.includes("changed since you opened this list"))', 8000);
  assert.equal((await owner('GET', '/users/op')).body.role, 'operator');
  await sleep(300);
  await changeRole();
  await page.waitFor('[...document.querySelectorAll(".toast span")].some((s) => s.textContent.startsWith("op is now viewer"))', 8000);
  assert.equal((await owner('GET', '/users/op')).body.role, 'viewer');

  // The show's Details, open while its overlay is renamed elsewhere: adding another still saves.
  await go(page, `/shows/${show.body.id}?tab=details`, '[...document.querySelectorAll("[data-view] button")].some((b) => b.textContent === "Save details")');
  const diag = await owner('GET', '/overlays/diag');
  assert.equal((await owner('PATCH', '/overlays/diag', { slug: 'diag-renamed' }, { 'if-match': diag.etag })).status, 200);
  await page.eval('[...document.querySelectorAll("[data-view] fieldset input[type=checkbox]")].find((i) => i.value === "other" || i.closest("label").textContent.includes("other")).click()');
  await click(page, '[data-view] button', 'Save details');
  await page.waitFor('[...document.querySelectorAll(".toast span")].some((s) => /^Saved the show.s overlays|There is no/.test(s.textContent))', 8000);
  assert.deepEqual((await toasts(page)).filter((s) => /There is no/.test(s)), []);
  assert.deepEqual([...(await owner('GET', `/shows/${show.body.id}`)).body.members].sort(), ['diag-renamed', 'other']);

  // Deleting a cue, then the show, sends what was read (H16).
  assert.equal((await owner('POST', `/shows/${show.body.id}/cues`, { at: '23:00', action: { type: 'media.stop' }, label: 'cue A' })).status, 201);
  await page.send('Network.enable');
  const deletes = [];
  const off = browser.cdp.on((m) => {
    if (m.method === 'Network.requestWillBeSent' && m.params.request.method === 'DELETE') deletes.push([new URL(m.params.request.url).pathname.split('/').slice(-2)[0], m.params.request.headers['If-Match'] || m.params.request.headers['if-match']]);
  });
  t.after(off);
  await go(page, `/shows/${show.body.id}?tab=timeline`, 'document.querySelector("[data-view] li details.menu")');
  await choose(page, 'More for cue A', 'Delete');
  await page.waitFor('document.querySelector("dialog[open]")', 5000);
  await click(page, 'dialog[open] button', 'Delete cue');
  await page.waitFor('[...document.querySelectorAll(".toast span")].some((s) => s.textContent === "Deleted the cue \\"cue A\\"")', 8000);
  await choose(page, 'More', 'Delete show');
  await page.waitFor('document.querySelector("dialog[open]")', 5000);
  await click(page, 'dialog[open] button', 'Delete show');
  await page.waitFor('location.hash === "#/shows"', 8000);
  assert.equal(deletes.length, 2);
  for (const [what, tag] of deletes) assert.match(String(tag), /^"[a-z]+_[0-9A-Za-z]+-r\d+"$/, `${what}: If-Match`);
  assert.deepEqual(problems(page), []);
});

test('something deleted elsewhere: saving says so plainly and shows it missing (U8)', opts, async (t) => {
  const platform = await start(t);
  const owner = await people(platform);
  platform.overlays.create({ slug: 'solo', template: DIAG, settings: {} });
  const show = await owner('POST', '/shows', { name: 'Doomed', overlays: [], date: '2026-10-17', timezone: 'UTC', lineup: [{ time: '21:00', name: 'Opener' }] });
  const { page } = await openPage(t, platform);
  await signIn(page, 'juan', '/overlays/solo');
  assert.ok((await owner('DELETE', '/overlays/solo', undefined, { 'if-match': (await owner('GET', '/overlays/solo')).etag })).status < 300);
  await choose(page, 'More', 'Reset to defaults…');
  await page.waitFor('document.querySelector("dialog[open]")', 5000);
  await click(page, 'dialog[open] button', 'Reset settings');
  await page.waitFor('document.querySelector("[data-view] h1")?.textContent === "There is no overlay \\"solo\\""', 8000);

  await go(page, `/shows/${show.body.id}?tab=lineup`, 'document.querySelector("[data-view] fieldset input[type=text]")');
  assert.ok((await owner('DELETE', `/shows/${show.body.id}`, undefined, { 'if-match': (await owner('GET', `/shows/${show.body.id}`)).etag })).status < 300);
  await page.eval('(() => { const i = document.querySelector("[data-view] fieldset input[type=text]"); i.value = "Later"; i.dispatchEvent(new Event("input", { bubbles: true })); })()');
  await click(page, '[data-view] button', 'Save lineup');
  await page.waitFor('document.querySelector("[data-view]").innerText.includes("There is no show \\"Doomed\\"")', 8000);
  const said = (await toasts(page)).join(' | ');
  assert.doesNotMatch(said, /ovl_|shw_/, said);
  assert.match(said, /"Doomed" was deleted meanwhile/);
  assert.deepEqual(problems(page), []);
});

test('what each role is offered and sees: the key (C4), everyone\'s tokens (C5), media users (C3), the name and logo (U11), going back a version (U18), audit words (U19)', opts, async (t) => {
  const platform = await start(t);
  const owner = await people(platform);
  // Two versions of a template, an overlay upgraded from the first: it can go back.
  const sample = (version) => packTemplate(DIAG_DIR, { manifest: { id: 'dev.skp.sample', name: 'Sample', version } });
  platform.templates.install(sample('1.0.0'), { actor: 'test' });
  platform.templates.install(sample('2.0.0'), { actor: 'test' });
  platform.overlays.create({ slug: 'old', template: { id: 'dev.skp.sample', version: '1.0.0' }, settings: {} });
  assert.equal((await owner('POST', '/overlays/old/upgrade', { version: '2.0.0', confirm: true })).status, 200);
  // A logo in a show's lineup; an operator's token.
  const logo = await owner('POST', '/media?name=logo.png', Buffer.from(PNG, 'base64'));
  assert.equal(logo.status, 201);
  assert.equal((await owner('POST', '/shows', { name: 'Night', overlays: ['old'], date: '2026-10-17', timezone: 'UTC', lineup: [{ time: '21:00', name: 'Opener', logo: logo.body.url }] })).status, 201);
  const op = await session(platform, 'op');
  assert.equal((await op('POST', '/tokens', { name: 'op deck', scopes: ['overlays:control'] })).status, 201);

  const { page } = await openPage(t, platform);
  await signIn(page, 'ad', '/overlays/old');
  // An admin can't let a URL work without its key: the choice says so, and is off.
  const keyItem = await page.eval('(() => { const b = [...document.querySelectorAll(".page-head [role=menuitem]")].find((x) => x.textContent.startsWith("Require the key")); return [b.textContent, b.disabled]; })()');
  assert.deepEqual(keyItem, ['Require the key in the URL: On (only the owner can turn it off)', true]);
  // Going back a version is in the version's menu, behind a danger confirmation.
  await page.eval('document.querySelector("#tab-version").click()');
  assert.equal(await page.eval('[...document.querySelectorAll("[data-view] button:not([role=menuitem])")].some((b) => b.textContent.startsWith("Go back"))'), false, 'no top-level Go back');
  await choose(page, 'More for the version', 'Go back to version 1.0.0…');
  await page.waitFor('document.querySelector("dialog[open]")', 5000);
  assert.match(await page.eval('document.querySelector("dialog[open]").innerText'), /every setting changed since is lost/);
  assert.equal(await page.eval('document.querySelector("dialog[open] .btn.danger")?.textContent'), 'Go back to 1.0.0');
  await click(page, 'dialog[open] button', 'Cancel');
  // Media: an overlay that uses a file is a link, a lineup is words.
  await go(page, '/media', 'document.querySelector("[data-view] article")');
  const used = await page.eval('(() => { const p = [...document.querySelectorAll("[data-view] article p")].find((x) => x.textContent.startsWith("Used by")); return { text: p.textContent, links: [...p.querySelectorAll("a")].map((a) => a.textContent) }; })()');
  assert.equal(used.text, 'Used by lineup of show Night');
  assert.deepEqual(used.links, []);

  // The owner: everyone's tokens, with whose they are, and Revoke.
  await page.eval('location.hash = "#/settings/account"');
  await page.waitFor('[...document.querySelectorAll("[data-view] button")].some((b) => b.textContent === "Sign out")', 10000);
  await click(page, '[data-view] button', 'Sign out');
  await signIn(page, 'juan', '/settings/tokens');
  await page.waitFor('document.querySelector("[data-view]").innerText.includes("Belongs to op")', 8000);
  await choose(page, 'More for token op deck of op', 'Revoke…');
  await page.waitFor('document.querySelector("dialog[open]")', 5000);
  await click(page, 'dialog[open] button', 'Revoke');
  await page.waitFor('document.querySelector("[data-view]").innerText.includes("Nobody else has an API token")', 8000);
  assert.deepEqual((await owner('GET', '/tokens?all=true')).body.items, []);

  // The name and logo: saving the name doesn't put back a logo someone else changed meanwhile.
  await go(page, '/settings/appearance', 'document.querySelector("[data-view] form input[type=text]")');
  assert.equal((await owner('PUT', '/system/settings', { logo: logo.body.url })).status, 200);
  await page.eval('(() => { const i = document.querySelector("[data-view] form input[type=text]"); i.value = "Night Club"; i.closest("form").requestSubmit(); })()');
  await page.waitFor('[...document.querySelectorAll(".toast span")].some((s) => s.textContent === "Installation name saved")', 8000);
  assert.deepEqual((await owner('GET', '/system/settings')).body, { name: 'Night Club', logo: logo.body.url });
  // The theme saved says which.
  await click(page, '[data-view] button', 'Dark');
  await page.waitFor('[...document.querySelectorAll(".toast span")].some((s) => s.textContent === "Theme: dark")', 8000);

  // The audit log in words: no internal ids, a choice of what to show rather than action names.
  await go(page, '/settings/audit', 'document.querySelector("[data-view] ul.list li")');
  const audit = await page.eval('({ text: document.querySelector("[data-view] ul.list").innerText, options: [...document.querySelectorAll("[data-view] select[name=action] option")].map((o) => o.textContent) })');
  assert.doesNotMatch(audit.text, /\b[a-z]{3}_[0-9A-Z]{26}\b|user\.create|token\.revoke/);
  assert.match(audit.text, /Revoked an API token/);
  assert.ok(audit.options.includes('Sign-ins, and failed ones'), audit.options.join(', '));
  await page.eval('(() => { const s = document.querySelector("[data-view] select[name=action]"); s.value = "token"; s.closest("form").requestSubmit(); })()');
  await page.waitFor('[...document.querySelectorAll("[data-view] ul.list li strong")].every((s) => /API token/.test(s.textContent))', 8000);
  assert.deepEqual(problems(page), []);
});
