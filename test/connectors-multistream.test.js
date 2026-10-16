// CTD Multi-Stream (PLAN step 16b), against a pretend Multi-Stream on 127.0.0.1: its merged chat
// reaches an overlay bound to every connection and a deletion takes a line off; an alert reaches a
// template that consumes alerts (its chat line hidden); viewers.<platform> and viewers.total from
// its status; a destination down makes the connection degraded, saying why; after a disconnect it
// resumes from its cursor without duplicates; a reset backfills quietly; a revoked token is
// needs-reauth with what to do; a 429 is waited out; the token never reaches a log line. Its token
// reads every profile (the pretend one has two), so the connection follows both (step 16c).
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
  // (The token reads every profile, so it follows both: the destination's profile is named.)
  assert.equal(get().health.detail, 'Instagram (Miami or Bust): ended the live (copyright). Starting a new one…');

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
  ms.emit('chat.message', { ...msg('y1', 'from youtube'), id: 'youtube:y1', platform: 'youtube', destinationId: 'd-yt', user: { id: 'youtube:UC1', name: 'Owl', roles: [] } }, { platform: 'youtube', destination: 'd-yt' });
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
  assert.equal(ms.requests.filter((r) => r.path === '/api/v1/chat').length, 2, 'no backfill on a resume (once per profile, when it started)');
  await until(() => get().health.status === 'degraded', 3000, 'running again');
});

test('a reset (the cursor no longer buffered) reads /status and /chat again, quietly, with no duplicates', { timeout: 30000 }, async (t) => {
  const { ms, live, channel } = await start(t);
  ms.emit('chat.message', msg('a', 'one'), { platform: 'twitch', destination: 'd-tw' });
  await until(() => liveOf(live, 'chat.message', 'twitch:a').length === 1, 3000, 'a');
  ms.dropStreams();
  ms.emit('chat.message', msg('b', 'during the restart'), { platform: 'twitch', destination: 'd-tw' });
  ms.forget();
  await until(() => ms.requests.filter((r) => r.path === '/api/v1/chat').length === 4, 8000, 'a backfill (of both profiles)');
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

test('stopping closes its event stream: settings saves, off and on, a quiet reconnect and a delete never leave one open', { timeout: 60000 }, async (t) => {
  const { ms, platform, get, conn } = await start(t);
  const H = signedIn(platform, { 'content-type': 'application/json' });
  const patch = async (body) => {
    const r = await fetch(`${platform.url}/api/v1/connections/${conn.id}`, { method: 'PATCH', headers: H, body: JSON.stringify(body) });
    assert.equal(r.status, 200, await r.text());
  };
  const streams = () => ms.requests.filter((r) => r.path === '/api/v1/events').length;
  const one = (what) => until(() => ['connected', 'degraded'].includes(get().health.status) && ms.openStreams === 1, 5000, `${what}: connected over one stream`);
  await one('started');
  // More saves than the 5 streams CTD allows a token: each closes the stream it replaces.
  for (let i = 1; i <= 6; i++) {
    await patch({ config: { baseUrl: `${ms.url}/api/v1`, hideAlertChatLines: i % 2 === 0 } });
    await one(`save ${i}`);
  }
  assert.equal(streams(), 7);
  await patch({ enabled: false });
  await until(() => get().health.status === 'disabled' && ms.openStreams === 0, 5000, 'off: no stream');
  await patch({ enabled: true });
  await one('on again');
  // The watchdog's reconnect (it went quiet): the old stream closes, the new one opens.
  const n = streams();
  platform.connectors.runnerOf(conn.id).ctx.fail(new Error('CTD Multi-Stream went quiet for 45 s; reconnecting.'));
  await until(() => streams() === n + 1, 8000, 'the reconnect');
  await one('reconnected');
  const del = await fetch(`${platform.url}/api/v1/connections/${conn.id}`, { method: 'DELETE', headers: H });
  assert.equal(del.status, 200);
  await until(() => ms.openStreams === 0, 3000, 'no stream after the delete');
});

test('a /clear removes that destination\'s lines from before a reconnect too; a replay over the publish limit and a /clear of a full buffer lose nothing', { timeout: 60000 }, async (t) => {
  const { ms, platform, live, get } = await start(t);
  const buffered = () => platform.bus.chatRecent().map((e) => e.data.id);
  const reconnected = async (n) => until(() => ms.requests.filter((r) => r.path === '/api/v1/events').length === n && ms.openStreams === 1 && ['connected', 'degraded'].includes(get().health.status), 8000, 'reconnected');
  for (const id of ['a', 'b', 'c']) ms.emit('chat.message', msg(id, id), { platform: 'twitch', destination: 'd-tw' });
  ms.emit('chat.message', { ...msg('y1', 'from youtube'), id: 'youtube:y1', platform: 'youtube', destinationId: 'd-yt', user: { id: 'youtube:UC1', name: 'Owl', roles: [] } }, { platform: 'youtube', destination: 'd-yt' });
  await until(() => buffered().length === 4, 3000, 'four lines');
  ms.dropStreams();
  await reconnected(2);
  ms.emit('chat.message', msg('d', 'd'), { platform: 'twitch', destination: 'd-tw' });
  await until(() => buffered().length === 5, 3000, 'd');
  ms.emit('chat.cleared', { platform: 'twitch', destinationId: 'd-tw' }, { platform: 'twitch', destination: 'd-tw' });
  await until(() => buffered().join() === 'youtube:y1', 3000, 'Twitch cleared, from before the reconnect too');
  assert.deepEqual(['a', 'b', 'c', 'd'].map((id) => liveOf(live, 'chat.message.deleted', `twitch:${id}`).length), [1, 1, 1, 1]);
  // 400 lines while it was away: the replay is twice the 200 a second overlays may get, and all of
  // it arrives, in order (it waits for room rather than dropping the rest).
  ms.dropStreams();
  for (let i = 0; i < 400; i++) ms.emit('chat.message', msg(`r${i}`, `missed ${i}`), { platform: 'twitch', destination: 'd-tw' });
  await until(() => liveOf(live, 'chat.message').filter((e) => e.data.id.startsWith('twitch:r')).length === 400, 10000, 'the whole replay');
  const order = liveOf(live, 'chat.message').filter((e) => e.data.id.startsWith('twitch:r')).map((e) => Number(e.data.id.slice(8)));
  assert.deepEqual(order, [...order].sort((x, y) => x - y));
  assert.equal(get().health.status === 'error', false, get().health.detail);
  // A /clear right after it removes all 200 lines the buffer holds, the newest too.
  ms.emit('chat.cleared', { platform: 'twitch', destinationId: 'd-tw' }, { platform: 'twitch', destination: 'd-tw' });
  await until(() => !buffered().some((id) => id.startsWith('twitch:')), 3000, 'every Twitch line gone');
  assert.equal(liveOf(live, 'chat.message.deleted', 'twitch:r399').length, 1);
});

test('an event line shows unless its alert follows; a ban by name only removes that user\'s lines', { timeout: 30000 }, async (t) => {
  const { ms, live, platform } = await start(t);
  // A Twitch /announce is an event line no alert follows: it is shown, briefly held.
  const sent = Date.now();
  ms.emit('chat.message', msg('ann', 'Giveaway at 10pm!', { kind: 'event', highlighted: true }), { platform: 'twitch', destination: 'd-tw' });
  await until(() => liveOf(live, 'chat.message', 'twitch:ann').length === 1, 3000, 'the announcement');
  assert.ok(Date.now() - sent < 1500, 'held for a moment only');
  assert.equal(liveOf(live, 'chat.message', 'twitch:ann')[0].data.kind, 'event');
  // A sub's line is followed by its alert: the alert shows, the line doesn't.
  ms.emit('chat.message', msg('e2', 'DJFan subscribed!', { kind: 'event' }), { platform: 'twitch', destination: 'd-tw' });
  ms.emit('alert.subscription', { kind: 'subscription', user: { id: 'twitch:144552210', name: 'DJFan' }, amount: { unit: 'months', value: 1 }, platform: 'twitch', destinationId: 'd-tw', messageId: 'twitch:e2', ts: Date.now() }, { platform: 'twitch', destination: 'd-tw' });
  ms.emit('chat.message', msg('after', 'after the sub'), { platform: 'twitch', destination: 'd-tw' });
  await until(() => liveOf(live, 'chat.message', 'twitch:after').length === 1, 3000, 'the next line');
  await new Promise((r) => setTimeout(r, 500));
  assert.deepEqual([liveOf(live, 'alert.subscription').length, liveOf(live, 'chat.message', 'twitch:e2').length], [1, 0]);
  // A ban that names the user only ("kick:name:…"): their line, which carries an id, goes; others stay.
  const kick = (id, user) => ({ ...msg(id, 'spam'), id: `kick:${id}`, platform: 'kick', destinationId: 'd-kk', user: { roles: [], ...user } });
  ms.emit('chat.message', kick('k1', { id: 'kick:777', login: 'spammer', name: 'Spammer' }), { platform: 'kick', destination: 'd-kk' });
  ms.emit('chat.message', kick('k2', { id: 'kick:778', login: 'fan', name: 'Fan' }), { platform: 'kick', destination: 'd-kk' });
  await until(() => liveOf(live, 'chat.message', 'kick:k2').length === 1, 3000, 'the Kick lines');
  ms.emit('chat.user.cleared', { userId: 'kick:name:SPAMMER', userName: 'SPAMMER', platform: 'kick', destinationId: 'd-kk' }, { platform: 'kick', destination: 'd-kk' });
  await until(() => !platform.bus.chatRecent().some((e) => e.data.id === 'kick:k1'), 3000, 'the banned user\'s line gone');
  assert.ok(platform.bus.chatRecent().some((e) => e.data.id === 'kick:k2'), 'the others stay');
});

test('ages are judged on CTD\'s clock, and only for the replay: a clock 150 s behind still plays live chat and alerts', { timeout: 30000 }, async (t) => {
  const SKEW = -150 * 1000;
  const ms = await startFakeMultistream();
  ms.skewMs = SKEW;
  defer(t, () => ms.close());
  const root = tempDir(t);
  const config = loadConfig({ argv: ['--port', '0'], env: { SKP_DATA_DIR: path.join(root, 'data'), SKP_CONFIG_DIR: path.join(root, 'config') } });
  const platform = await startPlatform(config, { log: memoryLogger().log, templateDirs: [FIXTURE_TEMPLATES], connectors: { random: () => 0.5 } });
  defer(t, () => platform.stop());
  platform.overlays.create({ slug: 'main', template: TESTBED, settings: {} });
  const live = [];
  platform.overlays.resolve('main').channel.subscribe((env) => live.push(env));
  const made = await fetch(`${platform.url}/api/v1/connections`, { method: 'POST', headers: signedIn(platform, { 'content-type': 'application/json' }), body: JSON.stringify({ connector: 'ctd-multistream', name: 'Multi-Stream', config: { baseUrl: `${ms.url}/api/v1` }, secrets: { token: ms.token } }) });
  const conn = await made.json();
  const get = () => platform.connectors.get(conn.id);
  await until(() => ['connected', 'degraded'].includes(get().health.status), 5000, 'connected');
  const sub = (id) => ({ kind: 'subscription', user: { id: 'twitch:1', name: 'DJFan' }, amount: { unit: 'months', value: 2 }, platform: 'twitch', destinationId: 'd-tw', messageId: `twitch:${id}`, ts: Date.now() });
  ms.emit('chat.message', msg('now', 'said just now'), { platform: 'twitch', destination: 'd-tw' });
  ms.emit('alert.subscription', sub('s1'), { platform: 'twitch', destination: 'd-tw' });
  await until(() => liveOf(live, 'chat.message', 'twitch:now').length === 1 && liveOf(live, 'alert.subscription').length === 1, 3000, 'live chat and the alert, played');
  // Missed while away and 200 s old on CTD's clock: the line goes to the buffer quietly, the alert is dropped.
  ms.dropStreams();
  ms.skewMs = SKEW - 200 * 1000;
  ms.emit('chat.message', msg('old', 'said while away'), { platform: 'twitch', destination: 'd-tw' });
  ms.emit('alert.subscription', sub('s2'), { platform: 'twitch', destination: 'd-tw' });
  ms.skewMs = SKEW;
  await until(() => platform.bus.chatRecent().some((e) => e.data.id === 'twitch:old'), 8000, 'the old line, in the buffer');
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual([liveOf(live, 'chat.message', 'twitch:old').length, liveOf(live, 'alert.subscription').length], [0, 1]);
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
