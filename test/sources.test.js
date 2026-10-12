// Template sources (04 §4.13): installing a template from a GitHub release or an https URL, and
// following a source so new releases install, and safe upgrades apply, by themselves. GitHub is
// faked in memory, so nothing here touches the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { openData, startPlatform } from '../src/app.js';
import { run } from '../src/cli.js';
import { ConfigError, describeConfig, loadConfig } from '../src/config.js';
import { redactString } from '../src/log.js';
import { packageFromDir, packageFromZip } from '../src/templates/package.js';
import { validateTemplate } from '../src/templates/registry.js';
import { describeSource, fetchPackage, parseSource } from '../src/templates/sources.js';
import { bufferSource } from '../src/templates/zip.js';
import { defer, DIAG_DIR, memoryLogger, packTemplate, tempDir } from './helpers.js';

const ID = 'dev.skp.sample';
const SETTINGS = {
  type: 'object',
  properties: { accent: { type: 'string', format: 'color', default: '#16E0FF' }, size: { type: 'integer', default: 1 } },
};
// A version of the sample template: settings as given (SETTINGS unless changed), any id.
const pkg = (version, { id = ID, settings = SETTINGS, wrap } = {}) => packTemplate(DIAG_DIR, { manifest: { id, version, settings }, wrap });

// GitHub in memory: each repository's latest release, served as api.github.com serves it (JSON
// with an ETag, 304 for a matching If-None-Match, 404 for none, a rate limit on demand), with
// assets that redirect to a storage host, and a source zip under one top folder.
function fakeGithub() {
  const repos = new Map();
  const requests = [];
  let n = 0;
  let limited = false;
  const response = (status, body, headers = {}) => new Response(body ?? null, { status, headers });
  const json = (status, value, headers = {}) => response(status, JSON.stringify(value), { 'content-type': 'application/json', ...headers });
  // repo → releases, oldest first (the last is "latest").
  const release = (repo, tag) => {
    const list = repos.get(repo) || [];
    return tag === undefined ? list.at(-1) : list.find((r) => r.tag === tag);
  };
  function releaseJson(repo, r) {
    return {
      tag_name: r.tag,
      draft: false,
      prerelease: false,
      assets: r.assets.map((a, i) => ({
        name: a.name,
        size: a.data.length,
        url: `https://api.github.com/repos/${repo}/releases/assets/${r.id}-${i}`,
        browser_download_url: `https://github.com/${repo}/releases/download/${r.tag}/${a.name}`,
      })),
      zipball_url: `https://api.github.com/repos/${repo}/zipball/${r.tag}`,
    };
  }
  const assetAt = (repo, ref) => {
    const [id, i] = ref.split('-').map(Number);
    return (repos.get(repo) || []).find((r) => r.id === id)?.assets[i];
  };
  async function fetch(url, init = {}) {
    const headers = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    requests.push({ url, headers });
    if (init.redirect !== 'manual') throw new Error('redirects must be followed by hand');
    const u = new URL(url);
    let m;
    if (u.host === 'api.github.com' && (m = /^\/repos\/([^/]+\/[^/]+)\/releases\/(?:latest|tags\/(.+))$/.exec(u.pathname))) {
      if (limited) return json(403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1900000000' });
      const r = release(m[1], m[2] === undefined ? undefined : decodeURIComponent(m[2]));
      if (!r) return json(404, { message: 'Not Found' });
      if (headers['if-none-match'] === r.etag) return response(304);
      return json(200, releaseJson(m[1], r), { etag: r.etag });
    }
    if (u.host === 'api.github.com' && (m = /^\/repos\/([^/]+\/[^/]+)\/releases\/assets\/(\d+-\d+)$/.exec(u.pathname))) {
      if (headers.accept !== 'application/octet-stream') return json(200, { name: 'metadata, not the file' });
      return response(302, null, { location: `https://objects.githubusercontent.com/${m[1]}/${m[2]}?X-Amz-Signature=abc` });
    }
    if (u.host === 'github.com' && (m = /^\/([^/]+\/[^/]+)\/releases\/download\/([^/]+)\/(.+)$/.exec(u.pathname))) {
      const r = release(m[1], decodeURIComponent(m[2]));
      return response(302, null, { location: `https://objects.githubusercontent.com/${m[1]}/${r?.id}-${r?.assets.findIndex((a) => a.name === m[3])}?X-Amz-Signature=abc` });
    }
    if (u.host === 'objects.githubusercontent.com' && (m = /^\/([^/]+\/[^/]+)\/(\d+-\d+)$/.exec(u.pathname))) {
      const asset = assetAt(m[1], m[2]);
      return asset ? response(200, asset.data, { 'content-length': String(asset.data.length) }) : response(404);
    }
    if (u.host === 'api.github.com' && (m = /^\/repos\/([^/]+\/[^/]+)\/zipball\/(.+)$/.exec(u.pathname))) {
      return response(302, null, { location: `https://codeload.github.com/${m[1]}/legacy.zip/${m[2]}` });
    }
    if (u.host === 'codeload.github.com' && (m = /^\/([^/]+\/[^/]+)\/legacy\.zip\/(.+)$/.exec(u.pathname))) {
      return response(200, release(m[1], decodeURIComponent(m[2])).zipball);
    }
    return response(404);
  }
  return {
    fetch,
    requests,
    // Publishes a release (the new latest): assets [{ name, data }] and/or a source zip.
    publish(repo, tag, { assets = [], zipball } = {}) {
      n++;
      repos.set(repo, [...(repos.get(repo) || []), { id: n, tag, assets, zipball, etag: `"etag-${n}"` }]);
    },
    limit() { limited = true; },
  };
}

function dirs(t, env = {}) {
  const root = tempDir(t);
  const all = { SKP_DATA_DIR: path.join(root, 'data'), SKP_CONFIG_DIR: path.join(root, 'config'), ...env };
  return { root, env: all, config: loadConfig({ argv: [], env: all }) };
}

async function cli(argv, env, fetch) {
  let stdout = '';
  let stderr = '';
  const code = await run(argv, { stdout: { write: (s) => { stdout += s; } }, stderr: { write: (s) => { stderr += s; } }, env, fetch });
  return { code, stdout, stderr };
}

// The data directory opened as the platform does, with the fake GitHub; closed when the test ends.
function data(t, config, fetch, sourceLimits) {
  const { log, entries } = memoryLogger();
  const d = openData(config, { log, fetch, sourceLimits });
  defer(t, () => d.close());
  return { ...d, entries };
}

const ops = (config) => (existsSync(path.join(config.dataDir, 'operations.log'))
  ? readFileSync(path.join(config.dataDir, 'operations.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  : []);
const downloadsLeft = (config) => readdirSync(path.join(config.dataDir, 'templates')).filter((n) => n.startsWith('.download-'));

test('a source is a GitHub repository (owner/name, a tag, a github.com URL) or an https URL, never http', () => {
  const cases = {
    'ItsLimitlezz/takeover': { kind: 'github', repo: 'ItsLimitlezz/takeover' },
    'github:a/b@v1.2.0': { kind: 'github', repo: 'a/b', tag: 'v1.2.0' },
    'a/b.git': { kind: 'github', repo: 'a/b' },
    'https://github.com/a/b': { kind: 'github', repo: 'a/b' },
    'https://github.com/a/b/releases/tag/v2.0.0': { kind: 'github', repo: 'a/b', tag: 'v2.0.0' },
    'https://example.com/t.skp': { kind: 'url', url: 'https://example.com/t.skp' },
  };
  for (const [input, want] of Object.entries(cases)) assert.deepEqual(parseSource(input), want, input);
  assert.equal(describeSource(parseSource('a/b@v1')), 'github:a/b@v1');
  for (const [input, code] of [['http://example.com/t.skp', 'not-https'], ['https://user:pw@example.com/t.skp', 'bad-source'], ['a/b/c', 'bad-source'], ['../x', 'bad-source'], ['C:/x/t.skp', 'bad-source'], ['', 'bad-source'], ['-a/b', 'bad-source']]) {
    assert.throws(() => parseSource(input), { code }, input);
  }
});

test('skp template install owner/name installs the latest release\'s package, and says where it came from', async (t) => {
  const gh = fakeGithub();
  gh.publish('dprtmnt/sample', 'v1.0.0', { assets: [{ name: 'notes.txt', data: Buffer.from('x') }, { name: 'sample-1.0.0.skp', data: pkg('1.0.0') }] });
  const { env, config } = dirs(t);
  const res = await cli(['template', 'install', 'dprtmnt/sample', '--json'], env, gh.fetch);
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual([JSON.parse(res.stdout).id, JSON.parse(res.stdout).version], [ID, '1.0.0']);
  const [build] = readdirSync(path.join(config.dataDir, 'templates', ID));
  const receipt = JSON.parse(readFileSync(path.join(config.dataDir, 'templates', ID, build, 'install.json'), 'utf8'));
  assert.deepEqual(receipt.source, { kind: 'github', name: 'dprtmnt/sample@v1.0.0', repo: 'dprtmnt/sample', tag: 'v1.0.0', asset: 'sample-1.0.0.skp' });
  assert.equal(ops(config).at(-1).from, 'dprtmnt/sample@v1.0.0');
  assert.deepEqual(downloadsLeft(config), [], 'the download is removed once installed');
  // No token: no credentials sent anywhere.
  assert.ok(gh.requests.every((r) => !r.headers.authorization));
  // A missing file is a missing file, not a repository.
  for (const missing of ['nope.skp', './dir/x', 'folder\\t.zip']) {
    const gone = await cli(['template', 'install', missing], env, gh.fetch);
    assert.equal(gone.code, 1, missing);
    assert.match(gone.stderr, /no such file/, missing);
  }
});

test('an https URL installs too; every hop must be https, and the size limit holds however the file arrives', async (t) => {
  const { config } = dirs(t);
  const d = data(t, config, undefined);
  const dir = d.templates.downloadDir;
  const serve = (routes) => async (url, init) => {
    assert.equal(init.redirect, 'manual');
    const route = routes[url];
    return route ? route() : new Response(null, { status: 404 });
  };
  const body = pkg('1.0.0');
  const ok = await fetchPackage('https://cdn.example.com/sample.skp', { dir, fetch: serve({ 'https://cdn.example.com/sample.skp': () => new Response(body, { headers: { etag: '"a"' } }) }) });
  assert.deepEqual(readFileSync(ok.file), body);
  assert.deepEqual([ok.origin, ok.etag], [{ kind: 'url', url: 'https://cdn.example.com/sample.skp' }, '"a"']);
  const toHttp = serve({ 'https://cdn.example.com/a.skp': () => new Response(null, { status: 302, headers: { location: 'http://cdn.example.com/a.skp' } }) });
  await assert.rejects(fetchPackage('https://cdn.example.com/a.skp', { dir, fetch: toHttp }), { code: 'not-https' });
  const loop = serve({ 'https://cdn.example.com/l': () => new Response(null, { status: 302, headers: { location: '/l' } }) });
  await assert.rejects(fetchPackage('https://cdn.example.com/l', { dir, fetch: loop }), { code: 'bad-response' });
  const limits = { bytes: 2048 };
  const declared = serve({ 'https://cdn.example.com/big': () => new Response(Buffer.alloc(10), { headers: { 'content-length': '999999' } }) });
  await assert.rejects(fetchPackage('https://cdn.example.com/big', { dir, fetch: declared, limits }), { code: 'too-large' });
  const endless = serve({
    'https://cdn.example.com/endless': () => new Response(new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(1024)); } })),
  });
  await assert.rejects(fetchPackage('https://cdn.example.com/endless', { dir, fetch: endless, limits }), { code: 'too-large' });
  const down = async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }); };
  await assert.rejects(fetchPackage('https://nowhere.example/x.skp', { dir, fetch: down }), (err) => err.code === 'unreachable' && /ENOTFOUND/.test(err.message));
  const slow = async (_url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
  await assert.rejects(fetchPackage('https://slow.example/x.skp', { dir, fetch: slow, limits: { downloadMs: 100 } }), { code: 'timeout' });
  assert.deepEqual(readdirSync(dir).filter((n) => n.startsWith('.download-')), [ok.file].map((f) => path.basename(f)), 'only the good download, which its caller removes');
});

test('following a repository: new releases install, overlays move when nothing breaks, the rest wait', async (t) => {
  const gh = fakeGithub();
  const { config } = dirs(t);
  gh.publish('dprtmnt/sample', 'v1.0.0', { assets: [{ name: 'sample.skp', data: pkg('1.0.0') }] });
  const d = data(t, config, gh.fetch);
  const src = d.sources.add('dprtmnt/sample');
  assert.equal(src.data.autoUpgrade, 'safe');
  assert.throws(() => d.sources.add('https://github.com/dprtmnt/sample'), { code: 'exists' });
  let [r] = await d.sources.check();
  assert.deepEqual([r.tag, r.installed.id, r.installed.version, r.installed.noop], ['v1.0.0', ID, '1.0.0', false]);
  d.overlays.create({ slug: 'main', template: { id: ID, version: '1.0.0' }, settings: { accent: '#ff0000', size: 3 } });
  d.overlays.create({ slug: 'other', template: { id: ID, version: '1.0.0' }, settings: {} });

  // Nothing new: GitHub answers 304 and nothing is downloaded.
  const before = gh.requests.length;
  [r] = await d.sources.check();
  assert.equal(r.unchanged, true);
  assert.equal(gh.requests.length, before + 1);
  assert.equal(gh.requests.at(-1).headers['if-none-match'], d.sources.get('dprtmnt/sample').data.etag);

  // A compatible minor release: installed, and both overlays move, settings kept.
  gh.publish('dprtmnt/sample', 'v1.1.0', { assets: [{ name: 'sample.skp', data: pkg('1.1.0') }] });
  [r] = await d.sources.check();
  assert.deepEqual(r.upgraded.map((u) => `${u.overlay} ${u.from}→${u.to}`), ['main 1.0.0→1.1.0', 'other 1.0.0→1.1.0']);
  assert.deepEqual(r.waiting, []);
  assert.equal(d.overlays.resolve('main').doc.data.template.version, '1.1.0');
  assert.deepEqual(d.overlays.resolve('main').doc.data.settings, { accent: '#ff0000', size: 3 });

  // A minor release that drops a setting "main" uses: installed, "main" waits, "other" moves.
  const dropsSize = { type: 'object', properties: { accent: SETTINGS.properties.accent } };
  gh.publish('dprtmnt/sample', 'v1.2.0', { assets: [{ name: 'sample.skp', data: pkg('1.2.0', { settings: dropsSize }) }] });
  [r] = await d.sources.check();
  assert.deepEqual(r.upgraded.map((u) => u.overlay), ['other']);
  assert.deepEqual(r.waiting.map((w) => [w.overlay, w.to]), [['main', '1.2.0']]);
  assert.equal(d.overlays.resolve('main').doc.data.template.version, '1.1.0');

  // A major release: installed; nobody moves without the operator.
  gh.publish('dprtmnt/sample', 'v2.0.0', { assets: [{ name: 'sample.skp', data: pkg('2.0.0') }] });
  [r] = await d.sources.check();
  assert.equal(r.installed.version, '2.0.0');
  assert.deepEqual(r.upgraded, []);
  assert.deepEqual(r.waiting.map((w) => [w.overlay, w.why]), [['main', 'a major version'], ['other', 'a major version']]);
  assert.ok(d.entries.some((e) => /waits for the operator/.test(e.msg) && /skp overlay upgrade main --to 2\.0\.0/.test(e.context.run)));

  // A release older than what is installed (a rollback upstream) installs, and moves nobody back.
  gh.publish('dprtmnt/sample', 'v1.1.1', { assets: [{ name: 'sample.skp', data: pkg('1.1.1') }] });
  [r] = await d.sources.check();
  assert.equal(r.installed.version, '1.1.1');
  assert.deepEqual([r.upgraded, r.waiting], [[], []]);

  // Every install and upgrade it made is in operations.log, as the updater's.
  const log = ops(config);
  assert.deepEqual(log.filter((o) => o.op === 'template update').map((o) => o.template), ['1.0.0', '1.1.0', '1.2.0', '2.0.0', '1.1.1'].map((v) => `${ID}@${v}`));
  assert.deepEqual(log.filter((o) => o.op === 'overlay upgrade').map((o) => `${o.overlay} ${o.to} ${o.actor}`), ['main 1.1.0 updater', 'other 1.1.0 updater', 'other 1.2.0 updater']);
  assert.deepEqual(downloadsLeft(config), []);
});

test('a source keeps to its template: another id is refused; with auto-upgrade off it only installs', async (t) => {
  const gh = fakeGithub();
  const { config } = dirs(t);
  const d = data(t, config, gh.fetch);
  gh.publish('a/sample', 'v1.0.0', { assets: [{ name: 's.skp', data: pkg('1.0.0') }] });
  d.sources.add('a/sample', { autoUpgrade: 'off' });
  await d.sources.check();
  d.overlays.create({ slug: 'main', template: { id: ID, version: '1.0.0' }, settings: {} });
  gh.publish('a/sample', 'v1.1.0', { assets: [{ name: 's.skp', data: pkg('1.1.0') }] });
  let [r] = await d.sources.check();
  assert.equal(r.installed.version, '1.1.0');
  assert.deepEqual(r.upgraded, []);
  assert.equal(d.overlays.resolve('main').doc.data.template.version, '1.0.0', 'off: installed, not applied');
  // The repository now publishes another template: refused, nothing installed, and it says why.
  gh.publish('a/sample', 'v1.2.0', { assets: [{ name: 's.skp', data: pkg('1.2.0', { id: 'dev.skp.other' }) }] });
  [r] = await d.sources.check();
  assert.equal(r.error.code, 'wrong-template');
  assert.equal(d.templates.get('dev.skp.other', '1.2.0'), undefined);
  assert.equal(d.sources.get('a/sample').data.error.code, 'wrong-template');
  // A template that ships with the platform can't be published from a source either.
  gh.publish('b/takeover', 'v9.0.0', { assets: [{ name: 't.skp', data: pkg('9.0.0', { id: 'dev.skp.diagnostic' }) }] });
  d.sources.add('b/takeover');
  [r] = await d.sources.check('b/takeover');
  assert.equal(r.error.code, 'reserved-id');
  assert.throws(() => d.sources.add('a/sample', { autoUpgrade: 'always' }), { code: 'bad-option' });
});

test('a source pinned to a tag stays on that release while newer ones come out', async (t) => {
  const gh = fakeGithub();
  const { config } = dirs(t);
  const d = data(t, config, gh.fetch);
  gh.publish('a/sample', 'v1.0.0', { assets: [{ name: 's.skp', data: pkg('1.0.0') }] });
  d.sources.add('a/sample@v1.0.0');
  let [r] = await d.sources.check();
  assert.equal(r.installed.version, '1.0.0');
  gh.publish('a/sample', 'v1.1.0', { assets: [{ name: 's.skp', data: pkg('1.1.0') }] });
  [r] = await d.sources.check();
  assert.equal(r.unchanged, true);
  assert.equal(d.templates.get(ID, '1.1.0'), undefined);
  assert.ok(gh.requests.every((q) => !q.url.endsWith('/releases/latest')), 'never asks for the latest');
  // Not pinned: the latest, and it keeps following.
  d.sources.add('a/sample');
  [r] = await d.sources.check('a/sample');
  assert.equal(r.installed.version, '1.1.0');
  gh.publish('a/sample', 'v1.2.0', { assets: [{ name: 's.skp', data: pkg('1.2.0') }] });
  [r] = await d.sources.check('a/sample');
  assert.equal(r.installed.version, '1.2.0', 'not stuck on the release it first installed');
});

test('without an attached package the release\'s source zip installs (a repository with template.json at its root)', async (t) => {
  const gh = fakeGithub();
  const { config } = dirs(t);
  const d = data(t, config, gh.fetch);
  gh.publish('a/repo-template', 'v1.0.0', { zipball: pkg('1.0.0', { wrap: 'a-repo-template-3f2c1ab' }) });
  d.sources.add('a/repo-template');
  const [r] = await d.sources.check();
  assert.equal(r.installed.version, '1.0.0', JSON.stringify(r.error));
  assert.ok(gh.requests.some((q) => q.url.startsWith('https://codeload.github.com/')));
});

test('a private repository: the token goes to api.github.com only, never to where downloads redirect', async (t) => {
  const gh = fakeGithub();
  const { config } = dirs(t, { SKP_GITHUB_TOKEN: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789' });
  const d = data(t, config, gh.fetch);
  gh.publish('a/private', 'v1.0.0', { assets: [{ name: 's.skp', data: pkg('1.0.0') }] });
  d.sources.add('a/private');
  const [r] = await d.sources.check();
  assert.equal(r.installed.version, '1.0.0', JSON.stringify(r.error));
  const sent = gh.requests.map((q) => [new URL(q.url).host, Boolean(q.headers.authorization)]);
  assert.deepEqual(sent, [['api.github.com', true], ['api.github.com', true], ['objects.githubusercontent.com', false]]);
  assert.equal(gh.requests[1].headers.accept, 'application/octet-stream', 'the asset itself, not its description');
  // Never in a log line or the startup summary.
  assert.equal(describeConfig(config).githubToken, 'set');
  assert.equal(redactString(`token ghp_abcdefghijklmnopqrstuvwxyz0123456789 and github_pat_11ABCDEFG0123456789_abcdefghij`), 'token ghp_[redacted] and github_pat_[redacted]');
});

test('what goes wrong is said, recorded on the source, and leaves nothing behind', async (t) => {
  const gh = fakeGithub();
  const { config } = dirs(t);
  const d = data(t, config, gh.fetch);
  d.sources.add('a/missing');
  let [r] = await d.sources.check();
  assert.equal(r.error.code, 'no-release');
  assert.match(r.error.message, /a\/missing has no published release, or it is private \(set SKP_GITHUB_TOKEN/);
  d.sources.remove('a/missing');
  gh.publish('a/broken', 'v1.0.0', { assets: [{ name: 'b.skp', data: Buffer.from('not a zip at all') }] });
  d.sources.add('a/broken');
  [r] = await d.sources.check();
  assert.equal(r.error.code, 'invalid');
  assert.match(r.error.message, /isn't a template package/);
  assert.ok(!d.entries.some((e) => e.level === 'error'), 'a bad release is the source\'s problem, not a platform error');
  assert.deepEqual(d.templates.versions(ID), []);
  gh.limit();
  [r] = await d.sources.check();
  assert.equal(r.error.code, 'rate-limited');
  assert.match(r.error.message, /until 2030-03-17T17:46:40\.000Z; SKP_GITHUB_TOKEN raises it/);
  const stored = d.sources.get('a/broken').data;
  assert.deepEqual([stored.error.code, typeof stored.checkedAt], ['rate-limited', 'string']);
  assert.deepEqual(downloadsLeft(config), []);
});

test('the running platform checks by itself, and stopping it abandons a check in progress', async (t) => {
  const gh = fakeGithub();
  const { config } = dirs(t, { SKP_TEMPLATE_CHECK_MINUTES: '60' });
  gh.publish('a/sample', 'v1.0.0', { assets: [{ name: 's.skp', data: pkg('1.0.0') }] });
  {
    const d = openData(config, { log: memoryLogger().log });
    d.sources.add('a/sample');
    d.close();
  }
  const { log, entries } = memoryLogger();
  const platform = await startPlatform({ ...config, port: 0 }, { log, fetch: gh.fetch, sourceLimits: { firstCheckMs: 50 } });
  defer(t, () => platform.stop());
  assert.ok(entries.some((e) => /checking template sources/.test(e.msg) && e.context.everyMinutes === 60));
  const deadline = Date.now() + 5000;
  while (!platform.templates.get(ID, '1.0.0') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  assert.ok(platform.templates.get(ID, '1.0.0'), 'installed by the platform\'s own first check');
  await platform.stop();

  // A check hung on the network: stop() ends it, and nothing is left.
  // GitHub answers; the download host never does.
  const hang = async (url, init) => (new URL(url).host === 'api.github.com'
    ? gh.fetch(url, init)
    : new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))));
  gh.publish('a/sample', 'v1.1.0', { assets: [{ name: 's.skp', data: pkg('1.1.0') }] });
  const again = await startPlatform({ ...config, port: 0 }, { log: memoryLogger().log, fetch: hang, sourceLimits: { firstCheckMs: 3600000 } });
  defer(t, () => again.stop());
  const checking = again.sources.check();
  await new Promise((r) => setTimeout(r, 100));
  const t0 = Date.now();
  await again.stop();
  assert.ok(Date.now() - t0 < 3000, 'stop doesn\'t wait for the network');
  const [r] = await checking;
  assert.equal(r.error.code, 'stopped');
  assert.deepEqual(downloadsLeft(config), []);
});

test('skp template follow, sources, update and unfollow', async (t) => {
  const gh = fakeGithub();
  const { env, config } = dirs(t);
  gh.publish('a/sample', 'v1.0.0', { assets: [{ name: 's.skp', data: pkg('1.0.0') }] });
  const followed = await cli(['template', 'follow', 'https://github.com/a/sample'], env, gh.fetch);
  assert.equal(followed.code, 0, followed.stderr);
  assert.match(followed.stdout, /following github:a\/sample \(overlays move to new versions when nothing breaks\)/);
  assert.match(followed.stdout, /github:a\/sample release v1\.0\.0: installed dev\.skp\.sample@1\.0\.0/);
  const list = JSON.parse((await cli(['template', 'sources', '--json'], env, gh.fetch)).stdout);
  assert.deepEqual(list.map((s) => [s.source, s.template, s.version, s.release, s.autoUpgrade]), [['github:a/sample', ID, '1.0.0', 'v1.0.0', 'safe']]);
  {
    const d = openData(config, { log: memoryLogger().log });
    d.overlays.create({ slug: 'main', template: { id: ID, version: '1.0.0' }, settings: {} });
    d.close();
  }
  gh.publish('a/sample', 'v1.1.0', { assets: [{ name: 's.skp', data: pkg('1.1.0') }] });
  const updated = await cli(['template', 'update'], env, gh.fetch);
  assert.equal(updated.code, 0, updated.stderr);
  assert.match(updated.stdout, /installed dev\.skp\.sample@1\.1\.0/);
  assert.match(updated.stdout, /"main" moved from 1\.0\.0 to 1\.1\.0 \(skp overlay revert main goes back\)/);
  assert.match((await cli(['template', 'update', 'a/sample'], env, gh.fetch)).stdout, /no new release \(still v1\.1\.0\)/);
  const failing = await cli(['template', 'follow', 'a/nothing-here'], env, gh.fetch);
  assert.equal(failing.code, 0, 'followed; the first check failing is reported, not fatal');
  assert.match(failing.stdout, /the check failed: a\/nothing-here has no published release/);
  assert.equal((await cli(['template', 'update'], env, gh.fetch)).code, 1, 'a failing source makes update exit 1');
  assert.equal((await cli(['template', 'follow', 'a/sample', '--auto-upgrade', 'sometimes'], env, gh.fetch)).code, 1);
  const unfollowed = await cli(['template', 'unfollow', 'a/sample'], env, gh.fetch);
  assert.match(unfollowed.stdout, /stopped following github:a\/sample; the versions of dev\.skp\.sample it installed stay/);
  assert.equal((await cli(['template', 'unfollow', 'a/sample', '--json'], env, gh.fetch)).code, 1);
  assert.deepEqual(ops(config).map((o) => o.op).filter((op) => op.startsWith('template')), ['template follow', 'template update', 'template update', 'template follow', 'template unfollow']);
});

test('a template packed from its repository leaves .git out, in a folder and in a zip', (t) => {
  const dir = path.join(tempDir(t), 'repo');
  cpSync(DIAG_DIR, dir, { recursive: true });
  mkdirSync(path.join(dir, '.git', 'objects'), { recursive: true });
  writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(path.join(dir, '.git', 'objects', 'ab'), 'x');
  const fromDir = packageFromDir(dir);
  assert.ok(!fromDir.names.some((n) => n.startsWith('.git/')), fromDir.names.join(' '));
  assert.equal(validateTemplate(dir).build, validateTemplate(DIAG_DIR).build, 'the same package as without the repository');
  const zipped = packTemplate(DIAG_DIR, { files: { '.git/HEAD': 'ref: refs/heads/main\n', '.github/workflows/release.yml': 'on: release' } });
  const names = packageFromZip(bufferSource(zipped)).names;
  assert.ok(!names.includes('.git/HEAD'));
  assert.ok(names.includes('.github/workflows/release.yml'), 'only version-control data is left out');
});

test('SKP_TEMPLATE_CHECK_MINUTES: 60 unless set, 0 for never, and nothing GitHub would throttle', (t) => {
  const root = tempDir(t);
  const base = { SKP_DATA_DIR: path.join(root, 'data'), SKP_CONFIG_DIR: path.join(root, 'config') };
  const at = (v) => loadConfig({ argv: [], env: v === undefined ? base : { ...base, SKP_TEMPLATE_CHECK_MINUTES: v } }).templateCheckMinutes;
  assert.deepEqual([at(undefined), at('0'), at('5'), at('1440')], [60, 0, 5, 1440]);
  for (const bad of ['2', '-1', 'hourly', '20000']) assert.throws(() => at(bad), ConfigError, bad);
  // The token comes from the environment only, never a file.
  const configDir = path.join(root, 'only-config');
  mkdirSync(configDir);
  writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ githubToken: 'x' }));
  assert.throws(() => loadConfig({ argv: [], env: { ...base, SKP_CONFIG_DIR: configDir } }), (err) => err instanceof ConfigError && /SKP_GITHUB_TOKEN/.test(err.message));
});
