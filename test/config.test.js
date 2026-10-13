import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ConfigError, defaultDirs, describeConfig, loadConfig } from '../src/config.js';
import { tempDir } from './helpers.js';

// A config directory with an optional config.json, and a separate data directory.
function dirs(t, configJson) {
  const root = tempDir(t);
  const configDir = path.join(root, 'config');
  const dataDir = path.join(root, 'data');
  mkdirSync(configDir);
  if (configJson !== undefined) {
    writeFileSync(path.join(configDir, 'config.json'), typeof configJson === 'string' ? configJson : JSON.stringify(configJson));
  }
  return { configDir, dataDir };
}

const load = (opts) => loadConfig({ argv: [], env: {}, ...opts });

test('defaults: local exposure on 127.0.0.1:4848 with SQLite', (t) => {
  const { configDir, dataDir } = dirs(t);
  const c = load({ env: { SKP_CONFIG_DIR: configDir, SKP_DATA_DIR: dataDir } });
  assert.equal(c.exposure, 'local');
  assert.equal(c.host, '127.0.0.1');
  assert.equal(c.port, 4848);
  assert.equal(c.store, 'sqlite');
  assert.equal(c.logLevel, 'info');
  assert.equal(c.dataDir, dataDir);
  assert.equal(c.configDir, configDir);
  assert.deepEqual(c.trustProxy, []);
  assert.ok(Object.isFrozen(c));
});

test('precedence: flags > environment > config.json > defaults', (t) => {
  const { configDir, dataDir } = dirs(t, { port: 5000, logLevel: 'warn', store: 'json' });
  const base = { SKP_CONFIG_DIR: configDir, SKP_DATA_DIR: dataDir };
  assert.equal(load({ env: base }).port, 5000);
  assert.equal(load({ env: { ...base, SKP_PORT: '6000' } }).port, 6000);
  assert.equal(load({ env: { ...base, SKP_PORT: '6000' }, argv: ['--port', '7000'] }).port, 7000);
  assert.equal(load({ env: base }).logLevel, 'warn');
  assert.equal(load({ env: base }).store, 'json');
  assert.equal(load({ env: { ...base, SKP_STORE: 'sqlite' } }).store, 'sqlite');
});

test('per-OS default directories keep config beside data, never inside it', () => {
  assert.deepEqual(defaultDirs('darwin', {}, '/Users/j'), {
    dataDir: '/Users/j/Library/Application Support/SKP/data',
    configDir: '/Users/j/Library/Application Support/SKP/config',
  });
  assert.deepEqual(defaultDirs('linux', {}, '/home/j'), { dataDir: '/home/j/.local/share/skp', configDir: '/home/j/.config/skp' });
  assert.deepEqual(defaultDirs('linux', { XDG_DATA_HOME: '/x/data', XDG_CONFIG_HOME: '/x/conf' }, '/home/j'), {
    dataDir: '/x/data/skp', configDir: '/x/conf/skp',
  });
  assert.deepEqual(defaultDirs('win32', { LOCALAPPDATA: 'C:\\Users\\j\\AppData\\Local' }, 'C:\\Users\\j'), {
    dataDir: 'C:\\Users\\j\\AppData\\Local\\SKP\\data',
    configDir: 'C:\\Users\\j\\AppData\\Local\\SKP\\config',
  });
});

test('the config directory may not sit inside the data directory, or the reverse (07 §7.7)', (t) => {
  const root = tempDir(t);
  assert.throws(() => load({ env: { SKP_DATA_DIR: root, SKP_CONFIG_DIR: path.join(root, 'config') } }), /must be separate/);
  assert.throws(() => load({ env: { SKP_CONFIG_DIR: root, SKP_DATA_DIR: path.join(root, 'data') } }), /must be separate/);
  assert.throws(() => load({ env: { SKP_CONFIG_DIR: root, SKP_DATA_DIR: root } }), /must be separate/);
});

test('exposure (07 §7.8): lan listens everywhere; public needs TLS (its own or a proxy\'s) and its public URL', (t) => {
  const { configDir, dataDir } = dirs(t, { exposure: 'public' });
  const base = { SKP_CONFIG_DIR: configDir, SKP_DATA_DIR: dataDir };
  assert.throws(() => load({ env: base }), (e) => e instanceof ConfigError && /SKP_EXPOSURE=public requires TLS: set SKP_TLS_CERT\/KEY or SKP_TRUST_PROXY/.test(e.message));
  assert.throws(() => load({ env: { ...base, SKP_TRUST_PROXY: '10.0.0.2' } }), /requires SKP_PUBLIC_URL/);
  const pub = load({ env: { ...base, SKP_TRUST_PROXY: '10.0.0.2', SKP_PUBLIC_URL: 'https://overlays.example.com' } });
  assert.deepEqual([pub.exposure, pub.host, pub.publicUrl, pub.trustProxy], ['public', '0.0.0.0', 'https://overlays.example.com', ['10.0.0.2']]);
  const tls = load({ env: { ...base, SKP_TLS_CERT: 'cert.pem', SKP_TLS_KEY: 'key.pem', SKP_PUBLIC_URL: 'https://overlays.example.com' } });
  assert.equal(path.basename(tls.tlsCert), 'cert.pem');
  const lan = load({ env: { ...base, SKP_EXPOSURE: 'lan', SKP_HOSTS: 'NAS.home.arpa, 192.168.1.20:4848' } });
  assert.deepEqual([lan.exposure, lan.host, lan.hosts], ['lan', '0.0.0.0', ['nas.home.arpa', '192.168.1.20:4848']]);
  assert.equal(load({ env: { ...base, SKP_EXPOSURE: 'lan', SKP_HOST: '::' } }).host, '::');
  assert.throws(() => load({ env: { ...base, SKP_EXPOSURE: 'lan', SKP_HOSTS: 'not a host!' } }), /SKP_HOSTS must list host names/);
});

test('only loopback hosts are accepted while exposure is local', (t) => {
  const { configDir, dataDir } = dirs(t);
  const base = { SKP_CONFIG_DIR: configDir, SKP_DATA_DIR: dataDir };
  for (const host of ['127.0.0.1', '127.0.0.2', '::1', 'localhost']) assert.equal(load({ env: { ...base, SKP_HOST: host } }).host, host);
  for (const host of ['0.0.0.0', '192.168.1.20', '::']) assert.throws(() => load({ env: { ...base, SKP_HOST: host } }), /expose the server.*SKP_EXPOSURE=lan/);
  assert.equal(load({ env: base }).host, '127.0.0.1', 'local by default, on loopback');
});

test('bad values stop startup with a message that names the setting', (t) => {
  const { configDir, dataDir } = dirs(t);
  const base = { SKP_CONFIG_DIR: configDir, SKP_DATA_DIR: dataDir };
  const cases = [
    [{ SKP_PORT: 'abc' }, /SKP_PORT must be a port number/],
    [{ SKP_PORT: '70000' }, /SKP_PORT must be a port number/],
    [{ SKP_LOG_LEVEL: 'loud' }, /SKP_LOG_LEVEL must be one of debug, info, warn, error/],
    [{ SKP_STORE: 'mongo' }, /SKP_STORE must be one of sqlite, json/],
    [{ SKP_PUBLIC_URL: 'http://x.example' }, /must use https/],
    [{ SKP_PUBLIC_URL: 'https://x.example/overlays' }, /origin only/],
    [{ SKP_TRUST_PROXY: '10.0.0.1, proxy.lan' }, /IP addresses/],
    [{ SKP_MASTER_KEY: 'c2hvcnQ=' }, /32 bytes in base64/],
    [{ SKP_TLS_CERT: 'cert.pem' }, /both SKP_TLS_CERT and SKP_TLS_KEY/],
  ];
  for (const [env, re] of cases) assert.throws(() => load({ env: { ...base, ...env } }), re, JSON.stringify(env));
});

test('the master key is accepted from the environment only, and never printed', (t) => {
  const { configDir, dataDir } = dirs(t);
  const key = Buffer.alloc(32, 7).toString('base64');
  const c = load({ env: { SKP_CONFIG_DIR: configDir, SKP_DATA_DIR: dataDir, SKP_MASTER_KEY: key } });
  assert.equal(c.masterKey, key);
  assert.equal(describeConfig(c).masterKey, 'set');
  assert.doesNotMatch(JSON.stringify(describeConfig(c)), new RegExp(key.replace(/[+/=]/g, '.')));
  const withFile = dirs(t, { masterKey: key });
  assert.throws(() => load({ env: { SKP_CONFIG_DIR: withFile.configDir, SKP_DATA_DIR: withFile.dataDir } }), /SKP_MASTER_KEY environment variable/);
});

test('config.json problems are reported precisely', (t) => {
  const broken = dirs(t, '{ "port": ');
  assert.throws(() => load({ env: { SKP_CONFIG_DIR: broken.configDir, SKP_DATA_DIR: broken.dataDir } }), /isn't valid JSON/);
  const typo = dirs(t, { prot: 1 });
  assert.throws(() => load({ env: { SKP_CONFIG_DIR: typo.configDir, SKP_DATA_DIR: typo.dataDir } }), /unknown setting "prot"/);
  const array = dirs(t, '[]');
  assert.throws(() => load({ env: { SKP_CONFIG_DIR: array.configDir, SKP_DATA_DIR: array.dataDir } }), /JSON object/);
});

test('unknown command-line options are refused with the list of known ones', () => {
  assert.throws(() => load({ argv: ['--prot', '1'] }), /Known options: --port/);
});

test('time zone: IANA names are accepted; a POSIX TZ from the OS only warns', (t) => {
  const { configDir, dataDir } = dirs(t);
  const base = { SKP_CONFIG_DIR: configDir, SKP_DATA_DIR: dataDir };
  assert.equal(load({ env: { ...base, TZ: 'America/Toronto' } }).timezone, 'America/Toronto');
  const posix = load({ env: { ...base, TZ: ':/etc/localtime' } });
  assert.equal(posix.warnings.length, 1);
  assert.match(posix.warnings[0], /isn't an IANA time zone name/);
  assert.throws(() => load({ env: base, argv: ['--timezone', 'Mars/Olympus'] }), /--timezone must be an IANA time zone name/);
});
