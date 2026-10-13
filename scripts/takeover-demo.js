// The TAKEOVER template with a sample show: npm run demo [-- --port 4950]
//
// Starts a throwaway platform (its own temporary data directory) with four TAKEOVER overlays
// (landscape and vertical, in each look) and publishes a sample show the way shows will (step 9):
// a lineup with start times, the headliner, go-live in a few minutes, a REC anchor and a viewer
// count. Type a command and Enter to drive it, as an operator would from the admin UI:
//
//   <scene>        take a scene on every overlay: starting, program, brb, lineup, outro, bg,
//                  intro, headliner, line, pov, auto
//   title | np | opening | onat    fire the action (title card, now playing, schedule chips)
//   viewers        drop the viewer count to absent, or bring it back
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
const overlays = [
  ['takeover-h', {}],
  ['event-h', { look: 'event', address: '473 ADELAIDE ST W · TORONTO' }],
].map(([slug, settings]) => platform.overlays.create({ slug, template: TEMPLATE, settings }));

// A sample night: go-live in 3 minutes, a set an hour.
const MIN = 60000;
const goLive = Date.now() + 3 * MIN;
const label = (t) => { const d = new Date(t); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const slot = (offsetMin, name, extra = {}) => ({ time: label(goLive + offsetMin * MIN), startAt: goLive + offsetMin * MIN, name, ...extra });
const lineup = [
  slot(-60, 'Trapment'),
  slot(0, 'BIA', { b2b: 'DOLF' }),
  slot(60, 'VIKKSTAR', { headliner: true }),
  slot(120, 'UNDERCOVER', { closer: true }),
];
const set = (key, value) => platform.bus.setState(key, value);
set('show.lineup', lineup);
set('show.headliner', 'VIKKSTAR');
set('show.goLiveAt', goLive);
// The show's own (local) calendar date, not UTC's: in the evening UTC is already tomorrow.
const today = new Date();
set('show.date', `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`);
set('show.recStartedAt', Date.now() - 42 * MIN);
set('show.currentSlot', 0);
let viewers = 1159;
set('viewers.total', viewers);
const drift = setInterval(() => { if (viewers !== undefined) set('viewers.total', (viewers += Math.round(Math.random() * 20 - 8))); }, 5000);

const scene = (name, transition = 'fade') => {
  for (const o of overlays) {
    platform.bus.publish('show.scene.changed', { scene: name, transition }, { target: o.id });
    platform.bus.channel(o.id).setLocalState('show.scene', name);
  }
};
const action = (name, durationMs) => {
  for (const o of overlays) platform.bus.publish('show.trigger', { name, args: {}, startAt: Date.now() + 200, durationMs }, { target: o.id });
};

console.log('\nTAKEOVER overlays (browser sources):\n');
for (const o of overlays) {
  console.log(`  ${platform.url}/o/${o.data.slug}`);
  console.log(`  ${platform.url}/o/${o.data.slug}?canvas=v   (1080 x 1920)`);
}
console.log('\nCommands: starting program brb lineup outro bg intro headliner line pov auto · title np opening onat · viewers · Ctrl+C to stop\n');

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const cmd = line.trim();
  const actions = { title: ['titleCard', 7000], np: ['nowPlaying', 22000], opening: ['chipOpening', 10000], onat: ['chipOnAt', 10000] };
  if (actions[cmd]) action(...actions[cmd]);
  else if (cmd === 'viewers') { viewers = viewers === undefined ? 1159 : undefined; set('viewers.total', viewers); }
  else if (cmd) scene(cmd);
});

process.on('SIGINT', async () => {
  clearInterval(drift);
  rl.close();
  await platform.stop();
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  process.exit(0);
});
