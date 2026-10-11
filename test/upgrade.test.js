// Overlays on installed templates: resolved settings (04 §4.3–4.4), the files they serve, and
// moving to a newer version (04 §4.10) without the OBS URL ever changing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { DIAG_DIR, defer, packTemplate, startWithOverlay } from './helpers.js';

const ID = 'dev.skp.sample';
const settingsV1 = {
  type: 'object',
  properties: {
    accent: { type: 'string', format: 'color', default: '#EFC33F' },
    size: { type: 'integer', minimum: 1, maximum: 10, default: 2 },
    old: { type: 'string' },
  },
};
const settingsV2 = {
  type: 'object',
  properties: {
    accent: { type: 'string', format: 'color', default: '#000000' },
    size: { type: 'integer', minimum: 1, maximum: 5, default: 2 },
    fresh: { type: 'boolean', default: true },
  },
};
const v = (version, settings, extra = {}) => packTemplate(DIAG_DIR, {
  manifest: { id: ID, version, settings, consumes: { state: ['custom.*'], events: ['custom.*'] }, ...extra.manifest },
  files: extra.files,
});

async function setup(t, { settings = { size: 3, old: 'x' }, install = [v('1.0.0', settingsV1)] } = {}) {
  return startWithOverlay(t, { slug: 'main', template: { id: ID, version: '1.0.0' }, settings, install });
}

const meta = async (url) => {
  const html = await (await fetch(url)).text();
  return JSON.parse(/<meta name="skp" content="([^"]*)">/.exec(html)[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
};

test('an overlay sees its resolved settings: saved values, then defaults, in the snapshot and the page alike', async (t) => {
  const { base, platform, overlay } = await setup(t);
  const snap = await (await fetch(`${base}/snapshot`)).json();
  assert.deepEqual(snap.state['overlay.settings'], { accent: '#EFC33F', size: 3, old: 'x' });
  assert.deepEqual((await meta(base)).settings, snap.state['overlay.settings']);
  // The store keeps only what the operator set.
  assert.deepEqual(platform.store.get('overlays', overlay.id).data.settings, { size: 3, old: 'x' });
});

test('settings are checked before they are saved; an edit made from a stale copy is a conflict', async (t) => {
  const { platform, overlay, base } = await setup(t);
  assert.throws(() => platform.overlays.create({ slug: 'other', template: { id: ID, version: '1.0.0' }, settings: { size: 99, nope: 1 } }), (err) => {
    assert.equal(err.code, 'bad-settings');
    assert.match(err.message, /\/size must be at most 10/);
    assert.match(err.message, /\/nope is not a setting/);
    return true;
  });
  assert.throws(() => platform.overlays.create({ slug: 'big', template: { id: ID, version: '1.0.0' }, settings: { old: 'x'.repeat(30000) } }), /limited to 24 KiB/);
  const updated = platform.overlays.updateSettings('main', { accent: '#112233' }, { ifRev: overlay.rev });
  assert.equal(updated.rev, overlay.rev + 1);
  assert.throws(() => platform.overlays.updateSettings('main', { size: 1 }, { ifRev: overlay.rev }), { name: 'ConflictError' });
  const snap = await (await fetch(`${base}/snapshot`)).json();
  assert.deepEqual(snap.state['overlay.settings'], { accent: '#112233', size: 2 });
});

test('only the files the template lists are served, exactly as named, sandboxed if opened directly', async (t) => {
  const { base, build, platform } = await setup(t);
  const res = await fetch(`${base}/t/${build}/template.css`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-security-policy'), /^sandbox; default-src 'none'/);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.equal((await fetch(`${base}/t/${build}/TEMPLATE.CSS`)).status, 404, 'case-exact on every OS');
  assert.equal((await fetch(`${base}/t/${build}/../install.json`)).status, 404);
  assert.equal((await fetch(`${base}/t/${build}/install.json`)).status, 404);
  // A file that appears on disk after install was never listed, so it isn't served.
  const dir = platform.templates.get(ID, '1.0.0').dir;
  writeFileSync(path.join(dir, 'added-later.js'), 'alert(1)');
  assert.equal((await fetch(`${base}/t/${build}/added-later.js`)).status, 404);
});

test('upgrade: settings carried over (removed dropped, invalid back to default), new build and consumes, same URL', async (t) => {
  // size 7 fits 1.0.0 (at most 10) but not 1.1.0 (at most 5).
  const { base, build, platform, overlay } = await setup(t, { settings: { size: 7, old: 'x' }, install: [v('1.0.0', settingsV1), v('1.1.0', settingsV2, { manifest: { consumes: { state: ['custom.*', 'viewers.*'], events: ['custom.*'] } } })] });
  // An open stream ends, so the page re-syncs and sees the new build.
  const { cursor } = await (await fetch(`${base}/snapshot`)).json();
  const ctrl = new AbortController();
  defer(t, () => ctrl.abort());
  const stream = await fetch(`${base}/stream?cursor=${cursor}`, { signal: ctrl.signal });
  const ended = stream.text();
  const plan = await platform.overlays.upgrade('main', '1.1.0');
  await ended;
  assert.equal(plan.major, false);
  assert.deepEqual(plan.changes.map((c) => `${c.change} ${c.path}`), ['invalid /size', 'removed /old', 'default /accent', 'added /fresh']);
  assert.deepEqual(platform.store.get('overlays', overlay.id).data, { slug: 'main', template: { id: ID, version: '1.1.0' }, settings: {}, connections: [] });
  const snap = await (await fetch(`${base}/snapshot`)).json();
  assert.notEqual(snap.build, build);
  assert.equal(snap.build, platform.templates.get(ID, '1.1.0').build);
  assert.deepEqual(snap.state['overlay.settings'], { accent: '#000000', size: 2, fresh: true });
  platform.bus.setState('viewers.total', 12);
  assert.equal((await (await fetch(`${base}/snapshot`)).json()).state['viewers.total'], 12, 'the new version\'s consumes apply');
  assert.equal((await fetch(base)).status, 200);
});

test('upgrade refuses an older, equal or missing version, and an edit made since it started', async (t) => {
  const { platform, overlay } = await setup(t, { install: [v('1.0.0', settingsV1), v('0.9.0', settingsV1), v('1.1.0', settingsV2)] });
  await assert.rejects(platform.overlays.upgrade('main', '0.9.0'), { code: 'not-newer' });
  await assert.rejects(platform.overlays.upgrade('main', '1.0.0'), { code: 'not-newer' });
  await assert.rejects(platform.overlays.upgrade('main', '3.0.0'), { code: 'no-template' });
  await assert.rejects(platform.overlays.upgrade('nobody', '1.1.0'), { code: 'not-found' });
  await assert.rejects(platform.overlays.upgrade('main', '1.1.0', { ifRev: overlay.rev - 1 }), { name: 'ConflictError' });
  assert.equal(platform.store.get('overlays', overlay.id).data.template.version, '1.0.0');
});

test('a major upgrade shows its plan and needs a confirmation; a dry run changes nothing', async (t) => {
  const { platform, overlay } = await setup(t, { install: [v('1.0.0', settingsV1), v('2.0.0', settingsV2, { manifest: { scenes: [{ id: 'live', label: 'Live', core: 'program' }] } })] });
  const dry = await platform.overlays.upgrade('main', '2.0.0', { dryRun: true });
  assert.equal(dry.major, true);
  assert.deepEqual(dry.removed.scenes, ['program']);
  assert.equal(platform.store.get('overlays', overlay.id).rev, overlay.rev);
  await assert.rejects(platform.overlays.upgrade('main', '2.0.0'), (err) => err.code === 'confirm-major' && err.detail.to === '2.0.0');
  const done = await platform.overlays.upgrade('main', '2.0.0', { confirm: true });
  assert.equal(done.doc.data.template.version, '2.0.0');
});

test('a package\'s migrate.js renames settings on upgrade when the operator allows it, isolated', async (t) => {
  const renamed = { type: 'object', properties: { colour: { type: 'string', format: 'color' }, size: { type: 'integer', default: 2 } } };
  const migrate = 'export function migrate(from, s) { if (s.accent) { s.colour = s.accent; delete s.accent; } return s; }';
  const { platform, base } = await setup(t, {
    settings: { accent: '#123456' },
    install: [v('1.0.0', settingsV1), v('1.2.0', renamed, { files: { 'migrate.js': migrate } }), v('1.3.0', renamed, { files: { 'migrate.js': 'function migrate() { for (;;) {} }' } })],
  });
  // Package code runs on the server only when allowed; skipped, the renamed setting is dropped.
  const skipped = await platform.overlays.upgrade('main', '1.2.0', { dryRun: true });
  assert.equal(skipped.migrated, 'skipped');
  assert.deepEqual(skipped.changes.map((c) => `${c.change} ${c.path}`), ['removed /accent', 'added /colour']);
  const plan = await platform.overlays.upgrade('main', '1.2.0', { runMigrate: true });
  assert.equal(plan.migrated, true);
  assert.deepEqual(plan.settings, { colour: '#123456' });
  assert.deepEqual((await (await fetch(`${base}/snapshot`)).json()).state['overlay.settings'], { colour: '#123456', size: 2 });
  // A migrate.js that never returns fails the upgrade, and the overlay stays where it was.
  await assert.rejects(platform.overlays.upgrade('main', '1.3.0', { runMigrate: true }), { name: 'MigrateError' });
  assert.equal(platform.overlays.resolve('main').doc.data.template.version, '1.2.0');
});

test('what counts as a major upgrade', async () => {
  const { isMajor } = await import('../src/overlays/registry.js');
  assert.equal(isMajor('1.4.0', '2.0.0'), true);
  assert.equal(isMajor('1.4.0', '1.9.3'), false);
  assert.equal(isMajor('0.3.0', '0.4.0'), true, 'under 1.0.0 a minor version can break things');
  assert.equal(isMajor('0.3.0', '0.3.9'), false);
  assert.equal(isMajor('1.0.0-rc.1', '1.0.0'), true, 'a prerelease promises nothing');
});
