// Overlays on installed templates: resolved settings (04 §4.3–4.4), the files they serve, and
// moving to a newer version (04 §4.10) without the OBS URL ever changing. And data from the
// version before this one, upgraded with nobody doing anything (store migrations).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { startPlatform } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { until } from './connector-helpers.js';
import { startFakeMultistream } from './fixtures/fake-multistream.mjs';
import { DIAG_DIR, FIXTURE_TEMPLATES, defer, memoryLogger, packTemplate, signedIn, startWithOverlay, tempDir } from './helpers.js';

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

// A platform on config's data directory (new, or the same one again as after a restart), stopped
// when the test ends.
async function start(t, config, templateDirs = [FIXTURE_TEMPLATES]) {
  const platform = await startPlatform(config, { log: memoryLogger().log, templateDirs });
  defer(t, () => platform.stop());
  return platform;
}

// Takes an installed version away from under its overlays: stopped, its <id>/<build> directory
// deleted, started again.
async function withoutVersion(t, { platform, config }, version) {
  const dir = path.dirname(platform.templates.get(ID, version).dir);
  await platform.stop();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  const again = await start(t, config);
  assert.equal(again.templates.get(ID, version), undefined);
  return again;
}

const meta = async (url) => {
  const html = await (await fetch(url)).text();
  return JSON.parse(/<meta name="skp" content="([^"]*)">/.exec(html)[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
};

const snapshot = async (base, key) => (await fetch(`${base}/snapshot${key ? `?key=${key}` : ''}`)).json();

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

test('settings are measured in UTF-8 bytes: 24 KiB saved is 24 KiB however few characters it takes', async (t) => {
  const strings = { type: 'object', properties: Object.fromEntries([1, 2, 3, 4, 5, 6].map((i) => [`s${i}`, { type: 'string', maxLength: 4096 }])) };
  const { platform, base, overlay } = await setup(t, { settings: {}, install: [v('1.0.0', strings)] });
  // Each value fits its field; "£" is one character but two bytes.
  const values = (n) => Object.fromEntries([1, 2, 3, 4, 5, 6].slice(0, n).map((i) => [`s${i}`, '£'.repeat(4000)]));
  assert.ok(JSON.stringify(values(6)).length < 24 * 1024, 'under 24 Ki characters');
  assert.throws(() => platform.overlays.updateSettings('main', values(6)), (err) => err.code === 'bad-settings' && /limited to 24 KiB/.test(err.message));
  assert.throws(() => platform.overlays.create({ slug: 'other', template: { id: ID, version: '1.0.0' }, settings: values(6) }), { code: 'bad-settings' });
  assert.equal(platform.store.get('overlays', overlay.id).rev, overlay.rev);
  platform.overlays.updateSettings('main', values(3));
  assert.deepEqual((await snapshot(base)).state['overlay.settings'], values(3));
});

test('a template whose defaults alone take more than 6 KiB is refused at install', async (t) => {
  const { platform } = await setup(t);
  // About 4 Ki characters, 8 KB as UTF-8.
  const heavy = { type: 'object', properties: { a: { type: 'string', default: '£'.repeat(2000) }, b: { type: 'string', default: '£'.repeat(2000) } } };
  assert.throws(() => platform.templates.install(v('1.1.0', heavy), { actor: 'test' }), (err) => {
    assert.equal(err.code, 'invalid');
    assert.ok(err.findings.some((f) => f.code === 'settings' && /defaults together/.test(f.message)), JSON.stringify(err.findings));
    return true;
  });
  assert.equal(platform.templates.get(ID, '1.1.0'), undefined);
});

test('a bound state value is kept while the settings take at most 31 KiB, and left out past that', async (t) => {
  const listed = {
    type: 'object',
    properties: {
      accent: { type: 'string', default: '#EFC33F' },
      names: { type: 'array', items: { type: 'string' }, 'x-skp-bind': 'custom.names' },
    },
  };
  const { platform, base, entries } = await setup(t, { settings: {}, install: [v('1.0.0', listed)] });
  const warnings = () => entries.filter((e) => e.level === 'warn' && /too large to send/.test(e.msg)).length;
  platform.bus.setState('custom.names', ['Ana', 'Bo']);
  assert.deepEqual((await snapshot(base)).state['overlay.settings'], { accent: '#EFC33F', names: ['Ana', 'Bo'] });

  // The settings travel beside their previous value in one 64 KiB envelope, so each may take
  // 31 KiB. Names that make the resolved settings exactly `bytes` long, as UTF-8 JSON (the last
  // name pads to the byte).
  const LIMIT = 31 * 1024;
  const size = (names) => Buffer.byteLength(JSON.stringify({ accent: '#EFC33F', names }));
  const sized = (bytes, pad) => {
    const names = Array.from({ length: 1200 }, (_, i) => `a-rather-long-name-${String(i).padStart(4, '0')}`);
    names.push('');
    names[names.length - 1] = pad.repeat(bytes - size(names));
    assert.equal(size(names), bytes);
    return names;
  };
  // At the limit, kept; twice in a row too (value and previous value then take most of the envelope).
  for (const pad of ['x', 'y']) {
    const names = sized(LIMIT, pad);
    platform.bus.setState('custom.names', names);
    assert.deepEqual((await snapshot(base)).state['overlay.settings'], { accent: '#EFC33F', names }, `${LIMIT} bytes (${pad})`);
  }
  assert.equal(warnings(), 0);
  assert.equal((await fetch(base)).status, 200);

  // One byte over: still a valid state value, but left out of the settings, with a warning.
  const over = sized(LIMIT + 1, 'z');
  platform.bus.setState('custom.names', over);
  const snap = await snapshot(base);
  assert.deepEqual(snap.state['custom.names'], over);
  assert.deepEqual(snap.state['overlay.settings'], { accent: '#EFC33F' });
  assert.ok(warnings() > 0);
  assert.equal((await fetch(base)).status, 200);
});

test('a bound setting follows its state key live, as the overlay sees it, and a saved value beats it', async (t) => {
  const bound = {
    type: 'object',
    properties: {
      headliner: { type: 'string', default: 'TBA', 'x-skp-bind': 'custom.headliner' },
      scene: { type: 'string', 'x-skp-bind': 'show.scene' },
    },
  };
  const { platform } = await setup(t, { settings: {}, install: [v('1.0.0', bound)] });
  const template = { id: ID, version: '1.0.0' };
  platform.overlays.create({ slug: 'live', template, settings: {}, connections: ['conn_a'] });
  platform.overlays.create({ slug: 'saved', template, settings: { headliner: 'Saved' }, connections: ['conn_a'] });
  platform.overlays.updateConnections('main', []); // bound to no connection (new overlays take every one)
  const settingsOf = async (slug) => (await snapshot(`${platform.url}/o/${slug}`, platform.overlays.key(slug))).state['overlay.settings'];
  assert.deepEqual(await settingsOf('live'), { headliner: 'TBA' });

  // No other call: the overlays bound to the key are resolved again as it changes.
  platform.bus.setState('custom.headliner', 'A', { src: { connector: 'x', connection: 'conn_a' } });
  assert.deepEqual(await settingsOf('live'), { headliner: 'A' });
  assert.deepEqual(await settingsOf('saved'), { headliner: 'Saved' });
  assert.deepEqual(await settingsOf('main'), { headliner: 'TBA' }, 'conn_a is not bound to main');

  // From a connection not bound to the overlay, the value doesn't count: each connection keeps its
  // own value (step 16), so live still shows conn_a's, and nothing once conn_a's goes.
  platform.bus.setState('custom.headliner', 'B', { src: { connector: 'x', connection: 'conn_b' } });
  assert.deepEqual(await settingsOf('live'), { headliner: 'A' });
  platform.bus.setState('custom.headliner', undefined, { src: { connector: 'x', connection: 'conn_a' } });
  assert.deepEqual(await settingsOf('live'), { headliner: 'TBA' });
  // Bound to conn_b now: its value arrives without anything else changing.
  platform.overlays.updateConnections('live', ['conn_b']);
  assert.deepEqual(await settingsOf('live'), { headliner: 'B' });
  platform.overlays.updateConnections('live', ['conn_a']);

  // Only keys the template consumes are readable (install refuses binding any other), except
  // show.scene, which every overlay sees, declared or not (04 §4.3, x-skp-bind).
  const channel = platform.overlays.resolve('live').channel;
  platform.bus.setState('viewers.total', 12);
  assert.equal(channel.visibleState('viewers.total'), undefined);
  platform.bus.setState('show.scene', 'brb');
  assert.equal(channel.visibleState('show.scene'), 'brb');
  assert.deepEqual(await settingsOf('live'), { headliner: 'TBA', scene: 'brb' });
});

test('only the files the template lists are served, exactly as named, sandboxed if opened directly', async (t) => {
  const { base, build, platform, config } = await setup(t);
  const res = await fetch(`${base}/t/${build}/template.css`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-security-policy'), /^sandbox; default-src 'none'/);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  // Ways out of the package that URL normalization leaves alone (an encoded / or \ inside one
  // segment), aimed at files that exist: the receipt beside package/, and one at the top of the
  // data directory. The %5c (\) ones are a way out only on Windows; elsewhere \ is part of a
  // name, so there they pass whatever the guards do and the %2f ones carry the check.
  const dir = platform.templates.get(ID, '1.0.0').dir;
  assert.match(readFileSync(path.join(dir, '..', 'install.json'), 'utf8'), /"packageSha256"/);
  writeFileSync(path.join(config.dataDir, 'secret.txt'), 'not-for-overlays');
  for (const [escape, content] of [
    ['..%2finstall.json', 'packageSha256'],
    ['%2e%2e%2finstall.json', 'packageSha256'],
    ['..%5cinstall.json', 'packageSha256'],
    ['..%2f..%2f..%2f..%2fsecret.txt', 'not-for-overlays'],
    ['..%5c..%5c..%5c..%5csecret.txt', 'not-for-overlays'],
    ['assets%2f..%2f..%2f..%2f..%2f..%2fsecret.txt', 'not-for-overlays'],
  ]) {
    const answer = await fetch(`${base}/t/${build}/${escape}`);
    const body = await answer.text();
    assert.equal(answer.status, 404, escape);
    assert.equal(JSON.parse(body).detail, 'No such template file.', `${escape} reached the file route`);
    assert.ok(!body.includes(content), escape);
  }
  assert.equal((await fetch(`${base}/t/${build}/TEMPLATE.CSS`)).status, 404, 'case-exact on every OS');
  // A file that appears on disk after install was never listed, so it isn't served.
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
  ended.catch(() => {}); // awaited below; aborted at cleanup if an assertion fails first
  const channel = platform.overlays.resolve('main').channel;
  assert.equal(channel.subscriberCount, 1);
  const storedKey = platform.store.get('overlays', overlay.id).data.key;
  // Values the operator set are dropped: a minor version too needs a confirmation.
  await assert.rejects(platform.overlays.upgrade('main', '1.1.0'), (err) => err.code === 'confirm-changes' && err.detail.confirm === true && err.detail.major === false);
  assert.equal(platform.store.get('overlays', overlay.id).rev, overlay.rev);
  assert.equal(channel.subscriberCount, 1, 'a refused upgrade leaves open streams alone');
  const plan = await platform.overlays.upgrade('main', '1.1.0', { confirm: true });
  // Checked before the stream is awaited, so a stream left open fails here instead of hanging.
  assert.equal(channel.subscriberCount, 0, 'open streams end');
  await ended;
  assert.equal(plan.major, false);
  assert.deepEqual(plan.changes.map((c) => `${c.change} ${c.path}`), ['invalid /size', 'removed /old', 'default /accent', 'added /fresh']);
  const { previous, ...data } = platform.store.get('overlays', overlay.id).data;
  const { key, keyRequired, ...stored } = data;
  assert.deepEqual(stored, { slug: 'main', template: { id: ID, version: '1.1.0' }, settings: {}, connections: 'all' });
  assert.match(key, /^enc:v1:/, 'the key, encrypted');
  assert.equal(key, storedKey, 'and unchanged by the upgrade');
  assert.deepEqual({ ...previous, at: undefined }, { template: { id: ID, version: '1.0.0' }, settings: { size: 7, old: 'x' }, at: undefined });
  const snap = await (await fetch(`${base}/snapshot`)).json();
  assert.notEqual(snap.build, build);
  assert.equal(snap.build, platform.templates.get(ID, '1.1.0').build);
  assert.deepEqual(snap.state['overlay.settings'], { accent: '#000000', size: 2, fresh: true });
  platform.bus.setState('viewers.total', 12);
  assert.equal((await (await fetch(`${base}/snapshot`)).json()).state['viewers.total'], 12, 'the new version\'s consumes apply');
  assert.equal((await fetch(base)).status, 200);
});

test('an overlay keeps its key through an upgrade, a revert, a rename and a restart: its URL in OBS keeps working (H2)', async (t) => {
  const { platform, config, key } = await startWithOverlay(t, { slug: 'main', template: { id: ID, version: '1.0.0' }, settings: {}, keyed: true, install: [v('1.0.0', settingsV1), v('1.1.0', settingsV1)] });
  const status = async (p, slug = 'main') => (await fetch(`${p.url}/o/${slug}/snapshot?key=${key}`)).status;
  assert.equal(await status(platform), 200);
  await platform.overlays.upgrade('main', '1.1.0');
  assert.equal(await status(platform), 200, 'after the upgrade');
  platform.overlays.revert('main');
  assert.equal(await status(platform), 200, 'after the revert');
  platform.overlays.rename('main', 'main-h');
  assert.equal(await status(platform, 'main-h'), 200, 'renamed: another URL, the same key');
  await platform.stop();
  const again = await start(t, config);
  assert.equal(again.overlays.key('main-h'), key, 'the key as stored, not only the one in memory');
  assert.equal(await status(again, 'main-h'), 200);
});

test('a minor upgrade that drops a value the operator set, or a scene, action or canvas, needs a confirmation', async (t) => {
  const actions = [{ id: 'titleCard', label: 'Title card' }];
  const { accent, size, old } = settingsV1.properties;
  const fields = (properties) => ({ type: 'object', properties });
  const { platform, overlay } = await setup(t, {
    settings: { size: 7, old: 'x' },
    install: [
      v('1.0.0', settingsV1, { manifest: { actions } }),
      v('1.1.0', fields({ accent, size }), { manifest: { actions } }),
      v('1.2.0', fields({ accent, size: { ...size, maximum: 5 }, old }), { manifest: { actions } }),
      v('1.3.0', settingsV1, { manifest: { actions, scenes: [{ id: 'live', label: 'Live', core: 'program' }] } }),
      v('1.4.0', settingsV1),
      v('1.5.0', settingsV1, { manifest: { actions, canvases: [{ id: 'h', width: 1920, height: 1080, default: true }] } }),
      // Adds and changes, drops nothing.
      v('1.6.0', fields({ accent: { ...accent, default: '#000000' }, size, old, fresh: { type: 'boolean', default: true } }), { manifest: { actions: [...actions, { id: 'lowerThird', label: 'Lower third' }] } }),
    ],
  });
  const dropped = (plan) => [
    ...plan.changes.filter((c) => c.change === 'removed' || c.change === 'invalid').map((c) => `${c.change} ${c.path}`),
    ...Object.entries(plan.removed).flatMap(([list, ids]) => ids.map((id) => `${list} ${id}`)),
  ];
  for (const [version, what] of [['1.1.0', 'removed /old'], ['1.2.0', 'invalid /size'], ['1.3.0', 'scenes program'], ['1.4.0', 'actions titleCard'], ['1.5.0', 'canvases v']]) {
    const dry = await platform.overlays.upgrade('main', version, { dryRun: true });
    assert.deepEqual(dropped(dry), [what], version);
    assert.equal(dry.confirm, true, version);
    await assert.rejects(platform.overlays.upgrade('main', version), (err) => err.code === 'confirm-changes' && err.detail.confirm === true && err.detail.major === false, version);
    assert.equal(platform.store.get('overlays', overlay.id).rev, overlay.rev, version);
  }
  const confirmed = await platform.overlays.upgrade('main', '1.2.0', { confirm: true });
  assert.equal(confirmed.doc.data.template.version, '1.2.0');

  platform.overlays.create({ slug: 'other', template: { id: ID, version: '1.0.0' }, settings: { size: 7, old: 'x' } });
  const plan = await platform.overlays.upgrade('other', '1.6.0');
  assert.equal(plan.confirm, false);
  assert.deepEqual(plan.changes.map((c) => `${c.change} ${c.path}`), ['default /accent', 'added /fresh']);
  assert.deepEqual(platform.overlays.resolve('other').doc.data.template, { id: ID, version: '1.6.0' });
});

test('upgrade refuses an older, equal or missing version, and an edit made since it started', async (t) => {
  const { platform, overlay } = await setup(t, { install: [v('1.0.0', settingsV1), v('0.9.0', settingsV1), v('1.1.0', settingsV2)] });
  await assert.rejects(platform.overlays.upgrade('main', '0.9.0'), { code: 'not-newer' });
  await assert.rejects(platform.overlays.upgrade('main', '1.0.0'), { code: 'not-newer' });
  await assert.rejects(platform.overlays.upgrade('main', '3.0.0'), { code: 'no-template' });
  await assert.rejects(platform.overlays.upgrade('nobody', '1.1.0'), { code: 'not-found' });
  await assert.rejects(platform.overlays.upgrade('main', '1.1.0', { ifRev: overlay.rev - 1, confirm: true }), { name: 'ConflictError' });
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

test('an overlay whose template version is gone answers 503, and can still be upgraded to one that is installed', async (t) => {
  const first = await setup(t, { install: [v('1.0.0', settingsV1), v('1.1.0', settingsV2)] });
  const platform = await withoutVersion(t, first, '1.0.0');
  const base = `${platform.url}/o/main`;
  assert.equal((await fetch(base)).status, 503);
  const plan = await platform.overlays.upgrade('main', '1.1.0', { confirm: true });
  assert.deepEqual(plan.removed, { scenes: [], actions: [], canvases: [] });
  assert.equal((await fetch(base)).status, 200);
  assert.deepEqual((await snapshot(base)).state['overlay.settings'], { accent: '#000000', size: 3, fresh: true });
});

test('an overlay waiting for a version that isn\'t installed renders once it is, without a restart', async (t) => {
  const first = await setup(t);
  const platform = await withoutVersion(t, first, '1.0.0');
  const base = `${platform.url}/o/main`;
  assert.equal((await fetch(base)).status, 503);
  assert.equal((await fetch(`${base}/snapshot`)).status, 503);
  platform.templates.install(v('1.0.0', settingsV1), { actor: 'test' });
  assert.equal((await fetch(base)).status, 200);
  platform.bus.setState('custom.counter', 5);
  const snap = await snapshot(base);
  assert.equal(snap.state['custom.counter'], 5, 'the template\'s consumes apply');
  assert.deepEqual(snap.state['overlay.settings'], { accent: '#EFC33F', size: 3, old: 'x' });
  assert.deepEqual((await meta(base)).settings, snap.state['overlay.settings']);
});

test('revert puts back the exact version and settings an overlay had before its upgrade, and goes forward again', async (t) => {
  const { base, build, platform, overlay } = await setup(t, { settings: { accent: '#112233', size: 7, old: 'x' }, install: [v('1.0.0', settingsV1), v('1.1.0', settingsV2)] });
  assert.throws(() => platform.overlays.revert('main'), { code: 'no-previous' });
  await platform.overlays.upgrade('main', '1.1.0', { confirm: true });
  const upgraded = platform.store.get('overlays', overlay.id);
  assert.deepEqual(upgraded.data.settings, { accent: '#112233' });

  const { cursor } = await snapshot(base);
  const ctrl = new AbortController();
  defer(t, () => ctrl.abort());
  const stream = await fetch(`${base}/stream?cursor=${cursor}`, { signal: ctrl.signal });
  const ended = stream.text().catch(() => {});
  const channel = platform.overlays.resolve('main').channel;
  assert.equal(channel.subscriberCount, 1);

  const back = platform.overlays.revert('main');
  assert.deepEqual({ from: back.from, to: back.to }, { from: '1.1.0', to: '1.0.0' });
  assert.equal(channel.subscriberCount, 0, 'open streams end, so pages reload with the old build');
  await ended;
  const doc = platform.store.get('overlays', overlay.id);
  assert.equal(doc.rev, upgraded.rev + 1);
  assert.deepEqual(doc.data.template, { id: ID, version: '1.0.0' });
  assert.deepEqual(doc.data.settings, { accent: '#112233', size: 7, old: 'x' });
  assert.deepEqual({ ...doc.data.previous, at: undefined }, { template: { id: ID, version: '1.1.0' }, settings: { accent: '#112233' }, at: undefined });
  const snap = await snapshot(base);
  assert.equal(snap.build, build);
  assert.deepEqual(snap.state['overlay.settings'], { accent: '#112233', size: 7, old: 'x' });

  // The previous version swaps each time: reverting again goes forward.
  platform.overlays.revert('main');
  const forward = platform.store.get('overlays', overlay.id).data;
  assert.deepEqual(forward.template, { id: ID, version: '1.1.0' });
  assert.deepEqual(forward.settings, { accent: '#112233' });
  assert.equal((await snapshot(base)).build, platform.templates.get(ID, '1.1.0').build);

  // Nothing pins 1.0.0 any more, so it can be uninstalled; then there is nowhere to go back to.
  platform.templates.uninstall(ID, '1.0.0', { pinnedBy: platform.overlays.pinnedBy, actor: 'test' });
  const before = platform.store.get('overlays', overlay.id).rev;
  assert.throws(() => platform.overlays.revert('main'), { code: 'no-template' });
  assert.equal(platform.store.get('overlays', overlay.id).rev, before);
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
  // The plan shows what migrate.js did, then what the copy made of it: the new setting holds the
  // value migrate.js gave it, not its default.
  assert.deepEqual(plan.changes, [
    { change: 'migrated', path: '/accent', from: '#123456', to: undefined },
    { change: 'migrated', path: '/colour', from: undefined, to: '#123456' },
    { change: 'added', path: '/colour', to: '#123456', saved: true },
  ]);
  assert.deepEqual((await (await fetch(`${base}/snapshot`)).json()).state['overlay.settings'], { colour: '#123456', size: 2 });
  // A migrate.js that never returns fails the upgrade, and the overlay stays where it was.
  await assert.rejects(platform.overlays.upgrade('main', '1.3.0', { runMigrate: true }), { name: 'MigrateError' });
  assert.equal(platform.overlays.resolve('main').doc.data.template.version, '1.2.0');
});

test('a value migrate.js rewrites shows in the plan, and keeps the upgrade from needing a confirmation', async (t) => {
  const seconds = { type: 'object', properties: { hold: { type: 'integer', minimum: 1, maximum: 60, default: 5 } } };
  const ms = { type: 'object', properties: { hold: { type: 'integer', minimum: 1000, maximum: 60000, default: 5000 } } };
  const migrate = 'function migrate(from, s) { if (typeof s.hold === "number" && s.hold < 1000) s.hold = s.hold * 1000; return s; }';
  const { platform, base } = await setup(t, { settings: { hold: 8 }, install: [v('1.0.0', seconds), v('1.1.0', ms, { files: { 'migrate.js': migrate } })] });
  // Without migrate.js, 8 doesn't fit and falls back to the default.
  const skipped = await platform.overlays.upgrade('main', '1.1.0', { dryRun: true });
  assert.deepEqual(skipped.changes, [{ change: 'invalid', path: '/hold', from: 8, to: 5000 }]);
  assert.equal(skipped.confirm, true);
  const plan = await platform.overlays.upgrade('main', '1.1.0', { runMigrate: true });
  assert.deepEqual(plan.changes, [{ change: 'migrated', path: '/hold', from: 8, to: 8000 }]);
  assert.equal(plan.confirm, false);
  assert.deepEqual((await snapshot(base)).state['overlay.settings'], { hold: 8000 });
});

test('an edit saved while an upgrade is under way is never lost', async (t) => {
  const renamed = { type: 'object', properties: { colour: { type: 'string', format: 'color' } } };
  const migrate = 'function migrate(from, s) { if (s.accent) { s.colour = s.accent; delete s.accent; } return s; }';
  const { platform, overlay, base } = await setup(t, { settings: { accent: '#123456' }, install: [v('1.0.0', settingsV1), v('1.2.0', renamed, { files: { 'migrate.js': migrate } })] });
  // Saved once the upgrade has started, before it saves.
  const upgrading = platform.overlays.upgrade('main', '1.2.0', { runMigrate: true }).catch((err) => err);
  const edited = platform.overlays.updateSettings('main', { accent: '#654321' });
  const outcome = await upgrading;
  const doc = platform.store.get('overlays', overlay.id);
  // An upgrade that read the overlay before the edit is a conflict; one that read it after
  // carries the edit over. It never saves what it made of the settings before the edit.
  if (outcome instanceof Error) {
    assert.equal(outcome.name, 'ConflictError');
    assert.equal(doc.rev, edited.rev);
    assert.deepEqual(doc.data.template, { id: ID, version: '1.0.0' });
    assert.deepEqual(doc.data.settings, { accent: '#654321' });
    assert.deepEqual((await snapshot(base)).state['overlay.settings'], { accent: '#654321', size: 2 });
  } else {
    assert.deepEqual(doc.data.template, { id: ID, version: '1.2.0' });
    assert.deepEqual(doc.data.settings, { colour: '#654321' });
    assert.deepEqual((await snapshot(base)).state['overlay.settings'], { colour: '#654321' });
  }
});

test('settings migrate.js returns that an overlay can\'t save are refused, by a dry run too', async (t) => {
  const listed = { type: 'object', properties: { names: { type: 'array', items: { type: 'string' } } } };
  // About 40 KB: over the 24 KiB an overlay may save. The second is over the 64 Ki characters
  // migrate.js may return at all.
  const names = (n) => `function migrate(from, s) { s.names = []; for (var i = 0; i < ${n}; i++) s.names.push("name-number-" + (10000 + i)); return s; }`;
  const { platform, overlay } = await setup(t, {
    settings: {},
    install: [v('1.0.0', listed), v('1.1.0', listed, { files: { 'migrate.js': names(2000) } }), v('1.2.0', listed, { files: { 'migrate.js': names(4000) } })],
  });
  const refused = (err) => err.code === 'bad-settings' && /limited to 24 KiB/.test(err.message) && err.detail.migrated === true;
  await assert.rejects(platform.overlays.upgrade('main', '1.1.0', { runMigrate: true, dryRun: true }), refused);
  await assert.rejects(platform.overlays.upgrade('main', '1.1.0', { runMigrate: true, confirm: true }), refused);
  await assert.rejects(platform.overlays.upgrade('main', '1.2.0', { runMigrate: true, dryRun: true }), { name: 'MigrateError', message: /more settings than an overlay can save/ });
  const doc = platform.store.get('overlays', overlay.id);
  assert.equal(doc.rev, overlay.rev);
  assert.deepEqual(doc.data.template, { id: ID, version: '1.0.0' });
  assert.deepEqual(doc.data.settings, {});
});

// A platform whose templates ship with it: dev.skp.shipped 1.0.0, and 1.1.0 whose migrate.js
// renames "accent" to "colour"; an overlay "main" on 1.0.0.
async function withShipped(t) {
  const shipped = tempDir(t);
  const manifest = JSON.parse(readFileSync(path.join(DIAG_DIR, 'template.json'), 'utf8'));
  const bundle = (name, fields, files = {}) => {
    const dir = path.join(shipped, name);
    cpSync(DIAG_DIR, dir, { recursive: true });
    writeFileSync(path.join(dir, 'template.json'), JSON.stringify({ ...manifest, id: 'dev.skp.shipped', ...fields }));
    for (const [file, content] of Object.entries(files)) writeFileSync(path.join(dir, file), content);
  };
  bundle('one', { version: '1.0.0', settings: { type: 'object', properties: { accent: { type: 'string' } } } });
  bundle('two', { version: '1.1.0', settings: { type: 'object', properties: { colour: { type: 'string' } } } }, {
    'migrate.js': 'function migrate(from, s) { if (s.accent) { s.colour = s.accent; delete s.accent; } return s; }',
  });
  const root = tempDir(t);
  const config = loadConfig({ argv: ['--port', '0'], env: { SKP_DATA_DIR: path.join(root, 'data'), SKP_CONFIG_DIR: path.join(root, 'config') } });
  const platform = await start(t, config, [shipped]);
  assert.equal(platform.templates.fromPlatform(platform.templates.get('dev.skp.shipped', '1.1.0')), true);
  platform.overlays.create({ slug: 'main', template: { id: 'dev.skp.shipped', version: '1.0.0' }, settings: { accent: '#123456' } });
  return platform;
}

test('migrate.js from a template that comes with the platform runs on upgrade without being asked', async (t) => {
  const platform = await withShipped(t);
  assert.equal((await platform.overlays.upgrade('main', '1.1.0', { dryRun: true })).migrated, true);
  const plan = await platform.overlays.upgrade('main', '1.1.0');
  assert.equal(plan.migrated, true);
  assert.deepEqual(plan.settings, { colour: '#123456' });
  assert.deepEqual(platform.overlays.resolve('main').doc.data.settings, { colour: '#123456' });
});

test('over the API too: an upgrade that leaves runMigrate out runs a shipped template\'s migrate.js; runMigrate: false skips it', async (t) => {
  const platform = await withShipped(t);
  const upgrade = async (body) => {
    const res = await fetch(`${platform.url}/api/v1/overlays/main/upgrade`, { method: 'POST', headers: signedIn(platform, { 'content-type': 'application/json' }), body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const skipped = await upgrade({ version: '1.1.0', dryRun: true, runMigrate: false });
  assert.equal(skipped.status, 200);
  assert.equal(skipped.body.migrated, 'skipped', 'the operator said not to');
  assert.deepEqual(skipped.body.changes.map((c) => `${c.change} ${c.path}`), ['removed /accent', 'added /colour']);
  const done = await upgrade({ version: '1.1.0' });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.migrated, true);
  assert.deepEqual(done.body.overlay.settings, { colour: '#123456' });
  assert.deepEqual(platform.audit.list({ action: 'overlay.upgrade' }).items.map((e) => e.details.migrated), [true]);
});

test('what counts as a major upgrade', async () => {
  const { isMajor } = await import('../src/overlays/registry.js');
  assert.equal(isMajor('1.4.0', '2.0.0'), true);
  assert.equal(isMajor('1.4.0', '1.9.3'), false);
  assert.equal(isMajor('0.3.0', '0.4.0'), true, 'under 1.0.0 a minor version can break things');
  assert.equal(isMajor('0.3.0', '0.3.9'), false);
  assert.equal(isMajor('1.0.0-rc.1', '1.0.0'), true, 'a prerelease promises nothing');
});

test('upgrading the NAS: a CTD Relay connection paired for every profile that followed the default one follows every profile, with nobody doing anything; its TAKEOVER bound to every connection keeps working', { timeout: 60000 }, async (t) => {
  const ms = await startFakeMultistream();
  defer(t, () => ms.close());
  const root = tempDir(t);
  const config = loadConfig({ argv: ['--port', '0'], env: { SKP_DATA_DIR: path.join(root, 'data'), SKP_CONFIG_DIR: path.join(root, 'config') } });
  // Before: the token reads every profile, the setting names the default one, the connection is
  // named after it, a cursor kept from that profile's stream, one overlay fed by everything.
  const before = await start(t, config);
  const token = ms.addToken({ profileId: null });
  const made = before.connectors.create({ connector: 'ctd-multistream', config: { baseUrl: `${ms.url}/api/v1`, profile: 'default' }, secrets: { token } });
  before.overlays.create({ slug: 'takeover', template: { id: 'com.dprtmnt.takeover', version: '1.0.0' }, settings: {}, connections: 'all' });
  const was = () => before.connectors.get(made.id);
  await until(() => ['connected', 'degraded'].includes(was().health.status) && was().name === 'Relay · Miami or Bust', 8000, 'following the default profile');
  ms.emit('chat.message', { id: 'twitch:x1', platform: 'twitch', destinationId: 'd-tw', user: { id: 'twitch:1', name: 'Fan', roles: [] }, text: 'hi', fragments: [{ type: 'text', text: 'hi' }], kind: 'message', ts: Date.now() }, { platform: 'twitch', destination: 'd-tw' });
  await until(() => before.connectors.runnerOf(made.id).memory.data.cursor, 5000, 'a cursor kept');
  before.connectors.runnerOf(made.id).flushMemory();
  assert.ok(before.store.get('connection_state', made.id).data.memory.cursor);
  before.store.transaction((tx) => tx.setMeta('schemaVersion', 2)); // as the version before this one left it
  await before.stop();

  // After: every profile, each its own stream; the overlay on "all" sees both.
  const n = ms.requests.length;
  const after = await start(t, config);
  const conn = () => after.connectors.get(made.id);
  await until(() => ['connected', 'degraded'].includes(conn().health.status) && conn().info?.everyProfile === true, 8000, 'following every profile');
  assert.equal(after.store.schemaVersion, 3);
  assert.equal(after.store.get('connections', made.id).data.config.profile, undefined);
  assert.deepEqual(conn().info.profiles.map((p) => p.name), ['Miami or Bust', 'DPRTMNT']);
  assert.equal(conn().name, 'Relay', 'the name it was given by its profile follows');
  const events = ms.requests.slice(n).filter((r) => r.path === '/api/v1/events');
  assert.equal(events[0].query.profile, '*');
  assert.equal(events[0].headers['last-event-id'], undefined, 'the one profile\'s cursor isn\'t resumed from');
  assert.deepEqual(new Set(ms.requests.slice(n).filter((r) => r.path === '/api/v1/chat').map((r) => r.query.profile)), new Set(['default', 'p-dprtmnt']));
  const takeover = after.overlays.resolve('takeover').channel;
  assert.equal(takeover.snapshot().state['viewers.total'], 244);
  ms.emit('destination.status', { ...ms.statuses['p-dprtmnt'].destinations[0], live: true, viewers: 50 }, { platform: 'kick', destination: 'd2-kk', profile: 'p-dprtmnt' });
  await until(() => takeover.snapshot().state['viewers.total'] === 294, 5000, 'both profiles\' viewers');
  const stream = (await (await fetch(`${after.url}/api/v1/overlays/takeover`, { headers: signedIn(after) })).json()).stream;
  assert.deepEqual(stream.profiles.map((p) => [p.name, p.status]), [['Miami or Bust', 'live'], ['DPRTMNT', 'offline']]);
});
