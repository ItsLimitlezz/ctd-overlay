import { test } from 'node:test';
import { launchBrowser } from './cdp.js';
import { startWithOverlay } from './helpers.js';
test('probe', async (t) => {
  const { base } = await startWithOverlay(t);
  let t0 = Date.now();
  const browser = await launchBrowser(t);
  console.log('launch', Date.now() - t0); t0 = Date.now();
  const page = await browser.open(base);
  await page.waitFor('window.SK && SK.transport.mode === "stream"', 10000);
  console.log('open+stream', Date.now() - t0);
  console.log(JSON.stringify(page.problems));
  t0 = Date.now();
  await browser.close();
  console.log('close', Date.now() - t0);
});