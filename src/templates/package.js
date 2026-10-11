// Template packages (04 §4.1–4.3, §4.11): one view over a .skp archive or a template directory,
// the build hash, and validation.
//
//   const pkg = packageFromZip(source) | packageFromDir(dir)
//   pkg.names → package-relative paths, sorted; pkg.size(name); pkg.read(name) → Buffer
//   validatePackage(pkg) → { manifest, errors: [finding], warnings: [finding], skipped }
//   buildOf(pkg) → { build, files: [{ path, size, sha256 }] }
//
// A finding is { level, code, path, message }: `path` is a file in the package or a JSON pointer
// into template.json, and `message` says what is wrong and what to do (08 §8.8). Errors block an
// install; warnings are shown (04 §4.11). The same shape becomes a problem+json 422 when the HTTP
// routes arrive (step 13).
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { compilePatterns, TYPE } from '../bus/names.js';
import { validate } from '../schema.js';
import { checkSettingsSchema, settingsSchema, boundKeys } from './settings.js';
import { checkName, openZip, ZIP_LIMITS, ZipError } from './zip.js';

export const STANDARD = 'skp/1';
const MANIFEST = 'template.json';
const MANIFEST_BYTES = 1024 * 1024;
const ENTRY_BYTES = 2 * 1024 * 1024;
const JUNK = /(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini)$|(^|\/)__MACOSX(\/|$)/i;
const CATEGORY_CORES = { show: ['starting', 'program', 'brb', 'outro'] };
const ALL_CORES = ['auto', 'starting', 'program', 'brb', 'lineup', 'outro', 'bg', 'intro'];
const KNOWN_FIELDS = new Set(['$schema', 'standard', 'id', 'name', 'version', 'description', 'author', 'license', 'category', 'tags', 'entry', 'previews', 'engines', 'canvases', 'scenes', 'consumes', 'settings', 'actions', 'alerts', 'transitions', 'fonts', 'definitions', '$defs']);

// The manifest schema is the standard's own file (single source of truth; packaging ships it).
const TEMPLATE_SCHEMA = JSON.parse(readFileSync(new URL('../../docs/standard/schemas/template.schema.json', import.meta.url), 'utf8'));

export class PackageError extends Error {
  constructor(message, code = 'bad-package') {
    super(message);
    this.name = 'PackageError';
    this.code = code;
  }
}

// An archive. Its files may sit inside one wrapping folder (the 04 §4.1 tree, and what macOS
// Finder's Compress makes); that folder is not part of the package's paths.
export function packageFromZip(source, limits) {
  const zip = openZip(source, limits);
  let prefix = '';
  if (!zip.entries.some((e) => e.name === MANIFEST)) {
    const tops = new Set(zip.entries.map((e) => e.name.split('/')[0]));
    const [top] = tops;
    if (tops.size === 1 && zip.entries.some((e) => e.name === `${top}/${MANIFEST}`)) prefix = `${top}/`;
  }
  const byName = new Map();
  for (const e of zip.entries) byName.set(e.name.slice(prefix.length), e);
  return {
    kind: 'zip',
    names: [...byName.keys()].sort(),
    skipped: zip.skipped,
    has: (name) => byName.has(name),
    size: (name) => byName.get(name)?.size,
    read(name) {
      const e = byName.get(name);
      if (!e) throw new PackageError(`"${name}" is not in the package.`);
      return zip.read(e);
    },
  };
}

// A directory: a bundled template, or an installed one on disk. Links and special files are
// refused (they would be followed when served), clutter is skipped, and the same limits and path
// rules as an archive apply.
export function packageFromDir(dir, limits = {}) {
  const max = { ...ZIP_LIMITS, ...limits };
  const sizes = new Map();
  const skipped = [];
  let total = 0;
  const walk = (rel) => {
    for (const name of readdirSync(path.join(dir, rel)).sort()) {
      const relPath = rel ? `${rel}/${name}` : name;
      if (JUNK.test(relPath)) { skipped.push(relPath); continue; }
      checkName(relPath, max);
      const st = lstatSync(path.join(dir, relPath));
      if (st.isSymbolicLink()) throw new ZipError(`"${relPath}" is a symbolic link; packages can't contain links.`, 'unsafe-path');
      if (st.isDirectory()) { walk(relPath); continue; }
      if (!st.isFile()) throw new ZipError(`"${relPath}" is not a regular file.`, 'unsafe-path');
      if (st.size > max.fileBytes) throw new ZipError(`"${relPath}" is larger than ${max.fileBytes} bytes.`, 'too-large');
      total += st.size;
      if (total > max.totalBytes) throw new ZipError(`The template is larger than ${max.totalBytes} bytes.`, 'too-large');
      if (sizes.size >= max.entries) throw new ZipError(`The template has more than ${max.entries} files.`, 'too-many');
      sizes.set(relPath, st.size);
    }
  };
  walk('');
  const names = [...sizes.keys()].sort();
  const folded = new Map();
  for (const name of names) {
    const key = name.normalize('NFC').toLowerCase();
    if (folded.has(key)) throw new ZipError(`"${folded.get(key)}" and "${name}" differ only in case or accents.`, 'duplicate');
    folded.set(key, name);
  }
  return {
    kind: 'dir',
    dir,
    names,
    skipped,
    has: (name) => sizes.has(name),
    size: (name) => sizes.get(name),
    read(name) {
      if (!sizes.has(name)) throw new PackageError(`"${name}" is not in the package.`);
      return readFileSync(path.join(dir, ...name.split('/')));
    },
  };
}

// The build: the first 16 hex digits of a SHA-256 over the file tree (04 §4.5), the same for an
// archive and for the directory it came from, on every OS. Each file contributes its path and
// the SHA-256 of its content, one line each, so no two different trees can hash alike (a raw
// concatenation of paths and contents could). Also returns the per-file digests, for the install
// receipt.
export function buildOf(pkg) {
  const files = pkg.names.map((name) => {
    const data = pkg.read(name);
    return { path: name, size: data.length, sha256: createHash('sha256').update(data).digest('hex') };
  });
  return { build: buildFromFiles(files), files };
}

export function buildFromFiles(files) {
  const hash = createHash('sha256');
  for (const f of files.slice().sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) hash.update(`${f.path}\0${f.sha256}\n`);
  return hash.digest('hex').slice(0, 16);
}

export function validatePackage(pkg) {
  const errors = [];
  const warnings = [];
  const error = (code, where, message) => errors.push({ level: 'error', code, path: where, message });
  const warn = (code, where, message) => warnings.push({ level: 'warning', code, path: where, message });
  const result = (manifest) => ({ manifest, errors, warnings, skipped: pkg.skipped || [], headless: 'skipped' });

  // template.json: present, small, JSON (a UTF-8 BOM, as Windows PowerShell 5.1 writes, is fine).
  if (!pkg.has(MANIFEST)) {
    error('manifest-missing', MANIFEST, 'The package has no template.json at its root (or inside its one top folder).');
    return result(undefined);
  }
  if (pkg.size(MANIFEST) > MANIFEST_BYTES) {
    error('manifest-too-large', MANIFEST, `template.json is over ${MANIFEST_BYTES / 1024} KiB.`);
    return result(undefined);
  }
  let manifest;
  const text = pkg.read(MANIFEST).toString('utf8').replace(/^﻿/, '');
  try {
    manifest = JSON.parse(text);
  } catch (err) {
    error('manifest-json', MANIFEST, `template.json is not valid JSON: ${jsonError(text, err)}.`);
    return result(undefined);
  }
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    error('manifest-json', MANIFEST, 'template.json must hold a JSON object.');
    return result(undefined);
  }

  // The standard first: a manifest for another version of it is judged by different rules.
  if (manifest.standard !== STANDARD) {
    error('unsupported-standard', '/standard', `This platform implements ${STANDARD}; the template says ${JSON.stringify(manifest.standard)}.`);
    return result(manifest);
  }
  for (const e of validate(TEMPLATE_SCHEMA, manifest)) error('manifest-invalid', e.path, `template.json ${e.path} ${e.message}.`);
  for (const key of Object.keys(manifest)) if (!KNOWN_FIELDS.has(key)) warn('unknown-field', `/${key}`, `"${key}" is not a field this platform knows; it is ignored.`);
  if (errors.length) return result(manifest); // the rest assumes the schema's shapes

  // Files the manifest names exist, inside the package (paths compared exactly: a case
  // difference works on Windows and macOS and breaks on Linux).
  const file = (where, rel, what) => {
    if (typeof rel !== 'string' || /^[a-z][a-z0-9+.-]*:/i.test(rel) || rel.startsWith('/') || rel.includes('\\') || rel.split('/').some((s) => s === '..' || s === '.' || s === '')) {
      error('path-invalid', where, `${what} ${JSON.stringify(rel)} must be a path inside the package, like "assets/x.png".`);
      return false;
    }
    if (!pkg.has(rel)) {
      const near = pkg.names.find((n) => n.toLowerCase() === rel.toLowerCase());
      error('file-missing', where, `${what} "${rel}" is not in the package${near ? ` (there is "${near}": paths are case-sensitive)` : ''}.`);
      return false;
    }
    return true;
  };
  if (file('/entry', manifest.entry, 'The entry document')) {
    if (!/\.html?$/i.test(manifest.entry)) error('entry-not-html', '/entry', `The entry "${manifest.entry}" must be an .html file.`);
    else if (pkg.size(manifest.entry) > ENTRY_BYTES) error('entry-too-large', '/entry', `The entry document is over ${ENTRY_BYTES / 1024 / 1024} MiB.`);
    else lintEntry(pkg.read(manifest.entry).toString('utf8'), manifest.entry, error, warn);
  }
  manifest.previews.forEach((p, i) => file(`/previews/${i}`, p, 'The preview'));

  // IDs are unique, so shows, buttons and cues can name them.
  for (const list of ['scenes', 'actions', 'canvases', 'transitions']) {
    const seen = new Set();
    (manifest[list] || []).forEach((item, i) => {
      if (seen.has(item.id)) error('duplicate-id', `/${list}/${i}/id`, `The ${list.slice(0, -1)} id "${item.id}" is used twice.`);
      seen.add(item.id);
    });
  }
  if (manifest.canvases.filter((c) => c.default).length > 1) warn('canvas-default', '/canvases', 'More than one canvas is marked default; the first one is used.');

  // Scenes: core scenes a category needs (04 §4.2), and timed scenes that return somewhere real.
  const scenes = manifest.scenes;
  const cores = new Map();
  scenes.forEach((s, i) => {
    if (!s.core) return;
    if (cores.has(s.core)) warn('duplicate-core', `/scenes/${i}/core`, `Two scenes map to the core scene "${s.core}"; shows will use "${cores.get(s.core)}".`);
    else cores.set(s.core, s.id);
  });
  for (const core of CATEGORY_CORES[manifest.category] || []) {
    if (!cores.has(core)) error('core-scene-missing', '/scenes', `A "${manifest.category}" template must have a scene with "core": "${core}".`);
  }
  if (manifest.category === 'show') {
    for (const core of ALL_CORES) if (!cores.has(core) && !(CATEGORY_CORES.show.includes(core))) warn('core-scene-missing', '/scenes', `A show template should have a scene with "core": "${core}".`);
  }
  const byId = new Map(scenes.map((s) => [s.id, s]));
  scenes.forEach((s, i) => {
    if (s.then !== undefined) {
      const target = byId.get(s.then) || scenes.find((x) => x.core === s.then);
      if (!target) error('then-unknown', `/scenes/${i}/then`, `Scene "${s.id}" returns to "${s.then}", which is not one of its scenes.`);
      else if (target.id === s.id) error('then-loop', `/scenes/${i}/then`, `Scene "${s.id}" returns to itself.`);
    } else if (s.durationMs !== undefined) {
      warn('duration-without-then', `/scenes/${i}/durationMs`, `Scene "${s.id}" has a duration but no "then", so nothing returns from it.`);
    }
  });
  // A chain of zero-length timed scenes would have the server switch scenes in a tight loop.
  for (const s of scenes) {
    const seen = new Set();
    let at = s;
    while (at && at.then !== undefined && at.durationMs === 0 && !seen.has(at.id)) {
      seen.add(at.id);
      at = byId.get(at.then) || scenes.find((x) => x.core === at.then);
    }
    if (at && seen.has(at.id)) { error('then-loop', '/scenes', `The scenes ${[...seen].join(' → ')} return to each other with no time between.`); break; }
  }

  // consumes: patterns the bus can compile, in namespaces that exist (02 §2.6–2.7).
  const consumes = manifest.consumes || {};
  for (const kind of ['state', 'events']) {
    try {
      compilePatterns(consumes[kind] || [], kind === 'state' ? 'state key' : 'event type');
    } catch (err) {
      error('consumes-invalid', `/consumes/${kind}`, `consumes.${kind}: ${err.message}. Use an exact name or a prefix ending in ".*".`);
    }
  }
  for (const [i, t] of (consumes.events || []).entries()) {
    const name = String(t);
    if (name.startsWith('chat.') && !consumes.chat) warn('consumes-chat', `/consumes/events/${i}`, `Chat reaches a template through "consumes.chat", not "${name}".`);
    else if (!name.endsWith('.*') && !TYPE.test(name)) warn('consumes-unknown', `/consumes/events/${i}`, `"${name}" is not an event type of the standard, custom.* or x-<vendor>.*; is it a typo?`);
    // "alerts.*" would match only alerts.cut, which comes with alert.* anyway: almost surely a typo.
    else if (name.endsWith('.*') && !/^(alert|chat|show|media|system|custom|x-[a-z0-9-]+)\./.test(name)) warn('consumes-unknown', `/consumes/events/${i}`, `"${name}" matches no event type of the standard; is it a typo?`);
  }
  const declaredState = safePatterns(consumes.state);

  // Transitions: a stinger's video is in the package; "cut" is the runtime's own (05 §5.4).
  (manifest.transitions || []).forEach((t, i) => {
    if (t.id === 'cut' || t.id === 'fade') error('transition-reserved', `/transitions/${i}/id`, `"${t.id}" is a built-in transition; give the template's own a different id.`);
    if (t.media !== undefined && file(`/transitions/${i}/media`, t.media, 'The stinger video')) {
      if (/\.mov$/i.test(t.media)) warn('media-mov', `/transitions/${i}/media`, 'OBS\'s browser can\'t play .mov reliably; use WebM or MP4 (H12).');
      else if (!/\.(webm|mp4)$/i.test(t.media)) warn('media-not-video', `/transitions/${i}/media`, `"${t.media}" doesn't look like a WebM or MP4 video.`);
    }
  });

  // Fonts: https only; the page's CSP allows exactly these hosts (04 §4.8).
  (manifest.fonts || []).forEach((u, i) => {
    let ok = false;
    try { ok = new URL(u).protocol === 'https:'; } catch { ok = false; }
    if (!ok) error('font-url', `/fonts/${i}`, `Font stylesheet ${JSON.stringify(u)} must be an https:// URL.`);
  });

  // Settings (04 §4.3).
  const settings = checkSettingsSchema(manifest);
  for (const m of settings.errors) {
    if (/^alerts\.durationSetting .* declares no settings$/.test(m)) warn('settings', '/alerts/durationSetting', `${m}; the manifest's alerts.durationMs is used instead.`);
    else error('settings', '/settings', m);
  }
  for (const m of settings.warnings) warn('settings', '/settings', m);
  if (settingsSchema(manifest)) {
    for (const key of boundKeys(manifest)) {
      if (!declaredState(key)) warn('bind-undeclared', '/settings', `A setting is bound to "${key}", which consumes.state doesn't declare; the template would see it only through its settings.`);
    }
  }

  // migrate.js, if any, is a classic script: no other imports or exports (04 §4.10).
  if (pkg.has('migrate.js')) {
    const src = pkg.read('migrate.js').toString('utf8');
    if (/^\s*import[\s{*]/m.test(src) || /\bimport\s*\(/.test(src)) error('migrate-import', 'migrate.js', 'migrate.js can\'t import anything; it runs with no I/O.');
  }

  // Paths that work but invite trouble (04 §4.1: lowercase recommended).
  for (const name of pkg.names) {
    if (/[#?%\s]/.test(name)) warn('path-escape', name, `"${name}" has a character that needs escaping in a URL (space, #, ? or %).`);
    else if (name !== name.toLowerCase()) warn('path-case', name, `"${name}" has capitals; lowercase paths avoid case mistakes.`);
    if (/\.css$/i.test(name) && pkg.size(name) <= ENTRY_BYTES) lintCss(pkg.read(name).toString('utf8'), name, warn);
  }
  return result(manifest);
}

// The entry document (04 §4.5, §4.8): no <base> of its own, no inline script (the CSP blocks it),
// and its own files by relative URL.
function lintEntry(html, where, error, warn) {
  const visible = html.replace(/<!--[\s\S]*?-->/g, '');
  if (/<base[\s>]/i.test(visible)) error('entry-base', where, 'The entry has its own <base>; the runtime inserts one, so remove it (04 §4.5).');
  if (/<script(?![^>]*\bsrc\s*=)[^>]*>\s*[^<\s]/i.test(visible)) warn('inline-script', where, 'The entry has an inline <script>, which the overlay CSP blocks; move it into a .js file.');
  if (/\son[a-z]+\s*=\s*["']/i.test(visible)) warn('inline-handler', where, 'The entry has an inline event handler (onclick=…), which the overlay CSP blocks.');
  if (/\s(?:src|href)\s*=\s*["']\/(?!\/)/i.test(visible)) warn('absolute-url', where, 'The entry loads a file by an absolute "/…" URL; use a relative one, so it resolves inside the package.');
}

function lintCss(css, where, warn) {
  const code = css.replace(/\/\*[\s\S]*?\*\//g, '');
  if (/\bbackdrop-filter\s*:/.test(code)) warn('css-backdrop-filter', where, 'backdrop-filter blurs nothing in a browser source and costs GPU; blur the camera with an OBS filter (05 §5.8).');
  if (/\bmix-blend-mode\s*:\s*multiply/.test(code)) warn('css-blend', where, 'mix-blend-mode: multiply turns a transparent overlay black (05 §5.8, H10).');
  if (/url\(\s*["']?\/(?!\/)/.test(code)) warn('absolute-url', where, 'A stylesheet loads a file by an absolute "/…" URL; use a relative one.');
  if (/:has\(|@container\b/.test(code)) warn('css-too-new', where, ':has() and container queries need Chromium 105; OBS 30 runs 103.');
}

function safePatterns(patterns) {
  try {
    return compilePatterns(patterns || []);
  } catch {
    return () => false;
  }
}

// "line 3, column 14: Unexpected token }" from a JSON.parse error.
function jsonError(text, err) {
  const m = /position (\d+)/.exec(err.message);
  if (!m) return err.message;
  const pos = Number(m[1]);
  const before = text.slice(0, pos).split('\n');
  return `line ${before.length}, column ${before[before.length - 1].length + 1}: ${err.message.replace(/ in JSON at position \d+.*$/, '')}`;
}
