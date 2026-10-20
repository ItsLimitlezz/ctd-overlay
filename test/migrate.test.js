import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { migrate, StoreVersionError } from '../src/store/migrate.js';
import { migrations } from '../src/store/migrations.js';
import { openStore } from '../src/store/index.js';
import { defer, memoryLogger, tempDir } from './helpers.js';

const steps = [
  { version: 1, name: 'one', up: (tx) => tx.put('system', 'a', { v: 1 }) },
  { version: 2, name: 'two', up: (tx) => tx.put('system', 'b', { v: 2 }) },
];

function open(t, dataDir) {
  const { log } = memoryLogger();
  const store = openStore({ dataDir, backend: 'sqlite', log });
  defer(t, () => store.close());
  return { store, log };
}

test('a fresh store runs every migration, with no backup since there is nothing to lose', (t) => {
  const { store, log } = open(t, tempDir(t));
  const result = migrate(store, steps, { log });
  assert.deepEqual(result, { from: 0, to: 2, backup: null });
  assert.equal(store.schemaVersion, 2);
  assert.ok(store.get('system', 'a') && store.get('system', 'b'));
});

test('migrating existing data writes a backup next to the store first', (t) => {
  const dataDir = tempDir(t);
  const first = open(t, dataDir);
  migrate(first.store, steps.slice(0, 1), { log: first.log });
  const result = migrate(first.store, steps, { log: first.log, now: new Date(Date.UTC(2026, 9, 10)) });
  assert.equal(result.from, 1);
  assert.equal(result.to, 2);
  assert.match(result.backup, /skp\.db\.pre-v2-2026-10-10T00-00-00-000Z\.bak$/);
  assert.ok(existsSync(result.backup));
});

test('running again is a no-op', (t) => {
  const { store, log } = open(t, tempDir(t));
  migrate(store, steps, { log });
  assert.deepEqual(migrate(store, steps, { log }), { from: 2, to: 2, backup: null });
  assert.equal(store.get('system', 'a').rev, 1);
});

test('a failing migration leaves the store at the last good version', (t) => {
  const { store, log } = open(t, tempDir(t));
  const failing = [steps[0], { version: 2, name: 'bad', up: (tx) => { tx.put('system', 'half', 1); throw new Error('nope'); } }];
  assert.throws(() => migrate(store, failing, { log }), /nope/);
  assert.equal(store.schemaVersion, 1);
  assert.equal(store.get('system', 'half'), undefined);
});

test('a store newer than this build is refused (10 §10.7)', (t) => {
  const { store, log } = open(t, tempDir(t));
  migrate(store, steps, { log });
  assert.throws(() => migrate(store, steps.slice(0, 1), { log }), (e) => e instanceof StoreVersionError && /only knows up to 1/.test(e.message));
});

test('migration lists must be numbered 1, 2, 3 with no gaps', (t) => {
  const { store, log } = open(t, tempDir(t));
  assert.throws(() => migrate(store, [steps[1]], { log }), /no gaps/);
});

test('migration 2: overlays made before connections existed take every connection; a list of them stays', (t) => {
  const { store, log } = open(t, tempDir(t));
  migrate(store, migrations.slice(0, 1), { log });
  store.put('overlays', 'ovl_A', { slug: 'a', connections: [] });
  store.put('overlays', 'ovl_B', { slug: 'b' });
  store.put('overlays', 'ovl_C', { slug: 'c', connections: ['con_x'] });
  const out = migrate(store, migrations.slice(0, 2), { log });
  assert.deepEqual([out.from, out.to], [1, 2]);
  assert.deepEqual(['ovl_A', 'ovl_B', 'ovl_C'].map((id) => store.get('overlays', id).data.connections), ['all', 'all', ['con_x']]);
  assert.equal(store.get('overlays', 'ovl_A').data.slug, 'a');
});

test('migration 3: a CTD Relay connection set to the default profile follows every profile; another profile picked, or another connector, stays', (t) => {
  const { store, log } = open(t, tempDir(t));
  migrate(store, migrations.slice(0, 2), { log });
  const base = { name: 'Relay', enabled: true, secretFields: ['token'] };
  store.put('connections', 'con_A', { ...base, connector: 'ctd-multistream', config: { baseUrl: 'http://192.168.1.50:30080/api/v1', profile: 'default', chat: true } });
  store.put('connections', 'con_B', { ...base, connector: 'ctd-multistream', config: { baseUrl: 'http://192.168.1.50:30080/api/v1', profile: 'p-dprtmnt' } });
  store.put('connections', 'con_C', { ...base, connector: 'ctd-multistream', config: { baseUrl: 'http://192.168.1.50:30080/api/v1' } });
  store.put('connections', 'con_D', { ...base, connector: 'other', config: { profile: 'default' } });
  const out = migrate(store, migrations, { log });
  assert.deepEqual([out.from, out.to], [2, 3]);
  assert.deepEqual(store.get('connections', 'con_A').data.config, { baseUrl: 'http://192.168.1.50:30080/api/v1', chat: true });
  assert.equal(store.get('connections', 'con_A').data.name, 'Relay');
  assert.equal(store.get('connections', 'con_B').data.config.profile, 'p-dprtmnt');
  assert.equal(store.get('connections', 'con_C').rev, 1, 'nothing to change');
  assert.equal(store.get('connections', 'con_D').data.config.profile, 'default');
});

test('the shipped migrations apply cleanly and create the installation record', (t) => {
  const { store, log } = open(t, tempDir(t));
  migrate(store, migrations, { log });
  const install = store.get('system', 'installation');
  assert.match(install.data.instanceId, /^[0-9A-HJKMNP-TV-Z]{26}$/);
});
