// One process per data directory. The platform and the CLI's commands that change it take
// <dataDir>/skp.lock: the JSON store rewrites its whole file from memory, so a second writer's
// changes would be lost, and a running server wouldn't see templates installed behind its back.
//
// Taking it is atomic: the holder's record is written to a file of its own, then hard-linked to
// skp.lock, which fails if skp.lock exists, so no process ever sees a half-written lock it could
// mistake for an abandoned one. (On a filesystem without hard links, an exclusive create is the
// fallback, and a lock too new to have its record yet counts as held.)
//
// Whether a holder is alive:
//   - on this host, by its pid (a pid that is gone means a crash or a power cut: take over), and
//     on Linux by the boot it started in (after a reboot its pid may belong to anything);
//   - our own pid means a restarted container that got the same pid: take over;
//   - on another host (another container with the volume, a share mounted twice), its pid means
//     nothing here, so the holder keeps the lock fresh: the platform touches it every minute, and
//     a lock from elsewhere counts as held until it is three minutes stale.
// A lock judged abandoned is renamed aside before a new one is made, and only the process whose
// rename moved that same record goes on, so two processes can't both take over.
import { randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, linkSync, openSync, readFileSync, renameSync, statSync, unlinkSync, utimesSync, writeSync } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';

export class LockError extends Error {
  constructor(message, holder) {
    super(message);
    this.name = 'LockError';
    this.holder = holder;
  }
}

export const REFRESH_MS = 60000;
const STALE_MS = 3 * REFRESH_MS;
const YOUNG_MS = 10000; // a lock without its record yet, younger than this, is being taken
const held = new Set(); // lock files this process holds, so two platforms in one process collide too

export function lockDataDir(dataDir, { log, purpose = 'platform', now = Date.now } = {}) {
  const file = path.join(dataDir, 'skp.lock');
  const host = hostname();
  const boot = bootId();
  const record = JSON.stringify({ pid: process.pid, host, boot, purpose, since: new Date(now()).toISOString() });
  for (let attempt = 0; attempt < 5; attempt++) {
    if (held.has(file)) throw new LockError(`This process already uses the data directory ${dataDir}.`, { pid: process.pid });
    if (create(file, record)) {
      held.add(file);
      return handle(file, host, now);
    }
    const seen = readLock(file);
    if (seen === null) continue; // gone since: try again
    const holder = seen.holder;
    if (holder ? alive(holder, host, boot, seen.mtimeMs, now) : now() - seen.mtimeMs < YOUNG_MS) {
      const what = !holder ? 'Another process is starting' : holder.purpose === 'platform' ? 'The platform is running' : `"skp ${holder.purpose}" is running`;
      const where = holder?.host && holder.host !== host ? ` on ${holder.host}` : '';
      throw new LockError(`${what}${where} with the data directory ${dataDir}${holder ? ` (pid ${holder.pid})` : ''}. Stop it first. (If nothing is running, delete ${file}.)`, holder);
    }
    if (takeAway(file, seen.text)) log?.warn('took over a lock left by a process that is gone', { file, holder });
  }
  throw new LockError(`Could not take the lock on ${dataDir}; another process keeps taking it. (If nothing is running, delete ${file}.)`);
}

function handle(file, host, now) {
  let released = false;
  return {
    file,
    // Shows a process on another host that this one is alive (REFRESH_MS apart).
    refresh() {
      if (released) return;
      try { utimesSync(file, new Date(now()), new Date(now())); } catch { /* gone: nothing to keep fresh */ }
    },
    release() {
      if (released) return;
      released = true;
      held.delete(file);
      const holder = readLock(file)?.holder;
      if (holder && holder.pid === process.pid && (holder.host ?? host) === host) {
        try { unlinkSync(file); } catch { /* already gone */ }
      }
    },
  };
}

// Makes skp.lock hold `record`, or returns false if it already exists.
function create(file, record) {
  const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}`;
  writeSynced(temp, record, 'wx');
  try {
    linkSync(temp, file);
    return true;
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    if (!['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV'].includes(err.code)) throw err;
    // No hard links here: an exclusive create, written at once.
    try {
      writeSynced(file, record, 'wx');
      return true;
    } catch (e) {
      if (e.code === 'EEXIST') return false;
      throw e;
    }
  } finally {
    try { unlinkSync(temp); } catch { /* already gone */ }
  }
}

function writeSynced(file, text, flags) {
  const fd = openSync(file, flags, 0o644);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

// { text, holder, mtimeMs } for skp.lock (holder null when it isn't a record), or null if absent.
function readLock(file) {
  let text;
  let mtimeMs;
  try {
    mtimeMs = statSync(file).mtimeMs;
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  let holder = null;
  try {
    const parsed = JSON.parse(text);
    if (Number.isInteger(parsed?.pid)) holder = parsed;
  } catch { /* not a record (yet) */ }
  return { text, holder, mtimeMs };
}

// Moves an abandoned lock aside. True only for the one process whose rename moved the very record
// it judged abandoned; anything else it moved (a lock taken meanwhile) is put back.
function takeAway(file, text) {
  const aside = `${file}.stale-${process.pid}-${randomBytes(4).toString('hex')}`;
  try {
    renameSync(file, aside);
  } catch (err) {
    // Gone: someone else moved it first. Busy (Windows, while another process reads it): retry.
    if (['ENOENT', 'EPERM', 'EBUSY', 'EACCES'].includes(err.code)) return false;
    throw err;
  }
  let moved;
  try { moved = readFileSync(aside, 'utf8'); } catch { moved = undefined; }
  if (moved !== text) {
    try { linkSync(aside, file); } catch { /* a newer lock is in place: it wins */ }
    try { unlinkSync(aside); } catch { /* gone */ }
    return false;
  }
  try { unlinkSync(aside); } catch { /* gone */ }
  return true;
}

function alive(holder, host, boot, mtimeMs, now) {
  if (holder.host && holder.host !== host) return now() - mtimeMs < STALE_MS;
  if (holder.pid === process.pid) return false; // a restarted container reusing our pid
  if (holder.boot && boot && holder.boot !== boot) return false; // from before a reboot
  try {
    process.kill(holder.pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // it exists, it just isn't ours to signal
  }
}

// This boot's id where the OS has one (Linux), else undefined.
function bootId() {
  try {
    return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}
