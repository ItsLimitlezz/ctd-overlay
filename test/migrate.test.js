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

test('the shipped migrations apply cleanly and create the installation record', (t) => {
  const { store, log } = open(t, tempDir(t));
  migrate(store, migrations, { log });
  const install = store.get('system', 'installation');
  assert.match(install.data.instanceId, /^[0-9A-HJKMNP-TV-Z]{26}$/);
});
