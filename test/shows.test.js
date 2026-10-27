// Shows (01 §1.3, 09 §9.1): member overlays that share a scene, server-timed triggers and timed
// scenes, the show state templates read, REC, and the local control API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import path from 'node:path';
import { ownHosts, startPlatform } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createShows, LINEUP_BYTES, LIVE_MS, TRIGGER_LEAD_MS } from '../src/shows/registry.js';
import { defer, FIXTURE_TEMPLATES, memoryLogger, signedIn, tempDir, TESTBED } from './helpers.js';

const MIN = 60000;
// The TAKEOVER template that ships with the platform, at the version it ships at.
const TAKEOVER = { id: 'com.dprtmnt.takeover', version: JSON.parse(readFileSync(new URL('../templates/takeover/template.json', import.meta.url), 'utf8')).version };

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
  // A slot field outside the shape is refused (07 §7.11, 03 §3.1); a top-level one never reaches
  // the store (the API refuses it before, http/api.js). Names are trimmed; flags are true or absent.
  bad({ lineup: [{ time: '22:00', name: 'X', extra: 'x' }] }, 'unknown-field', /unknown field extra/);
  const show = platform.shows.create({ ...SHOW, lineup: [{ time: '22:00', name: '  Trimmed  ', headliner: 'yes' }], admin: true });
  assert.deepEqual(show.lineup.map(({ startAt, ...s }) => s), [{ time: '22:00', name: 'Trimmed' }]);
  assert.equal(show.admin, undefined);
});

test('a show read, edited and sent back whole goes through: the lineup with what it resolved to, members since deleted', async (t) => {
  const { platform, api } = await setup(t);
  overlaysFor(platform);
  // 02:30 on 8 March 2026 doesn't exist in Toronto, so that slot comes back with clockGap too.
  const made = await api('POST', '/shows', { ...SHOW, date: '2026-03-07', lineup: [{ time: '22:30', name: 'A' }, { time: '02:30', name: 'Gap' }] });
  assert.equal(made.status, 201);
  assert.ok(made.body.lineup.every((s) => typeof s.startAt === 'string') && made.body.lineup[1].clockGap === true);
  const edited = [...made.body.lineup, { time: '03:30', name: 'Late' }];
  const changed = await api('PATCH', `/shows/${made.body.id}`, { lineup: edited });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  assert.deepEqual(platform.store.get('shows', made.body.id).data.lineup, [{ time: '22:30', name: 'A' }, { time: '02:30', name: 'Gap' }, { time: '03:30', name: 'Late' }], 'what it resolved to is never stored');
  const unknown = await api('PATCH', `/shows/${made.body.id}`, { lineup: [{ ...edited[0], vip: true }] });
  assert.deepEqual([unknown.status, unknown.body.type], [422, 'https://skp.dev/errors/unknown-field']);
  // A member deleted over the API leaves the show; one deleted before that did (an id the show still
  // held) goes from a list sent back as it was read.
  const ids = made.body.overlays;
  assert.equal((await api('DELETE', '/overlays/main-v')).status, 200);
  const after = await api('GET', `/shows/${made.body.id}`);
  assert.deepEqual([after.body.overlays, after.body.members], [[ids[0]], ['main-h']]);
  assert.equal((await api('PATCH', `/shows/${made.body.id}`, { overlays: after.body.overlays })).status, 200);
  platform.overlays.remove(ids[0]);
  const stale = (await api('GET', `/shows/${made.body.id}`)).body.overlays;
  assert.deepEqual(stale, [ids[0]]);
  const back = await api('PATCH', `/shows/${made.body.id}`, { overlays: [...stale, 'solo'] });
  assert.equal(back.status, 200, JSON.stringify(back.body));
  assert.deepEqual(back.body.members, ['solo']);
  assert.equal(back.body.overlays.length, 1);
  assert.equal((await api('PATCH', `/shows/${made.body.id}`, { overlays: [ids[0]] })).status, 422, 'gone from the show, it is just an unknown overlay');
});

test('the show API: signed in, JSON, problems with reasons', async (t) => {
  const { platform, api, got, watch } = await setup(t);
  overlaysFor(platform);
  const created = await api('POST', '/shows', SHOW);
  assert.equal(created.status, 201);
  const id = created.body.id;
  assert.equal((await api('GET', '/shows')).body.items.length, 1);
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
  assert.equal((await api('GET', '/shows')).body.items.length, 0);
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

// ---- from the step 9 review ----------------------------------------------------------------------
const CORES = { id: 'dev.skp.cores', version: '1.0.0' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A second registry over the platform's data on a hand-cranked clock. Timers fire `late` ms after
// they are due (a host that slept through them), and time moves to each as it fires.
function cranked(t, platform, start, { late = 0 } = {}) {
  const c = { t: start, pending: [] };
  const timers = {
    setTimeout(fn, ms) { const h = { at: c.t + ms, fn }; c.pending.push(h); return h; },
    clearTimeout(h) { const i = c.pending.indexOf(h); if (i >= 0) c.pending.splice(i, 1); },
  };
  c.advance = (ms) => {
    const until = c.t + ms;
    for (;;) {
      const due = c.pending.filter((h) => h.at + late <= until).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      c.pending.splice(c.pending.indexOf(due), 1);
      c.t = Math.max(c.t, due.at + late);
      due.fn();
    }
    c.t = until;
  };
  const { log, entries } = memoryLogger();
  c.entries = entries;
  c.make = () => {
    const s = createShows({ store: platform.store, bus: platform.bus, overlays: platform.overlays, templates: platform.templates, log, now: () => c.t, timers });
    defer(t, () => s.stop());
    return s;
  };
  return c;
}

test('a lineup too large to send is refused before it is saved; one stored anyway never stops the platform starting', async (t) => {
  const dataRoot = tempDir(t);
  const { platform } = await setup(t, { dataRoot });
  overlaysFor(platform);
  const big = Array.from({ length: 100 }, (_, i) => ({ time: '22:00', name: `Act ${i}`, logo: `https://cdn.example.com/${'x'.repeat(400)}/${i}.png` }));
  assert.throws(() => platform.shows.create({ ...SHOW, lineup: big }), (err) => err.code === 'too-large' && new RegExp(`at most ${LINEUP_BYTES / 1024} KiB`).test(err.message));
  assert.deepEqual(platform.shows.list(), [], 'nothing was saved');
  assert.throws(() => platform.shows.create({ ...SHOW, lineup: [{ time: '22:00', name: 'X', logo: `https://e.example/${'x'.repeat(500)}` }] }), (err) => err.code === 'invalid' && /500 characters/.test(err.message));
  const show = platform.shows.create(SHOW);
  assert.throws(() => platform.shows.update(show.id, { lineup: big }), { code: 'too-large' });
  assert.equal(platform.shows.get(show.id).lineup.length, 3, 'unchanged');
  // A record too large to publish (from an older version, or edited by hand) is skipped at startup.
  const huge = big.map((s) => ({ ...s, logo: `${s.logo}?${'y'.repeat(600)}` }));
  platform.store.put('shows', show.id, { ...platform.store.get('shows', show.id).data, lineup: huge });
  await platform.stop();
  const second = await setup(t, { dataRoot });
  assert.ok(second.entries.some((e) => e.msg === 'a show could not be restored at startup; fix or delete it' && e.context.show === show.id));
  assert.equal(second.platform.shows.remove(show.id).id, show.id, 'and it can still be deleted');
});

test('REC at go-live: caught up after a restart across it, on a go-live moved into the past, next week while REC still runs, never from a stale one', async (t) => {
  const { platform } = await setup(t);
  platform.overlays.create({ slug: 'tk', template: TAKEOVER, settings: {} });
  const c = cranked(t, platform, Date.UTC(2026, 9, 17, 2, 0));
  let shows = c.make();
  const g = utcShow(c.t + 10 * MIN);
  const show = shows.create({ name: 'Auto', overlays: ['tk'], date: g.date, timezone: 'UTC', dayBoundary: '00:00', goLive: g.time });
  const goLiveAt = shows.get(show.id).goLiveAt;
  shows.take(show.id, 'auto');
  c.advance(5 * MIN);
  shows.stop(); // down at 02:05, back at 02:12
  c.advance(7 * MIN);
  shows = c.make();
  assert.equal(shows.get(show.id).recStartedAt, goLiveAt, 'caught up at startup, from go-live');
  assert.equal(shows.onAir(platform.overlays.resolve('tk').doc.id), true);
  // Go-live moved into the past while "auto" is on air: from that go-live, at once.
  shows.rec(show.id, 'reset');
  const past = utcShow(c.t - 5 * MIN);
  const moved = shows.update(show.id, { date: past.date, goLive: past.time });
  assert.equal(moved.recStartedAt, moved.goLiveAt);
  // Next week's date while tonight's REC still runs: next week's go-live is still armed.
  const week = utcShow(moved.goLiveAt + 7 * 24 * 60 * MIN);
  shows.update(show.id, { date: week.date, goLive: week.time });
  c.advance(7 * 24 * 60 * MIN);
  assert.equal(shows.get(show.id).recStartedAt, shows.get(show.id).goLiveAt, 'live from next week\'s go-live');
  // A go-live long gone (last week's date left in place): taking "auto" anchors nothing.
  shows.rec(show.id, 'reset');
  const stale = utcShow(c.t - 2 * 24 * 60 * MIN);
  shows.update(show.id, { date: stale.date, goLive: stale.time });
  shows.take(show.id, 'auto');
  assert.equal(shows.get(show.id).recStartedAt, undefined);
  assert.equal(shows.get(show.id).live, false);
});

test('REC at go-live is anchored at go-live even when the timer fires late, and follows an edited go-live', async (t) => {
  const { platform } = await setup(t);
  platform.overlays.create({ slug: 'tk', template: TAKEOVER, settings: {} });
  const c = cranked(t, platform, Date.UTC(2026, 9, 17, 2, 0), { late: 30000 });
  const shows = c.make();
  const g = utcShow(c.t + 10 * MIN);
  const show = shows.create({ name: 'Auto', overlays: ['tk'], date: g.date, timezone: 'UTC', dayBoundary: '00:00', goLive: g.time });
  shows.take(show.id, 'auto');
  const later = utcShow(c.t + 20 * MIN);
  shows.update(show.id, { goLive: later.time });
  c.advance(15 * MIN);
  assert.equal(shows.get(show.id).live, false, 'the first go-live no longer counts');
  c.advance(10 * MIN);
  assert.equal(shows.get(show.id).recStartedAt, shows.get(show.id).goLiveAt, 'from go-live, not from when the late timer ran');
});

test('a new show starts on "auto" (v0\'s first scene) when every member has it: the countdown, then live at go-live with no take; else on no scene', async (t) => {
  const { platform, local } = await setup(t);
  overlaysFor(platform, ['main-h']);
  for (const slug of ['tk', 'tk-v', 'tk-late', 'tk-joins', 'tk-bed']) platform.overlays.create({ slug, template: TAKEOVER, settings: {} });
  const c = cranked(t, platform, Date.UTC(2026, 9, 17, 2, 0));
  const shows = c.make();
  const g = utcShow(c.t + 10 * MIN);
  const night = { date: g.date, timezone: 'UTC', dayBoundary: '00:00', goLive: g.time };
  const show = shows.create({ name: 'Countdown', overlays: ['tk', 'tk-v'], ...night });
  assert.deepEqual([show.scene, show.live], ['auto', false]);
  for (const slug of ['tk', 'tk-v']) assert.equal(local(slug)['show.scene'], 'auto', 'its members show the countdown');
  c.advance(10 * MIN);
  assert.equal(shows.get(show.id).recStartedAt, shows.get(show.id).goLiveAt, 'live at go-live, as v0 was');
  // Made after its go-live: on "auto" (which shows it live), with no REC it didn't have.
  const late = shows.create({ name: 'Late', overlays: ['tk-late'], ...night });
  assert.deepEqual([late.scene, late.live], ['auto', false]);
  // No overlays yet: no scene; its first ones start it there, still with no REC, even with a
  // go-live moved into the past in the same change.
  const empty = shows.create({ name: 'Empty', overlays: [], ...night });
  assert.equal(empty.scene, undefined);
  const past = utcShow(c.t - MIN);
  const joined = shows.update(empty.id, { overlays: ['tk-joins'], date: past.date, goLive: past.time });
  assert.deepEqual([joined.scene, joined.live], ['auto', false]);
  assert.equal(local('tk-joins')['show.scene'], 'auto');
  // A member whose template has no "auto" (the testbed): no scene, each shows its own default;
  // a show with a scene taken keeps it when overlays change.
  const mixed = shows.create({ name: 'Mixed', overlays: ['tk-bed', 'main-h'], ...night });
  assert.equal(mixed.scene, undefined);
  assert.equal('show.scene' in local('tk-bed'), false);
  shows.take(mixed.id, 'brb');
  assert.equal(shows.update(mixed.id, { overlays: ['tk-bed'] }).scene, 'brb');
});

test('scenes by core (04 §4.2): a take, REC and a timed scene\'s return work across templates; each member gets the name its template knows', async (t) => {
  const { platform, local, got, watch } = await setup(t);
  platform.overlays.create({ slug: 'co', template: CORES, settings: {} });
  platform.overlays.create({ slug: 'bed', template: TESTBED, settings: {} });
  const show = platform.shows.create({ ...SHOW, overlays: ['co', 'bed'] });
  watch('co');
  watch('bed');
  platform.shows.take(show.id, 'live'); // co's own id; core program, which the testbed has as "program"
  assert.deepEqual([local('co')['show.scene'], local('bed')['show.scene']], ['live', 'program']);
  assert.equal(platform.shows.get(show.id).live, true, 'REC from a scene whose core is program');
  platform.shows.take(show.id, 'brb'); // the testbed's id; co knows it as its core
  assert.deepEqual([local('co')['show.scene'], local('bed')['show.scene']], ['brb', 'brb']);
  assert.deepEqual(of(got.bed, 'show.scene.changed').map((e) => [e.data.scene, e.data.prev]), [['program', undefined], ['brb', 'program']]);
  // A timed scene whose "then" is a core returns on the server.
  platform.shows.take(show.id, 'sting');
  await sleep(1400);
  assert.equal(platform.shows.get(show.id).scene, 'program');
  assert.deepEqual([local('co')['show.scene'], local('bed')['show.scene']], ['program', 'program']);
  assert.equal(platform.shows.take(show.id, 'starting').live, false, 'starting, by core: REC back to before the show');
  // A show whose only template knows "program" and "auto" as cores, not ids.
  platform.overlays.create({ slug: 'co2', template: CORES, settings: {} });
  const alone = platform.shows.create({ ...SHOW, name: 'Cores only', overlays: ['co2'] });
  platform.shows.take(alone.id, 'sting');
  await sleep(1400);
  assert.equal(platform.shows.get(alone.id).scene, 'program', 'returned to a core');
  assert.equal(local('co2')['show.scene'], 'program');
  assert.equal(platform.shows.get(alone.id).live, true);
  const c = cranked(t, platform, Date.UTC(2026, 9, 17, 2, 0));
  const shows = c.make();
  const g = utcShow(c.t + 10 * MIN);
  shows.rec(alone.id, 'reset');
  shows.update(alone.id, { date: g.date, timezone: 'UTC', dayBoundary: '00:00', goLive: g.time });
  shows.take(alone.id, 'clock'); // core "auto"
  c.advance(11 * MIN);
  assert.equal(shows.get(alone.id).recStartedAt, shows.get(alone.id).goLiveAt, 'live at go-live under a scene whose core is auto');
});

const of = (envs, type) => envs.filter((e) => e.type === type);

test('who\'s on follows the act through a lineup edit, and is cleared when the act is gone', async (t) => {
  const { platform, local } = await setup(t);
  overlaysFor(platform);
  const show = platform.shows.create(SHOW);
  platform.shows.setSlot(show.id, 'VIKKSTAR');
  platform.shows.update(show.id, { lineup: [{ time: '22:00', name: 'Warm-up' }, ...LINEUP] });
  assert.equal(local('main-h')['show.currentSlot'], 2);
  assert.equal(platform.shows.get(show.id).lineup[platform.shows.get(show.id).currentSlot].name, 'VIKKSTAR');
  platform.shows.update(show.id, { lineup: LINEUP.map((s) => (s.name === 'VIKKSTAR' ? { ...s, time: '01:30' } : s)) });
  assert.equal(local('main-h')['show.currentSlot'], 1, 'a new time: still the same act');
  platform.shows.update(show.id, { lineup: LINEUP.filter((s) => s.name !== 'VIKKSTAR') });
  assert.equal('show.currentSlot' in local('main-h'), false);
});

test('an overlay\'s own timed scene returns on the server, and after it leaves a show', async (t) => {
  const { platform, local } = await setup(t);
  overlaysFor(platform);
  platform.shows.takeOverlay('solo', 'headliner'); // 1 s, then program
  await sleep(1300);
  assert.equal(local('solo')['show.scene'], 'program');
  platform.shows.takeOverlay('solo', 'headliner');
  const show = platform.shows.create({ ...SHOW, overlays: ['solo'] });
  await sleep(1300); // its return fell due while it was in the show
  platform.shows.update(show.id, { overlays: [] });
  assert.equal(local('solo')['show.scene'], 'program', 'back on its own: the return happens');
});

test('members by slug or id, each once; leaving clears every show key; state is published again at startup', async (t) => {
  const dataRoot = tempDir(t);
  const { platform, local, got, watch } = await setup(t, { dataRoot });
  overlaysFor(platform);
  const h = platform.overlays.resolve('main-h').doc.id;
  const show = platform.shows.create({ ...SHOW, overlays: [h, 'main-h', 'main-v'] });
  assert.deepEqual(show.members, ['main-h', 'main-v']);
  assert.deepEqual(show.overlays, [h, platform.overlays.resolve('main-v').doc.id]);
  watch('main-h');
  platform.shows.take(show.id, 'program');
  assert.equal(of(got['main-h'], 'show.scene.changed').length, 1, 'once, not twice');
  platform.shows.setSlot(show.id, 1);
  await platform.stop();
  const again = await setup(t, { dataRoot });
  const s = again.local('main-h');
  assert.deepEqual([s['show.scene'], s['show.headliner'], s['show.currentSlot'], s['show.lineup'].length, typeof s['show.recStartedAt']], ['program', 'VIKKSTAR', 1, 3, 'number']);
  again.platform.shows.update(show.id, { overlays: ['main-v'] });
  const left = again.local('main-h');
  for (const key of ['show.scene', 'show.lineup', 'show.headliner', 'show.currentSlot', 'show.date', 'show.goLiveAt', 'show.recStartedAt']) assert.equal(key in left, false, key);
  assert.ok(local);
});

test('a lineup time a clock change repeats is the first one, and flagged; live lasts 12 hours at most', async (t) => {
  const { platform } = await setup(t);
  overlaysFor(platform);
  const show = platform.shows.create({ ...SHOW, date: '2026-10-31', lineup: [{ time: '01:30', name: 'Twice' }] });
  assert.equal(show.lineup[0].clockOverlap, true);
  assert.equal(new Date(show.lineup[0].startAt).toISOString(), '2026-11-01T05:30:00.000Z');
  const c = cranked(t, platform, Date.UTC(2026, 10, 1, 2, 0));
  const shows = c.make();
  shows.take(show.id, 'program');
  c.advance(LIVE_MS - 1);
  assert.equal(shows.get(show.id).live, true);
  c.advance(1);
  assert.equal(shows.get(show.id).live, false, '09 §9.1: a show counts as live for 12 hours at most');
  assert.equal(shows.onAir(platform.overlays.resolve('main-h').doc.id), false);
});

test('re-taking a timed scene before it ends returns at the second take\'s end', async (t) => {
  const { platform } = await setup(t);
  overlaysFor(platform);
  const c = cranked(t, platform, Date.UTC(2026, 9, 17, 2, 0));
  const shows = c.make();
  const show = shows.create(SHOW);
  shows.take(show.id, 'headliner'); // 1 s
  c.advance(500);
  shows.take(show.id, 'headliner');
  c.advance(600);
  assert.equal(shows.get(show.id).scene, 'headliner', 'not at the first take\'s end');
  c.advance(500);
  assert.equal(shows.get(show.id).scene, 'program');
});

test('refusals, not crashes: odd overlay references, deeply nested args', async (t) => {
  const { platform, api } = await setup(t);
  overlaysFor(platform);
  const show = platform.shows.create(SHOW);
  assert.throws(() => platform.shows.create({ ...SHOW, name: 'Two', overlays: ['not an id'] }), { code: 'no-overlay' });
  assert.throws(() => platform.shows.takeOverlay('has space', 'brb'), { code: 'not-found' });
  assert.equal((await api('PUT', '/overlays/has%20space/scene', { scene: 'brb' })).status, 404);
  const deep = `{"args":{"a":${'['.repeat(5000)}${']'.repeat(5000)}}}`;
  for (const url of [`/shows/${show.id}/triggers/titleCard`, '/overlays/solo/actions/titleCard']) {
    const res = await fetch(`${platform.url}/api/v1${url}`, { method: 'POST', headers: signedIn(platform, { 'content-type': 'application/json' }), body: deep });
    assert.equal(res.status, 422, url);
    assert.match((await res.json()).detail, /nested at most 16 deep/);
  }
});

test('the platform\'s own names: its configured host, and on port 80 without the port', () => {
  const at = (port) => ({ address: () => ({ port }) });
  assert.deepEqual(ownHosts(at(4848)), ['127.0.0.1:4848', 'localhost:4848', '[::1]:4848']);
  assert.deepEqual(ownHosts(at(4848), '127.0.0.2'), ['127.0.0.1:4848', 'localhost:4848', '[::1]:4848', '127.0.0.2:4848']);
  assert.deepEqual(ownHosts(at(4848), '::1'), ['127.0.0.1:4848', 'localhost:4848', '[::1]:4848']);
  assert.deepEqual(ownHosts(at(80), '127.0.0.1'), ['127.0.0.1:80', 'localhost:80', '[::1]:80', '127.0.0.1', 'localhost', '[::1]']);
  assert.deepEqual(ownHosts({ address: () => null }), []);
});

test('a sandboxed page (an overlay, a template\'s script) can\'t drive a show; the platform\'s own pages can, signed in', async (t) => {
  const { platform, api } = await setup(t);
  overlaysFor(platform);
  const show = platform.shows.create(SHOW);
  const fromPage = (headers) => api('PUT', `/shows/${show.id}/scene`, { scene: 'brb' }, headers);
  assert.equal((await fromPage({ origin: 'null' })).status, 403, 'an overlay page has an origin of its own');
  assert.equal((await api('GET', '/shows', undefined, { origin: 'null' })).status, 403, 'reading too');
  assert.equal((await fromPage({ origin: platform.url })).status, 200);
  const res = await fetch(`${platform.url}/o/main-h?key=${platform.overlays.key('main-h')}`);
  assert.match(res.headers.get('content-security-policy'), /^sandbox allow-scripts; /, 'overlay pages are served sandboxed');
  await res.arrayBuffer();
});