// File writes that survive a crash (10 §10.6): write a temp file in the same directory, fsync
// it, then rename it over the target. A crash mid-write leaves the old file intact.
import { closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

export function atomicWriteFileSync(file, data, { mode = 0o644 } = {}) {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  const fd = openSync(tmp, 'w', mode);
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameRetrying(tmp, file);
  } catch (err) {
    try { unlinkSync(tmp); } catch {}
    throw err;
  }
  fsyncDir(dir);
}

// Corrupt or unreadable state is moved aside, never silently replaced (10 §10.6).
export function moveAside(file, now = new Date()) {
  const aside = `${file}.corrupt-${fileStamp(now)}`;
  renameRetrying(file, aside);
  return aside;
}

// An ISO timestamp that is safe in file names on every OS: 2026-10-10T21-30-00-000Z.
export function fileStamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

// On Windows a rename fails while another process (antivirus, a sync client) briefly holds the
// file or directory. Retry for up to ~1 s before giving up.
export function renameRetrying(from, to) {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      const transient = process.platform === 'win32' && ['EPERM', 'EACCES', 'EBUSY'].includes(err.code);
      if (!transient || attempt >= 20) throw err;
      sleepSync(50);
    }
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Makes the rename itself durable. POSIX only: Windows can't open a directory for fsync.
function fsyncDir(dir) {
  if (process.platform === 'win32') return;
  let fd;
  try {
    fd = openSync(dir, 'r');
    fsyncSync(fd);
  } catch {
    // Some filesystems refuse to fsync a directory; the data itself is already synced.
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
