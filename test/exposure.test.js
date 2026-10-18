// Safe to expose (07 §7.6–7.10): secrets at rest, overlay keys, the lan and public modes behind a
// trusted proxy, built-in TLS, and the hardening headers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { request } from 'node:https';
import path from 'node:path';
import { startPlatform } from '../src/app.js';
import { run } from '../src/cli.js';
import { loadConfig } from '../src/config.js';
import { clientOf } from '../src/net.js';
import { createSecrets, keyId, loadMasterKey } from '../src/secrets.js';
import { openStore } from '../src/store/index.js';
import { defer, FIXTURE_TEMPLATES, memoryLogger, signedIn, tempDir, TESTBED } from './helpers.js';
import { selfSigned } from './tls.js';

const PASSWORD = 'correct horse battery staple';

async function start(t, { dataRoot = tempDir(t), env = {} } = {}) {
  const config = loadConfig({ argv: ['--port', '0'], env: { SKP_DATA_DIR: path.join(dataRoot, 'data'), SKP_CONFIG_DIR: path.join(dataRoot, 'config'), ...env } });
  const { log, entries } = memoryLogger();
  const platform = await startPlatform(config, { log, templateDirs: [FIXTURE_TEMPLATES], scrypt: { N: 1024 } });
  defer(t, () => platform.stop());
  return { platform, config, entries, dataRoot };
}

test('secrets at rest: AES-256-GCM bound to their record, with the key\'s id; a master key made once, 0600', async (t) => {
  const dir = tempDir(t);
  const config = { configDir: dir };
  const { log, entries } = memoryLogger();
  const first = loadMasterKey(config, { log });
  assert.equal(first.source, 'file');
  assert.ok(entries.some((e) => /Made a new master key/.test(e.msg) && /back it up/.test(e.msg)));
  if (process.platform !== 'win32') assert.equal(statSync(first.file).mode & 0o777, 0o600);
  assert.equal(loadMasterKey(config, { log }).kid, first.kid, 'the same key next time');
  const s = createSecrets(first);
  const sealed = s.encrypt('skp_ovl_secret', 'ovl_A');
  assert.match(sealed, new RegExp(`^enc:v1:${first.kid}:`));
  assert.equal(s.decrypt(sealed, 'ovl_A'), 'skp_ovl_secret');
  assert.notEqual(s.encrypt('x', 'a'), s.encrypt('x', 'a'), 'a fresh nonce each time');
  assert.throws(() => s.decrypt(sealed, 'ovl_B'), /another record/);
  assert.throws(() => s.decrypt(sealed.slice(0, -2) + (sealed.endsWith('AA') ? 'BB' : 'AA'), 'ovl_A'), /changed/);
  const other = createSecrets({ key: Buffer.alloc(32, 9) });
  assert.throws(() => other.decrypt(sealed, 'ovl_A'), /restore that master key/);
  assert.equal(keyId(Buffer.alloc(32, 9)).length, 8);
  assert.throws(() => loadMasterKey({ masterKeyFile: path.join(dir, 'missing') }), /Can't read the master key file/);
});

test('overlay keys: the page and its data need the key; files don\'t; rotate, and "no key required" (not in public mode)', async (t) => {
  const { platform, config } = await start(t);
  platform.overlays.create({ slug: 'main', template: TESTBED, settings: {} });
  const key = platform.overlays.key('main');
  assert.match(key, /^skp_ovl_[0-9A-Za-z]{33}$/);
  const o = (p, k) => fetch(`${platform.url}/o/main${p}${k ? `${p.includes('?') ? '&' : '?'}key=${k}` : ''}`);
  for (const p of ['', '/snapshot', '/poll?cursor=0', '/stream']) {
    const res = await o(p, undefined);
    assert.equal(res.status, 401, p);
    assert.equal((await res.json()).type, 'https://skp.dev/errors/overlay-key');
    assert.equal((await o(p, 'skp_ovl_wrong')).status, 401);
  }
  const page = await o('', key);
  assert.equal(page.status, 200);
  await page.text();
  assert.equal((await o('/snapshot', key)).status, 200);
  assert.equal((await fetch(`${platform.url}/o/main/log`, { method: 'POST', body: '{"entries":[]}' })).status, 401);
  const build = platform.templates.get(TESTBED.id, TESTBED.version).build;
  assert.equal((await fetch(`${platform.url}/o/main/t/${build}/template.css`)).status, 200, 'template files need no key');
  // Its URL, over the API; then a new key.
  const api = (method, p, body) => fetch(`${platform.url}/api/v1${p}`, { method, headers: signedIn(platform, body ? { 'content-type': 'application/json' } : {}), body: body && JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));
  const urls = (await api('GET', '/overlays/main/url')).body.urls;
  assert.deepEqual(urls.map((u) => u.canvas), ['h', 'v']);
  assert.equal(urls[0].url, `${platform.url}/o/main?key=${key}`);
  assert.equal(urls[1].url, `${platform.url}/o/main?key=${key}&canvas=v`);
  const rotated = await api('POST', '/overlays/main/key/rotate', {});
  const fresh = platform.overlays.key('main');
  assert.notEqual(fresh, key);
  assert.match(rotated.body.note, /update the OBS browser sources/);
  assert.equal((await o('/snapshot', key)).status, 401, 'the old URL stops working');
  assert.equal((await o('/snapshot', fresh)).status, 200);
  assert.equal((await api('PATCH', '/overlays/main', { keyRequired: false })).body.keyRequired, false);
  assert.equal((await o('/snapshot', undefined)).status, 200);
  assert.equal((await api('PATCH', '/overlays/main', { name: 'x' })).status, 422, 'an unknown field');
  assert.equal((await api('GET', '/overlays/nope/url')).status, 404);
  assert.deepEqual(platform.audit.list({ action: 'overlay' }).items.map((e) => e.action), ['overlay.key-required', 'overlay.key-rotate']);
  // Stored encrypted: the key itself is nowhere in the store.
  await platform.stop();
  const store = openStore({ dataDir: config.dataDir, backend: config.store });
  const dump = JSON.stringify(store.list('overlays', { limit: 100 }));
  store.close();
  assert.ok(!dump.includes(fresh) && dump.includes('enc:v1:'));
});

test('skp overlay url | rotate-key | key, and skp key rotate: secrets survive a new master key', async (t) => {
  const { platform, config, dataRoot } = await start(t);
  platform.overlays.create({ slug: 'main', template: TESTBED, settings: {} });
  const env = { SKP_DATA_DIR: config.dataDir, SKP_CONFIG_DIR: config.configDir, SKP_PORT: String(platform.port) };
  const cli = async (argv) => {
    let stdout = '';
    let stderr = '';
    const code = await run(argv, { stdout: { write: (s) => { stdout += s; } }, stderr: { write: (s) => { stderr += s; } }, env });
    return { code, stdout, stderr };
  };
  const url = await cli(['overlay', 'url', 'main']);
  assert.match(url.stdout, /^h: http:\/\/127\.0\.0\.1:\d+\/o\/main\?key=skp_ovl_\w{33}\nv: .*&canvas=v\n$/);
  const rotated = await cli(['overlay', 'rotate-key', 'main']);
  assert.match(rotated.stderr, /old URL no longer works/);
  assert.match((await cli(['overlay', 'key', 'main', 'not-required'])).stdout, /^main: no key required/);
  assert.match((await cli(['overlay', 'key', 'main', 'required'])).stdout, /^main: its URL needs its key\n$/);
  const key = platform.overlays.key('main');
  await platform.stop();
  const before = loadMasterKey(config).kid;
  const r = await cli(['key', 'rotate']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /1 secret re-encrypted/);
  assert.notEqual(loadMasterKey(config).kid, before);
  assert.ok(readdirSync(config.configDir).includes(`master.key.${before}.retired`));
  const back = await start(t, { dataRoot });
  assert.equal(back.platform.overlays.key('main'), key, 'the same key, under the new master key');
  const fromEnv = await run(['key', 'rotate'], { stdout: { write() {} }, stderr: { write() {} }, env: { ...env, SKP_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') } });
  assert.notEqual(fromEnv, 0);
});

test('a client behind a trusted proxy: X-Forwarded-* believed from it only', () => {
  const req = (peer, headers = {}) => ({ socket: { remoteAddress: peer }, headers });
  assert.deepEqual(clientOf(req('10.0.0.2', { 'x-forwarded-for': '8.8.8.8' }), ['10.0.0.2']), { ip: '8.8.8.8', https: false, proxied: true });
  assert.deepEqual(clientOf(req('10.0.0.2', { 'x-forwarded-for': '1.1.1.1, 8.8.8.8, 10.0.0.3', 'x-forwarded-proto': 'https' }), ['10.0.0.2', '10.0.0.3']), { ip: '8.8.8.8', https: true, proxied: true }, 'from the right, past trusted proxies');
  assert.deepEqual(clientOf(req('::ffff:192.168.1.9', { 'x-forwarded-for': '8.8.8.8' }), ['10.0.0.2']), { ip: '192.168.1.9', https: false, proxied: false }, 'anyone else\'s is ignored');
});

test('lan mode serves the local network only; public mode answers outsiders over HTTPS only, with HSTS and __Host- cookies', async (t) => {
  const lan = await start(t, { env: { SKP_EXPOSURE: 'lan', SKP_HOST: '127.0.0.1', SKP_TRUST_PROXY: '127.0.0.1' } });
  const via = (p, client, headers = {}) => fetch(`${p.url}/api/v1/setup`, { headers: { 'x-forwarded-for': client, ...headers } });
  assert.equal((await via(lan.platform, '8.8.8.8')).status, 403);
  assert.equal((await via(lan.platform, '192.168.1.5')).status, 200);
  assert.equal((await via(lan.platform, '100.101.102.103')).status, 200, 'a VPN such as Tailscale counts as local');
  // A port forward without TLS, opened on purpose: the internet gets in too, and it is said.
  const open = await start(t, { env: { SKP_EXPOSURE: 'lan', SKP_HOST: '127.0.0.1', SKP_TRUST_PROXY: '127.0.0.1', SKP_ALLOW_PLAIN_INTERNET: 'true' } });
  assert.equal((await via(open.platform, '8.8.8.8')).status, 200);
  assert.match(open.platform.config.warnings.join(' '), /SKP_ALLOW_PLAIN_INTERNET is on/);
  assert.throws(() => loadConfig({ argv: [], env: { SKP_EXPOSURE: 'public', SKP_TRUST_PROXY: '127.0.0.1', SKP_PUBLIC_URL: 'https://o.example.com', SKP_ALLOW_PLAIN_INTERNET: 'true' } }), /only for SKP_EXPOSURE=lan/);
  assert.throws(() => loadConfig({ argv: [], env: { SKP_ALLOW_PLAIN_INTERNET: 'true' } }), /only for SKP_EXPOSURE=lan/);
  const pub = await start(t, { env: { SKP_EXPOSURE: 'public', SKP_HOST: '127.0.0.1', SKP_TRUST_PROXY: '127.0.0.1', SKP_PUBLIC_URL: 'https://overlays.example.com' } });
  const plain = await via(pub.platform, '8.8.8.8', { 'x-forwarded-proto': 'http' });
  assert.equal(plain.status, 403);
  assert.match((await plain.json()).detail, /https:\/\/overlays\.example\.com/);
  const outside = { 'x-forwarded-for': '8.8.8.8', 'x-forwarded-proto': 'https', host: 'overlays.example.com', origin: 'https://overlays.example.com', 'content-type': 'application/json' };
  const setup = (headers) => fetch(`${pub.platform.url}/api/v1/setup`, { method: 'POST', headers, body: JSON.stringify({ code: pub.platform.auth.setupCode, username: 'juan', password: PASSWORD }) });
  assert.equal((await setup(outside)).status, 403, 'a stranger with the code can\'t claim it (07 §7.2)');
  const made = await setup({ ...outside, 'x-forwarded-for': '192.168.1.5' });
  assert.equal(made.status, 201, 'the public name is one of the platform\'s own; the owner is made from the local network');
  assert.equal(made.headers.get('strict-transport-security'), 'max-age=31536000');
  assert.match(made.headers.get('set-cookie'), /^__Host-skp_session=[\w-]{43}; HttpOnly; SameSite=Lax; Path=\/; Secure$/);
  const session = made.headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(`${pub.platform.url}/api/v1/auth/session`, { headers: { ...outside, cookie: session } })).status, 200);
  // Through the proxy, the local token is no use: whoever is behind it isn't on this machine.
  const forwarded = await fetch(`${pub.platform.url}/api/v1/shows`, { headers: signedIn(pub.platform, { 'x-forwarded-for': '192.168.1.5' }) });
  assert.equal(forwarded.status, 401);
  // The API's own headers (07 §7.10).
  assert.match(made.headers.get('content-security-policy'), /^default-src 'self'; frame-ancestors 'none'; object-src 'none'/);
  assert.equal(made.headers.get('cross-origin-opener-policy'), 'same-origin');
});

test('built-in TLS: the platform serves HTTPS with its certificate', async (t) => {
  const dir = tempDir(t);
  const { cert, key } = selfSigned();
  writeFileSync(path.join(dir, 'cert.pem'), cert);
  writeFileSync(path.join(dir, 'key.pem'), key);
  const { platform } = await start(t, { env: { SKP_TLS_CERT: path.join(dir, 'cert.pem'), SKP_TLS_KEY: path.join(dir, 'key.pem') } });
  assert.match(platform.url, /^https:\/\/127\.0\.0\.1:\d+$/);
  const res = await new Promise((resolve, reject) => {
    const req = request(`${platform.url}/healthz`, { rejectUnauthorized: false }, (r) => {
      let body = '';
      r.on('data', (c) => { body += c; });
      r.on('end', () => resolve({ status: r.statusCode, body, hsts: r.headers['strict-transport-security'] }));
    });
    req.on('error', reject);
    req.end();
  });
  assert.deepEqual(res, { status: 200, body: 'ok', hsts: 'max-age=31536000' });
  assert.ok(existsSync(path.join(dir, 'cert.pem')) && readFileSync(path.join(dir, 'cert.pem'), 'utf8').startsWith('-----BEGIN CERTIFICATE-----'));
});
