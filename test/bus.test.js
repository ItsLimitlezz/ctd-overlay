import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BusError, createBus } from '../src/bus/index.js';
import { TYPE } from '../src/bus/names.js';
import { createUlid } from '../src/ids.js';
import { memoryLogger } from './helpers.js';

// A bus on a hand-cranked clock, so coalescing windows and buffer ages are exact.
function fixture() {
  let t = Date.UTC(2026, 9, 10, 23, 0);
  let seq = 0;
  const timers = new Map();
  const clock = {
    now: () => t,
    timers: {
      setTimeout(fn, ms) { const id = ++seq; timers.set(id, { at: t + ms, fn }); return id; },
      clearTimeout(id) { timers.delete(id); },
    },
    advance(ms) {
      const until = t + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, x]) => x.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        t = due[1].at;
        due[1].fn();
      }
      t = until;
    },
    pendingTimers: () => timers.size,
  };
  const { log, entries } = memoryLogger();
  const bus = createBus({ now: clock.now, idgen: createUlid(), timers: clock.timers, log });
  return { bus, clock, entries };
}

const twitch = { connector: 'twitch', connection: 'con_tw', platform: 'twitch' };
const kick = { connector: 'kick', connection: 'con_kk', platform: 'kick' };
const chatMsg = (id, user, text = 'hi') => ({ id, user: { id: user, name: user, roles: [] }, text, fragments: [{ type: 'text', text }] });

// Collects what a channel delivers live.
function watch(ch) {
  const got = [];
  ch.subscribe((env) => got.push(env));
  return got;
}

describe('envelopes', () => {
  test('publish stamps an increasing id, server time and the source', () => {
    const { bus, clock } = fixture();
    const a = bus.publish('custom.ping', { n: 1 });
    clock.advance(5);
    const b = bus.publish('chat.message', chatMsg('m1', 'twitch:1'), { src: twitch });
    assert.ok(b.id > a.id);
    assert.equal(b.ts - a.ts, 5);
    assert.deepEqual(a.src, { connector: 'core' });
    assert.deepEqual(b.src, twitch);
    assert.equal(bus.cursor(), b.id);
  });

  test('only registered and namespaced custom types are accepted (02 §2.6–2.7)', () => {
    const { bus } = fixture();
    for (const type of ['alert.follow', 'alerts.cut', 'show.trigger', 'media.play', 'custom.goal', 'x-streamdeck.button']) {
      assert.doesNotThrow(() => bus.publish(type, {}), type);
    }
    for (const type of ['goal.reached', 'alert', 'Custom.x', 'x-.y', '']) {
      assert.throws(() => bus.publish(type, {}), (e) => e instanceof BusError && e.code === 'bad-type', type);
    }
    assert.throws(() => bus.publish('state.changed', { key: 'a' }), /setState/);
  });

  test('the accepted types are exactly the envelope schema\'s type pattern', () => {
    const schema = JSON.parse(readFileSync(new URL('../docs/standard/schemas/envelope.schema.json', import.meta.url), 'utf8'));
    assert.equal(TYPE.source, schema.properties.type.pattern);
  });

  test('data must be a JSON object; envelopes over 64 KiB are refused (02 §2.9)', () => {
    const { bus } = fixture();
    assert.throws(() => bus.publish('custom.x', [1]), /JSON object/);
    assert.throws(() => bus.publish('custom.x', { n: 1n }), /JSON/);
    assert.throws(() => bus.publish('custom.x', { s: 'x'.repeat(70000) }), (e) => e.code === 'too-large');
    assert.throws(() => bus.publish('custom.x', {}, { src: {} }), /src.connector/);
  });

  test('published data is detached from the caller', () => {
    const { bus } = fixture();
    const data = { list: [1] };
    const env = bus.publish('custom.x', data);
    data.list.push(2);
    assert.deepEqual(env.data.list, [1]);
  });
});

describe('state', () => {
  test('setState publishes state.changed with key, value and prev, only on a real change', () => {
    const { bus } = fixture();
    const seen = [];
    bus.subscribeAll((env) => seen.push(env));
    bus.setState('viewers.total', 1140);
    bus.setState('viewers.total', 1159);
    assert.equal(bus.setState('viewers.total', 1159), null);
    assert.deepEqual(seen.map((e) => e.data), [{ key: 'viewers.total', value: 1140 }, { key: 'viewers.total', value: 1159, prev: 1140 }]);
    assert.equal(bus.getState('viewers.total'), 1159);
  });

  test('undefined removes a key: absent, never null or 0 (02 §2.8)', () => {
    const { bus } = fixture();
    bus.setState('viewers.twitch', 50);
    const env = bus.setState('viewers.twitch', undefined);
    assert.deepEqual(env.data, { key: 'viewers.twitch', prev: 50 });
    assert.equal('value' in env.data, false);
    assert.equal(bus.getState('viewers.twitch'), undefined);
    assert.equal(bus.setState('viewers.twitch', undefined), null);
  });

  test('bad keys are refused and values are copies', () => {
    const { bus } = fixture();
    assert.throws(() => bus.setState('Viewers', 1), (e) => e.code === 'bad-key');
    assert.throws(() => bus.setState('a..b', 1), (e) => e.code === 'bad-key');
    const track = { title: 'Strobe' };
    bus.setState('music.nowPlaying', track);
    track.title = 'changed';
    bus.getState('music.nowPlaying').title = 'changed';
    assert.equal(bus.getState('music.nowPlaying').title, 'Strobe');
  });
});

describe('channels: what an overlay may see', () => {
  test('state keys by exact name or prefix, plus the runtime keys', () => {
    const { bus } = fixture();
    const ch = bus.channel('ovl_a', { consumes: { state: ['viewers.total', 'music.*'] } });
    const got = watch(ch);
    bus.setState('viewers.total', 1);
    bus.setState('viewers.twitch', 1);
    bus.setState('music.nowPlaying', { title: 'x' });
    bus.setState('show.scene', 'brb');
    bus.setState('obs.scene', 'Live');
    assert.deepEqual(got.map((e) => e.data.key), ['viewers.total', 'music.nowPlaying', 'show.scene']);
  });

  test('events by declared pattern; runtime types always; operator-only never', () => {
    const { bus } = fixture();
    const ch = bus.channel('ovl_a', { consumes: { events: ['alert.*', 'media.play'] } });
    const got = watch(ch);
    for (const type of ['alert.follow', 'alert.raid', 'media.play', 'media.stop', 'custom.x', 'show.scene.changed', 'show.trigger', 'system.notice', 'system.connection', 'alerts.cut']) {
      bus.publish(type, {});
    }
    assert.deepEqual(got.map((e) => e.type), ['alert.follow', 'alert.raid', 'media.play', 'show.scene.changed', 'show.trigger', 'alerts.cut']);
  });

  test('chat reaches only overlays that consume chat', () => {
    const { bus } = fixture();
    const withChat = watch(bus.channel('ovl_chat', { consumes: { chat: { recent: 10 } }, connections: ['con_tw'] }));
    const without = watch(bus.channel('ovl_show', { connections: ['con_tw'] }));
    bus.publish('chat.message', chatMsg('m1', 'twitch:1'), { src: twitch });
    bus.publish('chat.cleared', {}, { src: twitch });
    assert.equal(withChat.length, 2);
    assert.equal(without.length, 0);
  });

  test('data from unbound connections never reaches an overlay (01 §1.3)', () => {
    const { bus } = fixture();
    const ch = bus.channel('ovl_a', { consumes: { state: ['viewers.*'], chat: {} }, connections: ['con_tw'] });
    const got = watch(ch);
    bus.publish('chat.message', chatMsg('m1', 'twitch:1'), { src: twitch });
    bus.publish('chat.message', chatMsg('m2', 'kick:1'), { src: kick });
    bus.setState('viewers.kick', 9, { src: kick });
    bus.setState('viewers.total', 10); // core: always passes the binding check
    assert.deepEqual(got.map((e) => e.data.id || e.data.key), ['m1', 'viewers.total']);
    assert.deepEqual(Object.keys(ch.snapshot().state), ['viewers.total']);
  });

  test('reconfiguring a channel changes what it accepts from then on', () => {
    const { bus } = fixture();
    const ch = bus.channel('ovl_a', { consumes: { events: [] } });
    const got = watch(ch);
    bus.publish('alert.follow', {});
    bus.channel('ovl_a', { consumes: { events: ['alert.*'] } });
    bus.publish('alert.follow', {});
    assert.equal(got.length, 1);
  });

  test('bad consumes patterns are refused', () => {
    const { bus } = fixture();
    assert.throws(() => bus.channel('ovl_a', { consumes: { events: ['alert*'] } }), /bad event pattern/);
    assert.throws(() => bus.channel('ovl_b', { consumes: { state: [3] } }), /must be a string/);
  });
});

describe('snapshots', () => {
  test('a snapshot has the cursor, filtered state, channel-only state and the chat buffer', () => {
    const { bus } = fixture();
    bus.setState('viewers.total', 1159);
    bus.setState('obs.scene', 'Live');
    const ch = bus.channel('ovl_a', { consumes: { state: ['viewers.*'], chat: { recent: 2 } }, connections: ['con_tw'] });
    ch.setLocalState('overlay.settings', { accent: '#16e0ff' });
    for (const id of ['m1', 'm2', 'm3']) bus.publish('chat.message', chatMsg(id, 'twitch:1'), { src: twitch });
    const snap = ch.snapshot();
    assert.equal(snap.cursor, bus.cursor());
    assert.deepEqual(snap.state, { 'viewers.total': 1159, 'overlay.settings': { accent: '#16e0ff' } });
    assert.deepEqual(snap.chat.recent.map((m) => m.id), ['m2', 'm3']);
  });

  test('the chat buffer applies deletions, bans and clears (02 §2.3)', () => {
    const { bus } = fixture();
    const ch = bus.channel('ovl_chat', { consumes: { chat: { recent: 50 } }, connections: ['con_tw'] });
    bus.publish('chat.message', chatMsg('m1', 'twitch:1'), { src: twitch });
    bus.publish('chat.message', chatMsg('m2', 'twitch:2'), { src: twitch });
    bus.publish('chat.message', chatMsg('m3', 'twitch:2'), { src: twitch });
    bus.publish('chat.message', chatMsg('m4', 'twitch:3'), { src: twitch });
    bus.publish('chat.message.deleted', { messageId: 'm1' }, { src: twitch });
    bus.publish('chat.user.cleared', { userId: 'twitch:2' }, { src: twitch });
    assert.deepEqual(ch.snapshot().chat.recent.map((m) => m.id), ['m4']);
    bus.publish('chat.cleared', {}, { src: twitch });
    assert.deepEqual(ch.snapshot().chat.recent, []);
  });

  test('the chat buffer holds the last 200 messages and recent is clamped to 0–200', () => {
    const { bus } = fixture();
    const big = bus.channel('ovl_big', { consumes: { chat: { recent: 999 } }, connections: ['con_tw'] });
    const none = bus.channel('ovl_none', { consumes: { chat: { recent: 0 } }, connections: ['con_tw'] });
    for (let i = 0; i < 250; i++) bus.publish('chat.message', chatMsg(`m${i}`, 'twitch:1'), { src: twitch });
    const recent = big.snapshot().chat.recent;
    assert.equal(recent.length, 200);
    assert.equal(recent[0].id, 'm50');
    assert.deepEqual(none.snapshot().chat.recent, []);
  });

  test('a template that does not consume chat gets no chat in its snapshot', () => {
    const { bus } = fixture();
    assert.equal('chat' in bus.channel('ovl_a', {}).snapshot(), false);
  });
});

describe('replay', () => {
  test('since(cursor) returns everything after the cursor, in order', () => {
    const { bus } = fixture();
    const ch = bus.channel('ovl_a', { consumes: { events: ['custom.*'] } });
    const { cursor } = ch.snapshot();
    const a = bus.publish('custom.a', {});
    const b = bus.publish('custom.b', {});
    assert.deepEqual(ch.since(cursor).envelopes.map((e) => e.id), [a.id, b.id]);
    assert.deepEqual(ch.since(a.id), { envelopes: [b], cursor: b.id });
    assert.deepEqual(ch.since(b.id), { envelopes: [], cursor: b.id });
  });

  test('a cursor from before the channel existed, or from a previous run, is gone (410)', () => {
    const { bus, clock } = fixture();
    const old = bus.publish('custom.a', {}).id;
    clock.advance(10);
    const latest = bus.publish('custom.b', {}).id;
    const ch = bus.channel('ovl_a', { consumes: { events: ['custom.*'] } });
    assert.deepEqual(ch.since(old), { gone: true }); // custom.b may have been missed
    assert.deepEqual(ch.since(latest), { envelopes: [], cursor: latest }); // nothing missed
    for (const bad of ['', 'not a cursor', 'zzzzzzzzzzzzzzzzzzzzzzzzzz', 42, undefined]) {
      assert.deepEqual(ch.since(bad), { gone: true }, String(bad));
    }
  });

  test('the buffer keeps at least 120 s or 500 envelopes, whichever is more (01 §1.5)', () => {
    const { bus, clock } = fixture();
    const ch = bus.channel('ovl_a', { consumes: { events: ['custom.*'] } });
    const first = ch.snapshot().cursor;
    for (let i = 0; i < 600; i++) bus.publish('custom.tick', { i });
    assert.equal(ch.bufferSize, 600); // all within 120 s
    assert.equal(ch.since(first).envelopes.length, 600);
    clock.advance(121000);
    bus.publish('custom.tick', { i: 600 });
    assert.equal(ch.bufferSize, 500); // the old ones may go now, down to 500
    assert.deepEqual(ch.since(first), { gone: true });
  });

  test('a flood is capped at 5000 envelopes; a client that far behind re-fetches the snapshot', () => {
    const { bus } = fixture();
    const ch = bus.channel('ovl_a', { consumes: { events: ['custom.*'] } });
    const first = ch.snapshot().cursor;
    for (let i = 0; i < 5200; i++) bus.publish('custom.tick', {});
    assert.equal(ch.bufferSize, 5000);
    assert.deepEqual(ch.since(first), { gone: true });
  });
});

describe('coalescing: at most 10 state.changed per key per second per overlay (02 §2.9)', () => {
  test('a burst sends the first change at once and the latest value when the window ends', () => {
    const { bus, clock } = fixture();
    const ch = bus.channel('ovl_a', { consumes: { state: ['viewers.*'] } });
    const got = watch(ch);
    for (let v = 1; v <= 5; v++) { bus.setState('viewers.total', v); clock.advance(10); }
    assert.deepEqual(got.map((e) => e.data.value), [1]);
    clock.advance(100);
    assert.deepEqual(got.map((e) => e.data), [{ key: 'viewers.total', value: 1 }, { key: 'viewers.total', value: 5, prev: 1 }]);
  });

  test('a value that changes back inside the window sends nothing more', () => {
    const { bus, clock } = fixture();
    const ch = bus.channel('ovl_a', { consumes: { state: ['viewers.*'] } });
    const got = watch(ch);
    bus.setState('viewers.total', 1);
    bus.setState('viewers.total', 2);
    bus.setState('viewers.total', 1);
    clock.advance(200);
    assert.deepEqual(got.map((e) => e.data.value), [1]);
  });

  test('different keys are limited separately, and changes 100 ms apart all go through', () => {
    const { bus, clock } = fixture();
    const ch = bus.channel('ovl_a', { consumes: { state: ['viewers.*'] } });
    const got = watch(ch);
    bus.setState('viewers.total', 1);
    bus.setState('viewers.twitch', 1);
    clock.advance(100);
    bus.setState('viewers.total', 2);
    assert.deepEqual(got.map((e) => `${e.data.key}=${e.data.value}`), ['viewers.total=1', 'viewers.twitch=1', 'viewers.total=2']);
  });

  test('a removal inside the window arrives as a removal', () => {
    const { bus, clock } = fixture();
    const ch = bus.channel('ovl_a', { consumes: { state: ['viewers.*'] } });
    const got = watch(ch);
    bus.setState('viewers.total', 7);
    bus.setState('viewers.total', undefined);
    clock.advance(100);
    assert.deepEqual(got.map((e) => e.data), [{ key: 'viewers.total', value: 7 }, { key: 'viewers.total', prev: 7 }]);
  });

  test('coalesced envelopes are also in the replay buffer', () => {
    const { bus, clock } = fixture();
    const ch = bus.channel('ovl_a', { consumes: { state: ['viewers.*'] } });
    const { cursor } = ch.snapshot();
    bus.setState('viewers.total', 1);
    bus.setState('viewers.total', 2);
    clock.advance(100);
    assert.deepEqual(ch.since(cursor).envelopes.map((e) => e.data.value), [1, 2]);
  });
});

describe('isolation', () => {
  test('channel-only state never reaches other overlays or API subscribers', () => {
    const { bus } = fixture();
    const all = [];
    bus.subscribeAll((e) => all.push(e));
    const a = bus.channel('ovl_a', {});
    const bGot = watch(bus.channel('ovl_b', {}));
    const aGot = watch(a);
    a.setLocalState('show.scene', 'brb');
    assert.equal(aGot.length, 1);
    assert.equal(bGot.length, 0);
    assert.equal(all.length, 0);
    assert.equal(bus.getState('show.scene'), undefined);
  });

  test('a targeted publish (the simulator) reaches one overlay only, and not the chat buffer', () => {
    const { bus } = fixture();
    const all = [];
    bus.subscribeAll((e) => all.push(e));
    const a = watch(bus.channel('ovl_a', { consumes: { chat: {} } }));
    const b = watch(bus.channel('ovl_b', { consumes: { chat: {} } }));
    bus.publish('chat.message', chatMsg('sim1', 'twitch:9'), { src: { connector: 'simulator' }, target: 'ovl_a' });
    assert.equal(a.length, 1);
    assert.equal(b.length, 0);
    assert.equal(all.length, 0);
    assert.deepEqual(bus.chatRecent(), []);
  });

  test('a subscriber that throws is logged and does not stop delivery to the others', () => {
    const { bus, entries } = fixture();
    const ch = bus.channel('ovl_a', { consumes: { events: ['custom.*'] } });
    ch.subscribe(() => { throw new Error('bad subscriber'); });
    const got = watch(ch);
    bus.subscribeAll(() => { throw new Error('bad global'); });
    bus.publish('custom.x', {});
    assert.equal(got.length, 1);
    assert.equal(entries.filter((e) => e.level === 'error').length, 2);
  });

  test('removing a channel cancels its pending timers and stops delivery', () => {
    const { bus, clock } = fixture();
    const ch = bus.channel('ovl_a', { consumes: { state: ['viewers.*'] } });
    const got = watch(ch);
    bus.setState('viewers.total', 1);
    bus.setState('viewers.total', 2);
    assert.equal(clock.pendingTimers(), 1);
    bus.removeChannel('ovl_a');
    assert.equal(clock.pendingTimers(), 0);
    clock.advance(500);
    bus.setState('viewers.total', 3);
    assert.equal(got.length, 1);
  });
});
