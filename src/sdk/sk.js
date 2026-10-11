/* SKP runtime SDK v1 (04 §4.4). Served at /sdk/v1/sk.js and injected into every overlay page, in
   <head>, before the template's own scripts. Templates get all live data through the frozen global
   SK and never connect to anything themselves (H1).

   Constraints: no dependencies, no build step (this file is served as written), it must run in the
   browser OBS 30 ships (Chromium 103), and it must stay under 25 KB gzipped (a test checks).
   Correctness never depends on requestAnimationFrame or animationend (H9): OBS stops painting
   sources it isn't showing, and hidden elements never fire animationend. Timers and deadlines it is.

   Sections: page settings · server clock · state and events · stage · element lifecycle · scenes ·
   actions · alerts · chat · music · settings · log · debug HUD · connection · mock · the API. */
(() => {
  'use strict';

  // ---- page settings ------------------------------------------------------------------------
  // The server passes the overlay's settings in <meta name="skp"> (the CSP forbids inline script).
  const metaEl = document.querySelector('meta[name="skp"]');
  const meta = JSON.parse(metaEl ? metaEl.getAttribute('content') : '{}');
  const canvas = meta.canvas || { id: 'h', width: 1920, height: 1080 };
  const manifestScenes = meta.scenes || [];
  const alertSpec = Object.assign({ mode: 'serial', maxConcurrent: 3, durationMs: 6000, gapMs: 500 }, meta.alerts || {});
  const chatMax = (meta.chat && meta.chat.max) || 30;
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
    alertRenderWaitMs: 250,
    chatFrameMs: 250,
    chatPerFrame: 4,
  }, meta.timing || {});

  const params = new URLSearchParams(location.search);
  const keyParam = params.get('key') ? '&key=' + encodeURIComponent(params.get('key')) : '';
  const base = '/o/' + encodeURIComponent(meta.slug);

  // Preview overrides (04 §4.9): the admin UI and development only, never in OBS links.
  const override = {
    scene: params.get('scene'),
    dark: params.get('bg') === 'dark',
    mock: params.get('mock') === '1',
    debug: params.get('debug') === '1',
    settings: decodeSettings(params.get('settings')),
  };

  let framed = true;
  try { framed = window.self !== window.top; } catch (err) { /* cross-origin parent: framed */ }
  const obs = typeof window.obsstudio === 'object' && window.obsstudio !== null;
  const preview = !obs && (framed || override.mock || override.scene !== null || override.settings !== null);
  const env = Object.freeze({
    preview,
    lite: params.get('lite') === '1',
    // Honoured in the admin UI only; on air, OBS sources always animate (05 §5.9).
    reducedMotion: preview && !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches),
    obs,
  });

  const html = document.documentElement;
  html.setAttribute('data-skp-canvas', canvas.id);
  if (env.lite) html.setAttribute('data-skp-lite', '');
  if (env.reducedMotion) html.setAttribute('data-skp-reduced-motion', '');

  function decodeSettings(value) {
    if (!value) return null;
    try {
      const bytes = Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
      const parsed = JSON.parse(new TextDecoder().decode(bytes));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch (err) {
      return null;
    }
  }

  // ---- small helpers ------------------------------------------------------------------------
  const clone = (v) => (v === undefined ? undefined : structuredClone(v));
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // Template callbacks are isolated: one that throws is logged and the rest still run.
  function safely(fn, args) {
    try {
      return fn.apply(null, args);
    } catch (err) {
      reportError('a template callback threw', err);
      return undefined;
    }
  }

  // Patterns: an exact name, or a prefix ending in ".*" (`alert.*`, `show.*`).
  function matcher(pattern) {
    if (pattern.slice(-2) === '.*') {
      const prefix = pattern.slice(0, -1);
      return (name) => name.indexOf(prefix) === 0;
    }
    return (name) => name === pattern;
  }

  // ---- server clock (01 §1.6) ---------------------------------------------------------------
  // skew = server time − local time, from the request with the shortest round trip seen in the
  // last minute: the shorter the round trip, the tighter the estimate.
  let skew = 0;
  let bestSample = null;
  function sampleClock(serverTs, t0, t1) {
    if (typeof serverTs !== 'number') return;
    const rtt = t1 - t0;
    if (!bestSample || rtt <= bestSample.rtt || t1 - bestSample.at > 60000) {
      bestSample = { rtt, at: t1 };
      skew = serverTs - (t0 + t1) / 2;
    }
  }
  const now = () => Date.now() + skew;

  // Runs fn at a server time. Re-checks every 250 ms, so it stays right across clock corrections
  // and in throttled sources (05 §5.3). Returns a cancel function.
  function at(ts, fn) {
    if (now() >= ts) {
      const id = setTimeout(() => safely(fn, []), 0);
      return () => clearTimeout(id);
    }
    const id = setInterval(() => {
      if (now() >= ts) {
        clearInterval(id);
        safely(fn, []);
      }
    }, 250);
    return () => clearInterval(id);
  }

  // ---- state and events ---------------------------------------------------------------------
  const state = new Map();
  let chatRecent = [];
  let cursor = null;
  let snapshotLoaded = false;
  let domReady = false;
  let isReady = false;
  const early = []; // envelopes that arrived after the snapshot but before ready
  const readyFns = [];
  const stateSubs = [];
  const eventSubs = [];
  const transport = { mode: 'connecting', received: 0, failures: [], opened: 0 };

  function notifyState(key, value, prev) {
    for (const sub of stateSubs.slice()) {
      if (!sub.test(key)) continue;
      if (sub.wildcard) safely(sub.fn, [key, clone(value), clone(prev)]);
      else safely(sub.fn, [clone(value), clone(prev)]);
    }
    if (key === 'overlay.settings') notifySettings();
    if (key === 'show.scene' && override.scene === null && value !== undefined) showScene(value, 'fade');
  }

  function dispatch(env) {
    const type = env.type;
    if (type === 'show.scene.changed') {
      if (override.scene === null && env.data && env.data.scene) showScene(env.data.scene, env.data.transition || 'fade');
    } else if (type === 'show.trigger') {
      runTrigger(env.data || {});
    } else if (type.indexOf('alert.') === 0) {
      queueAlert(env);
    } else if (type === 'alerts.cut') {
      cutAlert(env.data && env.data.alertId);
    } else if (type.indexOf('chat.') === 0) {
      chatEvent(env);
    }
    for (const sub of eventSubs.slice()) if (sub.test(type)) safely(sub.fn, [clone(env)]);
  }

  function apply(env) {
    if (!env || typeof env.id !== 'string' || typeof env.type !== 'string') return;
    if (cursor && env.id <= cursor) return; // already seen: a replay overlaps what we had
    cursor = env.id;
    transport.received++;
    if (env.type === 'state.changed') {
      const key = env.data.key;
      const prev = state.get(key);
      if ('value' in env.data) state.set(key, env.data.value);
      else state.delete(key); // absent, never null or 0 (02 §2.8)
      if (isReady) notifyState(key, env.data.value, prev);
    }
    if (isReady) dispatch(env);
    else if (env.type !== 'state.changed') early.push(env); // state is already in `state`
  }

  // A fresh snapshot replaces state. Once the template is running, every difference is reported
  // as a change, so a re-sync after 410 updates the screen like any other change.
  function applySnapshot(snap) {
    const before = new Map(state);
    state.clear();
    for (const key of Object.keys(snap.state || {})) state.set(key, snap.state[key]);
    if (snap.chat && Array.isArray(snap.chat.recent)) chatRecent = snap.chat.recent;
    cursor = snap.cursor;
    if (!isReady) {
      snapshotLoaded = true;
      maybeReady();
      return;
    }
    const keys = new Set([...before.keys(), ...state.keys()]);
    for (const key of keys) {
      if (JSON.stringify(before.get(key)) !== JSON.stringify(state.get(key))) notifyState(key, state.get(key), before.get(key));
    }
  }

  // Ready = the snapshot is in and the document is parsed. The stage and the first scene are in
  // place before any ready callback runs.
  function maybeReady() {
    if (isReady || !snapshotLoaded || !domReady) return;
    isReady = true;
    lastSettingsJson = JSON.stringify(settings());
    const first = override.scene !== null ? override.scene : (state.get('show.scene') || defaultScene());
    if (first) showScene(first, 'cut');
    for (const fn of readyFns.splice(0)) safely(fn, []);
    startChat();
    for (const env of early.splice(0)) dispatch(env);
  }

  // ---- stage (04 §4.5) ----------------------------------------------------------------------
  // A fixed stage of the canvas size, scaled to the viewport from the top-left and centred.
  // Templates lay out in canvas pixels and never compute scaling themselves.
  let stage = null;

  function buildStage() {
    stage = document.createElement('div');
    stage.setAttribute('data-skp-stage', '');
    stage.style.cssText = 'position:absolute;left:0;top:0;overflow:hidden;transform-origin:0 0;' +
      'width:' + canvas.width + 'px;height:' + canvas.height + 'px';
    const body = document.body;
    for (const node of Array.from(body.childNodes)) {
      if (node.nodeName !== 'SCRIPT' && node.nodeName !== 'TEMPLATE') stage.appendChild(node);
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
  }

  function fit() {
    if (!stage) return;
    const s = Math.min(window.innerWidth / canvas.width, window.innerHeight / canvas.height) || 1;
    const x = Math.round((window.innerWidth - canvas.width * s) / 2);
    const y = Math.round((window.innerHeight - canvas.height * s) / 2);
    stage.style.transform = 'translate(' + x + 'px,' + y + 'px) scale(' + s + ')';
  }

  // ---- element lifecycle (05 §5.2) ----------------------------------------------------------
  // (absent) → enter → idle → exit → (removed), exposed as data-skp-state for CSS. Durations come
  // from opts.durationMs, then --skp-enter-ms / --skp-exit-ms, then the computed animation and
  // transition durations, then 0. Each step ends on a timer, never on animationend.
  const lives = new WeakMap(); // element → token of its latest lifecycle step

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
      const names = cs.animationName.split(',');
      const durations = msList(cs.animationDuration);
      const delays = msList(cs.animationDelay);
      const counts = String(cs.animationIterationCount).split(',');
      names.forEach((name, i) => {
        if (name.trim() === 'none') return;
        const count = parseFloat(counts[i % counts.length]);
        if (!isFinite(count)) return; // infinite loops (idle breathing) don't end an enter or exit
        longest = Math.max(longest, delays[i % delays.length] + durations[i % durations.length] * count);
      });
    }
    const tDur = msList(cs.transitionDuration);
    const tDelay = msList(cs.transitionDelay);
    tDur.forEach((d, i) => { longest = Math.max(longest, d + tDelay[i % tDelay.length]); });
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

  // opts: { durationMs, enter (exposed as data-skp-enter for CSS), parent, offsetMs, cut }
  function mount(el, opts) {
    opts = opts || {};
    if (opts.enter) el.setAttribute('data-skp-enter', opts.enter);
    if (!el.parentNode) (opts.parent || currentRootEl() || stage || document.body).appendChild(el);
    const token = {};
    lives.set(el, token);
    if (opts.cut) {
      el.setAttribute('data-skp-state', 'idle');
      return Promise.resolve(el);
    }
    el.setAttribute('data-skp-state', 'enter');
    const ms = durationOf(el, 'enter', opts);
    const late = Math.max(0, opts.offsetMs || 0);
    seek(el, late);
    return new Promise((resolve) => {
      setTimeout(() => {
        if (lives.get(el) === token && el.getAttribute('data-skp-state') === 'enter') el.setAttribute('data-skp-state', 'idle');
        resolve(el);
      }, Math.max(0, ms - late));
    });
  }

  // Sets exit, removes the element after its exit duration plus 50 ms, and resolves then.
  function unmount(el, opts) {
    opts = opts || {};
    if (!el || !el.parentNode) return Promise.resolve();
    if (opts.exit) el.setAttribute('data-skp-exit', opts.exit);
    const token = {};
    lives.set(el, token);
    if (opts.cut) {
      el.remove();
      return Promise.resolve();
    }
    el.setAttribute('data-skp-state', 'exit');
    const ms = durationOf(el, 'exit', opts);
    return new Promise((resolve) => {
      setTimeout(() => {
        if (lives.get(el) === token) el.remove();
        resolve();
      }, ms + 50);
    });
  }

  // The exit duration an element will have, measured before it exits: a template-declared
  // --skp-exit-ms, or a probe that flips data-skp-state to exit and back within one task (no frame
  // is drawn in between, so nothing visible happens).
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
  const sceneSubs = [];
  let current = null; // { id, root }
  let stinger = null;

  function collectSceneTemplates() {
    for (const tpl of document.querySelectorAll('template[data-skp-scene]')) {
      const id = tpl.getAttribute('data-skp-scene');
      if (!sceneBuilders.has(id)) sceneBuilders.set(id, () => tpl.content.cloneNode(true));
    }
  }

  function defaultScene() {
    const program = manifestScenes.find((s) => s.core === 'program');
    if (program) return program.id;
    if (manifestScenes.length) return manifestScenes[0].id;
    return sceneBuilders.size ? sceneBuilders.keys().next().value : null;
  }

  // A scene name from a show may be a scene id or a core scene name (04 §4.2): shows and buttons
  // work across templates through `core`.
  function resolveScene(name) {
    if (manifestScenes.some((s) => s.id === name) || sceneBuilders.has(name)) return name;
    const byCore = manifestScenes.find((s) => s.core === name);
    return byCore ? byCore.id : null;
  }

  function currentRootEl() {
    return current && current.root;
  }

  function showScene(name, transition) {
    const id = resolveScene(name);
    if (!id) {
      if (isReady) sendLog('warn', 'this template has no scene "' + name + '"; staying on ' + (current ? current.id : 'none'));
      return;
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
      const content = safely(build, [{ scene: id, settings: settings(), canvas }]);
      if (content && typeof content === 'object' && 'nodeType' in content) root.appendChild(content);
    }
    current = { id, root };
    html.setAttribute('data-skp-scene', id);
    if (prev) prev.root.setAttribute('data-skp-transition', transition);

    const sting = (meta.transitions || []).find((t) => t.id === transition && t.media);
    if (transition === 'cut' || !stage || !prev) {
      (stage || document.body).appendChild(root);
      mount(root, { cut: true });
      if (prev) unmount(prev.root, { cut: true });
    } else if (sting) {
      playStinger(sting, root, prev.root);
    } else {
      stage.appendChild(root);
      mount(root); // both overlap: a crossfade by default, styled entirely in CSS
      unmount(prev.root);
    }
    for (const fn of sceneSubs.slice()) safely(fn, [id, prev ? prev.id : undefined, transition, root]);
  }

  // A stinger plays over both scenes; the swap happens at cutAtMs (05 §5.4). The video is muted:
  // audio belongs in OBS.
  function playStinger(sting, root, oldRoot) {
    if (stinger) stinger.remove();
    const video = document.createElement('video');
    video.setAttribute('data-skp-stinger', sting.id);
    video.muted = true;
    video.playsInline = true;
    video.src = asset(sting.media);
    video.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;object-fit:cover;z-index:2147483647;pointer-events:none';
    stage.appendChild(video);
    stinger = video;
    const p = video.play();
    if (p && p.catch) p.catch(() => {});
    setTimeout(() => {
      stage.insertBefore(root, video);
      mount(root, { cut: true });
      unmount(oldRoot, { cut: true });
    }, Math.max(0, sting.cutAtMs || 0));
    // Remove the video when it ends, or by a deadline if 'ended' never fires (hidden source).
    const done = () => { if (stinger === video) stinger = null; video.remove(); };
    video.addEventListener('ended', done);
    setTimeout(done, Math.max(sting.cutAtMs || 0, 0) + (sting.durationMs || 4000) + 1000);
  }

  // ---- actions (04 §4.6) --------------------------------------------------------------------
  const actionHandlers = new Map();

  // A trigger runs at startAt on server time. One arriving late but inside its window runs at once
  // with lateMs, so animations can be offset to the same frame as on-time clients; one whose
  // window has passed is dropped (04 §4.6, 05 §5.3).
  function runTrigger(t) {
    const handler = actionHandlers.get(t.name);
    if (!handler) return;
    const startAt = typeof t.startAt === 'number' ? t.startAt : now();
    const durationMs = typeof t.durationMs === 'number' ? t.durationMs : 0;
    if (durationMs > 0 && now() >= startAt + durationMs) return;
    at(startAt, () => {
      const lateMs = Math.max(0, now() - startAt);
      if (durationMs > 0 && lateMs >= durationMs) return;
      handler({ args: clone(t.args) || {}, startAt, durationMs, lateMs });
    });
  }

  // ---- alerts (05 §5.5) ---------------------------------------------------------------------
  // The server queues alerts and gives each a display window; the runtime shows it from startAt,
  // starts its exit so it ends with the window, and cuts it on alerts.cut. Until the server queue
  // exists (plan step 19), an alert without a window gets one here, paced by the manifest.
  let alertRenderer = null;
  const activeAlerts = new Map(); // envelope id → { el, cancels: [] }
  let localQueueEnd = 0;
  let localActive = [];

  function alertDuration() {
    const s = settings();
    const fromSetting = alertSpec.durationSetting ? Number(s[alertSpec.durationSetting]) : NaN;
    const ms = isFinite(fromSetting) ? fromSetting : alertSpec.durationMs;
    return Math.min(60000, Math.max(1000, ms));
  }

  function localWindow() {
    const t = now();
    const duration = alertDuration();
    localActive = localActive.filter((end) => end > t);
    let startAt = t;
    if (alertSpec.mode === 'stack') {
      if (localActive.length >= alertSpec.maxConcurrent) startAt = Math.min.apply(null, localActive) + alertSpec.gapMs;
    } else {
      startAt = Math.max(t, localQueueEnd + alertSpec.gapMs);
    }
    localQueueEnd = startAt + duration;
    localActive.push(startAt + duration);
    return { startAt, durationMs: duration };
  }

  function alertContainer() {
    return (current && current.root.querySelector('[data-skp-alerts]')) ||
      (stage && stage.querySelector('[data-skp-alerts]')) || currentRootEl() || stage || document.body;
  }

  function queueAlert(env) {
    if (!alertRenderer) return;
    const data = env.data || {};
    const win = data.display && typeof data.display.startAt === 'number' ? data.display : localWindow();
    const end = win.startAt + win.durationMs;
    if (now() >= end) return; // its window has passed
    const entry = { el: null, cancels: [] };
    activeAlerts.set(env.id, entry);
    entry.cancels.push(at(win.startAt, () => showAlert(env, entry, win)));
  }

  function showAlert(env, entry, win) {
    if (!activeAlerts.has(env.id)) return;
    const el = document.createElement('div');
    el.setAttribute('data-skp-alert', env.data.kind || env.type.slice(6));
    entry.el = el;
    const container = alertContainer();
    let done = false;
    const go = () => {
      if (done || !activeAlerts.has(env.id)) return;
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
  // and removes it on deletion, ban or clear.
  const chatAdd = [];
  const chatRemove = [];
  const chatClear = [];
  const chatQueue = [];
  const chatEls = []; // [{ id, userId, el }] oldest first
  let chatTimer = null;
  let chatStarted = false;

  function chatContainer() {
    return (current && current.root.querySelector('[data-skp-chat]')) ||
      (stage && stage.querySelector('[data-skp-chat]')) || null;
  }

  function startChat() {
    chatStarted = true;
    if (!chatAdd.length) return;
    for (const m of chatRecent.slice(-chatMax)) addChatMessage(m, true);
  }

  function addChatMessage(m, initial) {
    for (const fn of chatAdd.slice()) {
      const el = safely(fn, [clone(m), { initial: !!initial }]);
      if (el && typeof el === 'object' && 'nodeType' in el) {
        const box = chatContainer();
        if (!el.parentNode && box) box.appendChild(el);
        mount(el, initial ? { cut: true } : undefined);
        chatEls.push({ id: m.id, userId: m.user && m.user.id, el });
        while (chatEls.length > chatMax) unmount(chatEls.shift().el);
      }
    }
  }

  function pumpChat() {
    chatTimer = null;
    for (const m of chatQueue.splice(0, timing.chatPerFrame)) addChatMessage(m, false);
    if (chatQueue.length) chatTimer = setTimeout(pumpChat, timing.chatFrameMs);
  }

  function removeChat(test) {
    for (let i = chatQueue.length - 1; i >= 0; i--) if (test(chatQueue[i].id, chatQueue[i].user && chatQueue[i].user.id)) chatQueue.splice(i, 1);
    for (let i = chatEls.length - 1; i >= 0; i--) {
      const item = chatEls[i];
      if (test(item.id, item.userId)) {
        chatEls.splice(i, 1);
        unmount(item.el);
      }
    }
  }

  function chatEvent(env) {
    const d = env.data || {};
    if (env.type === 'chat.message') {
      chatRecent.push(d);
      if (chatRecent.length > 200) chatRecent = chatRecent.slice(-200);
      if (!chatStarted || !chatAdd.length) return;
      chatQueue.push(d);
      // More than about two seconds of backlog (32 at 4 per 250 ms, or chat.max if larger): skip
      // the oldest, so a flooded chat stays live instead of drawing messages seconds late.
      const backlog = Math.max(chatMax, (2000 / timing.chatFrameMs) * timing.chatPerFrame);
      if (chatQueue.length > backlog) chatQueue.splice(0, chatQueue.length - backlog);
      if (!chatTimer) chatTimer = setTimeout(pumpChat, 0);
    } else if (env.type === 'chat.message.deleted') {
      chatRecent = chatRecent.filter((m) => m.id !== d.messageId);
      removeChat((id) => id === d.messageId);
      for (const fn of chatRemove.slice()) safely(fn, [d.messageId]);
    } else if (env.type === 'chat.user.cleared') {
      const gone = chatRecent.filter((m) => m.user && m.user.id === d.userId).map((m) => m.id);
      chatRecent = chatRecent.filter((m) => !(m.user && m.user.id === d.userId));
      removeChat((id, userId) => userId === d.userId);
      for (const id of gone) for (const fn of chatRemove.slice()) safely(fn, [id]);
    } else if (env.type === 'chat.cleared') {
      chatRecent = [];
      chatQueue.length = 0;
      for (const item of chatEls.splice(0)) unmount(item.el); // everything exits at once
      for (const fn of chatClear.slice()) safely(fn, []);
    }
  }

  // ---- music (02 §2.5.1) --------------------------------------------------------------------
  function track() {
    return clone(state.get('music.nowPlaying'));
  }

  // progressMs was true at progressAt (server time); interpolate locally, never poll.
  function progress() {
    const t = state.get('music.nowPlaying');
    if (!t || typeof t.progressMs !== 'number') return undefined;
    if (!t.playing || typeof t.progressAt !== 'number') return t.progressMs;
    const p = t.progressMs + (now() - t.progressAt);
    return typeof t.durationMs === 'number' ? Math.min(t.durationMs, p) : p;
  }

  // ---- settings -----------------------------------------------------------------------------
  // overlay.settings, with ?settings=<base64> (unsaved edits in the admin UI) laid over it.
  const settingsSubs = [];
  let lastSettingsJson = null;

  function settings() {
    const s = Object.assign({}, state.get('overlay.settings') || {}, override.settings || {});
    return Object.freeze(clone(s));
  }

  function notifySettings() {
    const s = settings();
    const json = JSON.stringify(s);
    if (json === lastSettingsJson) return;
    lastSettingsJson = json;
    for (const fn of settingsSubs.slice()) safely(fn, [s]);
  }

  // ---- assets -------------------------------------------------------------------------------
  // A versioned, cacheable URL for a file in the template package (04 §4.5).
  function asset(path) {
    return base + '/t/' + meta.build + '/' + String(path).replace(/^(\.\/|\/)+/, '');
  }

  // ---- log ----------------------------------------------------------------------------------
  // SK.log goes to the platform's template log, batched; the server rate-limits per overlay.
  const logQueue = [];
  let logTimer = null;
  let lastError = '';

  function sendLog(level, msg, context) {
    if (level === 'error' || level === 'warn') (console[level] || console.log).call(console, '[skp] ' + msg);
    logQueue.push({ level, msg: String(msg).slice(0, 500), context });
    if (logQueue.length > 50) logQueue.splice(0, logQueue.length - 50);
    if (!logTimer && !override.mock) logTimer = setTimeout(flushLog, 1000);
  }

  function flushLog() {
    logTimer = null;
    const entries = logQueue.splice(0, 20);
    if (!entries.length) return;
    // A string body is a CORS-simple request: no preflight from the sandboxed preview.
    fetch(base + '/log?v=1' + keyParam, { method: 'POST', body: JSON.stringify({ entries }) }).catch(() => {});
    if (logQueue.length) logTimer = setTimeout(flushLog, 1000);
  }

  function reportError(what, err) {
    const text = (err && (err.stack || err.message)) || String(err);
    lastError = what + ': ' + text;
    sendLog('error', what, { error: String(text).slice(0, 1000) });
  }

  window.addEventListener('error', (ev) => {
    if (ev.target && ev.target !== window) return; // resource load failures are in the server log
    reportError('uncaught error', ev.error || ev.message);
  });
  window.addEventListener('unhandledrejection', (ev) => reportError('unhandled rejection', ev.reason));

  // ---- debug HUD (?debug=1) -----------------------------------------------------------------
  function startHud() {
    const hud = document.createElement('div');
    hud.setAttribute('data-skp-debug', '');
    hud.style.cssText = 'position:fixed;left:8px;top:8px;z-index:2147483647;padding:8px 12px;white-space:pre;' +
      'font:13px/1.5 ui-monospace,Consolas,monospace;color:#16e0ff;background:rgba(0,0,0,.85);border:1px solid #16e0ff;pointer-events:none';
    document.body.appendChild(hud);
    setInterval(() => {
      hud.textContent = 'SKP · ' + meta.slug + ' · ' + canvas.id + ' ' + canvas.width + 'x' + canvas.height + '\n' +
        'scene ' + (current ? current.id : '—') + ' · transport ' + transport.mode + ' · ' + transport.received + ' received\n' +
        'skew ' + Math.round(skew) + ' ms · viewport ' + window.innerWidth + 'x' + window.innerHeight + '\n' +
        (lastError ? 'ERR ' + lastError.slice(0, 200) : 'no errors');
    }, 250);
  }

  // ---- connection (01 §1.5, 01 §1.7) --------------------------------------------------------
  // 1. Fetch the snapshot and render. 2. Stream everything after its cursor (Server-Sent Events
  // read with fetch: EventSource only delivers named events to per-name listeners, and hides the
  // status). 3. A stream that errors, ends, or hasn't opened within 5 s has failed; two failures in
  // 30 s switch to polling every 700 ms (1500 ms in lite mode), with the stream retried every 60 s.
  // 429: this browser already holds as many streams as the server allows, poll right away.
  // 410: the cursor is too old, fetch the snapshot again. While the server is unreachable the last
  // good state stays on screen.
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
      if (transport.mode === 'poll') pollTimer = setTimeout(tick, env.lite ? timing.pollLiteMs : timing.pollMs);
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
      for (const e of body.envelopes) apply(e);
    } catch (err) { /* unreachable: keep the last good state on screen (01 §1.7) */ }
  }

  // ---- mock (?mock=1, 08 §8.5) --------------------------------------------------------------
  // Sample data instead of the server: /sdk/v1/mock.js feeds a snapshot and envelopes through this
  // hook. Kept in its own file so this one stays small.
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
    const s = document.createElement('script');
    s.src = '/sdk/v1/mock.js';
    s.onerror = () => reportError('mock data failed to load', new Error('/sdk/v1/mock.js'));
    document.head.appendChild(s);
  }

  // ---- the API (04 §4.4) --------------------------------------------------------------------
  const SK = {
    meta: Object.freeze(meta),
    env,
    canvas: Object.freeze({ id: canvas.id, width: canvas.width, height: canvas.height }),

    ready(fn) {
      if (isReady) setTimeout(() => safely(fn, []), 0);
      else readyFns.push(fn);
    },

    get settings() { return settings(); },
    onSettings(fn) { settingsSubs.push(fn); },

    state(key) { return clone(state.get(key)); },

    // onState('viewers.total', (value, prev) => …) or onState('show.*', (key, value, prev) => …).
    // Fires once with the current value when the template is ready (04 §4.4).
    onState(pattern, fn) {
      const sub = { test: matcher(pattern), wildcard: pattern.slice(-2) === '.*', fn };
      stateSubs.push(sub);
      SK.ready(() => {
        for (const [key, value] of state) {
          if (!sub.test(key)) continue;
          if (sub.wildcard) safely(fn, [key, clone(value), undefined]);
          else safely(fn, [clone(value), undefined]);
        }
        if (!sub.wildcard && !state.has(pattern)) safely(fn, [undefined, undefined]);
      });
    },

    // on('alert.*', envelope => …): only types the template declared reach the overlay (04 §4.2).
    on(pattern, fn) { eventSubs.push({ test: matcher(pattern), fn }); },

    get scene() { return current ? current.id : undefined; },
    onScene(fn) { sceneSubs.push(fn); },
    defineScene(id, build) { sceneBuilders.set(id, build); },

    action(name, fn) {
      if (meta.actions && !meta.actions.some((a) => a.id === name)) sendLog('warn', 'action "' + name + '" is not declared in template.json');
      actionHandlers.set(name, fn);
    },

    chat: Object.freeze({
      recent() { return clone(chatRecent); },
      onAdd(fn) { chatAdd.push(fn); },
      onRemove(fn) { chatRemove.push(fn); },
      onClear(fn) { chatClear.push(fn); },
    }),

    music: Object.freeze({ track, progress }),

    alerts: Object.freeze({
      render(fn) { alertRenderer = fn; },
    }),

    mount,
    unmount,

    clock: Object.freeze({ now, at }),

    asset,

    log: Object.freeze({
      info: (msg, context) => sendLog('info', msg, context),
      warn: (msg, context) => sendLog('warn', msg, context),
      error: (msg, context) => sendLog('error', msg, context),
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

  // ---- start --------------------------------------------------------------------------------
  function onDom() {
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
    (async () => {
      await loadSnapshot();
      streamLoop();
    })();
  }
})();
