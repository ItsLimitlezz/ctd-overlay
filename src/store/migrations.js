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
  {
    // Before connections existed every overlay was made with no bindings ([], or none at all), which
    // now means "no connection feeds it". They meant "whatever gets connected": an imported v0
    // overlay must show the Twitch and Kick counts once those connections are made (01 §1.3).
    version: 2,
    name: 'overlay bindings: every connection',
    up(tx) {
      for (let after = ''; ;) {
        const page = tx.list('overlays', { after, limit: 1000 });
        for (const doc of page) {
          const c = doc.data.connections;
          if (c === 'all' || (Array.isArray(c) && c.length)) continue;
          tx.put('overlays', doc.id, { ...doc.data, connections: 'all' });
        }
        if (page.length < 1000) break;
        after = page[page.length - 1].id;
      }
    },
  },
];
