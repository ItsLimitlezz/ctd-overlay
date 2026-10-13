import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startPlatform } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createLogger } from '../src/log.js';
import { openStore } from '../src/store/index.js';
import { packageFromDir } from '../src/templates/package.js';
import { writeZip } from '../src/templates/zip.js';

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

// The headers that sign a test in as the command line does: the platform's local token.
export const signedIn = (platform, headers = {}) => ({ authorization: `Bearer ${platform.auth.localToken}`, ...headers });

// The audit log of a data directory no process holds (the platform stopped, a CLI command done),
// oldest first.
export function auditOf(config) {
  const store = openStore({ dataDir: config.dataDir, backend: config.store });
  try {
    const out = [];
    for (let after = ''; ;) {
      const page = store.list('audit', { after, limit: 1000 });
      out.push(...page.map((d) => d.data));
      if (page.length < 1000) break;
      after = page[page.length - 1].id;
    }
    return out.reverse();
  } finally {
    store.close();
  }
}

export const DIAG = { id: 'dev.skp.diagnostic', version: '1.0.0' };
export const TESTBED = { id: 'dev.skp.testbed', version: '1.0.0' };
export const FIXTURE_TEMPLATES = fileURLToPath(new URL('./fixtures/templates/', import.meta.url));
export const DIAG_DIR = fileURLToPath(new URL('../templates/diagnostic/', import.meta.url));
export const TESTBED_DIR = path.join(FIXTURE_TEMPLATES, 'testbed');

// A .skp package, in memory, made from a template directory with changes: `manifest` fields
// merged over its template.json, `files` added or replaced ({ name: content }), `remove` names
// left out, `wrap` a folder to put everything in.
export function packTemplate(dir, { manifest = {}, files = {}, remove = [], wrap } = {}) {
  const pkg = packageFromDir(dir);
  const out = new Map(pkg.names.filter((n) => !remove.includes(n)).map((n) => [n, pkg.read(n)]));
  if (Object.keys(manifest).length) {
    const base = JSON.parse(pkg.read('template.json').toString('utf8'));
    out.set('template.json', Buffer.from(JSON.stringify({ ...base, ...manifest }, null, 2)));
  }
  for (const [name, content] of Object.entries(files)) {
    if (content === undefined) out.delete(name);
    else out.set(name, Buffer.from(typeof content === 'string' ? content : JSON.stringify(content)));
  }
  return writeZip([...out].map(([name, data]) => ({ name: wrap ? `${wrap}/${name}` : name, data })));
}

// A running platform on a free port with one overlay (the diagnostic template unless another is
// named), stopped when the test ends. Test fixture templates are always available; `install`
// lists .skp packages (packTemplate) to install before the overlay is created.
export async function startWithOverlay(t, { slug = 'diag-1', heartbeatMs, template = DIAG, settings = { accent: '#16e0ff' }, install = [], platform: platformOptions = {} } = {}) {
  const root = tempDir(t);
  const config = loadConfig({
    argv: ['--port', '0'],
    env: { SKP_DATA_DIR: path.join(root, 'data'), SKP_CONFIG_DIR: path.join(root, 'config') },
  });
  const { log, entries } = memoryLogger();
  const platform = await startPlatform(config, { log, heartbeatMs, templateDirs: [FIXTURE_TEMPLATES], ...platformOptions });
  defer(t, () => platform.stop());
  for (const pkg of install) platform.templates.install(pkg, { actor: 'test' });
  const overlay = platform.overlays.create({ slug, template, settings });
  const build = platform.templates.get(template.id, template.version).build;
  return { platform, overlay, build, entries, config, base: `${platform.url}/o/${slug}` };
}
