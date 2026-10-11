/* SKP runtime SDK v1 (04 §4.4). Served at /sdk/v1/sk.js and injected into every overlay page, in
   <head>, before the template's own scripts. Templates get all live data through the frozen global
   SK and never connect to anything themselves (H1).

   Constraints: no dependencies, no build step (this file is served as written), it must run in the
   browser OBS 30 ships (Chromium 103), and it must stay under 25 KB gzipped (tests check both).
   Correctness never depends on requestAnimationFrame or animationend (H9): OBS stops painting
   sources it isn't showing, and hidden elements never fire animationend. Timers and deadlines it is.

   Sections: page settings · helpers · server clock and ticker · what the template may see · state
   and events · stage · element lifecycle · scenes · actions · alerts · chat · music · settings ·
   assets · log and errors · debug HUD · connection · mock · the API · start. */
(() => {
  'use strict';

  // ---- page settings ------------------------------------------------------------------------
  // The server passes the overlay's settings in <meta name="skp"> (the CSP forbids inline script).
  // The copy is deep-frozen: templates can read SK.meta but can't change what the runtime uses.
  const metaEl = document.querySelector('meta[name="skp"]');
  const meta = deepFreeze(JSON.parse(metaEl ? metaEl.getAttribute('content') : '{}'));
  const canvas = Object.freeze({
    id: (meta.canvas && meta.canvas.id) || 'h',
    width: (meta.canvas && meta.canvas.width) || 1920,
    height: (meta.canvas && meta.canvas.height) || 1080,
  });
  const manifestScenes = meta.scenes || [];
  const consumes = meta.consumes || {};
  const chatSpec = consumes.chat || null;
  const chatMax = (chatSpec && chatSpec.max) || 30;
  const alertSpec = Object.assign({ durationMs: 6000 }, meta.alerts || {});
  const timing = Object.assign({
    openTimeoutMs: 5000,
    requestTimeoutMs: 10000,
    failWindowMs: 30000,
    reconnectMs: 1000,
    pollMs: 700,
    pollLiteMs: 1500,
    retryStreamMs: 60000,
    silenceMs: 45000, // three missed heartbeats: the connection is dead even if the socket says otherwise
    snapshotRetryMs: 1000,
    snapshotRetryMaxMs: 10000,
    alertRenderWaitMs: 250,
    chatFrameMs: 250,
    chatPerFrame: 4,
    tickMs: 250,
  }, meta.timing || {});

  const params = new URLSearchParams(location.search);
  const keyParam = params.get('key') ? '&key=' + encodeURIComponent(params.get('key')) : '';
  const base = '/o/' + encodeURIComponent(meta.slug);
  const sdkScript = document.currentScript;
  const version = (sdkScript && /[?&]v=([\w-]+)/.exec(sdkScript.src || '') || [])[1] || 'dev';

  // Preview overrides (04 §4.9): the admin UI and development only, never in OBS links.
  const override = {
    scene: params.get('scene'),
    dark: params.get('bg') === 'dark',
    mock: params.get('mock') === '1',
    debug: params.get('debug') === '1',
    settings: decodeSettings(params.get('settings')),
  };
  override.native = override.debug && params.get('fit') === '0'; // pixel-exact inspection

  let framed = true;
  try { framed = window.self !== window.top; } catch (err) { /* cross-origin parent: framed */ }
  // OBS defines window.obsstudio in every page it loads, docks included, so only a top-level page
  // counts as an OBS source; a preview inside the admin UI (even in an OBS dock) is a preview.
  const previewParams = override.mock || override.scene !== null || override.settings !== null;
  const obs = !framed && !previewParams && typeof window.obsstudio === 'object' && window.obsstudio !== null;
  const preview = !obs && (framed || previewParams);
  const env = Object.freeze({
    preview,
    lite: params.get('lite') === '1',
    // Honoured in the admin UI only; on air, OBS sources always animate (05 §5.9).
    reducedMotion: preview && !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches),
    obs,
  });

  // Set before first paint, so per-canvas and lite CSS apply from the first frame.
  const html = document.documentElement;
  html.setAttribute('data-skp-canvas', canvas.id);
  if (env.lite) html.setAttribute('data-skp-lite', '');
  if (env.reducedMotion) html.setAttribute('data-skp-reduced-motion', '');
  if (override.dark) html.setAttribute('data-skp-bg', 'dark');

  // ?settings=<base64>: UTF-8 JSON, either base64 alphabet. URLSearchParams turns '+' into a space,
  // so spaces map back.
  function decodeSettings(value) {
    if (!value) return null;
    try {
      const b64 = value.replace(/ /g, '+').replace(/-/g, '+').replace(/_/g, '/');
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const parsed = JSON.parse(new TextDecoder().decode(bytes));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch (err) {
      return null;
    }
  }

  // ---- helpers ------------------------------------------------------------------------------
  function deepFreeze(o) {
    if (o && typeof o === 'object' && !Object.isFrozen(o)) {
      Object.freeze(o);
      for (const k of Object.keys(o)) deepFreeze(o[k]);
    }
    return o;
  }
  const clone = (v) => (v === undefined ? undefined : structuredClone(v));
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const isNode = (v) => !!v && typeof v === 'object' && typeof v.nodeType === 'number';

  // Template callbacks are isolated: one that throws, or returns a rejected promise, is reported
  // and the rest still run.
  function safely(fn, args) {
    try {
      const r = fn.apply(null, args);
      if (r && typeof r.then === 'function') r.then(null, (err) => reportError('a template callback rejected', err));
      return r;
    } catch (err) {
      reportError('a template callback threw', err);
      return undefined;
    }
  }

  // Patterns: an exact name, or a prefix ending in ".*" (`alert.*`, `show.*`).
  function matcher(pattern) {
    if (String(pattern).slice(-2) === '.*') {
      const prefix = pattern.slice(0, -1);
      return (name) => name.indexOf(prefix) === 0;
    }
    return (name) => name === pattern;
  }
  function anyOf(patterns) {
    const tests = (patterns || []).map(matcher);
    return (name) => tests.some((t) => t(name));
  }

  // Subscriber lists: add() returns the function that removes it again.
  function list() {
    const items = [];
    return {
      items,
      add(item) {
        items.push(item);
        return () => { const i = items.indexOf(item); if (i >= 0) items.splice(i, 1); };
      },
    };
  }

  // ---- server clock and ticker (01 §1.6, 05 §5.3) -------------------------------------------
  // skew = server time − local time, from the request with the shortest round trip seen in the last
  // minute. Round trips are measured with performance.now(), which a wall-clock step can't bend.
  // While streaming, every heartbeat carries server time: a local clock step of more than a second
  // is corrected at once.
  let skew = 0;
  let bestSample = null;
  function sampleClock(serverTs, p0, p1) {
    if (typeof serverTs !== 'number') return;
    const rtt = p1 - p0;
    if (!(rtt >= 0)) return;
    const local = Date.now() - (p1 - p0) / 2;
    if (!bestSample || rtt <= bestSample.rtt || p1 - bestSample.at > 60000) {
      bestSample = { rtt, at: p1 };
      skew = serverTs - local;
    }
  }
  function oneWaySample(serverTs) {
    if (!(serverTs > 0)) return;
    const estimate = serverTs - Date.now() + (bestSample ? bestSample.rtt / 2 : 0);
    if (Math.abs(estimate - skew) > 1000) {
      skew = estimate;
      bestSample = null; // the next measured round trip replaces it
    }
  }
  const now = () => Date.now() + skew;

  // One shared ticker re-checks everything that runs on server time, keeps the stage fitted, and
  // refreshes the HUD. Each SK.clock.at also arms its own timer for precision; the ticker is the
  // safety net for throttled sources and clock corrections.
  const scheduled = []; // { ts, fn, done }
  let ticks = 0;
  const tickFns = [];
  function tick() {
    ticks++;
    const t = now();
    for (const job of scheduled.slice()) if (!job.done && t >= job.ts) runJob(job);
    for (const fn of tickFns) fn();
  }
  function runJob(job) {
    if (job.done) return;
    job.done = true;
    clearTimeout(job.timer);
    const i = scheduled.indexOf(job);
    if (i >= 0) scheduled.splice(i, 1);
    safely(job.fn, []);
  }
  setInterval(tick, env.lite ? timing.tickMs * 2 : timing.tickMs);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
  window.addEventListener('obsSourceVisibleChanged', tick);
  window.addEventListener('obsSourceActiveChanged', tick);

  // Runs fn once when server time reaches ts. Returns a cancel function.
  function at(ts, fn) {
    if (typeof ts !== 'number' || !isFinite(ts)) throw new TypeError('SK.clock.at needs a server time in epoch ms');
    const job = { ts, fn, done: false, timer: 0 };
    scheduled.push(job);
    job.timer = setTimeout(() => { if (now() >= ts) runJob(job); }, Math.max(0, ts - now()));
    return () => {
      job.done = true;
      clearTimeout(job.timer);
      const i = scheduled.indexOf(job);
      if (i >= 0) scheduled.splice(i, 1);
    };
  }

  // ---- what the template may see (04 §4.2, §4.8) --------------------------------------------
  // The server already filters by consumes; the runtime filters again, so runtime-only data
  // (scene changes, triggers, settings) reaches the template only through SK.scene, SK.action and
  // SK.settings unless it declared it, and mock data obeys the same rules.
  const declaredState = anyOf(consumes.state);
  const declaredEvent = anyOf(consumes.events);
  const declaresAlerts = (consumes.events || []).some((p) => p.indexOf('alert.') === 0);
  function visibleEvent(type) {
    if (type === 'state.changed') return false; // state reaches templates through onState
    if (type.indexOf('chat.') === 0) return !!chatSpec;
    if (type === 'alerts.cut') return declaresAlerts;
    return declaredEvent(type);
  }

  // ---- state and events ---------------------------------------------------------------------
  const state = new Map();
  let chatRecent = [];
  let cursor = null;
  let snapshotLoaded = false;
  let domReady = false;
  let isReady = false;
  const early = []; // envelopes that arrived after the snapshot but before ready
  const bootQueue = []; // ready callbacks and onState first calls, in registration order
  const stateSubs = list();
  const eventSubs = list();
  const transport = { mode: 'connecting', ok: true, received: 0, failures: [], opened: 0, lastData: 0, retryAfter: 0 };

  function notifyState(key, value, prev) {
    if (key === 'overlay.settings') notifySettings();
    if (key === 'show.scene' && override.scene === null && value !== undefined) requestScene(value, 'fade');
    if (!declaredState(key)) return;
    for (const sub of stateSubs.items.slice()) {
      if (!sub.primed || !sub.test(key)) continue;
      if (sub.wildcard) safely(sub.fn, [key, clone(value), clone(prev)]);
      else safely(sub.fn, [clone(value), clone(prev)]);
    }
  }

  function dispatch(env) {
    const type = env.type;
    const d = env.data || {};
    if (type === 'show.scene.changed') {
      if (override.scene === null && d.scene) requestScene(d.scene, d.transition || 'fade');
    } else if (type === 'show.trigger') {
      runTrigger(d);
    } else if (type.indexOf('alert.') === 0) {
      queueAlert(env);
    } else if (type === 'alerts.cut') {
      cutAlert(d.alertId);
    } else if (type.indexOf('chat.') === 0) {
      chatEvent(env);
    }
    if (!visibleEvent(type)) return;
    for (const sub of eventSubs.items.slice()) if (sub.test(type)) safely(sub.fn, [clone(env)]);
  }

  function apply(env) {
    if (!env || typeof env.id !== 'string' || typeof env.type !== 'string') return;
    if (cursor && env.id <= cursor) return; // already seen: a replay overlaps what we had
    cursor = env.id;
    transport.received++;
    transport.lastData = Date.now();
    if (env.type === 'state.changed') {
      const data = env.data || {};
      const key = data.key;
      if (typeof key !== 'string') return;
      const prev = state.get(key);
      const value = data.value === null ? undefined : data.value; // absent, never null (02 §2.8)
      if (same(prev, value)) return; // a value published again is not a change
      if (value === undefined) state.delete(key);
      else state.set(key, value);
      if (isReady) notifyState(key, value, prev);
      return;
    }
    if (isReady) dispatch(env);
    else early.push(env);
  }

  // A fresh snapshot replaces state. Once the template is running, every difference is reported
  // as a change, so a re-sync after 410 updates the screen like any other change. A snapshot older
  // than what we already applied is ignored: it would roll state back.
  function applySnapshot(snap) {
    if (snap.build && meta.build && snap.build !== meta.build) return reloadForBuild();
    if (isReady && cursor && snap.cursor && snap.cursor < cursor) return;
    const before = new Map(state);
    state.clear();
    for (const key of Object.keys(snap.state || {})) {
      const v = snap.state[key];
      if (v !== null && v !== undefined) state.set(key, v);
    }
    const oldRecent = chatRecent;
    if (snap.chat && Array.isArray(snap.chat.recent)) chatRecent = snap.chat.recent.slice(-200);
    cursor = snap.cursor;
    if (!isReady) {
      snapshotLoaded = true;
      maybeReady();
      return;
    }
    for (const key of new Set([...before.keys(), ...state.keys()])) {
      if (!same(before.get(key), state.get(key))) notifyState(key, state.get(key), before.get(key));
    }
    if (override.scene === null) requestScene(state.get('show.scene') || defaultScene(), 'cut');
    resyncChat(oldRecent);
  }

  // A template upgraded on the server reloads the page in place: the URL in OBS never changes
  // (01 §1.4). A random delay keeps many sources from reloading at the same instant.
  let reloading = false;
  function reloadForBuild() {
    if (reloading) return;
    reloading = true;
    setTimeout(() => location.reload(), Math.round(Math.random() * 2000));
  }

  // Ready = the snapshot is in and the document is parsed. The stage and the first scene are in
  // place before any ready callback runs.
  function maybeReady() {
    if (isReady || !snapshotLoaded || !domReady) return;
    isReady = true;
    lastSettingsJson = JSON.stringify(settings());
    const first = override.scene !== null ? override.scene : (state.get('show.scene') || defaultScene());
    // Whatever happens mounting the first scene, the template's ready callbacks still run.
    try { if (first) showScene(first, 'cut', true); } catch (err) { reportError('the first scene failed to mount', err); }
    // Ready callbacks and onState's first calls run in the order the template registered them.
    for (const item of bootQueue.splice(0)) {
      if (item.sub) { if (stateSubs.items.indexOf(item.sub) >= 0) primeState(item.sub); } else safely(item.fn, []);
    }
    startChat();
    for (const env of early.splice(0)) dispatch(env);
  }

  // onState's once-on-ready call. Until it has run, the subscriber gets no changes, so a change in
  // between can't be delivered twice.
  function primeState(sub) {
    if (sub.primed) return;
    sub.primed = true;
    let any = false;
    for (const [key, value] of state) {
      if (!sub.test(key) || !declaredState(key)) continue;
      any = true;
      if (sub.wildcard) safely(sub.fn, [key, clone(value), undefined]);
      else safely(sub.fn, [clone(value), undefined]);
    }
    if (!any && !sub.wildcard) safely(sub.fn, [undefined, undefined]);
  }

  // ---- stage (04 §4.5) ----------------------------------------------------------------------
  // A fixed stage of the canvas size, scaled from the top-left and centred with whole-pixel offsets
  // (v0: percentage-of-self transforms render inconsistently in OBS). Templates lay out in canvas
  // pixels. The fit is re-checked every tick, because an OBS source can report a 0 or provisional
  // size at load.
  let stage = null;
  let fitted = '';

  function buildStage() {
    stage = document.createElement('div');
    stage.setAttribute('data-skp-stage', '');
    stage.style.cssText = 'position:absolute;left:0;top:0;overflow:hidden;transform-origin:0 0;' +
      'width:' + canvas.width + 'px;height:' + canvas.height + 'px';
    const body = document.body;
    for (const node of Array.from(body.childNodes)) {
      if (node.nodeName === 'SCRIPT' || node.nodeName === 'TEMPLATE' || node.nodeName === 'STYLE') continue;
      if (node.nodeType === 1 && node.hasAttribute('data-skp-boot')) continue;
      stage.appendChild(node);
    }
    body.appendChild(stage);
    for (const el of [html, body]) {
      el.style.margin = '0';
      el.style.overflow = 'hidden';
    }
    // The page stays transparent (the browser default) so OBS composites it over the camera;
    // ?bg=dark gives previews an opaque backdrop.
    if (override.dark) html.style.background = '#08070a';
    fit();
    window.addEventListener('resize', fit);
    tickFns.push(fit);
  }

  let sizeWarned = false;
  function fit() {
    if (!stage) return;
    const w = html.clientWidth || window.innerWidth;
    const h = html.clientHeight || window.innerHeight;
    const key = w + 'x' + h;
    if (key === fitted || !(w > 0 && h > 0)) return;
    fitted = key;
    // In OBS the browser source's size should be the canvas size; anything else is resampled
    // (blurry) or letterboxed. Say so once, in the template log.
    if (obs && !sizeWarned && (Math.abs(w / h - canvas.width / canvas.height) > 0.01 * (canvas.width / canvas.height) || w < canvas.width)) {
      sizeWarned = true;
      sendLog('warn', 'the OBS browser source is ' + w + 'x' + h + ' but this canvas is ' + canvas.width + 'x' + canvas.height + '; set the source to the canvas size');
    }
    const s = override.native ? 1 : Math.min(w / canvas.width, h / canvas.height);
    const x = override.native ? 0 : Math.round((w - canvas.width * s) / 2);
    const y = override.native ? 0 : Math.round((h - canvas.height * s) / 2);
    stage.style.transform = 'translate(' + x + 'px,' + y + 'px) scale(' + s + ')';
  }

  // ---- element lifecycle (05 §5.2) ----------------------------------------------------------
  // (absent) → enter → idle → exit → (removed), exposed as data-skp-state for CSS. Durations come
  // from opts.durationMs, then --skp-enter-ms / --skp-exit-ms, then the computed animation and
  // transition durations, then 0. Each step ends on a deadline, never on animationend.
  const lives = new WeakMap(); // element → { phase, promise } of its latest step

  function msList(value) {
    return String(value).split(',').map((v) => {
      const n = parseFloat(v);
      if (!isFinite(n)) return 0;
      return /ms\s*$/.test(v) ? n : n * 1000;
    });
  }

  function cssDuration(el, phase) {
    const cs = window.getComputedStyle(el);
    const custom = parseFloat(cs.getPropertyValue(phase === 'enter' ? '--skp-enter-ms' : '--skp-exit-ms'));
    if (isFinite(custom)) return Math.max(0, custom);
    let longest = 0;
    if (cs.animationName && cs.animationName !== 'none') {
      const durations = msList(cs.animationDuration);
      const delays = msList(cs.animationDelay);
      const counts = String(cs.animationIterationCount).split(',');
      cs.animationName.split(',').forEach((name, i) => {
        if (name.trim() === 'none') return;
        const count = parseFloat(counts[i % counts.length]);
        if (!isFinite(count)) return; // infinite loops (idle breathing) don't end an enter or exit
        longest = Math.max(longest, delays[i % delays.length] + durations[i % durations.length] * count);
      });
    }
    const tDur = msList(cs.transitionDuration);
    const tDelay = msList(cs.transitionDelay);
    tDur.forEach((d, i) => { if (d > 0) longest = Math.max(longest, d + tDelay[i % tDelay.length]); });
    return longest;
  }

  function durationOf(el, phase, opts) {
    if (env.reducedMotion) return 0;
    if (opts && typeof opts.durationMs === 'number') return Math.max(0, opts.durationMs);
    return cssDuration(el, phase);
  }

  // Seeks every animation under el forward, so a late arrival lands on the same frame as an on-time
  // one on another machine (05 §5.3).
  function seek(el, ms) {
    if (!(ms > 0) || !el.getAnimations) return;
    for (const a of el.getAnimations({ subtree: true })) {
      try { a.currentTime = (a.currentTime || 0) + ms; } catch (err) { /* not seekable */ }
    }
  }

  // opts: { durationMs, enter (exposed as data-skp-enter), parent, offsetMs, cut }
  function mount(el, opts) {
    opts = opts || {};
    if (opts.enter) el.setAttribute('data-skp-enter', opts.enter);
    if (!el.parentNode) (opts.parent || currentRootEl() || stage || document.body).appendChild(el);
    if (el.hasAttribute('data-skp-state')) {
      // Re-entering: restart the enter animation instead of letting the browser coalesce it.
      el.removeAttribute('data-skp-state');
      void el.offsetWidth;
    }
    const life = { phase: 'enter', promise: null };
    lives.set(el, life);
    if (opts.cut) {
      el.setAttribute('data-skp-state', 'idle');
      life.phase = 'idle';
      return (life.promise = Promise.resolve(el));
    }
    el.setAttribute('data-skp-state', 'enter');
    const ms = durationOf(el, 'enter', opts);
    const late = Math.max(0, opts.offsetMs || 0);
    seek(el, late);
    life.promise = new Promise((resolve) => {
      setTimeout(() => {
        if (lives.get(el) === life && el.getAttribute('data-skp-state') === 'enter') {
          el.setAttribute('data-skp-state', 'idle');
          life.phase = 'idle';
        }
        resolve(el);
      }, Math.max(0, ms - late));
    });
    return life.promise;
  }

  // Sets exit, removes the element after its exit duration plus 50 ms, and resolves then. A second
  // unmount of the same exit returns the same promise; a later mount cancels the removal.
  function unmount(el, opts) {
    opts = opts || {};
    if (!el || !el.parentNode) return Promise.resolve();
    const prev = lives.get(el);
    if (prev && prev.phase === 'exit' && !opts.cut) return prev.promise;
    if (opts.exit) el.setAttribute('data-skp-exit', opts.exit);
    const life = { phase: 'exit', promise: null };
    lives.set(el, life);
    if (opts.cut) {
      el.remove();
      runExitHooks(el);
      return (life.promise = Promise.resolve());
    }
    el.setAttribute('data-skp-state', 'exit');
    const ms = durationOf(el, 'exit', opts);
    life.promise = new Promise((resolve) => {
      setTimeout(() => {
        if (lives.get(el) === life) {
          el.remove();
          runExitHooks(el);
        }
        resolve();
      }, ms + 50);
    });
    return life.promise;
  }

  // The exit duration an element will have, measured before it exits: a declared --skp-exit-ms,
  // or a probe that flips data-skp-state to exit and back within one task (no frame is drawn in
  // between, so nothing visible happens).
  function exitDurationOf(el) {
    if (env.reducedMotion) return 0;
    const custom = parseFloat(window.getComputedStyle(el).getPropertyValue('--skp-exit-ms'));
    if (isFinite(custom)) return Math.max(0, custom);
    const prev = el.getAttribute('data-skp-state');
    el.setAttribute('data-skp-state', 'exit');
    const ms = cssDuration(el, 'exit');
    if (prev === null) el.removeAttribute('data-skp-state');
    else el.setAttribute('data-skp-state', prev);
    return ms;
  }

  // ---- scenes (04 §4.7, 05 §5.4) ------------------------------------------------------------
  const sceneBuilders = new Map(); // id → (ctx) => Node
  const sceneSubs = list();
  const exitHooks = new WeakMap(); // scene root → [fn]
  let current = null; // { id, root }
  let stinger = null;
  let pendingScene = null;

  function runExitHooks(el) {
    const hooks = exitHooks.get(el);
    if (!hooks) return;
    exitHooks.delete(el);
    for (const fn of hooks) safely(fn, []);
  }

  function collectSceneTemplates() {
    for (const tpl of document.querySelectorAll('template[data-skp-scene]')) {
      const id = tpl.getAttribute('data-skp-scene');
      if (!sceneBuilders.has(id)) sceneBuilders.set(id, () => tpl.content.cloneNode(true));
      // Content inside <template> is inert: warm its images now, or the first showing stutters
      // while they decode mid-animation (v0's first-intro stutter).
      for (const img of tpl.content.querySelectorAll('img[src]')) preload(new URL(img.getAttribute('src'), document.baseURI).href);
    }
  }

  function defaultScene() {
    const program = manifestScenes.find((s) => s.core === 'program');
    if (program) return program.id;
    if (manifestScenes.length) return manifestScenes[0].id;
    return sceneBuilders.size ? sceneBuilders.keys().next().value : null;
  }

  // A scene name from a show may be this template's scene id or a core scene name (04 §4.2):
  // shows and buttons work across templates through `core`.
  function resolveScene(name) {
    if (manifestScenes.some((s) => s.id === name) || sceneBuilders.has(name)) return name;
    const byCore = manifestScenes.find((s) => s.core === name);
    return byCore ? byCore.id : null;
  }

  function currentRootEl() {
    return current && current.root;
  }

  // Scene requests in one burst (a replayed backlog, a poll batch, a re-sync) converge on the
  // latest: one transition, never the scenes in between.
  function requestScene(name, transition) {
    if (!isReady) return;
    const queued = pendingScene;
    pendingScene = { name, transition };
    if (!queued) {
      setTimeout(() => {
        const p = pendingScene;
        pendingScene = null;
        if (p) showScene(p.name, p.transition);
      }, 0);
    }
  }

  function showScene(name, transition, initial) {
    let id = resolveScene(name);
    if (!id) {
      sendLog('warn', 'this template has no scene "' + name + '"; staying on ' + (current ? current.id : 'the default'));
      if (current) return;
      id = resolveScene(defaultScene());
      if (!id) return;
    }
    if (current && current.id === id) return;
    transition = transition || 'fade';
    const prev = current;
    const root = document.createElement('section');
    root.setAttribute('data-skp-scene-root', id);
    root.setAttribute('data-skp-transition', transition);
    root.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%';
    const build = sceneBuilders.get(id);
    if (build) {
      const hooks = [];
      exitHooks.set(root, hooks);
      const ctx = Object.freeze({ scene: id, root, settings: settings(), canvas, onExit: (fn) => { hooks.push(fn); } });
      const content = safely(build, [ctx]);
      if (isNode(content)) root.appendChild(content);
    }
    current = { id, root };
    html.setAttribute('data-skp-scene', id);
    if (prev) prev.root.setAttribute('data-skp-transition', transition);

    const sting = env.lite ? null : (meta.transitions || []).find((t) => t.id === transition && t.media);
    if (transition === 'cut' || !prev) {
      stage.appendChild(root);
      mount(root, { cut: true });
      if (prev) unmount(prev.root, { cut: true });
    } else if (sting) {
      playStinger(sting, root, prev.root);
    } else {
      stage.appendChild(root);
      mount(root); // both overlap: a crossfade by default, styled entirely in CSS
      unmount(prev.root);
    }
    const t = initial ? 'cut' : transition;
    for (const fn of sceneSubs.items.slice()) safely(fn, [id, prev ? prev.id : undefined, t, root]);
  }

  // A stinger plays over both scenes; the swap is a cut under it at cutAtMs (05 §5.4). The video is
  // muted (audio belongs in OBS) and is removed when it ends, or by a deadline if 'ended' never
  // fires (a hidden source, a file that won't load).
  function playStinger(sting, root, oldRoot) {
    if (stinger) stinger.remove();
    const video = document.createElement('video');
    video.setAttribute('data-skp-stinger', sting.id);
    video.setAttribute('muted', '');
    video.setAttribute('playsinline', '');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.src = asset(sting.media);
    video.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;object-fit:cover;z-index:2147483647;pointer-events:none';
    stage.appendChild(video);
    stinger = video;
    const p = video.play();
    if (p && p.catch) p.catch(() => {});
    const cutAt = Math.max(0, sting.cutAtMs || 0);
    setTimeout(() => {
      stage.insertBefore(root, video);
      mount(root, { cut: true });
      unmount(oldRoot, { cut: true });
    }, cutAt);
    const done = () => { if (stinger === video) stinger = null; video.remove(); };
    video.addEventListener('ended', done);
    video.addEventListener('error', () => setTimeout(done, cutAt + 50));
    setTimeout(done, cutAt + 5000);
  }

  // ---- actions (04 §4.6, 05 §5.3) -----------------------------------------------------------
  const actionHandlers = new Map();

  // A trigger runs at startAt on server time. One arriving late but inside its window runs at once
  // with lateMs, so animations can be offset to land on the same frame as on-time clients; one
  // whose window has passed is dropped, including replays after a reconnect.
  function runTrigger(t) {
    const handler = actionHandlers.get(t.name);
    if (!handler) {
      if (override.debug) sendLog('info', 'no handler for action "' + t.name + '"');
      return;
    }
    const declared = (meta.actions || []).find((a) => a.id === t.name);
    const startAt = typeof t.startAt === 'number' ? t.startAt : now();
    const durationMs = typeof t.durationMs === 'number' ? t.durationMs : (declared && declared.durationMs) || 0;
    const end = durationMs > 0 ? startAt + durationMs : startAt + 250;
    if (now() >= end) return;
    at(startAt, () => {
      const lateMs = Math.max(0, now() - startAt);
      if (now() >= end) return;
      handler({ args: clone(t.args) || {}, startAt, durationMs, lateMs });
    });
  }

  // ---- alerts (05 §5.5) ---------------------------------------------------------------------
  // The server queues alerts and gives each a display window. The runtime shows it from startAt,
  // starts its exit so it ends with the window, and cuts it on alerts.cut. It never queues alerts
  // itself. An alert without a window (before the server queue, plan step 19) gets one from its
  // envelope time and the manifest duration, so H and V sources still agree.
  let alertRenderer = null;
  const activeAlerts = new Map(); // envelope id → { el, cancels: [] }

  function alertContainer() {
    return (current && current.root.querySelector('[data-skp-alerts]')) ||
      (stage && stage.querySelector('[data-skp-alerts]')) || currentRootEl() || stage || document.body;
  }

  function queueAlert(env) {
    if (!alertRenderer || !declaresAlerts) return;
    const data = env.data || {};
    const win = data.display && typeof data.display.startAt === 'number'
      ? data.display
      : { startAt: typeof env.ts === 'number' ? env.ts : now(), durationMs: alertSpec.durationMs };
    if (now() >= win.startAt + win.durationMs) return; // its window has passed
    const entry = { el: null, cancels: [] };
    activeAlerts.set(env.id, entry);
    entry.cancels.push(at(win.startAt, () => showAlert(env, entry, win)));
  }

  function showAlert(env, entry, win) {
    if (activeAlerts.get(env.id) !== entry) return;
    const el = document.createElement('div');
    el.setAttribute('data-skp-alert', (env.data && env.data.kind) || env.type.slice(6));
    entry.el = el;
    const container = alertContainer();
    let done = false;
    const go = () => {
      if (done || activeAlerts.get(env.id) !== entry) return;
      done = true;
      if (!el.parentNode) container.appendChild(el);
      const late = Math.max(0, now() - win.startAt);
      mount(el, { offsetMs: late });
      const exitAt = win.startAt + win.durationMs - exitDurationOf(el);
      entry.cancels.push(at(exitAt, () => {
        activeAlerts.delete(env.id);
        unmount(el);
      }));
    };
    const result = safely(alertRenderer, [clone(env.data), el]);
    if (result && typeof result.then === 'function') {
      result.then(go, go);
      setTimeout(go, timing.alertRenderWaitMs); // the renderer gets 250 ms, then it mounts regardless
    } else {
      go();
    }
  }

  function cutAlert(id) {
    const entry = activeAlerts.get(id);
    if (!entry) return;
    activeAlerts.delete(id);
    entry.cancels.forEach((c) => c());
    if (entry.el) unmount(entry.el);
  }

  // ---- chat (02 §2.3, 05 §5.6) --------------------------------------------------------------
  // Messages are paced into frames of at most 4 per 250 ms. A handler that returns an element hands
  // it to the runtime, which mounts it, keeps at most chat.max on screen (unmounting the oldest),
  // and removes it on deletion, ban or clear. onRemove reports moderation removals.
  const chatAdd = list();
  const chatRemove = list();
  const chatClear = list();
  const chatQueue = [];
  const chatEls = []; // [{ id, userId, el }] oldest first
  const chatSeen = new Set(); // ids already handed to the template
  let chatTimer = null;
  let chatStarted = false;

  function chatContainer() {
    return (current && current.root.querySelector('[data-skp-chat]')) ||
      (stage && stage.querySelector('[data-skp-chat]')) || null;
  }

  function startChat() {
    chatStarted = true;
    if (!chatSpec) return;
    for (const m of chatRecent.slice(-chatMax)) addChatMessage(m, true);
  }

  function addChatMessage(m, initial) {
    if (!m || chatSeen.has(m.id)) return;
    chatSeen.add(m.id);
    if (chatSeen.size > 1000) chatSeen.delete(chatSeen.values().next().value);
    for (const fn of chatAdd.items.slice()) {
      const el = safely(fn, [clone(m), { initial: !!initial }]);
      if (!isNode(el)) continue;
      const box = chatContainer();
      if (!el.parentNode && box) box.appendChild(el);
      mount(el, initial ? { cut: true } : undefined);
      chatEls.push({ id: m.id, userId: m.user && m.user.id, el });
      while (chatEls.length > chatMax) unmount(chatEls.shift().el);
    }
  }

  function pumpChat() {
    chatTimer = null;
    for (const m of chatQueue.splice(0, timing.chatPerFrame)) addChatMessage(m, false);
    if (chatQueue.length) chatTimer = setTimeout(pumpChat, timing.chatFrameMs);
  }

  function queueChat(m) {
    chatQueue.push(m);
    // More than about two seconds of backlog (32 at 4 per 250 ms, or chat.max if larger): skip the
    // oldest, so a flooded chat stays live instead of drawing messages seconds late.
    const backlog = Math.max(chatMax, (2000 / timing.chatFrameMs) * timing.chatPerFrame);
    if (chatQueue.length > backlog) chatQueue.splice(0, chatQueue.length - backlog);
    if (!chatTimer) chatTimer = setTimeout(pumpChat, 0);
  }

  function takeOffScreen(test) {
    const removed = [];
    for (let i = chatQueue.length - 1; i >= 0; i--) if (test(chatQueue[i].id, chatQueue[i].user && chatQueue[i].user.id)) chatQueue.splice(i, 1);
    for (let i = chatEls.length - 1; i >= 0; i--) {
      const item = chatEls[i];
      if (test(item.id, item.userId)) {
        chatEls.splice(i, 1);
        unmount(item.el);
        removed.push(item.id);
      }
    }
    return removed;
  }

  function chatEvent(env) {
    if (!chatSpec) return;
    const d = env.data || {};
    if (env.type === 'chat.message') {
      chatRecent.push(d);
      if (chatRecent.length > 200) chatRecent = chatRecent.slice(-200);
      if (chatStarted) queueChat(d);
    } else if (env.type === 'chat.message.deleted') {
      const shown = chatSeen.has(d.messageId);
      chatRecent = chatRecent.filter((m) => m.id !== d.messageId);
      takeOffScreen((id) => id === d.messageId);
      if (shown) for (const fn of chatRemove.items.slice()) safely(fn, [d.messageId]);
    } else if (env.type === 'chat.user.cleared') {
      const gone = chatRecent.filter((m) => m.user && m.user.id === d.userId && chatSeen.has(m.id)).map((m) => m.id);
      chatRecent = chatRecent.filter((m) => !(m.user && m.user.id === d.userId));
      takeOffScreen((id, userId) => userId === d.userId);
      for (const id of gone) for (const fn of chatRemove.items.slice()) safely(fn, [id]);
    } else if (env.type === 'chat.cleared') {
      chatRecent = [];
      chatQueue.length = 0;
      for (const item of chatEls.splice(0)) unmount(item.el); // everything exits at once
      for (const fn of chatClear.items.slice()) safely(fn, []);
    }
  }

  // After a re-sync: messages missing from the new buffer were moderated during the gap and come
  // off screen (when the new buffer reaches back that far); new ones are added once.
  function resyncChat(oldRecent) {
    if (!chatSpec || !chatStarted) return;
    const ids = new Set(chatRecent.map((m) => m.id));
    const covers = chatRecent.length < ((chatSpec && chatSpec.recent) || 50);
    if (covers) {
      const gone = oldRecent.filter((m) => !ids.has(m.id) && chatSeen.has(m.id)).map((m) => m.id);
      takeOffScreen((id) => gone.indexOf(id) >= 0);
      for (const id of gone) for (const fn of chatRemove.items.slice()) safely(fn, [id]);
    }
    for (const m of chatRecent) if (!chatSeen.has(m.id)) queueChat(m);
  }

  // ---- music (02 §2.5.1) --------------------------------------------------------------------
  function track() {
    return declaredState('music.nowPlaying') ? clone(state.get('music.nowPlaying')) : undefined;
  }

  // progressMs was true at progressAt (server time); interpolate locally, never poll.
  function progress() {
    const t = declaredState('music.nowPlaying') ? state.get('music.nowPlaying') : undefined;
    if (!t || typeof t.progressMs !== 'number') return undefined;
    if (!t.playing || typeof t.progressAt !== 'number') return t.progressMs;
    const p = Math.max(0, t.progressMs + (now() - t.progressAt));
    return typeof t.durationMs === 'number' ? Math.min(t.durationMs, p) : p;
  }

  // ---- settings -----------------------------------------------------------------------------
  // overlay.settings, or in a preview the unsaved settings in ?settings= (which then replace them,
  // live edits included, since the admin form holds the whole object).
  const settingsSubs = list();
  let lastSettingsJson = null;

  function settings() {
    return deepFreeze(clone(override.settings || state.get('overlay.settings') || {}));
  }

  function notifySettings() {
    if (!isReady) return;
    const s = settings();
    const json = JSON.stringify(s);
    if (json === lastSettingsJson) return;
    lastSettingsJson = json;
    for (const fn of settingsSubs.items.slice()) safely(fn, [s]);
  }

  // ---- assets -------------------------------------------------------------------------------
  // A versioned, cacheable URL for a file in the template package (04 §4.5).
  function asset(path) {
    const p = String(path).replace(/^(\.\/)+/, '');
    if (/^\/|^[a-z][a-z0-9+.-]*:|(^|\/)\.\.(\/|$)/i.test(p)) throw new TypeError('SK.asset takes a path inside the template package: ' + path);
    return base + '/t/' + meta.build + '/' + p;
  }

  // Decodes images ahead of their first reveal (05 §5.8). Resolves when all are ready; failures
  // don't reject.
  // A hidden OBS source may never finish decoding, so each wait is capped at 3 s.
  const warm = new Map();
  function preload(urls) {
    return Promise.all([].concat(urls).filter(Boolean).map((u) => {
      if (!warm.has(u)) {
        const img = new Image();
        img.src = u;
        const decoded = img.decode ? img.decode().catch(() => {}) : Promise.resolve();
        warm.set(u, { img, ready: Promise.race([decoded, sleep(3000)]) });
      }
      return warm.get(u).ready;
    })).then(() => undefined);
  }

  // ---- log and errors -----------------------------------------------------------------------
  // SK.log goes to the platform's template log, batched; the server rate-limits per overlay. Errors
  // are never painted on air (only the ?debug=1 HUD shows them).
  const logQueue = [];
  const logSeen = new Map(); // message → when it was last sent, so a loop logs it once a minute
  let logTimer = null;
  let lastError = '';

  function sendLog(level, msg, context) {
    msg = String(msg).slice(0, 500);
    const t = Date.now();
    if (t - (logSeen.get(msg) || -Infinity) < 60000) return;
    logSeen.set(msg, t);
    if (logSeen.size > 200) logSeen.delete(logSeen.keys().next().value);
    // OBS copies page console errors into its own log file.
    if (level === 'error' || level === 'warn') (console[level] || console.log).call(console, '[skp] ' + msg);
    logQueue.push({ level, msg, context });
    if (logQueue.length > 50) logQueue.splice(0, logQueue.length - 50);
    if (!logTimer && !override.mock) logTimer = setTimeout(flushLog, 1000);
  }

  function flushLog() {
    logTimer = null;
    const entries = logQueue.splice(0, 20);
    if (!entries.length) return;
    // A string body is a CORS-simple request: no preflight from the sandboxed preview. Never with
    // credentials: OBS's browser could otherwise attach an admin session cookie.
    fetch(base + '/log?v=1' + keyParam, { method: 'POST', body: JSON.stringify({ entries }), credentials: 'omit' }).catch(() => {});
    if (logQueue.length) logTimer = setTimeout(flushLog, 1000);
  }

  function reportError(what, err) {
    const text = (err && (err.stack || err.message)) || String(err);
    lastError = what + ': ' + text;
    sendLog('error', what, { error: String(text).slice(0, 1000) });
  }

  // v0's error ladder, rebuilt for a CSP without inline script: this script runs first, so it sees
  // template script errors, failed loads (capture phase) and CSP violations.
  window.addEventListener('error', (ev) => {
    const t = ev.target;
    if (t && t !== window && t.nodeType === 1) {
      sendLog('error', 'failed to load ' + (t.src || t.href || t.nodeName));
      return;
    }
    reportError('uncaught error', ev.error || ev.message);
  }, true);
  window.addEventListener('unhandledrejection', (ev) => reportError('unhandled rejection', ev.reason));
  document.addEventListener('securitypolicyviolation', (ev) => {
    const blocked = String(ev.blockedURI || '').split(/[?#]/)[0]; // never log a key= value
    sendLog('error', 'blocked by the overlay security policy: ' + (ev.effectiveDirective || ev.violatedDirective) + ' ' + blocked);
  });

  // ---- debug HUD (?debug=1) -----------------------------------------------------------------
  function startHud() {
    const hud = document.createElement('div');
    hud.setAttribute('data-skp-debug', '');
    hud.style.cssText = 'position:fixed;left:8px;top:8px;z-index:2147483647;padding:8px 12px;white-space:pre;' +
      'font:13px/1.5 ui-monospace,Consolas,monospace;color:#16e0ff;background:rgba(0,0,0,.85);border:1px solid #16e0ff;pointer-events:none';
    document.body.appendChild(hud);
    const tpl = meta.template || {};
    const overrides = ['scene', 'mock', 'settings', 'lite', 'bg', 'fit'].filter((p) => params.has(p)).join(' ') || 'none';
    tickFns.push(() => {
      const age = transport.lastData ? Math.round((Date.now() - transport.lastData) / 1000) + ' s ago' : 'never';
      hud.textContent = 'SKP ' + version + ' · ' + meta.slug + ' · ' + (tpl.id || '?') + '@' + (tpl.version || '?') + ' (' + meta.build + ')\n' +
        'canvas ' + canvas.id + ' ' + canvas.width + 'x' + canvas.height + ' · viewport ' + window.innerWidth + 'x' + window.innerHeight +
        ' · ' + (stage ? stage.style.transform : '') + '\n' +
        'scene ' + (current ? current.id : '—') + ' (show ' + (state.get('show.scene') || '—') + ') · tick ' + ticks + '\n' +
        'transport ' + SK.transport.mode + ' · ' + transport.received + ' received · streams ' + transport.opened +
        ' · skew ' + Math.round(skew) + ' ms · data ' + age + '\n' +
        'overrides ' + overrides + '\n' +
        (lastError ? 'ERR ' + lastError.slice(0, 240) : 'no errors');
    });
  }

  // ---- connection (01 §1.5, 01 §1.7) --------------------------------------------------------
  // 1. Fetch the snapshot and render. 2. Stream everything after its cursor (Server-Sent Events read
  // with fetch: EventSource only delivers named events to per-name listeners, and hides the
  // status). 3. A stream that errors, ends, or hasn't opened within 5 s has failed; two failures in
  // 30 s switch to polling every 700 ms (1500 ms in lite mode), with the stream retried later.
  // 429: this browser already holds as many streams as the server allows; poll right away and
  // retry after Retry-After. 410: the cursor is too old; fetch the snapshot again. While the server
  // is unreachable the last good state stays on screen. Only one snapshot fetch and one polling
  // loop ever run at a time.
  function request(url, ms, signal) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    if (signal) signal.addEventListener('abort', () => ctrl.abort());
    return fetch(url, { cache: 'no-store', credentials: 'omit', signal: ctrl.signal }).finally(() => clearTimeout(timer));
  }

  let snapshotFlight = null;
  function loadSnapshot() {
    if (!snapshotFlight) snapshotFlight = fetchSnapshot().finally(() => { snapshotFlight = null; });
    return snapshotFlight;
  }

  async function fetchSnapshot() {
    let delay = timing.snapshotRetryMs;
    for (;;) {
      let snap = null;
      try {
        const p0 = performance.now();
        const res = await request(base + '/snapshot?v=1' + keyParam, timing.requestTimeoutMs);
        const p1 = performance.now();
        if (res.ok) {
          snap = await res.json();
          sampleClock(snap.ts, p0, p1);
        }
      } catch (err) { /* unreachable: keep what's on screen and retry */ }
      if (snap) {
        transport.ok = true;
        transport.lastData = Date.now();
        // Applying is not a network failure: an error here is reported, never retried in a loop.
        try { applySnapshot(snap); } catch (err) { reportError('applying the snapshot failed', err); }
        return;
      }
      transport.ok = false;
      await sleep(delay);
      delay = Math.min(delay * 2, timing.snapshotRetryMaxMs);
    }
  }

  async function runStream(onOpen) {
    const ctrl = new AbortController();
    const openTimer = setTimeout(() => ctrl.abort(), timing.openTimeoutMs);
    let res;
    try {
      res = await fetch(base + '/stream?cursor=' + encodeURIComponent(cursor) + keyParam, { cache: 'no-store', credentials: 'omit', signal: ctrl.signal });
    } catch (err) {
      clearTimeout(openTimer);
      return 'failed';
    }
    clearTimeout(openTimer);
    if (!res.ok || !res.body) {
      transport.retryAfter = Number(res.headers.get('retry-after')) || 0;
      ctrl.abort(); // give the connection back to the browser's six-per-host pool at once
      if (res.status === 410) return 'gone';
      if (res.status === 429) return 'busy';
      return 'failed';
    }

    transport.opened++;
    transport.ok = true;
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
        buf += decoder.decode(chunk.value, { stream: true });
        // Normalise line ends on the joined text, holding back a final \r whose \n may come next.
        const hold = buf.slice(-1) === '\r' ? '\r' : '';
        buf = (hold ? buf.slice(0, -1) : buf).replace(/\r\n?/g, '\n');
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          handleBlock(buf.slice(0, i));
          buf = buf.slice(i + 2);
        }
        buf += hold;
      }
    } catch (err) { /* aborted or dropped */ } finally {
      clearTimeout(silence);
    }
    return 'ended';
  }

  function handleBlock(block) {
    let data = '';
    for (const line of block.split('\n')) {
      if (!line) continue;
      if (line[0] === ':') { // comments: ": open <ts> <build>", ": hb <ts>"
        const m = /^: ?(open|hb) (\d+)(?: (\S+))?/.exec(line);
        if (m) {
          oneWaySample(Number(m[2]));
          if (m[3] && meta.build && m[3] !== meta.build) reloadForBuild();
        }
        continue;
      }
      const c = line.indexOf(':');
      const field = c < 0 ? line : line.slice(0, c);
      let value = c < 0 ? '' : line.slice(c + 1);
      if (value[0] === ' ') value = value.slice(1);
      if (field === 'data') data += (data ? '\n' : '') + value;
    }
    if (!data) return;
    let env;
    try { env = JSON.parse(data); } catch (err) { return; } // a malformed message is skipped alone
    apply(env);
  }

  let pollGen = 0;
  let probeTimer = null;

  async function streamLoop() {
    let gone = 0;
    for (;;) {
      const result = await runStream(() => {
        transport.mode = 'stream';
        stopPolling();
      });
      if (result === 'gone') {
        await loadSnapshot();
        gone++;
        if (gone > 1) await sleep(Math.min(timing.snapshotRetryMaxMs, timing.reconnectMs * Math.pow(2, gone - 2)));
        continue;
      }
      if (result === 'busy') {
        if (transport.mode !== 'poll') startPolling(transport.retryAfter * 1000);
        return;
      }
      if (transport.mode === 'poll') return; // a retry from poll mode that didn't open: keep polling
      const t = Date.now();
      transport.failures = transport.failures.filter((f) => t - f < timing.failWindowMs);
      transport.failures.push(t);
      if (transport.failures.length >= 2) {
        transport.failures = [];
        startPolling();
        return;
      }
      transport.ok = false;
      await sleep(timing.reconnectMs);
    }
  }

  function startPolling(retryInMs) {
    transport.mode = 'poll';
    const gen = ++pollGen;
    const tick = async () => {
      await pollOnce(gen);
      if (gen === pollGen) setTimeout(tick, env.lite ? timing.pollLiteMs : timing.pollMs);
    };
    tick();
    const probe = () => {
      if (gen !== pollGen) return;
      streamLoop();
      probeTimer = setTimeout(probe, timing.retryStreamMs);
    };
    probeTimer = setTimeout(probe, retryInMs > 0 ? retryInMs : timing.retryStreamMs);
  }

  function stopPolling() {
    pollGen++;
    clearTimeout(probeTimer);
  }

  async function pollOnce(gen) {
    try {
      const p0 = performance.now();
      const res = await request(base + '/poll?cursor=' + encodeURIComponent(cursor) + keyParam, timing.requestTimeoutMs);
      const p1 = performance.now();
      if (gen !== pollGen) return;
      if (res.status === 410) return loadSnapshot();
      if (!res.ok) { transport.ok = false; return; }
      const body = await res.json();
      if (gen !== pollGen) return;
      transport.ok = true;
      sampleClock(body.ts, p0, p1);
      if (body.build && meta.build && body.build !== meta.build) return reloadForBuild();
      for (const e of body.envelopes) apply(e);
    } catch (err) {
      transport.ok = false; // unreachable: keep the last good state on screen (01 §1.7)
    }
  }

  // ---- mock (?mock=1, 08 §8.5) --------------------------------------------------------------
  // Sample data instead of the server: /sdk/v1/mock.js feeds a snapshot and envelopes through this
  // hook, and they pass the same filters as live data. It's a separate file so this one stays small.
  function startMock() {
    transport.mode = 'mock';
    let seq = 0;
    const id = () => {
      seq++;
      return Date.now().toString(36).padStart(10, '0') + String(seq).padStart(16, '0');
    };
    Object.defineProperty(window, '__skpMock', {
      value: Object.freeze({
        meta,
        now,
        snapshot(snap) { applySnapshot(Object.assign({ cursor: id(), ts: Date.now() }, snap)); },
        push(type, data) { apply({ id: id(), type, ts: now(), src: { connector: 'simulator' }, data }); },
      }),
    });
    // If the sample data never arrives, start empty rather than never becoming ready.
    const empty = () => { if (!snapshotLoaded) applySnapshot({ cursor: id(), ts: Date.now(), state: {} }); };
    const s = document.createElement('script');
    s.src = '/sdk/v1/mock.js';
    s.addEventListener('error', () => { reportError('mock data failed to load', new Error('/sdk/v1/mock.js')); empty(); });
    document.head.appendChild(s);
    setTimeout(empty, 3000);
  }

  // ---- the API (04 §4.4) --------------------------------------------------------------------
  // Every subscribe call returns a function that removes the subscription again.
  const SK = {
    meta,
    env,
    canvas,

    ready(fn) {
      if (isReady) setTimeout(() => safely(fn, []), 0);
      else bootQueue.push({ fn });
    },

    get settings() { return settings(); },
    onSettings(fn) { return settingsSubs.add(fn); },

    state(key) { return declaredState(key) ? clone(state.get(key)) : undefined; },

    // onState('viewers.total', (value, prev) => …) or onState('show.*', (key, value, prev) => …).
    // Fires once with the current value when the template is ready (04 §4.4).
    onState(pattern, fn) {
      const sub = { test: matcher(pattern), wildcard: String(pattern).slice(-2) === '.*', fn, primed: false };
      const remove = stateSubs.add(sub);
      if (isReady) setTimeout(() => { if (stateSubs.items.indexOf(sub) >= 0) primeState(sub); }, 0);
      else bootQueue.push({ sub });
      return remove;
    },

    // on('alert.*', envelope => …): only types the template declared (04 §4.2).
    on(pattern, fn) { return eventSubs.add({ test: matcher(pattern), fn }); },

    get scene() { return current ? current.id : undefined; },
    onScene(fn) {
      const remove = sceneSubs.add(fn);
      if (isReady && current) {
        const c = current;
        setTimeout(() => { if (sceneSubs.items.indexOf(fn) >= 0 && current === c) safely(fn, [c.id, undefined, 'cut', c.root]); }, 0);
      }
      return remove;
    },
    defineScene(id, build) { sceneBuilders.set(id, build); },

    action(name, fn) {
      if (!(meta.actions || []).some((a) => a.id === name)) sendLog('warn', 'action "' + name + '" is not declared in template.json');
      actionHandlers.set(name, fn);
    },

    chat: Object.freeze({
      recent() { return chatSpec ? clone(chatRecent) : []; },
      onAdd(fn) { return chatAdd.add(fn); },
      onRemove(fn) { return chatRemove.add(fn); },
      onClear(fn) { return chatClear.add(fn); },
    }),

    music: Object.freeze({ track, progress }),

    alerts: Object.freeze({
      render(fn) { alertRenderer = fn; },
    }),

    mount,
    unmount,
    preload,

    clock: Object.freeze({ now, at }),

    asset,

    log: Object.freeze({
      info: (msg, context) => sendLog('info', msg, context),
      warn: (msg, context) => sendLog('warn', msg, context),
      error: (msg, context) => sendLog('error', msg, context),
    }),

    // Read-only connection details, for diagnostics.
    transport: Object.freeze({
      get mode() { return transport.mode !== 'mock' && !transport.ok ? 'offline' : transport.mode; },
      get cursor() { return cursor; },
      get received() { return transport.received; },
      get streamsOpened() { return transport.opened; },
      get skew() { return skew; },
    }),
  };
  Object.defineProperty(window, 'SK', { value: Object.freeze(SK), writable: false, configurable: false, enumerable: true });

  // ---- start --------------------------------------------------------------------------------
  function onDom() {
    const boot = document.querySelector('[data-skp-boot]');
    if (boot) boot.remove(); // the runtime is running
    buildStage();
    collectSceneTemplates();
    if (override.debug) startHud();
    domReady = true;
    maybeReady();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', onDom);
  else onDom();

  if (override.mock) {
    startMock();
  } else {
    loadSnapshot().then(streamLoop);
  }
})();
