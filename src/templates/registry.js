// Templates the platform can render: the ones bundled with it (templates/<name>/) and the ones
// installed from .skp packages into the data directory (04 §4.1, §4.10).
//
//   <dataDir>/templates/<id>/<build>/package/…        the package's files, never changed again
//   <dataDir>/templates/<id>/<build>/install.json     the receipt: id, version, build, every
//                                                      file's size and SHA-256, where it came from
//
// Each template version gets a `build`: the first 16 hex digits of a SHA-256 over its files
// (package.js). Files are served under /o/<slug>/t/<build>/, so new content always arrives under
// a new URL (immutable caching never serves stale files, H14) that can't be guessed without the
// keyed page (04 §4.5, 07 §7.6). Only files the registry listed are served.
//
// An installed id@version is immutable: installing the same bytes again does nothing, different
// bytes are refused ("bump the version"), and installing a newer version changes no overlay
// (04 §4.10). Installs and uninstalls are crash-safe: work happens in a staging directory renamed
// into place in one step, removals rename aside first, and startup sweeps whatever a crash left.
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWriteFileSync, renameRetrying } from '../fsutil.js';
import { buildFromFiles, buildOf, packageFromDir, packageFromZip, validatePackage } from './package.js';
import { bufferSource, fileSource } from './zip.js';

export const BUILTIN_DIR = fileURLToPath(new URL('../../templates/', import.meta.url));
const RECEIPT = 'install.json';
const ID_DIR = /^[a-z0-9]+(\.[a-z0-9-]+){2,}$/; // the manifest's id pattern
const BUILD_DIR = /^[0-9a-f]{16}$/;

export class TemplateError extends Error {
  constructor(message, code, findings = []) {
    super(message);
    this.name = 'TemplateError';
    this.code = code;
    this.findings = findings;
  }
}

// dirs: roots of bundled templates (one template per subdirectory); dataDir: where installed
// templates live (omit it for a registry of bundled templates only). readOnly: look, don't touch
// (another process holds the data directory): no sweeping, no installs. reserve: roots whose
// templates' ids are the platform's own, so no package can publish a version of them.
export function createTemplateRegistry({ dirs = [BUILTIN_DIR], dataDir, log, readOnly = false, reserve = [BUILTIN_DIR] }) {
  const byKey = new Map(); // `${id}@${version}` → template
  // Ids that are the platform's own: bundled from a reserved root, or retained from one by an
  // earlier platform version (a later one may no longer ship it; the id stays the platform's).
  const reserved = new Set();
  // `${id}@${version}` → the copy this platform ships (kept even when an installed copy with
  // other content is the one served, so it can be served again if that copy goes).
  const shipped = new Map();
  const installedListeners = new Set();
  const root = dataDir ? path.join(dataDir, 'templates') : null;

  if (root && !readOnly) {
    mkdirSync(root, { recursive: true });
    sweep(root, log);
  }
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    const reservedRoot = reserve.some((r) => path.resolve(r) === path.resolve(dir));
    for (const name of readdirSync(dir).sort()) {
      const sub = path.join(dir, name);
      if (!lstatSync(sub).isDirectory() || !existsSync(path.join(sub, 'template.json'))) continue;
      try {
        const t = loadBundled(sub, log);
        t.reservedRoot = reservedRoot;
        shipped.set(`${t.id}@${t.version}`, t);
        register(t);
        if (reservedRoot) reserved.add(t.id);
      } catch (err) {
        log.error('skipping a template that could not be loaded', { dir: sub, err: err.message, findings: err.findings });
      }
    }
  }
  if (root && existsSync(root)) {
    for (const id of readdirSync(root).sort()) {
      if (id.startsWith('.') || !ID_DIR.test(id)) continue;
      for (const build of readdirSync(path.join(root, id)).sort()) {
        if (!BUILD_DIR.test(build)) continue;
        try {
          const t = loadInstalled(path.join(root, id, build), log);
          if (t.receipt.source?.kind === 'bundled' && t.receipt.source.reserved !== false) reserved.add(t.id);
          register(t);
        } catch (err) {
          log.error('skipping an installed template that could not be loaded', { dir: path.join(root, id, build), err: err.message, findings: err.findings });
        }
      }
    }
  }

  // One template per id@version. An installed copy wins over a bundled one with other content:
  // it is what pinned overlays have been showing, and a platform update must not change a look
  // on air (installs can't create this case; a platform update can).
  function register(t) {
    const key = `${t.id}@${t.version}`;
    const had = byKey.get(key);
    if (had && had.build !== t.build) {
      const keep = t.source === 'installed' ? t : had;
      const drop = keep === t ? had : t;
      log.warn('two copies of a template version differ; using one', { template: key, using: { source: keep.source, build: keep.build, dir: keep.dir }, ignoring: { source: drop.source, build: drop.build, dir: drop.dir } });
      byKey.set(key, keep);
      return keep;
    }
    if (!had || t.source === 'installed') byKey.set(key, t);
    return byKey.get(key);
  }

  // Whether a template came with the platform: bundled, a retained copy of a bundled one, or an
  // installed copy whose content is exactly the shipped one. Decided by content, not by name: a
  // package installed under a shipped id@version is still the package's code (its migrate.js
  // must not run unasked, 04 §4.10).
  function fromPlatform(t) {
    if (!t) return false;
    return t.source === 'bundled' || t.receipt?.source?.kind === 'bundled' || shipped.get(`${t.id}@${t.version}`)?.build === t.build;
  }

  // Installs a package: a file path, or { buffer } (tests). Returns { template, warnings, noop }.
  function install(input, { actor = 'cli', name } = {}) {
    if (!root || readOnly) throw new TemplateError('This registry can\'t install: it has no data directory, or another process holds it.', 'read-only');
    let fd;
    let source;
    let label = name;
    if (Buffer.isBuffer(input)) {
      source = bufferSource(input);
      label ||= 'upload';
    } else {
      fd = openSync(input, 'r');
      source = fileSource(fd, fstatSync(fd).size);
      label ||= path.basename(input);
    }
    try {
      const pkg = packageFromZip(source);
      const refuse = (result) => new TemplateError(`The package has ${result.errors.length} problem${result.errors.length === 1 ? '' : 's'}; nothing was installed.`, 'invalid', [...result.errors, ...result.warnings]);
      const early = validatePackage(pkg); // fails fast, before anything is written
      if (early.errors.length) throw refuse(early);
      const staging = path.join(root, `.staging-${randomBytes(6).toString('hex')}`);
      try {
        const files = extract(pkg, path.join(staging, 'package'));
        // What was written is what gets installed, so that is what gets validated: the archive
        // could have changed since it was first read.
        const result = validatePackage(packageFromDir(path.join(staging, 'package')));
        if (result.errors.length) throw refuse(result);
        const { id, version } = result.manifest;
        const build = buildFromFiles(files);
        const existing = byKey.get(`${id}@${version}`);
        if (existing && existing.build === build) return { template: existing, warnings: result.warnings, noop: true };
        if (reserved.has(id)) {
          throw new TemplateError(`${id} is a template that ships with the platform; a package can't add or replace versions of it.`, 'reserved-id');
        }
        if (existing) {
          throw new TemplateError(`${id}@${version} is already installed with other content; give the package a new version (installed versions never change, 04 §4.10).`, 'version-exists');
        }
        const receipt = {
          id, version, build,
          packageSha256: archiveHash(source),
          installedAt: new Date().toISOString(),
          source: { kind: 'package', name: label },
          actor,
          files,
        };
        atomicWriteFileSync(path.join(staging, RECEIPT), `${JSON.stringify(receipt, null, 2)}\n`);
        const target = path.join(root, id, build);
        placeIn(root, id, staging, target);
        const template = register(loadInstalled(target, log, receipt));
        log.info('template installed', { template: `${id}@${version}`, build, actor, source: label });
        for (const fn of installedListeners) {
          try { fn(template); } catch (err) { log.error('a listener for installed templates failed', { err: err.message }); }
        }
        return { template, warnings: result.warnings, noop: false };
      } finally {
        if (existsSync(staging)) rmSync(staging, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      }
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  // Removes one installed version (or every installed version of an id when version is omitted).
  // pinnedBy(id, version) → slugs of overlays that use it: any, and nothing is removed.
  function uninstall(id, version, { pinnedBy = () => [], actor = 'cli' } = {}) {
    const targets = [...byKey.values()].filter((t) => t.id === id && (version === undefined || t.version === version));
    if (!targets.length) throw new TemplateError(`${version ? `${id}@${version}` : id} is not installed.`, 'not-found');
    // What came with the platform stays, retained copies included: removing one would also free
    // its id for any package after the next start.
    const bundled = targets.filter((t) => fromPlatform(t));
    if (bundled.length) throw new TemplateError(`${bundled[0].id}@${bundled[0].version} came with the platform and can't be uninstalled.`, 'bundled');
    for (const t of targets) {
      const slugs = pinnedBy(t.id, t.version);
      if (slugs.length) throw new TemplateError(`${t.id}@${t.version} is used by ${slugs.map((s) => `"${s}"`).join(', ')}; move ${slugs.length === 1 ? 'it' : 'them'} to another template first.`, 'in-use');
    }
    for (const t of targets) {
      const key = `${t.id}@${t.version}`;
      trash(root, path.dirname(t.dir)); // <id>/<build>, which holds package/ and the receipt
      // An installed copy that hid the platform's own copy of the same version: that one returns.
      if (shipped.has(key)) byKey.set(key, shipped.get(key));
      else byKey.delete(key);
      log.info('template uninstalled', { template: key, build: t.build, actor });
    }
    return targets.map((t) => ({ id: t.id, version: t.version, build: t.build }));
  }

  // A bundled version an overlay pins is copied into the data directory, so a platform update that
  // drops or changes it can't take the overlay off air.
  function retain(id, version) {
    const t = byKey.get(`${id}@${version}`);
    if (!t || t.source !== 'bundled' || !root || readOnly) return t;
    const staging = path.join(root, `.staging-${randomBytes(6).toString('hex')}`);
    try {
      const files = extract(packageFromDir(t.dir), path.join(staging, 'package'));
      // reserved: whether the id is the platform's own, so it stays reserved after a release that
      // no longer ships this version.
      const receipt = { id, version, build: buildFromFiles(files), installedAt: new Date().toISOString(), source: { kind: 'bundled', name: path.basename(t.dir), reserved: Boolean(t.reservedRoot) }, actor: 'platform', files };
      atomicWriteFileSync(path.join(staging, RECEIPT), `${JSON.stringify(receipt, null, 2)}\n`);
      const target = path.join(root, id, receipt.build);
      placeIn(root, id, staging, target);
      return register(loadInstalled(target, log, receipt));
    } finally {
      if (existsSync(staging)) rmSync(staging, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  }

  return {
    get(id, version) { return byKey.get(`${id}@${version}`); },
    list() { return [...byKey.values()]; },
    // Every version of an id, newest first.
    versions(id) { return [...byKey.values()].filter((t) => t.id === id).sort((a, b) => compareVersions(b.version, a.version)); },
    fromPlatform,
    // fn(template) after each install that added a version; returns an unsubscribe function.
    onInstalled(fn) {
      installedListeners.add(fn);
      return () => installedListeners.delete(fn);
    },
    install,
    uninstall,
    retain,
  };
}

// Validates a .skp file or a template directory without installing it.
export function validateTemplate(input) {
  if (Buffer.isBuffer(input)) return validateWith(packageFromZip(bufferSource(input)));
  if (statSync(input).isDirectory()) return validateWith(packageFromDir(input));
  const fd = openSync(input, 'r');
  try {
    return validateWith(packageFromZip(fileSource(fd, fstatSync(fd).size)));
  } finally {
    closeSync(fd);
  }
}

function validateWith(pkg) {
  const result = validatePackage(pkg);
  return { ...result, build: result.errors.length ? undefined : buildOf(pkg).build };
}

// A bundled template directory: validated and hashed at every start (bundled templates are small
// and change with the platform's own code).
function loadBundled(dir, log) {
  const pkg = packageFromDir(dir);
  const result = validatePackage(pkg);
  if (result.errors.length) {
    throw new TemplateError(`${path.basename(dir)}: ${result.errors.map((e) => e.message).join(' ')}`, 'invalid', result.errors);
  }
  for (const w of result.warnings) log.warn('template warning', { dir, code: w.code, path: w.path, message: w.message });
  return template(result.manifest, dir, buildOf(pkg).build, pkg.names, 'bundled');
}

// An installed version. Its receipt is trusted when every file is still there with the size it
// had, so startup doesn't rehash up to 100 MiB per version on a small machine. Anything else was
// changed after install: it is validated again (a version that no longer passes isn't loaded, and
// its overlays answer 503) and rehashed, so changed content gets a new build (clients reload).
function loadInstalled(dir, log, known) {
  const receipt = known || JSON.parse(readFileSync(path.join(dir, RECEIPT), 'utf8'));
  const pkgDir = path.join(dir, 'package');
  const manifest = JSON.parse(readFileSync(path.join(pkgDir, 'template.json'), 'utf8').replace(/^﻿/, ''));
  if (manifest.id !== receipt.id || manifest.version !== receipt.version) {
    throw new TemplateError(`its template.json says ${manifest.id}@${manifest.version} but it was installed as ${receipt.id}@${receipt.version}`, 'mismatch');
  }
  let build = receipt.build;
  let names = receipt.files.map((f) => f.path);
  let intact = true;
  for (const f of receipt.files) {
    let st;
    try {
      st = lstatSync(path.join(pkgDir, ...f.path.split('/')));
    } catch {
      // A file is gone (a power cut mid-install, a hand edit): a partial template would render
      // broken on air, so this version isn't served at all (its overlays answer 503).
      throw new TemplateError(`"${f.path}" is missing from the installed files; install the package again`, 'incomplete');
    }
    if (!st.isFile() || st.size !== f.size) intact = false;
  }
  if (!intact) {
    const pkg = packageFromDir(pkgDir);
    const result = validatePackage(pkg);
    if (result.errors.length) {
      throw new TemplateError(`its files changed since it was installed and no longer pass: ${result.errors.map((e) => e.message).join(' ')}`, 'invalid', result.errors);
    }
    if (result.manifest.id !== receipt.id || result.manifest.version !== receipt.version) {
      throw new TemplateError(`its template.json says ${result.manifest.id}@${result.manifest.version} but it was installed as ${receipt.id}@${receipt.version}`, 'mismatch');
    }
    build = buildOf(pkg).build;
    names = pkg.names;
    log.warn('an installed template\'s files changed since it was installed; serving them under a new build', { template: `${receipt.id}@${receipt.version}`, installed: receipt.build, now: build });
  }
  return template(manifest, pkgDir, build, names, 'installed', receipt);
}

function template(manifest, dir, build, names, source, receipt) {
  let entry;
  return {
    id: manifest.id,
    version: manifest.version,
    manifest,
    dir,
    build,
    files: new Set(names),
    source,
    receipt,
    // Read when first served, not at startup for every installed version.
    get entry() {
      if (entry === undefined) entry = readFileSync(path.join(dir, ...manifest.entry.split('/')), 'utf8').replace(/^﻿/, '');
      return entry;
    },
  };
}

// Writes each file of a package under `to`, exclusively, with fixed modes (the archive's
// permission bits are ignored) and synced to disk, then syncs every directory it made, deepest
// first: after a power cut the version is either complete or not there. Returns
// [{ path, size, sha256 }]. A filesystem's refusal (a name too long for it, a full disk) is a
// TemplateError that says so, never a stack trace.
function extract(pkg, to) {
  mkdirSync(to, { recursive: true });
  const base = path.resolve(to) + path.sep;
  const dirs = new Set([path.resolve(to)]);
  const files = [];
  for (const name of pkg.names) {
    const target = path.resolve(to, ...name.split('/'));
    if (!target.startsWith(base)) throw new TemplateError(`"${name}" would land outside the template's folder.`, 'unsafe-path');
    const data = pkg.read(name);
    try {
      for (let d = path.dirname(target); d.length > base.length - 1 && !dirs.has(d); d = path.dirname(d)) dirs.add(d);
      mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
      const fd = openSync(target, 'wx', 0o644);
      try {
        writeSync(fd, data);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    } catch (err) {
      throw new TemplateError(`"${name}" could not be written (${err.code || err.message}); nothing was installed.`, 'write-failed');
    }
    files.push({ path: name, size: data.length, sha256: createHash('sha256').update(data).digest('hex') });
  }
  for (const d of [...dirs].sort((a, b) => b.length - a.length)) syncDir(d);
  syncDir(path.dirname(path.resolve(to))); // the staging directory holds package/ and the receipt
  return files;
}

// Moves a finished staging directory to <root>/<id>/<build> in one rename, durably.
function placeIn(root, id, staging, target) {
  const idDir = path.join(root, id);
  if (!existsSync(idDir)) {
    mkdirSync(idDir, { recursive: true });
    syncDir(root);
  }
  if (existsSync(target)) trash(root, target); // an orphan a crash left; its receipt never registered
  renameRetrying(staging, target);
  syncDir(idDir);
}

// Makes a directory's entries durable. POSIX only: Windows can't open a directory to sync it.
function syncDir(dir) {
  if (process.platform === 'win32') return;
  let fd;
  try {
    fd = openSync(dir, 'r');
    fsyncSync(fd);
  } catch {
    // Some filesystems refuse to sync a directory; the files themselves are synced.
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function archiveHash(source) {
  const hash = createHash('sha256');
  const step = 1024 * 1024;
  for (let at = 0; at < source.size; at += step) hash.update(source.read(at, Math.min(step, source.size - at)));
  return hash.digest('hex');
}

// Renamed aside first (one atomic step: a half-deleted version is never served), then deleted.
function trash(root, dir) {
  const aside = path.join(root, `.trash-${randomBytes(6).toString('hex')}`);
  renameRetrying(dir, aside);
  rmSync(aside, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

// What a crash left: staging directories never renamed into place, trash never deleted.
function sweep(root, log) {
  for (const name of readdirSync(root)) {
    if (!name.startsWith('.staging-') && !name.startsWith('.trash-')) continue;
    try {
      rmSync(path.join(root, name), { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      log.info('removed what an interrupted install or uninstall left', { dir: name });
    } catch (err) {
      log.warn('could not remove what an interrupted install or uninstall left', { dir: name, err: err.message });
    }
  }
}

// SemVer precedence (semver.org §11): numbers compare numerically, a prerelease sorts before its
// release, prerelease identifiers compare numerically when both are numbers.
export function compareVersions(a, b) {
  const parse = (v) => {
    const [core, pre] = String(v).split('+')[0].split(/-(.*)/s);
    return { nums: core.split('.').map(Number), pre: pre === undefined ? [] : pre.split('.') };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) if (x.nums[i] !== y.nums[i]) return x.nums[i] < y.nums[i] ? -1 : 1;
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) return Number(p) < Number(q) ? -1 : 1;
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
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
