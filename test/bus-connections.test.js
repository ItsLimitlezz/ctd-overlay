// State from many connections (01 §1.3, 02 §2.5, §2.8): each connection keeps its own value for a
// key, and each overlay sees the one its bindings allow, by one rule (the core's own value, fresh
// over held, direct over relay, the older connection); viewers.total and viewers.stale are worked
// out per overlay; <key>.stale marks a held value; rebinding sends what moved. And whatever happens,
// a client that took a snapshot and applied the stream after it sees what a fresh snapshot shows.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createBus } from '../src/bus/index.js';
import { createUlid } from '../src/ids.js';

function fixture() {
  let t = Date.UTC(2026, 9, 17, 23);
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
  };
  return { bus: createBus({ now: clock.now, idgen: createUlid(), timers: clock.timers }), clock };
}
const src = (connection, platform = 'twitch', connector = 'fake') => ({ connector, connection, platform });
const A = src('con_A'); // older
const B = src('con_B');
const KICK = src('con_K', 'kick');
const watch = (ch) => { const got = []; ch.subscribe((e) => got.push(e)); return got; };

describe('one value per overlay, from the connections it is bound to', () => {
  test('each connection keeps its own value; the older shows; a held one gives way to a fresh one; the core\'s wins', () => {
    const { bus } = fixture();
    bus.setState('viewers.twitch', 100, { src: A });
    assert.equal(bus.setState('viewers.twitch', 200, { src: B }), null, 'installation-wide, A still shows');
    assert.equal(bus.getState('viewers.twitch'), 100);
    assert.deepEqual(bus.stateOf('con_B'), [{ key: 'viewers.twitch', value: 200 }]);
    bus.setStale('viewers.twitch', 'con_A', true);
    assert.equal(bus.getState('viewers.twitch'), 200, 'fresh over held');
    assert.equal(bus.getState('viewers.twitch.stale'), undefined, 'what shows isn\'t held');
    bus.setStale('viewers.twitch', 'con_B', true);
    assert.equal(bus.getState('viewers.twitch'), 100);
    assert.equal(bus.getState('viewers.twitch.stale'), true);
    bus.setState('viewers.twitch', 101, { src: A });
    assert.equal(bus.getState('viewers.twitch.stale'), undefined, 'set again: fresh');
    bus.setState('viewers.twitch', 5);
    assert.equal(bus.getState('viewers.twitch'), 5, 'the core\'s own value wins');
    bus.setState('viewers.twitch', undefined);
    assert.equal(bus.getState('viewers.twitch'), 101);
  });

  test('a direct connection wins a tie with a relay (CTD Relay), whatever their age', () => {
    const { bus } = fixture();
    bus.setRank('con_A', 1); // the older one relays
    bus.setState('stream.twitch.live', false, { src: A });
    bus.setState('stream.twitch.live', true, { src: B });
    assert.equal(bus.getState('stream.twitch.live'), true);
    bus.setRank('con_A', 0);
    assert.equal(bus.getState('stream.twitch.live'), false);
  });

  test('an overlay bound to some connections sees theirs; to "all", every one, made later too', () => {
    const { bus } = fixture();
    const onlyB = bus.channel('ovl_b', { consumes: { state: ['viewers.*'] }, connections: ['con_B'] });
    const all = bus.channel('ovl_all', { consumes: { state: ['viewers.*'] } });
    assert.equal(all.connections, 'all');
    const gotB = watch(onlyB);
    bus.setState('viewers.twitch', 100, { src: A });
    assert.equal(gotB.length, 0, 'A is not bound to it');
    bus.setState('viewers.twitch', 200, { src: B });
    assert.deepEqual(gotB.map((e) => e.data), [{ key: 'viewers.twitch', value: 200 }, { key: 'viewers.total', value: 200 }]);
    assert.equal(onlyB.visibleState('viewers.twitch'), 200);
    assert.equal(all.visibleState('viewers.twitch'), 100);
    // A count from another platform adds to the total, once per platform.
    bus.setState('viewers.kick', 7, { src: KICK });
    assert.equal(all.visibleState('viewers.total'), 107, 'twitch once (A shows), plus kick');
    assert.equal(onlyB.visibleState('viewers.total'), 200);
    // The core's own total wins (the demo, a test).
    bus.setState('viewers.total', 1159);
    assert.equal(all.visibleState('viewers.total'), 1159);
  });

  test('viewers.stale and <key>.stale: true while what the overlay shows is held; gone with it', () => {
    const { bus, clock } = fixture();
    const ch = bus.channel('ovl_a', { consumes: { state: ['viewers.*', 'stream.*'] } });
    const got = watch(ch);
    bus.setState('viewers.twitch', 50, { src: A });
    bus.setState('stream.twitch.live', true, { src: A });
    bus.setStale('viewers.twitch', 'con_A', true);
    const snap = ch.snapshot().state;
    assert.deepEqual([snap['viewers.twitch'], snap['viewers.twitch.stale'], snap['viewers.stale'], snap['viewers.total']], [50, true, true, 50]);
    assert.equal(snap['stream.twitch.live.stale'], undefined);
    bus.clearOwner('con_A');
    assert.deepEqual(ch.snapshot().state, {});
    clock.advance(200);
    const keys = got.map((e) => `${e.data.key}=${e.data.value}`);
    assert.ok(keys.includes('viewers.twitch.stale=true') && keys.includes('viewers.stale=true'));
    assert.ok(keys.includes('viewers.twitch=undefined') && keys.includes('viewers.total=undefined'));
  });

  test('a change another overlay can\'t see sends nothing to it; one it can\'t tell apart sends nothing either', () => {
    const { bus } = fixture();
    const ch = bus.channel('ovl_a', { consumes: { state: ['viewers.*'] } });
    bus.setState('viewers.twitch', 100, { src: A });
    const got = watch(ch);
    bus.setState('viewers.twitch', 300, { src: B }); // B is younger: A still shows
    assert.deepEqual(got, []);
    bus.setStale('viewers.twitch', 'con_B', true);
    assert.deepEqual(got, [], 'B held: still A');
  });

  test('rebinding sends what moved: what the old connection showed goes, the new one\'s arrives', () => {
    const { bus, clock } = fixture();
    const ch = bus.channel('ovl_a', { consumes: { state: ['viewers.*'] }, connections: ['con_A'] });
    bus.setState('viewers.twitch', 100, { src: A });
    bus.setState('viewers.twitch', 200, { src: B });
    bus.setState('viewers.kick', 7, { src: KICK });
    clock.advance(500);
    const got = watch(ch);
    bus.channel('ovl_a', { consumes: { state: ['viewers.*'] }, connections: ['con_B'] });
    assert.deepEqual(got.map((e) => e.data), [{ key: 'viewers.twitch', value: 200, prev: 100 }, { key: 'viewers.total', value: 200, prev: 100 }]);
    clock.advance(500);
    bus.channel('ovl_a', { consumes: { state: ['viewers.*'] }, connections: 'all' });
    assert.equal(ch.visibleState('viewers.total'), 107);
    assert.equal(ch.visibleState('viewers.kick'), 7);
  });

  test('a simulated key holds back the overlay\'s own state too, until the simulation ends', () => {
    const { bus, clock } = fixture();
    const ch = bus.channel('ovl_a', { consumes: { state: ['show.*'] } });
    const got = watch(ch);
    ch.simulate('show.scene', 'brb', 60000);
    ch.setLocalState('show.scene', 'program');
    clock.advance(200);
    assert.deepEqual(got.map((e) => e.data.value), ['brb'], 'the take waits while simulated');
    ch.endSimulation();
    clock.advance(200);
    assert.equal(got.at(-1).data.value, 'program');
  });

  test('a deleted connection\'s chat leaves the buffer', () => {
    const { bus } = fixture();
    const msg = (id) => ({ id, user: { id: 'twitch:1', name: 'x', roles: [] }, text: 'hi', fragments: [{ type: 'text', text: 'hi' }] });
    bus.publish('chat.message', msg('a'), { src: A });
    bus.publish('chat.message', msg('b'), { src: B });
    assert.equal(bus.purgeChat('con_A'), 1);
    assert.deepEqual(bus.chatRecent().map((e) => e.data.id), ['b']);
    // History a connector catches up on goes to the buffer, not live.
    const ch = bus.channel('ovl_chat', { consumes: { chat: { recent: 10 } } });
    const got = watch(ch);
    bus.publish('chat.message', msg('old'), { src: A, backfill: true });
    assert.deepEqual(got, []);
    assert.deepEqual(ch.snapshot().chat.recent.map((m) => m.id), ['b', 'old']);
  });
});

// A seeded random walk of state changes from three connections and the core, holds, removals and
// rebinding: after every step, a client that took a snapshot and applied what the channel sent
// since has exactly what a fresh snapshot shows (coalescing included).
test('property: snapshot + stream = a fresh snapshot, whatever happens', () => {
  for (let run = 0; run < 25; run++) {
    const { bus, clock } = fixture();
    let s = run + 1;
    const rand = (n) => { s = (s * 1103515245 + 12345) % 2147483648; return s % n; };
    const owners = [A, B, KICK, { connector: 'core' }];
    const keys = ['viewers.twitch', 'viewers.kick', 'stream.twitch.live', 'viewers.total'];
    const bindings = ['all', ['con_A'], ['con_B', 'con_K'], []];
    const ch = bus.channel('ovl_p', { consumes: { state: ['viewers.*', 'stream.*'] }, connections: bindings[rand(4)] });
    const client = { ...ch.snapshot().state };
    ch.subscribe((env) => {
      if (env.type !== 'state.changed') return;
      if ('value' in env.data) client[env.data.key] = env.data.value;
      else delete client[env.data.key];
    });
    for (let i = 0; i < 120; i++) {
      const o = owners[rand(owners.length)];
      const k = keys[rand(keys.length)];
      const op = rand(10);
      try {
        if (op < 5) bus.setState(k, k === 'stream.twitch.live' ? Boolean(rand(2)) : rand(4) === 0 ? undefined : rand(50), { src: o });
        else if (op < 7 && o.connection) bus.setStale(k, o.connection, Boolean(rand(2)));
        else if (op === 7 && o.connection) bus.clearOwner(o.connection);
        else if (op === 8) bus.channel('ovl_p', { consumes: { state: ['viewers.*', 'stream.*'] }, connections: bindings[rand(4)] });
        else if (op === 9 && o.connection) bus.setRank(o.connection, rand(2));
      } catch { /* a connection may not set what it can't: none here */ }
      clock.advance(rand(3) * 60);
    }
    clock.advance(1000); // every coalesced value sent
    assert.deepEqual(client, ch.snapshot().state, `run ${run}`);
  }
});
