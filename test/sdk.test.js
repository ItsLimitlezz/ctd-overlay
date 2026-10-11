// The SDK is browser code. These tests run the real file in a VM context with just the browser
// APIs it uses, against a real server, so the transport is exercised end to end: snapshot,
// stream, reconnect with the cursor, 410 re-sync, and the fall back to polling.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fakeDom } from './fakedom.js';
import { defer, startWithOverlay } from './helpers.js';

const CODE = readFileSync(new URL('../src/sdk/sk.js', import.meta.url), 'utf8');
const MOCK = readFileSync(new URL('../src/sdk/mock.js', import.meta.url), 'utf8');

// Loads sk.js as the overlay page at `pageUrl` would, with the page's real <meta name="skp"> (plus
// test timings and `meta` overrides). Controls, changeable at any time:
//   hangStreams  stream requests never open (as when the browser holds them back)
//   fail(url)    true makes that request fail as if the server were unreachable
//   futureCursor the next snapshot carries a cursor from the future (a server restarted with its
//                clock stepped back still holds envelopes "older" than the client's cursor)
//   offset       ms added to the page's clock (Date), against the server's
//   hold(url)    ms to hold a request back before it is sent
//   delay(url)   ms to hold a response back before the page sees it
//   slowBody(url) true: the response's headers arrive at once, its body 400 ms later
//   requests     every URL path the page fetched
//   held, maxHeld   streams being held back now, and at most at once
// `mock` runs mock.js in the page after the SDK, as ?mock=1 would. `fail` and `futureCursor` can
// also be given up front, for the requests the page makes as it boots.
async function loadSdk(t, pageUrl, { timing = {}, meta: metaOverrides = {}, mock = false, offset = 0, fail = () => false, futureCursor = false, slowBody = () => false } = {}) {
  const html = await (await fetch(pageUrl)).text();
  const content = /<meta name="skp" content="([^"]*)">/.exec(html)[1]
    .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const meta = { ...JSON.parse(content), ...metaOverrides, timing: { reconnectMs: 50, ...timing } };
  const timers = new Set();
  const controllers = new Set();
  const control = {
    hangStreams: false, disposed: false, fail, futureCursor, offset, requests: [],
    hold: () => 0, delay: () => 0, slowBody, held: 0, maxHeld: 0,
  };
  // The page's clock: off from the server's by control.offset.
  const RealDate = Date;
  class PageDate extends RealDate {
    constructor(...args) { if (args.length) super(...args); else super(RealDate.now() + control.offset); }
    static now() { return RealDate.now() + control.offset; }
  }
  const track = (set, clear) => (fn, ms, ...args) => {
    if (control.disposed) return 0;
    const id = set(() => { timers.delete(id); fn(...args); }, ms);
    timers.add(id);
    return id;
  };
  const dom = fakeDom(JSON.stringify(meta));
  const sandbox = {
    window: dom.window,
    console,
    document: dom.document,
    location: new URL(pageUrl),
    Date: PageDate,
    URLSearchParams,
    AbortController,
    TextDecoder,
    TextEncoder,
    structuredClone,
    performance,
    setTimeout: track(setTimeout),
    clearTimeout: (id) => { timers.delete(id); clearTimeout(id); },
    setInterval: (fn, ms) => { if (control.disposed) return 0; const id = setInterval(fn, ms); timers.add(id); return id; },
    clearInterval: (id) => { timers.delete(id); clearInterval(id); },
    fetch: async (input, init = {}) => {
      if (control.disposed) return new Promise(() => {});
      const url = new URL(input, pageUrl);
      control.requests.push(url.pathname);
      if (control.fail(url)) throw new TypeError('Failed to fetch');
      const own = new AbortController();
      controllers.add(own);
      const signal = init.signal ? AbortSignal.any([init.signal, own.signal]) : own.signal;
      if (control.hangStreams && url.pathname.endsWith('/stream')) {
        control.maxHeld = Math.max(control.maxHeld, ++control.held);
        return new Promise((_, reject) => signal.addEventListener('abort', () => { control.held--; reject(new Error('aborted')); }));
      }
      const before = control.hold(url);
      if (before > 0) await new Promise((r) => setTimeout(r, before));
      const res = await fetch(url, { ...init, signal }).finally(() => controllers.delete(own));
      const wait = control.delay(url);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      if (control.futureCursor && url.pathname.endsWith('/snapshot') && res.ok) {
        control.futureCursor = false;
        const snap = await res.json();
        return new Response(JSON.stringify({ ...snap, cursor: '7ZZZZZZZZZZZZZZZZZZZZZZZZZ' }), { status: 200, headers: res.headers });
      }
      if (control.slowBody(url)) {
        const text = await res.text();
        const body = new ReadableStream({
          async start(c) {
            await new Promise((r) => setTimeout(r, 400));
            c.enqueue(new TextEncoder().encode(text));
            c.close();
          },
        });
        return new Response(body, { status: res.status, headers: res.headers });
      }
      return res;
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(CODE, sandbox, { filename: 'sk.js' });
  if (mock) vm.runInContext(MOCK, sandbox, { filename: 'mock.js' });
  defer(t, () => {
    control.disposed = true;
    for (const id of timers) { clearTimeout(id); clearInterval(id); }
    for (const c of controllers) c.abort();
  });
  return { SK: sandbox.window.SK, control, window: sandbox.window, document: sandbox.document };
}

// Envelopes from a chat connection (the overlay must be bound to it).
const twitch = { connector: 'twitch', connection: 'con_tw' };
const chatMsg = (id, user = 'twitch:1') => ({ id, user: { id: user, name: user, roles: [] }, text: `text ${id}`, fragments: [{ type: 'text', text: `text ${id}` }] });

// Resolves when check() is truthy, polling every 10 ms.
async function until(check, ms = 4000, what = 'condition') {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

test('ready fires after the snapshot; onState fires once with the current value', async (t) => {
  const { platform, base } = await startWithOverlay(t);
  platform.bus.setState('custom.diag.counter', 3);
  const { SK } = await loadSdk(t, base);
  const calls = [];
  SK.onState('custom.diag.counter', (v, prev) => calls.push([v, prev]));
  SK.onState('custom.missing', (v) => calls.push(['missing', v]));
  let ready = false;
  SK.ready(() => { ready = true; });
  await until(() => ready, 4000, 'ready');
  await until(() => calls.length === 2);
  assert.deepEqual(calls, [[3, undefined], ['missing', undefined]]);
  assert.equal(SK.state('custom.diag.counter'), 3);
  assert.deepEqual(SK.settings, { accent: '#16e0ff' });
  assert.equal(SK.state('overlay.settings'), undefined); // undeclared runtime data stays private (04 §4.8)
});

test('it streams: events and state changes arrive live', async (t) => {
  const { platform, base } = await startWithOverlay(t);
  const { SK } = await loadSdk(t, base);
  const events = [];
  const values = [];
  SK.on('custom.*', (env) => events.push(env.data.n));
  SK.onState('custom.diag.counter', (v, prev) => values.push([v, prev]));
  await until(() => SK.transport.mode === 'stream', 4000, 'stream mode');
  platform.bus.publish('custom.diag.tick', { n: 1 });
  platform.bus.setState('custom.diag.counter', 5);
  await until(() => events.length === 1 && values.length === 2);
  assert.deepEqual(events, [1]);
  assert.deepEqual(values, [[undefined, undefined], [5, undefined]]);
});

test('after a dropped connection it resumes from its cursor: nothing missed, nothing twice', async (t) => {
  const { platform, base } = await startWithOverlay(t);
  const { SK } = await loadSdk(t, base);
  const seen = [];
  SK.on('custom.*', (env) => seen.push(env.data.n));
  await until(() => SK.transport.mode === 'stream');
  platform.bus.publish('custom.diag.tick', { n: 1 });
  await until(() => seen.length === 1);
  platform.server.closeAllConnections(); // the Wi-Fi blip
  platform.bus.publish('custom.diag.tick', { n: 2 }); // while disconnected
  platform.bus.publish('custom.diag.tick', { n: 3 });
  await until(() => seen.length === 3, 4000, 'replayed events');
  platform.bus.publish('custom.diag.tick', { n: 4 });
  await until(() => seen.length === 4);
  assert.deepEqual(seen, [1, 2, 3, 4]);
  assert.ok(SK.transport.streamsOpened >= 2);
});

test('when its cursor has expired (410) it re-fetches the snapshot, reports what changed, and streams on', async (t) => {
  const { platform, base, overlay } = await startWithOverlay(t);
  platform.bus.setState('custom.diag.counter', 1);
  const { SK, control } = await loadSdk(t, base);
  const values = [];
  SK.onState('custom.diag.counter', (v) => values.push(v));
  await until(() => SK.transport.mode === 'stream');
  // Replace the overlay's channel: everything before now is no longer replayable.
  const consumes = platform.templates.get('dev.skp.diagnostic', '1.0.0').manifest.consumes;
  platform.bus.removeChannel(overlay.id); // ends the stream
  platform.bus.publish('custom.filler', {});
  platform.bus.channel(overlay.id, { consumes });
  platform.bus.setState('custom.diag.counter', 2);
  await until(() => values.includes(2), 4000, 're-sync');
  assert.deepEqual(values, [1, 2]);
  // Straight back to streaming from the new cursor, never through polling.
  await until(() => SK.transport.mode === 'stream' && SK.transport.streamsOpened >= 2, 4000, 'a new stream');
  assert.equal(control.requests.filter((p) => p.endsWith('/poll')).length, 0);
});

test('a cursor from the server\'s future (a restart with its clock stepped back) re-syncs instead of freezing', async (t) => {
  const { platform, base } = await startWithOverlay(t);
  platform.bus.setState('custom.diag.counter', 1);
  // The first snapshot: 410 on every stream and poll from it.
  const { SK, control } = await loadSdk(t, base, { futureCursor: true });
  const values = [];
  SK.onState('custom.diag.counter', (v) => values.push(v));
  await until(() => SK.transport.mode === 'stream' && SK.transport.streamsOpened >= 1, 4000, 'a stream after the 410');
  platform.bus.setState('custom.diag.counter', 2);
  await until(() => values.includes(2), 4000, 'a live change');
  assert.deepEqual(values, [1, 2]);
  assert.ok(control.requests.filter((p) => p.endsWith('/snapshot')).length <= 3, control.requests.join(' '));
});

test('streams that never open fall back to polling within the window, then return to streaming', async (t) => {
  const { platform, base } = await startWithOverlay(t);
  const { SK, control } = await loadSdk(t, base, { timing: { openTimeoutMs: 150, pollMs: 30, retryStreamMs: 300 } });
  control.hangStreams = true; // the browser is holding the stream back (01 §1.5)
  const seen = [];
  SK.on('custom.*', (env) => seen.push(env.data.n));
  await until(() => SK.transport.mode === 'poll', 4000, 'poll mode');
  platform.bus.publish('custom.diag.tick', { n: 1 });
  await until(() => seen.length === 1, 2000, 'an event by polling');
  control.hangStreams = false;
  await until(() => SK.transport.mode === 'stream', 4000, 'back to streaming');
  platform.bus.publish('custom.diag.tick', { n: 2 });
  await until(() => seen.length === 2);
  assert.deepEqual(seen, [1, 2]);
});

test('when the server says the browser has enough streams (429), it polls at once', async (t) => {
  const { platform, base } = await startWithOverlay(t);
  // Hold this "browser's" four streams (Node's fetch sends the same User-Agent as the SDK's).
  const { cursor } = await (await fetch(`${base}/snapshot`)).json();
  const holds = [];
  defer(t, () => holds.forEach((c) => c.abort()));
  for (let i = 0; i < 4; i++) {
    const c = new AbortController();
    holds.push(c);
    const res = await fetch(`${base}/stream?cursor=${cursor}`, { signal: c.signal });
    assert.equal(res.status, 200);
  }
  // A failure would only reach polling after reconnectMs (10 s), and the stream retry would come
  // after retryStreamMs (300 ms) without Retry-After (60 s).
  const { SK, control } = await loadSdk(t, base, { timing: { pollMs: 30, openTimeoutMs: 5000, reconnectMs: 10000, retryStreamMs: 300 } });
  const seen = [];
  SK.on('custom.*', (env) => seen.push(env.data.n));
  await until(() => SK.transport.mode === 'poll', 1000, 'poll mode without waiting for failures');
  assert.equal(SK.transport.streamsOpened, 0);
  platform.bus.publish('custom.diag.tick', { n: 1 });
  await until(() => seen.length === 1);
  await new Promise((r) => setTimeout(r, 1000));
  assert.equal(control.requests.filter((p) => p.endsWith('/stream')).length, 1, 'no stream retry before Retry-After');
});

test('a template callback that throws does not break the others', async (t) => {
  const { platform, base } = await startWithOverlay(t);
  const { SK } = await loadSdk(t, base);
  const seen = [];
  const original = console.error;
  console.error = () => {};
  defer(t, () => { console.error = original; });
  SK.on('custom.*', () => { throw new Error('template bug'); });
  SK.on('custom.*', (env) => seen.push(env.type));
  await until(() => SK.transport.mode === 'stream');
  platform.bus.publish('custom.diag.tick', { n: 1 });
  await until(() => seen.length === 1);
});

test('SK and its clock are frozen, and the clock tracks server time', async (t) => {
  const { base } = await startWithOverlay(t);
  const { SK } = await loadSdk(t, base);
  await until(() => SK.transport.mode === 'stream');
  assert.ok(Object.isFrozen(SK));
  assert.ok(Object.isFrozen(SK.clock));
  assert.ok(Math.abs(SK.clock.now() - Date.now()) < 1000);
});

test('a page whose clock is 90 s off still runs on server time, and follows a clock step at once (01 §1.6)', async (t) => {
  const { base } = await startWithOverlay(t, { heartbeatMs: 50 });
  const { SK, control } = await loadSdk(t, base, { offset: 90000 });
  await until(() => SK.transport.mode === 'stream');
  assert.ok(Math.abs(SK.transport.skew + 90000) < 150, `skew ${SK.transport.skew}`);
  assert.ok(Math.abs(SK.clock.now() - Date.now()) < 150, `off by ${SK.clock.now() - Date.now()} ms`);
  // The page's clock steps 5 s back (NTP, a manual fix): the next heartbeat corrects it.
  control.offset = 85000;
  await until(() => Math.abs(SK.clock.now() - Date.now()) < 150, 2000, 'the step corrected');
  // A server time scheduled a moment ahead fires on server time, not the page's.
  const target = Date.now() + 300;
  const fired = await new Promise((resolve) => SK.clock.at(target, () => resolve(Date.now())));
  assert.ok(fired >= target - 30 && fired < target + 300, `fired ${fired - target} ms from the server time`);
});

test('a polling page also follows a clock step at once, even when no later round trip is faster', async (t) => {
  const { base } = await startWithOverlay(t);
  const { SK, control } = await loadSdk(t, base, { timing: { openTimeoutMs: 100, pollMs: 30, retryStreamMs: 60000 } });
  control.hangStreams = true;
  await until(() => SK.transport.mode === 'poll', 4000, 'poll mode');
  // Every poll from now on is slower than the best sample, so only a sample that disagrees by
  // more than a second can replace the estimate.
  control.delay = (url) => (url.pathname.endsWith('/poll') ? 25 : 0);
  control.offset = -3000;
  await until(() => Math.abs(SK.clock.now() - Date.now()) < 150, 1000, 'the step corrected');
});

test('skew is measured when the response arrives, not after its body is read', async (t) => {
  const { base } = await startWithOverlay(t);
  // The snapshot's body takes 400 ms after its headers (a busy page at boot).
  const { SK } = await loadSdk(t, base, { slowBody: (url) => url.pathname.endsWith('/snapshot') });
  let ready = false;
  SK.ready(() => { ready = true; });
  await until(() => ready, 4000, 'ready');
  assert.ok(Math.abs(SK.clock.now() - Date.now()) < 150, `off by ${SK.clock.now() - Date.now()} ms`);
});

test('a page runs at most one stream at a time, however often it retries', async (t) => {
  const { base } = await startWithOverlay(t);
  // Streams are held back for a second; the retry from poll mode comes every 100 ms.
  const { SK, control } = await loadSdk(t, base, { timing: { openTimeoutMs: 1000, pollMs: 30, retryStreamMs: 100, failWindowMs: 60000 } });
  control.hangStreams = true;
  await until(() => SK.transport.mode === 'poll', 5000, 'poll mode');
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(control.maxHeld, 1);
});

test('a stream that goes silent (a half-open connection) is replaced, and nothing arrives twice', async (t) => {
  const { platform, base } = await startWithOverlay(t, { heartbeatMs: 60000 });
  const { SK } = await loadSdk(t, base, { timing: { silenceMs: 200, failWindowMs: 100 } });
  const seen = [];
  SK.on('custom.*', (env) => seen.push(env.data.n));
  await until(() => SK.transport.streamsOpened >= 2, 2000, 'a second stream after the silence');
  platform.bus.publish('custom.diag.tick', { n: 1 });
  await until(() => seen.length === 1);
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(seen, [1]);
});

test('heartbeats keep a quiet stream open', async (t) => {
  const { base } = await startWithOverlay(t, { heartbeatMs: 50 });
  const { SK } = await loadSdk(t, base, { timing: { silenceMs: 200 } });
  await until(() => SK.transport.mode === 'stream');
  await new Promise((r) => setTimeout(r, 800));
  assert.equal(SK.transport.streamsOpened, 1);
});

test('a server that is down when the page loads is retried until it answers (01 §1.7)', async (t) => {
  const { platform, base } = await startWithOverlay(t);
  platform.bus.setState('custom.diag.counter', 7);
  let refused = 0;
  const fail = (url) => url.pathname.endsWith('/snapshot') && ++refused <= 3;
  const { SK } = await loadSdk(t, base, { fail, timing: { snapshotRetryMs: 20, snapshotRetryMaxMs: 40 } });
  let ready = false;
  SK.ready(() => { ready = true; });
  await until(() => ready, 4000, 'ready');
  assert.equal(refused, 4);
  assert.equal(SK.state('custom.diag.counter'), 7);
});

test('while the server is unreachable the last good state stays, and the page resumes when it returns', async (t) => {
  const { platform, base } = await startWithOverlay(t);
  platform.bus.setState('custom.diag.counter', 1);
  const { SK, control } = await loadSdk(t, base, { timing: { pollMs: 30, failWindowMs: 60000 } });
  await until(() => SK.transport.mode === 'stream');
  control.fail = () => true;
  platform.server.closeAllConnections();
  await until(() => SK.transport.mode === 'offline', 4000, 'offline');
  assert.equal(SK.state('custom.diag.counter'), 1);
  control.fail = () => false;
  platform.bus.setState('custom.diag.counter', 2);
  await until(() => SK.state('custom.diag.counter') === 2, 4000, 'resumed');
});

test('viewer counts are hidden after 120 s without the server, and come back with it (H6)', async (t) => {
  const { platform, base, overlay } = await startWithOverlay(t);
  const consumes = { state: ['custom.*', 'viewers.*'], events: ['custom.*'], chat: null };
  platform.bus.channel(overlay.id, { consumes });
  platform.bus.setState('viewers.total', 1234);
  platform.bus.setState('custom.diag.counter', 1);
  const { SK, control } = await loadSdk(t, base, { meta: { consumes }, timing: { offlineHoldMs: 300, pollMs: 30, failWindowMs: 60000, tickMs: 50 } });
  const seen = [];
  SK.onState('viewers.total', (v) => seen.push(v));
  await until(() => SK.transport.mode === 'stream');
  control.fail = () => true;
  platform.server.closeAllConnections();
  await until(() => seen.length === 2, 2000, 'the count hidden');
  assert.deepEqual(seen, [1234, undefined]);
  assert.equal(SK.state('custom.diag.counter'), 1); // everything else is held (01 §1.7)
  control.fail = () => false; // the count never changed, so only a fresh snapshot can restore it
  await until(() => seen.length === 3, 4000, 'the count back');
  assert.deepEqual(seen, [1234, undefined, 1234]);
});

test('bringing viewer counts back never skips an envelope that arrives meanwhile', async (t) => {
  const { platform, base, overlay } = await startWithOverlay(t);
  const consumes = { state: ['custom.*', 'viewers.*'], events: ['custom.*'], chat: null };
  platform.bus.channel(overlay.id, { consumes });
  platform.bus.setState('viewers.total', 1234);
  const { SK, control } = await loadSdk(t, base, { meta: { consumes }, timing: { offlineHoldMs: 300, pollMs: 30, failWindowMs: 60000, tickMs: 50 } });
  const seen = [];
  SK.on('custom.*', (env) => seen.push(env.type));
  await until(() => SK.transport.mode === 'stream');
  control.fail = () => true;
  platform.server.closeAllConnections();
  await until(() => SK.state('viewers.total') === undefined, 2000, 'the count hidden');
  // The server is back. The snapshot that brings the count back is sent late, and polls answer
  // slowly: an event published in between is in the snapshot's cursor before any poll delivered
  // it. It must still arrive (a snapshot that moved the cursor would skip it).
  control.hold = (url) => (url.pathname.endsWith('/snapshot') ? 300 : 0);
  control.delay = (url) => (url.pathname.endsWith('/poll') ? 600 : 0);
  control.fail = () => false;
  await until(() => control.requests.filter((p) => p.endsWith('/snapshot')).length >= 2, 3000, 'the restore requested');
  platform.bus.publish('custom.during', {});
  await until(() => SK.state('viewers.total') === 1234, 2000, 'the count back');
  platform.bus.publish('custom.after', {});
  await until(() => seen.includes('custom.after'), 2000, 'a later event');
  assert.deepEqual(seen, ['custom.during', 'custom.after']);
});

test('a transition with a media path outside the package can\'t stop the page: the take falls back to a fade', async (t) => {
  const { platform, base } = await startWithOverlay(t);
  const errors = [];
  const original = console.error;
  console.error = (msg) => errors.push(msg);
  defer(t, () => { console.error = original; });
  const { SK } = await loadSdk(t, base, {
    meta: {
      scenes: [{ id: 'program', core: 'program' }, { id: 'brb', core: 'brb' }],
      transitions: [{ id: 'sting', media: '/assets/s.webm', cutAtMs: 100 }],
    },
  });
  let ready = false;
  SK.ready(() => { ready = true; });
  await until(() => ready, 4000, 'ready');
  const scenes = [];
  SK.onScene((scene, prev, transition) => scenes.push(`${scene}:${transition}`));
  await until(() => SK.transport.mode === 'stream');
  platform.bus.publish('show.scene.changed', { scene: 'brb', transition: 'sting' });
  await until(() => SK.scene === 'brb', 2000, 'the take');
  assert.ok(errors.some((e) => /transition "sting" can't play/.test(e)), errors.join('\n'));
});

test('a chat element the template recycles from an exited message enters again', async (t) => {
  const { platform, base, overlay } = await startWithOverlay(t);
  const consumes = { state: ['custom.*'], events: ['custom.*'], chat: { recent: 0, max: 2 } };
  platform.bus.channel(overlay.id, { consumes, connections: ['con_tw'] });
  const { SK, document } = await loadSdk(t, base, { meta: { consumes } });
  const pool = [];
  const shown = [];
  SK.chat.onAdd(() => {
    let el = pool.find((e) => !e.parentNode);
    if (!el) pool.push((el = document.createElement('div')));
    shown.push(el);
    return el;
  });
  await until(() => SK.transport.mode === 'stream');
  for (const id of ['a', 'b', 'c', 'd']) {
    platform.bus.publish('chat.message', chatMsg(id), { src: twitch });
    await new Promise((r) => setTimeout(r, 300)); // a frame each, and time for exits to finish
  }
  await until(() => shown.length === 4, 2000, 'four messages');
  assert.ok(pool.length < 4, 'the template reused an element');
  const last = shown[3];
  assert.equal(last.parentNode !== null, true);
  assert.notEqual(last.getAttribute('data-skp-state'), 'exit');
});

test('a re-sync never takes chat off screen unless the new buffer shows it was deleted', async (t) => {
  const { platform, base, overlay } = await startWithOverlay(t);
  const consumes = { state: ['custom.*'], events: ['custom.*'], chat: { recent: 0, max: 5 } };
  const bind = () => platform.bus.channel(overlay.id, { consumes, connections: ['con_tw'] });
  bind();
  const { SK } = await loadSdk(t, base, { meta: { consumes } });
  const added = [];
  const removed = [];
  SK.chat.onAdd((m) => { added.push(m.id); });
  SK.chat.onRemove((id) => removed.push(id));
  await until(() => SK.transport.mode === 'stream');
  for (const id of ['a', 'b', 'c']) platform.bus.publish('chat.message', chatMsg(id), { src: twitch });
  await until(() => added.length === 3, 2000, 'live messages');
  // A 410 re-sync with chat.recent 0: the snapshot has no messages, which proves nothing.
  platform.bus.removeChannel(overlay.id);
  platform.bus.publish('custom.filler', {});
  bind();
  platform.bus.setState('custom.diag.counter', 9);
  await until(() => SK.state('custom.diag.counter') === 9, 4000, 're-sync');
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(removed, []);
});

test('a re-sync takes off screen what was deleted during the gap, and adds what was missed, once', async (t) => {
  const { platform, base, overlay } = await startWithOverlay(t);
  const consumes = { state: ['custom.*'], events: ['custom.*'], chat: { recent: 10, max: 5 } };
  const bind = () => platform.bus.channel(overlay.id, { consumes, connections: ['con_tw'] });
  bind();
  const { SK } = await loadSdk(t, base, { meta: { consumes } });
  const added = [];
  const removed = [];
  SK.chat.onAdd((m) => { added.push(m.id); });
  SK.chat.onRemove((id) => removed.push(id));
  await until(() => SK.transport.mode === 'stream');
  for (const id of ['a', 'b', 'c']) platform.bus.publish('chat.message', chatMsg(id), { src: twitch });
  await until(() => added.length === 3, 2000, 'live messages');
  platform.bus.removeChannel(overlay.id);
  platform.bus.publish('chat.message.deleted', { messageId: 'b' }, { src: twitch }); // during the gap
  platform.bus.publish('chat.message', chatMsg('d'), { src: twitch });
  bind();
  platform.bus.setState('custom.diag.counter', 9);
  await until(() => SK.state('custom.diag.counter') === 9 && added.length === 4, 4000, 're-sync');
  assert.deepEqual(removed, ['b']);
  assert.deepEqual(added, ['a', 'b', 'c', 'd']);
});

test('the renderer gets only the alert kinds the template declared (04 §4.2)', async (t) => {
  const { platform, base, overlay } = await startWithOverlay(t);
  platform.bus.channel(overlay.id, { consumes: { state: ['custom.*'], events: ['custom.*', 'alert.*'], chat: null } });
  const { SK } = await loadSdk(t, base, { meta: { consumes: { state: ['custom.*'], events: ['custom.*', 'alert.follow'], chat: null } } });
  const rendered = [];
  SK.alerts.render((a) => { rendered.push(a.kind); });
  await until(() => SK.transport.mode === 'stream');
  platform.bus.publish('alert.raid', { kind: 'raid', user: { name: 'x' } });
  platform.bus.publish('alert.follow', { kind: 'follow', user: { name: 'y' } });
  platform.bus.publish('custom.done', {});
  await until(() => rendered.length === 1, 2000, 'the follow');
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(rendered, ['follow']);
});

test('reading undeclared data is logged once, so a missing declaration is found', async (t) => {
  const { base } = await startWithOverlay(t);
  const warnings = [];
  const original = console.warn;
  console.warn = (msg) => warnings.push(msg);
  defer(t, () => { console.warn = original; });
  const { SK } = await loadSdk(t, base);
  SK.onState('viewers.total', () => {});
  SK.state('viewers.total');
  SK.on('show.trigger', () => {});
  SK.onState('custom.diag.counter', () => {});
  assert.deepEqual(warnings.filter((w) => /not declared/.test(w)).length, 2, warnings.join('\n'));
});

describe('mock mode (?mock=1, 08 §8.5)', () => {
  test('the overlay\'s saved settings still apply, and nothing is fetched from the server', async (t) => {
    const { base } = await startWithOverlay(t, { settings: { accent: 'cyan' } });
    const { SK, control } = await loadSdk(t, `${base}?mock=1`, { mock: true });
    let ready = false;
    SK.ready(() => { ready = true; });
    await until(() => ready, 2000, 'ready');
    assert.equal(SK.settings.accent, 'cyan');
    assert.equal(SK.transport.mode, 'mock');
    assert.deepEqual(control.requests.filter((p) => /\/(snapshot|stream|poll)$/.test(p)), []);
  });

  test('the chat backlog follows consumes.chat.recent, as the server would send it', async (t) => {
    const { base } = await startWithOverlay(t);
    const recentOf = async (chat) => {
      const { SK } = await loadSdk(t, `${base}?mock=1`, { mock: true, meta: { consumes: { state: [], events: [], chat } } });
      let ready = false;
      SK.ready(() => { ready = true; });
      await until(() => ready, 2000, 'ready');
      return SK.chat.recent().length;
    };
    assert.equal(await recentOf({ recent: 0, max: 5 }), 0);
    assert.equal(await recentOf({ recent: 3, max: 5 }), 3);
    assert.equal(await recentOf({ max: 5 }), 5); // default 50; the sample has 5
  });

  test('sample alerts match the alert schema, use the duration setting, and only declared kinds render', async (t) => {
    const { base } = await startWithOverlay(t, { settings: { hold: 2000 } });
    const { SK, window } = await loadSdk(t, `${base}?mock=1&mockSpeed=100`, {
      mock: true,
      meta: { consumes: { state: [], events: ['alert.follow', 'alert.raid'], chat: null }, alerts: { durationMs: 6000, durationSetting: 'hold' } },
    });
    const seen = [];
    SK.on('alert.*', (env) => seen.push(env));
    const rendered = [];
    SK.alerts.render((a) => { rendered.push(a.kind); });
    await until(() => seen.length >= 2, 4000, 'two sample alerts');
    for (const env of seen) {
      assert.ok(!('message' in env.data) || (env.data.message && typeof env.data.message === 'object'), JSON.stringify(env.data));
      assert.equal(env.data.display.durationMs, 2000);
    }
    assert.deepEqual([...new Set(seen.map((e) => e.type))].sort(), ['alert.follow', 'alert.raid']);
    assert.ok(rendered.every((kind) => kind === 'follow' || kind === 'raid'), rendered.join());
    assert.ok(window.__skpMock);
  });
});
