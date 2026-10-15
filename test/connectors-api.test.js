// Connections over the API (03 §3.4, 07 §7.5, §7.7): who may see and change them, If-Match on
// edits, refusals that say what to fix, no secret in any answer or audit entry, overlays' bindings
// ('all' or connections that exist), the connections summary operators get from /system/health,
// installation-wide state, and inbound deliveries checked by their connector.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { startPlatform } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { until } from './connector-helpers.js';
import { fakeConnector } from './fixtures/connectors/fake.js';
import { defer, FIXTURE_TEMPLATES, memoryLogger, tempDir, TESTBED } from './helpers.js';

const PASSWORD = 'correct horse battery staple';
const SECRET = 'a-client-secret-nobody-sees';

async function start(t) {
  const fake = fakeConnector({ auth: 'oauth-pkce' });
  const root = tempDir(t);
  const config = loadConfig({ argv: ['--port', '0'], env: { SKP_DATA_DIR: path.join(root, 'data'), SKP_CONFIG_DIR: path.join(root, 'config') } });
  const { log, entries } = memoryLogger();
  const platform = await startPlatform(config, { log, scrypt: { N: 1024 }, templateDirs: [FIXTURE_TEMPLATES], connectors: { defs: [fake.def, fakeConnector({ id: 'pusher', name: 'Pusher' }).def] } });
  defer(t, () => platform.stop());
  return { platform, entries, fake };
}

async function as(platform, who, owner) {
  let res;
  if (!owner) res = await fetch(`${platform.url}/api/v1/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: platform.auth.setupCode, username: who, password: PASSWORD }) });
  else {
    await owner('POST', '/users', { username: who.username, password: PASSWORD, role: who.role });
    res = await fetch(`${platform.url}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: who.username, password: PASSWORD }) });
  }
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const { csrf } = await res.json();
  return (method, p, body, headers = {}) => fetch(`${platform.url}/api/v1${p}`, { method, headers: { cookie, 'x-skp-csrf': csrf, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null), headers: r.headers }));
}

test('owners and admins see and change connections; operators and viewers don\'t, but see their status', async (t) => {
  const { platform } = await start(t);
  const owner = await as(platform, 'juan');
  const op = await as(platform, { username: 'opal', role: 'operator' }, owner);
  const made = await owner('POST', '/connections', { connector: 'pusher', name: 'Pusher', config: { behaviour: 'push' } });
  assert.equal(made.status, 201);
  for (const [m, p] of [['GET', '/connectors'], ['GET', '/connections'], ['GET', `/connections/${made.body.id}`], ['POST', '/connections']]) {
    assert.equal((await op(m, p, m === 'POST' ? { connector: 'pusher' } : undefined)).status, 403, `${m} ${p}`);
  }
  await until(() => platform.connectors.get(made.body.id).health.status === 'connected');
  const health = await op('GET', '/system/health');
  assert.equal(health.status, 200);
  assert.deepEqual(health.body.connections.map((c) => [c.name, c.connector, c.status]), [['Pusher', 'pusher', 'connected']]);
  assert.equal(health.body.status, 'ok');
  // An action an operator may run (overlays:control); one that asks for connections:write they can't.
  assert.equal((await op('POST', `/connections/${made.body.id}/actions/echo`, { args: { text: 'x' } })).status, 200);
  const admin = await op('POST', `/connections/${made.body.id}/actions/admin`, {});
  assert.equal(admin.status, 403);
  assert.match(admin.body.detail, /connections:write/);
  // A connection turned on but failing degrades the platform's health.
  await owner('POST', '/connections', { connector: 'pusher', name: 'Broken', config: { behaviour: 'fail-start' } });
  await until(async () => (await op('GET', '/system/health')).body.status === 'degraded');
});

test('edits need If-Match from the admin UI; refusals say what to fix; nothing secret in answers or the audit log', async (t) => {
  const { platform, entries } = await start(t);
  const owner = await as(platform, 'juan');
  const bad = async (body, code, re) => {
    const r = await owner('POST', '/connections', body);
    assert.equal(r.status, 422, JSON.stringify(body));
    assert.equal(r.body.type, `https://skp.dev/errors/${code}`);
    if (re) assert.match(r.body.detail, re);
  };
  await bad({ connector: 'nope' }, 'unknown-connector', /no connector "nope"/);
  await bad({ connector: 'fake', config: { colour: 1 } }, 'unknown-field', /colour/);
  await bad({ connector: 'fake', secrets: { clientId: 'x' } }, 'unknown-field');
  await bad({ connector: 'fake', name: '' }, 'invalid', /"name"/);
  assert.equal((await owner('POST', '/connections', { connector: 'fake', extra: 1 })).status, 422);
  const made = await owner('POST', '/connections', { connector: 'fake', name: 'Fake', config: { behaviour: 'push', clientId: 'cid' }, secrets: { clientSecret: SECRET } });
  assert.equal(made.status, 201);
  assert.equal(made.headers.get('etag'), `"${made.body.id}-r1"`);
  const id = made.body.id;
  assert.equal((await owner('PATCH', `/connections/${id}`, { name: 'x' })).status, 428);
  assert.equal((await owner('PATCH', `/connections/${id}`, { name: 'x' }, { 'if-match': `"${id}-r9"` })).status, 412);
  const renamed = await owner('PATCH', `/connections/${id}`, { name: 'Renamed', secrets: { clientSecret: `${SECRET}-new` } }, { 'if-match': `"${id}-r1"` });
  assert.equal(renamed.status, 200);
  assert.deepEqual([renamed.body.name, renamed.body.secretFields], ['Renamed', ['clientSecret']]);
  const cleared = await owner('PATCH', `/connections/${id}`, { secrets: { clientSecret: null } }, { 'if-match': `"${id}-r2"` });
  assert.deepEqual(cleared.body.secretFields, []);
  // Changing the client id (x-skp-reauth) forgets the sign-in.
  platform.connectors.records.saveTokens(id, { accessToken: 'at-token-0000000000', refreshToken: 'rt-token-000000000', scope: [], obtainedAt: Date.now() });
  assert.equal((await owner('GET', `/connections/${id}`)).body.signedIn, true);
  const moved = await owner('PATCH', `/connections/${id}`, { config: { behaviour: 'push', clientId: 'another' } }, { 'if-match': `"${id}-r3"` });
  assert.equal(moved.status, 200);
  assert.equal(moved.body.signedIn, undefined);
  // A test, at most one every 5 s.
  assert.equal((await owner('POST', `/connections/${id}/test`, {})).status, 200);
  const again = await owner('POST', `/connections/${id}/test`, {});
  assert.equal(again.status, 429);
  assert.ok(Number(again.headers.get('retry-after')) >= 1);
  // No sign-in for a connector that has none; nothing about a connection that doesn't exist.
  assert.equal((await owner('POST', '/connections/con_00000000000000000000000000/authorize', {})).status, 404);
  const pusher = await owner('POST', '/connections', { connector: 'pusher' });
  const none = await owner('POST', `/connections/${pusher.body.id}/authorize`, {});
  assert.equal(none.status, 422);
  assert.match(none.body.detail, /No sign-in needed/);
  const everything = JSON.stringify([await owner('GET', '/connections'), (await owner('GET', '/system/audit?limit=200')).body, entries]);
  assert.ok(!everything.includes(SECRET));
  assert.ok(!everything.includes('at-token-0000000000'));
  // The audit log names the fields that changed, never their values (newest first).
  const updates = (await owner('GET', '/system/audit?action=connection.update')).body.items.map((e) => e.details);
  assert.deepEqual(updates, [{ fields: ['clientId'], signedOut: true }, { fields: ['clientSecret'] }, { fields: ['name', 'clientSecret'] }]);
});

test('overlays take "all" connections by default, or a list of connections that exist; a deleted one leaves the lists', async (t) => {
  const { platform, fake } = await start(t);
  const owner = await as(platform, 'juan');
  const a = (await owner('POST', '/connections', { connector: 'pusher', name: 'A', config: { behaviour: 'push' } })).body;
  const b = (await owner('POST', '/connections', { connector: 'pusher', name: 'B', config: { behaviour: 'push' } })).body;
  const all = await owner('POST', '/overlays', { slug: 'every', template: TESTBED });
  assert.equal(all.body.connections, 'all');
  await until(async () => (await owner('GET', '/overlays/every')).body.bound.length === 2);
  assert.deepEqual((await owner('GET', '/overlays/every')).body.bound.map((c) => c.name).sort(), ['A', 'B']);
  const missing = await owner('POST', '/overlays', { slug: 'one', template: TESTBED, connections: ['con_00000000000000000000000000'] });
  assert.equal(missing.status, 422);
  assert.match(missing.body.detail, /no connection/);
  assert.equal((await owner('POST', '/overlays', { slug: 'one', template: TESTBED, connections: 'some' })).status, 422);
  const one = await owner('POST', '/overlays', { slug: 'one', template: TESTBED, connections: [a.id] });
  assert.deepEqual([one.status, one.body.connections, one.body.bound.map((c) => c.name)], [201, [a.id], ['A']]);
  assert.deepEqual((await owner('GET', `/connections/${a.id}`)).body.overlays, ['every', 'one']);
  assert.deepEqual((await owner('GET', `/connections/${b.id}`)).body.overlays, ['every']);
  // What each overlay shows: A's count on both; B's only where it is bound.
  const pushOf = (id) => fake.live && platform.connectors.runnerOf(id).ctx;
  await until(() => pushOf(a.id) && pushOf(b.id));
  pushOf(a.id).setState('viewers.twitch', 100);
  const snap = (slug) => platform.overlays.resolve(slug).channel.snapshot().state;
  assert.equal(snap('every')['viewers.total'], 100);
  // Rebinding through the API (If-Match), and B instead of A.
  const rebound = await owner('PATCH', '/overlays/one', { connections: [b.id] }, { 'if-match': `"${one.body.id}-r${one.body.rev}"` });
  assert.equal(rebound.status, 200);
  assert.equal(snap('one')['viewers.twitch'], undefined);
  const gone = await owner('DELETE', `/connections/${b.id}`);
  assert.deepEqual(gone.body, { id: b.id, name: 'B', overlays: ['every', 'one'] });
  assert.deepEqual((await owner('GET', '/overlays/one')).body.connections, [], 'no longer named');
  assert.ok((await owner('GET', '/system/audit?action=overlay.bind')).body.items.length >= 1);
});

test('GET /state is installation-wide: one value per key by the bus\'s rule, viewers.total summed over platforms', async (t) => {
  const { platform } = await start(t);
  const owner = await as(platform, 'juan');
  const x = platform.connectors.create({ connector: 'pusher', name: 'X', config: { behaviour: 'push' } });
  await until(() => platform.connectors.runnerOf(x.id)?.ctx);
  const ctx = platform.connectors.runnerOf(x.id).ctx;
  ctx.setState('viewers.twitch', 40);
  ctx.setState('stream.twitch.live', true);
  const state = (await owner('GET', '/state')).body;
  assert.deepEqual([state['viewers.twitch'], state['viewers.total'], state['stream.twitch.live']], [40, 40, true]);
  ctx.hold(['viewers.twitch']);
  const held = (await owner('GET', '/state')).body;
  assert.deepEqual([held['viewers.twitch'], held['viewers.twitch.stale'], held['viewers.stale']], [40, true, true]);
  assert.equal((await owner('GET', `/connections/${x.id}`)).body.state['viewers.twitch'], 40);
});

test('deliveries to /hooks/<connector>: checked by the connector against the raw body; refused ones counted', async (t) => {
  const { platform } = await start(t);
  const x = platform.connectors.create({ connector: 'pusher', name: 'X', config: { behaviour: 'push' } });
  await until(() => platform.connectors.get(x.id).health.status === 'connected');
  const send = (p, signature, body) => fetch(`${platform.url}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(signature ? { 'x-fake-signature': signature } : {}) }, body: JSON.stringify(body) });
  assert.equal((await send('/hooks/pusher', 'bad', { id: 'h1', text: 'no' })).status, 401);
  assert.equal((await send('/hooks/pusher', 'good', { id: 'h1', text: 'hello' })).status, 204);
  assert.equal((await send(`/hooks/pusher/${x.id}`, 'good', { id: 'h1', text: 'hello' })).status, 204);
  assert.equal(platform.bus.chatRecent().filter((m) => m.data.id === 'h1').length, 1, 'deduplicated');
  assert.equal((await send('/hooks/nothing', 'good', {})).status, 404);
  assert.deepEqual(platform.connectors.get(x.id).deliveries, { accepted: 2, refused: 1 });
});
