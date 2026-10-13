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
