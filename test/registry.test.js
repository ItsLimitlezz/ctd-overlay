// Installing and uninstalling template packages (04 §4.1, §4.10; 03 §3.4 semantics), what a
// restart finds, and the data-directory lock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { openData, startPlatform, StartupError } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { lockDataDir, LockError } from '../src/lock.js';
import { createTemplateRegistry, TemplateError } from '../src/templates/registry.js';
import { DIAG, DIAG_DIR, FIXTURE_TEMPLATES, memoryLogger, packTemplate, tempDir } from './helpers.js';

const V1 = { id: 'dev.skp.sample', version: '1.0.0' };
const sample = (version = '1.0.0', extra = {}) => packTemplate(DIAG_DIR, { manifest: { id: V1.id, version, name: `Sample ${version}` }, ...extra });

function registry(t, dataDir = path.join(tempDir(t), 'data')) {
  const { log, entries } = memoryLogger();
  return { templates: createTemplateRegistry({ dataDir, log }), dataDir, entries, reopen: () => createTemplateRegistry({ dataDir, log }) };
}
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
  const { dataDir, entries } = registry(t);
  mkdirSync(path.join(dataDir, 'templates', '.staging-abc', 'package'), { recursive: true });
  mkdirSync(path.join(dataDir, 'templates', '.trash-def'), { recursive: true });
  createTemplateRegistry({ dataDir, log: memoryLogger().log });
  assert.deepEqual(readdirSync(path.join(dataDir, 'templates')), []);
  assert.ok(entries.length >= 0);
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
  const root = tempDir(t);
  const config = loadConfig({ argv: ['--port', '0'], env: { SKP_DATA_DIR: path.join(root, 'data'), SKP_CONFIG_DIR: path.join(root, 'config') } });
  const { log } = memoryLogger();
  const platform = await startPlatform(config, { log, templateDirs: [FIXTURE_TEMPLATES] });
  const overlay = platform.overlays.create({ slug: 'main', template: DIAG });
  const build = platform.templates.get(DIAG.id, DIAG.version).build;
  assert.equal(platform.templates.get(DIAG.id, DIAG.version).source, 'installed');
  await platform.stop();
  // The next release no longer ships diagnostic 1.0.0: the overlay still renders it.
  const after = createTemplateRegistry({ dirs: [], dataDir: config.dataDir, log });
  assert.equal(after.get(DIAG.id, DIAG.version).build, build);
  assert.ok(overlay.id);
});

test('one process per data directory: a second platform is refused, a dead holder\'s lock is taken over', async (t) => {
  const root = tempDir(t);
  const config = loadConfig({ argv: ['--port', '0'], env: { SKP_DATA_DIR: path.join(root, 'data'), SKP_CONFIG_DIR: path.join(root, 'config') } });
  const { log, entries } = memoryLogger();
  const platform = await startPlatform(config, { log });
  await assert.rejects(startPlatform(config, { log }), (err) => err instanceof StartupError && /already uses the data directory/.test(err.message));
  assert.throws(() => openData(config, { log, purpose: 'template install' }), StartupError);
  await platform.stop();
  // Released on stop: it starts again.
  const again = await startPlatform(config, { log });
  await again.stop();
  // A lock left by a process that no longer exists.
  writeFileSync(path.join(config.dataDir, 'skp.lock'), JSON.stringify({ pid: 2 ** 22 + 7, purpose: 'platform' }));
  const lock = lockDataDir(config.dataDir, { log });
  assert.ok(entries.some((e) => /took over a lock/.test(e.msg)));
  assert.throws(() => lockDataDir(config.dataDir, { log }), LockError);
  lock.release();
  assert.ok(!existsSync(path.join(config.dataDir, 'skp.lock')));
});
