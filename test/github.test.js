// Connect GitHub (04 §4.13, 07 §7.7): a GitHub token saved from Settings → Integrations instead of
// the server's environment, used for every template install, update check and release list;
// GitHub's device sign-in; clear words when a repository can't be read. GitHub is a fake on
// 127.0.0.1 (fixtures/fake-github.mjs): nothing here touches the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { openData, startPlatform } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { redactString } from '../src/log.js';
import { rotateMasterKey } from '../src/secrets.js';
import { openStore } from '../src/store/index.js';
import { assetPattern, fetchPackage, parseSource, tagPrefixOf } from '../src/templates/sources.js';
import { startFakeGithub } from './fixtures/fake-github.mjs';
import { auditOf, defer, DIAG_DIR, memoryLogger, packTemplate, signedIn, tempDir } from './helpers.js';

const PASSWORD = 'correct horse battery staple';
const REPO = 'ItsLimitlezz/miamiorbust-live';
const ID = 'com.itslimitlezz.miami-or-bust';
// Tokens shaped like GitHub's: a fine-grained one for the repository, a classic one for others.
const GOOD = 'github_pat_11AAAAAAA0123456789_abcdefghijklmnopqrstuvwxyzABCDEFGHIJ';
const OTHER = 'ghp_0123456789abcdefghijklmnopqrstuvwxyzAB';
const ENV = 'ghp_ENVENVENVENV0123456789abcdefghijklmnop';
const pkg = (version) => packTemplate(DIAG_DIR, { manifest: { id: ID, name: 'Miami or Bust', version } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await check();
    if (v) return v;
    await sleep(20);
  }
  return check();
}

// The private repository as the user has it: overlay-v1.0.0 with miami-or-bust-1.0.0.zip.
async function fakeGithub(t) {
  const gh = await startFakeGithub();
  defer(t, () => gh.close());
  gh.repo(REPO, { private: true });
  gh.release(REPO, 'overlay-v1.0.0', { assets: [{ name: 'miami-or-bust-1.0.0.zip', data: pkg('1.0.0') }] });
  gh.token(GOOD, { login: 'ItsLimitlezz', repos: [REPO] });
  gh.token(OTHER, { login: 'someone', repos: ['someone/else'], scopes: 'repo, read:org' });
  gh.token(ENV, { login: 'server-env', repos: [REPO] });
  return gh;
}

function dirs(t, env = {}) {
  const root = tempDir(t);
  return loadConfig({ argv: ['--port', '0'], env: { SKP_DATA_DIR: path.join(root, 'data'), SKP_CONFIG_DIR: path.join(root, 'config'), ...env } });
}

async function start(t, { env, gh } = {}) {
  gh ??= await fakeGithub(t);
  const config = dirs(t, env);
  const { log, entries } = memoryLogger();
  const platform = await startPlatform(config, { log, fetch: gh.fetch, lookup: gh.lookup, scrypt: { N: 1024 }, github: { secondMs: 10 } });
  defer(t, () => platform.stop());
  const answers = [];
  const call = async (method, p, body, headers = signedIn(platform)) => {
    const res = await fetch(`${platform.url}/api/v1${p}`, {
      method,
      headers: { ...headers, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    answers.push(text);
    let json;
    try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json };
  };
  return { gh, platform, config, entries, call, answers };
}

// An account signed in from Node (setup makes the owner, then one of the role given).
async function session(platform, username, role) {
  const post = (p, body, headers = {}) => fetch(`${platform.url}/api/v1${p}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  if (role !== 'owner') {
    await post('/setup', { code: platform.auth.setupCode, username: 'juan', password: PASSWORD });
    const made = await post('/users', { username, password: PASSWORD, role }, signedIn(platform));
    assert.equal(made.status, 201);
  } else {
    assert.equal((await post('/setup', { code: platform.auth.setupCode, username, password: PASSWORD })).status, 201);
  }
  const res = await post('/auth/login', { username, password: PASSWORD });
  assert.equal(res.status, 200);
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const { csrf } = await res.json();
  return { cookie, 'x-skp-csrf': csrf };
}

test('tag prefixes, file names without their version, and release download links', () => {
  assert.equal(tagPrefixOf('overlay-v1.0.0'), 'overlay-v');
  assert.deepEqual([tagPrefixOf('v1.0.0'), tagPrefixOf('1.0.0'), tagPrefixOf('nightly'), tagPrefixOf(undefined)], [undefined, undefined, undefined, undefined]);
  assert.equal(assetPattern('miami-or-bust-1.0.0.zip'), 'miami-or-bust-*.zip');
  assert.equal(assetPattern('miami-or-bust-1.1.0.zip'), assetPattern('miami-or-bust-1.0.0.zip'));
  assert.deepEqual(parseSource(`https://github.com/${REPO}/releases/download/overlay-v1.0.0/miami-or-bust-1.0.0.zip`), { kind: 'github', repo: REPO, tag: 'overlay-v1.0.0', asset: 'miami-or-bust-1.0.0.zip' });
  assert.throws(() => parseSource('https://user:pw@example.com/t.skp'), (err) => err.fix === 'connect-github' && !/SKP_GITHUB_TOKEN/.test(err.message));
  assert.equal(redactString(`gho_${'a'.repeat(36)} ghu_${'b'.repeat(36)} ${GOOD} ${OTHER}`), 'gho_[redacted] ghu_[redacted] github_pat_[redacted] ghp_[redacted]');
});

test('a token saved in Settings → Integrations is checked with GitHub, kept encrypted, and never comes back: not in an answer, the log or the audit log', async (t) => {
  const { gh, platform, config, entries, call, answers } = await start(t);
  assert.deepEqual((await call('GET', '/integrations/github')).body, { using: 'none', env: false, clientId: null, clientIdFrom: null, device: { status: 'none' } });

  const notAToken = await call('PUT', '/integrations/github/token', { token: 'my password' });
  assert.deepEqual([notAToken.status, notAToken.body.type], [422, 'https://skp.dev/errors/bad-token']);
  const unknown = await call('PUT', '/integrations/github/token', { token: 'ghp_unknownunknownunknownunknown0123456789' });
  assert.deepEqual([unknown.status, unknown.body.type], [422, 'https://skp.dev/errors/bad-token']);
  assert.match(unknown.body.detail, /GitHub refused this token/);
  assert.equal((await call('PUT', '/integrations/github/token', { token: GOOD, extra: 1 })).status, 422, 'only "token"');

  const saved = await call('PUT', '/integrations/github/token', { token: ` ${GOOD}\n` });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual([saved.body.using, saved.body.saved.login, saved.body.saved.method, typeof saved.body.saved.savedAt], ['saved', 'ItsLimitlezz', 'token', 'string']);
  // Checked with GitHub, as itself, on api.github.com only.
  const asked = gh.to('api.github.com', /^\/user$/).at(-1);
  assert.equal(asked.headers.authorization, `Bearer ${GOOD}`);
  // Encrypted at rest, bound to its record.
  const raw = platform.store.get('integrations', 'github').data;
  assert.match(raw.token, /^enc:v1:/);
  assert.ok(!JSON.stringify(raw).includes(GOOD));

  // An admin installs templates and sees whether GitHub is connected, but can't change it.
  const admin = await session(platform, 'ad', 'admin');
  const seen = await call('GET', '/integrations/github', undefined, admin);
  assert.deepEqual([seen.status, seen.body.using, seen.body.saved.login], [200, 'saved', 'ItsLimitlezz']);
  assert.equal((await call('PUT', '/integrations/github/token', { token: OTHER }, admin)).status, 403);
  assert.equal((await call('DELETE', '/integrations/github/token', undefined, admin)).status, 403);
  assert.equal((await call('POST', '/integrations/github/device', {}, admin)).status, 403);

  const gone = await call('DELETE', '/integrations/github/token');
  assert.deepEqual([gone.status, gone.body.using, gone.body.saved], [200, 'none', undefined]);
  assert.equal(platform.store.get('integrations', 'github'), undefined);
  await platform.stop();

  for (const text of [...answers, JSON.stringify(entries), JSON.stringify(auditOf(config))]) assert.ok(!text.includes(GOOD) && !text.includes(GOOD.slice(11)), 'the token never comes back');
  const audit = auditOf(config).filter((a) => a.action.startsWith('github.'));
  assert.deepEqual(audit.map((a) => [a.action, a.target, a.details?.method]), [['github.connect', '@ItsLimitlezz', 'token'], ['github.disconnect', '@ItsLimitlezz', undefined]]);
});

test('which token is used: the one saved here, else SKP_GITHUB_TOKEN, else none (public repositories only)', async (t) => {
  const gh = await fakeGithub(t);
  const config = dirs(t, { SKP_GITHUB_TOKEN: ENV });
  const d = openData(config, { log: memoryLogger().log, fetch: gh.fetch, lookup: gh.lookup });
  defer(t, () => d.close());
  assert.deepEqual(d.github.auth(), { token: ENV, from: 'env' });
  assert.equal(d.github.status().using, 'env');
  await d.github.saveToken(GOOD, { actor: 'test' });
  assert.deepEqual(d.github.auth(), { token: GOOD, from: 'saved', login: 'ItsLimitlezz' });
  // A source checks with the saved token, read at each check.
  d.sources.add(REPO);
  const [r] = await d.sources.check();
  assert.equal(r.installed?.version, '1.0.0', JSON.stringify(r.error));
  assert.ok(gh.to('api.github.com').slice(1).every((q) => q.headers.authorization === `Bearer ${GOOD}`));
  d.github.disconnect({ actor: 'test' });
  assert.equal(d.github.auth().from, 'env');
  const bare = openData(dirs(t), { log: memoryLogger().log, fetch: gh.fetch, lookup: gh.lookup });
  defer(t, () => bare.close());
  assert.deepEqual([bare.github.auth(), bare.github.status().using], [{ from: 'none' }, 'none']);
});

test('a private release, installed by its file, then followed: overlay-v1.1.0 brings miami-or-bust-1.1.0.zip; the token never reaches the signed link', async (t) => {
  const { gh, platform, call } = await start(t);
  await call('PUT', '/integrations/github/token', { token: GOOD });

  // The release list a person picks from: whether it can be read, as whom, newest first.
  gh.release(REPO, 'overlay-v1.1.0-beta.1', { prerelease: true, assets: [{ name: 'miami-or-bust-1.1.0-beta.1.zip', data: pkg('1.1.0-beta.1') }, { name: 'notes.txt', data: 'x' }] });
  const listed = await call('GET', `/integrations/github/repos/${REPO}/releases`);
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  assert.deepEqual([listed.body.repo, listed.body.private, listed.body.using, listed.body.login], [REPO, true, 'saved', 'ItsLimitlezz']);
  assert.deepEqual(listed.body.releases.map((r) => [r.tag, r.prerelease, r.assets.map((a) => a.name)]), [
    ['overlay-v1.1.0-beta.1', true, ['miami-or-bust-1.1.0-beta.1.zip']],
    ['overlay-v1.0.0', false, ['miami-or-bust-1.0.0.zip']],
  ]);
  assert.equal(listed.body.releases[1].assets[0].size, pkg('1.0.0').length);

  // Installed by its download link (what the picker sends): through the API, with the token.
  const before = gh.requests.length;
  const installed = await call('POST', '/templates', { url: `https://github.com/${REPO}/releases/download/overlay-v1.0.0/miami-or-bust-1.0.0.zip` });
  assert.equal(installed.status, 201, JSON.stringify(installed.body));
  assert.deepEqual([installed.body.id, installed.body.version], [ID, '1.0.0']);
  const hops = gh.requests.slice(before).map((q) => [q.host, q.path.replace(/\d+/g, 'N'), Boolean(q.headers.authorization)]);
  assert.deepEqual(hops, [
    ['api.github.com', `/repos/${REPO}/releases/tags/overlay-v1.0.0`.replace(/\d+/g, 'N'), true],
    ['api.github.com', `/repos/${REPO}/releases/assets/N`, true],
    ['objects.githubusercontent.com', '/github-production-release-asset/N', false],
  ], 'the signed link gets no Authorization');
  assert.equal(gh.requests.slice(before)[1].headers.accept, 'application/octet-stream');
  const receipt = platform.templates.get(ID, '1.0.0').receipt.source;
  assert.deepEqual([receipt.repo, receipt.tag, receipt.asset], [REPO, 'overlay-v1.0.0', 'miami-or-bust-1.0.0.zip']);

  // Followed: the tag prefix and the file's name come from what is installed.
  const followed = await call('POST', '/templates/sources', { source: REPO });
  assert.equal(followed.status, 201, JSON.stringify(followed.body));
  assert.deepEqual([followed.body.tagPrefix, followed.body.assetPattern], ['overlay-v', 'miami-or-bust-*.zip']);
  assert.equal(followed.body.check.error, undefined, JSON.stringify(followed.body.check));
  assert.equal(followed.body.check.tag, 'overlay-v1.0.0', 'the newest published overlay release, not the pre-release');

  // A release of something else, and the next overlay release with another .zip beside it.
  gh.release(REPO, 'overlay-v1.1.0', { assets: [{ name: 'artwork.zip', data: 'not a template' }, { name: 'miami-or-bust-1.1.0.zip', data: pkg('1.1.0') }] });
  gh.release(REPO, 'tools-v9.0.0', { assets: [{ name: 'tools-9.0.0.zip', data: 'not a template' }] });
  const checked = await call('POST', '/templates/sources/check', {});
  const [result] = checked.body.items;
  assert.equal(result.error, undefined, JSON.stringify(result.error));
  assert.deepEqual([result.tag, result.installed?.version], ['overlay-v1.1.0', '1.1.0']);
  assert.equal(platform.templates.get(ID, '1.1.0').receipt.source.asset, 'miami-or-bust-1.1.0.zip');
  assert.ok(gh.to('objects.githubusercontent.com').every((q) => !q.headers.authorization));
  // By tag alone: the release's .zip.
  const dir = platform.templates.downloadDir;
  const byTag = await fetchPackage(`${REPO}@overlay-v1.0.0`, { dir, github: () => ({ token: GOOD, from: 'saved', login: 'ItsLimitlezz' }), fetch: gh.fetch, lookup: gh.lookup });
  assert.equal(byTag.origin.asset, 'miami-or-bust-1.0.0.zip');
});

test('when GitHub says no, it is said plainly: not connected, connected without access, the server\'s token, a missing release, the rate limit', async (t) => {
  const { gh, call } = await start(t);
  const install = (url) => call('POST', '/templates', { url });

  const none = await install(`${REPO}@overlay-v1.0.0`);
  assert.deepEqual([none.status, none.body.type, none.body.fix], [422, 'https://skp.dev/errors/no-access', 'connect-github']);
  assert.match(none.body.detail, /^This repository is private or the GitHub token can't read it\. Without a token only public repositories can be read, and ItsLimitlezz\/miamiorbust-live isn't one/);
  assert.doesNotMatch(none.body.detail, /set SKP_GITHUB_TOKEN/);
  const test0 = await call('GET', `/integrations/github/repos/${REPO}/releases`);
  assert.deepEqual([test0.status, test0.body.fix], [422, 'connect-github']);

  await call('PUT', '/integrations/github/token', { token: OTHER });
  const noAccess = await install(`${REPO}@overlay-v1.0.0`);
  assert.deepEqual([noAccess.status, noAccess.body.fix], [422, 'connect-github']);
  assert.match(noAccess.body.detail, /The token for @someone can't read ItsLimitlezz\/miamiorbust-live: give it access to this repository/);
  const listed = await call('GET', `/integrations/github/repos/${REPO}/releases`);
  assert.match(listed.body.detail, /The token for @someone can't read/);
  // The saved token's classic scopes are kept, to show.
  assert.deepEqual((await call('GET', '/integrations/github')).body.saved.scopes, ['repo', 'read:org']);

  await call('PUT', '/integrations/github/token', { token: GOOD });
  const missing = await install(`${REPO}@overlay-v9.9.9`);
  assert.deepEqual([missing.body.type, missing.body.detail], ['https://skp.dev/errors/no-release', `${REPO} has no release "overlay-v9.9.9".`]);
  const noFile = await install(`https://github.com/${REPO}/releases/download/overlay-v1.0.0/other.zip`);
  assert.match(noFile.body.detail, /has no file named "other\.zip"/);

  gh.limit();
  const limited = await install(`${REPO}@overlay-v1.0.0`);
  assert.deepEqual([limited.status, limited.body.type, limited.body.fix], [503, 'https://skp.dev/errors/rate-limited', undefined]);
  assert.match(limited.body.detail, /limit on requests from this address is used up until 2030-03-17T17:46:40\.000Z\. Try again then\./);
  gh.limit(false);

  // The server's own token, when nothing is saved here.
  const envGh = await fakeGithub(t);
  envGh.token(ENV, { login: 'server-env', repos: [] });
  const withEnv = await start(t, { env: { SKP_GITHUB_TOKEN: ENV }, gh: envGh });
  const envNo = await withEnv.call('POST', '/templates', { url: REPO });
  assert.match(envNo.body.detail, /The token in the server's environment \(SKP_GITHUB_TOKEN\) can't read ItsLimitlezz\/miamiorbust-live/);
  assert.equal((await withEnv.call('GET', '/integrations/github')).body.using, 'env');
});

test('signing in with GitHub (the device flow): a code to enter, polled at GitHub\'s pace, slowed down when asked; the device code never shown', async (t) => {
  const { gh, platform, config, entries, call, answers } = await start(t);
  const noApp = await call('POST', '/integrations/github/device', {});
  assert.deepEqual([noApp.status, noApp.body.type], [422, 'https://skp.dev/errors/no-client-id']);
  assert.equal((await call('PUT', '/integrations/github/app', { clientId: 'not a client id!' })).status, 422);
  const app = await call('PUT', '/integrations/github/app', { clientId: 'Ov23liWrongClient' });
  assert.deepEqual([app.body.clientId, app.body.clientIdFrom], ['Ov23liWrongClient', 'saved']);
  const wrong = await call('POST', '/integrations/github/device', {});
  assert.match(wrong.body.detail, /doesn't know this client ID/);
  await call('PUT', '/integrations/github/app', { clientId: gh.clientId });

  gh.script.device = ['pending', 'slow_down', 'pending', 'pending', 'pending', 'pending', 'ok'];
  const started = await call('POST', '/integrations/github/device', {});
  assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.deepEqual([started.body.status, started.body.userCode, started.body.verificationUri, started.body.intervalS], ['pending', 'WDJB-MJHT', 'https://github.com/login/device', 1]);
  const asked = gh.to('github.com', /^\/login\/device\/code$/).at(-1).form;
  assert.deepEqual([asked.client_id, asked.scope], [gh.clientId, 'repo']);
  const slowed = await until(async () => ((await call('GET', '/integrations/github/device')).body.intervalS === 3 ? true : undefined), 3000);
  assert.ok(slowed, 'slow_down: GitHub\'s new interval');
  const done = await until(async () => {
    const s = (await call('GET', '/integrations/github/device')).body;
    return s.status === 'connected' ? s : undefined;
  });
  assert.deepEqual([done?.status, done?.login], ['connected', 'device-person']);
  const polls = gh.to('github.com', /^\/login\/oauth\/access_token$/);
  assert.equal(polls.length, 7);
  assert.ok(polls.every((q) => q.form.grant_type === 'urn:ietf:params:oauth:grant-type:device_code' && !q.headers.authorization));
  const status = (await call('GET', '/integrations/github')).body;
  assert.deepEqual([status.using, status.saved.login, status.saved.method], ['saved', 'device-person', 'device']);
  assert.equal(platform.github.auth().token, gh.issued[0]);
  await platform.stop();
  const secrets = [polls[0].form.device_code, gh.issued[0]];
  for (const text of [...answers, JSON.stringify(entries), JSON.stringify(auditOf(config))]) for (const s of secrets) assert.ok(!text.includes(s), 'never shown');
});

test('the device flow refused, expired or cancelled; the client id from SKP_GITHUB_CLIENT_ID', async (t) => {
  const { gh, call } = await start(t, { env: { SKP_GITHUB_CLIENT_ID: 'Ov23liFakeClient01' } });
  assert.deepEqual((await call('GET', '/integrations/github')).body.clientIdFrom, 'env');
  const outcome = async () => until(async () => {
    const s = (await call('GET', '/integrations/github/device')).body;
    return s.status !== 'pending' ? s : undefined;
  });
  gh.script.device = ['pending', 'denied'];
  await call('POST', '/integrations/github/device', {});
  const denied = await outcome();
  assert.deepEqual([denied.status, denied.userCode], ['denied', undefined]);
  assert.match(denied.message, /cancelled on GitHub/);
  gh.script.device = ['expired'];
  await call('POST', '/integrations/github/device', {});
  assert.equal((await outcome()).status, 'expired');
  gh.script.device = ['pending'];
  await call('POST', '/integrations/github/device', {});
  assert.deepEqual((await call('DELETE', '/integrations/github/device')).body, { status: 'none' });
  const polled = gh.to('github.com', /access_token/).length;
  await sleep(100);
  assert.equal(gh.to('github.com', /access_token/).length, polled, 'cancelled: no more polling');
  assert.equal((await call('GET', '/integrations/github')).body.using, 'none');
});

test('skp key rotate re-encrypts the saved GitHub token', async (t) => {
  const gh = await fakeGithub(t);
  const config = dirs(t);
  {
    const d = openData(config, { log: memoryLogger().log, fetch: gh.fetch, lookup: gh.lookup });
    await d.github.saveToken(GOOD, { actor: 'test' });
    d.close();
  }
  const store = openStore({ dataDir: config.dataDir });
  const before = store.get('integrations', 'github').data.token;
  const r = rotateMasterKey(config, store);
  const after = store.get('integrations', 'github').data.token;
  store.close();
  assert.equal(r.reencrypted, 1);
  assert.ok(after !== before && after.split(':')[2] === r.to, 'under the new key');
  const d = openData(config, { log: memoryLogger().log, fetch: gh.fetch, lookup: gh.lookup });
  defer(t, () => d.close());
  assert.equal(d.github.auth().token, GOOD);
});
