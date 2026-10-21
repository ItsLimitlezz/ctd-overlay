// CTD Relay's OBS events (PLAN step 18, its §10): the CTD OBS plugin's scene changes and outputs
// reach this platform as each profile's state. Against a pretend Relay: the scenes OBS shows now
// are read from GET /profiles/<id>/obs on connecting; obs.scene and obs.output events keep them,
// per profile and canvas; a change older than what that OBS machine said last (atMs) is ignored,
// one seen twice (eventId) is dropped, and Relay's resend of an unchanged scene changes nothing;
// two OBS machines on one profile: the most recent change shows; two profiles never mix; a
// connection limited to one profile has them as its own; an older Relay without OBS still connects.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { startPlatform } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { until } from './connector-helpers.js';
import { startFakeMultistream } from './fixtures/fake-multistream.mjs';
import { defer, FIXTURE_TEMPLATES, memoryLogger, signedIn, tempDir } from './helpers.js';

const running = (s) => ['connected', 'degraded'].includes(s);

async function start(t, prepare = () => {}) {
  const ms = await startFakeMultistream();
  defer(t, () => ms.close());
  prepare(ms);
  const root = tempDir(t);
  const config = loadConfig({ argv: ['--port', '0'], env: { SKP_DATA_DIR: path.join(root, 'data'), SKP_CONFIG_DIR: path.join(root, 'config') } });
  const platform = await startPlatform(config, { log: memoryLogger().log, templateDirs: [FIXTURE_TEMPLATES], connectors: { random: () => 0.5 } });
  defer(t, () => platform.stop());
  const H = signedIn(platform, { 'content-type': 'application/json' });
  const api = async (method, p, body) => {
    const r = await fetch(`${platform.url}/api/v1${p}`, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  return { ms, platform, api };
}

async function connect({ ms, api, platform }, { profileId = null } = {}) {
  const token = ms.addToken({ profileId });
  const r = await api('POST', '/connections', { connector: 'ctd-multistream', config: { baseUrl: `${ms.url}/api/v1` }, secrets: { token } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const get = () => platform.connectors.get(r.body.id);
  await until(() => running(get().health.status) && (profileId ? get().info?.profile : get().info?.profiles?.length === 2), 8000, 'connected');
  return { id: r.body.id, get };
}
// A feed's (a profile's) values, as the connection shows them.
const feedState = (get, profile) => get().feeds?.find((f) => f.profile === profile)?.state || {};
const changesOf = (platform, key) => {
  const seen = [];
  platform.bus.subscribeAll((env) => { if (env.type === 'state.changed' && env.data.key === key) seen.push(env.data.value); });
  return seen;
};

test('every profile: OBS scenes read on connecting, then kept by events, per profile and canvas; outputs say streaming and recording', { timeout: 60000 }, async (t) => {
  const ctx = await start(t, (ms) => {
    // What OBS showed before this platform connected: GET /profiles/<id>/obs has it.
    ms.obsScene({ canvas: 'landscape', scene: 'Live', sceneUuid: 'u-live', atMs: 1000, emit: false });
    ms.obsScene({ canvas: 'vertical', scene: 'Takeover V', atMs: 1000, emit: false });
    ms.obsOutput({ output: 'main', canvas: 'landscape', state: 'live', emit: false });
    ms.obsScene({ profile: 'p-dprtmnt', canvas: 'landscape', scene: 'Starting', atMs: 1000, emit: false });
    // An OBS machine that went away: its scene is stale, left out.
    ms.obsScene({ profile: 'p-dprtmnt', appId: 'ctd-obs-plugin-old', canvas: 'vertical', scene: 'Old', atMs: 5000, emit: false });
    ms.obsOffline('ctd-obs-plugin-old', 'p-dprtmnt');
  });
  const { ms, platform } = ctx;
  const { id, get } = await connect(ctx);
  assert.ok(ms.requests.some((r) => r.path === '/api/v1/profiles/default/obs') && ms.requests.some((r) => r.path === '/api/v1/profiles/p-dprtmnt/obs'), 'read per profile');
  assert.ok(ms.requests.find((r) => r.path === '/api/v1/events').query.types.split(',').includes('obs.scene'), 'subscribed to obs.scene');
  const miami = feedState(get, 'default');
  assert.deepEqual([miami['obs.scene.landscape'].scene, miami['obs.scene.landscape'].sceneUuid, miami['obs.scene.landscape'].appId], ['Live', 'u-live', 'ctd-obs-plugin-studio']);
  assert.equal(typeof miami['obs.scene.landscape'].since, 'number');
  assert.deepEqual([miami['obs.scene.vertical'].scene, miami['obs.scene'], miami['obs.streaming'], miami['obs.recording']], ['Takeover V', 'Live', true, false]);
  const dprtmnt = feedState(get, 'p-dprtmnt');
  assert.deepEqual([dprtmnt['obs.scene.landscape'].scene, 'obs.scene.vertical' in dprtmnt, 'obs.streaming' in dprtmnt], ['Starting', false, false], 'its own, the offline machine left out');
  // Owned by each profile's feed, src.platform obs.
  const e = platform.bus.entriesOf('obs.scene.landscape').map((x) => x.owner).sort();
  assert.deepEqual(e, [`${id}/default`, `${id}/p-dprtmnt`]);

  // A change on Miami or Bust's vertical canvas: only there.
  ms.obsScene({ canvas: 'vertical', scene: 'BRB V', previous: 'Takeover V', atMs: 2000 });
  await until(() => feedState(get, 'default')['obs.scene.vertical']?.scene === 'BRB V', 5000, 'the vertical change');
  assert.equal(feedState(get, 'default')['obs.scene.landscape'].scene, 'Live');
  assert.equal(feedState(get, 'p-dprtmnt')['obs.scene.landscape'].scene, 'Starting');
  // DPRTMNT changes: Miami or Bust doesn't.
  ms.obsScene({ profile: 'p-dprtmnt', canvas: 'landscape', scene: 'Live', previous: 'Starting', atMs: 2000 });
  await until(() => feedState(get, 'p-dprtmnt')['obs.scene.landscape']?.scene === 'Live', 5000, 'DPRTMNT live');
  // Recording starts, then streaming stops.
  ms.obsOutput({ output: 'record', state: 'live' });
  await until(() => feedState(get, 'default')['obs.recording'] === true, 5000, 'recording');
  ms.obsOutput({ output: 'main', canvas: 'landscape', state: 'stopped' });
  await until(() => feedState(get, 'default')['obs.streaming'] === false, 5000, 'streaming stopped');
  assert.equal(feedState(get, 'p-dprtmnt')['obs.recording'], undefined, 'DPRTMNT\'s OBS said nothing about its outputs');

  // The show's stream says what OBS shows, per profile.
  platform.overlays.create({ slug: 'miami', template: { id: 'dev.skp.testbed', version: '1.0.0' }, settings: {}, connections: [`${id}/default`] });
  const show = platform.shows.create({ name: 'Miami', overlays: ['miami'], date: '2026-10-17', timezone: 'America/Toronto' }, { actor: 'test' });
  const stream = (await ctx.api('GET', `/shows/${show.id}`)).body.stream;
  assert.deepEqual(stream.obs.map((o) => [o.source, o.name, o.landscape.scene, o.vertical.scene, o.streaming, o.recording]), [[`${id}/default`, 'Relay · Miami or Bust', 'Live', 'BRB V', false, true]]);
  assert.deepEqual(stream.obs[0].seen.vertical.map((s) => s.scene), ['BRB V', 'Takeover V'], 'the scenes it has shown, newest first');
  assert.match(stream.obs[0].landscape.since, /^\d{4}-\d\d-\d\dT/);

  // A deleted profile takes its OBS values with it.
  ms.deleteProfile('p-dprtmnt');
  await until(() => platform.bus.entriesOf('obs.scene.landscape').length === 1, 5000, 'DPRTMNT\'s OBS gone');
});

test('ordering by atMs per OBS machine and canvas, duplicates dropped by eventId, the 60 s resend changes nothing; two machines: the most recent shows', { timeout: 60000 }, async (t) => {
  const ctx = await start(t, (ms) => ms.obsScene({ canvas: 'landscape', scene: 'Live', atMs: 10_000, emit: false }));
  const { ms, platform } = ctx;
  const { get } = await connect(ctx);
  const changes = changesOf(platform, 'obs.scene.landscape');
  const scene = () => feedState(get, 'default')['obs.scene.landscape']?.scene;
  assert.equal(scene(), 'Live');

  // Resent by Relay every 60 s without `previous`: the same scene, nothing changes.
  ms.obsScene({ canvas: 'landscape', scene: 'Live', atMs: 70_000 });
  // An older change (atMs before the one it has) arriving late: ignored.
  ms.obsScene({ canvas: 'landscape', scene: 'BRB', previous: 'Starting', atMs: 5_000 });
  // The real change, then the same event again (its eventId): once.
  ms.obsScene({ canvas: 'landscape', scene: 'Cam 2', previous: 'Live', atMs: 80_000, eventId: 'ev-1' });
  ms.obsScene({ canvas: 'landscape', scene: 'Cam 3', previous: 'Cam 2', atMs: 90_000, eventId: 'ev-1' });
  await until(() => scene() === 'Cam 2', 5000, 'Cam 2');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(scene(), 'Cam 2', 'the duplicate eventId was dropped');
  assert.deepEqual(changes.map((v) => v.scene), ['Cam 2'], 'one change only: no resend, no late or duplicate event');
  // A resync that differs (a change this platform missed) is taken.
  ms.obsScene({ canvas: 'landscape', scene: 'Cam 3', atMs: 95_000 });
  await until(() => scene() === 'Cam 3', 5000, 'the resync that differs');

  // A second OBS machine on the same profile: its newer change shows; an older one from it doesn't.
  ms.obsScene({ appId: 'ctd-obs-plugin-laptop', canvas: 'landscape', scene: 'Laptop', previous: 'X', atMs: 96_000 });
  await until(() => scene() === 'Laptop', 5000, 'the laptop\'s');
  assert.equal(feedState(get, 'default')['obs.scene.landscape'].appId, 'ctd-obs-plugin-laptop');
  ms.obsScene({ canvas: 'landscape', scene: 'Studio again', previous: 'Cam 3', atMs: 97_000 });
  await until(() => scene() === 'Studio again', 5000, 'the studio\'s, newer');
  ms.obsScene({ appId: 'ctd-obs-plugin-laptop', canvas: 'landscape', scene: 'Laptop 2', previous: 'Laptop', atMs: 96_500 });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(scene(), 'Studio again', 'the laptop\'s change is older than the studio\'s last');
  assert.equal(feedState(get, 'default')['obs.scene'], 'Studio again', 'obs.scene: the landscape scene\'s name');
});

test('each canvas\'s whole scene list (v1.6): read on connecting, kept by events, a list-only change taken, an event without a list keeps it; the stream says it', { timeout: 60000 }, async (t) => {
  const LIST = [{ name: 'Starting', uuid: 'u-start' }, { name: 'Live', uuid: 'u-live' }, { name: 'BRB', uuid: 'u-brb' }];
  const ctx = await start(t, (ms) => ms.obsScene({ canvas: 'landscape', scene: 'Live', sceneUuid: 'u-live', scenes: LIST, atMs: 1000, emit: false }));
  const { ms, platform } = ctx;
  const { id, get } = await connect(ctx);
  const list = (canvas = 'landscape') => feedState(get, 'default')[`obs.scenes.${canvas}`];
  assert.deepEqual(list(), [{ scene: 'Starting', sceneUuid: 'u-start' }, { scene: 'Live', sceneUuid: 'u-live' }, { scene: 'BRB', sceneUuid: 'u-brb' }], 'from GET …/obs, in OBS\'s order');
  assert.equal(list('vertical'), undefined, 'none sent for the vertical canvas');
  assert.equal(feedState(get, 'p-dprtmnt')['obs.scenes.landscape'], undefined, 'DPRTMNT\'s OBS sent none');

  // A scene added in OBS: the plugin sends the same scene with the new list (a list-only change).
  const changes = changesOf(platform, 'obs.scene.landscape');
  ms.obsScene({ canvas: 'landscape', scene: 'Live', sceneUuid: 'u-live', scenes: [...LIST, { name: 'Ending' }, { name: 'BRB' }, { nope: 1 }], atMs: 2000 });
  await until(() => list()?.length === 4, 5000, 'the new list');
  assert.deepEqual(list()[3], { scene: 'Ending' }, 'no uuid, none said; a name once; a bad entry left out');
  assert.deepEqual(changes, [], 'the scene itself didn\'t change');

  // An older plugin's event (no list): the scene changes, the list stays.
  ms.obsScene({ canvas: 'landscape', scene: 'BRB', sceneUuid: 'u-brb', previous: 'Live', atMs: 3000 });
  await until(() => feedState(get, 'default')['obs.scene.landscape']?.scene === 'BRB', 5000, 'BRB');
  assert.equal(list().length, 4);

  platform.overlays.create({ slug: 'miami', template: { id: 'dev.skp.testbed', version: '1.0.0' }, settings: {}, connections: [`${id}/default`] });
  const show = platform.shows.create({ name: 'Miami', overlays: ['miami'], date: '2026-10-17', timezone: 'America/Toronto' }, { actor: 'test' });
  const stream = (await ctx.api('GET', `/shows/${show.id}`)).body.stream;
  assert.deepEqual(stream.obs[0].scenes.landscape.map((s) => s.scene), ['Starting', 'Live', 'BRB', 'Ending']);
  assert.equal(stream.obs[0].scenes.vertical, undefined);
});

test('a connection limited to one profile has OBS as its own values; an older Relay (no OBS) still connects', { timeout: 60000 }, async (t) => {
  const ctx = await start(t, (ms) => ms.obsScene({ profile: 'p-dprtmnt', canvas: 'vertical', scene: 'Vert', atMs: 1, emit: false }));
  const { ms, platform } = ctx;
  const { id, get } = await connect(ctx, { profileId: 'p-dprtmnt' });
  assert.equal(get().state['obs.scene.vertical'].scene, 'Vert');
  assert.deepEqual(platform.bus.entriesOf('obs.scene.vertical').map((e) => e.owner), [id]);
  ms.obsScene({ profile: 'p-dprtmnt', canvas: 'vertical', scene: 'Vert 2', previous: 'Vert', atMs: 2 });
  await until(() => get().state['obs.scene.vertical']?.scene === 'Vert 2', 5000, 'its change');

  ms.noObsRoute = true;
  const { get: older } = await connect(ctx, { profileId: 'default' });
  assert.ok(running(older().health.status));
  assert.equal(older().state['obs.scene.landscape'], undefined);
});
