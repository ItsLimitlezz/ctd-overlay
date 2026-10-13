// Templates the platform can render. For now only the ones built into this repository
// (templates/<name>/template.json); installable .skp packages arrive in step 6 and will register
// here the same way.
//
// Each template version gets a `build`: the first 16 hex digits of a SHA-256 over its files.
// Template files are served under /o/<slug>/t/<build>/, so an upgrade changes every file URL
// (immutable caching never serves stale files, H14) and the URLs can't be guessed without the
// keyed page (04 §4.5, 07 §7.6).
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BUILTIN_DIR = fileURLToPath(new URL('../../templates/', import.meta.url));

export function createTemplateRegistry({ dirs = [BUILTIN_DIR], log }) {
  const byKey = new Map(); // `${id}@${version}` → template

  for (const root of dirs) {
    if (!existsSync(root)) continue;
    for (const name of readdirSync(root)) {
      const dir = path.join(root, name);
      if (!statSync(dir).isDirectory() || !existsSync(path.join(dir, 'template.json'))) continue;
      try {
        const t = loadTemplateDir(dir);
        byKey.set(`${t.id}@${t.version}`, t);
      } catch (err) {
        log.error('skipping a template that could not be loaded', { dir, err });
      }
    }
  }

  return {
    get(id, version) { return byKey.get(`${id}@${version}`); },
    list() { return [...byKey.values()]; },
  };
}

export function loadTemplateDir(dir) {
  const manifest = JSON.parse(readFileSync(path.join(dir, 'template.json'), 'utf8'));
  for (const field of ['id', 'version', 'entry', 'canvases']) {
    if (manifest[field] === undefined) throw new Error(`template.json has no "${field}"`);
  }
  const files = listFiles(dir);
  if (!files.includes(manifest.entry)) throw new Error(`the entry "${manifest.entry}" is missing`);
  const hash = createHash('sha256');
  for (const rel of files) {
    hash.update(rel).update('\0').update(readFileSync(path.join(dir, rel))).update('\0');
  }
  return {
    id: manifest.id,
    version: manifest.version,
    manifest,
    dir,
    build: hash.digest('hex').slice(0, 16),
    entry: readFileSync(path.join(dir, manifest.entry), 'utf8'),
  };
}

// Template-relative paths of every file, "/"-separated and sorted, so the build hash is the same
// on every OS.
function listFiles(dir, prefix = '') {
  const out = [];
  for (const name of readdirSync(path.join(dir, prefix)).sort()) {
    const rel = prefix ? `${prefix}/${name}` : name;
    if (statSync(path.join(dir, rel)).isDirectory()) out.push(...listFiles(dir, rel));
    else out.push(rel);
  }
  return out.sort();
}

// The default canvas, or the one `canvas` names (01 §1.4: the one allowed URL parameter), by id
// or as <w>x<h> (`1080x1920`). An id wins over a size that reads the same.
export function pickCanvas(manifest, requested) {
  const canvases = manifest.canvases;
  const size = /^(\d+)x(\d+)$/.exec(requested ?? '');
  return canvases.find((c) => c.id === requested) ||
    (size && canvases.find((c) => c.width === Number(size[1]) && c.height === Number(size[2]))) ||
    canvases.find((c) => c.default) || canvases[0];
}
