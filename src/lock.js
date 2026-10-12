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
// Only one process at a time may remove a lock judged abandoned: it takes skp.lock.takeover (made
// the same atomic way) first, reads skp.lock again, and removes it only if it still holds the
// record that was judged. Nothing else ever removes a lock but its own holder, so a live
// holder's lock is never lost to a race.
import { randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, linkSync, openSync, readFileSync, statSync, unlinkSync, utimesSync, writeSync } from 'node:fs';
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
const ATTEMPTS = 40;
const PAUSE_MS = 25; // between attempts, while another process is taking over or the file is busy
// Windows answers these while a file is being deleted or read by another process: try again.
const BUSY = new Set(['EPERM', 'EBUSY', 'EACCES']);
const held = new Set(); // lock files this process holds, so two platforms in one process collide too

export function lockDataDir(dataDir, { log, purpose = 'platform', now = Date.now } = {}) {
  const file = path.join(dataDir, 'skp.lock');
  const host = hostname();
  const boot = bootId();
  const links = supportsLinks(dataDir);
  const record = JSON.stringify({ pid: process.pid, host, boot, purpose, since: new Date(now()).toISOString() });
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    if (held.has(file)) throw new LockError(`This process already uses the data directory ${dataDir}.`, { pid: process.pid });
    if (attempt) pause(PAUSE_MS);
    if (create(file, record, links)) {
      held.add(file);
      return handle(file, host, now);
    }
    const seen = readLock(file);
    if (seen === null) continue; // gone since, or busy: try again
    const holder = seen.holder;
    if (holder ? alive(holder, host, boot, seen.mtimeMs, now) : now() - seen.mtimeMs < YOUNG_MS) {
      const what = !holder ? 'Another process is starting' : holder.purpose === 'platform' ? 'The platform is running' : `"skp ${holder.purpose}" is running`;
      const where = holder?.host && holder.host !== host ? ` on ${holder.host}` : '';
      throw new LockError(`${what}${where} with the data directory ${dataDir}${holder ? ` (pid ${holder.pid})` : ''}. Stop it first. (If nothing is running, delete ${file}.)`, holder);
    }
    if (takeOver(file, seen.text, links)) log?.warn('took over a lock left by a process that is gone', { file, holder });
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

// Makes `file` hold `record`, or returns false if it exists (or is busy being deleted).
function create(file, record, links) {
  const taken = (err) => err.code === 'EEXIST' || BUSY.has(err.code);
  if (!links) {
    // No hard links here: an exclusive create, written at once.
    try {
      writeSynced(file, record, 'wx');
      return true;
    } catch (err) {
      if (taken(err)) return false;
      throw err;
    }
  }
  const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}`;
  writeSynced(temp, record, 'wx');
  try {
    linkSync(temp, file);
    return true;
  } catch (err) {
    if (taken(err)) return false;
    throw err;
  } finally {
    try { unlinkSync(temp); } catch { /* already gone */ }
  }
}

// Whether this directory's filesystem has hard links (FAT and some network shares don't).
function supportsLinks(dir) {
  const a = path.join(dir, `.skp-link-${process.pid}-${randomBytes(4).toString('hex')}`);
  const b = `${a}.l`;
  try {
    writeSynced(a, '', 'wx');
    linkSync(a, b);
    return true;
  } catch {
    return false;
  } finally {
    for (const f of [b, a]) try { unlinkSync(f); } catch { /* not made */ }
  }
}

function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
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

// { text, holder, mtimeMs } for skp.lock (holder null when it isn't a record), or null if absent
// (or busy: being deleted on Windows).
function readLock(file) {
  let text;
  let mtimeMs;
  try {
    mtimeMs = statSync(file).mtimeMs;
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT' || BUSY.has(err.code)) return null;
    throw err;
  }
  let holder = null;
  try {
    const parsed = JSON.parse(text);
    if (Number.isInteger(parsed?.pid)) holder = parsed;
  } catch { /* not a record (yet) */ }
  return { text, holder, mtimeMs };
}

// Removes an abandoned lock, if this process gets to: true only for the one process that holds the
// takeover guard and finds skp.lock still holding the very record it judged abandoned. A lock
// taken meanwhile is a live one, and is left alone.
function takeOver(file, text, links) {
  const guard = `${file}.takeover`;
  if (!create(guard, JSON.stringify({ pid: process.pid, since: new Date().toISOString() }), links)) {
    // Another process is taking it over. A guard left by one that died midway is cleared (by
    // real time: these are milliseconds of work), and the next attempt goes on.
    const g = readLock(guard);
    if (g && Date.now() - g.mtimeMs > YOUNG_MS) try { unlinkSync(guard); } catch { /* gone */ }
    return false;
  }
  try {
    const seen = readLock(file);
    if (!seen || seen.text !== text) return false; // changed since it was judged: judge again
    unlinkSync(file);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT' || BUSY.has(err.code)) return false;
    throw err;
  } finally {
    try { unlinkSync(guard); } catch { /* gone */ }
  }
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
