// Overlays in a real browser (installed Chrome or Edge, headless, driven over CDP; see cdp.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browserSkip, launchBrowser } from './cdp.js';
import { startWithOverlay } from './helpers.js';

test('the diagnostic overlay loads under the CSP, styles via <base>, and streams', { skip: browserSkip }, async (t) => {
  const { platform, base } = await startWithOverlay(t);
  const browser = await launchBrowser(t);
  const page = await browser.open(base, { width: 1920, height: 1080 });
  await page.waitFor('window.SK && SK.transport.mode === "stream"', 10000);
  // template.css is a relative URL: it only applies if the injected <base> points at the template.
  assert.equal(await page.eval('getComputedStyle(document.querySelector(".diag")).borderTopColor'), 'rgb(22, 224, 255)');
  platform.bus.setState('custom.diag.counter', 42);
  await page.waitFor('document.querySelector("[data-counter]").textContent === "42"');
  assert.deepEqual(page.problems, []);
});

test('a template\'s script can\'t reach the API, even in a browser signed in as the owner: the page has an origin of its own', { skip: browserSkip }, async (t) => {
  const { platform, base } = await startWithOverlay(t, { platform: { scrypt: { N: 1024 } } });
  const made = await fetch(`${platform.url}/api/v1/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: platform.auth.setupCode, username: 'juan', password: 'correct horse battery staple' }) });
  assert.equal(made.status, 201);
  const session = made.headers.get('set-cookie').split(';')[0].split('=')[1];
  const browser = await launchBrowser(t);
  const page = await browser.open(base);
  await page.send('Network.enable', {});
  await page.send('Network.setCookie', { name: 'skp_session', value: session, url: platform.url });
  await page.waitFor('window.SK && SK.transport.mode === "stream"', 10000);
  const tried = await page.eval(`(async () => {
    const out = { origin: self.origin };
    const attempt = async (key, url, init) => {
      try { out[key] = (await fetch(url, { credentials: 'include', ...init })).status; } catch { out[key] = 'blocked'; }
    };
    await attempt('session', '/api/v1/auth/session');
    await attempt('shows', '/api/v1/shows', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"name":"x"}' });
    await attempt('simulate', '/api/v1/overlays/diag-1/simulate', { method: 'POST', body: '{"kind":"follow"}' });
    return out;
  })()`);
  assert.deepEqual(tried, { origin: 'null', session: 'blocked', shows: 'blocked', simulate: 'blocked' });
  assert.deepEqual(platform.shows.list(), []);
  // The same cookie from the platform's own origin (the admin UI) does work.
  const own = await fetch(`${platform.url}/api/v1/auth/session`, { headers: { cookie: `skp_session=${session}`, origin: platform.url } });
  assert.equal(own.status, 200);
});

test('the CSP really blocks inline scripts and third-party fetches in an overlay', { skip: browserSkip }, async (t) => {
  const { base } = await startWithOverlay(t);
  const browser = await launchBrowser(t);
  const page = await browser.open(base);
  await page.waitFor('window.SK && SK.transport.mode !== "connecting"', 10000);
  const blocked = await page.eval(`(async () => {
    const s = document.createElement('script');
    s.textContent = 'window.__inline = true';
    document.head.appendChild(s);
    let fetched = 'no';
    try { await fetch('https://example.com/'); fetched = 'yes'; } catch { fetched = 'blocked'; }
    return { inline: window.__inline === true, fetched };
  })()`);
  assert.deepEqual(blocked, { inline: false, fetched: 'blocked' });
  assert.ok(page.problems.some((p) => /Content Security Policy/i.test(p)), 'the browser reported the violations');
});
