// Connections at rest (07 §7.7): settings plain, secrets and the account's tokens encrypted with the
// record's id as associated data, re-encrypted by `skp key rotate`, and deleted together.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createRecords } from '../src/connectors/records.js';
import { validateDefinition } from '../src/connectors/registry.js';
import { createSecrets, loadMasterKey, rotateMasterKey } from '../src/secrets.js';
import { migrate } from '../src/store/migrate.js';
import { migrations } from '../src/store/migrations.js';
import { openStore } from '../src/store/index.js';
import { fakeConnector } from './fixtures/connectors/fake.js';
import { defer, memoryLogger, tempDir } from './helpers.js';

function setup(t) {
  const root = tempDir(t);
  const config = { configDir: path.join(root, 'config'), dataDir: path.join(root, 'data') };
  mkdirSync(config.configDir);
  mkdirSync(config.dataDir);
  const store = openStore({ dataDir: config.dataDir });
  defer(t, () => store.close());
  migrate(store, migrations, { log: memoryLogger().log });
  const records = createRecords({ store, secrets: createSecrets(loadMasterKey(config)) });
  return { config, store, records, def: validateDefinition(fakeConnector().def) };
}

test('secrets and tokens are encrypted, bound to their record; settings stay readable', (t) => {
  const { store, records, def } = setup(t);
  const doc = records.create(def, { name: 'X', config: { channel: 'dprtmnt' }, secrets: { clientSecret: 'cs-0123456789' } });
  records.saveTokens(doc.id, { accessToken: 'at-0123456789', refreshToken: 'rt-0123456789', scope: ['a'], obtainedAt: 1, expiresAt: 3600001 });
  const raw = JSON.stringify([store.get('connections', doc.id), store.get('connection_tokens', doc.id)]);
  for (const s of ['cs-0123456789', 'at-0123456789', 'rt-0123456789']) assert.ok(!raw.includes(s), s);
  assert.equal(store.get('connections', doc.id).data.config.channel, 'dprtmnt');
  assert.deepEqual(records.secretsOf(doc), { clientSecret: 'cs-0123456789' });
  assert.equal(records.tokensOf(doc.id).user.refreshToken, 'rt-0123456789');
  // Moved to another record, a ciphertext doesn't decrypt.
  store.put('connections', 'con_00000000000000000000000000', { ...doc.data });
  assert.throws(() => records.secretsOf(store.get('connections', 'con_00000000000000000000000000')), /belongs to another record/);
  // The view has no secret, only which fields hold one.
  const view = records.view(store.get('connections', doc.id));
  assert.deepEqual([view.secretFields, view.signedIn, view.scopes], [['clientSecret'], true, ['a']]);
  assert.ok(!JSON.stringify(view).includes('0123456789'));
  // Deleted together.
  records.memoryOf(doc.id);
  records.saveMemory(doc.id, { memory: { cursor: 'x' } });
  assert.equal(records.remove(doc.id), true);
  assert.deepEqual([store.get('connections', doc.id), store.get('connection_tokens', doc.id), store.get('connection_state', doc.id)], [undefined, undefined, undefined]);
});

test('skp key rotate re-encrypts connections\' secrets and tokens', (t) => {
  const { config, store, records, def } = setup(t);
  const doc = records.create(def, { name: 'X', secrets: { clientSecret: 'cs-0123456789' } });
  records.saveTokens(doc.id, { accessToken: 'at-0123456789', refreshToken: 'rt-0123456789', scope: [], obtainedAt: 1 });
  const before = [store.get('connections', doc.id).data.secrets, store.get('connection_tokens', doc.id).data.user];
  const r = rotateMasterKey(config, store);
  assert.equal(r.reencrypted, 2);
  const after = [store.get('connections', doc.id).data.secrets, store.get('connection_tokens', doc.id).data.user];
  assert.ok(after.every((v, i) => v !== before[i] && v.split(':')[2] === r.to), 'under the new key');
  const fresh = createRecords({ store, secrets: createSecrets(loadMasterKey(config, { create: false })) });
  assert.deepEqual(fresh.secretsOf(store.get('connections', doc.id)), { clientSecret: 'cs-0123456789' });
  assert.equal(fresh.tokensOf(doc.id).user.accessToken, 'at-0123456789');
});
