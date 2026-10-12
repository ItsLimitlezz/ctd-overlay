// Installing and uninstalling template packages (04 §4.1, §4.10; 03 §3.4 semantics), what a
// restart finds, and the data-directory lock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { openData, startPlatform, StartupError } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { lockDataDir, LockError } from '../src/lock.js';
import { createTemplateRegistry, TemplateError } from '../src/templates/registry.js';
import { defer, DIAG, DIAG_DIR, FIXTURE_TEMPLATES, memoryLogger, packTemplate, tempDir, TESTBED, TESTBED_DIR } from './helpers.js';

const V1 = { id: 'dev.skp.sample', version: '1.0.0' };
const sample = (version = '1.0.0', extra = {}) => packTemplate(DIAG_DIR, { manifest: { id: V1.id, version, name: `Sample ${version}` }, ...extra });

function registry(t, dataDir = path.join(tempDir(t), 'data')) {
  const { log, entries } = memoryLogger();
  return { templates: createTemplateRegistry({ dataDir, log }), dataDir, log, entries, reopen: () => createTemplateRegistry({ dataDir, log }) };
}

function configIn(t) {
  const root = tempDir(t);
  return loadConfig({ argv: ['--port', '0'], env: { SKP_DATA_DIR: path.join(root, 'data'), SKP_CONFIG_DIR: path.join(root, 'config') } });
}

// A platform that is stopped when the test ends, even when an assertion fails first (a server left
// running would keep the test process alive).
async function start(t, config, options) {
  const platform = await startPlatform(config, options);
  defer(t, () => platform.stop());
  return platform;
}

const staged = (dataDir) => readdirSync(path.join(dataDir, 'templates')).filter((name) => name.startsWith('.staging-'));
const refuses = (fn, code, pattern) => assert.throws(fn, (err) => {
  assert.ok(err instanceof TemplateError, String(err));
  assert.equal(err.code, code, err.message);
  if (pattern) assert.match(err.message, pattern);
  return true;
});

test('install puts the files under the data directory, serves its build, and keeps a receipt', (t) => {
  const { templates, dataDir } = registry(t);
  const { template, noop, warnings } = templates.install(sample(), { name: 'sample.skp' });
  assert.equal(noop, false);
  assert.deepEqual(warnings, []);
  assert.equal(template.source, 'installed');
  assert.equal(templates.get(V1.id, V1.version), template);
  assert.equal(template.dir, path.join(dataDir, 'templates', V1.id, template.build, 'package'));
  assert.ok(template.files.has('index.html'));
  const receipt = JSON.parse(readFileSync(path.join(dataDir, 'templates', V1.id, template.build, 'install.json'), 'utf8'));
  assert.equal(receipt.build, template.build);
  assert.equal(receipt.source.name, 'sample.skp');
  assert.match(receipt.packageSha256, /^[0-9a-f]{64}$/);
  assert.ok(receipt.files.some((f) => f.path === 'template.json' && /^[0-9a-f]{64}$/.test(f.sha256)));
  assert.ok(!template.files.has('install.json'), 'the receipt is not one of the template\'s files');
  assert.match(template.entry, /<html/i);
});

test('an installed version never changes: the same bytes are a no-op, other bytes are refused', (t) => {
  const { templates } = registry(t);
  const first = templates.install(sample()).template;
  assert.equal(templates.install(sample()).noop, true);
  refuses(() => templates.install(sample('1.0.0', { files: { 'extra.txt': 'changed' } })), 'version-exists', /new version/);
  assert.equal(templates.get(V1.id, V1.version).build, first.build);
  // Several versions of one id live side by side, newest first.
  templates.install(sample('1.1.0'));
  templates.install(sample('1.0.0-rc.1'));
  assert.deepEqual(templates.versions(V1.id).map((x) => x.version), ['1.1.0', '1.0.0', '1.0.0-rc.1']);
});

test('a package can\'t replace a bundled template, or add versions of one', (t) => {
  const { templates } = registry(t);
  assert.equal(templates.get(DIAG.id, DIAG.version).source, 'bundled');
  assert.equal(templates.install(packTemplate(DIAG_DIR)).noop, true, 'the same bytes as the bundled one');
  refuses(() => templates.install(packTemplate(DIAG_DIR, { files: { 'x.txt': 'x' } })), 'reserved-id', /ships with the platform/);
  refuses(() => templates.install(packTemplate(DIAG_DIR, { manifest: { version: '9.0.0' } })), 'reserved-id');
});

test('an invalid package installs nothing and says why', (t) => {
  const { templates, dataDir } = registry(t);
  assert.throws(() => templates.install(sample('1.0.0', { manifest: { id: V1.id, version: '1.0.0', previews: ['missing.png'] } })), (err) => {
    assert.equal(err.code, 'invalid');
    assert.deepEqual(err.findings.filter((f) => f.level === 'error').map((f) => f.code), ['file-missing']);
    return true;
  });
  assert.throws(() => templates.install(Buffer.from('not a zip')), /not a ZIP/);
  assert.equal(templates.get(V1.id, V1.version), undefined);
  assert.deepEqual(readdirSync(path.join(dataDir, 'templates')), [], 'no staging left behind');
});

test('a restart finds installed versions from their receipts, and notices files that changed', (t) => {
  const { templates, reopen, entries, dataDir } = registry(t);
  const { template } = templates.install(sample());
  const again = reopen().get(V1.id, V1.version);
  assert.equal(again.build, template.build);
  assert.equal(again.source, 'installed');
  // Someone edits a file in place: it is served under a new build (clients reload) and logged.
  writeFileSync(path.join(template.dir, 'template.css'), 'body { color: red }');
  const changed = reopen().get(V1.id, V1.version);
  assert.notEqual(changed.build, template.build);
  assert.ok(entries.some((e) => /files changed since it was installed/.test(e.msg)));
  // A version whose receipt is unreadable is skipped, not fatal.
  writeFileSync(path.join(dataDir, 'templates', V1.id, template.build, 'install.json'), '{ broken');
  assert.equal(reopen().get(V1.id, V1.version), undefined);
  assert.ok(entries.some((e) => /could not be loaded/.test(e.msg)));
});

test('what an interrupted install or uninstall leaves is cleared at the next start', (t) => {
  const { dataDir, entries, reopen } = registry(t);
  mkdirSync(path.join(dataDir, 'templates', '.staging-abc', 'package'), { recursive: true });
  mkdirSync(path.join(dataDir, 'templates', '.trash-def'), { recursive: true });
  reopen();
  assert.deepEqual(readdirSync(path.join(dataDir, 'templates')), []);
  assert.deepEqual(entries.filter((e) => /interrupted install/.test(e.msg)).map((e) => e.context.dir).sort(), ['.staging-abc', '.trash-def']);
});

test('a read-only registry leaves what an interrupted install left alone', (t) => {
  const { dataDir, log } = registry(t);
  const staging = path.join(dataDir, 'templates', '.staging-x');
  mkdirSync(path.join(staging, 'package'), { recursive: true });
  const readOnly = createTemplateRegistry({ dataDir, log, readOnly: true });
  assert.ok(existsSync(staging), 'another process holds the data directory, and may be installing right now');
  refuses(() => readOnly.install(sample()), 'read-only');
});

test('a refused or repeated install leaves no staging directory behind', (t) => {
  const { templates, dataDir } = registry(t);
  templates.install(sample());
  assert.equal(templates.install(sample()).noop, true);
  assert.deepEqual(staged(dataDir), []);
  // Both are refused after the package was extracted to staging.
  refuses(() => templates.install(sample('1.0.0', { files: { 'extra.txt': 'changed' } })), 'version-exists');
  assert.deepEqual(staged(dataDir), []);
  refuses(() => templates.install(packTemplate(DIAG_DIR, { files: { 'x.txt': 'x' } })), 'reserved-id');
  assert.deepEqual(staged(dataDir), []);
});

test('installing a package again replaces an installed copy of it that could not be loaded', (t) => {
  const { templates, reopen, dataDir } = registry(t);
  const { template } = templates.install(sample());
  const receipt = path.join(dataDir, 'templates', V1.id, template.build, 'install.json');
  writeFileSync(receipt, '{ broken');
  const after = reopen();
  assert.equal(after.get(V1.id, V1.version), undefined);
  // Its <id>/<build> directory is still there, where the same package lands again.
  const again = after.install(sample());
  assert.equal(again.noop, false);
  assert.equal(again.template.build, template.build);
  assert.equal(after.get(V1.id, V1.version), again.template);
  assert.equal(JSON.parse(readFileSync(receipt, 'utf8')).build, template.build);
  assert.equal(reopen().get(V1.id, V1.version)?.build, template.build);
});

test('an installed version whose template.json no longer matches its receipt is skipped at load', (t) => {
  const { templates, reopen, entries } = registry(t);
  const { template } = templates.install(sample());
  const file = path.join(template.dir, 'template.json');
  const original = readFileSync(file, 'utf8');
  const installed = (templates) => templates.list().filter((x) => x.source === 'installed').map((x) => `${x.id}@${x.version}`);
  const skipped = (says) => entries.some((e) => /could not be loaded/.test(e.msg) && e.context.err.includes(`says ${says} but it was installed as ${V1.id}@${V1.version}`));
  // Another version of the same size: every file keeps its size, so the receipt is trusted.
  writeFileSync(file, original.replace('"version": "1.0.0"', '"version": "1.0.1"'));
  assert.equal(statSync(file).size, Buffer.byteLength(original));
  assert.deepEqual(installed(reopen()), []);
  assert.ok(skipped(`${V1.id}@1.0.1`));
  // Another id, of another size: the receipt check catches it before anything is validated again.
  writeFileSync(file, original.replace(`"id": "${V1.id}"`, '"id": "dev.skp.renamed"'));
  assert.notEqual(statSync(file).size, Buffer.byteLength(original));
  assert.deepEqual(installed(reopen()), []);
  assert.ok(skipped('dev.skp.renamed@1.0.0'));
});

test('an installed version with a file missing is skipped at load, until the package is installed again', (t) => {
  const { templates, reopen, entries } = registry(t);
  const { template } = templates.install(sample());
  // The manifest doesn't name template.css: validated again, what is left would still pass, and
  // a partial template would be served.
  rmSync(path.join(template.dir, 'template.css'));
  const after = reopen();
  assert.equal(after.get(V1.id, V1.version), undefined);
  assert.ok(entries.some((e) => /could not be loaded/.test(e.msg) && /"template\.css" is missing from the installed files/.test(e.context.err)));
  // As the message says, installing the package again puts it back.
  assert.equal(after.install(sample()).template.build, template.build);
  assert.ok(existsSync(path.join(template.dir, 'template.css')));
  assert.equal(reopen().get(V1.id, V1.version)?.build, template.build);
});

test('an installed copy of a version wins over a bundled copy with other content', (t) => {
  const { templates, dataDir } = registry(t);
  const retained = templates.retain(DIAG.id, DIAG.version);
  assert.equal(retained.source, 'installed');
  // A platform update ships diagnostic 1.0.0 again, with other content.
  const shipped = path.join(tempDir(t), 'templates');
  cpSync(DIAG_DIR, path.join(shipped, 'diagnostic'), { recursive: true });
  writeFileSync(path.join(shipped, 'diagnostic', 'template.css'), 'body { color: red }');
  // A logger of its own, so the warning found below is the one this registry logged.
  const { log, entries } = memoryLogger();
  const after = createTemplateRegistry({ dirs: [shipped], reserve: [shipped], dataDir, log });
  const kept = after.get(DIAG.id, DIAG.version);
  assert.equal(kept.build, retained.build);
  assert.equal(kept.source, 'installed');
  const warning = entries.find((e) => /two copies/.test(e.msg));
  assert.ok(warning, 'the difference is logged');
  assert.equal(warning.context.using.build, retained.build);
  assert.equal(warning.context.ignoring.source, 'bundled');
  assert.ok(warning.context.ignoring.dir.startsWith(shipped), warning.context.ignoring.dir);
  assert.notEqual(warning.context.ignoring.build, retained.build);
});

test('onInstalled tells listeners about each version an install adds, until they unsubscribe', (t) => {
  const { templates, entries } = registry(t);
  const seen = [];
  const off = templates.onInstalled((x) => seen.push(x));
  const { template } = templates.install(sample());
  assert.equal(templates.install(sample()).noop, true);
  assert.deepEqual(seen, [template], 'once, for the install that added a version');
  off();
  templates.install(sample('1.1.0'));
  assert.equal(seen.length, 1);
  // A listener that throws is logged; the install still succeeds.
  templates.onInstalled(() => { throw new Error('boom'); });
  assert.equal(templates.install(sample('1.2.0')).noop, false);
  assert.ok(entries.some((e) => /listener for installed templates failed/.test(e.msg) && e.context.err === 'boom'));
  assert.equal(templates.get(V1.id, '1.2.0').version, '1.2.0');
});

test('uninstall: refused while an overlay uses the version, refused for bundled templates, then gone', (t) => {
  const { templates, dataDir, reopen } = registry(t);
  const { template } = templates.install(sample());
  refuses(() => templates.uninstall(V1.id, V1.version, { pinnedBy: () => ['main', 'vertical'] }), 'in-use', /"main", "vertical"/);
  assert.ok(existsSync(template.dir));
  refuses(() => templates.uninstall(DIAG.id, DIAG.version), 'bundled');
  refuses(() => templates.uninstall(V1.id, '9.9.9'), 'not-found');
  assert.deepEqual(templates.uninstall(V1.id, V1.version).map((r) => r.version), ['1.0.0']);
  assert.equal(templates.get(V1.id, V1.version), undefined);
  assert.ok(!existsSync(template.dir));
  assert.equal(reopen().get(V1.id, V1.version), undefined);
  // Every version of an id at once.
  templates.install(sample('2.0.0'));
  templates.install(sample('2.1.0'));
  assert.deepEqual(templates.uninstall(V1.id).map((r) => r.version).sort(), ['2.0.0', '2.1.0']);
  assert.deepEqual(readdirSync(path.join(dataDir, 'templates', V1.id)), []);
});

test('a bundled version an overlay uses is kept in the data directory, so a platform update can\'t remove it', async (t) => {
  const config = configIn(t);
  const { log } = memoryLogger();
  const platform = await start(t, config, { log, templateDirs: [FIXTURE_TEMPLATES] });
  const overlay = platform.overlays.create({ slug: 'main', template: DIAG });
  const build = platform.templates.get(DIAG.id, DIAG.version).build;
  assert.equal(platform.templates.get(DIAG.id, DIAG.version).source, 'installed');
  await platform.stop();
  // The next release no longer ships diagnostic 1.0.0: the overlay still renders it.
  const after = createTemplateRegistry({ dirs: [], dataDir: config.dataDir, log });
  assert.equal(after.get(DIAG.id, DIAG.version).build, build);
  assert.ok(overlay.id);
});

test('a retained copy of a bundled version stays the platform\'s: it is never uninstalled, and its id stays reserved', async (t) => {
  const config = configIn(t);
  const { log } = memoryLogger();
  const platform = await start(t, config, { log });
  const overlay = platform.overlays.create({ slug: 'main', template: DIAG });
  const retained = platform.templates.get(DIAG.id, DIAG.version);
  assert.equal(retained.source, 'installed');
  assert.equal(platform.templates.fromPlatform(retained), true);
  // Not even once no overlay uses it.
  platform.overlays.remove(overlay.id);
  refuses(() => platform.templates.uninstall(DIAG.id, DIAG.version, { pinnedBy: (id, v) => platform.overlays.pinnedBy(id, v) }), 'bundled');
  assert.equal(platform.templates.get(DIAG.id, DIAG.version), retained);
  await platform.stop();
  // A later release no longer ships the diagnostic template at all: the id is still the platform's.
  const after = createTemplateRegistry({ dirs: [], dataDir: config.dataDir, log });
  assert.equal(after.fromPlatform(after.get(DIAG.id, DIAG.version)), true);
  refuses(() => after.install(packTemplate(DIAG_DIR, { manifest: { version: '9.0.0' } })), 'reserved-id');
  assert.equal(after.get(DIAG.id, '9.0.0'), undefined);
  // Still not uninstallable there, so the id can't be freed for packages by a restart.
  refuses(() => after.uninstall(DIAG.id, DIAG.version), 'bundled');
  const later = createTemplateRegistry({ dirs: [], dataDir: config.dataDir, log });
  refuses(() => later.install(packTemplate(DIAG_DIR, { manifest: { version: '9.0.0' } })), 'reserved-id');
});

test('retaining a template from a root that isn\'t reserved doesn\'t reserve its id after a restart', (t) => {
  const { dataDir, log } = registry(t);
  const dirs = [FIXTURE_TEMPLATES]; // the test hook's templates: bundled, but not the platform's own ids
  const pkg = packTemplate(TESTBED_DIR, { manifest: { version: '7.0.0' } });
  const first = createTemplateRegistry({ dirs, reserve: [], dataDir, log });
  first.retain(TESTBED.id, TESTBED.version);
  const receipt = first.get(TESTBED.id, TESTBED.version).receipt;
  assert.equal(receipt.source.kind, 'bundled');
  assert.equal(receipt.source.reserved, false);
  const again = createTemplateRegistry({ dirs, reserve: [], dataDir, log });
  assert.equal(again.install(pkg).noop, false, 'the same answer as before the restart');
});

test('a package installed under a version the platform ships is still the package: not trusted, and uninstalling it brings the shipped copy back', (t) => {
  const { dataDir, log } = registry(t);
  const id = 'dev.skp.later';
  // Installed first, when the platform didn't ship this id yet.
  const pkg = packTemplate(DIAG_DIR, { manifest: { id, version: '1.1.0' }, files: { 'migrate.js': 'function migrate(f, s) { return s; }' } });
  createTemplateRegistry({ dirs: [], dataDir, log }).install(pkg);
  // A release then ships the same id@version with other content (from a root that isn't reserved,
  // or the package couldn't have been installed above at all).
  const shipped = path.join(tempDir(t), 'templates');
  cpSync(DIAG_DIR, path.join(shipped, 'later'), { recursive: true });
  const manifest = JSON.parse(readFileSync(path.join(shipped, 'later', 'template.json'), 'utf8'));
  writeFileSync(path.join(shipped, 'later', 'template.json'), JSON.stringify({ ...manifest, id, version: '1.1.0' }));
  const templates = createTemplateRegistry({ dirs: [shipped], reserve: [], dataDir, log });
  const served = templates.get(id, '1.1.0');
  assert.equal(served.source, 'installed', 'the installed copy is what overlays have been showing');
  assert.equal(served.files.has('migrate.js'), true);
  assert.equal(templates.fromPlatform(served), false, 'its code is the package\'s, whatever its name');
  assert.deepEqual(templates.uninstall(id, '1.1.0').map((r) => r.version), ['1.1.0']);
  const back = templates.get(id, '1.1.0');
  assert.equal(back.source, 'bundled');
  assert.equal(templates.fromPlatform(back), true);
});

test('an installed version whose files changed and no longer pass is skipped; only its overlays go off air', async (t) => {
  const config = configIn(t);
  const { log, entries } = memoryLogger();
  const first = await start(t, config, { log });
  const { template } = first.templates.install(sample());
  first.overlays.create({ slug: 'changed', template: V1 });
  first.overlays.create({ slug: 'fine', template: DIAG });
  await first.stop();
  // Valid JSON, of another size, with a consumes pattern the rules refuse.
  const file = path.join(template.dir, 'template.json');
  const originalSize = statSync(file).size;
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), consumes: { state: ['viewers.**'] } }));
  assert.notEqual(statSync(file).size, originalSize, 'a changed size, so the files are validated again');

  const templates = createTemplateRegistry({ dataDir: config.dataDir, log });
  assert.equal(templates.get(V1.id, V1.version), undefined);
  assert.ok(entries.some((e) => /could not be loaded/.test(e.msg) && /no longer pass/.test(e.context.err)));
  openData(config, { log }).close();
  const platform = await start(t, config, { log });
  assert.equal(platform.templates.get(V1.id, V1.version), undefined);
  const keyed = (slug, p = '') => `${platform.url}/o/${slug}${p}?key=${platform.overlays.key(slug)}`;
  assert.equal((await fetch(keyed('changed'))).status, 503);
  assert.equal((await fetch(keyed('fine'))).status, 200);
});

test('an installed template that loads but can\'t be used takes only its own overlays off air', async (t) => {
  const config = configIn(t);
  const { log, entries } = memoryLogger();
  const first = await start(t, config, { log });
  const { template } = first.templates.install(sample());
  const edited = first.overlays.create({ slug: 'edited', template: V1 });
  first.overlays.create({ slug: 'fine', template: DIAG });
  await first.stop();
  // Edited in place to the same size: the receipt is trusted and the files aren't validated
  // again, so the bad pattern only shows when the overlay's channel is set up.
  const file = path.join(template.dir, 'template.json');
  const text = readFileSync(file, 'utf8');
  writeFileSync(file, text.replaceAll('"custom.*"', '"custom**"'));
  assert.equal(statSync(file).size, Buffer.byteLength(text));

  const platform = await start(t, config, { log });
  assert.equal(platform.templates.get(V1.id, V1.version)?.build, template.build, 'loaded from its receipt');
  const keyed = (slug, p = '') => `${platform.url}/o/${slug}${p}?key=${platform.overlays.key(slug)}`;
  assert.equal((await fetch(keyed('edited'))).status, 503);
  assert.equal((await fetch(keyed('edited', '/snapshot'))).status, 503);
  assert.equal((await fetch(keyed('fine'))).status, 200);
  assert.ok(entries.some((e) => /can't be used as installed/.test(e.msg) && e.context.overlay === edited.id));
});

test('one process per data directory: a second platform is refused, a dead holder\'s lock is taken over', async (t) => {
  const config = configIn(t);
  const { log, entries } = memoryLogger();
  const platform = await start(t, config, { log });
  // Should a second one start after all, start() stops it when the test ends.
  await assert.rejects(start(t, config, { log }), (err) => err instanceof StartupError && /already uses the data directory/.test(err.message));
  assert.throws(() => {
    const data = openData(config, { log, purpose: 'template install' });
    defer(t, () => data.close());
  }, StartupError);
  await platform.stop();
  // Released on stop: it starts again.
  const again = await start(t, config, { log });
  await again.stop();
  // A lock left by a process that no longer exists.
  writeFileSync(path.join(config.dataDir, 'skp.lock'), JSON.stringify({ pid: 2 ** 22 + 7, purpose: 'platform' }));
  const lock = lockDataDir(config.dataDir, { log });
  defer(t, () => lock.release());
  assert.ok(entries.some((e) => /took over a lock/.test(e.msg)));
  assert.throws(() => {
    const second = lockDataDir(config.dataDir, { log });
    defer(t, () => second.release());
  }, LockError);
  lock.release();
  assert.ok(!existsSync(path.join(config.dataDir, 'skp.lock')));
});
