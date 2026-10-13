// The store's migrations, in order. Append new ones; never edit one that has shipped.
import { ulid } from '../ids.js';

export const migrations = [
  {
    version: 1,
    name: 'installation record',
    up(tx) {
      tx.put('system', 'installation', { instanceId: ulid(), createdAt: new Date().toISOString() }, { ifRev: 0 });
    },
  },
];
