// Several templates in one repository (04 §4.13): a repository is followed once per release tag
// prefix (show-v1.3.0, tn-v1.0.0), each source installing and updating only its own template; a
// source with no prefix beside them; sources stored before this rule; the 409s of the API and the
// command line. GitHub is the fake on 127.0.0.1 (fixtures/fake-github.mjs): no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { openData, startPlatform } from '../src/app.js';
import { run } from '../src/cli.js';
import { loadConfig } from '../src/config.js';
import { openStore } from '../src/store/index.js';
import { fetchPackage, parseSourceRef } from '../src/templates/sources.js';
import { startFakeGithub } from './fixtures/fake-github.mjs';
import { auditOf, defer, DIAG_DIR, memoryLogger, packTemplate, signedIn, tempDir } from './helpers.js';

const KIT = 'ItsLimitlezz/DPRTMNT-stream-Kit';
const SHOW = 'com.dprtmnt.show';
const TN = 'com.dprtmnt.tn';
const LEGACY = 'com.dprtmnt.legacy';
const pkg = (id, version) => packTemplate(DIAG_DIR, { manifest: { id, name: id, version } });
// A release as the repository's workflow makes it: <name>-<version>.skp attached.
const show = (version, extra = []) => [`show-v${version}`, { assets: [...extra, { name: `dprtmnt-show-${version}.skp`, data: pkg(SHOW, version) }] }];
const tn = (version) => [`tn-v${version}`, { assets: [{ name: `dprtmnt-tn-${version}.skp`, data: pkg(TN, version) }] }];

async function fakeGithub(t) {
  const gh = await startFakeGithub();
  defer(t, () => gh.close());
  gh.repo(KIT);
  return gh;
}

function dirs(t, argv = []) {
  const root = tempDir(t);
  const env = { SKP_DATA_DIR: path.join(root, 'data'), SKP_CONFIG_DIR: path.join(root, 'config') };
  return { env, config: loadConfig({ argv, env }) };
}

function data(t, config, gh) {
  const { log, entries } = memoryLogger();
  const d = openData(config, { log, fetch: gh.fetch, lookup: gh.lookup });
  defer(t, () => d.close());
  return { ...d, entries };
}

const downloads = (gh, from = 0) => gh.requests.slice(from).filter((q) => q.host === 'objects.githubusercontent.com');

test('a source names a tag prefix after "#": owner/name#show-v, owner/name# for none; a pinned tag or a URL keeps its "#"', () => {
  assert.deepEqual(parseSourceRef(`${KIT}#show-v`), { source: { kind: 'github', repo: KIT }, tagPrefix: 'show-v' });
  assert.deepEqual(parseSourceRef(`github:${KIT}#`), { source: { kind: 'github', repo: KIT }, tagPrefix: '' });
  assert.deepEqual(parseSourceRef(KIT), { source: { kind: 'github', repo: KIT } });
  assert.deepEqual(parseSourceRef(`${KIT}@build#7`), { source: { kind: 'github', repo: KIT, tag: 'build#7' } });
  assert.deepEqual(parseSourceRef('https://example.com/pkg.skp#x'), { source: { kind: 'url', url: 'https://example.com/pkg.skp#x' } });
  assert.throws(() => parseSourceRef(`${KIT}#show v`), { code: 'bad-source' });
});

test('one repository, two templates: each source installs only its own, and updates on its own', async (t) => {
  const gh = await fakeGithub(t);
  gh.release(KIT, ...show('1.0.0'));
  gh.release(KIT, ...tn('1.0.0'));
  const { config } = dirs(t);
  const d = data(t, config, gh);
  const s = d.sources.add(KIT, { tagPrefix: 'show-v' });
  const n = d.sources.add(`${KIT}#tn-v`);
  assert.deepEqual([s.data.label, n.data.label], [`github:${KIT}#show-v`, `github:${KIT}#tn-v`]);
  assert.deepEqual([s.data.tagPrefix, n.data.tagPrefix], ['show-v', 'tn-v']);

  let results = await d.sources.check();
  assert.deepEqual(results.map((r) => [r.source, r.tag, r.installed?.id, r.installed?.version, r.error?.code]), [
    [`github:${KIT}#show-v`, 'show-v1.0.0', SHOW, '1.0.0', undefined],
    [`github:${KIT}#tn-v`, 'tn-v1.0.0', TN, '1.0.0', undefined],
  ]);
  assert.deepEqual([d.sources.get(`${KIT}#show-v`).data.assetPattern, d.sources.get(`${KIT}#tn-v`).data.assetPattern], ['dprtmnt-show-*.skp', 'dprtmnt-tn-*.skp']);
  d.overlays.create({ slug: 'main', template: { id: SHOW, version: '1.0.0' }, settings: {} });
  d.overlays.create({ slug: 'special', template: { id: TN, version: '1.0.0' }, settings: {} });

  // The show's next release (the repository's newest): the show's source alone installs it.
  gh.release(KIT, ...show('1.1.0'));
  results = await d.sources.check(undefined, { force: true });
  assert.deepEqual(results.map((r) => [r.tag, r.installed?.version, r.upgraded.map((u) => u.overlay), r.error?.code]), [
    ['show-v1.1.0', '1.1.0', ['main'], undefined],
    ['tn-v1.0.0', '1.0.0', [], undefined],
  ]);
  assert.equal(d.templates.get(TN, '1.1.0'), undefined);
  // The special's: the other way round.
  gh.release(KIT, ...tn('1.1.0'));
  results = await d.sources.check();
  assert.deepEqual(results.map((r) => [r.tag, r.unchanged ?? false, r.installed?.version, r.upgraded.map((u) => u.overlay)]), [
    ['show-v1.1.0', true, undefined, []],
    ['tn-v1.1.0', false, '1.1.0', ['special']],
  ]);
  assert.deepEqual([d.overlays.resolve('main').doc.data.template, d.overlays.resolve('special').doc.data.template], [{ id: SHOW, version: '1.1.0' }, { id: TN, version: '1.1.0' }]);

  // One source, one template: a show release that carries the special is refused.
  gh.release(KIT, 'show-v1.2.0', { assets: [{ name: 'dprtmnt-show-1.2.0.skp', data: pkg(TN, '1.2.0') }] });
  const [wrong] = await d.sources.check(`${KIT}#show-v`);
  assert.equal(wrong.error.code, 'wrong-template');
  assert.equal(d.templates.get(TN, '1.2.0'), undefined);

  // owner/name alone is ambiguous while it is followed twice, and says how to name each.
  assert.throws(() => d.sources.get(KIT), (err) => err.code === 'ambiguous' && err.message.includes(`${KIT}#show-v or ${KIT}#tn-v`));
  await assert.rejects(d.sources.check(KIT), { code: 'ambiguous' });
  assert.throws(() => d.sources.remove(KIT), { code: 'ambiguous' });
  assert.equal(d.sources.get(`github:${KIT}#tn-v`).id, n.id);
  assert.equal(d.sources.get(s.id).id, s.id);
  assert.equal(d.sources.get(`${KIT}#nope-v`), undefined);
  d.sources.remove(`${KIT}#show-v`);
  assert.equal(d.sources.get(KIT).id, n.id, 'followed once again: owner/name names it');
});

test('a file is picked per prefix: the one named like what its source installed, learnt or found among what is installed', async (t) => {
  const gh = await fakeGithub(t);
  gh.release(KIT, ...tn('1.0.0'));
  gh.release(KIT, ...show('2.0.0'));
  const { config } = dirs(t);
  const d = data(t, config, gh);
  // Both installed by hand, the show's version the newest.
  for (const tag of ['tn-v1.0.0', 'show-v2.0.0']) {
    const got = await fetchPackage(`${KIT}@${tag}`, { dir: d.templates.downloadDir, fetch: gh.fetch, lookup: gh.lookup });
    d.templates.install(got.file, { name: got.label, origin: got.origin });
  }
  // Followed for the special: its own file's name, not the newest version's (the show's).
  const special = d.sources.add(KIT, { tagPrefix: 'tn-v' });
  assert.equal(special.data.assetPattern, 'dprtmnt-tn-*.skp');
  // Followed again with no prefix: what no other source follows is the show, so its prefix.
  const main = d.sources.add(KIT);
  assert.deepEqual([main.data.tagPrefix, main.data.assetPattern, main.data.label], ['show-v', 'dprtmnt-show-*.skp', `github:${KIT}#show-v`]);
  assert.throws(() => d.sources.add(KIT, { claim: SHOW }), { code: 'exists' }, 'the show is followed now, with its prefix');

  // A release with another package beside the show's (sorted first): the show's is taken.
  gh.release(KIT, ...show('2.1.0', [{ name: 'a-preview-2.1.0.skp', data: 'not a package' }]));
  gh.release(KIT, ...tn('1.1.0'));
  const results = await d.sources.check();
  assert.deepEqual(results.map((r) => [r.tag, r.installed?.id, r.installed?.version, r.error?.message]), [
    ['tn-v1.1.0', TN, '1.1.0', undefined],
    ['show-v2.1.0', SHOW, '2.1.0', undefined],
  ]);
  assert.equal(d.templates.get(SHOW, '2.1.0').receipt.source.asset, 'dprtmnt-show-2.1.0.skp');
  // A claim picks the template's own prefix and file too.
  d.sources.remove(`${KIT}#tn-v`);
  const claimed = d.sources.add(KIT, { claim: TN });
  assert.deepEqual([claimed.data.tagPrefix, claimed.data.assetPattern], ['tn-v', 'dprtmnt-tn-*.skp']);
});

test('a source with no prefix beside them takes only the releases no prefix takes, and warns while there are two prefixes', async (t) => {
  const gh = await fakeGithub(t);
  gh.release(KIT, 'v1.0.0', { assets: [{ name: 'legacy-1.0.0.skp', data: pkg(LEGACY, '1.0.0') }] });
  const { config } = dirs(t);
  const d = data(t, config, gh);
  const plain = d.sources.add(KIT);
  let [r] = await d.sources.check();
  assert.deepEqual([r.installed.id, plain.data.tagPrefix], [LEGACY, undefined], 'a bare v is no prefix');

  // The special is released, the newest; the plain source takes it and refuses it for good.
  gh.release(KIT, ...tn('1.0.0'));
  [r] = await d.sources.check();
  assert.equal(r.error.code, 'wrong-template');
  assert.equal(d.sources.get(KIT).data.failed.release, 'tn-v1.0.0');

  // The special followed with its prefix: it is that source's now, and the plain source's
  // failure clears at its next check, with nothing downloaded for it.
  const n = d.sources.add(KIT, { tagPrefix: 'tn-v' });
  assert.equal(d.sources.view(plain).warning, undefined, 'one prefix beside it: no warning');
  let before = gh.requests.length;
  let results = await d.sources.check();
  assert.deepEqual(results.map((x) => [x.id, x.tag, x.error?.code, x.unchanged ?? false]), [
    [plain.id, 'v1.0.0', undefined, true],
    [n.id, 'tn-v1.0.0', undefined, false],
  ]);
  assert.equal(downloads(gh, before).length, 1, 'only the special was downloaded');
  assert.deepEqual([d.sources.get(plain.id).data.failed, d.sources.get(plain.id).data.error], [undefined, undefined]);

  // The show too: two prefixes, so the plain source warns, and still takes only its own.
  d.sources.add(KIT, { tagPrefix: 'show-v' });
  gh.release(KIT, ...show('1.0.0'));
  gh.release(KIT, ...tn('1.1.0'));
  before = gh.requests.length;
  results = await d.sources.check();
  assert.deepEqual(results.map((x) => [x.tag, x.installed?.id ?? null, x.error?.code]), [
    ['v1.0.0', null, undefined],
    ['tn-v1.1.0', TN, undefined],
    ['show-v1.0.0', SHOW, undefined],
  ]);
  const warning = d.sources.view(d.sources.get(plain.id)).warning;
  assert.equal(warning.code, 'no-tag-prefix');
  assert.match(warning.message, /followed once per template, with the tag prefixes "tn-v", "show-v"; this source has none/);
  assert.equal(d.sources.view(n).warning, undefined);
  assert.equal(d.sources.view(n).tagPrefix, 'tn-v');
  assert.equal(d.sources.view(d.sources.get(plain.id)).tagPrefix, null);
  // Its own next release still installs.
  gh.release(KIT, 'v1.1.0', { assets: [{ name: 'legacy-1.1.0.skp', data: pkg(LEGACY, '1.1.0') }] });
  [r] = await d.sources.check(plain.id);
  assert.deepEqual([r.tag, r.installed?.version], ['v1.1.0', '1.1.0']);
});

test('with nothing of its own, a source with no prefix says so, and fails nothing for good', async (t) => {
  const gh = await fakeGithub(t);
  gh.release(KIT, ...show('1.0.0'));
  gh.release(KIT, ...tn('1.0.0'));
  const { config } = dirs(t);
  const d = data(t, config, gh);
  d.sources.add(KIT, { tagPrefix: 'show-v' });
  d.sources.add(KIT, { tagPrefix: 'tn-v' });
  const plain = d.sources.add(`${KIT}#`);
  assert.equal(plain.data.tagPrefix, undefined);
  const [, , r] = await d.sources.check();
  assert.equal(r.error.code, 'no-release');
  assert.match(r.error.message, /has no published release but those of the other sources that follow it \(tags starting with "show-v", "tn-v"\)/);
  assert.equal(d.sources.get(plain.id).data.failed, undefined);
  assert.equal(d.sources.get(`${KIT}#`).id, plain.id);
  // A longer prefix that starts a shorter one: its tags are its source's.
  const gh2 = 'ItsLimitlezz/nested';
  gh.release(gh2, 'show-vertical-v1.0.0', { assets: [{ name: 'vertical-1.0.0.skp', data: pkg('com.dprtmnt.vertical', '1.0.0') }] });
  const short = d.sources.add(gh2, { tagPrefix: 'show-v' });
  const long = d.sources.add(gh2, { tagPrefix: 'show-vertical-v' });
  const [a] = await d.sources.check(short.id);
  const [b] = await d.sources.check(long.id);
  assert.deepEqual([a.error?.code, b.installed?.id], ['no-release', 'com.dprtmnt.vertical']);
});

test('sources stored before a repository could be followed per prefix keep working: their names gain the prefix, nothing else changes', async (t) => {
  const gh = await fakeGithub(t);
  gh.release('a/sample', 'overlay-v1.0.0', { assets: [{ name: 'sample-1.0.0.zip', data: pkg('dev.skp.sample', '1.0.0') }] });
  const { config } = dirs(t);
  const old = {
    src_000000000000000000000001: { label: 'github:a/sample', kind: 'github', repo: 'a/sample', tagPrefix: 'overlay-v', assetPattern: 'sample-*.zip', autoUpgrade: 'safe', templateId: 'dev.skp.sample', version: '1.0.0', release: 'overlay-v1.0.0', etag: '"old"', addedAt: '2026-11-01T00:00:00.000Z', actor: 'cli' },
    src_000000000000000000000002: { label: 'github:b/plain', kind: 'github', repo: 'b/plain', autoUpgrade: 'off', addedAt: '2026-11-01T00:00:00.000Z', actor: 'cli' },
    src_000000000000000000000003: { label: 'github:c/pinned@v1.0.0', kind: 'github', repo: 'c/pinned', tag: 'v1.0.0', autoUpgrade: 'safe', addedAt: '2026-11-01T00:00:00.000Z', actor: 'cli' },
    src_000000000000000000000004: { label: 'https://example.com/t.skp', kind: 'url', url: 'https://example.com/t.skp', autoUpgrade: 'safe', addedAt: '2026-11-01T00:00:00.000Z', actor: 'cli' },
  };
  {
    mkdirSync(config.dataDir, { recursive: true });
    const store = openStore({ dataDir: config.dataDir, backend: config.store });
    for (const [id, record] of Object.entries(old)) store.put('template_sources', id, record);
    store.close();
  }
  const d = data(t, config, gh);
  const now = Object.fromEntries(d.sources.list().map((doc) => [doc.id, doc.data]));
  assert.deepEqual(now, { ...old, src_000000000000000000000001: { ...old.src_000000000000000000000001, label: 'github:a/sample#overlay-v' } });
  // Named as before, and checked as before: the release it has is no news, nothing downloaded.
  assert.equal(d.sources.get('a/sample').id, 'src_000000000000000000000001');
  assert.equal(d.sources.get('github:b/plain').id, 'src_000000000000000000000002');
  assert.equal(d.sources.get('c/pinned@v1.0.0').id, 'src_000000000000000000000003');
  const before = gh.requests.length;
  let [r] = await d.sources.check('a/sample');
  assert.deepEqual([r.source, r.tag, r.unchanged], ['github:a/sample#overlay-v', 'overlay-v1.0.0', true]);
  assert.equal(downloads(gh, before).length, 0);
  gh.release('a/sample', 'overlay-v1.1.0', { assets: [{ name: 'sample-1.1.0.zip', data: pkg('dev.skp.sample', '1.1.0') }] });
  [r] = await d.sources.check('a/sample');
  assert.deepEqual([r.tag, r.installed?.version], ['overlay-v1.1.0', '1.1.0']);
  // Following it again with its prefix is following it twice.
  assert.throws(() => d.sources.add('a/sample', { tagPrefix: 'overlay-v' }), { code: 'exists' });
  assert.throws(() => d.sources.add('b/plain'), { code: 'exists' });
  assert.throws(() => d.sources.add('c/pinned@v1.0.0'), { code: 'exists' });
  assert.throws(() => d.sources.add('c/pinned@v1.0.0', { tagPrefix: 'v' }), { code: 'bad-option' }, 'a pinned tag takes no prefix');
  assert.throws(() => d.sources.add('https://example.com/t.skp'), { code: 'exists' });
});

test('a prefix learnt from the first release is part of the name, and the repository can be followed again with another', async (t) => {
  const gh = await fakeGithub(t);
  gh.release(KIT, ...show('1.0.0'));
  const { config } = dirs(t);
  const d = data(t, config, gh);
  const first = d.sources.add(KIT);
  assert.equal(first.data.label, `github:${KIT}`);
  await d.sources.check();
  assert.deepEqual([d.sources.get(first.id).data.label, d.sources.get(first.id).data.tagPrefix], [`github:${KIT}#show-v`, 'show-v']);
  assert.throws(() => d.sources.add(KIT, { tagPrefix: 'show-v' }), (err) => err.code === 'exists' && /#show-v is already followed/.test(err.message));
  gh.release(KIT, ...tn('1.0.0'));
  const second = d.sources.add(KIT, { tagPrefix: 'tn-v' });
  const [, r] = await d.sources.check();
  assert.deepEqual([r.id, r.installed?.id], [second.id, TN]);
});

test('the API: a repository is followed once per prefix (409 for the same one again), lists each prefix and the warning, and takes owner/name#prefix', async (t) => {
  const gh = await fakeGithub(t);
  gh.release(KIT, ...show('1.0.0'));
  gh.release(KIT, ...tn('1.0.0'));
  const { config } = dirs(t, ['--port', '0']);
  const platform = await startPlatform(config, { log: memoryLogger().log, fetch: gh.fetch, lookup: gh.lookup, scrypt: { N: 1024 } });
  defer(t, () => platform.stop());
  const call = async (method, p, body) => {
    const res = await fetch(`${platform.url}/api/v1${p}`, { method, headers: { ...signedIn(platform), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const followShow = await call('POST', '/templates/sources', { source: KIT, tagPrefix: 'show-v' });
  assert.equal(followShow.status, 201, JSON.stringify(followShow.body));
  assert.deepEqual([followShow.body.label, followShow.body.tagPrefix, followShow.body.check.installed.id], [`github:${KIT}#show-v`, 'show-v', SHOW]);
  const again = await call('POST', '/templates/sources', { source: KIT, tagPrefix: 'show-v' });
  assert.deepEqual([again.status, again.body.type], [409, 'https://skp.dev/errors/exists']);
  assert.match(again.body.detail, /#show-v is already followed\. To follow another template released from/);
  assert.equal((await call('POST', '/templates/sources', { source: `${KIT.toLowerCase()}#show-v` })).status, 409, 'GitHub names are any case');
  const followTn = await call('POST', '/templates/sources', { source: KIT, tagPrefix: 'tn-v' });
  assert.equal(followTn.status, 201, JSON.stringify(followTn.body));
  assert.equal(followTn.body.check.installed.id, TN);
  assert.equal((await call('POST', '/templates/sources', { source: `${KIT}#tn-v` })).status, 409);
  assert.equal((await call('POST', '/templates/sources', { source: `${KIT}#tn-v`, tagPrefix: 'show-v' })).status, 422, 'two prefixes');
  assert.equal((await call('POST', '/templates/sources', { source: `${KIT}@show-v1.0.0`, tagPrefix: 'show-v' })).status, 422, 'a pinned tag takes no prefix');
  // No prefix: nothing installed from it is left for one, so it has none, and warns.
  const plain = await call('POST', '/templates/sources', { source: KIT, tagPrefix: '' });
  assert.equal(plain.status, 201, JSON.stringify(plain.body));
  assert.deepEqual([plain.body.tagPrefix, plain.body.warning?.code, plain.body.check.error?.code], [null, 'no-tag-prefix', 'no-release']);
  assert.equal((await call('POST', '/templates/sources', { source: KIT })).status, 409);

  const list = await call('GET', '/templates/sources');
  assert.deepEqual(list.body.items.map((s) => [s.label, s.tagPrefix, s.templateId ?? null, s.warning?.code ?? null]), [
    [`github:${KIT}#show-v`, 'show-v', SHOW, null],
    [`github:${KIT}#tn-v`, 'tn-v', TN, null],
    [`github:${KIT}`, null, null, 'no-tag-prefix'],
  ]);
  // Named by owner/name#prefix; owner/name alone is ambiguous.
  const checked = await call('POST', `/templates/sources/check?source=${encodeURIComponent(`${KIT}#tn-v`)}`, {});
  assert.deepEqual(checked.body.items.map((r) => r.source), [`github:${KIT}#tn-v`]);
  const ambiguous = await call('DELETE', `/templates/sources/${encodeURIComponent(KIT)}`);
  assert.deepEqual([ambiguous.status, ambiguous.body.type], [422, 'https://skp.dev/errors/ambiguous']);
  assert.match(ambiguous.body.detail, /is followed 3 times, once per tag prefix: name one, as \S+#show-v or \S+#tn-v or \S+# \(or by its id\)/);
  const gone = await call('DELETE', `/templates/sources/${encodeURIComponent(`${KIT}#`)}`);
  assert.deepEqual([gone.status, gone.body.label], [200, `github:${KIT}`]);
  const tnGone = await call('DELETE', `/templates/sources/${encodeURIComponent(`${KIT}#tn-v`)}`);
  assert.equal(tnGone.status, 200);
  assert.equal((await call('GET', '/templates/sources')).body.items.length, 1);
  assert.equal((await call('DELETE', `/templates/sources/${encodeURIComponent(KIT)}`)).status, 200, 'followed once: owner/name names it');
});

test('skp template follow --tag-prefix: once per prefix; sources shows each; update and unfollow take owner/name#prefix', async (t) => {
  const gh = await fakeGithub(t);
  gh.release(KIT, ...show('1.0.0'));
  gh.release(KIT, ...tn('1.0.0'));
  const { env, config } = dirs(t);
  const cli = async (...argv) => {
    let stdout = '';
    let stderr = '';
    const code = await run(argv, { stdout: { write: (s) => { stdout += s; } }, stderr: { write: (s) => { stderr += s; } }, env, fetch: gh.fetch, lookup: gh.lookup });
    return { code, stdout, stderr };
  };
  const a = await cli('template', 'follow', KIT, '--tag-prefix', 'show-v');
  assert.equal(a.code, 0, a.stderr);
  assert.match(a.stdout, new RegExp(`following github:${KIT}#show-v `));
  assert.match(a.stdout, /installed com\.dprtmnt\.show@1\.0\.0/);
  assert.match(a.stdout, new RegExp(`name it ${KIT}#show-v`));
  const twice = await cli('template', 'follow', KIT, '--tag-prefix', 'show-v');
  assert.equal(twice.code, 1);
  assert.match(twice.stderr, /#show-v is already followed/);
  const b = await cli('template', 'follow', KIT, '--tag-prefix', 'tn-v', '--json');
  assert.equal(b.code, 0, b.stderr);
  const followed = JSON.parse(b.stdout);
  assert.deepEqual([followed.source, followed.tagPrefix, followed.check.installed.id], [`github:${KIT}#tn-v`, 'tn-v', TN]);

  const listed = await cli('template', 'sources');
  assert.match(listed.stdout, new RegExp(`github:${KIT}#show-v  tag prefix "show-v"  com\\.dprtmnt\\.show@1\\.0\\.0 \\(release show-v1\\.0\\.0\\)`));
  assert.match(listed.stdout, new RegExp(`github:${KIT}#tn-v  tag prefix "tn-v"  com\\.dprtmnt\\.tn@1\\.0\\.0`));
  const rows = JSON.parse((await cli('template', 'sources', '--json')).stdout);
  assert.deepEqual(rows.map((r) => [r.source, r.repo, r.tagPrefix, r.template]), [[`github:${KIT}#show-v`, KIT, 'show-v', SHOW], [`github:${KIT}#tn-v`, KIT, 'tn-v', TN]]);

  const ambiguous = await cli('template', 'update', KIT);
  assert.equal(ambiguous.code, 1);
  assert.match(ambiguous.stderr, new RegExp(`is followed 2 times, once per tag prefix: name one, as ${KIT}#show-v or ${KIT}#tn-v`));
  gh.release(KIT, ...tn('1.1.0'));
  const one = await cli('template', 'update', `${KIT}#tn-v`);
  assert.equal(one.code, 0, one.stderr);
  assert.match(one.stdout, /installed com\.dprtmnt\.tn@1\.1\.0/);
  assert.doesNotMatch(one.stdout, /show-v/);
  assert.equal((await cli('template', 'unfollow', KIT)).code, 1);
  const off = await cli('template', 'unfollow', `${KIT}#show-v`);
  assert.equal(off.code, 0, off.stderr);
  assert.match(off.stdout, new RegExp(`stopped following github:${KIT}#show-v; the versions of com\\.dprtmnt\\.show it installed stay`));
  assert.equal((await cli('template', 'unfollow', KIT)).code, 0, 'followed once now');
  assert.deepEqual(auditOf(config).filter((e) => e.action === 'template.follow').map((e) => e.details.tagPrefix), ['show-v', 'tn-v']);
});
