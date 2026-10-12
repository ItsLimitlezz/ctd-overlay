// <dataDir>/operations.log: one JSON line per change to the data directory made outside the HTTP
// API (the command line, and the platform's own template updates), until the audit log arrives
// (step 11).
import { appendFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import path from 'node:path';

export function recordOperation(dataDir, op, details) {
  let user;
  try { user = userInfo().username; } catch { user = undefined; }
  const line = JSON.stringify({ ts: new Date().toISOString(), op, user, pid: process.pid, ...details });
  try {
    appendFileSync(path.join(dataDir, 'operations.log'), `${line}\n`, { mode: 0o600 });
  } catch {
    // The change itself is done; a log that can't be written must not undo or hide it.
  }
}
