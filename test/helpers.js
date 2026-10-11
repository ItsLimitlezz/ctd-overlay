import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLogger } from '../src/log.js';

// Cleanup that runs when the test ends, last registered first, so a store or server opened
// inside a temp directory is closed before the directory is removed (Windows refuses to delete
// open files).
const stacks = new WeakMap();
export function defer(t, fn) {
  let stack = stacks.get(t);
  if (!stack) {
    stack = [];
    stacks.set(t, stack);
    t.after(async () => {
      while (stack.length) await stack.pop()();
    });
  }
  stack.push(fn);
}

// A fresh temporary directory, removed when the test ends.
export function tempDir(t, name = 'skp-') {
  const dir = mkdtempSync(path.join(tmpdir(), name));
  defer(t, () => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  return dir;
}

// A logger that keeps parsed entries in memory.
export function memoryLogger(level = 'debug') {
  const entries = [];
  const log = createLogger({ level, write: (line) => entries.push(JSON.parse(line)) });
  return { log, entries };
}
