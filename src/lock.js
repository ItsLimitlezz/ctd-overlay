// One process per data directory. The platform and the CLI's commands that change it take
// <dataDir>/skp.lock: the JSON store rewrites its whole file from memory, so a second writer's
// changes would be lost, and a running server wouldn't see templates installed behind its back.
// A lock left by a process that is gone (a crash, a power cut, a container restarted with the
// same pid) is taken over.
import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import path from 'node:path';

export class LockError extends Error {
  constructor(message, holder) {
    super(message);
    this.name = 'LockError';
    this.holder = holder;
  }
}

const held = new Set(); // lock files this process holds, so two platforms in one process collide too

export function lockDataDir(dataDir, { log, purpose = 'platform' } = {}) {
  const file = path.join(dataDir, 'skp.lock');
  for (let attempt = 0; attempt < 3; attempt++) {
    if (held.has(file)) throw new LockError(`This process already uses the data directory ${dataDir}.`, { pid: process.pid });
    let fd;
    try {
      fd = openSync(file, 'wx', 0o644);
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const holder = readHolder(file);
      if (holder && alive(holder.pid)) {
        const what = holder.purpose === 'platform' ? 'The platform is running' : `"skp ${holder.purpose}" is running`;
        throw new LockError(`${what} with the data directory ${dataDir} (pid ${holder.pid}). Stop it first.`, holder);
      }
      log?.warn('taking over a lock left by a process that is gone', { file, holder });
      try { unlinkSync(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      continue;
    }
    try {
      writeSync(fd, JSON.stringify({ pid: process.pid, purpose, since: new Date().toISOString() }));
    } finally {
      closeSync(fd);
    }
    held.add(file);
    let released = false;
    return {
      file,
      release() {
        if (released) return;
        released = true;
        held.delete(file);
        const holder = readHolder(file);
        if (holder && holder.pid === process.pid) {
          try { unlinkSync(file); } catch { /* already gone */ }
        }
      },
    };
  }
  throw new LockError(`Could not take the lock on ${dataDir}.`);
}

function readHolder(file) {
  try {
    const holder = JSON.parse(readFileSync(file, 'utf8'));
    return Number.isInteger(holder.pid) ? holder : null;
  } catch {
    return null; // half-written or unreadable: treat as stale
  }
}

// Our own pid on a lock we don't hold means a restarted container reused it: stale.
function alive(pid) {
  if (pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // it exists, it just isn't ours to signal
  }
}
