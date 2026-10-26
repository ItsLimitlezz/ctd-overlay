// Follow OBS (PLAN step 18, 09 §9.7): a show, or an overlay outside a show, takes the scene mapped to
// the OBS program scene its connection reports (obs.scene.<canvas>, a feed's state). Only a real
// change acts: the first scene seen, Relay's resend of the same scene, an unmapped scene, a scene
// on already and a show that doesn't follow change nothing; the operator's take still works and
// the next OBS change applies again; a vertical show follows the vertical canvas; a scene renamed
// in OBS still maps by its uuid; with several OBS feeding a show one must be picked; every take is
// in the audit log as "obs". The API checks followObs (scenes the members have, names ≤ 200,
// known fields) and takes it with If-Match, on shows and on overlays.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { startPlatform } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { cleanFollowObs, mappedScene } from '../src/obs/mapping.js';
import { defer, FIXTURE_TEMPLATES, memoryLogger, signedIn, tempDir, TESTBED } from './helpers.js';

const SHOW = { date: '2026-10-17', timezone: 'America/Toronto' };
const codeOf = (problem) => String(problem?.type || '').split('/').pop();
const RELAY = 'con_01JRELAY0000000000000000000';
const feed = (profile) => ({ connector: 'ctd-multistream', connection: RELAY, platform: 'obs', ...(profile ? { profile } : {}) });

async function start(t) {
  const root = tempDir(t);
  const config = loadConfig({ argv: ['--port', '0'], env: { SKP_DATA_DIR: path.join(root, 'data'), SKP_CONFIG_DIR: path.join(root, 'config') } });
  const platform = await startPlatform(config, { log: memoryLogger().log, templateDirs: [FIXTURE_TEMPLATES] });
  defer(t, () => platform.stop());
  const api = async (method, p, body, headers = {}) => {
    const r = await fetch(`${platform.url}/api/v1${p}`, { method, headers: signedIn(platform, { 'content-type': 'application/json', ...headers }), body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null), etag: r.headers.get('etag') };
  };
  // What OBS shows on a canvas, as a connection's feed reports it.
  const obs = (canvas, scene, { profile = 'p1', sceneUuid } = {}) => platform.bus.setState(`obs.scene.${canvas}`, { scene, ...(sceneUuid ? { sceneUuid } : {}), appId: 'ctd-obs-plugin-studio', since: Date.now() }, { src: feed(profile) });
  const audits = () => platform.audit.list({ limit: 100, action: 'obs.follow' }).items;
  return { platform, api, obs, audits };
}
const MAP = [{ obsScene: 'Live', scene: 'program' }, { obsScene: 'BRB', obsSceneUuid: 'u-brb', scene: 'brb' }, { obsScene: 'Lineup', scene: 'lineup' }];

test('followObs is checked: scenes its members have, OBS names of at most 200, known fields; uuid first, then the name, then otherwise', () => {
  const sceneOk = (s) => ['program', 'brb', 'starting'].includes(s);
  const bad = (msg) => { throw new Error(msg); };
  const ok = cleanFollowObs({ enabled: true, map: [{ obsScene: 'Live', scene: 'program' }], otherwise: '' }, { sceneOk, bad });
  assert.deepEqual(ok, { enabled: true, canvas: 'landscape', map: [{ obsScene: 'Live', scene: 'program' }] });
  assert.equal(cleanFollowObs(null, { sceneOk, bad }), null);
  for (const [input, re] of [
    [{ map: [{ obsScene: 'Live', scene: 'nope' }] }, /no overlay's template here has a scene "nope"/],
    [{ map: [{ obsScene: 'x'.repeat(201), scene: 'brb' }] }, /at most 200/],
    [{ map: [{ obsScene: 'Live', scene: 'brb', extra: 1 }] }, /unknown field extra/],
    [{ map: [{ obsScene: 'Live', scene: 'brb' }, { obsScene: 'Live', scene: 'program' }] }, /twice/],
    [{ canvas: 'square' }, /landscape" or "vertical/],
    [{ enabled: 'yes' }, /true or false/],
    [{ source: 'has space' }, /whose OBS/],
    [{ otherwise: 'nope' }, /otherwise.*"nope"/],
    [{ mapping: [] }, /unknown field mapping/],
    [[], /followObs/],
  ]) assert.throws(() => cleanFollowObs(input, { sceneOk, bad }), re, JSON.stringify(input).slice(0, 60));
  const f = { map: [{ obsScene: 'BRB', obsSceneUuid: 'u1', scene: 'brb' }, { obsScene: 'Live', scene: 'program' }], otherwise: 'starting' };
  assert.equal(mappedScene(f, { scene: 'Renamed BRB', sceneUuid: 'u1' }), 'brb', 'by uuid');
  assert.equal(mappedScene(f, { scene: 'BRB', sceneUuid: 'u-other' }), 'brb', 'made again: by name');
  assert.equal(mappedScene(f, { scene: 'Live' }), 'program');
  assert.equal(mappedScene(f, { scene: 'Cam 2' }), 'starting', 'otherwise');
  assert.equal(mappedScene({ ...f, otherwise: undefined }, { scene: 'Cam 2' }), undefined, 'unmapped: as it is');
});

test('a show follows the OBS scene on a real change only; unmapped leaves it; the operator\'s take still works; the audit log says "obs"', { timeout: 60000 }, async (t) => {
  const { platform, api, obs, audits } = await start(t);
  platform.overlays.create({ slug: 'room-h', template: TESTBED, settings: {} });
  platform.overlays.create({ slug: 'room-v', template: TESTBED, settings: {} });
  const show = platform.shows.create({ name: 'Room', overlays: ['room-h', 'room-v'], ...SHOW }, { actor: 'test' });
  const sceneOf = () => platform.shows.get(show.id).scene;
  const onAir = (slug) => platform.overlays.resolve(slug).channel.snapshot().state['show.scene'];

  // Turned on through the API, with If-Match.
  const read = await api('GET', `/shows/${show.id}`);
  const on = await api('PATCH', `/shows/${show.id}`, { followObs: { enabled: true, map: MAP } }, { 'if-match': read.etag });
  assert.equal(on.status, 200, JSON.stringify(on.body));
  assert.deepEqual(on.body.followObs, { enabled: true, canvas: 'landscape', map: MAP });
  assert.equal(on.body.rev, read.body.rev + 1, 'an edit: the ETag moves');

  // The first scene seen after a start: nothing (no change yet).
  obs('landscape', 'Live');
  assert.equal(sceneOf(), undefined);
  // A real change: BRB → brb, on both members.
  obs('landscape', 'BRB', { sceneUuid: 'u-brb' });
  assert.equal(sceneOf(), 'brb');
  assert.deepEqual([onAir('room-h'), onAir('room-v')], ['brb', 'brb']);
  const after = (await api('GET', `/shows/${show.id}`)).body;
  assert.deepEqual([after.sceneByObs.obsScene, after.sceneByObs.canvas, after.sceneByObs.source], ['BRB', 'landscape', `${RELAY}/p1`]);
  assert.match(after.sceneByObs.at, /^\d{4}-\d\d-\d\dT/);
  assert.equal(after.rev, on.body.rev, 'a take is live control: the ETag stays');
  const [entry] = audits();
  assert.deepEqual([entry.actor, entry.action, entry.target, entry.details.scene, entry.details.obsScene, entry.details.canvas, entry.details.source], ['obs', 'obs.follow', show.id, 'brb', 'BRB', 'landscape', `${RELAY}/p1`]);
  // The same again (Relay's resend, the since moved): no take.
  obs('landscape', 'BRB', { sceneUuid: 'u-brb' });
  assert.equal(audits().length, 1);
  // Renamed in OBS, same uuid: still brb, which is on: no take.
  obs('landscape', 'Be Right Back', { sceneUuid: 'u-brb' });
  assert.equal(audits().length, 1);
  // Unmapped: as it is.
  obs('landscape', 'Cam 2');
  assert.equal(sceneOf(), 'brb');
  // The vertical canvas doesn't drive a landscape-following show.
  obs('vertical', 'Live V', { profile: 'p1' });
  obs('vertical', 'Lineup', { profile: 'p1' });
  assert.equal(sceneOf(), 'brb');
  // The operator takes a scene: it stays until OBS changes again.
  const taken = await api('PUT', `/shows/${show.id}/scene`, { scene: 'starting' });
  assert.equal(taken.status, 200);
  assert.equal(taken.body.sceneByObs, undefined, 'the operator\'s take: not OBS\'s');
  obs('landscape', 'Live');
  assert.equal(sceneOf(), 'program');
  assert.equal(audits().length, 2);
  // "Otherwise": an unmapped scene takes it.
  const cur = await api('GET', `/shows/${show.id}`);
  assert.equal((await api('PATCH', `/shows/${show.id}`, { followObs: { ...cur.body.followObs, otherwise: 'outro' } }, { 'if-match': cur.etag })).status, 200);
  obs('landscape', 'Cam 3');
  assert.equal(sceneOf(), 'outro');
  // Turned off: nothing happens.
  const cur2 = await api('GET', `/shows/${show.id}`);
  assert.equal((await api('PATCH', `/shows/${show.id}`, { followObs: { ...cur2.body.followObs, enabled: false } }, { 'if-match': cur2.etag })).status, 200);
  obs('landscape', 'BRB', { sceneUuid: 'u-brb' });
  assert.equal(sceneOf(), 'outro');
  assert.equal(audits().length, 3);
  // null removes it.
  const cur3 = await api('GET', `/shows/${show.id}`);
  const cleared = await api('PATCH', `/shows/${show.id}`, { followObs: null }, { 'if-match': cur3.etag });
  assert.equal(cleared.body.followObs, undefined);
});

test('a vertical show follows the vertical canvas; an overlay outside a show follows its own; several OBS: one must be picked', { timeout: 60000 }, async (t) => {
  const { platform, api, obs, audits } = await start(t);
  platform.overlays.create({ slug: 'vert', template: TESTBED, settings: {} });
  platform.overlays.create({ slug: 'solo', template: TESTBED, settings: {}, connections: [`${RELAY}/p2`] });
  const show = platform.shows.create({ name: 'Vertical', overlays: ['vert'], ...SHOW, followObs: { enabled: true, canvas: 'vertical', map: [{ obsScene: 'BRB V', scene: 'brb' }] } }, { actor: 'test' });
  obs('vertical', 'Main V');
  obs('landscape', 'Main');
  obs('landscape', 'BRB V');
  assert.equal(platform.shows.get(show.id).scene, undefined, 'the landscape canvas doesn\'t drive it');
  obs('vertical', 'BRB V');
  assert.equal(platform.shows.get(show.id).scene, 'brb');

  // The overlay outside a show, fed by profile p2 only.
  const solo = await api('GET', '/overlays/solo');
  const set = await api('PATCH', '/overlays/solo', { followObs: { enabled: true, map: [{ obsScene: 'Live', scene: 'program' }] } }, { 'if-match': solo.etag });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  assert.deepEqual(set.body.followObs, { enabled: true, canvas: 'landscape', map: [{ obsScene: 'Live', scene: 'program' }] });
  obs('landscape', 'Starting', { profile: 'p2' });
  obs('landscape', 'Live', { profile: 'p1' }); // not its feed
  assert.equal(platform.shows.overlayScene(set.body.id)?.scene, undefined);
  obs('landscape', 'Live', { profile: 'p2' });
  assert.equal(platform.shows.overlayScene(set.body.id).scene, 'program');
  assert.equal(platform.overlays.resolve('solo').channel.snapshot().state['show.scene'], 'program');
  const read = (await api('GET', '/overlays/solo')).body;
  assert.deepEqual([read.sceneByObs.obsScene, read.sceneByObs.source], ['Live', `${RELAY}/p2`]);
  assert.deepEqual(audits().map((a) => a.target), ['solo', show.id]);

  // A show fed by every connection, with two OBS (p1 and p2): turning it on needs a pick.
  platform.overlays.create({ slug: 'both', template: TESTBED, settings: {} });
  const two = (await api('POST', '/shows', { name: 'Two', overlays: ['both'], ...SHOW })).body;
  const r = await api('GET', `/shows/${two.id}`);
  const refused = await api('PATCH', `/shows/${two.id}`, { followObs: { enabled: true, map: [{ obsScene: 'Live', scene: 'program' }] } }, { 'if-match': r.etag });
  assert.equal(refused.status, 422);
  assert.equal(codeOf(refused.body), 'pick-obs');
  assert.match(refused.body.detail, new RegExp(`${RELAY}/p1, ${RELAY}/p2`));
  const picked = await api('PATCH', `/shows/${two.id}`, { followObs: { enabled: true, source: `${RELAY}/p1`, map: [{ obsScene: 'Live', scene: 'program' }, { obsScene: 'BRB', scene: 'brb' }] } }, { 'if-match': r.etag });
  assert.equal(picked.status, 200, JSON.stringify(picked.body));
  obs('landscape', 'BRB', { profile: 'p2' });
  assert.equal(platform.shows.get(two.id).scene, undefined, 'p2 isn\'t the one it follows');
  obs('landscape', 'BRB', { profile: 'p1' });
  assert.equal(platform.shows.get(two.id).scene, 'brb');
  // The same for an overlay fed by every connection.
  const both = await api('GET', '/overlays/both');
  assert.equal((await api('PATCH', '/overlays/both', { followObs: { enabled: true, map: [] } }, { 'if-match': both.etag })).status, 422, 'in a show or not, two OBS need a pick');
});

test('the API refuses what doesn\'t fit, and a followObs read and sent back is taken; If-Match guards it', { timeout: 60000 }, async (t) => {
  const { platform, api } = await start(t);
  platform.overlays.create({ slug: 'one', template: TESTBED, settings: {} });
  const show = (await api('POST', '/shows', { name: 'Night', overlays: ['one'], ...SHOW, followObs: { enabled: false, canvas: 'vertical', map: [{ obsScene: 'Live', scene: 'program' }] } })).body;
  assert.deepEqual(show.followObs, { enabled: false, canvas: 'vertical', map: [{ obsScene: 'Live', scene: 'program' }] });
  const r = await api('GET', `/shows/${show.id}`);
  for (const [followObs, code] of [
    [{ map: [{ obsScene: 'Live', scene: 'nope' }] }, 'unknown-scene'],
    [{ map: [{ obsScene: 'L'.repeat(201), scene: 'brb' }] }, 'invalid'],
    [{ map: [{ obsScene: 'Live', scene: 'brb', why: 1 }] }, 'unknown-field'],
    [{ enabled: true, extra: 1 }, 'unknown-field'],
    ['on', 'invalid'],
  ]) {
    const x = await api('PATCH', `/shows/${show.id}`, { followObs }, { 'if-match': r.etag });
    assert.deepEqual([x.status, codeOf(x.body)], [422, code], JSON.stringify(followObs).slice(0, 50));
  }
  // Read and sent back whole.
  const back = await api('PATCH', `/shows/${show.id}`, { followObs: r.body.followObs }, { 'if-match': r.etag });
  assert.equal(back.status, 200);
  // A stale If-Match: 412.
  assert.equal((await api('PATCH', `/shows/${show.id}`, { followObs: null }, { 'if-match': r.etag })).status, 412);
  // The overlay: its own template's scenes.
  const o = await api('GET', '/overlays/one');
  const bad = await api('PATCH', '/overlays/one', { followObs: { map: [{ obsScene: 'Live', scene: 'nope' }] } }, { 'if-match': o.etag });
  assert.deepEqual([bad.status, codeOf(bad.body)], [422, 'unknown-scene']);
  assert.equal((await api('PATCH', '/overlays/one', { followObs: { enabled: false } }, { 'if-match': '"1"' })).status, 412);
  const ok = await api('PATCH', '/overlays/one', { followObs: { enabled: false, otherwise: 'brb' } }, { 'if-match': o.etag });
  assert.deepEqual([ok.status, ok.body.followObs], [200, { enabled: false, canvas: 'landscape', map: [], otherwise: 'brb' }]);
  assert.equal(ok.body.rev, o.body.rev + 1);
  // The OpenAPI document declares it.
  const doc = await (await fetch(`${platform.url}/api/v1/openapi.json`)).json();
  const schema = (p, m) => doc.paths[p][m].requestBody.content['application/json'].schema.properties.followObs;
  assert.deepEqual(Object.keys(schema('/api/v1/shows/{ref}', 'patch').properties), ['enabled', 'canvas', 'source', 'map', 'otherwise']);
  assert.deepEqual(Object.keys(schema('/api/v1/overlays/{ref}', 'patch').properties), ['enabled', 'canvas', 'source', 'map', 'otherwise']);
});
