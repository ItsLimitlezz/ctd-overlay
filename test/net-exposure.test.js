// Exposure, the network side (07 §7.7–7.11): which addresses are private, who a request comes
// from behind a proxy, the names the platform answers to as the machine's addresses change, the
// command line reaching the platform in every mode, and master keys the command line and an
// interrupted rotation must not lose.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:net';
import path from 'node:path';
import { openData, startPlatform } from '../src/app.js';
import { run } from '../src/cli.js';
import { loadConfig } from '../src/config.js';
import { clientOf, isPrivateAddress, liveMachineNames, pinnedFetch } from '../src/net.js';
import { createSecrets, loadMasterKey, rotateMasterKey, writeKeyFile } from '../src/secrets.js';
import { openStore } from '../src/store/index.js';
import { DIAG, defer, FIXTURE_TEMPLATES, memoryLogger, signedIn, tempDir } from './helpers.js';
import { selfSigned } from './tls.js';

function dirsEnv(t, env = {}) {
  const root = tempDir(t);
  return { root, env: { SKP_DATA_DIR: path.join(root, 'data'), SKP_CONFIG_DIR: path.join(root, 'config'), ...env } };
}

async function start(t, env = {}, options = {}) {
  const d = dirsEnv(t, env);
  const config = loadConfig({ argv: ['--port', '0'], env: d.env });
  const { log, entries } = memoryLogger();
  const platform = await startPlatform(config, { log, templateDirs: [FIXTURE_TEMPLATES], scrypt: { N: 1024 }, ...options });
  defer(t, () => platform.stop());
  return { platform, config, entries, env: { ...d.env, SKP_PORT: String(platform.port) }, root: d.root };
}

async function cli(argv, env) {
  let stdout = '';
  let stderr = '';
  const code = await run(argv, { stdout: { write: (s) => { stdout += s; } }, stderr: { write: (s) => { stderr += s; } }, env });
  return { code, stdout, stderr };
}

test('private addresses: 192.0.0.0/24 and 192.0.2.0/24 only, and IPv4-mapped IPv6 however it is written', () => {
  for (const ip of ['192.0.0.8', '192.0.2.1', '192.168.1.1', '::ffff:192.0.2.5', '::ffff:7f00:1', '::ffff:c0a8:101', '0:0:0:0:0:ffff:a9fe:a9fe', '::FFFF:127.0.0.1', '0:0:0:0:0:0:0:1', '::7f00:1', 'FD00::2']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ['192.0.78.9', '192.0.32.8', '192.0.64.1', '192.0.255.1', '8.8.8.8', '::ffff:808:808', '2606:4700::1111', 'unknown']) {
    assert.equal(isPrivateAddress(ip), false, ip);
  }
});

test('a download to an address in the URL is checked too: no lookup happens for it, so nothing else would', async (t) => {
  let connections = 0;
  const server = createServer((socket) => { connections++; socket.destroy(); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  defer(t, () => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  const lookup = async () => { throw new Error('no lookup for an address'); };
  const get = pinnedFetch({ lookup });
  for (const host of ['127.0.0.1', '[::ffff:127.0.0.1]', '[::ffff:7f00:1]']) {
    await assert.rejects(get(`https://${host}:${port}/t.skp`), { code: 'EPRIVATE' }, host);
  }
  assert.equal(connections, 0);
});

test('behind a trusted proxy: X-Forwarded-For with ports, an entry that isn\'t an address, and requests that forward nothing', () => {
  const req = (peer, headers = {}) => ({ socket: { remoteAddress: peer }, headers });
  const trusted = ['10.0.0.2'];
  assert.deepEqual(clientOf(req('10.0.0.2', { 'x-forwarded-for': '192.168.1.10, 203.0.113.9:5555' }), trusted), { ip: '203.0.113.9', https: false, proxied: true }, 'ip:port');
  assert.equal(clientOf(req('10.0.0.2', { 'x-forwarded-for': '192.168.1.10, [2001:DB8::1]:5555' }), trusted).ip, '2001:db8::1', '[v6]:port');
  assert.equal(clientOf(req('10.0.0.2', { 'x-forwarded-for': '[2001:db8::1]' }), trusted).ip, '2001:db8::1');
  const junk = clientOf(req('10.0.0.2', { 'x-forwarded-for': '192.168.1.10, junk' }), trusted);
  assert.equal(junk.ip, 'unknown', 'never the entry before it, which the client may have written');
  assert.equal(isPrivateAddress(junk.ip), false);
  // From the proxy's address, forwarding nothing: the proxy's machine itself (the command line).
  assert.deepEqual(clientOf(req('10.0.0.2'), trusted), { ip: '10.0.0.2', https: false, proxied: false });
  // Forwarding without naming the client: unknown, never the proxy's own address.
  assert.deepEqual(clientOf(req('10.0.0.2', { 'x-forwarded-proto': 'https' }), trusted), { ip: 'unknown', https: true, proxied: true, unnamed: true });
  assert.deepEqual(clientOf(req('10.0.0.2', { 'x-forwarded-for': ' , ', 'x-forwarded-proto': 'https' }), trusted), { ip: 'unknown', https: true, proxied: true, unnamed: true });
  assert.deepEqual(clientOf(req('10.0.0.2', { 'x-real-ip': '8.8.8.8' }), trusted), { ip: 'unknown', https: false, proxied: true, unnamed: true });
});

test('SKP_TRUST_PROXY is written the way the peer\'s address is, so any spelling of it matches', (t) => {
  const { env } = dirsEnv(t, { SKP_TRUST_PROXY: '::ffff:172.17.0.1, FD00:0::2, 0:0:0:0:0:0:0:1, 172.17.0.1' });
  const { trustProxy } = loadConfig({ argv: [], env });
  assert.deepEqual(trustProxy, ['172.17.0.1', 'fd00::2', '::1']);
  const req = (peer) => ({ socket: { remoteAddress: peer }, headers: { 'x-forwarded-for': '8.8.8.8' } });
  for (const peer of ['::ffff:172.17.0.1', '172.17.0.1', 'fd00::2', '::1']) assert.equal(clientOf(req(peer), trustProxy).ip, '8.8.8.8', peer);
});

test('lan mode: a public client stays outside, whatever range or port form it comes as', async (t) => {
  const { platform } = await start(t, { SKP_EXPOSURE: 'lan', SKP_HOST: '127.0.0.1', SKP_TRUST_PROXY: '127.0.0.1' });
  const via = (client) => fetch(`${platform.url}/api/v1/setup`, { headers: { 'x-forwarded-for': client } }).then((r) => r.status);
  assert.equal(await via('192.0.78.9'), 403, '192.0.0.0/16 is mostly public');
  assert.equal(await via('203.0.113.9:5555'), 403);
  assert.equal(await via('192.168.1.10, 203.0.113.9:5555'), 403, 'a private address the client wrote itself');
  assert.equal(await via('192.168.1.10, junk'), 403);
  assert.equal(await via('192.168.1.10:5555'), 200);
  // The local token through a proxy on this machine: refused when it forwards, not when the
  // command line beside it asks directly. Forwarded without the client's address, the client is
  // unknown: outside the local network.
  assert.equal((await fetch(`${platform.url}/api/v1/users`, { headers: signedIn(platform) })).status, 200);
  assert.equal((await fetch(`${platform.url}/api/v1/users`, { headers: signedIn(platform, { 'x-forwarded-for': '192.168.1.10', 'x-forwarded-proto': 'https' }) })).status, 401);
  assert.equal((await fetch(`${platform.url}/api/v1/users`, { headers: signedIn(platform, { 'x-forwarded-proto': 'https' }) })).status, 403);
});

test('the machine\'s names follow its addresses: one that arrives after startup is accepted', async (t) => {
  let ifaces = { lo: [{ address: '127.0.0.1', family: 'IPv4' }], eth0: [{ address: '172.17.0.2', family: 'IPv4' }] };
  let now = 1_700_000_000_000;
  const { platform } = await start(t, { SKP_EXPOSURE: 'lan', SKP_HOST: '127.0.0.1' }, { interfaces: () => ifaces, clock: { now: () => now } });
  // node:http, which sends the Host it is given (fetch sends the URL's).
  const as = (host) => new Promise((resolve, reject) => {
    request(`${platform.url}/api/v1/setup`, { headers: { host: `${host}:${platform.port}` } }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject).end();
  });
  assert.equal(await as('172.17.0.2'), 200);
  assert.equal(await as('192.168.1.77'), 403);
  ifaces = { ...ifaces, wlan0: [{ address: '192.168.1.77', family: 'IPv4' }] };
  now += 5000;
  assert.equal(await as('192.168.1.77'), 200, 'the Wi-Fi address that arrived');
  assert.equal(await as('evil.example'), 403);
});

test('the machine\'s names are read again for a Host they lack, at most once a second', () => {
  let reads = 0;
  let names = ['10.0.0.5'];
  let now = 0;
  const live = liveMachineNames({ read: () => { reads++; return names; }, now: () => now, maxAgeMs: 60000 });
  assert.equal(reads, 1);
  names = ['10.0.0.5', '192.168.1.77'];
  assert.deepEqual(live('192.168.1.77:4848'), ['10.0.0.5'], 'not yet: read less than a second ago');
  now = 1000;
  assert.deepEqual(live('10.0.0.5:4848'), ['10.0.0.5'], 'a name it has: no read');
  assert.equal(reads, 1);
  assert.deepEqual(live('192.168.1.77:4848'), ['10.0.0.5', '192.168.1.77']);
  assert.equal(reads, 2);
  live('nope.example');
  assert.equal(reads, 2, 'within a second of the last read');
  now = 61000;
  live();
  assert.equal(reads, 3, 'and when they are old');
});

test('the command line reaches the platform in lan mode, listening on every interface (0.0.0.0)', async (t) => {
  const { platform, env } = await start(t, { SKP_EXPOSURE: 'lan' });
  assert.equal(platform.config.host, '0.0.0.0');
  const r = await cli(['user', 'list'], env);
  assert.equal(r.code, 0, r.stderr);
  // Through a proxy on this machine (SKP_TRUST_PROXY=127.0.0.1) too.
  const proxied = await start(t, { SKP_EXPOSURE: 'public', SKP_TRUST_PROXY: '127.0.0.1', SKP_PUBLIC_URL: 'https://overlays.example.com' });
  const p = await cli(['user', 'list'], proxied.env);
  assert.equal(p.code, 0, p.stderr);
});

test('the command line reaches the platform over its built-in TLS, trusting the platform\'s certificate only', async (t) => {
  const dir = tempDir(t);
  const write = (name, { cert, key }) => {
    writeFileSync(path.join(dir, `${name}.pem`), cert);
    writeFileSync(path.join(dir, `${name}-key.pem`), key);
    return { SKP_TLS_CERT: path.join(dir, `${name}.pem`), SKP_TLS_KEY: path.join(dir, `${name}-key.pem`) };
  };
  const own = write('own', selfSigned('overlays.example.com'));
  const { env } = await start(t, own);
  const r = await cli(['user', 'list'], env);
  assert.equal(r.code, 0, r.stderr);
  const other = await cli(['user', 'list'], { ...env, ...write('other', selfSigned('overlays.example.com')) });
  assert.equal(other.code, 69);
  assert.match(other.stderr, /didn't answer with the platform's certificate.*the local token wasn't sent/);
});

test('the command line refuses a platform that listens on a non-loopback address only, saying why', async (t) => {
  const { env } = dirsEnv(t, { SKP_EXPOSURE: 'lan', SKP_HOST: '192.0.2.1' });
  const r = await cli(['user', 'list'], env);
  assert.equal(r.code, 78);
  assert.match(r.stderr, /listens on 192\.0\.2\.1 only.*SKP_HOST=0\.0\.0\.0/);
});

test('command line commands never make a master key: without the platform\'s SKP_MASTER_KEY_FILE they say so', async (t) => {
  const { root, env } = dirsEnv(t);
  mkdirSync(path.join(root, 'secret'));
  const keyFile = path.join(root, 'secret', 'platform.key');
  writeKeyFile(keyFile, randomBytes(32));
  const data = openData(loadConfig({ argv: [], env: { ...env, SKP_MASTER_KEY_FILE: keyFile } }), { log: memoryLogger().log });
  try {
    data.overlays.create({ slug: 'main', template: DIAG, settings: { accent: '#16e0ff' } });
  } finally {
    data.close();
  }
  const configFiles = () => (existsSync(env.SKP_CONFIG_DIR) ? readdirSync(env.SKP_CONFIG_DIR) : []);
  const list = await cli(['template', 'list'], env);
  assert.equal(list.code, 0, list.stderr);
  assert.deepEqual(configFiles().filter((f) => f.startsWith('master.key')), [], 'no stray key');
  const rotate = await cli(['key', 'rotate'], env);
  assert.equal(rotate.code, 1);
  assert.match(rotate.stderr, /There is no master key in .*SKP_MASTER_KEY_FILE/);
  assert.deepEqual(configFiles().filter((f) => f.startsWith('master.key')), []);
  const withKey = await cli(['key', 'rotate'], { ...env, SKP_MASTER_KEY_FILE: keyFile });
  assert.equal(withKey.code, 0, withKey.stderr);
  assert.match(withKey.stdout, /1 secret re-encrypted/);
});

// A config directory with a master key and a store holding one secret under it.
function sealed(t) {
  const root = tempDir(t);
  const config = { configDir: path.join(root, 'config'), dataDir: path.join(root, 'data') };
  mkdirSync(config.configDir);
  mkdirSync(config.dataDir);
  const store = openStore({ dataDir: config.dataDir });
  defer(t, () => store.close());
  store.put('overlays', 'ovl_A', { key: createSecrets(loadMasterKey(config)).encrypt('skp_ovl_secret', 'ovl_A') });
  const file = (name = '') => path.join(config.configDir, `master.key${name}`);
  const secret = () => createSecrets(loadMasterKey(config, { create: false })).decrypt(store.get('overlays', 'ovl_A').data.key, 'ovl_A');
  return { config, store, file, secret };
}

test('key rotate never overwrites master.key.next: a rotation that stopped after its commit is finished with its key', (t) => {
  const { config, store, file, secret } = sealed(t);
  const first = rotateMasterKey(config, store);
  // It stopped before its renames (killed, or Windows refused to rename master.key).
  renameSync(file(), file('.next'));
  renameSync(first.retired, file());
  assert.equal(secret(), 'skp_ovl_secret', 'the ring still has the next key');
  // Rotating again fails in its transaction (disk full): the next key must still be on disk.
  const failing = { list: (...a) => store.list(...a), get: (...a) => store.get(...a), transaction() { throw new Error('SQLITE_FULL'); } };
  assert.throws(() => rotateMasterKey(config, failing), /SQLITE_FULL/);
  assert.equal(secret(), 'skp_ovl_secret');
  const done = rotateMasterKey(config, store);
  assert.deepEqual([done.to, done.resumed, done.reencrypted], [first.to, true, 1]);
  assert.equal(loadMasterKey(config).kid, first.to);
  assert.ok(!existsSync(file('.next')));
  assert.equal(secret(), 'skp_ovl_secret');
  // A next key that can't be read is refused, never replaced.
  writeFileSync(file('.next'), 'not a key\n');
  assert.throws(() => rotateMasterKey(config, store), /must hold a 32-byte key/);
  assert.equal(readFileSync(file('.next'), 'utf8'), 'not a key\n');
});

test('a rotation that stopped between its renames: the next key becomes the master key, not a new one', (t) => {
  const { config, store, file, secret } = sealed(t);
  const r = rotateMasterKey(config, store);
  renameSync(file(), file('.next')); // master.key is retired, the next one not yet in its place
  const { log, entries } = memoryLogger();
  assert.equal(loadMasterKey(config, { log }).kid, r.to);
  assert.ok(entries.some((e) => /stopped part way/.test(e.msg)));
  assert.ok(!entries.some((e) => /Made a new master key/.test(e.msg)));
  assert.ok(!existsSync(file('.next')));
  assert.equal(secret(), 'skp_ovl_secret');
});
