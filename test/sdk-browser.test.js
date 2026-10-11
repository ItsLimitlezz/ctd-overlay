// The runtime SDK in a real browser, driving the testbed fixture template
// (test/fixtures/templates/testbed). One headless Chrome/Edge is shared by the file.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { browserSkip, launchBrowser } from './cdp.js';
import { TESTBED, defer, startWithOverlay } from './helpers.js';

let browser;
before(async () => { if (!browserSkip) browser = await launchBrowser(); });
after(async () => { if (browser) await browser.close(); });

// A platform with a testbed overlay, and the page open in the browser and ready.
async function open(t, { query = '', width = 1920, height = 1080, settings } = {}) {
  const ctx = await startWithOverlay(t, { slug: 'bed', template: TESTBED, settings });
  const page = await browser.open(ctx.base + query, { width, height });
  defer(t, () => page.close().catch(() => {}));
  await page.waitFor('window.__log && window.__log.some((e) => e.what === "ready")', 10000);
  const channel = ctx.platform.bus.channel(ctx.overlay.id);
  const logOf = (what) => page.eval(`window.__log.filter((e) => e.what === ${JSON.stringify(what)})`);
  return { ...ctx, page, channel, logOf };
}

const opts = { skip: browserSkip };

// The page's problems, less the one the testbed causes on purpose: its "broken" stinger's file
// isn't a video, and the runtime reports that once per page.
const problems = (page) => page.problems.filter((p) => !/\[skp\] failed to load \/o\/[^/]+\/t\/[0-9a-f]+\/template\.css$/.test(p));

describe('stage and page (04 §4.5)', () => {
  test('the stage is the canvas size, scaled to fit and centred', opts, async (t) => {
    const { page, base } = await open(t, { width: 960, height: 540 });
    const box = (sel) => `(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return [r.x, r.y, r.width, r.height].map(Math.round); })()`;
    assert.deepEqual(await page.eval(box('[data-skp-stage]')), [0, 0, 960, 540]);
    await page.resize(1920, 1080);
    await page.waitFor(`${box('[data-skp-stage]')}[2] === 1920`);
    // A vertical canvas in a landscape viewport: pillarboxed in the middle.
    await page.goto(`${base}?canvas=v`);
    await page.waitFor('window.__log && window.__log.some((e) => e.what === "ready")');
    assert.deepEqual(await page.eval(box('[data-skp-stage]')), [656, 0, 608, 1080]);
    assert.equal(await page.eval('document.documentElement.getAttribute("data-skp-canvas")'), 'v');
    assert.deepEqual(problems(page), []);
  });

  test('template content outside scenes moves into the stage; the page stays transparent', opts, async (t) => {
    const { page } = await open(t);
    assert.equal(await page.eval('!!document.querySelector("[data-skp-stage] [data-static]")'), true);
    assert.equal(await page.eval('getComputedStyle(document.documentElement).backgroundColor'), 'rgba(0, 0, 0, 0)');
    assert.equal(await page.eval('getComputedStyle(document.body).backgroundColor'), 'rgba(0, 0, 0, 0)');
  });

  test('?bg=dark, ?lite=1 and ?debug=1 do what 04 §4.9 says', opts, async (t) => {
    const { page } = await open(t, { query: '?bg=dark&lite=1&debug=1' });
    assert.equal(await page.eval('getComputedStyle(document.documentElement).backgroundColor'), 'rgb(8, 7, 10)');
    assert.equal(await page.eval('document.documentElement.hasAttribute("data-skp-lite") && SK.env.lite'), true);
    assert.equal(await page.eval('SK.env.preview'), true); // any override means a preview, never OBS
    await page.waitFor('(document.querySelector("[data-skp-debug]") || {}).textContent?.includes("scene program")');
  });

  test('the boot badge is gone once the runtime runs', opts, async (t) => {
    const { page } = await open(t);
    assert.equal(await page.eval('!!document.querySelector("[data-skp-boot]")'), false);
  });

  test('the boot badge says so when the runtime never starts', { ...opts, timeout: 30000 }, async (t) => {
    const { page, base } = await open(t);
    await page.send('Network.enable');
    await page.send('Network.setBlockedURLs', { urls: ['*/sdk/v1/sk.js*'] });
    await page.goto(base);
    assert.equal(await page.eval('typeof window.SK'), 'undefined');
    await page.waitFor('getComputedStyle(document.querySelector("[data-skp-boot]")).opacity === "1"', 12000);
  });

  test('a second copy of sk.js in the page changes nothing', opts, async (t) => {
    const { page } = await open(t);
    await page.waitFor('SK.transport.mode === "stream" && SK.transport.streamsOpened >= 1');
    const before = await page.eval('SK.transport.streamsOpened');
    await page.eval(`new Promise((resolve) => {
      const s = document.createElement('script'); s.src = '/sdk/v1/sk.js'; s.onload = resolve; document.head.appendChild(s);
    })`);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(await page.eval('SK.transport.streamsOpened'), before);
    assert.equal(await page.eval('document.querySelectorAll("[data-skp-stage]").length'), 1);
    assert.deepEqual(problems(page), []);
  });
});

describe('scenes (04 §4.7, 05 §5.4)', () => {
  test('the first scene is the core "program" scene, mounted without animation', opts, async (t) => {
    const { page, logOf } = await open(t);
    assert.equal(await page.eval('SK.scene'), 'program');
    assert.equal(await page.eval('document.documentElement.getAttribute("data-skp-scene")'), 'program');
    assert.equal(await page.eval('document.querySelector("[data-skp-scene-root=program]").getAttribute("data-skp-state")'), 'idle');
    const [scene] = await logOf('scene');
    assert.deepEqual({ ...scene, at: 0 }, { what: 'scene', scene: 'program', prev: null, transition: 'cut', root: true, at: 0 });
  });

  test('a scene change crossfades: both roots overlap, the old one goes after its exit', opts, async (t) => {
    const { page, channel, platform, overlay } = await open(t);
    platform.bus.publish('show.scene.changed', { scene: 'brb', prev: 'program', transition: 'fade' }, { target: overlay.id });
    channel.setLocalState('show.scene', 'brb');
    await page.waitFor('document.querySelectorAll("[data-skp-scene-root]").length === 2');
    const states = await page.eval('[...document.querySelectorAll("[data-skp-scene-root]")].map((r) => r.dataset.skpSceneRoot + ":" + r.dataset.skpState + ":" + r.dataset.skpTransition)');
    assert.deepEqual(states, ['program:exit:fade', 'brb:enter:fade']);
    await page.waitFor('document.querySelectorAll("[data-skp-scene-root]").length === 1', 2000);
    await page.waitFor('document.querySelector("[data-skp-scene-root=brb]").dataset.skpState === "idle"', 2000);
    assert.equal(await page.eval('SK.scene'), 'brb');
  });

  test('"cut" swaps at once; a burst of takes converges on the last', opts, async (t) => {
    const { page, platform, overlay, logOf } = await open(t);
    platform.bus.publish('show.scene.changed', { scene: 'outro', transition: 'cut' }, { target: overlay.id });
    await page.waitFor('SK.scene === "outro"');
    assert.equal(await page.eval('document.querySelectorAll("[data-skp-scene-root]").length'), 1);
    assert.equal(await page.eval('document.querySelector("[data-skp-scene-root=outro]").dataset.skpState'), 'idle');
    platform.bus.publish('show.scene.changed', { scene: 'brb', transition: 'cut' }, { target: overlay.id });
    platform.bus.publish('show.scene.changed', { scene: 'lineup', transition: 'cut' }, { target: overlay.id });
    await page.waitFor('SK.scene === "lineup"');
    assert.match(await page.eval('document.querySelector("[data-skp-scene-root=lineup]").textContent'), /Lineup for h/);
    assert.deepEqual((await logOf('scene')).map((s) => s.scene), ['program', 'outro', 'lineup']);
  });

  test('core scene names map to the template\'s scenes; an unknown name keeps the current scene', opts, async (t) => {
    const { page, platform, overlay, logOf } = await open(t);
    platform.bus.publish('show.scene.changed', { scene: 'intro', transition: 'cut' }, { target: overlay.id });
    await page.waitFor('SK.scene === "opener"'); // { "id": "opener", "core": "intro" }
    platform.bus.publish('show.scene.changed', { scene: 'pov', transition: 'cut' }, { target: overlay.id });
    platform.bus.publish('custom.sentinel', {}, { target: overlay.id });
    await page.waitFor('window.__log.some((e) => e.type === "custom.sentinel")');
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(await page.eval('SK.scene'), 'opener');
    assert.deepEqual((await logOf('scene')).map((s) => s.scene), ['program', 'opener']);
  });

  test('the operator\'s transition wins over the show.scene state that echoes the take, in either order', opts, async (t) => {
    const { page, channel, platform, overlay, logOf } = await open(t);
    const order = [];
    defer(t, channel.subscribe((env) => {
      if (env.type === 'show.scene.changed') order.push(`event:${env.data.scene}`);
      if (env.type === 'state.changed' && env.data.key === 'show.scene') order.push(`state:${env.data.value}`);
    }));
    // Event, then state, in one tick (as a take publishes them).
    platform.bus.publish('show.scene.changed', { scene: 'outro', transition: 'cut' }, { target: overlay.id });
    channel.setLocalState('show.scene', 'outro');
    await page.waitFor('SK.scene === "outro"');
    // State first, then the event a moment later (but within the settle wait). The state's
    // coalescing window (100 ms per key) has to pass first, or the bus holds it back.
    await new Promise((r) => setTimeout(r, 150));
    channel.setLocalState('show.scene', 'brb');
    await new Promise((r) => setTimeout(r, 15));
    platform.bus.publish('show.scene.changed', { scene: 'brb', transition: 'cut' }, { target: overlay.id });
    await page.waitFor('SK.scene === "brb"');
    assert.deepEqual(order, ['event:outro', 'state:outro', 'state:brb', 'event:brb']);
    assert.deepEqual((await logOf('scene')).slice(1).map((s) => `${s.scene}:${s.transition}`), ['outro:cut', 'brb:cut']);
    assert.equal(await page.eval('document.querySelectorAll("[data-skp-scene-root]").length'), 1);
  });

  test('a scene defined after it was mounted (inside SK.ready) is rebuilt in place', opts, async (t) => {
    const { page } = await open(t);
    await page.eval(`SK.defineScene('program', (ctx) => {
      const d = document.createElement('div'); d.className = 'rebuilt'; d.textContent = ctx.scene; return d;
    }); true`);
    await page.waitFor('!!document.querySelector("[data-skp-scene-root=program] .rebuilt")');
    assert.equal(await page.eval('document.querySelectorAll("[data-skp-scene-root]").length'), 1);
    assert.equal(await page.eval('SK.scene'), 'program');
  });

  test('?scene= pins a scene for previews, whatever the show does', opts, async (t) => {
    const { page, channel } = await open(t, { query: '?scene=brb' });
    assert.equal(await page.eval('SK.scene'), 'brb');
    channel.setLocalState('show.scene', 'outro');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(await page.eval('SK.scene'), 'brb');
  });

  const rootsOf = 'Array.from(document.querySelectorAll("[data-skp-scene-root]")).map((r) => r.dataset.skpSceneRoot)';

  test('a stinger, loaded ahead, covers the swap, which happens at cutAtMs on the video\'s clock, then leaves', opts, async (t) => {
    const { page, platform, overlay } = await open(t);
    // The video starts 400 ms late (a busy machine): a cut on the wall clock would show at 200 ms,
    // before the stinger covers anything.
    await page.eval(`(() => {
      const play = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function () { setTimeout(() => play.call(this), 400); return Promise.resolve(); };
      const seen = window.__stinger = {};
      new MutationObserver((records) => {
        for (const m of records) for (const n of m.addedNodes) {
          if (n.nodeName === 'VIDEO') { seen.video = n; seen.readyState = n.readyState; }
          if (n.nodeType === 1 && n.dataset.skpSceneRoot === 'brb') seen.cutAt = seen.video ? seen.video.currentTime : -1;
        }
      }).observe(document.querySelector('[data-skp-stage]'), { childList: true });
      return true;
    })()`);
    platform.bus.publish('show.scene.changed', { scene: 'brb', transition: 'stinger' }, { target: overlay.id });
    await page.waitFor('window.__stinger.cutAt !== undefined', 3000);
    const seen = await page.eval('({ cutAt: window.__stinger.cutAt, readyState: window.__stinger.readyState })');
    assert.ok(seen.readyState >= 2, `the video had readyState ${seen.readyState} when it was shown (not loaded ahead)`);
    assert.ok(seen.cutAt >= 0.18, `cut at ${seen.cutAt} s into the stinger`);
    assert.deepEqual(await page.eval(rootsOf), ['brb']);
    await page.waitFor('!document.querySelector("video[data-skp-stinger]")', 4000); // removed when it ends
    assert.deepEqual(problems(page), []);
  });

  test('a stinger whose file fails still cuts on schedule, and the failure is logged', opts, async (t) => {
    const { page, platform, overlay, entries } = await open(t);
    const t0 = Date.now();
    platform.bus.publish('show.scene.changed', { scene: 'brb', transition: 'broken' }, { target: overlay.id });
    await page.waitFor(`JSON.stringify(${rootsOf}) === '["brb"]'`, 2000);
    assert.ok(Date.now() - t0 < 900, `cut after ${Date.now() - t0} ms`);
    await page.waitFor('!document.querySelector("video[data-skp-stinger]")', 2000);
    const deadline = Date.now() + 3000;
    const failed = () => entries.some((e) => e.component === 'template' && /failed to load .*template\.css/.test(e.msg));
    while (!failed() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    assert.ok(failed(), 'a "failed to load" entry in the template log');
  });

  test('a re-sync with no show.scene keeps the scene on screen', opts, async (t) => {
    const { page, platform, overlay } = await open(t);
    platform.bus.publish('show.scene.changed', { scene: 'brb', transition: 'cut' }, { target: overlay.id });
    await page.waitFor('SK.scene === "brb"');
    const consumes = platform.templates.get(TESTBED.id, TESTBED.version).manifest.consumes;
    platform.bus.removeChannel(overlay.id); // a 410 re-sync on the next connect
    platform.bus.publish('custom.filler', {});
    platform.bus.channel(overlay.id, { consumes });
    platform.bus.setState('custom.after', 1);
    await page.waitFor('SK.state("custom.after") === 1', 4000);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(await page.eval('SK.scene'), 'brb');
  });

  test('a take during a stinger\'s pre-cut window leaves exactly one scene on stage', opts, async (t) => {
    const { page, platform, overlay } = await open(t);
    const take = (scene, transition) => platform.bus.publish('show.scene.changed', { scene, transition }, { target: overlay.id });
    take('brb', 'stinger');
    await page.waitFor('!!document.querySelector("video[data-skp-stinger]")');
    take('starting', 'cut'); // an operator correcting a misclick
    await page.waitFor('SK.scene === "starting"');
    await new Promise((r) => setTimeout(r, 1500)); // past every timer the stinger armed
    assert.deepEqual(await page.eval(rootsOf), ['starting']);
    take('brb', 'stinger');
    await page.waitFor('SK.scene === "brb"');
    take('outro', 'stinger'); // a stinger over a stinger
    await page.waitFor('SK.scene === "outro"');
    await new Promise((r) => setTimeout(r, 1500));
    assert.deepEqual(await page.eval(rootsOf), ['outro']);
    assert.deepEqual(problems(page), []);
  });
});

describe('element lifecycle (05 §5.2)', () => {
  const measure = (cls, opt = '{}') => `(async () => {
    const el = document.createElement('div'); el.className = ${JSON.stringify(cls)};
    const t0 = performance.now();
    await SK.mount(el, ${opt});
    const entered = performance.now() - t0, state = el.dataset.skpState;
    const t1 = performance.now();
    await SK.unmount(el);
    return { entered: Math.round(entered), state, exited: Math.round(performance.now() - t1), removed: !el.isConnected };
  })()`;

  test('durations come from the CSS animation; idle loops do not count', opts, async (t) => {
    const { page } = await open(t);
    const msg = await page.eval(measure('msg'));
    assert.equal(msg.state, 'idle');
    assert.ok(msg.entered >= 190 && msg.entered < 450, `enter took ${msg.entered} ms`);
    assert.ok(msg.exited >= 240 && msg.exited < 500, `exit took ${msg.exited} ms (200 + 50 deadline)`);
    assert.equal(msg.removed, true);
    const breathing = await page.eval(measure('breathing'));
    assert.ok(breathing.entered >= 140 && breathing.entered < 400, `enter took ${breathing.entered} ms`);
  });

  // Every step ends on its duration plus the 50 ms deadline (05 §5.2).
  test('opts.durationMs beats --skp-enter-ms, which beats CSS; transitions count too', opts, async (t) => {
    const { page } = await open(t);
    // .custom msg: --skp-enter-ms 75 and --skp-exit-ms 25 over a 200 ms CSS animation.
    const custom = await page.eval(measure('custom msg'));
    assert.ok(custom.entered >= 115 && custom.entered < 200, `custom enter took ${custom.entered} ms (75 + 50, CSS would be 250)`);
    assert.ok(custom.exited >= 70 && custom.exited < 150, `custom exit took ${custom.exited} ms (25 + 50, CSS would be 250)`);
    const forced = await page.eval(measure('custom msg', '{ durationMs: 300 }'));
    assert.ok(forced.entered >= 340 && forced.entered < 500, `durationMs 300 entered in ${forced.entered} ms`);
    const zero = await page.eval(measure('msg', '{ durationMs: 0 }'));
    assert.ok(zero.entered < 100, `durationMs 0 entered in ${zero.entered} ms`);
    const transitioned = await page.eval(measure('transitioned'));
    assert.ok(transitioned.entered >= 190, `transition-based enter took ${transitioned.entered} ms (120 + 30 + 50)`);
  });

  test('a child animation that runs regardless of state (a countdown bar) stretches no step', opts, async (t) => {
    const { page } = await open(t);
    const r = await page.eval(`(async () => {
      const el = document.createElement('div'); el.className = 'msg';
      const bar = document.createElement('div'); bar.className = 'countdown'; el.appendChild(bar);
      const t0 = performance.now();
      await SK.mount(el);
      const entered = performance.now() - t0, t1 = performance.now();
      await SK.unmount(el);
      return { entered: Math.round(entered), exited: Math.round(performance.now() - t1) };
    })()`);
    assert.ok(r.entered < 450, `enter took ${r.entered} ms (200 + 50, not the bar's 5 s)`);
    assert.ok(r.exited < 500, `exit took ${r.exited} ms`);
  });

  test('animations the state change starts on children count toward the duration', opts, async (t) => {
    const { page } = await open(t);
    const r = await page.eval(`(async () => {
      const el = document.createElement('div');
      const card = document.createElement('div'); card.className = 'msg'; el.appendChild(card);
      const style = document.createElement('style');
      style.textContent = '[data-skp-state="exit"] > .msg { animation: fadeOut 300ms linear both; }';
      document.head.appendChild(style);
      await SK.mount(el);
      const t1 = performance.now();
      await SK.unmount(el);
      return Math.round(performance.now() - t1);
    })()`);
    assert.ok(r >= 330, `exit took ${r} ms (a child's 300 ms + 50)`);
  });

  test('a hidden element still finishes on time: no animationend needed (H9)', opts, async (t) => {
    const { page } = await open(t);
    const r = await page.eval(`(async () => {
      const el = document.createElement('div'); el.className = 'msg'; el.style.display = 'none';
      await SK.mount(el);
      const t1 = performance.now();
      await SK.unmount(el);
      return { exited: Math.round(performance.now() - t1), removed: !el.isConnected };
    })()`);
    assert.equal(r.removed, true);
    assert.ok(r.exited < 500, `exit took ${r.exited} ms`);
  });

  test('a newer mount wins over an older unmount of the same element', opts, async (t) => {
    const { page } = await open(t);
    const kept = await page.eval(`(async () => {
      const el = document.createElement('div'); el.className = 'msg';
      await SK.mount(el);
      const gone = SK.unmount(el);
      await SK.mount(el);
      await gone;
      return el.isConnected && el.dataset.skpState;
    })()`);
    assert.equal(kept, 'idle');
  });
});

describe('actions (04 §4.6, 05 §5.3)', () => {
  test('a trigger runs at startAt on server time, not on receipt', opts, async (t) => {
    const { page, platform, overlay, logOf } = await open(t);
    const startAt = Date.now() + 600;
    platform.bus.publish('show.trigger', { name: 'titleCard', args: { name: 'BIA' }, startAt, durationMs: 3000 }, { target: overlay.id });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal((await logOf('titleCard')).length, 0);
    await page.waitFor('window.__log.some((e) => e.what === "titleCard")', 3000);
    const [call] = await logOf('titleCard');
    assert.deepEqual(call.args, { name: 'BIA' });
    assert.ok(call.at >= startAt - 50, `ran ${startAt - call.at} ms early`);
    assert.ok(call.lateMs < 400);
    await page.waitFor('document.querySelector(".title")?.textContent === "BIA"');
  });

  test('a late trigger runs at once with lateMs; one whose window passed is dropped', opts, async (t) => {
    const { page, platform, overlay, logOf } = await open(t);
    platform.bus.publish('show.trigger', { name: 'titleCard', args: { name: 'stale' }, startAt: Date.now() - 5000, durationMs: 3000 }, { target: overlay.id });
    platform.bus.publish('show.trigger', { name: 'titleCard', args: { name: 'late' }, startAt: Date.now() - 1000, durationMs: 3000 }, { target: overlay.id });
    await page.waitFor('window.__log.some((e) => e.what === "titleCard")', 3000);
    await new Promise((r) => setTimeout(r, 300));
    const calls = await logOf('titleCard');
    assert.deepEqual(calls.map((c) => c.args.name), ['late']);
    assert.ok(calls[0].lateMs >= 900 && calls[0].lateMs < 2500, `lateMs ${calls[0].lateMs}`);
  });

  test('a handler registered after its trigger arrived still runs at startAt', opts, async (t) => {
    const { page, platform, overlay } = await open(t);
    const startAt = Date.now() + 500;
    platform.bus.publish('show.trigger', { name: 'titleCard', args: {}, startAt, durationMs: 2000 }, { target: overlay.id });
    await new Promise((r) => setTimeout(r, 150));
    await page.eval('SK.action("titleCard", () => window.__log.push({ what: "second-handler", at: SK.clock.now() })); true');
    const call = await page.waitFor('window.__log.find((e) => e.what === "second-handler")', 3000);
    assert.ok(call.at >= startAt - 50, `ran ${startAt - call.at} ms early`);
  });

  test('triggers for actions the template has no handler for are ignored', opts, async (t) => {
    const { page, platform, overlay } = await open(t);
    platform.bus.publish('show.trigger', { name: 'nowPlaying', startAt: Date.now(), durationMs: 1000 }, { target: overlay.id });
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(problems(page), []);
  });
});

describe('alerts (05 §5.5)', () => {
  const follow = (name, extra = {}) => ({ kind: 'follow', user: { name }, ...extra });

  // Records, in server time, when an alert element is added, starts its exit and is removed.
  const watchAlerts = `(() => {
    const times = window.__alertTimes = {};
    const isAlert = (n) => n.nodeType === 1 && n.hasAttribute('data-skp-alert');
    new MutationObserver((records) => {
      for (const m of records) {
        for (const n of m.addedNodes) if (isAlert(n) && !times.added) times.added = SK.clock.now();
        for (const n of m.removedNodes) if (isAlert(n) && !times.removed) times.removed = SK.clock.now();
        if (m.type === 'attributes' && isAlert(m.target) && m.target.dataset.skpState === 'exit' && !times.exit) times.exit = SK.clock.now();
      }
    }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-skp-state'] });
    return true;
  })()`;

  test('an alert shows from startAt, starts its exit so it ends with the window, and is gone then', opts, async (t) => {
    const { page, platform, overlay } = await open(t);
    await page.eval(watchAlerts);
    const startAt = Date.now() + 300;
    platform.bus.publish('alert.follow', follow('Trapment', { display: { startAt, durationMs: 1000 } }), { target: overlay.id });
    await page.waitFor('!!document.querySelector("[data-skp-alerts] [data-skp-alert=follow]")', 2000);
    assert.equal(await page.eval('document.querySelector("[data-skp-alert]").textContent'), 'Trapment follow');
    const times = await page.waitFor('window.__alertTimes.removed && window.__alertTimes', 3000);
    // --skp-exit-ms is 200: exit at startAt + 800, removed 50 ms after it ends.
    assert.ok(times.added >= startAt - 50 && times.added < startAt + 150, `added at ${times.added - startAt}`);
    assert.ok(times.exit >= startAt + 750 && times.exit < startAt + 950, `exit at ${times.exit - startAt}`);
    assert.ok(times.removed >= startAt + 1000 && times.removed < startAt + 1400, `removed at ${times.removed - startAt}`);
  });

  test('an alert with a countdown bar stays for its whole window', opts, async (t) => {
    const { page, platform, overlay } = await open(t);
    await page.eval(watchAlerts);
    const startAt = Date.now() + 200;
    platform.bus.publish('alert.follow', follow('Barred', { bar: true, probe: true, display: { startAt, durationMs: 1500 } }), { target: overlay.id });
    const times = await page.waitFor('window.__alertTimes.removed && window.__alertTimes', 4000);
    // The probed exit is the 300 ms animation, not the bar's 5 s: exit at 1200, removed at 1550.
    assert.ok(times.exit >= startAt + 1150, `exit at ${times.exit - startAt}`);
    assert.ok(times.removed >= startAt + 1450 && times.removed < startAt + 1900, `removed at ${times.removed - startAt}`);
  });

  test('a late alert lands on the same frame as on-time ones, even when its exit is probed from CSS', opts, async (t) => {
    const { page, platform, overlay } = await open(t);
    platform.bus.publish('alert.follow', follow('Late', { probe: true, display: { startAt: Date.now() - 500, durationMs: 3000 } }), { target: overlay.id });
    await page.waitFor('!!document.querySelector("[data-skp-alert].probe")', 2000);
    // The 1000 ms enter was sought forward by the lateness, and no probe restarted it.
    const at = await page.eval('Math.round(document.querySelector("[data-skp-alert].probe").getAnimations()[0].currentTime)');
    assert.ok(at >= 400, `enter animation at ${at} ms`);
  });

  test('alerts.cut removes the alert on screen at once, and one still waiting for its window never shows', opts, async (t) => {
    const { page, platform, overlay } = await open(t);
    const env = platform.bus.publish('alert.raid', { kind: 'raid', user: { name: 'BIA' }, display: { startAt: Date.now(), durationMs: 10000 } }, { target: overlay.id });
    await page.waitFor('!!document.querySelector("[data-skp-alert=raid]")', 2000);
    platform.bus.publish('alerts.cut', { alertId: env.id }, { target: overlay.id });
    await page.waitFor('!document.querySelector("[data-skp-alert=raid]")', 1000);
    await page.eval(watchAlerts);
    const queued = platform.bus.publish('alert.follow', follow('Later', { display: { startAt: Date.now() + 500, durationMs: 1000 } }), { target: overlay.id });
    platform.bus.publish('alerts.cut', { alertId: queued.id }, { target: overlay.id });
    await new Promise((r) => setTimeout(r, 900));
    assert.equal(await page.eval('window.__alertTimes.added || 0'), 0);
  });

  test('alerts.durationSetting sets how long an alert without a window stays', opts, async (t) => {
    const { page, platform, overlay } = await open(t, { settings: { alertHold: 2000 } });
    await page.eval(watchAlerts);
    const env = platform.bus.publish('alert.follow', follow('Held'), { target: overlay.id });
    const times = await page.waitFor('window.__alertTimes.removed && window.__alertTimes', 4000);
    // The window starts at the envelope's time: removed at 2000 + 50, not at 1500 + 50.
    const end = times.removed - env.ts;
    assert.ok(end >= 1950 && end < 2400, `removed ${end} ms after the envelope (2000 from settings, not 1500 from the manifest)`);
  });

  test('without a display window (before the server queue, step 19) an alert shows at once; the browser never queues', opts, async (t) => {
    const { page, platform, overlay, logOf } = await open(t);
    platform.bus.publish('alert.follow', follow('one'), { target: overlay.id });
    platform.bus.publish('alert.follow', follow('two'), { target: overlay.id });
    await page.waitFor('window.__log.filter((e) => e.what === "alert").length === 2', 2000);
    const [a, b] = await logOf('alert');
    assert.deepEqual([a.name, b.name], ['one', 'two']);
    assert.ok(Math.abs(b.at - a.at) < 300, 'both start from their envelope time, overlapping');
    // The window is the manifest's durationMs (1500) from the envelope time.
    await page.waitFor('document.querySelectorAll("[data-skp-alert]").length === 0', 3000);
  });

  test('alerts for templates without a renderer reach SK.on subscribers only; nothing is mounted', opts, async (t) => {
    const { page, platform, overlay } = await open(t, { query: '?norender' });
    await page.eval(watchAlerts);
    platform.bus.publish('alert.cheer', { kind: 'cheer', user: { name: 'x' }, amount: { value: 100, unit: 'bits' } }, { target: overlay.id });
    await page.waitFor('window.__log.some((e) => e.what === "alert-event" && e.type === "alert.cheer")');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(await page.eval('window.__alertTimes.added || 0'), 0);
  });
});

describe('chat (02 §2.3, 05 §5.6)', () => {
  const twitch = { connector: 'twitch', connection: 'con_tw' };
  const msg = (id, user = 'twitch:1') => ({ id, user: { id: user, name: user, roles: [] }, text: `text ${id}`, fragments: [{ type: 'text', text: `text ${id}` }] });

  async function chatBed(t) {
    const ctx = await startWithOverlay(t, { slug: 'chatbed', template: TESTBED });
    ctx.platform.bus.channel(ctx.overlay.id, { consumes: ctx.platform.templates.get(TESTBED.id, TESTBED.version).manifest.consumes, connections: ['con_tw'] });
    for (const id of ['r1', 'r2', 'r3']) ctx.platform.bus.publish('chat.message', msg(id), { src: twitch });
    const page = await browser.open(ctx.base);
    defer(t, () => page.close().catch(() => {}));
    await page.waitFor('window.__log && window.__log.some((e) => e.what === "ready")', 10000);
    const ids = () => page.eval('[...document.querySelectorAll("[data-skp-chat] .msg")].map((e) => e.dataset.id)');
    return { ...ctx, page, ids };
  }

  test('recent messages render at start without animation; live ones pace and cap at chat.max', opts, async (t) => {
    const { page, platform, ids } = await chatBed(t);
    await page.waitFor('document.querySelectorAll("[data-skp-chat] .msg").length === 3');
    assert.deepEqual(await page.eval('window.__log.filter((e) => e.what === "chat").map((e) => e.initial)'), [true, true, true]);
    for (let i = 1; i <= 8; i++) platform.bus.publish('chat.message', msg(`m${i}`), { src: twitch });
    await page.waitFor('window.__log.filter((e) => e.what === "chat" && !e.initial).length === 8', 3000);
    const live = await page.eval('window.__log.filter((e) => e.what === "chat" && !e.initial).map((e) => e.at)');
    assert.ok(live[7] - live[0] >= 200, `8 messages spread over ${live[7] - live[0]} ms (frames of 4 per 250 ms)`);
    await page.waitFor('document.querySelectorAll("[data-skp-chat] .msg:not([data-skp-state=exit])").length === 5', 2000);
    await page.waitFor('document.querySelectorAll("[data-skp-chat] .msg").length === 5', 2000);
    assert.deepEqual(await ids(), ['m4', 'm5', 'm6', 'm7', 'm8']);
  });

  test('messages arriving one by one are paced too: never more than 4 per 250 ms', opts, async (t) => {
    const { page, platform } = await chatBed(t);
    await page.waitFor('document.querySelectorAll("[data-skp-chat] .msg").length === 3');
    for (let i = 1; i <= 12; i++) {
      platform.bus.publish('chat.message', msg(`p${i}`), { src: twitch });
      await new Promise((r) => setTimeout(r, 20));
    }
    await page.waitFor('window.__log.filter((e) => e.what === "chat" && !e.initial).length === 12', 4000);
    const at = await page.eval('window.__log.filter((e) => e.what === "chat" && !e.initial).map((e) => e.at)');
    for (let i = 0; i + 4 < at.length; i++) assert.ok(at[i + 4] - at[i] >= 230, `messages ${i + 1}–${i + 5} within ${at[i + 4] - at[i]} ms`);
  });

  test('a scene with its own chat box gets the latest messages again after a scene change', opts, async (t) => {
    const { page, platform, overlay, ids } = await chatBed(t);
    await page.waitFor('document.querySelectorAll("[data-skp-chat] .msg").length === 3');
    platform.bus.publish('show.scene.changed', { scene: 'brb', transition: 'cut' }, { target: overlay.id });
    await page.waitFor('SK.scene === "brb"');
    platform.bus.publish('show.scene.changed', { scene: 'program', transition: 'cut' }, { target: overlay.id });
    await page.waitFor('SK.scene === "program" && document.querySelectorAll("[data-skp-chat] .msg").length === 3');
    assert.deepEqual(await ids(), ['r1', 'r2', 'r3']);
    for (let i = 1; i <= 8; i++) platform.bus.publish('chat.message', msg(`m${i}`), { src: twitch });
    // chat.max (5), counting only what is on screen: the old root's messages left with it.
    await page.waitFor('[...document.querySelectorAll("[data-skp-chat] .msg")].map((e) => e.dataset.id).join() === "m4,m5,m6,m7,m8"', 4000);
  });

  test('deletions, bans and clears take messages off screen', opts, async (t) => {
    const { page, platform, ids } = await chatBed(t);
    await page.waitFor('document.querySelectorAll("[data-skp-chat] .msg").length === 3');
    platform.bus.publish('chat.message', msg('b1', 'twitch:bad'), { src: twitch });
    platform.bus.publish('chat.message', msg('b2', 'twitch:bad'), { src: twitch });
    await page.waitFor('document.querySelectorAll("[data-skp-chat] .msg").length === 5', 2000);
    platform.bus.publish('chat.message.deleted', { messageId: 'r1' }, { src: twitch });
    platform.bus.publish('chat.user.cleared', { userId: 'twitch:bad' }, { src: twitch });
    await page.waitFor('document.querySelectorAll("[data-skp-chat] .msg").length === 2', 2000);
    assert.deepEqual(await ids(), ['r2', 'r3']);
    assert.deepEqual(await page.eval('window.__log.filter((e) => e.what === "chat-removed").map((e) => e.id)'), ['r1', 'b1', 'b2']);
    platform.bus.publish('chat.cleared', {}, { src: twitch });
    await page.waitFor('document.querySelectorAll("[data-skp-chat] .msg").length === 0', 2000);
    assert.deepEqual(await page.eval('SK.chat.recent()'), []);
  });
});

describe('mock data (?mock=1, 08 §8.5)', () => {
  test('the page runs a sample show with no server connection', opts, async (t) => {
    const { page, channel } = await open(t, { query: '?mock=1&mockSpeed=20' });
    assert.equal(await page.eval('SK.transport.mode'), 'mock');
    assert.equal(channel.subscriberCount, 0); // never opened a stream
    assert.equal(await page.eval('SK.state("show.lineup").length'), 5);
    assert.equal(await page.eval('SK.state("show.lineup").filter((s) => s.headliner).length'), 1);
    assert.equal(await page.eval('typeof SK.music.progress()'), 'number');
    assert.equal(await page.eval('SK.chat.recent().length'), 5);
    await page.waitFor('document.querySelectorAll("[data-skp-chat] .msg").length === 5');
    const roles = await page.eval('new Set(SK.chat.recent().flatMap((m) => m.user.roles)).size');
    assert.ok(roles >= 3);
    await page.waitFor('!!document.querySelector("[data-skp-alert]")', 4000);
    await page.waitFor('window.__log.some((e) => e.what === "titleCard")', 4000);
    await page.waitFor('window.__log.filter((e) => e.what === "chat" && !e.initial).length >= 3', 4000);
    assert.deepEqual(problems(page), []);
  });
});

describe('data helpers', () => {
  test('music progress is interpolated on server time and clamped to the track', opts, async (t) => {
    const { page, platform } = await open(t);
    platform.bus.setState('music.nowPlaying', { title: 'Strobe', artists: ['deadmau5'], durationMs: 637000, progressMs: 120000, progressAt: Date.now(), playing: true, source: 'spotify' });
    await page.waitFor('SK.music.track()?.title === "Strobe"');
    await new Promise((r) => setTimeout(r, 500));
    const p = await page.eval('SK.music.progress()');
    assert.ok(p >= 120400 && p < 122000, `progress ${p}`);
    platform.bus.setState('music.nowPlaying', { title: 'Strobe', durationMs: 1000, progressMs: 900, progressAt: Date.now() - 5000, playing: true });
    await page.waitFor('SK.music.progress() === 1000');
    platform.bus.setState('music.nowPlaying', undefined);
    await page.waitFor('SK.music.track() === undefined && SK.music.progress() === undefined');
  });

  test('settings: live edits reach onSettings, frozen', opts, async (t) => {
    const { page, channel } = await open(t, { settings: { accent: 'cyan', size: 2 } });
    assert.deepEqual(await page.eval('SK.settings'), { accent: 'cyan', size: 2 });
    assert.equal(await page.eval('Object.isFrozen(SK.settings)'), true);
    channel.setLocalState('overlay.settings', { accent: 'cyan', size: 3 });
    await page.waitFor('window.__log.some((e) => e.what === "settings")');
    assert.deepEqual(await page.eval('window.__log.filter((e) => e.what === "settings").map((e) => e.settings)'), [{ accent: 'cyan', size: 3 }]);
    assert.equal(await page.eval('SK.state("overlay.settings") === undefined'), true); // runtime data: only through SK.settings (04 §4.8)
  });

  test('?settings= (unsaved edits in the admin UI) replaces the saved settings, in either base64 alphabet', opts, async (t) => {
    const edits = { accent: 'gold', headliner: 'VIKKSTAR ✕ D/PRTMNT', note: '>>>???' };
    const b64url = Buffer.from(JSON.stringify(edits)).toString('base64url');
    const { page, channel, base } = await open(t, { query: `?settings=${b64url}`, settings: { accent: 'cyan', size: 2 } });
    assert.deepEqual(await page.eval('SK.settings'), edits);
    channel.setLocalState('overlay.settings', { accent: 'red' });
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(await page.eval('SK.settings'), edits); // live edits don't override unsaved ones
    // Standard base64 put in the URL as is: its '+' arrives as a space and must still decode.
    const b64 = Buffer.from(JSON.stringify(edits)).toString('base64');
    assert.match(b64, /\+/);
    await page.goto(`${base}?settings=${b64}`);
    await page.waitFor('window.__log && window.__log.some((e) => e.what === "ready")');
    assert.deepEqual(await page.eval('SK.settings'), edits);
  });

  test('SK.asset gives the versioned URL of a template file', opts, async (t) => {
    const { page, build } = await open(t);
    assert.equal(await page.eval('SK.asset("previews/testbed.svg")'), `/o/bed/t/${build}/previews/testbed.svg`);
    assert.equal(await page.eval('fetch(SK.asset("./previews/testbed.svg")).then((r) => r.status)'), 200);
  });

  test('SK.log and uncaught template errors reach the platform log', opts, async (t) => {
    const { page, entries } = await open(t);
    await page.eval('SK.log.warn("the poster is missing", { file: "poster.jpg" }); setTimeout(() => { throw new Error("template bug"); }, 0); true');
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && entries.filter((e) => e.component === 'template').length < 2) await new Promise((r) => setTimeout(r, 50));
    const logged = entries.filter((e) => e.component === 'template');
    assert.ok(logged.some((e) => e.level === 'warn' && e.msg === 'the poster is missing' && e.context.overlay === 'bed'), JSON.stringify(logged));
    assert.ok(logged.some((e) => e.level === 'error' && e.msg === 'uncaught error' && /template bug/.test(e.context.context.error)), JSON.stringify(logged));
  });

  test('a template log flood is cut down, but distinct entries get through', opts, async (t) => {
    const { page, entries } = await open(t);
    // 60 frames of the same warning with a changing context, and 20 long non-ASCII entries.
    await page.eval(`(() => {
      for (let i = 0; i < 60; i++) SK.log.warn('slow frame', { ms: i });
      for (let i = 0; i < 20; i++) SK.log.info('チャット' + i + 'あ'.repeat(490), { text: 'メッセージ'.repeat(300) });
      return true;
    })()`);
    const template = () => entries.filter((e) => e.component === 'template');
    const deadline = Date.now() + 5000;
    while (template().filter((e) => e.msg.startsWith('チャット')).length < 20 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    assert.equal(template().filter((e) => e.msg.startsWith('チャット')).length, 20, 'batches stay under 64 KiB, so none is refused');
    assert.equal(template().filter((e) => e.msg === 'slow frame').length, 5, 'one message, at most five contexts a minute');
  });

  test('the SK object and its parts are frozen', opts, async (t) => {
    const { page } = await open(t);
    assert.equal(await page.eval('[SK, SK.clock, SK.chat, SK.music, SK.alerts, SK.log, SK.env, SK.canvas, SK.transport].every(Object.isFrozen)'), true);
    assert.equal(await page.eval('(() => { try { SK.state = null; } catch (e) {} return typeof SK.state; })()'), 'function');
  });
});
