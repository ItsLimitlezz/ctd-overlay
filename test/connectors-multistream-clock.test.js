// CTD Relay's stream clock (its §4, GET /clock, v1.3), against a pretend Relay: NTP-style samples
// a second apart, the one with the lowest round trip kept; the session's start moved onto this
// server's clock as stream.clock; again every 5 minutes, after a reconnect, and for one profile
// when its session starts or stops; a Relay older than v1.3 asked once and said so once; every
// profile's clock its own, reaching only the overlays it feeds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { startPlatform } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { fakeClock, until } from './connector-helpers.js';
import { startFakeMultistream } from './fixtures/fake-multistream.mjs';
import { defer, memoryLogger, signedIn, tempDir } from './helpers.js';

const TEXT_CLOCK = { id: 'com.ctd.text-clock', version: '1.0.0' };
const RELAY_START = Date.parse('2026-10-17T03:00:04Z'); // the pretend Relay's default session start, on its clock
const running = (s) => ['connected', 'degraded'].includes(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function start(t, { clock, ms: msOptions } = {}) {
  const ms = await startFakeMultistream(msOptions);
  defer(t, () => ms.close());
  const root = tempDir(t);
  const config = loadConfig({ argv: ['--port', '0'], env: { SKP_DATA_DIR: path.join(root, 'data'), SKP_CONFIG_DIR: path.join(root, 'config') } });
  const { log, entries } = memoryLogger();
  const platform = await startPlatform(config, { log, connectors: { random: () => 0.5 }, ...(clock ? { clock: { now: clock.now, timers: clock.timers } } : {}) });
  defer(t, () => platform.stop());
  const connect = async (token) => {
    const r = await fetch(`${platform.url}/api/v1/connections`, { method: 'POST', headers: signedIn(platform, { 'content-type': 'application/json' }), body: JSON.stringify({ connector: 'ctd-multistream', config: { baseUrl: `${ms.url}/api/v1` }, secrets: { token } }) });
    assert.equal(r.status, 201, await r.clone().text());
    const conn = await r.json();
    return () => platform.connectors.get(conn.id);
  };
  const clockAsks = () => ms.requests.filter((r) => r.path === '/api/v1/clock');
  return { ms, platform, entries, connect, clockAsks };
}

test('a sync keeps the sample with the lowest round trip, moves the session\'s start onto this server\'s clock, and runs again every 5 min, after a reconnect and when the session changes', { timeout: 90000 }, async (t) => {
  const clock = fakeClock(Date.now());
  const { ms, connect, clockAsks } = await start(t, { clock, ms: { heartbeatMs: 20 } });
  // The Relay's clock is 90 s ahead. Six answers, each with its own way out, time there and way
  // back; the third has the shortest round trip (6 ms), and its way out is 2 ms shorter than its
  // way back, so its offset is 1 ms short: that is the one kept (the round trip is the best guide).
  ms.clock.advance = (d) => { clock.t += d; };
  ms.clock.offsetMs = 90000;
  ms.clock.fps = 25;
  ms.clock.samples = [
    { outMs: 40, backMs: 40 }, { outMs: 5, procMs: 3, backMs: 25 }, { outMs: 2, procMs: 1, backMs: 4 },
    { outMs: 60, backMs: 10 }, { outMs: 20, backMs: 20 }, { outMs: 10, backMs: 50 },
  ];
  const get = await connect(ms.addToken({ profileId: 'default' }));
  // The fake clock moves only when told: in steps under the 15 s quiet check, with real time
  // between them for the stream's heartbeats and the requests.
  const step = async (ms2) => { await clock.advance(ms2); await sleep(60); };
  const advance = async (total) => { for (let left = total; left > 0; left -= 10000) await step(Math.min(10000, left)); };
  const state = () => get().state['stream.clock'];
  await until(async () => { await step(1000); return running(get().health.status) && state(); }, 20000, 'the first sync');

  assert.equal(clockAsks().length, 6, 'six answers, a second apart');
  const t0s = clockAsks().map((r) => Number(r.query.t0));
  for (let i = 1; i < t0s.length; i++) assert.ok(t0s[i] - t0s[i - 1] >= 1000, `a second apart: ${t0s}`);
  const s = state();
  assert.deepEqual([s.offsetMs, s.startedAt, s.fps], [89999, RELAY_START - 89999, 25]);
  assert.ok(Number.isInteger(s.at) && s.at <= clock.t && s.at >= t0s[2], 'when the kept sample was taken, on this server\'s clock');
  assert.deepEqual(Object.keys(s).sort(), ['at', 'fps', 'offsetMs', 'startedAt']);

  // Nothing more until 5 minutes after it; then six more. The Relay's clock moved meanwhile.
  ms.clock.offsetMs = 1000;
  await advance(5 * 60 * 1000 - 8000);
  assert.equal(clockAsks().length, 6, 'not before 5 min');
  await until(async () => { await step(1000); return clockAsks().length >= 12 && state().offsetMs === 1000; }, 20000, 'the re-sync');
  assert.equal(clockAsks().length, 12);
  assert.deepEqual([state().offsetMs, state().startedAt], [1000, RELAY_START - 1000]);

  // A session that starts again (a new start) is read at once, with that offset; one that stops
  // leaves no start.
  ms.status.session = { ...ms.status.session, status: 'live', startedAt: '2026-10-17T05:00:00.000Z' };
  ms.emit('stream.status', ms.status.session);
  await until(async () => { await step(500); return state().startedAt === Date.parse('2026-10-17T05:00:00Z') - 1000; }, 10000, 'the new start');
  assert.equal(clockAsks().length, 13, 'one answer, not a whole sync');
  ms.status.session = { ...ms.status.session, status: 'idle', startedAt: null };
  ms.emit('stream.status', ms.status.session);
  await until(async () => { await step(500); return state() && !('startedAt' in state()); }, 10000, 'stopped');
  assert.deepEqual([state().fps, state().offsetMs], [25, 1000]);
  // The same session again is nothing to read.
  ms.emit('stream.status', ms.status.session);
  await step(1000);
  assert.equal(clockAsks().length, 14);

  // Reconnected (the stream dropped): synced again, at once.
  ms.status.session = { ...ms.status.session, status: 'live', startedAt: '2026-10-17T03:00:04Z' };
  ms.clock.offsetMs = -2500;
  const before = clockAsks().length;
  ms.dropStreams();
  await until(async () => { await step(1000); return clockAsks().length >= before + 6 && state()?.offsetMs === -2500; }, 30000, 'synced after the reconnect');
  assert.equal(state().startedAt, RELAY_START + 2500);
});

test('a Relay older than v1.3 (no /clock) is asked once and says so in one warning; no clock, nothing logged as a problem', { timeout: 30000 }, async (t) => {
  const { ms, entries, connect, clockAsks } = await start(t);
  ms.clock.missing = true;
  const get = await connect(ms.addToken({ profileId: 'default' }));
  await until(() => running(get().health.status) && get().health.warnings.some((w) => /older than v1\.3/.test(w)), 8000, 'the note');
  await sleep(1500);
  assert.equal(clockAsks().length, 1, 'asked once');
  assert.deepEqual(get().health.warnings.filter((w) => /clock/.test(w)), ['This CTD Relay is older than v1.3: overlays get no stream clock (run time, timecode). Update CTD Relay to use them.']);
  assert.equal(get().state['stream.clock'], undefined);
  assert.ok(running(get().health.status), 'chat and status still work');
  assert.deepEqual(entries.filter((e) => ['warn', 'error'].includes(e.level) && /clock/i.test(JSON.stringify(e))), []);

  // A token without status:read is never asked.
  ms.clock.missing = false;
  const n = clockAsks().length;
  const other = await connect(ms.addToken({ profileId: 'p-dprtmnt', scopes: ['chat:read'] }));
  await until(() => other().health.status !== 'connecting', 8000, 'the second connection started');
  await sleep(500);
  assert.equal(clockAsks().length, n);
});

test('following every profile, each one\'s clock is its own and reaches only the overlays it feeds; a profile that goes live is read at once', { timeout: 60000 }, async (t) => {
  const { ms, platform, connect, clockAsks } = await start(t);
  const get = await connect(ms.addToken({ profileId: null }));
  const id = get().id;
  const slugs = { miami: [`${id}/default`], dprtmnt: [`${id}/p-dprtmnt`], whole: [id] };
  for (const [slug, connections] of Object.entries(slugs)) platform.overlays.create({ slug, template: TEXT_CLOCK, settings: {}, connections });
  const seen = (slug) => platform.overlays.resolve(slug).channel.snapshot().state['stream.clock'];
  const feed = (profile) => get().feeds?.find((f) => f.profile === profile)?.state['stream.clock'];
  // Six answers a second apart, the profiles' in turn.
  await until(() => feed('default') && feed('p-dprtmnt'), 15000, 'both profiles\' clocks');
  assert.deepEqual(new Set(clockAsks().map((r) => r.query.profile)), new Set(['default', 'p-dprtmnt']));
  assert.equal(get().state['stream.clock'], undefined, 'nothing of the connection\'s own');

  // Miami or Bust is live (its start on this server's clock: the same clock here, within the
  // round trip); DPRTMNT is idle: a clock with no start.
  assert.ok(Math.abs(feed('default').startedAt - RELAY_START) <= 50, JSON.stringify(feed('default')));
  assert.equal('startedAt' in feed('p-dprtmnt'), false);
  assert.deepEqual(seen('miami'), feed('default'));
  assert.deepEqual(seen('dprtmnt'), feed('p-dprtmnt'));
  assert.deepEqual(seen('whole'), feed('default'), 'the whole connection: one profile\'s (the lower id)');

  // DPRTMNT goes live: read at once, for DPRTMNT's overlays only.
  const miami = seen('miami');
  const n = clockAsks().length;
  ms.setProfileStatus('p-dprtmnt', 'live');
  const started = Date.parse(ms.statuses['p-dprtmnt'].session.startedAt);
  await until(() => Number.isFinite(seen('dprtmnt')?.startedAt), 5000, 'DPRTMNT\'s start');
  assert.ok(Math.abs(seen('dprtmnt').startedAt - started) <= 50);
  assert.deepEqual(clockAsks().slice(n).map((r) => r.query.profile), ['p-dprtmnt'], 'one answer, DPRTMNT\'s');
  assert.deepEqual(seen('miami'), miami, 'Miami or Bust\'s overlays unchanged');

  // A profile deleted there: its clock goes with its other values.
  ms.deleteProfile('p-dprtmnt');
  await until(() => !get().feeds?.some((f) => f.profile === 'p-dprtmnt'), 5000, 'DPRTMNT gone');
  assert.equal(seen('dprtmnt'), undefined);
  assert.deepEqual(seen('miami'), miami);
});
