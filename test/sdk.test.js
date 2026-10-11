// The SDK is browser code. These tests run the real file in a VM context with just the browser
// APIs it uses, against a real server, so the transport is exercised end to end: snapshot,
// stream, reconnect with the cursor, 410 re-sync, and the fall back to polling.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fakeDom } from './fakedom.js';
import { defer, startWithOverlay } from './helpers.js';

const CODE = readFileSync(new URL('../src/sdk/sk.js', import.meta.url), 'utf8');

// Loads sk.js as the overlay page at `pageUrl` would, with the page's real <meta name="skp"> (plus
// test timings). `hangStreams` makes stream requests never open (as when the browser holds them
// back), until set back to false.
async function loadSdk(t, pageUrl, { timing = {} } = {}) {
  const html = await (await fetch(pageUrl)).text();
  const content = /<meta name="skp" content="([^"]*)">/.exec(html)[1]
    .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const meta = { ...JSON.parse(content), timing: { reconnectMs: 50, ...timing } };
  const timers = new Set();
  const controllers = new Set();
  const control = { hangStreams: false, disposed: false };
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
    URLSearchParams,
    AbortController,
    TextDecoder,
    structuredClone,
    performance,
    setTimeout: track(setTimeout),
    clearTimeout: (id) => { timers.delete(id); clearTimeout(id); },
    setInterval: (fn, ms) => { if (control.disposed) return 0; const id = setInterval(fn, ms); timers.add(id); return id; },
    clearInterval: (id) => { timers.delete(id); clearInterval(id); },
    fetch: (input, init = {}) => {
      if (control.disposed) return new Promise(() => {});
      const url = new URL(input, pageUrl);
      const own = new AbortController();
      controllers.add(own);
      const signal = init.signal ? AbortSignal.any([init.signal, own.signal]) : own.signal;
      if (control.hangStreams && url.pathname.endsWith('/stream')) {
        return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
      }
      return fetch(url, { ...init, signal }).finally(() => controllers.delete(own));
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(CODE, sandbox, { filename: 'sk.js' });
  defer(t, () => {
    control.disposed = true;
    for (const id of timers) { clearTimeout(id); clearInterval(id); }
    for (const c of controllers) c.abort();
  });
  return { SK: sandbox.window.SK, control };
}

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

test('when its cursor has expired (410) it re-fetches the snapshot and reports what changed', async (t) => {
  const { platform, base, overlay } = await startWithOverlay(t);
  platform.bus.setState('custom.diag.counter', 1);
  const { SK } = await loadSdk(t, base);
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
  const { SK } = await loadSdk(t, base, { timing: { pollMs: 30, openTimeoutMs: 5000 } });
  const seen = [];
  SK.on('custom.*', (env) => seen.push(env.data.n));
  await until(() => SK.transport.mode === 'poll', 2000, 'poll mode without waiting for failures');
  assert.equal(SK.transport.streamsOpened, 0);
  platform.bus.publish('custom.diag.tick', { n: 1 });
  await until(() => seen.length === 1);
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
