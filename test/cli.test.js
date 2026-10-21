// The command line (src/cli.js): template validate, pack, list, install, uninstall, overlay
// upgrade and revert, the audit log, its exit codes, the lock that keeps it off a running
// platform's data, and how src/main.js tells a command from the server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chownSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openData, startPlatform } from '../src/app.js';
import { run } from '../src/cli.js';
import { loadConfig } from '../src/config.js';
import { openStore } from '../src/store/index.js';
import { validateTemplate } from '../src/templates/registry.js';
import { DIAG, DIAG_DIR, FIXTURE_TEMPLATES, TESTBED, auditOf, defer, memoryLogger, packTemplate, tempDir } from './helpers.js';

const MAIN = fileURLToPath(new URL('../src/main.js', import.meta.url));

async function cli(args, env = {}) {
  let stdout = '';
  let stderr = '';
  const code = await run(args, {
    stdout: { write: (s) => { stdout += s; } },
    stderr: { write: (s) => { stderr += s; } },
    env: { ...process.env, SKP_STORE: '', SKP_DATA_DIR: '', SKP_CONFIG_DIR: '', SKP_LOG_LEVEL: '', ...env },
  });
  return { code, stdout, stderr };
}

function dirs(t) {
  const root = tempDir(t);
  const env = { SKP_DATA_DIR: path.join(root, 'data'), SKP_CONFIG_DIR: path.join(root, 'config') };
  return { root, env, config: loadConfig({ argv: [], env }) };
}

const ID = 'dev.skp.sample';
// The templates that ship with the platform, as `template list` sorts them.
const BUNDLED = ['com.ctd.text-clock', 'com.dprtmnt.alerts', 'com.dprtmnt.chat', 'com.dprtmnt.takeover', 'dev.skp.diagnostic', 'dev.skp.viewers'];
const V1 = {
  type: 'object',
  properties: {
    accent: { type: 'string', format: 'color', default: '#EFC33F' },
    size: { type: 'integer', minimum: 1, maximum: 10, default: 2 },
    old: { type: 'string' },
  },
};
// 1.0.0 without `old`: a minor version that drops a value an operator may have set.
const V1_1 = { type: 'object', properties: { accent: V1.properties.accent, size: V1.properties.size } };

// Installs each { version, settings, files } of dev.skp.sample with the CLI, then (given
// settings) creates the overlay "main" on the first one.
async function withSample(t, versions, settings) {
  const d = dirs(t);
  for (const { version, settings: schema, files } of versions) {
    const file = path.join(d.root, `${version}.skp`);
    writeFileSync(file, packTemplate(DIAG_DIR, { manifest: { id: ID, version, ...(schema && { settings: schema }) }, files }));
    const res = await cli(['template', 'install', file], d.env);
    assert.equal(res.code, 0, res.stderr);
  }
  if (settings) {
    const data = openData(d.config, { log: memoryLogger().log });
    try {
      data.overlays.create({ slug: 'main', template: { id: ID, version: versions[0].version }, settings });
    } finally {
      data.close();
    }
  }
  return d;
}

// The overlay "main" as stored.
function stored(config) {
  const data = openData(config, { log: memoryLogger().log });
  try {
    return data.overlays.resolve('main').doc.data;
  } finally {
    data.close();
  }
}

test('template validate: a directory or a package, readable or --json; errors exit 1', async (t) => {
  const ok = await cli(['template', 'validate', DIAG_DIR]);
  assert.equal(ok.code, 0, ok.stderr);
  assert.match(ok.stdout, /dev\.skp\.diagnostic@1\.0\.0 {2}build [0-9a-f]{16}/);
  assert.match(ok.stdout, /valid\./);
  const file = path.join(tempDir(t), 'bad.skp');
  writeFileSync(file, packTemplate(DIAG_DIR, { manifest: { previews: ['nope.png'] } }));
  const bad = await cli(['template', 'validate', file, '--json']);
  assert.equal(bad.code, 1);
  const result = JSON.parse(bad.stdout);
  assert.equal(result.valid, false);
  assert.deepEqual(result.errors.map((e) => e.code), ['file-missing']);
  assert.equal(result.headless, 'skipped');
});

test('template pack writes a package with the directory\'s build; the same files make the same bytes', async (t) => {
  const root = tempDir(t);
  const a = path.join(root, 'a.skp');
  const b = path.join(root, 'b.skp');
  assert.equal((await cli(['template', 'pack', DIAG_DIR, '-o', a])).code, 0);
  assert.equal((await cli(['template', 'pack', DIAG_DIR, '--out', b, '--json'])).code, 0);
  assert.ok(readFileSync(a).equals(readFileSync(b)));
  assert.equal(validateTemplate(a).build, validateTemplate(DIAG_DIR).build);
});

test('install, list and uninstall, in the data directory the server would use', async (t) => {
  const { root, env } = dirs(t);
  const file = path.join(root, 'sample.skp');
  writeFileSync(file, packTemplate(DIAG_DIR, { manifest: { id: 'dev.skp.sample', version: '1.0.0' } }));
  const installed = await cli(['template', 'install', file], env);
  assert.equal(installed.code, 0, installed.stderr);
  assert.match(installed.stdout, /installed dev\.skp\.sample@1\.0\.0/);
  assert.match(installed.stdout, /Templates are code/);
  assert.match((await cli(['template', 'install', file], env)).stdout, /already installed/);
  const list = JSON.parse((await cli(['template', 'list', '--json'], env)).stdout);
  assert.deepEqual(list.map((r) => `${r.id}@${r.version} ${r.source} ${r.overlays}`), [...BUNDLED.map((id) => `${id}@1.0.0 bundled 0`), 'dev.skp.sample@1.0.0 installed 0'].sort());
  const removed = await cli(['template', 'uninstall', 'dev.skp.sample@1.0.0'], env);
  assert.equal(removed.code, 0, removed.stderr);
  assert.equal((await cli(['template', 'uninstall', 'dev.skp.sample@1.0.0'], env)).code, 1);
  assert.match((await cli(['template', 'uninstall', 'dev.skp.diagnostic'], env)).stderr, /came with the platform/);
});

test('an invalid package is refused with its findings, and nothing is installed', async (t) => {
  const { root, env } = dirs(t);
  const file = path.join(root, 'bad.skp');
  writeFileSync(file, packTemplate(DIAG_DIR, { manifest: { id: 'dev.skp.sample', version: '1.0.0', standard: 'skp/2' } }));
  const res = await cli(['template', 'install', file], env);
  assert.equal(res.code, 1);
  assert.match(res.stdout, /implements skp\/1/);
  assert.match(res.stderr, /nothing was installed/);
  assert.equal((await cli(['template', 'install', path.join(root, 'missing.skp')], env)).code, 1);
});

test('overlay upgrade: a dry run, a major upgrade that needs --yes, then the upgrade', async (t) => {
  const { root, env, config } = dirs(t);
  const settings = (max) => ({ type: 'object', properties: { size: { type: 'integer', maximum: max, default: 1 } } });
  for (const [version, max] of [['1.0.0', 10], ['2.0.0', 5]]) {
    const file = path.join(root, `${version}.skp`);
    writeFileSync(file, packTemplate(DIAG_DIR, { manifest: { id: 'dev.skp.sample', version, settings: settings(max) } }));
    assert.equal((await cli(['template', 'install', file], env)).code, 0);
  }
  const data = openData(config, { log: memoryLogger().log });
  data.overlays.create({ slug: 'main', template: { id: 'dev.skp.sample', version: '1.0.0' }, settings: { size: 8 } });
  data.close();

  const dry = await cli(['overlay', 'upgrade', 'main', '--to', '2.0.0', '--dry-run'], env);
  assert.equal(dry.code, 0, dry.stderr);
  assert.match(dry.stdout, /main: 1\.0\.0 → 2\.0\.0 \(major\)/);
  assert.match(dry.stdout, /setting \/size = 8 doesn't fit the new version/);
  assert.match(dry.stdout, /Nothing changed/);
  const unconfirmed = await cli(['overlay', 'upgrade', 'main', '--to', '2.0.0'], env);
  assert.equal(unconfirmed.code, 1);
  assert.match(unconfirmed.stdout, /--yes/);
  const done = await cli(['overlay', 'upgrade', 'main', '--to', '2.0.0', '--yes', '--json'], env);
  assert.equal(done.code, 0, done.stderr);
  assert.equal(JSON.parse(done.stdout).applied, true);
  assert.equal((await cli(['overlay', 'upgrade', 'main'], env)).code, 64);
});

test('commands that change the data directory refuse while the platform runs it (exit 75); validate and list still work', async (t) => {
  const { root, env, config } = dirs(t);
  // Another live process holds the data directory (here: the test runner that started us).
  mkdirSync(config.dataDir, { recursive: true });
  writeFileSync(path.join(config.dataDir, 'skp.lock'), JSON.stringify({ pid: process.ppid, purpose: 'platform' }));
  const file = path.join(root, 'x.skp');
  writeFileSync(file, packTemplate(DIAG_DIR, { manifest: { id: 'dev.skp.sample', version: '1.0.0' } }));
  const res = await cli(['template', 'install', file], env);
  assert.equal(res.code, 75);
  assert.match(res.stderr, /The platform is running/);
  assert.ok(!existsSync(path.join(config.dataDir, 'templates', 'dev.skp.sample')));
  assert.equal((await cli(['template', 'validate', file], env)).code, 0);
  const list = await cli(['template', 'list'], env);
  assert.equal(list.code, 0, list.stderr);
  assert.match(list.stdout, /overlay counts are not shown/);
});

test('a platform in this same process holds its data directory too', async (t) => {
  const { root, env, config } = dirs(t);
  const platform = await startPlatform({ ...config, port: 0 }, { log: memoryLogger().log });
  defer(t, () => platform.stop()); // before the temp directory goes (defer is last in, first out)
  const file = path.join(root, 'x.skp');
  writeFileSync(file, packTemplate(DIAG_DIR, { manifest: { id: 'dev.skp.sample', version: '1.0.0' } }));
  assert.equal((await cli(['template', 'install', file], env)).code, 75);
  assert.equal((await cli(['template', 'list'], env)).code, 0);
});

test('usage and configuration errors have their own exit codes', async () => {
  assert.equal((await cli(['template', 'frobnicate'])).code, 64);
  assert.equal((await cli(['template', 'validate'])).code, 64);
  assert.equal((await cli(['--nope'])).code, 64);
  assert.equal((await cli(['help'])).code, 0);
  assert.equal((await cli(['template', 'list', '--store', 'mongo'])).code, 78);
});

test('node src/main.js <command> runs the command, not the server', async () => {
  const child = spawn(process.execPath, [MAIN, 'template', 'validate', DIAG_DIR, '--json'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  const code = await new Promise((resolve) => child.on('exit', resolve));
  assert.equal(code, 0);
  assert.equal(JSON.parse(out).valid, true);
});

test('template list counts the overlays on each version, and uninstall refuses a version an overlay uses', async (t) => {
  const { env, config } = await withSample(t, [{ version: '1.0.0' }], {});
  const list = await cli(['template', 'list', '--json'], env);
  assert.equal(list.code, 0, list.stderr);
  assert.deepEqual(JSON.parse(list.stdout).map((r) => `${r.id}@${r.version} ${r.overlays}`), [...BUNDLED.map((id) => `${id}@1.0.0 0`), 'dev.skp.sample@1.0.0 1'].sort());
  assert.match((await cli(['template', 'list'], env)).stdout, /^dev\.skp\.sample@1\.0\.0 .* 1 overlay$/m);
  for (const ref of ['dev.skp.sample@1.0.0', 'dev.skp.sample']) {
    const refused = await cli(['template', 'uninstall', ref], env);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /dev\.skp\.sample@1\.0\.0 is used by "main"/);
  }
  assert.equal(readdirSync(path.join(config.dataDir, 'templates', ID)).length, 1, 'the installed version is still there');
});

test('a bundled template an overlay retained is still the platform\'s: listed as bundled, never uninstalled', async (t) => {
  const { env, config } = dirs(t);
  // The platform that made these overlays also had the testbed bundled. The command line loads
  // only its own bundled templates, so for the testbed only the copy's receipt says it's bundled.
  const data = openData(config, { log: memoryLogger().log, templateDirs: [FIXTURE_TEMPLATES] });
  let overlay;
  try {
    overlay = data.overlays.create({ slug: 'diag', template: DIAG });
    data.overlays.create({ slug: 'tb', template: TESTBED });
  } finally {
    data.close();
  }
  const copy = path.join(config.dataDir, 'templates', DIAG.id);
  assert.equal(readdirSync(copy).length, 1, 'the overlay kept a copy in the data directory');
  const rows = JSON.parse((await cli(['template', 'list', '--json'], env)).stdout);
  assert.deepEqual(rows.map((r) => `${r.id}@${r.version} ${r.source} ${r.overlays}`), [...BUNDLED.filter((id) => id !== DIAG.id).map((id) => `${id}@1.0.0 bundled 0`), 'dev.skp.diagnostic@1.0.0 bundled 1', 'dev.skp.testbed@1.0.0 bundled 1'].sort());
  assert.match((await cli(['template', 'list'], env)).stdout, /^dev\.skp\.diagnostic@1\.0\.0 +[0-9a-f]{16} {2}bundled /m);
  // With no overlay on it any more, the copy is still a version the platform ships.
  const again = openData(config, { log: memoryLogger().log });
  try {
    again.overlays.remove(overlay.id);
  } finally {
    again.close();
  }
  const res = await cli(['template', 'uninstall', 'dev.skp.diagnostic@1.0.0'], env);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /came with the platform/);
  assert.equal(readdirSync(copy).length, 1);
});

test('overlay upgrade runs an installed package\'s migrate.js only with --run-migrate, and lists what it changed', async (t) => {
  const renamed = { type: 'object', properties: { colour: { type: 'string', format: 'color' }, size: { type: 'integer', default: 2 } } };
  const migrate = 'export function migrate(from, s) { s.colour = s.accent; delete s.accent; s.size += 1; return s; }';
  const { env, config } = await withSample(t, [{ version: '1.0.0', settings: V1 }, { version: '1.1.0', settings: renamed, files: { 'migrate.js': migrate } }], { accent: '#123456', size: 3 });

  const skipped = await cli(['overlay', 'upgrade', 'main', '--to', '1.1.0', '--dry-run'], env);
  assert.equal(skipped.code, 0, skipped.stderr);
  assert.match(skipped.stdout, /the package has a migrate\.js, which was not run .*--run-migrate/);
  assert.match(skipped.stdout, /setting \/accent is no longer used and is dropped/);
  assert.match(skipped.stdout, /Nothing changed \(--dry-run\)\. Applying it needs --yes\./);

  const dry = await cli(['overlay', 'upgrade', 'main', '--to', '1.1.0', '--dry-run', '--run-migrate'], env);
  assert.equal(dry.code, 0, dry.stderr);
  assert.match(dry.stdout, /^main: 1\.0\.0 → 1\.1\.0, settings run through the template's migrate\.js$/m);
  assert.match(dry.stdout, /^ {2}migrate\.js removed setting \/accent \(was "#123456"\)$/m);
  assert.match(dry.stdout, /^ {2}migrate\.js set \/colour = "#123456"$/m);
  assert.match(dry.stdout, /^ {2}migrate\.js changed setting \/size from 3 to 4$/m);
  assert.match(dry.stdout, /^ {2}new setting \/colour = "#123456"$/m);
  // Nothing is dropped this time, so applying it needs no --yes.
  assert.match(dry.stdout, /^Nothing changed \(--dry-run\)\.$/m);
  assert.deepEqual(stored(config).template, { id: ID, version: '1.0.0' });

  const done = await cli(['overlay', 'upgrade', 'main', '--to', '1.1.0', '--run-migrate', '--json'], env);
  assert.equal(done.code, 0, done.stderr);
  const plan = JSON.parse(done.stdout);
  assert.equal(plan.migrated, true);
  assert.equal(plan.applied, true);
  assert.deepEqual(plan.settings, { colour: '#123456', size: 4 });
  assert.deepEqual(plan.changes.filter((c) => c.change === 'migrated').map((c) => c.path).sort(), ['/accent', '/colour', '/size']);
  assert.deepEqual(stored(config).settings, { colour: '#123456', size: 4 });
});

test('the upgrade plan says a bound setting shows its state key\'s value before its default', async (t) => {
  const bind = 'custom.headliner'; // a key the template consumes, or it can't bind to it
  const field = (extra) => ({ type: 'string', 'x-skp-bind': bind, ...extra });
  const v1 = { type: 'object', properties: { title: field({ default: 'Live' }), sub: field({ default: 'a' }) } };
  const v1_1 = { type: 'object', properties: { title: field({ maxLength: 3, default: 'Liv' }), sub: field({ default: 'b' }), tag: field({ default: 'x' }) } };
  const { env } = await withSample(t, [{ version: '1.0.0', settings: v1 }, { version: '1.1.0', settings: v1_1 }], { title: 'Headline' });
  const dry = await cli(['overlay', 'upgrade', 'main', '--to', '1.1.0', '--dry-run'], env);
  assert.equal(dry.code, 0, dry.stderr);
  assert.match(dry.stdout, /^ {2}setting \/title = "Headline" doesn't fit the new version; it goes back to the value of custom\.headliner, else its default \("Liv"\)$/m);
  assert.match(dry.stdout, /^ {2}setting \/sub keeps its default, which changes from "a" to "b" \(when custom\.headliner has no value\)$/m);
  assert.match(dry.stdout, /^ {2}new setting \/tag, which shows the value of custom\.headliner, else its default \("x"\)$/m);
});

test('overlay revert puts an upgraded overlay back on its version and settings; one never upgraded has nothing to go back to', async (t) => {
  const { env, config } = await withSample(t, [{ version: '1.0.0', settings: V1 }, { version: '1.1.0', settings: V1_1 }], { size: 3, old: 'x' });
  const never = await cli(['overlay', 'revert', 'main'], env);
  assert.equal(never.code, 1);
  assert.match(never.stderr, /^skp: "main" has not been upgraded, so there is nothing to go back to\.$/m);

  const up = await cli(['overlay', 'upgrade', 'main', '--to', '1.1.0', '--yes'], env);
  assert.equal(up.code, 0, up.stderr);
  assert.match(up.stdout, /main now uses 1\.1\.0; its URL is unchanged\. \(skp overlay revert main goes back\.\)/);
  assert.deepEqual(stored(config).settings, { size: 3 });

  const back = await cli(['overlay', 'revert', 'main'], env);
  assert.equal(back.code, 0, back.stderr);
  assert.match(back.stdout, /^main is back on 1\.0\.0, with the settings it had there/m);
  const doc = stored(config);
  assert.deepEqual(doc.template, { id: ID, version: '1.0.0' });
  assert.deepEqual(doc.settings, { size: 3, old: 'x' });
  assert.deepEqual(doc.previous.template, { id: ID, version: '1.1.0' }, 'the revert can be undone in turn');
});

test('each change made from the command line goes to the audit log as cli:<user>; looking, dry runs and refusals add nothing', async (t) => {
  const { root, env, config } = dirs(t);
  const pack = (version, settings) => {
    const file = path.join(root, `${version}.skp`);
    writeFileSync(file, packTemplate(DIAG_DIR, { manifest: { id: ID, version, settings } }));
    return file;
  };
  const v1 = pack('1.0.0', V1);
  const ok = async (...args) => {
    const res = await cli(args, env);
    assert.equal(res.code, 0, `${args.join(' ')}: ${res.stderr}`);
  };
  await ok('template', 'install', v1);
  await ok('template', 'install', v1); // already installed: nothing changed
  await ok('template', 'install', pack('1.1.0', V1_1));
  await ok('template', 'list');
  await ok('template', 'list', '--json');
  const data = openData(config, { log: memoryLogger().log });
  try {
    data.overlays.create({ slug: 'main', template: { id: ID, version: '1.0.0' }, settings: { size: 3, old: 'x' } });
  } finally {
    data.close();
  }
  await ok('overlay', 'upgrade', 'main', '--to', '1.1.0', '--dry-run');
  assert.equal((await cli(['overlay', 'upgrade', 'main', '--to', '1.1.0'], env)).code, 1, 'needs --yes');
  await ok('overlay', 'upgrade', 'main', '--to', '1.1.0', '--yes');
  assert.equal((await cli(['template', 'uninstall', 'dev.skp.sample@1.1.0'], env)).code, 1, 'in use');
  await ok('overlay', 'revert', 'main');
  await ok('template', 'uninstall', 'dev.skp.sample@1.1.0');

  const ops = auditOf(config);
  assert.deepEqual(ops.map((o) => {
    const { file, build, ...details } = o.details || {};
    return { action: o.action, ...details };
  }), [
    { action: 'template.install', template: 'dev.skp.sample@1.0.0' },
    { action: 'template.install', template: 'dev.skp.sample@1.1.0' },
    { action: 'overlay.upgrade', overlay: 'main', from: '1.0.0', to: '1.1.0', migrated: false, changes: 1 },
    { action: 'overlay.revert', overlay: 'main', from: '1.1.0', to: '1.0.0' },
    { action: 'template.uninstall', removed: ['dev.skp.sample@1.1.0'] },
  ]);
  const me = (() => { try { return userInfo().username; } catch { return undefined; } })();
  for (const o of ops) {
    assert.ok(Math.abs(Date.parse(o.at) - Date.now()) < 60_000, o.at);
    assert.equal(o.actor, me ? `cli:${me}` : 'cli');
  }
  assert.equal(ops[0].details.file, path.resolve(v1));
  assert.match(ops[0].details.build, /^[0-9a-f]{16}$/);
});

test('a minor upgrade that drops a value the operator set shows the plan and needs --yes', async (t) => {
  const { env, config } = await withSample(t, [{ version: '1.0.0', settings: V1 }, { version: '1.1.0', settings: V1_1 }], { size: 3, old: 'x' });
  const res = await cli(['overlay', 'upgrade', 'main', '--to', '1.1.0'], env);
  assert.equal(res.code, 1);
  assert.match(res.stdout, /^main: 1\.0\.0 → 1\.1\.0$/m);
  assert.match(res.stdout, /^ {2}setting \/old is no longer used and is dropped \(was "x"\)$/m);
  assert.match(res.stdout, /1\.0\.0 → 1\.1\.0 drops something this overlay uses; review what changes, then confirm it\. Run it again with --yes to apply\./);
  const json = await cli(['overlay', 'upgrade', 'main', '--to', '1.1.0', '--json'], env);
  assert.equal(json.code, 1);
  const body = JSON.parse(json.stdout);
  assert.equal(body.error, 'confirm-changes');
  assert.deepEqual([body.plan.major, body.plan.confirm], [false, true]);
  assert.deepEqual(stored(config).template, { id: ID, version: '1.0.0' });

  const done = await cli(['overlay', 'upgrade', 'main', '--to', '1.1.0', '--yes'], env);
  assert.equal(done.code, 0, done.stderr);
  assert.deepEqual(stored(config).template, { id: ID, version: '1.1.0' });
});

// The size limit is what's left to fail: the plan's "problem:" lines (values that don't validate)
// can't be reached through an upgrade, since migrateSettings already drops every value that
// validateSettings would refuse.
test('settings from migrate.js that can\'t be saved are refused with the plan, on a dry run too', async (t) => {
  const fields = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
  const wide = { type: 'object', properties: Object.fromEntries(fields.map((f) => [f, { type: 'string' }])) };
  // Seven values of 4000 characters: each fits its field; together they pass the 24 KiB an overlay may save.
  const migrate = `function migrate() { const x = 'x'.repeat(4000); return { ${fields.map((f) => `${f}: x`).join(', ')} }; }`;
  const { env, config } = await withSample(t, [{ version: '1.0.0', settings: V1 }, { version: '1.1.0', settings: wide, files: { 'migrate.js': migrate } }], { size: 3 });
  for (const extra of [['--dry-run'], ['--yes']]) {
    const res = await cli(['overlay', 'upgrade', 'main', '--to', '1.1.0', '--run-migrate', ...extra], env);
    assert.equal(res.code, 1, extra[0]);
    assert.match(res.stdout, /^main: 1\.0\.0 → 1\.1\.0, settings run through the template's migrate\.js$/m);
    assert.match(res.stdout, /^ {2}migrate\.js removed setting \/size \(was 3\)$/m);
    assert.match(res.stdout, /^ {2}migrate\.js set \/g = "x{4000}"$/m);
    assert.match(res.stdout, /^migrate\.js produced settings that can't be saved for dev\.skp\.sample@1\.1\.0: Settings are limited to 24 KiB\.$/m);
    assert.doesNotMatch(res.stdout, /--yes/);
  }
  const json = await cli(['overlay', 'upgrade', 'main', '--to', '1.1.0', '--run-migrate', '--json'], env);
  assert.equal(json.code, 1);
  const body = JSON.parse(json.stdout);
  assert.equal(body.error, 'bad-settings');
  assert.match(body.message, /limited to 24 KiB/);
  assert.deepEqual([body.plan.overlay, body.plan.from, body.plan.to, body.plan.migrated], ['main', '1.0.0', '1.1.0', true]);
  assert.equal(body.plan.changes.filter((c) => c.change === 'migrated').length, 8);
  assert.deepEqual(stored(config).template, { id: ID, version: '1.0.0' });
  assert.deepEqual(auditOf(config).map((o) => o.action), ['template.install', 'template.install']);
});

test('a known error is one line, or JSON with --json, and never a stack', async (t) => {
  const { root, env, config } = dirs(t);
  const oneLine = (res) => {
    assert.equal(res.code, 1);
    assert.doesNotMatch(res.stderr, /^\s+at /m, res.stderr);
    assert.doesNotMatch(res.stderr, /unexpected error/);
    assert.equal(res.stderr.trimEnd().split('\n').length, 1, res.stderr);
    assert.match(res.stderr, /^skp: /);
  };

  // A slug that could never be an id is simply not found.
  const slug = await cli(['overlay', 'upgrade', 'my overlay', '--to', '1.1.0'], env);
  oneLine(slug);
  assert.match(slug.stderr, /^skp: There is no overlay "my overlay"\.$/m);

  const notDir = path.join(DIAG_DIR, 'template.json');
  const pack = await cli(['template', 'pack', notDir, '-o', path.join(root, 'x.skp')]);
  oneLine(pack);
  assert.match(pack.stderr, /^skp: not a directory: /m);
  const packJson = await cli(['template', 'pack', notDir, '-o', path.join(root, 'x.skp'), '--json']);
  assert.equal(packJson.code, 1);
  assert.deepEqual(JSON.parse(packJson.stdout), { error: 'ENOTDIR', message: `not a directory: ${notDir}` });
  assert.ok(!existsSync(path.join(root, 'x.skp')));

  // A store a newer build has migrated.
  mkdirSync(config.dataDir, { recursive: true });
  const store = openStore({ dataDir: config.dataDir, backend: config.store, log: memoryLogger().log });
  try {
    store.transaction((tx) => tx.setMeta('schemaVersion', 99));
  } finally {
    store.close();
  }
  const newer = await cli(['template', 'list'], env);
  oneLine(newer);
  assert.match(newer.stderr, /^skp: .* is at schema version 99, but this build only knows up to \d+\./m);
  const newerJson = await cli(['overlay', 'revert', 'main', '--json'], env);
  assert.equal(newerJson.code, 1);
  const body = JSON.parse(newerJson.stdout);
  assert.deepEqual(Object.keys(body).sort(), ['error', 'message']);
  assert.notEqual(body.error, 'internal');
  assert.match(body.message, /schema version 99/);
});

test('with --json, a store a newer build migrated is reported with a code of its own', async (t) => {
  const { env, config } = dirs(t);
  mkdirSync(config.dataDir, { recursive: true });
  const store = openStore({ dataDir: config.dataDir, backend: config.store, log: memoryLogger().log });
  try {
    store.transaction((tx) => tx.setMeta('schemaVersion', 99));
  } finally {
    store.close();
  }
  const res = await cli(['template', 'list', '--json'], env);
  assert.equal(res.code, 1);
  // Like the other codes ('not-found', 'confirm-changes' …), not a class name.
  assert.equal(JSON.parse(res.stdout).error, 'store-version');
});

test('with --json, refusals before a command starts are JSON too: in use, config, usage', async (t) => {
  const { env, config } = dirs(t);
  mkdirSync(config.dataDir, { recursive: true });
  writeFileSync(path.join(config.dataDir, 'skp.lock'), JSON.stringify({ pid: process.ppid, purpose: 'platform' }));
  const locked = await cli(['template', 'install', 'x.skp', '--json'], env);
  assert.equal(locked.code, 75);
  assert.equal(JSON.parse(locked.stdout).error, 'locked');
  const badConfig = await cli(['template', 'list', '--store', 'mongo', '--json'], env);
  assert.equal(badConfig.code, 78);
  assert.equal(JSON.parse(badConfig.stdout).error, 'config');
  const usage = await cli(['template', 'install', '--json'], env);
  assert.equal(usage.code, 64);
  assert.equal(JSON.parse(usage.stdout).error, 'usage');
  const unknownFlag = await cli(['template', 'list', '--nope', '--json'], env);
  assert.equal(unknownFlag.code, 64);
  assert.equal(JSON.parse(unknownFlag.stdout).error, 'usage');
});

// The entry point as a child process, with directories of its own. A command ends by itself;
// SKP_PORT=0 and the timeout only matter if something wrongly starts the server.
function main(args, root) {
  const env = { ...process.env, SKP_DATA_DIR: path.join(root, 'data'), SKP_CONFIG_DIR: path.join(root, 'config'), SKP_PORT: '0', SKP_STORE: '', SKP_LOG_LEVEL: '' };
  const res = spawnSync(process.execPath, [MAIN, ...args], { env, encoding: 'utf8', timeout: 20000 });
  return { ...res, why: `${args.join(' ')} → ${res.status} ${res.error?.message ?? ''}\n${res.stderr}` };
}

test('node src/main.js runs a command given a word or a flag only commands take, in any order with the server\'s flags', async (t) => {
  const root = tempDir(t);
  const other = path.join(root, 'other');
  // A command's flag alone, with no command word, is a command: its usage, not the server.
  for (const args of [['--help'], ['-h'], ['--json'], ['--yes'], ['--data-dir', other, '--dry-run']]) {
    const res = main(args, root);
    assert.equal(res.status, 0, res.why);
    assert.match(res.stderr, /Usage: skp <command> \[options\]/);
    assert.equal(res.stdout, '');
  }
  const json = main(['--json', 'template', 'list'], root);
  assert.equal(json.status, 0, json.why);
  assert.deepEqual(JSON.parse(json.stdout).map((r) => r.id), BUNDLED);
  // The server's flags take a value: `--data-dir D` is not a command, the words after it are.
  const flagged = main(['--data-dir', other, 'template', 'list'], root);
  assert.equal(flagged.status, 0, flagged.why);
  assert.match(flagged.stdout, /^dev\.skp\.diagnostic@1\.0\.0 /m);
  assert.ok(existsSync(path.join(other, 'templates')), 'the --data-dir directory was used');
  const joined = main([`--data-dir=${other}`, '-h'], root);
  assert.equal(joined.status, 0, joined.why);
});

test('node src/main.js with only the server\'s flags runs the server: a bad flag is a configuration error (78)', async (t) => {
  const root = tempDir(t);
  const res = main(['--port', '0', '--bogus', 'x'], root);
  assert.equal(res.status, 78, res.why);
  assert.match(res.stderr, /^skp: configuration error: .*--bogus/m);
  assert.ok(!existsSync(path.join(root, 'data')), 'nothing started');
});

test('as root, a command refuses a data directory another user owns (exit 77) and writes nothing there', { skip: process.geteuid?.() !== 0 && 'only meaningful when run as root (POSIX)' }, async (t) => {
  const { root, env, config } = dirs(t);
  mkdirSync(config.dataDir, { recursive: true });
  try {
    chownSync(config.dataDir, 65534, 65534);
  } catch (err) {
    // Root in a user namespace (rootless containers) may have no uid 65534 to give it to.
    if (err.code === 'EINVAL' || err.code === 'EPERM') return t.skip(`can't chown here (${err.code})`);
    throw err;
  }
  const file = path.join(root, 'x.skp');
  writeFileSync(file, packTemplate(DIAG_DIR, { manifest: { id: ID, version: '1.0.0' } }));
  const res = await cli(['template', 'install', file], env);
  assert.equal(res.code, 77, res.stderr);
  assert.match(res.stderr, /belongs to uid 65534, and this is root/);
  assert.deepEqual(readdirSync(config.dataDir), []);
});
