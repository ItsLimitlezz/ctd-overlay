// Schema migrations (10 §10.6, §10.7): numbered 1, 2, 3…, forward only, each in its own
// transaction. Before migrating existing data, a backup is written next to the store file.
// A store newer than this build is refused, because downgrading across a migration isn't
// supported.
import { fileStamp } from '../fsutil.js';

export class StoreVersionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StoreVersionError';
    this.code = 'store-version';
  }
}

export function migrate(store, migrations, { log, now = new Date() }) {
  migrations.forEach((m, i) => {
    if (m.version !== i + 1) throw new Error(`migrations must be numbered 1, 2, 3… with no gaps (found ${m.version} at position ${i + 1})`);
  });
  const latest = migrations.length;
  const current = store.schemaVersion;

  if (current > latest) {
    throw new StoreVersionError(
      `${store.file} is at schema version ${current}, but this build only knows up to ${latest}. ` +
      'Downgrading across a migration isn\'t supported (10 §10.7): run the newer build again, or restore the ' +
      `backup taken before migration ${latest + 1} (${store.file}.pre-v${latest + 1}-….bak).`);
  }
  if (current === latest) return { from: current, to: latest, backup: null };

  let backup = null;
  if (current > 0) {
    backup = `${store.file}.pre-v${latest}-${fileStamp(now)}.bak`;
    store.backup(backup);
    log.info('backed up the store before migrating', { backup });
  }
  for (const m of migrations.slice(current)) {
    store.transaction((tx) => {
      m.up(tx);
      tx.setMeta('schemaVersion', m.version);
    });
    log.info('migrated the store', { version: m.version, name: m.name });
  }
  return { from: current, to: latest, backup };
}
