// The names the platform answers to (07 §7.8), as a request meets them: a Host that isn't among
// the machine's names has them read again at once (at most once a second), not after the
// five-second refresh.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import path from 'node:path';
import { startPlatform } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { defer, memoryLogger, tempDir } from './helpers.js';

test('an address that arrives after startup is accepted on its first request a second later', async (t) => {
  let ifaces = { lo: [{ address: '127.0.0.1', family: 'IPv4' }] };
  let reads = 0;
  let now = 1_700_000_000_000;
  const root = tempDir(t);
  const config = loadConfig({ argv: ['--port', '0'], env: { SKP_DATA_DIR: path.join(root, 'data'), SKP_CONFIG_DIR: path.join(root, 'config'), SKP_EXPOSURE: 'lan', SKP_HOST: '127.0.0.1' } });
  const platform = await startPlatform(config, { log: memoryLogger().log, interfaces: () => { reads++; return ifaces; }, clock: { now: () => now } });
  defer(t, () => platform.stop());
  // node:http, which sends the Host it is given (fetch sends the URL's).
  const as = (host) => new Promise((resolve, reject) => {
    request(`${platform.url}/api/v1/setup`, { headers: { host: `${host}:${platform.port}` } }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject).end();
  });
  ifaces = { ...ifaces, wlan0: [{ address: '192.168.1.77', family: 'IPv4' }] };
  assert.equal(await as('192.168.1.77'), 403, 'read less than a second ago: not yet');
  now += 1000;
  assert.equal(await as('192.168.1.77'), 200, 'read again for the Host it lacked');
  const before = reads;
  assert.equal(await as('evil.example'), 403);
  assert.equal(reads, before, 'a made-up Host within the second reads nothing');
});
