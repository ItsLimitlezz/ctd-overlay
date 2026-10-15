// The admin UI in a real browser, quickly: node scripts/ui-smoke.js [routes…] [--phone] [--shots <dir>]
//
// Starts a throwaway platform (its own temporary data directory, in lan mode) with the TAKEOVER
// overlays, a show (and an overlay outside it), a pretend CTD Multi-Stream connected by pairing
// and an owner, signs in in headless Chrome or Edge (test/cdp.js), and opens each route
// (default: every section), printing per route the page's text and every console error,
// uncaught exception and CSP violation. --phone uses a 390 × 844 viewport; --shots saves a PNG
// per route there. Exits 1 if any route had a problem.
//
//   node scripts/ui-smoke.js /overlays /overlays/takeover --shots tmp/shots
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { startPlatform } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createLogger } from '../src/log.js';
import { BUILTIN } from '../src/connectors/registry.js';
import { launchBrowser } from '../test/cdp.js';
import { fakeConnector } from '../test/fixtures/connectors/fake.js';
import { startFakeMultistream } from '../test/fixtures/fake-multistream.mjs';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { phone: { type: 'boolean' }, shots: { type: 'string' }, wait: { type: 'string', default: '1500' } } });
const routes = positionals.length ? positionals : ['/live', '/live?show=<show>', '/live?show=<show>&overlay=takeover', '/live?overlay=solo', '/overlays', '/overlays/takeover', '/templates', '/templates/com.dprtmnt.takeover', '/shows', '/connections', '/connections/new/ctd-multistream', '/connections/<fake>', '/connections/<paired>', '/media', '/settings'];

const root = mkdtempSync(path.join(tmpdir(), 'skp-ui-'));
// On the LAN, as on the NAS: SKP_HOSTS is the address the OBS plugin gets overlay URLs at.
const config = loadConfig({ argv: ['--port', '0', '--data-dir', path.join(root, 'data'), '--config-dir', path.join(root, 'config'), '--exposure', 'lan', '--host', '127.0.0.1', '--hosts', '192.168.1.50:4850'], env: {} });
// The built-in connectors, and a test one signed in by a device code (no service behind it: its
// sign-in shows as needed), so the Connections pages have something on them.
const platform = await startPlatform(config, { log: createLogger({ level: 'error' }), connectors: { defs: [...BUILTIN, fakeConnector({ name: 'Test service', auth: 'device-code' }).def] } });
const OWNER = { username: 'demo', password: 'stream-kit-demo-night' };
await platform.auth.createOwner({ code: platform.auth.setupCode, ...OWNER }, { ip: '127.0.0.1' });

const TEMPLATE = { id: 'com.dprtmnt.takeover', version: '1.0.0' };
platform.overlays.create({ slug: 'takeover', template: TEMPLATE, settings: {} });
platform.overlays.create({ slug: 'event', template: TEMPLATE, settings: { look: 'event' } });
// An overlay outside the show: a stream of its own on Live.
platform.overlays.create({ slug: 'solo', template: TEMPLATE, settings: {} });
const MIN = 60000;
const pad = (n) => String(n).padStart(2, '0');
const local = (t) => { const d = new Date(t); return { date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, time: `${pad(d.getHours())}:${pad(d.getMinutes())}` }; };
const goLive = Date.now() + 3 * MIN;
const dayStart = local(goLive - 6 * 60 * MIN);
const slot = (offsetMin, name, extra = {}) => ({ time: local(goLive + offsetMin * MIN).time, name, ...extra });
const show = platform.shows.create({
  name: 'Saturday TAKEOVER', overlays: ['takeover', 'event'], date: dayStart.date, dayBoundary: dayStart.time,
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, goLive: local(goLive).time,
  lineup: [slot(-60, 'Trapment'), slot(0, 'BIA', { b2b: 'DOLF' }), slot(60, 'VIKKSTAR', { headliner: true }), slot(120, 'UNDERCOVER', { closer: true })],
}, { actor: 'smoke' });
platform.shows.take(show.id, 'auto', { transition: 'cut', actor: 'smoke' });
platform.bus.setState('viewers.total', 1159);
const fake = platform.connectors.create({ connector: 'fake', name: 'Test service', config: { behaviour: 'push', clientId: 'smoke-client' }, secrets: { clientSecret: 'smoke-secret-value' } });
platform.connectors.create({ connector: 'ctd-multistream', name: 'Multi-Stream (NAS)', enabled: false, config: { baseUrl: 'http://192.168.1.50:30080/api/v1' }, secrets: { token: 'ctd_pat_0123456789abcdefghijklmnop' } });
// A pretend CTD Multi-Stream, connected by pairing (approved for its DPRTMNT profile, live), so a
// stream shows its profile and the connection what it shares with the OBS plugin.
const ms = await startFakeMultistream();
ms.statuses['p-dprtmnt'].session.status = 'live';
const paired = platform.connectors.create({ connector: 'ctd-multistream', config: { baseUrl: `${ms.url}/api/v1` } });
await platform.connectors.authorize(paired.id, { who: { label: 'smoke' } });
ms.approve({ profileId: 'p-dprtmnt' });
for (let i = 0; i < 100 && platform.connectors.get(paired.id).info?.hub?.status !== 'shared'; i++) await new Promise((r) => setTimeout(r, 100));
const routeOf = (r) => r.replace('<fake>', fake.id).replace('<show>', show.id).replace('<paired>', paired.id);

let failed = false;
const browser = await launchBrowser();
try {
  const [width, height] = values.phone ? [390, 844] : [1280, 900];
  const page = await browser.open(`${platform.url}/#/login`, { width, height });
  await page.waitFor('document.querySelector("input[name=username]")', 10000);
  await page.eval(`fetch('/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(${JSON.stringify(OWNER)}) }).then((r) => r.status)`);
  if (values.shots) mkdirSync(values.shots, { recursive: true });
  for (const route of routes.map(routeOf)) {
    const before = page.problems.length;
    await page.goto(`${platform.url}/?r=${Date.now()}#${route}`);
    try {
      await page.waitFor('document.querySelector("[data-view]") && !document.querySelector("[data-view] > .loading")', 10000);
    } catch { /* reported below as still loading */ }
    await new Promise((r) => setTimeout(r, Number(values.wait)));
    const info = await page.eval('({ title: document.title, hash: location.hash, text: (document.querySelector("[data-view]")?.innerText || "").slice(0, 2000), overflow: document.documentElement.scrollWidth > innerWidth + 1 })');
    const problems = page.problems.slice(before);
    if (info.overflow) problems.push(`layout: the page scrolls sideways at ${width} px`);
    if (problems.length) failed = true;
    console.log(`\n=== ${route} → ${info.hash}  "${info.title}"`);
    console.log(info.text.split('\n').filter(Boolean).map((l) => `  | ${l}`).join('\n'));
    for (const p of problems) console.log(`  !! ${p}`);
    if (values.shots) {
      const file = path.join(values.shots, `${route.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '') || 'root'}${values.phone ? '.phone' : ''}.png`);
      writeFileSync(file, await page.screenshot());
      console.log(`  (screenshot: ${file})`);
    }
  }
} finally {
  await browser.close();
  await platform.stop();
  await ms.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}
process.exit(failed ? 1 : 0);
