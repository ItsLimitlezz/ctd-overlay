import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
export const TESTBED = { id: 'dev.skp.testbed', version: '1.0.0' };
export const FIXTURE_TEMPLATES = fileURLToPath(new URL('./fixtures/templates/', import.meta.url));

// A running platform on a free port with one overlay (the diagnostic template unless another is
// named), stopped when the test ends. Test fixture templates are always installed.
export async function startWithOverlay(t, { slug = 'diag-1', heartbeatMs, template = DIAG, settings = { accent: '#16e0ff' } } = {}) {
  const root = tempDir(t);
  const config = loadConfig({
    argv: ['--port', '0'],
    env: { SKP_DATA_DIR: path.join(root, 'data'), SKP_CONFIG_DIR: path.join(root, 'config') },
  });
  const { log, entries } = memoryLogger();
  const platform = await startPlatform(config, { log, heartbeatMs, templateDirs: [FIXTURE_TEMPLATES] });
  defer(t, () => platform.stop());
  const overlay = platform.overlays.create({ slug, template, settings });
  const build = platform.templates.get(template.id, template.version).build;
  return { platform, overlay, build, entries, base: `${platform.url}/o/${slug}` };
}
