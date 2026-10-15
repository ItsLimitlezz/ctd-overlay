// The alert queue (05 §5.5): alerts paced on the server, one at a time (or a few, stacked), in
// priority order, a gift burst as one alert, windows that never overlap, fresh ids for replay.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { alertSpec, createAlertQueue } from '../src/alerts/queue.js';
import { startPlatform } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { defer, FIXTURE_TEMPLATES, memoryLogger, tempDir, TESTBED } from './helpers.js';

// A clock that only moves when told to, with timers that fire as it does.
function fakeClock(start = 1_000_000) {
  let t = start;
  const due = [];
  const timers = {
    setTimeout(fn, ms) { const h = { at: t + ms, fn }; due.push(h); return h; },
    clearTimeout(h) { const i = due.indexOf(h); if (i >= 0) due.splice(i, 1); },
  };
  const advance = (ms) => {
    const end = t + ms;
    for (;;) {
      due.sort((a, b) => a.at - b.at);
      if (!due.length || due[0].at > end) break;
      const h = due.shift();
      t = h.at;
      h.fn();
    }
    t = end;
  };
  return { now: () => t, timers, advance };
}

let n = 0;
const env = (kind, extra = {}, platform = 'twitch') => ({ id: `E${String(++n).padStart(4, '0')}`, type: `alert.${kind}`, ts: 0, src: { connector: 'x', connection: 'c1', platform }, data: { kind, user: { id: `${platform}:u`, name: 'U' }, ...extra } });

function harness({ specs = { a: alertSpec({ alerts: { durationMs: 5000, gapMs: 500 } }) }, groups = {} } = {}) {
  const clock = fakeClock();
  const sent = []; // [channel, env]
  const cuts = [];
  let ids = 0;
  const q = createAlertQueue({
    groupOf: (id) => groups[id],
    specOf: (id) => specs[id],
    deliver: (id, e) => sent.push([id, e]),
    cut: (targets, alertId) => cuts.push([targets, alertId]),
    stamp: (e, data) => ({ ...e, id: `S${String(++ids).padStart(4, '0')}`, ts: clock.now(), data }),
    now: clock.now, timers: clock.timers,
  });
  return { q, clock, sent, cuts };
}

test('alertSpec: the template\'s alerts settings, its durationSetting applied and clamped, defaults otherwise', () => {
  assert.deepEqual(alertSpec({}), { mode: 'serial', durationMs: 6000, gapMs: 500, maxConcurrent: 3, maxQueue: 50, coalesce: true });
  const m = { alerts: { mode: 'serial', durationMs: 7000, durationSetting: 'holdMs', gapMs: 600 } };
  assert.equal(alertSpec(m, {}).durationMs, 7000);
  assert.equal(alertSpec(m, { holdMs: 4000 }).durationMs, 4000);
  assert.equal(alertSpec(m, { holdMs: 100 }).durationMs, 1000);
  assert.equal(alertSpec(m, { holdMs: 999999 }).durationMs, 60000);
  assert.equal(alertSpec({ alerts: { mode: 'stack', maxConcurrent: 2 } }).maxConcurrent, 2);
});

test('a burst plays one at a time: each window starts after the last one and its gap, never overlapping', () => {
  const { q, clock, sent } = harness();
  q.enqueue(env('follow'), ['a']);
  q.enqueue(env('cheer', { amount: { value: 500, unit: 'bits' } }), ['a']);
  q.enqueue(env('subscription'), ['a']);
  assert.equal(sent.length, 1, 'only the first goes out at once');
  clock.advance(60000);
  assert.equal(sent.length, 3);
  const windows = sent.map(([, e]) => e.data.display);
  for (let i = 1; i < windows.length; i++) {
    assert.ok(windows[i].startAt >= windows[i - 1].startAt + windows[i - 1].durationMs + 500, `window ${i} starts after ${i - 1} and the gap`);
  }
  assert.ok(windows.every((w) => w.durationMs === 5000));
  // Each window starts a little after it is sent, so every source has it in time.
  assert.ok(sent.every(([, e]) => e.data.display.startAt > e.ts));
});

test('waiting alerts go in priority order: a raid before a follow that came first', () => {
  const { q, clock, sent } = harness();
  q.enqueue(env('cheer', { amount: { value: 100, unit: 'bits' } }), ['a']); // on screen at once
  q.enqueue(env('follow'), ['a']);
  q.enqueue(env('subscription'), ['a']);
  q.enqueue(env('raid', { amount: { value: 50, unit: 'viewers' } }), ['a']);
  clock.advance(60000);
  assert.deepEqual(sent.map(([, e]) => e.data.kind), ['cheer', 'raid', 'subscription', 'follow']);
});

test('a gift of 25 and the 25 single gifts that follow it are one alert of 25, whether it is still waiting or already on screen', () => {
  // On screen already: the singles are part of it.
  {
    const { q, clock, sent } = harness();
    q.enqueue(env('gift', { amount: { value: 25, unit: 'count' }, tier: '1' }), ['a']);
    for (let i = 0; i < 25; i++) q.enqueue(env('gift', { amount: { value: 1, unit: 'count' }, gift: { recipients: [`r${i}`], total: 1 } }), ['a']);
    clock.advance(120000);
    assert.equal(sent.length, 1);
    assert.equal(sent[0][1].data.amount.value, 25);
  }
  // Waiting behind another alert: merged while it waits.
  {
    const { q, clock, sent } = harness();
    q.enqueue(env('raid', { amount: { value: 10, unit: 'viewers' } }), ['a']);
    q.enqueue(env('gift', { amount: { value: 5, unit: 'count' } }), ['a']);
    for (let i = 0; i < 5; i++) q.enqueue(env('gift', { amount: { value: 1, unit: 'count' }, gift: { recipients: [`r${i}`] } }), ['a']);
    clock.advance(120000);
    assert.deepEqual(sent.map(([, e]) => [e.data.kind, e.data.amount.value]), [['raid', 10], ['gift', 5]]);
    assert.equal(sent[1][1].data.coalesced, 6);
    assert.deepEqual(sent[1][1].data.gift.recipients, ['r0', 'r1', 'r2', 'r3', 'r4']);
  }
  // Three single gifts from one person while another alert shows: one alert of 3.
  {
    const { q, clock, sent } = harness();
    q.enqueue(env('follow'), ['a']);
    for (let i = 0; i < 3; i++) q.enqueue(env('gift', { amount: { value: 1, unit: 'count' } }), ['a']);
    clock.advance(60000);
    assert.deepEqual(sent.map(([, e]) => [e.data.kind, e.data.amount?.value]), [['follow', undefined], ['gift', 3]]);
  }
  // Gifts from different people, or anonymous ones, are their own alerts.
  {
    const { q, clock, sent } = harness();
    q.enqueue(env('follow'), ['a']);
    q.enqueue({ ...env('gift', { amount: { value: 1, unit: 'count' } }), data: { kind: 'gift', user: { id: 'twitch:x', name: 'X' }, amount: { value: 1, unit: 'count' } } }, ['a']);
    q.enqueue({ ...env('gift', { amount: { value: 1, unit: 'count' } }), data: { kind: 'gift', user: { id: 'twitch:y', name: 'Y' }, amount: { value: 1, unit: 'count' } } }, ['a']);
    q.enqueue({ ...env('gift'), data: { kind: 'gift', user: { name: 'Anonymous', anonymous: true }, amount: { value: 1, unit: 'count' } } }, ['a']);
    q.enqueue({ ...env('gift'), data: { kind: 'gift', user: { name: 'Anonymous', anonymous: true }, amount: { value: 1, unit: 'count' } } }, ['a']);
    clock.advance(120000);
    assert.equal(sent.length, 5);
  }
});

test('members of a show share one queue: both get each alert with the same window, paced by the longer duration', () => {
  const specs = { h: alertSpec({ alerts: { durationMs: 4000 } }), v: alertSpec({ alerts: { durationMs: 6000 } }) };
  const { q, clock, sent } = harness({ specs, groups: { h: 'show1', v: 'show1' } });
  q.enqueue(env('follow'), ['h', 'v']);
  q.enqueue(env('raid'), ['h', 'v']);
  clock.advance(60000);
  assert.deepEqual(sent.map(([id]) => id), ['h', 'v', 'h', 'v']);
  assert.deepEqual(sent[0][1], sent[1][1], 'the same envelope, window and id to both');
  assert.equal(sent[0][1].data.display.durationMs, 6000);
  assert.ok(sent[2][1].data.display.startAt >= sent[0][1].data.display.startAt + 6000);
});

test('overlays outside a show have queues of their own: one busy overlay doesn\'t hold back another', () => {
  const specs = { a: alertSpec({}), b: alertSpec({}) };
  const { q, sent } = harness({ specs });
  q.enqueue(env('follow'), ['a']);
  q.enqueue(env('raid'), ['b']);
  q.enqueue(env('subscription'), ['a', 'b']);
  assert.deepEqual(sent.map(([id, e]) => `${id}:${e.data.kind}`), ['a:follow', 'b:raid']);
});

test('stack mode shows up to maxConcurrent at once, a gap apart', () => {
  const { q, clock, sent } = harness({ specs: { a: alertSpec({ alerts: { mode: 'stack', maxConcurrent: 2, durationMs: 5000, gapMs: 300 } }) } });
  for (let i = 0; i < 4; i++) q.enqueue(env('follow'), ['a']);
  clock.advance(400);
  assert.equal(sent.length, 2, 'two on screen');
  clock.advance(60000);
  assert.equal(sent.length, 4);
  const starts = sent.map(([, e]) => e.data.display.startAt);
  assert.ok(starts[1] - starts[0] >= 300);
  assert.ok(starts[2] >= starts[0] + 5000, 'the third waits for a slot');
});

test('past maxQueue the oldest of the lowest priority is dropped', () => {
  const { q, clock, sent } = harness({ specs: { a: alertSpec({ alerts: { maxQueue: 3 } }) } });
  q.enqueue(env('raid'), ['a']); // on screen
  q.enqueue(env('follow', { user: { id: 'f1', name: 'F1' } }), ['a']);
  q.enqueue(env('follow', { user: { id: 'f2', name: 'F2' } }), ['a']);
  q.enqueue(env('cheer'), ['a']);
  q.enqueue(env('subscription'), ['a']); // 4 waiting: F1 goes
  clock.advance(120000);
  assert.deepEqual(sent.map(([, e]) => e.data.user.name === 'U' ? e.data.kind : e.data.user.name), ['raid', 'subscription', 'cheer', 'F2']);
});

test('pause holds alerts, resume plays them; skip cuts the one on screen; replay queues the last again with a new id', () => {
  const { q, clock, sent, cuts } = harness();
  q.pause();
  q.enqueue(env('follow'), ['a']);
  clock.advance(10000);
  assert.equal(sent.length, 0);
  assert.equal(q.list()[0].waiting.length, 1);
  q.resume();
  assert.equal(sent.length, 1);
  q.enqueue(env('raid'), ['a']);
  clock.advance(1000);
  q.skip();
  assert.deepEqual(cuts, [[['a'], sent[0][1].id]]);
  clock.advance(600);
  assert.equal(sent.length, 2, 'the next one after the gap, not the whole duration');
  clock.advance(10000);
  assert.ok(q.replay());
  clock.advance(10000);
  assert.equal(sent.length, 3);
  assert.equal(sent[2][1].data.kind, 'raid');
  assert.notEqual(sent[2][1].id, sent[1][1].id);
});

test('each alert goes out with a fresh id, so a reconnecting overlay\'s replay (ids after its cursor) still has it', () => {
  const { q, clock, sent } = harness();
  const a = env('follow');
  const b = env('raid');
  q.enqueue(a, ['a']);
  q.enqueue(b, ['a']);
  clock.advance(60000);
  assert.notEqual(sent[0][1].id, a.id);
  assert.ok(sent[1][1].id > sent[0][1].id);
  assert.equal(sent[1][1].ts, sent[1][1].data.display.startAt - 400);
});

test('on the platform: a burst published on the bus reaches an alerts overlay one window at a time; chat isn\'t held back', async (t) => {
  const root = tempDir(t);
  const config = loadConfig({ argv: ['--port', '0'], env: { SKP_DATA_DIR: path.join(root, 'data'), SKP_CONFIG_DIR: path.join(root, 'config') } });
  const { log } = memoryLogger();
  const platform = await startPlatform(config, { log, templateDirs: [FIXTURE_TEMPLATES] });
  defer(t, () => platform.stop());
  // The testbed: serial alerts, its alertHold setting as the duration.
  platform.overlays.create({ slug: 'alerts', template: TESTBED, settings: { alertHold: 1000 } });
  const got = [];
  platform.overlays.resolve('alerts').channel.subscribe((e) => got.push(e));
  const src = { connector: 'test', platform: 'twitch' };
  platform.bus.publish('alert.follow', { kind: 'follow', user: { id: 'twitch:1', name: 'A' } }, { src });
  platform.bus.publish('alert.raid', { kind: 'raid', user: { id: 'twitch:2', name: 'B' }, amount: { value: 9, unit: 'viewers' } }, { src });
  const alerts = () => got.filter((e) => e.type.startsWith('alert.'));
  assert.deepEqual(alerts().map((e) => e.data.kind), ['follow']);
  assert.equal(alerts()[0].data.display.durationMs, 1000);
  await new Promise((r) => setTimeout(r, 2500));
  assert.deepEqual(alerts().map((e) => e.data.kind), ['follow', 'raid']);
  const [w1, w2] = alerts().map((e) => e.data.display);
  assert.ok(w2.startAt >= w1.startAt + w1.durationMs, 'no overlap');
  assert.ok(platform.alerts.list().length >= 1);
  // Chat isn't queued.
  platform.bus.publish('custom.ping', { n: 1 }, { src });
  assert.equal(got.at(-1).type, 'custom.ping');
});

test('a simulated alert waits its turn behind a real one', async (t) => {
  const root = tempDir(t);
  const config = loadConfig({ argv: ['--port', '0'], env: { SKP_DATA_DIR: path.join(root, 'data'), SKP_CONFIG_DIR: path.join(root, 'config') } });
  const { log } = memoryLogger();
  const platform = await startPlatform(config, { log, templateDirs: [FIXTURE_TEMPLATES] });
  defer(t, () => platform.stop());
  const doc = platform.overlays.create({ slug: 'alerts', template: TESTBED, settings: {} });
  const got = [];
  platform.overlays.resolve('alerts').channel.subscribe((e) => got.push(e));
  platform.bus.publish('alert.follow', { kind: 'follow', user: { name: 'A' } }, { src: { connector: 'test' } });
  platform.bus.publish('alert.raid', { kind: 'raid', user: { name: 'B' } }, { src: { connector: 'simulator' }, target: doc.id });
  assert.deepEqual(got.filter((e) => e.type.startsWith('alert.')).map((e) => e.data.kind), ['follow']);
});
