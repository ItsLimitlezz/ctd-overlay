// One CTD Multi-Stream connection follows every profile (PLAN step 16c): a token for every profile
// reads them all over one stream (?profile=*), each profile a feed of the connection
// ("<connection>/<profile>", bus/owners.js). Against a pretend Multi-Stream with two profiles,
// "Miami or Bust" (default, live on Twitch and YouTube) and "DPRTMNT" (Kick, offline): each
// profile's chat, alerts and viewers reach only the overlays bound to it, to the whole connection
// or to "all"; each show's stream status is its profile's; a new profile shows up by itself and can
// be bound; a deleted one is reported where it was bound, its data gone; stopping clears every
// feed; an error holds every feed's values; the hub gets each overlay once per profile it feeds;
// another app's overlay.create binds to the profile it names. And the bus's feeds on their own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { startPlatform } from '../src/app.js';
import { createBus } from '../src/bus/index.js';
import { connectionOf, isOfConnection, listAllows, ownerOf, profileOf } from '../src/bus/owners.js';
import { loadConfig } from '../src/config.js';
import { resourcesFor } from '../src/connectors/defs/ctd-multistream-hub.js';
import { until } from './connector-helpers.js';
import { startFakeMultistream } from './fixtures/fake-multistream.mjs';
import { defer, FIXTURE_TEMPLATES, memoryLogger, signedIn, tempDir, TESTBED } from './helpers.js';

const SHARED = 'http://192.168.1.50:4850';
const SHOW = { date: '2026-10-17', timezone: 'America/Toronto' };
const running = (s) => ['connected', 'degraded'].includes(s);

async function start(t) {
  const ms = await startFakeMultistream();
  defer(t, () => ms.close());
  const root = tempDir(t);
  const config = loadConfig({ argv: ['--port', '0'], env: { SKP_DATA_DIR: path.join(root, 'data'), SKP_CONFIG_DIR: path.join(root, 'config'), SKP_EXPOSURE: 'lan', SKP_HOST: '127.0.0.1', SKP_HOSTS: '192.168.1.50:4850' } });
  const { log, entries } = memoryLogger();
  const platform = await startPlatform(config, { log, templateDirs: [FIXTURE_TEMPLATES], connectors: { random: () => 0.5 } });
  defer(t, () => platform.stop());
  const H = signedIn(platform, { 'content-type': 'application/json' });
  const api = async (method, p, body, headers = {}) => {
    const r = await fetch(`${platform.url}/api/v1${p}`, { method, headers: { ...H, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let json;
    try { json = JSON.parse(text); } catch { json = text; }
    return { status: r.status, body: json, text, etag: r.headers.get('etag') };
  };
  return { ms, platform, api, entries };
}

// A connection with a token for every profile (as pairing hands over when the admin picks "every
// profile"), running, following both.
async function everyProfile(ctx, { scopes } = {}) {
  const { ms, platform, api } = ctx;
  const token = ms.addToken({ profileId: null, ...(scopes ? { scopes } : {}) });
  const r = await api('POST', '/connections', { connector: 'ctd-multistream', config: { baseUrl: `${ms.url}/api/v1` }, secrets: { token } });
  assert.equal(r.status, 201, r.text);
  const conn = r.body;
  const get = () => platform.connectors.get(conn.id);
  await until(() => running(get().health.status) && get().info?.everyProfile === true && get().info.profiles.length === 2, 8000, 'following every profile');
  return { conn, get, token };
}

const msg = (id, profile, extra = {}) => ({
  id: `${profile === 'p-dprtmnt' ? 'kick' : 'twitch'}:${id}`, platform: profile === 'p-dprtmnt' ? 'kick' : 'twitch', destinationId: profile === 'p-dprtmnt' ? 'd2-kk' : 'd-tw',
  user: { id: 'twitch:1', name: 'Fan', roles: [] }, text: id, fragments: [{ type: 'text', text: id }], kind: 'message', ts: Date.now(), ...extra,
});
const say = (ms, id, profile) => {
  const m = msg(id, profile);
  return ms.emit('chat.message', m, { platform: m.platform, destination: m.destinationId, profile });
};

test('each profile\'s chat, alerts and viewers reach only the overlays bound to it, to the whole connection, or to "all"; each show\'s stream is its profile\'s', { timeout: 60000 }, async (t) => {
  const ctx = await start(t);
  const { ms, platform, api } = ctx;
  const { conn, get } = await everyProfile(ctx);
  assert.equal(get().name, 'Multi-Stream');
  assert.deepEqual(get().info.profiles.map((p) => [p.id, p.name, p.status]), [['default', 'Miami or Bust', 'live'], ['p-dprtmnt', 'DPRTMNT', 'offline']]);
  const events = ms.requests.filter((r) => r.path === '/api/v1/events');
  assert.ok(events.length && events.every((r) => r.query.profile === '*'), 'one stream for every profile');
  // Its values, profile by profile.
  const feeds = Object.fromEntries(get().feeds.map((f) => [f.profile, f.state]));
  assert.deepEqual([feeds.default['viewers.twitch'], feeds.default['stream.twitch.live'], feeds['p-dprtmnt']['stream.kick.live'], 'viewers.kick' in feeds['p-dprtmnt']], [214, true, false, false]);
  assert.deepEqual(get().state, {}, 'nothing of its own: it is all the profiles\'');

  const slugs = { miami: [`${conn.id}/default`], dprtmnt: [`${conn.id}/p-dprtmnt`], whole: [conn.id], every: 'all', both: [`${conn.id}/default`, `${conn.id}/p-dprtmnt`] };
  const live = {};
  for (const [slug, connections] of Object.entries(slugs)) {
    platform.overlays.create({ slug, template: TESTBED, settings: {}, connections });
    live[slug] = [];
    platform.overlays.resolve(slug).channel.subscribe((env) => live[slug].push(env));
  }
  const total = (slug) => platform.overlays.resolve(slug).channel.snapshot().state['viewers.total'];
  assert.deepEqual(Object.keys(slugs).map(total), [244, undefined, 244, 244, 244], 'DPRTMNT has no viewer count yet');

  // Chat from each profile.
  say(ms, 'm1', 'default');
  say(ms, 'k1', 'p-dprtmnt');
  const chats = (slug) => live[slug].filter((e) => e.type === 'chat.message').map((e) => e.data.id).sort();
  await until(() => chats('whole').length === 2 && chats('both').length === 2, 5000, 'both lines');
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(Object.keys(slugs).map(chats), [['twitch:m1'], ['kick:k1'], ['kick:k1', 'twitch:m1'], ['kick:k1', 'twitch:m1'], ['kick:k1', 'twitch:m1']]);
  const k1 = live.dprtmnt.find((e) => e.type === 'chat.message');
  assert.deepEqual([k1.src.connection, k1.src.profile, k1.src.platform], [conn.id, 'p-dprtmnt', 'kick']);
  // A snapshot's chat is its profile's too.
  assert.deepEqual(platform.overlays.resolve('miami').channel.snapshot().chat.recent.map((m) => m.id), ['twitch:m1']);
  assert.deepEqual(platform.overlays.resolve('dprtmnt').channel.snapshot().chat.recent.map((m) => m.id), ['kick:k1']);
  // An alert from DPRTMNT.
  ms.emit('alert.raid', { kind: 'raid', user: { id: 'kick:9', name: 'Raider' }, amount: { unit: 'viewers', value: 30 }, platform: 'kick', destinationId: 'd2-kk', ts: Date.now() }, { platform: 'kick', destination: 'd2-kk', profile: 'p-dprtmnt' });
  const raids = (slug) => live[slug].filter((e) => e.type === 'alert.raid').length;
  await until(() => raids('dprtmnt') === 1 && raids('every') === 1, 8000, 'the raid');
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(Object.keys(slugs).map(raids), [0, 1, 1, 1, 1]);
  // A clear on DPRTMNT's Kick takes DPRTMNT's lines only.
  ms.emit('chat.cleared', { platform: 'kick', destinationId: 'd2-kk' }, { platform: 'kick', destination: 'd2-kk', profile: 'p-dprtmnt' });
  await until(() => !platform.bus.chatRecent().some((e) => e.data.id === 'kick:k1'), 3000, 'DPRTMNT\'s Kick cleared');
  assert.ok(platform.bus.chatRecent().some((e) => e.data.id === 'twitch:m1'));
  // Viewers: DPRTMNT goes live on Kick with 50.
  ms.emit('destination.status', { ...ms.statuses['p-dprtmnt'].destinations[0], live: true, phase: 'live', viewers: 50 }, { platform: 'kick', destination: 'd2-kk', profile: 'p-dprtmnt' });
  await until(() => total('dprtmnt') === 50, 5000, 'DPRTMNT\'s count');
  assert.deepEqual(Object.keys(slugs).map(total), [244, 50, 294, 294, 294]);
  assert.equal(platform.overlays.resolve('miami').channel.snapshot().state['viewers.kick'], undefined);

  // Two shows, one per profile: Miami or Bust on air, DPRTMNT offline (its profile says so, even
  // with Kick live: "live" is the profile's).
  ms.emit('destination.status', { ...ms.statuses['p-dprtmnt'].destinations[0], live: false, viewers: null }, { platform: 'kick', destination: 'd2-kk', profile: 'p-dprtmnt' });
  const showA = platform.shows.create({ name: 'Miami or Bust', overlays: ['miami'], ...SHOW }, { actor: 'test' });
  const showB = platform.shows.create({ name: 'DPRTMNT', overlays: ['dprtmnt'], ...SHOW }, { actor: 'test' });
  const streamOf = async (p) => (await api('GET', p)).body.stream;
  await until(async () => (await streamOf(`/shows/${showB.id}`)).viewers === undefined, 5000, 'DPRTMNT off Kick');
  const a = await streamOf(`/shows/${showA.id}`);
  const b = await streamOf(`/shows/${showB.id}`);
  assert.deepEqual([a.onAir, a.viewers, a.platforms.map((p) => p.platform), a.profiles.map((p) => [p.name, p.status])], [true, 244, ['twitch', 'youtube', 'instagram'], [['Miami or Bust', 'live']]]);
  assert.deepEqual([b.onAir, 'viewers' in b, b.platforms.map((p) => p.platform), b.profiles.map((p) => [p.name, p.status, p.color])], [false, false, ['kick'], [['DPRTMNT', 'offline', '#E11D48']]]);
  assert.deepEqual(b.connections.map((c) => c.id), [conn.id]);
  // DPRTMNT goes live: its show is on air.
  ms.setProfileStatus('p-dprtmnt', 'live');
  await until(async () => (await streamOf(`/shows/${showB.id}`)).onAir === true, 5000, 'DPRTMNT live');
  // Fed by the whole connection: every profile, each on its own.
  const w = await streamOf('/overlays/whole');
  assert.deepEqual(w.profiles.map((p) => [p.profile, p.name, p.status]), [['default', 'Miami or Bust', 'live'], ['p-dprtmnt', 'DPRTMNT', 'live']]);
  // What feeds it, by name: the connection and the profile.
  const dp = (await api('GET', '/overlays/dprtmnt')).body;
  assert.deepEqual(dp.bound, [{ id: `${conn.id}/p-dprtmnt`, connection: conn.id, profile: 'p-dprtmnt', name: 'Multi-Stream · DPRTMNT', connector: 'ctd-multistream', status: get().health.status }]);
  // GET /system/health (operators read it): each profile with its status.
  const health = (await api('GET', '/system/health')).body.connections.find((c) => c.id === conn.id);
  assert.deepEqual([health.everyProfile, health.profiles.map((p) => [p.id, p.name, p.color, p.status])], [true, [['default', 'Miami or Bust', '#3B82F6', 'live'], ['p-dprtmnt', 'DPRTMNT', '#E11D48', 'live']]]);
  assert.equal(health.viewers, 244);
});

test('a new profile shows up by itself and can be bound; a deleted one is reported where it was bound and its data stops; bindings are checked', { timeout: 60000 }, async (t) => {
  const ctx = await start(t);
  const { ms, platform, api } = ctx;
  const { conn, get } = await everyProfile(ctx);
  platform.overlays.create({ slug: 'tk', template: TESTBED, settings: {}, connections: [conn.id] });
  const read = async () => api('GET', '/overlays/tk');
  // A profile that isn't there can't be bound; one that is can.
  let o = await read();
  const refused = await api('PATCH', '/overlays/tk', { connections: [`${conn.id}/p-club`] }, { 'if-match': o.etag });
  assert.equal(refused.status, 422, refused.text);
  assert.match(refused.body.detail, /Multi-Stream doesn't follow a profile "p-club": it follows "default", "p-dprtmnt"/);
  assert.equal((await api('PATCH', '/overlays/tk', { connections: ['con_00000000000000000000000000/default'] }, { 'if-match': o.etag })).status, 422);

  // Made in CTD Multi-Stream: followed at once (its status read), in health, and bindable.
  const n = ms.requests.length;
  ms.addProfile({ id: 'p-club', name: 'Club', slug: 'club', color: '#22C55E' }, {
    session: { status: 'live', startedAt: '2026-10-17T03:00:00Z', title: 'Club night' }, feeds: [],
    destinations: [{ id: 'd3-yt', name: 'YouTube', platform: 'youtube', enabled: true, phase: 'live', live: true, down: false, message: null, viewers: 7, since: '2026-10-17T03:00:01Z' }],
    platforms: [],
  });
  await until(() => get().info.profiles.length === 3, 5000, 'the new profile');
  assert.ok(ms.requests.slice(n).some((r) => r.path === '/api/v1/status' && r.query.profile === 'p-club'), 'its status read');
  await until(() => get().feeds?.some((f) => f.profile === 'p-club' && f.state['viewers.youtube'] === 7), 5000, 'its viewers');
  const h = (await api('GET', '/system/health')).body.connections.find((c) => c.id === conn.id);
  assert.deepEqual(h.profiles.map((p) => p.name), ['Miami or Bust', 'DPRTMNT', 'Club']);
  assert.deepEqual(get().info.choices.profile.map((c) => c.label), ['Every profile', 'Miami or Bust', 'DPRTMNT', 'Club']);
  o = await read();
  const bound = await api('PATCH', '/overlays/tk', { connections: [`${conn.id}/p-club`] }, { 'if-match': o.etag });
  assert.equal(bound.status, 200, bound.text);
  assert.equal(platform.overlays.resolve('tk').channel.snapshot().state['viewers.total'], 7, 'the club\'s count only');
  assert.deepEqual(platform.audit.list({ action: 'overlay.bind' }).items[0].details.connections, [`${conn.id}/p-club`]);
  // Saved from a stale copy: a conflict (H16).
  assert.equal((await api('PATCH', '/overlays/tk', { connections: [conn.id] }, { 'if-match': o.etag })).status, 412);

  // Deleted there: dropped, its values gone; the binding reports it, and is kept when sent back.
  ms.deleteProfile('p-club');
  await until(() => get().info.profiles.length === 2, 5000, 'the profile gone');
  assert.ok(!get().feeds.some((f) => f.profile === 'p-club'), 'its values gone');
  assert.equal(platform.overlays.resolve('tk').channel.snapshot().state['viewers.total'], undefined, 'nothing feeds it now');
  o = await read();
  assert.deepEqual(o.body.bound.map((b) => [b.name, b.missing]), [[`Multi-Stream · p-club`, true]]);
  assert.deepEqual(o.body.stream.profiles, [{ connection: conn.id, profile: 'p-club', name: 'p-club', status: 'missing' }]);
  const same = await api('PATCH', '/overlays/tk', { connections: [`${conn.id}/p-club`, `${conn.id}/default`] }, { 'if-match': o.etag });
  assert.equal(same.status, 200, 'a binding it had stays, though its profile is gone');
  // A profile it hears of first from an event (its profiles.changed not seen): followed at once,
  // its name and status read a moment later.
  platform.overlays.create({ slug: 'all-of-it', template: TESTBED, settings: {}, connections: [conn.id] });
  const heard = [];
  platform.overlays.resolve('all-of-it').channel.subscribe((env) => heard.push(env));
  ms.profiles.push({ id: 'p-late', name: 'Late night', slug: 'late', color: '#111111', createdAt: '2026-10-11T18:00:00Z', updatedAt: '2026-10-11T18:00:00Z' });
  ms.statuses['p-late'] = { session: { status: 'idle', title: 'Late' }, feeds: [], destinations: [{ id: 'd4-tt', name: 'TikTok', platform: 'tiktok', enabled: true, live: false, down: false, viewers: null }], platforms: [] };
  ms.emit('chat.message', { ...msg('t1', 'p-late'), id: 'tiktok:t1', platform: 'tiktok', destinationId: 'd4-tt' }, { platform: 'tiktok', destination: 'd4-tt', profile: 'p-late' });
  await until(() => heard.some((e) => e.type === 'chat.message' && e.data.id === 'tiktok:t1' && e.src.profile === 'p-late'), 5000, 'its chat');
  await until(() => get().info.profiles.find((p) => p.id === 'p-late')?.name === 'Late night' && get().feeds?.some((f) => f.profile === 'p-late' && f.state['stream.tiktok.live'] === false), 5000, 'its name and status');
  // Deleting the connection unbinds every profile of it.
  assert.equal((await api('DELETE', `/connections/${conn.id}`)).status, 200);
  assert.deepEqual(platform.overlays.resolve('tk').doc.data.connections, []);
});

test('a connection that follows one profile takes no profile bindings; stopping clears every feed; an error holds every feed\'s values', { timeout: 60000 }, async (t) => {
  const ctx = await start(t);
  const { ms, platform, api } = ctx;
  const single = await api('POST', '/connections', { connector: 'ctd-multistream', config: { baseUrl: `${ms.url}/api/v1` }, secrets: { token: ms.addToken({ profileId: 'p-dprtmnt' }) } });
  await until(() => running(platform.connectors.get(single.body.id).health.status), 8000, 'the single one running');
  platform.overlays.create({ slug: 'x', template: TESTBED, settings: {}, connections: [] });
  const o = await api('GET', '/overlays/x');
  const r = await api('PATCH', '/overlays/x', { connections: [`${single.body.id}/p-dprtmnt`] }, { 'if-match': o.etag });
  assert.equal(r.status, 422);
  assert.match(r.body.detail, /doesn't follow separate profiles now.*bind the whole connection/);
  assert.equal(platform.connectors.get(single.body.id).feeds, undefined, 'its values are its own');
  assert.equal(platform.connectors.get(single.body.id).state['stream.kick.live'], false);

  const { conn, get } = await everyProfile(ctx);
  const owners = () => new Set(platform.bus.connectionState(conn.id).map((e) => e.owner));
  assert.deepEqual(owners(), new Set([`${conn.id}/default`, `${conn.id}/p-dprtmnt`]));
  // An error: every feed's values held (marked stale), then fresh again once it is back.
  platform.connectors.runnerOf(conn.id).ctx.fail(new Error('a blip'));
  assert.ok(get().feeds.every((f) => f.stale?.length), JSON.stringify(get().feeds));
  platform.overlays.create({ slug: 'dp', template: TESTBED, settings: {}, connections: [`${conn.id}/default`] });
  assert.equal(platform.overlays.resolve('dp').channel.snapshot().state['viewers.stale'], true);
  await until(() => running(get().health.status) && get().feeds.every((f) => !f.stale), 8000, 'back, fresh');
  // Turned off: every feed's values go.
  assert.equal((await api('PATCH', `/connections/${conn.id}`, { enabled: false })).status, 200);
  await until(() => get().health.status === 'disabled', 5000, 'off');
  assert.equal(owners().size, 0);
  assert.equal(get().feeds, undefined);
  assert.equal(platform.overlays.resolve('dp').channel.snapshot().state['viewers.total'], undefined);
  assert.equal(platform.connectors.get(single.body.id).state['stream.kick.live'], false, 'the other connection keeps its own');
});

test('the hub gets each overlay once per profile it feeds (every profile when bound whole), new profiles too; overlay.create binds to the profile asked for', { timeout: 60000 }, async (t) => {
  const ctx = await start(t);
  const { ms, platform } = ctx;
  const { conn, get } = await everyProfile(ctx);
  platform.overlays.create({ slug: 'miami', template: TESTBED, settings: {}, connections: [`${conn.id}/default`] });
  platform.overlays.create({ slug: 'whole', template: TESTBED, settings: {}, connections: [conn.id] });
  platform.overlays.create({ slug: 'every', template: TESTBED, settings: {}, connections: 'all' });
  platform.overlays.create({ slug: 'both', template: TESTBED, settings: {}, connections: [`${conn.id}/default`, `${conn.id}/p-dprtmnt`] });
  platform.overlays.create({ slug: 'none', template: TESTBED, settings: {}, connections: [] });
  const last = () => ms.registrations.filter((r) => r.appId === 'ctd-overlay').at(-1)?.body;
  const by = () => Object.groupBy(last().resources, (r) => r.name.split(' — ')[0]);
  await until(() => last() && Object.keys(by()).length === 4 && get().info?.hub?.status === 'shared', 8000, 'registered');
  assert.equal(ms.apps.get('ctd-overlay').profileId, null, 'one app for every profile');
  const ids = (slug) => platform.overlays.resolve(slug).doc.id;
  const res = by();
  const perProfile = (slug) => [['h', 'default'], ['v', 'default'], ['h', 'p-dprtmnt'], ['v', 'p-dprtmnt']].map(([c, p]) => [`${ids(slug)}:${c}:${p}`, p]);
  assert.deepEqual(res.miami.map((r) => [r.id, r.profileId]), [[`${ids('miami')}:h:default`, 'default'], [`${ids('miami')}:v:default`, 'default']]);
  // Bound whole, or to "all": once per profile, assigned to it (the plugin lists a profile's own).
  assert.deepEqual(res.whole.map((r) => [r.id, r.profileId]), perProfile('whole'));
  assert.deepEqual(res.every.map((r) => [r.id, r.profileId]), perProfile('every'));
  assert.deepEqual(res.both.map((r) => [r.id, r.profileId]), perProfile('both'));
  assert.ok(last().resources.every((r) => r.profileId !== null), 'nothing unassigned');
  assert.equal(res.miami[0].url.startsWith(`${SHARED}/o/miami?key=`), true);
  assert.deepEqual([res.whole[0].url, res.whole[0].meta], [res.whole[2].url, res.whole[2].meta], 'the same URL, canvas and slot in every profile');
  // A profile made there: the overlays fed whole are registered for it too.
  ms.addProfile({ id: 'p-club', name: 'Club', slug: 'club', color: '#22C55E' });
  await until(() => last().resources.some((r) => r.id === `${ids('whole')}:h:p-club`), 8000, 'registered for the new profile');
  assert.ok(!last().resources.some((r) => r.id.startsWith(`${ids('miami')}:`) && r.profileId === 'p-club'), 'not one bound to another profile');
  ms.deleteProfile('p-club');
  await until(() => !last().resources.some((r) => r.profileId === 'p-club'), 8000, 'gone with the profile');

  // overlay.create about DPRTMNT: bound to DPRTMNT; about none: to the whole connection.
  const reply = (id) => ms.messages.find((m) => m.replyTo === id);
  const ask = async (data, profileId) => {
    const id = ms.injectMessage({ to: 'ctd-overlay', type: 'overlay.create', profileId, data });
    await until(() => reply(id), 8000, `the answer to ${JSON.stringify(data)}`);
    return reply(id);
  };
  const a = await ask({ template: 'takeover', canvas: 'vertical' }, 'p-dprtmnt');
  assert.deepEqual([a.type, a.profileId, a.data.ok, a.data.resource.profileId], ['overlay.created', 'p-dprtmnt', true, 'p-dprtmnt'], JSON.stringify(a));
  assert.deepEqual(platform.overlays.resolve('takeover-dprtmnt').doc.data.connections, [`${conn.id}/p-dprtmnt`]);
  assert.equal(platform.audit.list({ action: 'overlay.create' }).items[0].details.profile, 'p-dprtmnt');
  assert.equal(a.data.resource.id, `${platform.overlays.resolve('takeover-dprtmnt').doc.id}:v:p-dprtmnt`);
  assert.ok(last().resources.some((r) => r.id === a.data.resource.id && r.profileId === 'p-dprtmnt'), 'registered for DPRTMNT');
  assert.ok(!last().resources.some((r) => r.id.startsWith(platform.overlays.resolve('takeover-dprtmnt').doc.id) && r.profileId !== 'p-dprtmnt'), 'for DPRTMNT only');
  const b = await ask({ template: 'takeover' }, null);
  assert.equal(b.data.ok, true);
  assert.deepEqual(platform.overlays.resolve('takeover').doc.data.connections, [conn.id]);
  assert.deepEqual([...new Set(b.data.resources.map((r) => r.profileId))], ['default', 'p-dprtmnt'], 'every profile');
  const c = await ask({ template: 'takeover' }, 'p-nobody');
  assert.equal(c.data.ok, false);
  assert.match(c.data.reason, /doesn't follow a CTD Multi-Stream profile "p-nobody"/);
});

test('feeds on the bus: owned by "<connection>/<profile>", bound whole or one by one, cleared, ranked and purged with their connection', () => {
  assert.deepEqual([ownerOf({ connector: 'x', connection: 'con_A', profile: 'p1' }), ownerOf({ connector: 'x', connection: 'con_A' }), ownerOf({ connector: 'core' })], ['con_A/p1', 'con_A', '']);
  assert.deepEqual([connectionOf('con_A/p1'), profileOf('con_A/p1'), profileOf('con_A'), isOfConnection('con_A/p1', 'con_A'), isOfConnection('con_AB', 'con_A')], ['con_A', 'p1', undefined, true, false]);
  assert.deepEqual([listAllows(['con_A'], 'con_A/p1'), listAllows(['con_A/p1'], 'con_A/p2'), listAllows(['con_A/p1'], 'con_A')], [true, false, false]);
  const bus = createBus();
  const src = (connection, profile, platform = 'twitch') => ({ connector: 'ctd-multistream', connection, platform, ...(profile ? { profile } : {}) });
  bus.setState('viewers.twitch', 10, { src: src('con_A', 'p1') });
  bus.setState('viewers.twitch', 20, { src: src('con_A', 'p2') });
  bus.setState('viewers.twitch', 30, { src: src('con_B', undefined) });
  const ch = (connections) => bus.channel(`ovl_${JSON.stringify(connections)}`, { consumes: { state: ['viewers.*'], chat: { recent: 10 } }, connections });
  assert.deepEqual([ch(['con_A/p1']).visibleState('viewers.total'), ch(['con_A/p2']).visibleState('viewers.total'), ch(['con_A']).visibleState('viewers.twitch'), ch(['con_B', 'con_A/p2']).visibleState('viewers.twitch')], [10, 20, 10, 20], 'the older connection\'s feed over a newer connection');
  // A relay's rank is its feeds' too: a direct connection beats them.
  bus.setRank('con_A', 1);
  assert.equal(ch('all').visibleState('viewers.twitch'), 30, 'con_B, direct, over con_A\'s feeds');
  assert.throws(() => bus.setState('viewers.twitch', 1, { src: { connector: 'x', profile: 'p1' } }), /src.profile/);
  assert.throws(() => bus.setState('viewers.twitch', 1, { src: src('con_A', 'a/b') }), /src.profile/);
  bus.publish('chat.message', { id: 'c1', text: 'hi', user: { id: 'u', name: 'U' } }, { src: src('con_A', 'p1') });
  bus.publish('chat.message', { id: 'c2', text: 'hi', user: { id: 'u', name: 'U' } }, { src: src('con_B') });
  assert.deepEqual(ch(['con_A/p2']).snapshot().chat.recent, []);
  assert.deepEqual(ch(['con_A']).snapshot().chat.recent.map((m) => m.id), ['c1']);
  assert.deepEqual(bus.connectionState('con_A').map((e) => [e.owner, e.value]).sort(), [['con_A/p1', 10], ['con_A/p2', 20]]);
  assert.deepEqual(bus.stateOf('con_A'), [], 'the connection itself set nothing');
  assert.equal(bus.purgeChat('con_A'), 1);
  assert.equal(bus.clearOwner('con_A/p1'), 1, 'one feed');
  assert.equal(bus.clearOwner('con_A'), 1, 'the rest of the connection');
  assert.deepEqual(bus.connectionState('con_A'), []);
  assert.equal(bus.getState('viewers.twitch'), 30);
});

test('resources for the hub, following one profile or every one', () => {
  const item = (id, profiles) => ({ id, slug: id, template: { id: 'com.a.chat' }, canvases: [{ id: 'h', kind: 'landscape', width: 1920, height: 1080, url: `http://h/o/${id}` }], profiles });
  const items = [item('a', null), item('b', ['p1']), item('c', ['p1', 'p2'])];
  assert.deepEqual(resourcesFor(items, { every: true, profiles: ['p1', 'p2'] }).map((r) => [r.id, r.profileId]), [['a:h:p1', 'p1'], ['a:h:p2', 'p2'], ['b:h:p1', 'p1'], ['c:h:p1', 'p1'], ['c:h:p2', 'p2']]);
  assert.deepEqual(resourcesFor(items, { every: false, profileId: 'p9' }).map((r) => [r.id, r.profileId]), [['a:h', 'p9'], ['b:h', 'p9'], ['c:h', 'p9']]);
});
