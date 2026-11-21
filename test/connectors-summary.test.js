// The overlay summary for CTD Relay (its docs/API.md §9.5) and the OBS plugin's CTD Overlays dock:
// update kinds (patch/minor go by themselves, major waits), versions from release tags, release
// notes trimmed to plain lines, what an overlay waits for, nothing secret in it, and the hub
// sending it after a registration, only when it changed, and not to a CTD Relay without the route.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { startPlatform } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { buildSummary, cleanUi, SUMMARY_SCHEMA, trimNotes, updateKind, versionOfTag } from '../src/connectors/summary.js';
import { fitSummary } from '../src/connectors/defs/ctd-multistream-hub.js';
import { until } from './connector-helpers.js';
import { startFakeMultistream } from './fixtures/fake-multistream.mjs';
import { defer, FIXTURE_TEMPLATES, memoryLogger, signedIn, tempDir } from './helpers.js';

test('update kinds: patch and minor move by themselves, major (and 0.x minor, pre-releases) wait', () => {
  assert.equal(updateKind('1.2.3', '1.2.4'), 'patch');
  assert.equal(updateKind('1.2.3', '1.3.0'), 'minor');
  assert.equal(updateKind('1.2.3', '2.0.0'), 'major');
  assert.equal(updateKind('0.2.0', '0.3.0'), 'major', 'before 1.0.0 a minor bump is major');
  assert.equal(updateKind('0.2.0', '0.2.1'), 'patch');
  assert.equal(updateKind('1.0.0', '1.1.0-beta.1'), 'major', 'a pre-release waits');
  assert.equal(updateKind('1.3.0', '1.3.0'), 'none');
  assert.equal(updateKind('1.3.0', '1.2.0'), 'none', 'never backwards');
  assert.equal(updateKind('1.10.0', '1.9.0'), 'none', 'numeric, not text');
  assert.equal(updateKind('latest', '1.0.0'), 'none');
});

test('a release tag\'s version', () => {
  assert.equal(versionOfTag('v1.3.0'), '1.3.0');
  assert.equal(versionOfTag('overlay-v2.0.0-rc.1'), '2.0.0-rc.1');
  assert.equal(versionOfTag('1.0.0'), '1.0.0');
  assert.equal(versionOfTag('nightly'), undefined);
});

test('release notes: plain lines, no links, images, HTML or code; at most 8 of 200 characters', () => {
  const md = [
    '## What\'s changed',
    '',
    '- **New:** a darker style ([#12](https://github.com/o/r/pull/12))',
    '* Fix: long names wrap <br>',
    '![shot](https://example.com/x.png)',
    '```js',
    'secret();',
    '```',
    '1. Settings: `accent` colour',
    '> quoted line',
    '---',
    `- ${'x'.repeat(300)}`,
    '**Full Changelog**: https://github.com/o/r/compare/v1...v2',
  ].join('\n');
  const lines = trimNotes(md);
  assert.deepEqual(lines.slice(0, 5), ['What\'s changed', 'New: a darker style (#12)', 'Fix: long names wrap', 'Settings: accent colour', 'quoted line']);
  assert.equal(lines[5].length, 200);
  assert.ok(lines[5].endsWith('…'));
  assert.equal(lines.length, 6, 'the empty, image, code, rule and changelog lines are gone');
  assert.ok(!lines.join(' ').includes('http'));
  assert.equal(trimNotes(Array.from({ length: 20 }, (_, i) => `- line ${i}`).join('\n')).length, 8);
  assert.deepEqual(trimNotes(undefined), []);
});

test('the admin UI address: origin only, http(s) only', () => {
  assert.equal(cleanUi('http://user:pw@overlay.test:4848/some/path?x=1#y'), 'http://overlay.test:4848');
  assert.equal(cleanUi('file:///etc/passwd'), null);
  assert.equal(cleanUi(undefined), null);
});

// A template registry with these versions installed: [[id, version, name]].
const registry = (list) => {
  const all = list.map(([id, version, name]) => ({ id, version, manifest: { name } }));
  return { list: () => all, versions: (id) => all.filter((t) => t.id === id) };
};
const overlay = (id, slug, tid, version, extra = {}) => ({ id, data: { slug, template: { id: tid, version }, key: 'ENCRYPTED-KEY', settings: { secretish: 'x' }, ...extra } });

test('the summary: versions per template, what waits for the operator and why, shows, notes; nothing else', () => {
  const templates = registry([
    ['com.ctd.lower', '1.2.0', 'Lower third'], ['com.ctd.lower', '1.3.0', 'Lower third'],
    ['com.ctd.bug', '1.4.0', 'Club bug'], ['com.ctd.bug', '2.0.0', 'Club bug'],
    ['com.ctd.manual', '1.0.0', 'By hand'], ['com.ctd.manual', '1.1.0', 'By hand'],
    ['com.ctd.unused', '0.1.0', 'Unused'],
  ]);
  const sources = [
    { id: 'src_1', data: { label: 'github:o/lower', kind: 'github', repo: 'o/lower', templateId: 'com.ctd.lower', version: '1.3.0', release: 'v1.3.0', autoUpgrade: 'safe', checkedAt: '2026-11-21T10:00:00.000Z', notes: ['New: a darker style'], notesVersion: '1.3.0', etag: 'W/"abc"' } },
    { id: 'src_2', data: { label: 'github:o/bug', kind: 'github', repo: 'o/bug', templateId: 'com.ctd.bug', version: '2.0.0', release: 'v2.0.0', autoUpgrade: 'safe', error: { code: 'rate-limited', message: 'GitHub said no to token ghp_SECRET', at: 'x' } } },
  ];
  const overlays = [
    overlay('ovl_a', 'lower', 'com.ctd.lower', '1.2.0'),
    overlay('ovl_b', 'club-bug', 'com.ctd.bug', '1.4.0'),
    overlay('ovl_c', 'by-hand', 'com.ctd.manual', '1.0.0'),
  ];
  const s = buildSummary({ templates, sources, overlays, shows: [{ name: 'Miami Or Bust', overlays: ['ovl_a'] }], ui: 'http://overlay.test:4848/', serverVersion: '0.4.0' });
  assert.equal(s.schema, SUMMARY_SCHEMA);
  assert.deepEqual(s.server, { name: 'CTD Overlay', version: '0.4.0' });
  assert.equal(s.ui, 'http://overlay.test:4848');
  const t = Object.fromEntries(s.templates.map((x) => [x.id, x]));
  assert.deepEqual(t['com.ctd.lower'], { id: 'com.ctd.lower', name: 'Lower third', installed: '1.3.0', oldestInUse: '1.2.0', source: { kind: 'github', repo: 'o/lower' }, latest: '1.3.0', auto: true, checkedAt: '2026-11-21T10:00:00.000Z', notes: [{ version: '1.3.0', text: 'New: a darker style' }], update: 'minor' });
  assert.equal(t['com.ctd.bug'].update, 'major');
  assert.equal(t['com.ctd.bug'].problem, 'rate-limited', 'a code, never the message');
  assert.deepEqual(t['com.ctd.manual'].source, { kind: 'none' });
  const multi = buildSummary({ templates: registry([['com.dprtmnt.tn', '1.0.0', 'TN']]), sources: [{ id: 'src_9', data: { kind: 'github', repo: 'ItsLimitlezz/DPRTMNT-stream-Kit', tagPrefix: 'tn-v', templateId: 'com.dprtmnt.tn', version: '1.0.0', release: 'tn-v1.0.0' } }, { id: 'src_8', data: { kind: 'github', repo: 'o/r', tagPrefix: 'bad prefix', templateId: 'x' } }] });
  assert.deepEqual(multi.templates[0].source, { kind: 'github', repo: 'ItsLimitlezz/DPRTMNT-stream-Kit', tagPrefix: 'tn-v' }, 'one repository, one template per tag prefix');
  const pinnedToo = buildSummary({ templates: registry([['com.dprtmnt.show', '1.3.0', 'Takeover - DPRTMNT']]), sources: [
    { id: 'src_6', data: { kind: 'github', repo: 'ItsLimitlezz/DPRTMNT-stream-Kit', tagPrefix: 'takeover-v', templateId: 'com.dprtmnt.show', version: '1.3.0', release: 'takeover-v1.3.0', autoUpgrade: 'safe' } },
    { id: 'src_7', data: { kind: 'github', repo: 'ItsLimitlezz/DPRTMNT-stream-Kit', tag: 'takeover-v1.2.0', templateId: 'com.dprtmnt.show', version: '1.2.0', release: 'takeover-v1.2.0', autoUpgrade: 'safe' } },
  ] });
  assert.deepEqual(pinnedToo.templates[0].source, { kind: 'github', repo: 'ItsLimitlezz/DPRTMNT-stream-Kit', tagPrefix: 'takeover-v' }, 'a pinned release beside the followed source: the followed one says what comes next');
  assert.equal(pinnedToo.templates[0].latest, '1.3.0');
  assert.equal(t['com.ctd.manual'].update, 'minor');
  assert.equal(t['com.ctd.unused'].update, 'none');
  const o = Object.fromEntries(s.overlays.map((x) => [x.slug, x]));
  assert.deepEqual(o.lower, { id: 'ovl_a', slug: 'lower', template: { id: 'com.ctd.lower', name: 'Lower third', version: '1.2.0' }, show: 'Miami Or Bust' }, 'a minor update with a source moves by itself: not waiting');
  assert.deepEqual(o['club-bug'].waiting, { to: '2.0.0', major: true, why: 'a major version' });
  assert.equal(o['club-bug'].show, null);
  assert.deepEqual(o['by-hand'].waiting, { to: '1.1.0', major: false, why: 'installed by hand: upgrade it in CTD Overlay' });
  const text = JSON.stringify(s);
  for (const secret of ['ENCRYPTED-KEY', 'secretish', 'ghp_SECRET', 'W/"abc"', 'GitHub said']) assert.ok(!text.includes(secret), secret);
});

test('a release that failed to install still counts as the latest; automatic upgrades off make a minor wait', () => {
  const templates = registry([['com.ctd.lower', '1.2.0', 'Lower'], ['com.ctd.lower', '1.2.1', 'Lower']]);
  const sources = [{ id: 'src_1', data: { kind: 'github', repo: 'o/lower', templateId: 'com.ctd.lower', version: '1.2.1', release: 'v1.2.1', autoUpgrade: 'off', failed: { release: 'v1.3.0' }, error: { code: 'invalid', message: 'x' } } }];
  const s = buildSummary({ templates, sources, overlays: [overlay('ovl_a', 'lower', 'com.ctd.lower', '1.2.0')] });
  assert.equal(s.templates[0].latest, '1.3.0');
  assert.equal(s.templates[0].installed, '1.2.1');
  assert.equal(s.templates[0].update, 'minor');
  assert.equal(s.templates[0].auto, false);
  assert.deepEqual(s.overlays[0].waiting, { to: '1.2.1', major: false, why: 'automatic upgrades are off' });
  assert.equal(s.ui, null);
});

test('a summary past 60 KB loses its notes first, then overlays and templates', () => {
  const big = { schema: SUMMARY_SCHEMA, server: { version: '1.0.0' }, ui: null, templates: Array.from({ length: 150 }, (_, i) => ({ id: `t${i}`, name: 'n', installed: '1.0.0', notes: [{ version: '1.0.0', text: Array(8).fill('x'.repeat(200)).join('\n') }] })), overlays: [] };
  const fit = fitSummary(big);
  assert.ok(Buffer.byteLength(JSON.stringify(fit)) <= 60 * 1024);
  assert.equal(fit.templates.length, 150, 'every template kept');
  assert.ok(fit.templates.every((t) => !t.notes));
  const huge = { ...big, templates: Array.from({ length: 2000 }, (_, i) => ({ id: `t${i}`.padEnd(90, 'x'), name: 'n'.repeat(100), installed: '1.0.0' })) };
  assert.ok(Buffer.byteLength(JSON.stringify(fitSummary(huge))) <= 60 * 1024);
});

const TAKEOVER = { id: 'com.dprtmnt.takeover', version: '1.1.0' };

async function start(t, msOptions) {
  const ms = await startFakeMultistream(msOptions);
  defer(t, () => ms.close());
  const root = tempDir(t);
  const config = loadConfig({ argv: ['--port', '0'], env: { SKP_DATA_DIR: path.join(root, 'data'), SKP_CONFIG_DIR: path.join(root, 'config'), SKP_EXPOSURE: 'lan', SKP_HOST: '127.0.0.1', SKP_HOSTS: '192.168.1.50:4850' } });
  const { log } = memoryLogger();
  const platform = await startPlatform(config, { log, templateDirs: [FIXTURE_TEMPLATES], connectors: { random: () => 0.5 } });
  defer(t, () => platform.stop());
  const H = signedIn(platform, { 'content-type': 'application/json' });
  const connect = async (token) => {
    const r = await fetch(`${platform.url}/api/v1/connections`, { method: 'POST', headers: H, body: JSON.stringify({ connector: 'ctd-multistream', config: { baseUrl: `${ms.url}/api/v1` }, secrets: { token } }) });
    assert.equal(r.status, 201);
    return r.json();
  };
  return { ms, platform, connect };
}

test('the hub sends the summary after registering, without keys, and again only when it changes', { timeout: 60000 }, async (t) => {
  const { ms, platform, connect } = await start(t);
  const conn = await connect(ms.addToken({ profileId: 'p-dprtmnt' }));
  platform.overlays.create({ slug: 'takeover', template: TAKEOVER, settings: {}, connections: [conn.id] });
  await until(() => ms.summaries.some((x) => x.body.overlays.length === 1), 10000, 'a summary with the overlay');
  const { appId, body } = ms.summaries.at(-1);
  assert.equal(appId, 'ctd-overlay-dprtmnt');
  assert.equal(body.ui, 'http://192.168.1.50:4850');
  assert.match(body.server.version, /^\d+\.\d+\.\d+/);
  assert.deepEqual(body.overlays[0], { id: body.overlays[0].id, slug: 'takeover', template: { id: TAKEOVER.id, name: body.overlays[0].template.name, version: '1.1.0' }, show: null });
  assert.ok(body.templates.some((x) => x.id === TAKEOVER.id && x.installed === '1.1.0' && x.source.kind === 'none'));
  const key = platform.overlays.key('takeover');
  assert.ok(!JSON.stringify(ms.summaries).includes(key), 'never an overlay key');
  // Unchanged: not sent again with the next registration.
  const n = ms.summaries.length;
  const regs = ms.registrations.length;
  platform.overlays.rotateKey('takeover'); // registered again (new URL), summary unchanged
  await until(() => ms.registrations.length > regs, 5000, 'registered again');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(ms.summaries.length, n);
});

test('a CTD Relay without the summary route: registration goes on as before', { timeout: 60000 }, async (t) => {
  const { ms, platform, connect } = await start(t);
  ms.noSummaryRoute = true;
  const conn = await connect(ms.addToken({ profileId: 'p-dprtmnt' }));
  platform.overlays.create({ slug: 'takeover', template: TAKEOVER, settings: {}, connections: [conn.id] });
  await until(() => platform.connectors.get(conn.id).info?.hub?.status === 'shared' && ms.registrations.some((r) => r.body.resources.length === 2), 10000, 'shared');
  assert.equal(ms.summaries.length, 0);
});
