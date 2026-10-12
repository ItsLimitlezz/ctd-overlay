// Shows (01 §1.3, 09 §9.1): member overlays that share a scene, server-timed triggers and timed
// scenes, the show state templates read, REC, and the local control API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import path from 'node:path';
import { startPlatform } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { TRIGGER_LEAD_MS } from '../src/shows/registry.js';
import { defer, FIXTURE_TEMPLATES, memoryLogger, signedIn, tempDir, TESTBED } from './helpers.js';

const MIN = 60000;
const TAKEOVER = { id: 'com.dprtmnt.takeover', version: '1.0.0' };

// A platform with two testbed overlays (a horizontal and a vertical feed) and a third outside any
// show, every envelope each one's channel sends, and a way to restart on the same data.
async function setup(t, { dataRoot = tempDir(t) } = {}) {
  const config = loadConfig({ argv: ['--port', '0'], env: { SKP_DATA_DIR: path.join(dataRoot, 'data'), SKP_CONFIG_DIR: path.join(dataRoot, 'config') } });
  const { log, entries } = memoryLogger();
  const platform = await startPlatform(config, { log, templateDirs: [FIXTURE_TEMPLATES] });
  defer(t, () => platform.stop());
  const got = {};
  const watch = (slug) => {
    got[slug] = [];
    platform.overlays.resolve(slug).channel.subscribe((env) => got[slug].push(env));
  };
  const local = (slug) => platform.overlays.resolve(slug).channel.snapshot().state;
  const api = (method, url, body, headers = {}) => fetch(`${platform.url}/api/v1${url}`, {
    method,
    headers: signedIn(platform, body === undefined ? headers : { 'content-type': 'application/json', ...headers }),
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (res) => ({ status: res.status, type: res.headers.get('content-type'), body: await res.json().catch(() => null) }));
  return { platform, config, entries, got, watch, local, api, dataRoot };
}

function overlaysFor(platform, slugs = ['main-h', 'main-v', 'solo']) {
  for (const slug of slugs) platform.overlays.create({ slug, template: TESTBED, settings: {} });
}

const LINEUP = [
  { time: '22:30', name: 'Manzone & strong' },
  { time: '01:00', name: 'VIKKSTAR', headliner: true, logo: '/media/0123456789abcdef0123456789abcdef/vik.png' },
  { time: '03:00', name: 'Deecee', b2b: 'quim', closer: true },
];
const SHOW = { name: 'Saturday TAKEOVER', overlays: ['main-h', 'main-v'], date: '2026-08-28', timezone: 'America/Toronto', dayBoundary: '12:00', goLive: '22:30', lineup: LINEUP };

test('a show publishes its state to its members only, with instants the server resolved', async (t) => {
  const { platform, local, entries } = await setup(t);
  overlaysFor(platform);
  const show = platform.shows.create(SHOW);
  assert.match(show.id, /^show_/);
  assert.deepEqual(show.members, ['main-h', 'main-v']);
  for (const slug of ['main-h', 'main-v']) {
    const s = local(slug);
    assert.deepEqual(s['show.lineup'].map((x) => [x.name, new Date(x.startAt).toISOString()]), [
      ['Manzone & strong', '2026-08-29T02:30:00.000Z'],
      ['VIKKSTAR', '2026-08-29T05:00:00.000Z'],
      ['Deecee', '2026-08-29T07:00:00.000Z'],
    ]);
    assert.equal(s['show.lineup'][1].logo, LINEUP[1].logo);
    assert.equal(s['show.headliner'], 'VIKKSTAR');
    assert.equal(s['show.date'], '2026-08-28');
    assert.equal(new Date(s['show.goLiveAt']).toISOString(), '2026-08-29T02:30:00.000Z');
    assert.equal('show.recStartedAt' in s, false, 'not live yet: absent, never 0');
    assert.equal('show.currentSlot' in s, false);
  }
  assert.equal('show.lineup' in local('solo'), false, 'an overlay outside the show sees none of it');
  assert.equal(platform.bus.getState('show.lineup'), undefined, 'nothing global: two shows never share state');
  assert.ok(entries.some((e) => e.msg === 'show created'));
  // A lineup time that a clock change skipped is flagged for the operator (09 §9.2).
  const dst = platform.shows.update(show.id, { date: '2026-03-07', lineup: [{ time: '02:30', name: 'Gap' }] });
  assert.equal(dst.lineup[0].clockGap, true);
  assert.equal(new Date(dst.lineup[0].startAt).toISOString(), '2026-03-08T07:30:00.000Z');
});

test('a take changes every member together: the take event with its transition, then the scene state', async (t) => {
  const { platform, got, watch, local } = await setup(t);
  overlaysFor(platform);
  const show = platform.shows.create(SHOW);
  for (const slug of ['main-h', 'main-v', 'solo']) watch(slug);
  platform.shows.take(show.id, 'brb', { transition: 'cut' });
  platform.shows.take(show.id, 'program');
  for (const slug of ['main-h', 'main-v']) {
    const takes = got[slug].filter((e) => e.type === 'show.scene.changed').map((e) => e.data);
    assert.deepEqual(takes, [{ scene: 'brb', transition: 'cut' }, { scene: 'program', prev: 'brb', transition: 'fade' }]);
    assert.equal(local(slug)['show.scene'], 'program');
  }
  assert.deepEqual(got.solo, []);
  assert.equal(platform.shows.get(show.id).scene, 'program');
  assert.throws(() => platform.shows.take(show.id, 'nope'), { code: 'unknown-scene' });
  assert.throws(() => platform.shows.take(show.id, 'brb', { transition: 'Fade In!' }), { code: 'invalid' });
});

test('a timed scene returns on the server, even across a restart in the middle of it', async (t) => {
  const dataRoot = tempDir(t);
  const first = await setup(t, { dataRoot });
  overlaysFor(first.platform);
  const show = first.platform.shows.create(SHOW);
  first.watch('main-h');
  first.platform.shows.take(show.id, 'headliner'); // 1 s, then program (the testbed's timed scene)
  await new Promise((r) => setTimeout(r, 1400));
  assert.equal(first.local('main-h')['show.scene'], 'program');
  assert.deepEqual(first.got['main-h'].filter((e) => e.type === 'show.scene.changed').map((e) => e.data.scene), ['headliner', 'program']);
  // Taken again, then the platform stops mid-scene and starts after the return was due.
  first.platform.shows.take(show.id, 'headliner');
  await first.platform.stop();
  await new Promise((r) => setTimeout(r, 1200));
  const second = await setup(t, { dataRoot });
  assert.equal(second.platform.shows.get(show.id).scene, 'program', 'the return that was due happened at startup');
  assert.equal(second.local('main-h')['show.scene'], 'program');
  // Taking something else first cancels a pending return.
  second.platform.shows.take(show.id, 'headliner');
  second.platform.shows.take(show.id, 'brb');
  await new Promise((r) => setTimeout(r, 1300));
  assert.equal(second.platform.shows.get(show.id).scene, 'brb');
});

test('REC: anchored at the first program take or at go-live under "auto", cleared by starting; live means REC runs', async (t) => {
  const { platform, local } = await setup(t);
  overlaysFor(platform);
  const show = platform.shows.create({ ...SHOW, date: new Date().toISOString().slice(0, 10) });
  platform.shows.take(show.id, 'starting');
  assert.equal(platform.shows.get(show.id).live, false);
  const t0 = Date.now();
  platform.shows.take(show.id, 'program');
  const rec = platform.shows.get(show.id).recStartedAt;
  assert.ok(rec >= t0 && rec <= Date.now());
  assert.equal(local('main-v')['show.recStartedAt'], rec);
  assert.equal(platform.shows.onAir(platform.overlays.resolve('main-h').doc.id), true);
  assert.equal(platform.shows.onAir(platform.overlays.resolve('solo').doc.id), false);
  platform.shows.take(show.id, 'brb');
  platform.shows.take(show.id, 'program');
  assert.equal(platform.shows.get(show.id).recStartedAt, rec, 'a second program take keeps the anchor');
  platform.shows.take(show.id, 'starting');
  assert.equal('show.recStartedAt' in local('main-h'), false);
  assert.equal(platform.shows.get(show.id).live, false);
  platform.shows.rec(show.id, 'start');
  assert.equal(platform.shows.get(show.id).live, true);
  platform.shows.rec(show.id, 'reset');
  assert.equal(platform.shows.get(show.id).live, false);
});

// A show date and HH:MM in UTC for an instant (shows' times are minutes).
function utcShow(at) {
  const iso = new Date(at).toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 16), timezone: 'UTC', dayBoundary: '00:00' };
}

test('"auto" taken after go-live is live from go-live', async (t) => {
  const { platform, local } = await setup(t);
  // The testbed has no "auto" scene; the TAKEOVER template does.
  platform.overlays.create({ slug: 'tk', template: TAKEOVER, settings: {} });
  const g = utcShow(Date.now() - 2 * MIN);
  const show = platform.shows.create({ name: 'Auto', overlays: ['tk'], date: g.date, timezone: g.timezone, dayBoundary: g.dayBoundary, goLive: g.time });
  const at = platform.shows.get(show.id).goLiveAt;
  platform.shows.take(show.id, 'auto');
  assert.equal(platform.shows.get(show.id).recStartedAt, at);
  assert.equal(local('tk')['show.recStartedAt'], at);
});

test('"auto" on air before go-live goes live at go-live on the server, with no take (fake clock)', async (t) => {
  const { platform } = await setup(t);
  platform.overlays.create({ slug: 'tk', template: TAKEOVER, settings: {} });
  // A second registry over the same data, on a hand-cranked clock.
  const { createShows } = await import('../src/shows/registry.js');
  let clock = Date.UTC(2026, 9, 17, 2, 0);
  const pending = [];
  const timers = {
    setTimeout(fn, ms) { const h = { at: clock + ms, fn }; pending.push(h); return h; },
    clearTimeout(h) { const i = pending.indexOf(h); if (i >= 0) pending.splice(i, 1); },
  };
  // Time moves to each timer as it fires, as it would.
  const advance = (ms) => {
    const until = clock + ms;
    for (;;) {
      const due = pending.filter((h) => h.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      pending.splice(pending.indexOf(due), 1);
      clock = Math.max(clock, due.at);
      due.fn();
    }
    clock = until;
  };
  const { log } = memoryLogger();
  const shows = createShows({ store: platform.store, bus: platform.bus, overlays: platform.overlays, templates: platform.templates, log, now: () => clock, timers });
  defer(t, () => shows.stop());
  const g = utcShow(clock + 10 * MIN);
  const show = shows.create({ name: 'Auto', overlays: ['tk'], date: g.date, timezone: g.timezone, dayBoundary: g.dayBoundary, goLive: g.time });
  shows.take(show.id, 'auto');
  assert.equal(shows.get(show.id).live, false);
  advance(9 * MIN);
  assert.equal(shows.get(show.id).live, false);
  advance(MIN);
  assert.equal(shows.get(show.id).recStartedAt, clock, 'live at go-live');
  // Taken away from "auto" before go-live: no REC.
  const g2 = utcShow(clock + 10 * MIN);
  shows.rec(show.id, 'reset');
  shows.update(show.id, { date: g2.date, goLive: g2.time });
  shows.take(show.id, 'auto');
  shows.take(show.id, 'brb');
  advance(11 * MIN);
  assert.equal(shows.get(show.id).live, false);
  // A go-live five weeks away (past setTimeout's 24.8-day limit) still arms.
  const far = utcShow(clock + 35 * 24 * 60 * MIN);
  shows.update(show.id, { date: far.date, goLive: far.time });
  shows.take(show.id, 'auto');
  advance(35 * 24 * 60 * MIN);
  assert.equal(shows.get(show.id).live, true);
});

test('a trigger reaches every member with the action, on one server-time frame', async (t) => {
  const { platform, got, watch } = await setup(t);
  overlaysFor(platform);
  platform.overlays.create({ slug: 'tk-h', template: TAKEOVER, settings: {} });
  const show = platform.shows.create({ ...SHOW, overlays: ['main-h', 'main-v', 'tk-h'] });
  for (const slug of ['main-h', 'main-v', 'tk-h', 'solo']) watch(slug);
  const t0 = Date.now();
  const res = platform.shows.trigger(show.id, 'titleCard', { args: { name: 'VIKKSTAR' } });
  const [a, b, c] = ['main-h', 'main-v', 'tk-h'].map((s) => got[s].find((e) => e.type === 'show.trigger').data);
  assert.equal(a.startAt, b.startAt);
  assert.equal(a.startAt, c.startAt);
  assert.ok(a.startAt >= t0 + TRIGGER_LEAD_MS && a.startAt <= Date.now() + TRIGGER_LEAD_MS);
  assert.deepEqual([a.durationMs, c.durationMs], [3000, 7000], 'each member\'s own declared duration');
  assert.deepEqual(a.args, { name: 'VIKKSTAR' });
  assert.deepEqual(res.overlays, ['main-h', 'main-v', 'tk-h']);
  assert.deepEqual(got.solo, []);
  // An action only the TAKEOVER template has goes to that member only.
  platform.shows.trigger(show.id, 'nowPlaying');
  assert.equal(got['main-h'].filter((e) => e.type === 'show.trigger').length, 1);
  assert.equal(got['tk-h'].filter((e) => e.type === 'show.trigger').length, 2);
  assert.throws(() => platform.shows.trigger(show.id, 'explode'), { code: 'unknown-action' });
  assert.throws(() => platform.shows.trigger(show.id, 'titleCard', { args: { big: 'x'.repeat(5000) } }), { code: 'invalid' });
});

test('an overlay belongs to one show at most; leaving gives it back its own scene; a removed overlay is skipped', async (t) => {
  const { platform, local } = await setup(t);
  overlaysFor(platform);
  platform.shows.takeOverlay('solo', 'brb');
  const show = platform.shows.create(SHOW);
  assert.throws(() => platform.shows.create({ ...SHOW, name: 'Other', overlays: ['main-h'] }), (err) => err.code === 'in-other-show' && err.status === 409 && /Saturday TAKEOVER/.test(err.message));
  assert.throws(() => platform.shows.create({ ...SHOW, name: 'saturday takeover', overlays: [] }), { code: 'name-taken' });
  platform.shows.take(show.id, 'program');
  assert.throws(() => platform.shows.takeOverlay('main-h', 'brb'), { code: 'in-show' });
  platform.shows.update(show.id, { overlays: ['main-v', 'solo'] });
  assert.equal('show.lineup' in local('main-h'), false, 'left: its show state is gone');
  assert.equal(local('solo')['show.scene'], 'program', 'joined: the show\'s scene');
  assert.equal(local('solo')['show.headliner'], 'VIKKSTAR');
  platform.shows.update(show.id, { overlays: ['main-v'] });
  assert.equal(local('solo')['show.scene'], 'brb', 'left again: its own scene back');
  platform.overlays.remove(platform.overlays.resolve('main-v').doc.id);
  assert.deepEqual(platform.shows.get(show.id).members, []);
  assert.throws(() => platform.shows.take(show.id, 'brb'), (err) => err.code === 'no-members' && /add some/.test(err.message));
});

test('an overlay outside a show takes its own scene, which survives a restart; its actions fire', async (t) => {
  const dataRoot = tempDir(t);
  const first = await setup(t, { dataRoot });
  overlaysFor(first.platform);
  first.watch('solo');
  first.platform.shows.takeOverlay('solo', 'brb', { transition: 'cut' });
  const fired = first.platform.shows.fireOverlay('solo', 'titleCard', { args: { name: 'X' } });
  assert.deepEqual(fired.overlays, ['solo']);
  assert.deepEqual(first.got.solo.map((e) => e.type), ['show.scene.changed', 'state.changed', 'show.trigger']);
  await first.platform.stop();
  const second = await setup(t, { dataRoot });
  assert.equal(second.local('solo')['show.scene'], 'brb');
});

test('the current slot: by position or by name, published to the members', async (t) => {
  const { platform, local } = await setup(t);
  overlaysFor(platform);
  const show = platform.shows.create(SHOW);
  platform.shows.setSlot(show.id, 1);
  assert.equal(local('main-h')['show.currentSlot'], 1);
  platform.shows.setSlot(show.id, 'deecee');
  assert.equal(local('main-v')['show.currentSlot'], 2);
  platform.shows.setSlot(show.id, null);
  assert.equal('show.currentSlot' in local('main-h'), false);
  for (const bad of [3, -1, 1.5, 'nobody']) assert.throws(() => platform.shows.setSlot(show.id, bad), { code: 'invalid' }, String(bad));
  // A lineup edit that removes the current slot's position clears it.
  platform.shows.setSlot(show.id, 2);
  platform.shows.update(show.id, { lineup: LINEUP.slice(0, 2) });
  assert.equal('show.currentSlot' in local('main-h'), false);
});

test('a setting bound to show.headliner follows the show\'s own headliner (04 §4.3)', async (t) => {
  const { platform } = await setup(t);
  platform.overlays.create({ slug: 'tk', template: TAKEOVER, settings: {} });
  const show = platform.shows.create({ ...SHOW, overlays: ['tk'] });
  const headliner = () => platform.overlays.resolve('tk').settings.headliner;
  assert.equal(headliner(), 'VIKKSTAR');
  platform.shows.update(show.id, { lineup: [{ time: '23:00', name: 'UNDERCOVER', headliner: true }] });
  assert.equal(headliner(), 'UNDERCOVER');
  platform.shows.remove(show.id);
  assert.equal(headliner(), undefined);
});

test('what a show must be: refusals say what to fix', async (t) => {
  const { platform } = await setup(t);
  overlaysFor(platform);
  const bad = (patch, code, re) => assert.throws(() => platform.shows.create({ ...SHOW, ...patch }), (err) => err.code === code && (!re || re.test(err.message)), JSON.stringify(patch));
  bad({ name: '' }, 'invalid', /name/);
  bad({ overlays: ['ghost'] }, 'no-overlay');
  bad({ date: '2026-02-30' }, 'invalid', /date/);
  bad({ timezone: 'Mars/Olympus' }, 'invalid', /IANA/);
  bad({ goLive: '25:00' }, 'invalid', /goLive/);
  bad({ dayBoundary: '6:00' }, 'invalid', /dayBoundary/);
  bad({ lineup: [{ time: '22:00' }] }, 'invalid', /name/);
  bad({ lineup: [{ time: '10pm', name: 'X' }] }, 'invalid', /time/);
  bad({ lineup: [{ time: '22:00', name: 'X', logo: 'javascript:alert(1)' }] }, 'invalid', /logo/);
  bad({ lineup: Array.from({ length: 101 }, () => ({ time: '22:00', name: 'X' })) }, 'invalid');
  // Fields outside the shape are dropped, not stored.
  const show = platform.shows.create({ ...SHOW, lineup: [{ time: '22:00', name: '  Trimmed  ', extra: 'x', headliner: 'yes' }], admin: true });
  assert.deepEqual(show.lineup.map(({ startAt, ...s }) => s), [{ time: '22:00', name: 'Trimmed' }]);
  assert.equal(show.admin, undefined);
});

test('the show API: signed in, JSON, problems with reasons', async (t) => {
  const { platform, api, got, watch } = await setup(t);
  overlaysFor(platform);
  const created = await api('POST', '/shows', SHOW);
  assert.equal(created.status, 201);
  const id = created.body.id;
  assert.equal((await api('GET', '/shows')).body.length, 1);
  assert.equal((await api('GET', `/shows/${encodeURIComponent('saturday takeover')}`)).body.id, id, 'by name too');
  watch('main-h');
  assert.equal((await api('PUT', `/shows/${id}/scene`, { scene: 'brb' })).status, 200);
  assert.equal((await api('POST', `/shows/${id}/triggers/titleCard`, { args: { name: 'X' } })).status, 200);
  assert.equal((await api('PUT', `/shows/${id}/slot`, { slot: 'VIKKSTAR' })).body.currentSlot, 1);
  assert.equal((await api('POST', `/shows/${id}/rec`, { action: 'start' })).body.live, true);
  assert.equal((await api('PATCH', `/shows/${id}`, { goLive: '23:00' })).body.goLive, '23:00');
  assert.equal((await api('PUT', '/overlays/solo/scene', { scene: 'outro' })).status, 200);
  assert.equal((await api('POST', '/overlays/solo/actions/titleCard', {})).status, 200);
  assert.deepEqual(got['main-h'].filter((e) => e.type !== 'state.changed').map((e) => e.type), ['show.scene.changed', 'show.trigger']);
  const problems = [
    [await api('GET', '/shows/nope'), 404],
    [await api('PUT', `/shows/${id}/scene`, { scene: 'nope' }), 422],
    [await api('POST', '/shows', { ...SHOW, name: 'Two' }), 409],
    [await api('PUT', '/overlays/main-v/scene', { scene: 'brb' }), 409],
    [await api('PUT', `/shows/${id}/scene`, ['brb']), 400],
  ];
  for (const [res, status] of problems) {
    assert.equal(res.status, status, JSON.stringify(res.body));
    assert.match(res.type, /application\/problem\+json/);
    assert.ok(res.body.detail, 'says why');
  }
  const form = await fetch(`${platform.url}/api/v1/shows/${id}/scene`, { method: 'PUT', headers: signedIn(platform, { 'content-type': 'application/x-www-form-urlencoded' }), body: 'scene=brb' });
  assert.equal(form.status, 415);
  await form.arrayBuffer();
  // Another name for this machine (a DNS-rebinding page) is refused, for reading too.
  const { port } = new URL(platform.url);
  const raw = (method, host) => new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path: '/api/v1/shows', headers: signedIn(platform, { host }) }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    req.end();
  });
  assert.equal(await raw('GET', `attacker.example:${port}`), 403);
  assert.equal(await raw('GET', `localhost:${port}`), 200);
  assert.equal((await api('DELETE', `/shows/${id}`)).status, 200);
  assert.equal((await api('GET', '/shows')).body.length, 0);
});

async function cli(argv, env) {
  const { run } = await import('../src/cli.js');
  let stdout = '';
  let stderr = '';
  const code = await run(argv, { stdout: { write: (s) => { stdout += s; } }, stderr: { write: (s) => { stderr += s; } }, env });
  return { code, stdout, stderr };
}

test('skp show …: the command line drives the running platform', async (t) => {
  const { platform, config, local } = await setup(t);
  overlaysFor(platform);
  const env = { SKP_DATA_DIR: config.dataDir, SKP_CONFIG_DIR: config.configDir, SKP_PORT: String(platform.port) };
  const dir = tempDir(t);
  const lineupFile = path.join(dir, 'lineup.json');
  writeFileSync(lineupFile, JSON.stringify(LINEUP));
  const created = await cli(['show', 'create', '--name', 'Saturday TAKEOVER', '--overlays', 'main-h, main-v', '--date', '2026-08-28', '--timezone', 'America/Toronto', '--go-live', '22:30', '--lineup', lineupFile], env);
  assert.equal(created.code, 0, created.stderr);
  assert.match(created.stdout, /^created Saturday TAKEOVER \(show_\w+\) with main-h, main-v/);
  const list = JSON.parse((await cli(['show', 'list', '--json'], env)).stdout);
  assert.deepEqual(list.map((s) => [s.name, s.members, s.lineup.length]), [['Saturday TAKEOVER', ['main-h', 'main-v'], 3]]);
  assert.match((await cli(['show', 'take', 'Saturday TAKEOVER', 'brb', '--transition', 'cut'], env)).stdout, /Saturday TAKEOVER: brb/);
  assert.equal(local('main-v')['show.scene'], 'brb');
  assert.match((await cli(['show', 'fire', 'saturday takeover', 'titleCard', '--args', '{"name":"X"}'], env)).stdout, /titleCard on main-h, main-v/);
  assert.match((await cli(['show', 'slot', 'Saturday TAKEOVER', 'vikkstar'], env)).stdout, /VIKKSTAR is on/);
  assert.match((await cli(['show', 'rec', 'Saturday TAKEOVER', 'start'], env)).stdout, /REC from/);
  assert.match((await cli(['overlay', 'take', 'solo', 'outro'], env)).stdout, /solo: outro/);
  const inShow = await cli(['overlay', 'take', 'main-h', 'brb', '--json'], env);
  assert.equal(inShow.code, 1);
  assert.equal(JSON.parse(inShow.stdout).error, 'in-show');
  assert.match(inShow.stderr, /take the scene on the show/);
  assert.match((await cli(['show', 'edit', 'Saturday TAKEOVER', '--go-live', '23:00'], env)).stdout, /updated Saturday TAKEOVER/);
  assert.equal(platform.shows.get('Saturday TAKEOVER').goLive, '23:00');
  assert.equal((await cli(['show', 'fire', 'Saturday TAKEOVER', 'titleCard', '--args', '{nope'], env)).code, 64);
  assert.match((await cli(['show', 'delete', 'Saturday TAKEOVER'], env)).stdout, /deleted Saturday TAKEOVER/);
  // With the platform not running, the command says so (69), and what to do.
  const spare = await new Promise((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
  const down = await cli(['show', 'list', '--json'], { ...env, SKP_PORT: String(spare) });
  assert.equal(down.code, 69);
  assert.equal(JSON.parse(down.stdout).error, 'not-running');
  assert.match(down.stderr, /isn't running at http:\/\/127\.0\.0\.1:\d+ .*Start it first/);
});
