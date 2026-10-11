import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startPlatform } from '../src/app.js';
import { loadConfig } from '../src/config.js';
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

export const DIAG = { id: 'dev.skp.diagnostic', version: '1.0.0' };

// A running platform on a free port with one diagnostic overlay, stopped when the test ends.
export async function startWithOverlay(t, { slug = 'diag-1', heartbeatMs } = {}) {
  const root = tempDir(t);
  const config = loadConfig({
    argv: ['--port', '0'],
    env: { SKP_DATA_DIR: path.join(root, 'data'), SKP_CONFIG_DIR: path.join(root, 'config') },
  });
  const { log, entries } = memoryLogger();
  const platform = await startPlatform(config, { log, heartbeatMs });
  defer(t, () => platform.stop());
  const overlay = platform.overlays.create({ slug, template: DIAG, settings: { accent: '#16e0ff' } });
  const build = platform.templates.get(DIAG.id, DIAG.version).build;
  return { platform, overlay, build, entries, base: `${platform.url}/o/${slug}` };
}
