// The same behaviour is required of both backends, so every test runs against each.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ConflictError, openStore } from '../src/store/index.js';
import { defer, memoryLogger, tempDir } from './helpers.js';

for (const backend of ['sqlite', 'json']) {
  describe(`store (${backend})`, () => {
    const open = (t, dataDir = tempDir(t)) => {
      const { log, entries } = memoryLogger();
      const store = openStore({ dataDir, backend, log });
      defer(t, () => store.close());
      return { store, dataDir, entries };
    };

    test('put creates revision 1 and each write adds one', (t) => {
      const { store } = open(t);
      assert.equal(store.get('overlays', 'ovl_a'), undefined);
      assert.deepEqual(store.put('overlays', 'ovl_a', { slug: 'friday-main' }), { id: 'ovl_a', rev: 1, data: { slug: 'friday-main' } });
      assert.equal(store.put('overlays', 'ovl_a', { slug: 'friday-h' }).rev, 2);
      assert.deepEqual(store.get('overlays', 'ovl_a'), { id: 'ovl_a', rev: 2, data: { slug: 'friday-h' } });
    });

    test('ifRev turns a stale write into a ConflictError instead of an overwrite (H16)', (t) => {
      const { store } = open(t);
      store.put('shows', 'show_sat', { scene: 'starting' });
      store.put('shows', 'show_sat', { scene: 'program' }, { ifRev: 1 });
      assert.throws(
        () => store.put('shows', 'show_sat', { scene: 'brb' }, { ifRev: 1 }),
        (e) => e instanceof ConflictError && e.currentRev === 2 && e.expectedRev === 1,
      );
      assert.equal(store.get('shows', 'show_sat').data.scene, 'program');
    });

    test('ifRev 0 means create only', (t) => {
      const { store } = open(t);
      store.put('users', 'usr_a', { name: 'J' }, { ifRev: 0 });
      assert.throws(() => store.put('users', 'usr_a', { name: 'K' }, { ifRev: 0 }), /already exists/);
    });

    test('delete removes, honours ifRev, and reports whether anything was there', (t) => {
      const { store } = open(t);
      store.put('media', 'med_a', { name: 'clip.mp4' });
      assert.throws(() => store.delete('media', 'med_a', { ifRev: 5 }), ConflictError);
      assert.equal(store.delete('media', 'med_a', { ifRev: 1 }), true);
      assert.equal(store.delete('media', 'med_a'), false);
      assert.equal(store.get('media', 'med_a'), undefined);
    });

    test('list returns documents in id order, with paging and prefixes', (t) => {
      const { store } = open(t);
      for (const id of ['cue_03', 'cue_01', 'plan_01', 'cue_02']) store.put('things', id, { id });
      assert.deepEqual(store.list('things').map((d) => d.id), ['cue_01', 'cue_02', 'cue_03', 'plan_01']);
      assert.deepEqual(store.list('things', { limit: 2 }).map((d) => d.id), ['cue_01', 'cue_02']);
      assert.deepEqual(store.list('things', { after: 'cue_02' }).map((d) => d.id), ['cue_03', 'plan_01']);
      assert.deepEqual(store.list('things', { prefix: 'cue_' }).map((d) => d.id), ['cue_01', 'cue_02', 'cue_03']);
      assert.deepEqual(store.list('empty'), []);
    });

    test('returned data is a copy: mutating it does not change the store', (t) => {
      const { store } = open(t);
      const input = { lineup: [{ name: 'BIA' }] };
      const written = store.put('shows', 'show_a', input);
      input.lineup[0].name = 'changed';
      written.data.lineup[0].name = 'changed';
      store.get('shows', 'show_a').data.lineup[0].name = 'changed';
      assert.equal(store.get('shows', 'show_a').data.lineup[0].name, 'BIA');
    });

    test('a transaction commits all of its writes or none of them', (t) => {
      const { store } = open(t);
      store.put('cues', 'cue_a', { status: 'armed' });
      assert.throws(() => store.transaction((tx) => {
        tx.put('cues', 'cue_a', { status: 'fired' });
        tx.put('cues', 'cue_b', { status: 'armed' });
        throw new Error('crash between the two');
      }), /crash between the two/);
      assert.equal(store.get('cues', 'cue_a').data.status, 'armed');
      assert.equal(store.get('cues', 'cue_b'), undefined);

      const result = store.transaction((tx) => {
        tx.put('cues', 'cue_a', { status: 'fired' }, { ifRev: 1 });
        tx.put('cues', 'cue_b', { status: 'armed' });
        return tx.get('cues', 'cue_a').rev;
      });
      assert.equal(result, 2);
      assert.equal(store.get('cues', 'cue_b').rev, 1);
    });

    test('transactions refuse async callbacks, nesting, and use after they finish', async (t) => {
      const { store } = open(t);
      assert.throws(() => store.transaction(async () => {}), /must be synchronous/);
      assert.throws(() => store.transaction(() => store.put('a', 'b', 1)), /use the transaction object/);
      let leaked;
      store.transaction((tx) => { leaked = tx; });
      assert.throws(() => leaked.put('a', 'b', 1), /already finished/);
    });

    test('bad names, ids and data are rejected', (t) => {
      const { store } = open(t);
      assert.throws(() => store.put('Overlays', 'x', {}), /bad collection name/);
      assert.throws(() => store.put('overlays', 'has space', {}), /bad id/);
      assert.throws(() => store.put('overlays', '', {}), /bad id/);
      assert.throws(() => store.put('overlays', 'x', undefined), /JSON value/);
      assert.throws(() => store.put('overlays', 'x', { n: 1n }), /JSON-serializable/);
      assert.throws(() => store.put('overlays', 'x', {}, { ifRev: -1 }), /ifRev/);
    });

    test('ids that look like object internals are ordinary ids', (t) => {
      const { store } = open(t);
      store.put('things', '__proto__', { ok: true });
      store.put('things', 'constructor', { ok: true });
      assert.equal(store.get('things', '__proto__').data.ok, true);
      assert.deepEqual(store.list('things').map((d) => d.id), ['__proto__', 'constructor']);
    });

    test('data survives closing and reopening', (t) => {
      const dataDir = tempDir(t);
      const first = open(t, dataDir).store;
      first.put('shows', 'show_a', { name: 'Saturday TAKEOVER' });
      first.transaction((tx) => tx.setMeta('schemaVersion', 3));
      first.close();
      const second = open(t, dataDir).store;
      assert.equal(second.get('shows', 'show_a').data.name, 'Saturday TAKEOVER');
      assert.equal(second.schemaVersion, 3);
    });

    test('backup writes a store that opens with the same contents', (t) => {
      const { store, dataDir } = open(t);
      store.put('shows', 'show_a', { name: 'x' });
      const dest = path.join(dataDir, 'copy');
      const backupDir = tempDir(t);
      const file = path.join(backupDir, backend === 'json' ? 'skp.json' : 'skp.db');
      store.backup(file);
      assert.ok(existsSync(file));
      const restored = open(t, backupDir).store;
      assert.equal(restored.get('shows', 'show_a').data.name, 'x');
      assert.equal(existsSync(dest), false);
    });

    test('a corrupt store file is moved aside and reported, not silently replaced (10 §10.6)', (t) => {
      const dataDir = tempDir(t);
      const file = path.join(dataDir, backend === 'json' ? 'skp.json' : 'skp.db');
      writeFileSync(file, 'this is not a store, padded out so SQLite reads a full header ................................................');
      const { store, entries } = open(t, dataDir);
      assert.ok(store.movedAside);
      assert.match(path.basename(store.movedAside), /\.corrupt-/);
      assert.ok(entries.some((e) => e.level === 'error' && /moved aside/.test(e.msg)));
      assert.ok(readdirSync(dataDir).some((f) => f.includes('.corrupt-')));
      store.put('a', 'b', 1);
      assert.equal(store.get('a', 'b').data, 1);
    });

    test('a closed store refuses to work', (t) => {
      const { store } = open(t);
      store.close();
      assert.throws(() => store.get('a', 'b'), /closed/);
      assert.doesNotThrow(() => store.close());
    });
  });
}
