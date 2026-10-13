// The transport test rig: npm run diag [-- --count 8 --port 4949]
//
// Starts a throwaway platform (its own temporary data directory) with N diagnostic overlays,
// publishes an event every second and changes a state value every three, and prints the URLs
// to add to OBS as browser sources. Each overlay shows whether it is streaming or polling
// (01 §1.5), how many envelopes arrived, and the server clock.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { startPlatform } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createLogger } from '../src/log.js';

const { values } = parseArgs({ options: { count: { type: 'string', default: '8' }, port: { type: 'string', default: '4949' } } });
const count = Math.max(1, Math.min(32, Number(values.count) || 8));

const root = mkdtempSync(path.join(tmpdir(), 'skp-diag-'));
const config = loadConfig({
  argv: ['--port', values.port, '--data-dir', path.join(root, 'data'), '--config-dir', path.join(root, 'config')],
  env: {},
});
const log = createLogger({ level: 'warn' });
const platform = await startPlatform(config, { log });

for (let i = 1; i <= count; i++) {
  platform.overlays.create({ slug: `diag-${i}`, template: { id: 'dev.skp.diagnostic', version: '1.0.0' } });
}

let n = 0;
const tick = setInterval(() => {
  n++;
  platform.bus.publish('custom.diag.tick', { n });
  if (n % 3 === 0) platform.bus.setState('custom.diag.counter', n / 3);
}, 1000);

console.log(`\nDiagnostic overlays (browser sources, 1920 x 1080):\n`);
for (let i = 1; i <= count; i++) console.log(`  ${platform.url}/o/diag-${i}`);
console.log(`\nAll of them should load and keep counting. Four per browser show "stream" in green; the rest`);
console.log(`show "poll" in amber, because over plain HTTP a browser keeps only six connections per host`);
console.log(`and the server leaves two free for page loads and polls (01 §1.5). Ctrl+C to stop.\n`);

process.on('SIGINT', async () => {
  clearInterval(tick);
  await platform.stop();
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  process.exit(0);
});
