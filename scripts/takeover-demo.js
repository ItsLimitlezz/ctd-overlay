// The TAKEOVER template with a sample show: npm run demo [-- --port 4950]
//
// Starts a throwaway platform (its own temporary data directory) with two TAKEOVER overlays, one
// in each look, as the members of one show: a lineup, the headliner, go-live in three minutes
// with the "auto" scene on air (it counts down, then goes live, and REC starts by itself), and a
// viewer count. Type a command and Enter to drive it, as an operator would from the admin UI:
//
//   <scene>        take a scene on the show: starting, program, brb, lineup, outro, bg, intro,
//                  headliner, line, pov, auto
//   title | np | opening | onat    fire the action (title card, now playing, schedule chips)
//   next           the next act is on
//   rec            restart the REC timer
//   viewers        drop the viewer count to absent, or bring it back
//
// The same show answers the command line while this runs: npm run skp -- show list --port 4950.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { startPlatform } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createLogger } from '../src/log.js';

const { values } = parseArgs({ options: { port: { type: 'string', default: '4950' } } });
const root = mkdtempSync(path.join(tmpdir(), 'skp-demo-'));
const config = loadConfig({ argv: ['--port', values.port, '--data-dir', path.join(root, 'data'), '--config-dir', path.join(root, 'config')], env: {} });
const platform = await startPlatform(config, { log: createLogger({ level: 'warn' }) });

const TEMPLATE = { id: 'com.dprtmnt.takeover', version: '1.0.0' };
for (const [slug, settings] of [['takeover', {}], ['event', { look: 'event', address: '473 ADELAIDE ST W · TORONTO' }]]) {
  platform.overlays.create({ slug, template: TEMPLATE, settings });
}

// A sample night in this machine's timezone: go-live in 3 minutes, a set an hour. The show's day
// starts six hours before go-live, so every time below falls on it whenever the demo runs.
const MIN = 60000;
const pad = (n) => String(n).padStart(2, '0');
const local = (t) => { const d = new Date(t); return { date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, time: `${pad(d.getHours())}:${pad(d.getMinutes())}` }; };
const goLive = Date.now() + 3 * MIN;
const dayStart = local(goLive - 6 * 60 * MIN);
const slot = (offsetMin, name, extra = {}) => ({ time: local(goLive + offsetMin * MIN).time, name, ...extra });
const show = platform.shows.create({
  name: 'Saturday TAKEOVER',
  overlays: ['takeover', 'event'],
  date: dayStart.date,
  dayBoundary: dayStart.time,
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  goLive: local(goLive).time,
  lineup: [slot(-60, 'Trapment'), slot(0, 'BIA', { b2b: 'DOLF' }), slot(60, 'VIKKSTAR', { headliner: true }), slot(120, 'UNDERCOVER', { closer: true })],
}, { actor: 'demo' });
platform.shows.take(show.id, 'auto', { transition: 'cut', actor: 'demo' });

let viewers = 1159;
platform.bus.setState('viewers.total', viewers);
const drift = setInterval(() => { if (viewers !== undefined) platform.bus.setState('viewers.total', (viewers += Math.round(Math.random() * 20 - 8))); }, 5000);

console.log('\nTAKEOVER overlays (browser sources):\n');
for (const slug of ['takeover', 'event']) {
  const [h, v] = platform.overlays.urls(slug, platform.url);
  console.log(`  ${h.url}`);
  if (v) console.log(`  ${v.url}   (1080 x 1920)`);
}
console.log('\nCommands: starting program brb lineup outro bg intro headliner line pov auto · title np opening onat · next · rec · viewers · Ctrl+C to stop\n');

const ACTIONS = { title: 'titleCard', np: 'nowPlaying', opening: 'chipOpening', onat: 'chipOnAt' };
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const cmd = line.trim();
  try {
    if (ACTIONS[cmd]) platform.shows.trigger(show.id, ACTIONS[cmd], { actor: 'demo' });
    else if (cmd === 'next') {
      const s = platform.shows.get(show.id);
      platform.shows.setSlot(show.id, ((s.currentSlot ?? -1) + 1) % s.lineup.length);
    } else if (cmd === 'rec') platform.shows.rec(show.id, 'start');
    else if (cmd === 'viewers') {
      viewers = viewers === undefined ? 1159 : undefined;
      platform.bus.setState('viewers.total', viewers);
    } else if (cmd) platform.shows.take(show.id, cmd, { actor: 'demo' });
  } catch (err) {
    console.log(`  ${err.message}`);
  }
});

process.on('SIGINT', async () => {
  clearInterval(drift);
  rl.close();
  await platform.stop();
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  process.exit(0);
});
