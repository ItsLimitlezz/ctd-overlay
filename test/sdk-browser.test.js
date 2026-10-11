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
    assert.deepEqual(page.problems, []);
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
    await page.waitFor('(document.querySelector("[data-skp-debug]") || {}).textContent?.includes("scene program")');
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

  test('"cut" swaps at once; core names map to template scenes; unknown scenes are ignored', opts, async (t) => {
    const { page, platform, overlay, logOf } = await open(t);
    platform.bus.publish('show.scene.changed', { scene: 'outro', transition: 'cut' }, { target: overlay.id });
    await page.waitFor('SK.scene === "outro"');
    assert.equal(await page.eval('document.querySelectorAll("[data-skp-scene-root]").length'), 1);
    assert.equal(await page.eval('document.querySelector("[data-skp-scene-root=outro]").dataset.skpState'), 'idle');
    platform.bus.publish('show.scene.changed', { scene: 'pov', transition: 'cut' }, { target: overlay.id });
    platform.bus.publish('show.scene.changed', { scene: 'lineup', transition: 'cut' }, { target: overlay.id });
    await page.waitFor('SK.scene === "lineup"');
    assert.match(await page.eval('document.querySelector("[data-skp-scene-root=lineup]").textContent'), /Lineup for h/);
    assert.deepEqual((await logOf('scene')).map((s) => s.scene), ['program', 'outro', 'lineup']);
  });

  test('?scene= pins a scene for previews, whatever the show does', opts, async (t) => {
    const { page, channel } = await open(t, { query: '?scene=brb' });
    assert.equal(await page.eval('SK.scene'), 'brb');
    channel.setLocalState('show.scene', 'outro');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(await page.eval('SK.scene'), 'brb');
  });

  test('a stinger covers the swap, which happens at cutAtMs', opts, async (t) => {
    const { page, platform, overlay } = await open(t);
    platform.bus.publish('show.scene.changed', { scene: 'brb', transition: 'stinger' }, { target: overlay.id });
    await page.waitFor('!!document.querySelector("video[data-skp-stinger=stinger]")');
    assert.equal(await page.eval('!!document.querySelector("[data-skp-scene-root=brb]")'), false); // not before cutAtMs
    await page.waitFor('!!document.querySelector("[data-skp-scene-root=brb]") && !document.querySelector("[data-skp-scene-root=program]")', 2000);
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

  test('opts.durationMs beats --skp-enter-ms, which beats CSS; transitions count too', opts, async (t) => {
    const { page } = await open(t);
    const custom = await page.eval(measure('custom msg'));
    assert.ok(custom.entered >= 70 && custom.entered < 300, `custom enter took ${custom.entered} ms`);
    assert.ok(custom.exited >= 70 && custom.exited < 300, `custom exit took ${custom.exited} ms (25 + 50)`);
    const forced = await page.eval(measure('msg', '{ durationMs: 0 }'));
    assert.ok(forced.entered < 100, `durationMs 0 entered in ${forced.entered} ms`);
    const transitioned = await page.eval(measure('transitioned'));
    assert.ok(transitioned.entered >= 140, `transition-based enter took ${transitioned.entered} ms (120 + 30)`);
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

  test('triggers for actions the template has no handler for are ignored', opts, async (t) => {
    const { page, platform, overlay } = await open(t);
    platform.bus.publish('show.trigger', { name: 'nowPlaying', startAt: Date.now(), durationMs: 1000 }, { target: overlay.id });
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(page.problems, []);
  });
});

describe('alerts (05 §5.5)', () => {
  const follow = (name, extra = {}) => ({ kind: 'follow', user: { name }, ...extra });

  test('an alert with a display window shows from startAt and is gone when the window ends', opts, async (t) => {
    const { page, platform, overlay } = await open(t);
    const startAt = Date.now() + 300;
    platform.bus.publish('alert.follow', follow('Trapment', { display: { startAt, durationMs: 1000 } }), { target: overlay.id });
    await page.waitFor('!!document.querySelector("[data-skp-alerts] [data-skp-alert=follow]")', 2000);
    const shownAt = Date.now();
    assert.ok(shownAt >= startAt - 50, `shown ${startAt - shownAt} ms early`);
    assert.equal(await page.eval('document.querySelector("[data-skp-alert]").textContent'), 'Trapment follow');
    await page.waitFor('!document.querySelector("[data-skp-alert]")', 3000);
    const goneAt = Date.now();
    assert.ok(goneAt <= startAt + 1000 + 400, `gone ${goneAt - startAt - 1000} ms after the window`);
  });

  test('alerts.cut removes the alert on screen at once', opts, async (t) => {
    const { page, platform, overlay } = await open(t);
    const env = platform.bus.publish('alert.raid', { kind: 'raid', user: { name: 'BIA' }, display: { startAt: Date.now(), durationMs: 10000 } }, { target: overlay.id });
    await page.waitFor('!!document.querySelector("[data-skp-alert=raid]")', 2000);
    platform.bus.publish('alerts.cut', { alertId: env.id }, { target: overlay.id });
    await page.waitFor('!document.querySelector("[data-skp-alert=raid]")', 1000);
  });

  test('without a display window (until the server queue, step 19) alerts play one after another', opts, async (t) => {
    const { page, platform, overlay, logOf } = await open(t);
    platform.bus.publish('alert.follow', follow('one'), { target: overlay.id });
    platform.bus.publish('alert.follow', follow('two'), { target: overlay.id });
    await page.waitFor('window.__log.filter((e) => e.what === "alert").length === 2', 5000);
    const [a, b] = await logOf('alert');
    assert.deepEqual([a.name, b.name], ['one', 'two']);
    assert.ok(b.at - a.at >= 1500, `second alert ${b.at - a.at} ms after the first (1500 + 100 gap)`);
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
    assert.deepEqual(page.problems, []);
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

  test('settings: live edits reach onSettings; ?settings= lays unsaved edits over them', opts, async (t) => {
    const preview = Buffer.from(JSON.stringify({ accent: 'gold', héadliner: 'VIKKSTAR' })).toString('base64');
    const { page, channel } = await open(t, { query: `?settings=${encodeURIComponent(preview)}`, settings: { accent: 'cyan', size: 2 } });
    assert.deepEqual(await page.eval('SK.settings'), { accent: 'gold', size: 2, 'héadliner': 'VIKKSTAR' });
    assert.equal(await page.eval('Object.isFrozen(SK.settings)'), true);
    channel.setLocalState('overlay.settings', { accent: 'cyan', size: 3 });
    await page.waitFor('window.__log.some((e) => e.what === "settings")');
    assert.deepEqual(await page.eval('window.__log.filter((e) => e.what === "settings").map((e) => e.settings)'), [{ accent: 'gold', size: 3, 'héadliner': 'VIKKSTAR' }]);
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

  test('the SK object and its parts are frozen', opts, async (t) => {
    const { page } = await open(t);
    assert.equal(await page.eval('[SK, SK.clock, SK.chat, SK.music, SK.alerts, SK.log, SK.env, SK.canvas, SK.transport].every(Object.isFrozen)'), true);
    assert.equal(await page.eval('(() => { try { SK.state = null; } catch (e) {} return typeof SK.state; })()'), 'function');
  });
});
