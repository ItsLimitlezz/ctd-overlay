// CTD Multi-Stream (PLAN step 16b), against a pretend Multi-Stream on 127.0.0.1: its merged chat
// reaches an overlay bound to every connection and a deletion takes a line off; an alert reaches a
// template that consumes alerts (its chat line hidden); viewers.<platform> and viewers.total from
// its status; a destination down makes the connection degraded, saying why; after a disconnect it
// resumes from its cursor without duplicates; a reset backfills quietly; a revoked token is
// needs-reauth with what to do; a 429 is waited out; the token never reaches a log line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { startPlatform } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { alertOf, chatMessage } from '../src/connectors/defs/ctd-multistream.js';
import { until } from './connector-helpers.js';
import { startFakeMultistream } from './fixtures/fake-multistream.mjs';
import { defer, FIXTURE_TEMPLATES, memoryLogger, signedIn, tempDir, TESTBED } from './helpers.js';

const msg = (id, text, extra = {}) => ({
  id: `twitch:${id}`, platform: 'twitch', channel: 'Twitch', destinationId: 'd-tw', platformMessageId: id,
  user: { id: 'twitch:144552210', login: 'djfan', name: 'DJFan', color: '#1E90FF', avatar: null, badges: [{ id: 'subscriber/12', label: 'subscriber' }], roles: ['subscriber'] },
  text, fragments: [{ type: 'text', text }], reply: null, highlighted: false, action: false, kind: 'message', ts: Date.now(), ...extra,
});

async function start(t, { history = [] } = {}) {
  const ms = await startFakeMultistream();
  defer(t, () => ms.close());
  for (const m of history) ms.emit('chat.message', m, { platform: 'twitch', destination: 'd-tw' });
  const root = tempDir(t);
  const config = loadConfig({ argv: ['--port', '0'], env: { SKP_DATA_DIR: path.join(root, 'data'), SKP_CONFIG_DIR: path.join(root, 'config') } });
  const { log, entries } = memoryLogger();
  const platform = await startPlatform(config, { log, templateDirs: [FIXTURE_TEMPLATES], connectors: { random: () => 0.5 } });
  defer(t, () => platform.stop());
  platform.overlays.create({ slug: 'main', template: TESTBED, settings: {} });
  const channel = platform.overlays.resolve('main').channel;
  const live = [];
  channel.subscribe((env) => live.push(env));
  const made = await fetch(`${platform.url}/api/v1/connections`, { method: 'POST', headers: signedIn(platform, { 'content-type': 'application/json' }), body: JSON.stringify({ connector: 'ctd-multistream', name: 'Multi-Stream', config: { baseUrl: `${ms.url}/api/v1` }, secrets: { token: ms.token } }) });
  assert.equal(made.status, 201, await made.clone().text());
  const conn = await made.json();
  const get = () => platform.connectors.get(conn.id);
  await until(() => ['connected', 'degraded'].includes(get().health.status), 5000, 'connected');
  return { ms, platform, channel, live, conn, get, entries };
}
const liveOf = (live, type, id) => live.filter((e) => e.type === type && (id === undefined || e.data.id === id || e.data.messageId === id));

test('chat, deletions, alerts and counts reach an overlay bound to every connection; a destination down is degraded, saying why', { timeout: 30000 }, async (t) => {
  const { ms, platform, channel, live, get, entries } = await start(t, { history: [msg('m0', 'before we connected')] });
  // Backfill: in the buffer (a snapshot shows it), never played live.
  assert.deepEqual(channel.snapshot().chat.recent.map((m) => m.id), ['twitch:m0']);
  assert.equal(liveOf(live, 'chat.message').length, 0);
  // Counts and status from /status: one per platform, the total summed, unknown absent (never 0).
  const state = channel.snapshot().state;
  assert.deepEqual([state['viewers.twitch'], state['viewers.youtube'], state['viewers.total'], 'viewers.instagram' in state], [214, 30, 244, false]);
  // The TAKEOVER look consumes only the total: it gets it, worked out from the platforms' counts.
  platform.overlays.create({ slug: 'tk', template: { id: 'com.dprtmnt.takeover', version: '1.0.0' }, settings: {} });
  const tk = platform.overlays.resolve('tk').channel.snapshot().state;
  assert.deepEqual([tk['viewers.total'], 'viewers.twitch' in tk], [244, false]);
  assert.equal(platform.bus.getState('stream.twitch.live'), true);
  assert.equal(platform.bus.getState('stream.instagram.live'), false);
  assert.equal(platform.bus.getState('stream.twitch.title'), 'DPRTMNT Saturday');
  assert.equal(get().health.status, 'degraded');
  assert.equal(get().health.detail, 'Instagram: ended the live (copyright). Starting a new one…');

  // Live chat, with the platform it came from.
  ms.emit('chat.message', msg('m1', 'this set is fire'), { platform: 'twitch', destination: 'd-tw' });
  await until(() => liveOf(live, 'chat.message', 'twitch:m1').length === 1, 3000, 'live chat');
  const m1 = liveOf(live, 'chat.message', 'twitch:m1')[0];
  assert.deepEqual([m1.src.connector, m1.src.platform, m1.data.platform, m1.data.user.id, m1.data.user.color], ['ctd-multistream', 'twitch', 'twitch', 'twitch:144552210', '#1E90FF']);
  assert.equal('avatar' in m1.data.user, false, 'null fields left out');
  // A deletion takes it off.
  ms.emit('chat.message.deleted', { messageId: 'twitch:m1', platformMessageId: 'm1', platform: 'twitch', destinationId: 'd-tw' }, { platform: 'twitch', destination: 'd-tw' });
  await until(() => liveOf(live, 'chat.message.deleted', 'twitch:m1').length === 1, 3000, 'the deletion');
  assert.deepEqual(channel.snapshot().chat.recent.map((m) => m.id), ['twitch:m0']);
  // An alert: its chat line hidden (alerts are on), the alert in this standard's shape.
  ms.emit('chat.message', msg('e1', 'DJFan subscribed for 12 months!', { kind: 'event' }), { platform: 'twitch', destination: 'd-tw' });
  ms.emit('alert.subscription', { kind: 'subscription', user: { id: 'twitch:144552210', name: 'DJFan' }, amount: { unit: 'months', value: 12 }, tier: '1000', message: { text: 'a year!' }, platform: 'twitch', destinationId: 'd-tw', messageId: 'twitch:e1', ts: Date.now() }, { platform: 'twitch', destination: 'd-tw' });
  await until(() => liveOf(live, 'alert.subscription').length === 1, 3000, 'the alert');
  const alert = liveOf(live, 'alert.subscription')[0].data;
  assert.deepEqual([alert.kind, alert.tier, alert.amount, alert.user.name], ['subscription', '1', { value: 12, unit: 'months' }, 'DJFan']);
  assert.equal(liveOf(live, 'chat.message', 'twitch:e1').length, 0, 'the alert\'s chat line is hidden');
  // A count moves; a destination comes back: connected.
  ms.emit('destination.status', { ...ms.status.destinations[0], viewers: 300 }, { platform: 'twitch', destination: 'd-tw' });
  await until(() => channel.snapshot().state['viewers.total'] === 330, 3000, 'the new total');
  ms.emit('destination.up', { destinationId: 'd-ig', name: 'Instagram', platform: 'instagram', downForSec: 41, recoveries: 1 }, { platform: 'instagram', destination: 'd-ig' });
  await until(() => get().health.status === 'connected', 3000, 'connected');
  // A clear on one platform takes that platform's lines only.
  ms.emit('chat.message', { ...msg('y1', 'from youtube'), id: 'youtube:y1', platform: 'youtube', user: { id: 'youtube:UC1', name: 'Owl', roles: [] } }, { platform: 'youtube', destination: 'd-yt' });
  ms.emit('chat.message', msg('m2', 'still here'), { platform: 'twitch', destination: 'd-tw' });
  await until(() => channel.snapshot().chat.recent.length === 3, 3000, 'three lines');
  ms.emit('chat.cleared', { platform: 'youtube', destinationId: 'd-yt' }, { platform: 'youtube', destination: 'd-yt' });
  await until(() => channel.snapshot().chat.recent.map((m) => m.id).join() === 'twitch:m0,twitch:m2', 3000, 'youtube cleared');
  // Notices are the operator's: a warning on the connection, never on an overlay.
  ms.emit('system.notice', { level: 'warn', message: 'Instagram ended the live (copyright).' });
  await until(() => get().health.warnings.includes('Instagram ended the live (copyright).'), 3000, 'the notice');
  assert.equal(live.filter((e) => e.type === 'system.notice').length, 0);
  assert.ok(!JSON.stringify(entries).includes(ms.token), 'the token is in no log line');
  // The Test button: the token's permissions.
  const tested = await fetch(`${platform.url}/api/v1/connections/${get().id}/test`, { method: 'POST', headers: signedIn(platform, { 'content-type': 'application/json' }), body: '{}' });
  const out = await tested.json();
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.deepEqual(out.checks.at(-1), { name: 'Token permissions', ok: true, detail: 'chat:read and status:read' });
});

test('after a disconnect it resumes from its cursor: what was missed arrives once, nothing twice', { timeout: 30000 }, async (t) => {
  const { ms, live, get } = await start(t);
  ms.emit('chat.message', msg('a', 'one'), { platform: 'twitch', destination: 'd-tw' });
  await until(() => liveOf(live, 'chat.message', 'twitch:a').length === 1, 3000, 'a');
  ms.dropStreams();
  ms.emit('chat.message', msg('b', 'missed'), { platform: 'twitch', destination: 'd-tw' });
  await until(() => liveOf(live, 'chat.message', 'twitch:b').length === 1, 8000, 'b, after reconnecting');
  const resumed = ms.requests.filter((r) => r.path === '/api/v1/events').at(-1);
  assert.ok(resumed.headers['last-event-id'], 'resumed with Last-Event-ID');
  ms.emit('chat.message', msg('c', 'after'), { platform: 'twitch', destination: 'd-tw' });
  await until(() => liveOf(live, 'chat.message', 'twitch:c').length === 1, 3000, 'c');
  assert.deepEqual(['twitch:a', 'twitch:b', 'twitch:c'].map((id) => liveOf(live, 'chat.message', id).length), [1, 1, 1]);
  assert.equal(ms.requests.filter((r) => r.path === '/api/v1/chat').length, 1, 'no backfill on a resume');
  await until(() => get().health.status === 'degraded', 3000, 'running again');
});

test('a reset (the cursor no longer buffered) reads /status and /chat again, quietly, with no duplicates', { timeout: 30000 }, async (t) => {
  const { ms, live, channel } = await start(t);
  ms.emit('chat.message', msg('a', 'one'), { platform: 'twitch', destination: 'd-tw' });
  await until(() => liveOf(live, 'chat.message', 'twitch:a').length === 1, 3000, 'a');
  ms.dropStreams();
  ms.emit('chat.message', msg('b', 'during the restart'), { platform: 'twitch', destination: 'd-tw' });
  ms.forget();
  await until(() => ms.requests.filter((r) => r.path === '/api/v1/chat').length === 2, 8000, 'a backfill');
  await until(() => channel.snapshot().chat.recent.some((m) => m.id === 'twitch:b'), 3000, 'b in the buffer');
  assert.equal(liveOf(live, 'chat.message', 'twitch:b').length, 0, 'backfilled, not played');
  assert.equal(channel.snapshot().chat.recent.filter((m) => m.id === 'twitch:a').length, 1, 'no duplicate');
});

test('a revoked token is needs-reauth, saying where to make a new one, with no retry loop; a 429 is waited out', { timeout: 30000 }, async (t) => {
  const { ms, get, platform } = await start(t);
  ms.tooMany = 1;
  ms.dropStreams();
  await until(() => get().health.status === 'error' && /limiting requests/.test(get().health.detail), 5000, 'the 429');
  await until(() => ['connected', 'degraded'].includes(get().health.status), 8000, 'back after the pause');
  ms.revoked = true;
  ms.dropStreams();
  await until(() => get().health.status === 'needs-reauth', 8000, 'needs-reauth');
  assert.match(get().health.detail, /revoked or is wrong.*Settings → API/);
  const n = ms.requests.length;
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(ms.requests.length, n, 'no retry until the token is changed');
  // A new token, pasted in: it connects again.
  ms.revoked = false;
  ms.token = `ctd_pat_${'R'.repeat(43)}`;
  const patched = await fetch(`${platform.url}/api/v1/connections/${get().id}`, { method: 'PATCH', headers: signedIn(platform, { 'content-type': 'application/json' }), body: JSON.stringify({ secrets: { token: ms.token } }) });
  assert.equal(patched.status, 200);
  await until(() => ['connected', 'degraded'].includes(get().health.status), 8000, 'connected with the new token');
});

test('chat and alerts in this standard\'s shapes: nulls left out, roles closed, text cut at 1000, money a string', () => {
  const m = chatMessage({ id: 'tiktok:name:x:1', user: { id: 'snapchat:9', name: 'X', roles: ['subscriber', 'emperor'], color: 'red', avatar: 'http://not-https' }, text: 'y'.repeat(1200), fragments: [{ type: 'sticker', text: 'y'.repeat(1200) }] }, 'tiktok');
  assert.equal(m.user.id, 'custom:snapchat:9');
  assert.deepEqual(m.user.roles, ['subscriber']);
  assert.equal('color' in m.user || 'avatar' in m.user, false);
  assert.deepEqual([m.text.length, m.truncated, m.fragments], [1000, true, [{ type: 'text', text: 'y'.repeat(1000) }]]);
  const a = alertOf({ user: { anonymous: true }, amount: { unit: 'currency', value: '5.00', currency: 'USD' }, tier: 'Prime', gift: { total: 5, recipients: ['a', 3] } }, 'superchat', 'youtube');
  assert.deepEqual(a, { kind: 'superchat', user: { name: 'Anonymous', anonymous: true }, platform: 'youtube', amount: { value: '5.00', unit: 'currency', currency: 'USD' }, tier: 'prime', gift: { recipients: ['a'], total: 5 } });
  assert.equal(alertOf({ amount: { unit: 'currency', value: 5 } }, 'tip', 'x').amount, undefined, 'money must be a decimal string');
});
