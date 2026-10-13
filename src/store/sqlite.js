// SQLite backend on node:sqlite (10 §10.2). Documents live in one table keyed by (collection, id);
// WAL with synchronous=FULL so a committed write survives a crash or power loss (H4).
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { moveAside } from '../fsutil.js';

const SQLITE_CORRUPT = 11;
const SQLITE_NOTADB = 26;

export function openSqliteBackend(file, { log }) {
  let movedAside = null;
  let db = openChecked(file);
  if (db instanceof Error) {
    const err = db;
    movedAside = moveAside(file);
    for (const suffix of ['-wal', '-shm']) {
      if (existsSync(file + suffix)) { try { moveAside(file + suffix); } catch {} }
    }
    log.error('the database could not be read, so it was moved aside and an empty one created', { file, movedAside, err });
    db = new DatabaseSync(file);
  }

  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS docs (
      collection TEXT NOT NULL,
      id TEXT NOT NULL,
      rev INTEGER NOT NULL,
      data TEXT NOT NULL,
      PRIMARY KEY (collection, id)
    ) WITHOUT ROWID;
  `);

  const q = {
    read: db.prepare('SELECT rev, data FROM docs WHERE collection = ? AND id = ?'),
    write: db.prepare(`INSERT INTO docs (collection, id, rev, data) VALUES (?, ?, ?, ?)
      ON CONFLICT (collection, id) DO UPDATE SET rev = excluded.rev, data = excluded.data`),
    remove: db.prepare('DELETE FROM docs WHERE collection = ? AND id = ?'),
    scan: db.prepare(`SELECT id, rev, data FROM docs
      WHERE collection = ? AND id > ? AND substr(id, 1, length(?)) = ?
      ORDER BY id LIMIT ?`),
    getMeta: db.prepare('SELECT value FROM meta WHERE key = ?'),
    setMeta: db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?)
      ON CONFLICT (key) DO UPDATE SET value = excluded.value`),
  };

  const prims = {
    read(collection, id) {
      const row = q.read.get(collection, id);
      return row ? { rev: row.rev, data: JSON.parse(row.data) } : undefined;
    },
    write(collection, id, rev, json) { q.write.run(collection, id, rev, json); },
    remove(collection, id) { q.remove.run(collection, id); },
    scan(collection, { after, prefix, limit }) {
      return q.scan.all(collection, after, prefix, prefix, limit)
        .map((row) => ({ id: row.id, rev: row.rev, data: JSON.parse(row.data) }));
    },
    getMeta(key) { return q.getMeta.get(key)?.value; },
    setMeta(key, value) { q.setMeta.run(key, String(value)); },
  };

  let open = true;
  return {
    kind: 'sqlite',
    file,
    movedAside,
    prims,
    atomic(fn) {
      db.exec('BEGIN IMMEDIATE');
      let result;
      try {
        result = fn(prims);
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      try {
        db.exec('COMMIT');
      } catch (err) {
        try { db.exec('ROLLBACK'); } catch {}
        throw err;
      }
      return result;
    },
    backup(dest) { db.prepare('VACUUM INTO ?').run(dest); },
    close() { if (open) { open = false; db.close(); } },
  };
}

// Opens the file and runs a quick integrity check. Returns the error only when the file is
// genuinely corrupt or not a database; anything else (locked, no permission) is thrown as is,
// because moving a healthy database aside would be far worse than refusing to start.
function openChecked(file) {
  if (!existsSync(file)) return new DatabaseSync(file);
  let db;
  try {
    db = new DatabaseSync(file);
    const row = db.prepare('PRAGMA quick_check').get();
    const result = row && Object.values(row)[0];
    if (result !== 'ok') throw Object.assign(new Error(`integrity check failed: ${result}`), { corrupt: true });
    return db;
  } catch (err) {
    try { db?.close(); } catch {}
    const primary = typeof err.errcode === 'number' ? err.errcode & 0xff : undefined;
    if (err.corrupt || primary === SQLITE_CORRUPT || primary === SQLITE_NOTADB) return err;
    throw err;
  }
}
