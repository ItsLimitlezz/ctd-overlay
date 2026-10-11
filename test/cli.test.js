// The command line (src/cli.js): template validate, pack, list, install, uninstall and overlay
// upgrade, its exit codes, and the lock that keeps it off a running platform's data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openData, startPlatform } from '../src/app.js';
import { run } from '../src/cli.js';
import { loadConfig } from '../src/config.js';
import { validateTemplate } from '../src/templates/registry.js';
import { DIAG_DIR, defer, memoryLogger, packTemplate, tempDir } from './helpers.js';

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
  assert.deepEqual(list.map((r) => `${r.id}@${r.version} ${r.source} ${r.overlays}`), ['dev.skp.diagnostic@1.0.0 bundled 0', 'dev.skp.sample@1.0.0 installed 0']);
  const removed = await cli(['template', 'uninstall', 'dev.skp.sample@1.0.0'], env);
  assert.equal(removed.code, 0, removed.stderr);
  assert.equal((await cli(['template', 'uninstall', 'dev.skp.sample@1.0.0'], env)).code, 1);
  assert.match((await cli(['template', 'uninstall', 'dev.skp.diagnostic'], env)).stderr, /ships with the platform/);
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
