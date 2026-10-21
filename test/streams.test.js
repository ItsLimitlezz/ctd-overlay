// A stream's status (src/streams.js) on shows and overlays: what feeds each one, on air or not
// (true, false, or unknown: never "Offline" for nothing said), its platforms with the bus's choice
// between two connections (fresh over held, direct over relay), viewers added up or absent (never
// 0), "all" against named connections, two shows fed by two connections side by side; operators
// read it, and it carries no setting or secret. Worked out on read: the ETag doesn't move with it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { startPlatform } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { BUILTIN } from '../src/connectors/registry.js';
import { until } from './connector-helpers.js';
import { fakeConnector } from './fixtures/connectors/fake.js';
import { startFakeMultistream } from './fixtures/fake-multistream.mjs';
import { defer, FIXTURE_TEMPLATES, memoryLogger, signedIn, tempDir, TESTBED } from './helpers.js';

const PASSWORD = 'correct horse battery staple';
const SHOW = { date: '2026-10-17', timezone: 'America/Toronto' };

async function start(t, defs) {
  const root = tempDir(t);
  const config = loadConfig({ argv: ['--port', '0'], env: { SKP_DATA_DIR: path.join(root, 'data'), SKP_CONFIG_DIR: path.join(root, 'config') } });
  const platform = await startPlatform(config, { log: memoryLogger().log, templateDirs: [FIXTURE_TEMPLATES], scrypt: { N: 1024 }, connectors: { defs } });
  defer(t, () => platform.stop());
  const call = (headers) => async (method, p, body) => {
    const res = await fetch(`${platform.url}/api/v1${p}`, { method, headers: { ...headers, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null), etag: res.headers.get('etag'), text: '' };
  };
  const owner = call(signedIn(platform));
  return { platform, owner, call };
}

// An operator, signed in as the admin UI is: no connections:read.
async function operator(platform, owner, call) {
  assert.equal((await owner('POST', '/users', { username: 'op', password: PASSWORD, role: 'operator' })).status, 201);
  const res = await fetch(`${platform.url}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'op', password: PASSWORD }) });
  assert.equal(res.status, 200);
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const { csrf } = await res.json();
  return call({ cookie, 'x-skp-csrf': csrf });
}

test('on air, offline or unknown; the bus\'s choice between connections; viewers added up or absent; "all" and named; two shows apart', { timeout: 60000 }, async (t) => {
  const direct = fakeConnector({ id: 'fake', name: 'Direct' });
  const youtube = fakeConnector({ id: 'fake-yt', name: 'Direct YouTube', platform: 'youtube' });
  const relay = fakeConnector({ id: 'relay', name: 'Relay', relay: true });
  const { platform, owner, call } = await start(t, [direct.def, youtube.def, relay.def]);
  const make = (connector, name) => platform.connectors.create({ connector, name, config: { behaviour: 'push', clientId: 'client-id-value' }, secrets: { clientSecret: 'client-secret-value' } });
  const a = make('fake', 'Stream A');
  const b = make('fake-yt', 'Stream B');
  const r = make('relay', 'Relay');
  await until(() => direct.live.length === 1 && youtube.live.length === 1 && relay.live.length === 1, 5000, 'the connections running');
  const ctxOf = (id) => [...direct.live, ...youtube.live, ...relay.live].find((i) => i.ctx.connection.id === id).ctx;
  for (const c of [a, b, r]) ctxOf(c.id).setHealth({ status: 'connected' });

  for (const [slug, connections] of [['a-h', [a.id]], ['a-v', [a.id]], ['b-h', [b.id]], ['solo', 'all'], ['pair', [a.id, r.id]], ['c-all', 'all'], ['c-b', [b.id]]]) {
    platform.overlays.create({ slug, template: TESTBED, settings: {}, connections });
  }
  const showA = platform.shows.create({ name: 'Stream A night', overlays: ['a-h', 'a-v'], ...SHOW }, { actor: 'test' });
  const showB = platform.shows.create({ name: 'Stream B night', overlays: ['b-h'], ...SHOW }, { actor: 'test' });
  const showC = platform.shows.create({ name: 'Everything', overlays: ['c-b', 'c-all'], ...SHOW }, { actor: 'test' });
  const showNone = platform.shows.create({ name: 'Empty', overlays: [], ...SHOW }, { actor: 'test' });
  const streamOf = async (p) => (await owner('GET', p)).body.stream;
  const names = (s) => s.connections.map((c) => c.name);

  // Nothing reported yet: unknown (no onAir), no platforms, no viewers.
  assert.deepEqual(await streamOf(`/shows/${showA.id}`), { connections: [{ id: a.id, name: 'Stream A', connector: 'fake', status: 'connected' }], platforms: [] });
  assert.deepEqual(await streamOf(`/shows/${showNone.id}`), { connections: [], platforms: [] }, 'no member: nothing feeds it');

  // Stream A is live on Twitch with 214 viewers; stream B says YouTube is offline, with no count.
  ctxOf(a.id).setState('stream.twitch.live', true);
  ctxOf(a.id).setState('stream.twitch.title', 'Saturday');
  ctxOf(a.id).setState('stream.twitch.startedAt', Date.UTC(2026, 9, 17, 3));
  ctxOf(a.id).setState('viewers.twitch', 214);
  ctxOf(b.id).setState('stream.youtube.live', false);
  const sa = await streamOf(`/shows/${showA.id}`);
  assert.deepEqual([sa.onAir, sa.viewers, sa.platforms], [true, 214, [{ platform: 'twitch', live: true, title: 'Saturday', startedAt: '2026-10-17T03:00:00.000Z', viewers: 214 }]]);
  const sb = await streamOf(`/shows/${showB.id}`);
  assert.deepEqual([sb.onAir, 'viewers' in sb, sb.platforms, names(sb)], [false, false, [{ platform: 'youtube', live: false }], ['Stream B']], 'offline, and no viewer count rather than 0');
  // Each show is its own stream: A's Twitch is not B's.
  assert.equal((await streamOf('/overlays/b-h')).onAir, false);
  assert.equal((await streamOf('/overlays/a-v')).onAir, true);

  // Bound to every connection: both platforms, every connection; a show with one "all" member too.
  const solo = await streamOf('/overlays/solo');
  assert.deepEqual([solo.onAir, solo.viewers, solo.platforms.map((p) => p.platform), names(solo)], [true, 214, ['twitch', 'youtube'], ['Stream A', 'Stream B', 'Relay']]);
  assert.deepEqual(names(await streamOf(`/shows/${showC.id}`)), ['Stream A', 'Stream B', 'Relay']);
  // A count with no live status yet (Kick, through B): its viewers count, its "on air" isn't said.
  platform.bus.setState('viewers.kick', 12, { src: { connector: 'fake-yt', connection: b.id, platform: 'kick' } });
  const sb2 = await streamOf(`/shows/${showB.id}`);
  assert.deepEqual([sb2.onAir, sb2.viewers, sb2.platforms.map((p) => p.platform)], [false, 12, ['youtube', 'kick']]);

  // Two connections on one platform: the direct one over the relay, a fresh value over a held one.
  ctxOf(r.id).setState('stream.twitch.live', false);
  ctxOf(r.id).setState('viewers.twitch', 999);
  const pair = await streamOf('/overlays/pair');
  assert.deepEqual([pair.onAir, pair.viewers, pair.platforms[0].live], [true, 214, true], 'direct over relay');
  ctxOf(a.id).hold();
  const held = await streamOf('/overlays/pair');
  // (The title and start, which only A gives, are still A's held ones: the platform is marked held.)
  assert.deepEqual([held.onAir, held.viewers, held.platforms[0].live, held.platforms[0].title, held.platforms[0].stale], [false, 999, false, 'Saturday', true], 'fresh over held');
  const heldA = await streamOf('/overlays/a-h');
  assert.deepEqual([heldA.onAir, heldA.viewers, heldA.platforms[0].stale], [true, 214, true], 'only the held one: shown, marked held');

  // A connection turned off feeds nothing.
  await platform.connectors.update(b.id, { enabled: false });
  await until(async () => (await streamOf(`/shows/${showB.id}`)).connections.length === 0, 5000, 'B off');
  assert.deepEqual(await streamOf(`/shows/${showB.id}`), { connections: [], platforms: [] });

  // The core's own value (a demo, PUT /state) is not a stream's: no connection reports YouTube now.
  platform.bus.setState('stream.youtube.live', true);
  assert.deepEqual((await streamOf('/overlays/solo')).platforms.map((p) => p.platform), ['twitch']);
  assert.equal((await streamOf('/overlays/a-h')).onAir, true);

  // Operators read it (no connections:read); it holds names and status, never a setting or secret.
  const op = await operator(platform, owner, call);
  const shows = await op('GET', '/shows');
  assert.equal(shows.status, 200);
  assert.equal(shows.body.items.find((s) => s.id === showA.id).stream.onAir, true);
  const ov = await op('GET', '/overlays');
  assert.equal(ov.status, 200);
  const text = JSON.stringify([shows.body, ov.body]);
  for (const secret of ['client-secret-value', 'client-id-value', 'behaviour']) assert.ok(!text.includes(secret), secret);

  // Worked out on read: a change of status leaves the ETag alone.
  const before = await owner('GET', `/shows/${showA.id}`);
  ctxOf(a.id).setState('viewers.twitch', 300);
  const after = await owner('GET', `/shows/${showA.id}`);
  assert.equal(after.etag, before.etag);
  assert.notDeepEqual(after.body.stream, before.body.stream);
  const o1 = await owner('GET', '/overlays/a-h');
  ctxOf(a.id).setState('stream.twitch.live', false);
  const o2 = await owner('GET', '/overlays/a-h');
  assert.deepEqual([o2.etag, o1.body.stream.onAir, o2.body.stream.onAir], [o1.etag, true, false]);
});

test('two CTD Relay servers feed two shows: one on air with its viewers, the other offline', { timeout: 60000 }, async (t) => {
  const one = await startFakeMultistream();
  defer(t, () => one.close());
  const two = await startFakeMultistream();
  defer(t, () => two.close());
  // One profile each (their tokens read every profile: the connection follows every one there is).
  for (const ms of [one, two]) ms.profiles = ms.profiles.filter((p) => p.id === 'default');
  // The second server's destinations are all off air, without counts.
  two.status.destinations = two.status.destinations.map((d) => ({ ...d, live: false, phase: 'idle', down: false, message: null, viewers: null }));
  two.status.platforms = two.status.platforms.map((p) => ({ ...p, live: false, startedAt: null, viewers: null, error: null }));
  two.status.session = { ...two.status.session, status: 'idle' };
  const { platform, owner } = await start(t, BUILTIN);
  const conn = (ms, name) => platform.connectors.create({ connector: 'ctd-multistream', name, config: { baseUrl: `${ms.url}/api/v1` }, secrets: { token: ms.token } });
  const c1 = conn(one, 'Main room');
  const c2 = conn(two, 'Second room');
  for (const [slug, id] of [['main-h', c1.id], ['main-v', c1.id], ['second', c2.id]]) platform.overlays.create({ slug, template: TESTBED, settings: {}, connections: [id] });
  const main = platform.shows.create({ name: 'Main room', overlays: ['main-h', 'main-v'], ...SHOW }, { actor: 'test' });
  const second = platform.shows.create({ name: 'Second room', overlays: ['second'], ...SHOW }, { actor: 'test' });
  const streamOf = async (id) => (await owner('GET', `/shows/${id}`)).body.stream;
  const up = (s) => s.connections.every((c) => ['connected', 'degraded'].includes(c.status));
  await until(async () => (await streamOf(main.id)).viewers === 244 && (await streamOf(second.id)).platforms.length === 3 && up(await streamOf(main.id)) && up(await streamOf(second.id)), 15000, 'both servers read');

  const m = await streamOf(main.id);
  assert.equal(m.onAir, true);
  assert.deepEqual(m.platforms.map((p) => [p.platform, p.live, p.viewers]), [['twitch', true, 214], ['youtube', true, 30], ['instagram', false, undefined]]);
  assert.deepEqual(m.connections.map((c) => [c.name, c.connector]), [['Main room', 'ctd-multistream']]);
  assert.match(m.connections[0].status, /^(connected|degraded)$/);
  const s = await streamOf(second.id);
  assert.deepEqual([s.onAir, 'viewers' in s, s.platforms.every((p) => p.live === false)], [false, false, true]);
  assert.deepEqual(s.connections.map((c) => c.name), ['Second room']);
  assert.ok(!JSON.stringify([m, s]).includes(one.token) && !JSON.stringify([m, s]).includes('/api/v1'), 'no token, no address');
});
