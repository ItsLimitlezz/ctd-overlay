// A trusted proxy that forwards a request without naming the client (07 §7.8): the client is
// unknown, so outside, never the proxy's own address.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { startPlatform } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { defer, memoryLogger, tempDir } from './helpers.js';

const PASSWORD = 'correct horse battery staple';

test('public mode: a proxied setup with X-Forwarded-Proto and no X-Forwarded-For is refused, the code kept', async (t) => {
  const root = tempDir(t);
  const config = loadConfig({
    argv: ['--port', '0'],
    env: { SKP_DATA_DIR: path.join(root, 'data'), SKP_CONFIG_DIR: path.join(root, 'config'), SKP_EXPOSURE: 'public', SKP_HOST: '127.0.0.1', SKP_TRUST_PROXY: '127.0.0.1', SKP_PUBLIC_URL: 'https://overlays.example.com' },
  });
  const { log, entries } = memoryLogger();
  const platform = await startPlatform(config, { log, scrypt: { N: 1024 } });
  defer(t, () => platform.stop());
  const code = platform.auth.setupCode;
  const setup = (headers) => fetch(`${platform.url}/api/v1/setup`, {
    method: 'POST',
    headers: { host: 'overlays.example.com', origin: 'https://overlays.example.com', 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ code, username: 'juan', password: PASSWORD }),
  });
  for (const headers of [{ 'x-forwarded-proto': 'https' }, { 'x-forwarded-for': '', 'x-forwarded-proto': 'https' }]) {
    const res = await setup(headers);
    assert.equal(res.status, 403, JSON.stringify(headers));
    assert.equal((await res.json()).type, 'https://skp.dev/errors/setup-not-local');
  }
  assert.equal(platform.auth.setupCode, code, 'still valid');
  // The log says why, once, so the proxy gets fixed.
  const warned = entries.filter((e) => /without X-Forwarded-For/.test(e.msg));
  assert.equal(warned.length, 1, 'once per run');
  assert.equal(warned[0].context.proxy, '127.0.0.1');
  // Named, a client on the local network makes the owner.
  assert.equal((await setup({ 'x-forwarded-for': '192.168.1.5', 'x-forwarded-proto': 'https' })).status, 201);
});
