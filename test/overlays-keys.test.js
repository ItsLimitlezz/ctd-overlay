// Overlay keys over the API (07 §7.6–7.7): an answer holding a new key is never kept for replay,
// "no key required" is the owner's choice and never public mode's, and a key is bound to its own
// overlay's record.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { startPlatform } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { openStore } from '../src/store/index.js';
import { defer, FIXTURE_TEMPLATES, memoryLogger, signedIn, tempDir, TESTBED } from './helpers.js';

const PASSWORD = 'correct horse battery staple';

async function start(t, { dataRoot = tempDir(t), env = {} } = {}) {
  const config = loadConfig({ argv: ['--port', '0'], env: { SKP_DATA_DIR: path.join(dataRoot, 'data'), SKP_CONFIG_DIR: path.join(dataRoot, 'config'), ...env } });
  const { log, entries } = memoryLogger();
  const platform = await startPlatform(config, { log, templateDirs: [FIXTURE_TEMPLATES], scrypt: { N: 1024 } });
  defer(t, () => platform.stop());
  // A caller with these headers: a token, a session, the command line's local token.
  const as = (headers) => async (method, p, body, extra = {}) => {
    const res = await fetch(`${platform.url}/api/v1${p}`, { method, headers: { ...headers, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
  };
  return { platform, config, entries, dataRoot, as, api: as(signedIn(platform)) };
}

// A signed-in browser's headers, from setup or a login.
async function session(platform, url, body) {
  const res = await fetch(`${platform.url}/api/v1${url}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.ok(res.ok, `${url}: ${res.status}`);
  const { csrf } = await res.json();
  return { cookie: res.headers.get('set-cookie').split(';')[0], 'x-skp-csrf': csrf };
}

const keyIn = (answer) => new URL(answer.body.urls[0].url).searchParams.get('key');

test('a rotated key\'s answer is never kept for replay: the same Idempotency-Key rotates again, and nothing holding the key is stored', async (t) => {
  const { platform, config, api } = await start(t);
  platform.overlays.create({ slug: 'main', template: TESTBED, settings: {} });
  const rotate = () => api('POST', '/overlays/main/key/rotate', {}, { 'idempotency-key': 'deck-rotate-1' });
  const first = await rotate();
  const second = await rotate();
  assert.deepEqual([first.status, second.status], [200, 200]);
  assert.equal(second.headers.get('idempotent-replayed'), null);
  assert.notEqual(keyIn(second), keyIn(first), 'pressed twice, it rotates twice');
  assert.equal(keyIn(second), platform.overlays.key('main'), 'and the second answer has the key that works');
  await platform.stop();
  const store = openStore({ dataDir: config.dataDir, backend: config.store });
  const kept = store.list('idempotency', { limit: 1000 });
  store.close();
  assert.deepEqual(kept, [], 'the idempotency records are stored as they are: a key must never be among them (07 §7.7)');
});

test('"no key required" is the owner\'s choice (07 §7.6): an operator, or their token, may ask for the key or rotate it, never drop it', async (t) => {
  const { platform, api, as } = await start(t);
  platform.overlays.create({ slug: 'main', template: TESTBED, settings: { size: 3 } });
  const owner = as(await session(platform, '/setup', { code: platform.auth.setupCode, username: 'juan', password: PASSWORD }));
  assert.equal((await owner('POST', '/users', { username: 'op', password: `${PASSWORD} op`, role: 'operator' })).status, 201);
  const operator = as(await session(platform, '/auth/login', { username: 'op', password: `${PASSWORD} op` }));
  const etag = async () => ({ 'if-match': (await api('GET', '/overlays/main')).headers.get('etag') });
  const keyless = async () => (await fetch(`${platform.url}/o/main/snapshot`)).status;

  const refused = await operator('PATCH', '/overlays/main', { settings: { size: 4 }, keyRequired: false }, await etag());
  assert.deepEqual([refused.status, refused.body.type], [403, 'https://skp.dev/errors/forbidden']);
  assert.match(refused.body.detail, /owner's choice.*system:admin/);
  assert.deepEqual(platform.overlays.resolve('main').doc.data.settings, { size: 3 }, 'nothing of it saved');
  assert.equal(await keyless(), 401);
  const made = await operator('POST', '/tokens', { name: 'deck', scopes: ['overlays:read', 'overlays:write'] });
  assert.equal(made.status, 201);
  const deck = as({ authorization: `Bearer ${made.body.token}` });
  assert.equal((await deck('PATCH', '/overlays/main', { keyRequired: false })).status, 403);
  assert.equal(await keyless(), 401);
  assert.equal((await deck('PATCH', '/overlays/main', { keyRequired: true })).status, 200, 'asking for the key only makes it safer');
  assert.equal((await deck('POST', '/overlays/main/key/rotate', {})).status, 200, 'so does a new key');

  const mine = await owner('PATCH', '/overlays/main', { keyRequired: false }, await etag());
  assert.deepEqual([mine.status, mine.body.keyRequired], [200, false]);
  assert.equal(await keyless(), 200);
  assert.equal((await deck('PATCH', '/overlays/main', { keyRequired: false })).status, 200, 'already so: nothing to decide');
  assert.equal((await deck('PATCH', '/overlays/main', { keyRequired: true })).status, 200);
  // The log shows who changed the choice, and only that: asking for what was already so (the key,
  // then no key) decided nothing, so it never shows the owner's choice as the operator's.
  const decided = platform.audit.list({ action: 'overlay.key-required' }).items.reverse().map((e) => [e.actor, e.details.required]);
  assert.deepEqual(decided, [['juan', false], ['op (token deck)', true]]);
});

test('in public mode every overlay needs its key: one marked "no key required" in lan mode needs it again, and can\'t be marked again', async (t) => {
  const lan = await start(t, { env: { SKP_EXPOSURE: 'lan', SKP_HOST: '127.0.0.1' } });
  lan.platform.overlays.create({ slug: 'main', template: TESTBED, settings: {} });
  lan.platform.overlays.setKeyRequired('main', false);
  const key = lan.platform.overlays.key('main');
  await lan.platform.stop();
  const pub = await start(t, { dataRoot: lan.dataRoot, env: { SKP_EXPOSURE: 'public', SKP_HOST: '127.0.0.1', SKP_TRUST_PROXY: '127.0.0.1', SKP_PUBLIC_URL: 'https://overlays.example.com' } });
  const outside = { 'x-forwarded-for': '8.8.8.8', 'x-forwarded-proto': 'https', host: 'overlays.example.com' };
  const snapshot = (k) => fetch(`${pub.platform.url}/o/main/snapshot${k ? `?key=${k}` : ''}`, { headers: outside }).then((r) => r.status);
  assert.equal(await snapshot(), 401, 'from the internet, without the key');
  assert.equal(await snapshot(key), 200);
  assert.equal(pub.platform.overlays.keyRequired(pub.platform.overlays.resolve('main').doc), true);
  assert.throws(() => pub.platform.overlays.setKeyRequired('main', false), (err) => err.code === 'public-needs-key');
  // Over the API, with a rename in the same request: refused whole, so the URL in OBS stays.
  const res = await pub.api('PATCH', '/overlays/main', { slug: 'renamed', keyRequired: false });
  assert.deepEqual([res.status, res.body.type], [409, 'https://skp.dev/errors/public-needs-key']);
  assert.equal((await pub.api('GET', '/overlays/renamed')).status, 404);
  assert.equal(await snapshot(key), 200);
  assert.deepEqual(pub.platform.audit.list({ action: 'overlay' }).items, []);
  // Asking for the key here stores the choice (lan mode's "no key" was stored): recorded, though
  // public mode needed the key either way, so the overlay keeps it if the mode goes back to lan.
  assert.equal((await pub.api('PATCH', '/overlays/main', { keyRequired: true })).status, 200);
  assert.deepEqual(pub.platform.audit.list({ action: 'overlay.key-required' }).items.map((e) => e.details.required), [true]);
});

test('an overlay key is bound to its own overlay\'s record (07 §7.7): copied into another, it doesn\'t decrypt there', async (t) => {
  const first = await start(t);
  for (const slug of ['a', 'b']) first.platform.overlays.create({ slug, template: TESTBED, settings: {} });
  const keyA = first.platform.overlays.key('a');
  await first.platform.stop();
  const store = openStore({ dataDir: first.config.dataDir, backend: first.config.store });
  const [a, b] = ['a', 'b'].map((slug) => store.list('overlays', { limit: 10 }).find((d) => d.data.slug === slug));
  store.put('overlays', b.id, { ...b.data, key: a.data.key });
  store.close();
  const back = await start(t, { dataRoot: first.dataRoot });
  assert.notEqual(back.platform.overlays.key('b'), keyA);
  assert.equal((await fetch(`${back.platform.url}/o/b/snapshot?key=${keyA}`)).status, 401);
  assert.equal((await fetch(`${back.platform.url}/o/a/snapshot?key=${keyA}`)).status, 200, 'its own overlay still takes it');
  assert.ok(back.entries.some((e) => /can't be decrypted/.test(e.msg) && e.context.overlay === 'b'));
});
