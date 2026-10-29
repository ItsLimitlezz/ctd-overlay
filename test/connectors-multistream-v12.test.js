// CTD Relay v1.2 (PLAN step 16c), against a pretend Relay on 127.0.0.1: Connect is
// pairing (the code shown, the token handed over once, kept encrypted, never logged or answered;
// denied, expired, too many waiting); a token limited to a profile names the connection and keeps
// its live status; a token for every profile follows every profile, or the profile picked, with
// ?profile= on every call; the overlays a connection feeds are registered in the hub (one resource per canvas, keyed
// URLs at SKP_HOSTS's address, canvas, slot), every 30 s and when they change, and unregistered
// when it is deleted; another app's overlay.create makes one (or says why not), always answered.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { shareBase, startPlatform } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { canvasKind } from '../src/connectors/share.js';
import { appIdFor, resourcesOf } from '../src/connectors/defs/ctd-multistream-hub.js';
import { fakeClock, until } from './connector-helpers.js';
import { startFakeMultistream } from './fixtures/fake-multistream.mjs';
import { defer, FIXTURE_TEMPLATES, memoryLogger, signedIn, tempDir, TESTBED } from './helpers.js';

const TAKEOVER = { id: 'com.dprtmnt.takeover', version: '1.1.0' };
const CHAT = { id: 'com.dprtmnt.chat', version: '1.0.0' };
const SHARED = 'http://192.168.1.50:4850';

// A platform on the LAN (SKP_HOSTS names the NAS's address), and a pretend Relay.
async function start(t, { clock, env = {}, ms: msOptions } = {}) {
  const ms = await startFakeMultistream(msOptions);
  defer(t, () => ms.close());
  const root = tempDir(t);
  const config = loadConfig({ argv: ['--port', '0'], env: { SKP_DATA_DIR: path.join(root, 'data'), SKP_CONFIG_DIR: path.join(root, 'config'), SKP_EXPOSURE: 'lan', SKP_HOST: '127.0.0.1', SKP_HOSTS: '192.168.1.50:4850', ...env } });
  const { log, entries } = memoryLogger();
  const platform = await startPlatform(config, { log, templateDirs: [FIXTURE_TEMPLATES], connectors: { random: () => 0.5 }, ...(clock ? { clock: { now: clock.now, timers: clock.timers } } : {}) });
  defer(t, () => platform.stop());
  const H = signedIn(platform, { 'content-type': 'application/json' });
  const api = async (method, p, body) => {
    const r = await fetch(`${platform.url}/api/v1${p}`, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let json;
    try { json = JSON.parse(text); } catch { json = text; }
    return { status: r.status, body: json, text };
  };
  return { ms, platform, entries, api };
}
const connect = async ({ api, ms }, extra = {}) => {
  const r = await api('POST', '/connections', { connector: 'ctd-multistream', config: { baseUrl: `${ms.url}/api/v1`, ...(extra.config || {}) }, ...(extra.token ? { secrets: { token: extra.token } } : {}), ...(extra.name ? { name: extra.name } : {}) });
  assert.equal(r.status, 201, r.text);
  return r.body;
};
const running = (s) => ['connected', 'degraded'].includes(s);

test('Connect is pairing: the code to approve, then the token kept encrypted, never answered or logged; named after its profile, whose live status it keeps', { timeout: 60000 }, async (t) => {
  const ctx = await start(t);
  const { ms, platform, entries, api } = ctx;
  const conn = await connect(ctx);
  const get = () => platform.connectors.get(conn.id);
  await until(() => get().health.status === 'needs-reauth', 5000, 'waiting to be connected');
  assert.match(get().health.detail, /press Connect/);

  const started = await api('POST', `/connections/${conn.id}/authorize`, {});
  assert.equal(started.status, 200, started.text);
  const p = ms.pairings.at(-1);
  assert.deepEqual([started.body.flow, started.body.code, started.body.intervalS], ['pairing', p.code, 1]);
  assert.match(started.body.approveUrl, /\/settings\?tab=api&pair=/);
  assert.ok(Date.parse(started.body.expiresAt) > Date.now() + 9 * 60 * 1000);
  assert.deepEqual(ms.requests.find((r) => r.path === '/api/v1/pairing').body, { appName: 'CTD Overlay', kind: 'ctd-overlay', scopes: ['status:read', 'chat:read', 'apps:read', 'apps:write'], profileId: null });
  // Pending: the code on the connection, polled from the platform (never the poll secret).
  await until(() => ms.requests.filter((r) => r.path.endsWith('/token')).length >= 2, 5000, 'polling');
  const pending = await api('GET', `/connections/${conn.id}`);
  assert.deepEqual([pending.body.authorization.flow, pending.body.authorization.status, pending.body.authorization.code], ['pairing', 'pending', p.code]);
  assert.ok(!started.text.includes(p.secret) && !pending.text.includes(p.secret), 'the poll secret is never answered');
  assert.equal(ms.requests.filter((r) => r.path.endsWith('/token')).at(-1).body.pollSecret, p.secret);

  // Approved for DPRTMNT: the token, once; it connects, limited to that profile.
  const token = ms.approve({ profileId: 'p-dprtmnt' });
  await until(() => running(get().health.status) && get().info?.profile?.name === 'DPRTMNT', 10000, 'connected to DPRTMNT');
  const c = (await api('GET', `/connections/${conn.id}`)).body;
  assert.equal(c.name, 'Relay · DPRTMNT', 'named after its profile');
  assert.deepEqual(c.secretFields, ['token']);
  assert.equal(c.authorization.status, 'done');
  assert.deepEqual(c.info.profile, { id: 'p-dprtmnt', name: 'DPRTMNT', slug: 'dprtmnt', color: '#E11D48', status: 'offline', live: 0, down: 0 });
  const raw = platform.store.get('connections', conn.id).data;
  assert.ok(typeof raw.secrets === 'string' && !raw.secrets.includes(token) && !JSON.stringify(raw).includes(token), 'stored encrypted');
  assert.ok(!JSON.stringify(c).includes(token), 'never answered');
  assert.ok(!JSON.stringify(entries).includes(token) && !JSON.stringify(entries).includes(p.secret), 'never logged');
  const audit = platform.audit.list({ action: 'connection.authorize' }).items[0];
  assert.deepEqual([audit.details.flow, audit.details.profile], ['pairing', 'p-dprtmnt']);
  assert.ok(!JSON.stringify(platform.audit.list({ limit: 200 })).includes(token));
  // A token limited to a profile reads it without ?profile=.
  const reads = ms.requests.filter((r) => ['/api/v1/status', '/api/v1/events'].includes(r.path) && r.headers.authorization === `Bearer ${token}`);
  assert.ok(reads.length >= 2 && reads.every((r) => !('profile' in r.query)));

  // Its live status: an overlay it feeds is on air when the profile is, before any platform says.
  platform.overlays.create({ slug: 'tk', template: TAKEOVER, settings: {}, connections: [conn.id] });
  const stream = async () => (await api('GET', '/overlays/tk')).body.stream;
  assert.deepEqual([(await stream()).onAir, (await stream()).profiles], [false, [{ connection: conn.id, profile: 'p-dprtmnt', name: 'DPRTMNT', color: '#E11D48', status: 'offline' }]]);
  ms.setProfileStatus('p-dprtmnt', 'live');
  await until(async () => (await stream()).onAir === true, 5000, 'on air from the profile');
  assert.equal((await stream()).platforms.every((x) => x.live === false), true, 'no platform said so');
  assert.equal((await api('GET', '/system/health')).body.connections.find((x) => x.id === conn.id).profile.status, 'live');
  // Renamed there: the name follows while nobody named it here; then it stays.
  ms.renameProfile('p-dprtmnt', 'DPRTMNT Club');
  await until(() => get().name === 'Relay · DPRTMNT Club', 5000, 'the new name');
  assert.equal((await api('PATCH', `/connections/${conn.id}`, { name: 'Club night' })).status, 200);
  ms.renameProfile('p-dprtmnt', 'DPRTMNT');
  await until(() => get().info.profile.name === 'DPRTMNT', 5000, 'the profile renamed back');
  assert.equal(get().name, 'Club night', 'a name someone gave stays');
  // Deleted there: an error saying so, not retried.
  ms.deleteProfile('p-dprtmnt');
  await until(() => get().health.status === 'error', 5000, 'the profile gone');
  assert.match(get().health.detail, /"DPRTMNT" was deleted in CTD Relay.*Connect again/);
});

test('pairing that is denied, expires, or finds too many requests waiting says so; Connect again works for a revoked token', { timeout: 60000 }, async (t) => {
  const ctx = await start(t);
  const { ms, platform, api } = ctx;
  const conn = await connect(ctx);
  const auth = () => platform.connectors.get(conn.id).authorization;
  assert.equal((await api('POST', `/connections/${conn.id}/authorize`, {})).status, 200);
  ms.deny();
  await until(() => auth()?.status === 'denied', 5000, 'denied');
  assert.match(auth().detail, /denied in CTD Relay/);
  assert.equal((await api('POST', `/connections/${conn.id}/authorize`, {})).status, 200);
  ms.expire();
  await until(() => auth()?.status === 'expired', 5000, 'expired');
  assert.match(auth().detail, /expired before it was approved/);
  ms.pairingLimited = 1;
  const limited = await api('POST', `/connections/${conn.id}/authorize`, {});
  assert.equal(limited.status, 429, limited.text);
  assert.match(limited.body.detail, /too many connection requests waiting/);
  // Cancel stops polling.
  assert.equal((await api('POST', `/connections/${conn.id}/authorize`, {})).status, 200);
  assert.deepEqual((await api('DELETE', `/connections/${conn.id}/authorize`)).body, { cancelled: true });
  await new Promise((r) => setTimeout(r, 200)); // a poll already on its way lands
  const polls = ms.requests.filter((r) => r.path.endsWith('/token')).length;
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(ms.requests.filter((r) => r.path.endsWith('/token')).length, polls, 'no more polls');
  // A pasted token, revoked: needs-reauth, and Connect again replaces it.
  const pasted = ms.addToken({ profileId: 'default' });
  assert.equal((await api('PATCH', `/connections/${conn.id}`, { secrets: { token: pasted } })).status, 200);
  await until(() => running(platform.connectors.get(conn.id).health.status), 8000, 'connected with the pasted token');
  ms.tokens.delete(pasted);
  ms.dropStreams();
  await until(() => platform.connectors.get(conn.id).health.status === 'needs-reauth', 8000, 'refused');
  assert.match(platform.connectors.get(conn.id).health.detail, /Press Connect again/);
  assert.equal((await api('POST', `/connections/${conn.id}/authorize`, {})).status, 200);
  ms.approve({ profileId: 'default' });
  await until(() => running(platform.connectors.get(conn.id).health.status), 10000, 'connected again');
  assert.equal(platform.connectors.get(conn.id).info.profile.name, 'Miami or Bust');
});

test('a token for every profile follows every one until one is picked in its settings: then ?profile= on every call, and only that profile\'s chat reaches overlays', { timeout: 60000 }, async (t) => {
  const ctx = await start(t);
  const { ms, platform, api } = ctx;
  const token = ms.addToken({ profileId: null, scopes: ['status:read', 'chat:read'] });
  const conn = await connect(ctx, { token });
  const get = () => platform.connectors.get(conn.id);
  await until(() => running(get().health.status) && get().info?.everyProfile === true, 8000, 'connected');
  // Every profile until one is picked ("Every profile" first in the settings' choice).
  assert.equal(get().info.profile, undefined);
  assert.deepEqual(get().info.profiles.map((p) => p.id), ['default', 'p-dprtmnt']);
  assert.deepEqual(get().info.choices, { profile: [{ value: '*', label: 'Every profile' }, { value: 'default', label: 'Miami or Bust' }, { value: 'p-dprtmnt', label: 'DPRTMNT' }] });
  assert.equal(get().name, 'Relay');
  assert.equal(get().info.hub.status, 'off', 'no apps:write: nothing shared');
  const mine = (p) => ms.requests.filter((r) => r.path === p && r.headers.authorization === `Bearer ${token}`);
  for (const p of ['/api/v1/status', '/api/v1/chat']) assert.deepEqual(new Set(mine(p).map((r) => r.query.profile)), new Set(['default', 'p-dprtmnt']), p);
  assert.ok(mine('/api/v1/events').every((r) => r.query.profile === '*'), 'one stream for every profile');
  assert.match(mine('/api/v1/events').at(-1).query.types, /profile\.status/);

  platform.overlays.create({ slug: 'main', template: TESTBED, settings: {}, connections: [conn.id] });
  const live = [];
  platform.overlays.resolve('main').channel.subscribe((env) => live.push(env));
  const msg = (id) => ({ id: `kick:${id}`, platform: 'kick', destinationId: 'd2-kk', user: { id: 'kick:1', name: 'Fan', roles: [] }, text: id, fragments: [{ type: 'text', text: id }], kind: 'message', ts: Date.now() });
  const n = mine('/api/v1/events').length;
  assert.equal((await api('PATCH', `/connections/${conn.id}`, { config: { baseUrl: `${ms.url}/api/v1`, profile: 'p-dprtmnt' } })).status, 200);
  await until(() => running(get().health.status) && get().info?.profile?.id === 'p-dprtmnt' && mine('/api/v1/events').length > n && ms.openStreams === 1, 8000, 'following DPRTMNT');
  assert.equal(mine('/api/v1/events').at(-1).query.profile, 'p-dprtmnt');
  assert.equal(get().info.everyProfile, undefined, 'one profile now');
  assert.equal(get().name, 'Relay · DPRTMNT');
  ms.emit('chat.message', msg('other'), { platform: 'kick', destination: 'd2-kk', profile: 'default' });
  ms.emit('chat.message', msg('ours'), { platform: 'kick', destination: 'd2-kk', profile: 'p-dprtmnt' });
  await until(() => live.some((e) => e.type === 'chat.message' && e.data.id === 'kick:ours'), 5000, 'its own chat');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(live.filter((e) => e.type === 'chat.message' && e.data.id === 'kick:other').length, 0, 'another profile\'s chat never arrives');
  // Picking a profile that isn't there any more: an error saying so.
  assert.equal((await api('PATCH', `/connections/${conn.id}`, { config: { baseUrl: `${ms.url}/api/v1`, profile: 'p-gone' } })).status, 200);
  await until(() => get().health.status === 'error', 5000, 'the profile missing');
  assert.match(get().health.detail, /isn't in CTD Relay any more/);
});

test('the overlays it feeds are registered in the hub: a resource per canvas, keyed URLs at SKP_HOSTS\'s address, canvas and slot; again on a change; gone with the connection', { timeout: 60000 }, async (t) => {
  const ctx = await start(t);
  const { ms, platform, api } = ctx;
  platform.overlays.create({ slug: 'chat', template: CHAT, settings: {}, connections: 'all', role: 'chat-main' });
  const conn = await connect(ctx, { token: ms.addToken({ profileId: 'p-dprtmnt' }) });
  platform.overlays.create({ slug: 'takeover', template: TAKEOVER, settings: {}, connections: [conn.id] });
  platform.overlays.create({ slug: 'elsewhere', template: TAKEOVER, settings: {}, connections: [] });
  const get = () => platform.connectors.get(conn.id);
  const last = () => ms.registrations.filter((r) => r.appId === 'ctd-overlay-dprtmnt').at(-1)?.body;
  await until(() => last()?.resources.length === 4 && get().info?.hub?.status === 'shared', 8000, 'registered');
  const body = last();
  assert.deepEqual([body.name, body.kind, body.baseUrl, body.capabilities], ['CTD Overlay', 'ctd-overlay', SHARED, ['overlays', 'overlay.create']]);
  assert.match(body.version, /^\d+\.\d+\.\d+/);
  const tk = platform.store.list('overlays', { limit: 100 }).find((d) => d.data.slug === 'takeover');
  const key = platform.overlays.key('takeover');
  assert.deepEqual(body.resources.find((r) => r.id === `${tk.id}:h`), { type: 'overlay', id: `${tk.id}:h`, name: 'takeover — landscape', profileId: 'p-dprtmnt', url: `${SHARED}/o/takeover?key=${key}`, width: 1920, height: 1080, meta: { canvas: 'landscape', slot: 'takeover-landscape', transparent: true } });
  assert.deepEqual(body.resources.find((r) => r.id === `${tk.id}:v`).meta, { canvas: 'vertical', slot: 'takeover-vertical', transparent: true });
  assert.match(body.resources.find((r) => r.id === `${tk.id}:v`).url, new RegExp(`^${SHARED}/o/takeover\\?key=skp_ovl_\\w+&canvas=v$`));
  // Chat's role in OBS; its tall "side" column is the landscape output's, its "v" the vertical one's.
  assert.deepEqual(body.resources.filter((r) => r.name.startsWith('chat')).map((r) => [r.width, r.height, r.meta.canvas, r.meta.slot]), [[560, 1000, 'landscape', 'chat-main-landscape'], [1080, 720, 'vertical', 'chat-main-vertical']]);
  assert.ok(!body.resources.some((r) => r.name.startsWith('elsewhere')), 'only what it feeds');
  assert.deepEqual(get().info.hub, { appId: 'ctd-overlay-dprtmnt', status: 'shared', overlays: 2, resources: 4, at: get().info.hub.at });
  assert.equal(ms.apps.get('ctd-overlay-dprtmnt').profileId, 'p-dprtmnt');

  // A change is registered within about a second: bound, re-keyed, a role given.
  const n = ms.registrations.length;
  const sent = Date.now();
  await api('PATCH', '/overlays/elsewhere', { connections: [conn.id], role: 'takeover-b' });
  await until(() => last().resources.length === 6, 5000, 'the new binding');
  assert.ok(Date.now() - sent < 3000);
  assert.ok(ms.registrations.length - n <= 2, 'debounced');
  assert.deepEqual(last().resources.filter((r) => r.name.startsWith('elsewhere')).map((r) => r.meta.slot), ['takeover-b-landscape', 'takeover-b-vertical']);
  const fresh = platform.overlays.rotateKey('takeover');
  await until(() => last().resources.find((r) => r.id === `${tk.id}:h`).url.endsWith(fresh), 5000, 'the new key');
  // A role that can't be a slot is refused.
  assert.equal((await api('PATCH', '/overlays/elsewhere', { role: 'Has Spaces' })).status, 422);

  // Turned off: unregistered; on: registered again. Deleted: unregistered.
  assert.equal((await api('PATCH', `/connections/${conn.id}`, { enabled: false })).status, 200);
  await until(() => !ms.apps.has('ctd-overlay-dprtmnt'), 5000, 'unregistered when off');
  assert.equal((await api('PATCH', `/connections/${conn.id}`, { enabled: true })).status, 200);
  await until(() => ms.apps.has('ctd-overlay-dprtmnt'), 8000, 'registered when on');
  assert.equal((await api('DELETE', `/connections/${conn.id}`)).status, 200);
  await until(() => !ms.apps.has('ctd-overlay-dprtmnt'), 5000, 'unregistered when deleted');
  assert.ok(ms.requests.some((r) => r.method === 'DELETE' && r.path === '/api/v1/apps/ctd-overlay-dprtmnt'));
});

test('past the hub\'s 200 resources, the first 200 by slug are registered and a warning says so', { timeout: 60000 }, async (t) => {
  const ctx = await start(t);
  const { ms, platform } = ctx;
  for (let i = 0; i < 101; i++) platform.overlays.create({ slug: `tk-${String(i).padStart(3, '0')}`, template: TAKEOVER, settings: {} });
  const conn = await connect(ctx, { token: ms.addToken({ profileId: 'p-dprtmnt' }) });
  const get = () => platform.connectors.get(conn.id);
  await until(() => get().info?.hub?.status === 'shared', 8000, 'registered');
  const body = ms.registrations.at(-1).body;
  assert.equal(body.resources.length, 200);
  assert.ok(!body.resources.some((r) => r.name.startsWith('tk-100')), 'the last by slug left out');
  assert.ok(get().health.warnings.some((w) => /Only 200 of 202 overlay URLs are shared/.test(w)), JSON.stringify(get().health.warnings));
  assert.deepEqual([get().info.hub.overlays, get().info.hub.resources], [100, 200]);
});

test('the hub hears from it every 30 s; an app id another token owns is a warning saying what to do', { timeout: 60000 }, async (t) => {
  const clock = fakeClock(Date.now());
  const ctx = await start(t, { clock, ms: { heartbeatMs: 20 } });
  const { ms, platform } = ctx;
  ms.ownApp('ctd-overlay-dprtmnt');
  const owned = await connect(ctx, { token: ms.addToken({ profileId: 'p-dprtmnt' }) });
  const conn = await connect(ctx, { token: ms.addToken({ profileId: 'default' }) });
  const step = async (ms2) => { await clock.advance(ms2); await new Promise((r) => setTimeout(r, 100)); };
  await step(0);
  const puts = (id) => ms.requests.filter((r) => r.method === 'PUT' && r.path === `/api/v1/apps/${id}`).length;
  await until(() => puts('ctd-overlay-main') === 1, 8000, 'the first registration');
  const ow = () => platform.connectors.get(owned.id);
  await until(() => ow().health.warnings.some((w) => /Another CTD Relay token already registered the app "ctd-overlay-dprtmnt".*delete the old/.test(w)), 8000, 'the app_owned warning');
  assert.equal(ow().info.hub.status, 'failed');
  assert.ok(running(ow().health.status), 'chat and status still work');
  await step(29000);
  assert.equal(puts('ctd-overlay-main'), 1, 'not before 30 s');
  await step(1000);
  await until(() => puts('ctd-overlay-main') === 2, 3000, 'at 30 s');
  await step(30000);
  await until(() => puts('ctd-overlay-main') === 3, 3000, 'at 60 s');
  // The old app deleted there: the next one registers it.
  ms.apps.delete('ctd-overlay-dprtmnt');
  await step(30000);
  await until(() => ow().info.hub.status === 'shared' && !ow().health.warnings.length, 3000, 'registered once it is free');
  assert.ok(running(platform.connectors.get(conn.id).health.status));
});

test('overlay.create from another app makes one, bound to this connection only and recorded; refusals are answered too; at most what it asks', { timeout: 60000 }, async (t) => {
  const ctx = await start(t);
  const { ms, platform, api } = ctx;
  const conn = await connect(ctx, { token: ms.addToken({ profileId: 'p-dprtmnt' }) });
  const get = () => platform.connectors.get(conn.id);
  await until(() => get().info?.hub?.status === 'shared', 8000, 'registered');
  const reply = (id) => ms.messages.find((m) => m.replyTo === id);
  const ask = async (data, extra = {}) => {
    const id = ms.injectMessage({ to: 'ctd-overlay-dprtmnt', type: 'overlay.create', profileId: 'p-dprtmnt', data, ...extra });
    await until(() => reply(id), 8000, `the answer to ${JSON.stringify(data)}`);
    return reply(id);
  };

  const a = await ask({ template: 'takeover', canvas: 'vertical' });
  assert.deepEqual([a.to, a.from, a.type, a.profileId, a.data.ok], ['ctd-obs-plugin-studio', 'ctd-overlay-dprtmnt', 'overlay.created', 'p-dprtmnt', true], JSON.stringify(a));
  const made = platform.overlays.resolve('takeover-dprtmnt').doc;
  assert.deepEqual(made.data.connections, [conn.id]);
  assert.deepEqual(a.data.resource, { type: 'overlay', id: `${made.id}:v`, name: 'takeover-dprtmnt — vertical', profileId: 'p-dprtmnt', url: `${SHARED}/o/takeover-dprtmnt?key=${platform.overlays.key('takeover-dprtmnt')}&canvas=v`, width: 1080, height: 1920, meta: { canvas: 'vertical', slot: 'takeover-vertical', transparent: true } });
  // Registered before the answer went.
  const at = ms.messages.indexOf(a);
  assert.ok(ms.registrations.some((r) => r.at <= a.at && r.body.resources.some((x) => x.id === `${made.id}:v`)), 'in the hub when answered');
  assert.ok(at >= 0);
  const entry = platform.audit.list({ action: 'overlay.create' }).items[0];
  assert.deepEqual([entry.actor, entry.target, entry.details.connection, entry.details.via], ['app:ctd-obs-plugin-studio', 'takeover-dprtmnt', conn.id, 'Relay · DPRTMNT']);
  // By its id, every canvas, a second one: its own slug.
  const b = await ask({ template: 'com.dprtmnt.takeover' });
  assert.equal(b.data.ok, true);
  assert.deepEqual(b.data.resources.map((r) => [r.name, r.meta.canvas]), [['takeover-dprtmnt-2 — landscape', 'landscape'], ['takeover-dprtmnt-2 — vertical', 'vertical']]);
  // Refusals, in plain words.
  assert.match((await ask({ template: 'nope' })).data.reason, /no template "nope" installed/);
  assert.match((await ask({ template: 'viewers', canvas: 'vertical' })).data.reason, /Viewer count has no vertical canvas/);
  assert.match((await ask({ template: 'takeover', canvas: 'square' })).data.reason, /"canvas" is "landscape" or "vertical"/);
  assert.equal((await api('PATCH', `/connections/${conn.id}`, { config: { baseUrl: `${ms.url}/api/v1`, allowAppOverlays: false } })).status, 200);
  await until(() => running(get().health.status) && get().info?.hub?.status === 'shared', 8000, 'running again');
  const off = await ask({ template: 'takeover' });
  assert.deepEqual([off.type, off.data.ok], ['overlay.created', false]);
  assert.match(off.data.reason, /turned off in CTD Overlay/);
  assert.equal(platform.overlays.resolve('takeover-dprtmnt-3'), undefined, 'nothing made');
  // A type it doesn't handle, addressed to it: answered; a broadcast: not.
  const odd = ms.injectMessage({ to: 'ctd-overlay-dprtmnt', type: 'scene.take', profileId: 'p-dprtmnt', data: {} });
  await until(() => reply(odd), 5000, 'the answer to scene.take');
  assert.deepEqual([reply(odd).type, reply(odd).data], ['error', { ok: false, reason: 'CTD Overlay doesn\'t handle scene.take.' }]);
  const cast = ms.injectMessage({ to: null, type: 'scene.take', profileId: 'p-dprtmnt', data: {} });
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(reply(cast), undefined, 'a broadcast isn\'t answered');
  assert.equal(platform.overlays.list().filter((d) => d.data.slug.startsWith('takeover-dprtmnt')).length, 2, 'each request handled once');
});

test('where OBS reaches the platform; app ids; resources and canvases as the hub wants them', () => {
  assert.deepEqual(shareBase({ hosts: ['192.168.1.50:4850'], exposure: 'lan' }, { scheme: 'http', port: 4848 }), { url: 'http://192.168.1.50:4850' });
  assert.deepEqual(shareBase({ hosts: ['nas.home.arpa'], exposure: 'lan' }, { scheme: 'http', port: 4848 }), { url: 'http://nas.home.arpa:4848' });
  assert.deepEqual(shareBase({ hosts: ['nas.home.arpa'], exposure: 'public', publicUrl: 'https://overlays.example.com' }, { scheme: 'http', port: 4848 }), { url: 'https://overlays.example.com' });
  assert.match(shareBase({ hosts: [], exposure: 'lan' }, { scheme: 'http', port: 4848 }).problem, /SKP_HOSTS/);
  assert.match(shareBase({ hosts: ['192.168.1.50:4850'], exposure: 'local' }, { scheme: 'http', port: 4848 }).problem, /SKP_EXPOSURE=lan/);
  assert.deepEqual([appIdFor({ limited: true, slug: 'dprtmnt' }), appIdFor({ limited: false, slug: 'dprtmnt' }), appIdFor({ limited: true, slug: 'A Very Long Profile Slug That Goes On And On' })], ['ctd-overlay-dprtmnt', 'ctd-overlay', 'ctd-overlay-a-very-long-profile-slug-tha']);
  const square = [{ id: 'sq', width: 1080, height: 1080 }];
  assert.deepEqual([canvasKind(square, square[0]), canvasKind([{ id: 'tall', width: 500, height: 900 }], { id: 'tall', width: 500, height: 900 })], ['landscape', 'vertical']);
  const two = resourcesOf({ id: 'ovl_1', slug: 'x', template: { id: 'com.a.b' }, canvases: [{ id: 'a', kind: 'landscape', width: 1920, height: 1080, url: 'http://h/o/x' }, { id: 'b', kind: 'landscape', width: 1280, height: 720, url: 'http://h/o/x?canvas=b' }, { id: 'c', kind: 'vertical', width: 1, height: 2 }] }, null);
  assert.deepEqual(two.map((r) => [r.name, r.meta.slot, r.profileId]), [['x — landscape (a)', 'b-landscape', null], ['x — landscape (b)', 'b-landscape-2', null]], 'a canvas without a URL is left out');
});
