// Sign-in on an exposed platform (07 §7.2, §7.3, §7.8, §7.12): public mode behind a trusted proxy
// on this machine. Setup only from this machine or its network; the client behind the proxy is
// who the audit log, the sessions and login protection see; the command line still works beside
// the proxy, but never through it; over HTTPS only the __Host- cookie counts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { startPlatform } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { defer, memoryLogger, signedIn, tempDir } from './helpers.js';

const PASSWORD = 'correct horse battery staple';

async function behindProxy(t) {
  const root = tempDir(t);
  const config = loadConfig({ argv: ['--port', '0'], env: { SKP_DATA_DIR: path.join(root, 'data'), SKP_CONFIG_DIR: path.join(root, 'config'), SKP_EXPOSURE: 'public', SKP_HOST: '127.0.0.1', SKP_TRUST_PROXY: '127.0.0.1', SKP_PUBLIC_URL: 'https://overlays.example.com' } });
  const platform = await startPlatform(config, { log: memoryLogger().log, scrypt: { N: 1024 } });
  defer(t, () => platform.stop());
  // A request as the proxy forwards it: from this client, over this scheme, to the public name.
  const via = (client, proto = 'https') => async (method, url, body, headers = {}) => {
    const res = await fetch(`${platform.url}/api/v1${url}`, {
      method,
      headers: { 'x-forwarded-for': client, 'x-forwarded-proto': proto, host: 'overlays.example.com', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null), cookies: res.headers.getSetCookie() };
  };
  return { platform, via };
}

test('public mode: the owner is made from this machine or its network only, never by a stranger with the code', async (t) => {
  const { platform, via } = await behindProxy(t);
  const code = platform.auth.setupCode;
  const stranger = await via('8.8.8.8')('POST', '/setup', { code, username: 'stranger', password: PASSWORD });
  assert.deepEqual([stranger.status, stranger.body.type], [403, 'https://skp.dev/errors/setup-not-local']);
  assert.match(stranger.body.detail, /skp setup/);
  assert.equal(platform.auth.setupCode, code, 'refused before the code is tried: still valid');
  assert.equal(platform.auth.setupNeeded(), true);
  const made = await via('192.168.1.5')('POST', '/setup', { code, username: 'juan', password: PASSWORD });
  assert.equal(made.status, 201);
  assert.equal(made.body.user.username, 'juan');
});

test('behind the proxy, the audit log, the sessions and login protection see the client, not the proxy', async (t) => {
  const { platform, via } = await behindProxy(t);
  const lan = via('192.168.1.5');
  const made = await lan('POST', '/setup', { code: platform.auth.setupCode, username: 'juan', password: PASSWORD });
  assert.equal(made.status, 201);
  const cookie = made.cookies[0].split(';')[0];
  for (let i = 0; i < 10; i++) assert.equal((await via('9.9.9.9')('POST', '/auth/login', { username: `nobody${i}`, password: 'wrong password!' })).status, 401);
  assert.equal((await via('9.9.9.9')('POST', '/auth/login', { username: 'juan', password: PASSWORD })).status, 429, 'that client waits');
  assert.equal((await via('8.8.4.4')('POST', '/auth/login', { username: 'juan', password: PASSWORD })).status, 200, 'not everyone behind the proxy');
  assert.deepEqual([...new Set(platform.audit.list({ action: 'login.failure', limit: 20 }).items.map((e) => e.ip))], ['9.9.9.9']);
  assert.equal(platform.audit.list({ action: 'setup' }).items[0].ip, '192.168.1.5');
  const mine = (await lan('GET', '/auth/sessions', undefined, { cookie })).body.items;
  assert.deepEqual(mine.map((s) => s.ip), ['8.8.4.4', '192.168.1.5']);
});

test('the command line works beside a proxy this platform trusts, and never through it', async (t) => {
  const { platform } = await behindProxy(t);
  const direct = await fetch(`${platform.url}/api/v1/users`, { headers: signedIn(platform) });
  assert.equal(direct.status, 200, 'from this machine, with no forwarding headers');
  for (const headers of [{ 'x-forwarded-proto': 'https' }, { 'x-forwarded-for': '127.0.0.1' }, { 'x-forwarded-for': '192.168.1.5', 'x-forwarded-proto': 'http' }]) {
    const through = await fetch(`${platform.url}/api/v1/users`, { headers: signedIn(platform, headers) });
    assert.equal(through.status, 401, JSON.stringify(headers));
    assert.match((await through.json()).detail, /only from this machine/);
  }
});

test('over HTTPS only the __Host- cookie signs in, and signing out there clears both', async (t) => {
  const { platform, via } = await behindProxy(t);
  const plain = via('192.168.1.5', 'http');
  const secure = via('192.168.1.5', 'https');
  const made = await plain('POST', '/setup', { code: platform.auth.setupCode, username: 'juan', password: PASSWORD });
  const http = made.cookies[0].split(';')[0];
  assert.match(http, /^skp_session=/);
  assert.equal((await plain('GET', '/auth/session', undefined, { cookie: http })).status, 200);
  assert.equal((await secure('GET', '/auth/session', undefined, { cookie: http })).status, 401, 'a cookie plain HTTP could have planted');
  const signed = await secure('POST', '/auth/login', { username: 'juan', password: PASSWORD });
  const https = signed.cookies[0].split(';')[0];
  assert.match(https, /^__Host-skp_session=/);
  const both = `${http}; ${https}`;
  const out = await secure('POST', '/auth/logout', {}, { cookie: both, 'x-skp-csrf': signed.body.csrf, origin: 'https://overlays.example.com' });
  assert.equal(out.status, 200);
  assert.deepEqual(out.cookies.map((c) => c.split(';')[0]), ['__Host-skp_session=', 'skp_session=']);
  assert.equal((await secure('GET', '/auth/session', undefined, { cookie: both })).status, 401);
});
