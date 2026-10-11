/* SKP runtime SDK v1 (04 §4.4). Served at /sdk/v1/sk.js and injected into every overlay page
   before the template's own scripts. It must run in the browser OBS 30 ships (Chromium 103) and
   load no dependencies.

   This file is the connection layer (01 §1.5, 01 §1.7):
   1. Fetch the snapshot and render.
   2. Stream everything after its cursor (Server-Sent Events, read with fetch: EventSource only
      delivers named events to listeners registered per name, and every message is named after
      its type; fetch also exposes the 410 status).
   3. A stream that errors, ends, or hasn't opened within 5 s has failed. Two failures within
      30 s switch to polling every 700 ms (1500 ms in lite mode), and the stream is retried every
      60 s. 429 means this browser already holds as many streams as the server allows: poll
      right away. 410 means the cursor is too old: fetch the snapshot again.
   While the server is unreachable the last good state stays on screen.

   The template-facing API (scenes, actions, element lifecycle, chat and music helpers, mock
   data) is built on top of this in step 5. */
(() => {
  'use strict';

  const metaEl = document.querySelector('meta[name="skp"]');
  const meta = JSON.parse(metaEl ? metaEl.getAttribute('content') : '{}');
  const timing = Object.assign({
    openTimeoutMs: 5000,
    failWindowMs: 30000,
    reconnectMs: 1000,
    pollMs: 700,
    pollLiteMs: 1500,
    retryStreamMs: 60000,
    silenceMs: 45000, // three missed heartbeats: the connection is dead even if the socket says otherwise
    snapshotRetryMs: 1000,
    snapshotRetryMaxMs: 10000,
  }, meta.timing || {});

  const params = new URLSearchParams(location.search);
  const lite = params.get('lite') === '1';
  const keyParam = params.get('key') ? '&key=' + encodeURIComponent(params.get('key')) : '';
  const base = '/o/' + encodeURIComponent(meta.slug);

  const state = new Map();
  let chatRecent = [];
  let cursor = null;
  let isReady = false;
  const readyFns = [];
  const stateSubs = [];
  const eventSubs = [];
  const transport = { mode: 'connecting', received: 0, failures: [], opened: 0 };

  // ---- server clock (01 §1.6) -------------------------------------------------------------
  // skew = server time - local time, from the request with the shortest round trip seen in the
  // last minute: the shorter the round trip, the tighter the estimate.
  let skew = 0;
  let best = null;
  function sampleClock(serverTs, t0, t1) {
    if (typeof serverTs !== 'number') return;
    const rtt = t1 - t0;
    if (!best || rtt <= best.rtt || t1 - best.at > 60000) {
      best = { rtt, at: t1 };
      skew = serverTs - (t0 + t1) / 2;
    }
  }
  const now = () => Date.now() + skew;

  // ---- patterns: exact names, or a prefix ending in ".*" -----------------------------------
  function matcher(pattern) {
    if (pattern.slice(-2) === '.*') {
      const prefix = pattern.slice(0, -1);
      return (name) => name.indexOf(prefix) === 0;
    }
    return (name) => name === pattern;
  }

  const clone = (v) => (v === undefined ? undefined : structuredClone(v));

  function safely(fn, args) {
    try { fn.apply(null, args); } catch (err) { console.error('[skp] a template callback threw', err); }
  }

  function notifyState(key, value, prev) {
    for (const sub of stateSubs) {
      if (!sub.test(key)) continue;
      if (sub.wildcard) safely(sub.fn, [key, clone(value), clone(prev)]);
      else safely(sub.fn, [clone(value), clone(prev)]);
    }
  }

  function notifyEvent(env) {
    for (const sub of eventSubs) if (sub.test(env.type)) safely(sub.fn, [clone(env)]);
  }

  // ---- applying data ----------------------------------------------------------------------
  function apply(env) {
    if (!env || typeof env.id !== 'string') return;
    if (cursor && env.id <= cursor) return; // already seen (a replay overlaps what we had)
    cursor = env.id;
    transport.received++;
    if (env.type === 'state.changed') {
      const key = env.data.key;
      const prev = state.get(key);
      if ('value' in env.data) state.set(key, env.data.value);
      else state.delete(key);
      if (isReady) notifyState(key, env.data.value, prev);
    }
    if (isReady) notifyEvent(env);
  }

  // A fresh snapshot replaces state; once the template is running, every difference is reported
  // as a change, so a re-sync after 410 updates the screen like any other change.
  function applySnapshot(snap) {
    const before = new Map(state);
    state.clear();
    for (const key of Object.keys(snap.state || {})) state.set(key, snap.state[key]);
    chatRecent = (snap.chat && snap.chat.recent) || [];
    cursor = snap.cursor;
    if (!isReady) return;
    const keys = new Set([...before.keys(), ...state.keys()]);
    for (const key of keys) {
      if (JSON.stringify(before.get(key)) !== JSON.stringify(state.get(key))) notifyState(key, state.get(key), before.get(key));
    }
  }

  // ---- transport ----------------------------------------------------------------------------
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function loadSnapshot() {
    let delay = timing.snapshotRetryMs;
    for (;;) {
      try {
        const t0 = Date.now();
        const res = await fetch(base + '/snapshot?v=1' + keyParam, { cache: 'no-store' });
        const t1 = Date.now();
        if (res.ok) {
          const snap = await res.json();
          sampleClock(snap.ts, t0, t1);
          applySnapshot(snap);
          return;
        }
      } catch (err) { /* unreachable: keep what's on screen and retry */ }
      if (transport.mode === 'connecting' || transport.mode === 'offline') transport.mode = 'offline';
      await sleep(delay);
      delay = Math.min(delay * 2, timing.snapshotRetryMaxMs);
    }
  }

  // One stream connection, start to finish. Resolves 'gone' (410), 'busy' (429: this browser
  // already holds as many streams as the server allows, so poll), 'failed' (never opened), or
  // 'ended' (opened, then closed or went silent).
  async function runStream(onOpen) {
    const ctrl = new AbortController();
    const openTimer = setTimeout(() => ctrl.abort(), timing.openTimeoutMs);
    let res;
    try {
      res = await fetch(base + '/stream?cursor=' + encodeURIComponent(cursor) + keyParam, { cache: 'no-store', signal: ctrl.signal });
    } catch (err) {
      clearTimeout(openTimer);
      return 'failed';
    }
    clearTimeout(openTimer);
    if (res.status === 410) return 'gone';
    if (res.status === 429) return 'busy';
    if (!res.ok || !res.body) return 'failed';

    transport.opened++;
    onOpen();
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let silence = setTimeout(() => ctrl.abort(), timing.silenceMs);
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        clearTimeout(silence);
        silence = setTimeout(() => ctrl.abort(), timing.silenceMs);
        buf += decoder.decode(chunk.value, { stream: true }).replace(/\r\n?/g, '\n');
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          handleBlock(buf.slice(0, i));
          buf = buf.slice(i + 2);
        }
      }
    } catch (err) { /* aborted or dropped */ } finally {
      clearTimeout(silence);
    }
    return 'ended';
  }

  function handleBlock(block) {
    let data = '';
    for (const line of block.split('\n')) {
      if (!line || line[0] === ':') continue; // comments: ": open", ": hb"
      const c = line.indexOf(':');
      const field = c < 0 ? line : line.slice(0, c);
      let value = c < 0 ? '' : line.slice(c + 1);
      if (value[0] === ' ') value = value.slice(1);
      if (field === 'data') data += (data ? '\n' : '') + value;
    }
    if (!data) return;
    let env;
    try { env = JSON.parse(data); } catch (err) { return; }
    apply(env);
  }

  let pollTimer = null;
  let probeTimer = null;

  async function streamLoop() {
    const result = await runStream(() => {
      transport.mode = 'stream';
      stopPolling();
    });
    if (result === 'gone') {
      await loadSnapshot();
      return streamLoop();
    }
    if (result === 'busy') {
      if (transport.mode !== 'poll') startPolling(); // and the stream is retried every 60 s
      return;
    }
    if (transport.mode === 'poll') return; // a retry from poll mode that didn't open: keep polling
    const t = Date.now();
    transport.failures = transport.failures.filter((f) => t - f < timing.failWindowMs);
    transport.failures.push(t);
    if (transport.failures.length >= 2) {
      transport.failures = [];
      startPolling();
    } else {
      setTimeout(streamLoop, timing.reconnectMs);
    }
  }

  function startPolling() {
    transport.mode = 'poll';
    const tick = async () => {
      await pollOnce();
      if (transport.mode === 'poll') pollTimer = setTimeout(tick, lite ? timing.pollLiteMs : timing.pollMs);
    };
    tick();
    const probe = () => {
      if (transport.mode !== 'poll') return;
      streamLoop();
      probeTimer = setTimeout(probe, timing.retryStreamMs);
    };
    probeTimer = setTimeout(probe, timing.retryStreamMs);
  }

  function stopPolling() {
    clearTimeout(pollTimer);
    clearTimeout(probeTimer);
  }

  async function pollOnce() {
    try {
      const t0 = Date.now();
      const res = await fetch(base + '/poll?cursor=' + encodeURIComponent(cursor) + keyParam, { cache: 'no-store' });
      const t1 = Date.now();
      if (res.status === 410) return loadSnapshot();
      if (!res.ok) return;
      const body = await res.json();
      sampleClock(body.ts, t0, t1);
      for (const env of body.envelopes) apply(env);
    } catch (err) { /* unreachable: keep the last good state on screen (01 §1.7) */ }
  }

  // ---- the API ------------------------------------------------------------------------------
  const SK = {
    meta: Object.freeze(meta),

    ready(fn) {
      if (isReady) setTimeout(fn, 0);
      else readyFns.push(fn);
    },

    state(key) { return clone(state.get(key)); },

    // onState('viewers.total', (value, prev) => …) or onState('show.*', (key, value, prev) => …).
    // Fires once with the current value when the template is ready (04 §4.4).
    onState(pattern, fn) {
      const sub = { test: matcher(pattern), wildcard: pattern.slice(-2) === '.*', fn };
      stateSubs.push(sub);
      const fire = () => {
        for (const [key, value] of state) {
          if (!sub.test(key)) continue;
          if (sub.wildcard) safely(fn, [key, clone(value), undefined]);
          else safely(fn, [clone(value), undefined]);
        }
        if (!sub.wildcard && !state.has(pattern)) safely(fn, [undefined, undefined]);
      };
      SK.ready(fire);
    },

    // on('alert.*', envelope => …): only types the template declared reach it (04 §4.4).
    on(pattern, fn) { eventSubs.push({ test: matcher(pattern), fn }); },

    chatRecent() { return clone(chatRecent); },

    clock: Object.freeze({
      now,
      // Runs fn at a server time. Re-checks every 250 ms, so it stays right across clock
      // corrections and throttled sources (05 §5.3). Returns a cancel function.
      at(ts, fn) {
        const id = setInterval(() => {
          if (now() >= ts) {
            clearInterval(id);
            safely(fn, []);
          }
        }, 250);
        return () => clearInterval(id);
      },
    }),

    // Read-only connection details, for diagnostics.
    transport: Object.freeze({
      get mode() { return transport.mode; },
      get cursor() { return cursor; },
      get received() { return transport.received; },
      get streamsOpened() { return transport.opened; },
      get skew() { return skew; },
    }),
  };
  window.SK = Object.freeze(SK);

  (async () => {
    await loadSnapshot();
    isReady = true;
    for (const fn of readyFns.splice(0)) safely(fn, []);
    streamLoop();
  })();
})();
