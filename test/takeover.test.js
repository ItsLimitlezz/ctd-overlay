// The TAKEOVER template (plan step 8) and the viewer-count widget (04 §4.12): v0's look on the
// runtime SDK, in a real browser. What the port had to fix (docs/PLAN.md) is checked statically.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateTemplate } from '../src/templates/registry.js';
import { browserSkip, launchBrowser } from './cdp.js';
import { defer, startWithOverlay } from './helpers.js';

const DIR = fileURLToPath(new URL('../templates/takeover/', import.meta.url));
const TAKEOVER = { id: 'com.dprtmnt.takeover', version: '1.0.0' };
const VIEWERS = { id: 'dev.skp.viewers', version: '1.0.0' };
const SCENES = ['auto', 'starting', 'program', 'brb', 'lineup', 'outro', 'bg', 'intro', 'headliner', 'line', 'pov'];
const MIN = 60000;
const FILE_ID = '0123456789abcdef0123456789abcdef';

describe('what the port had to fix (docs/PLAN.md)', () => {
  const read = (name) => readFileSync(path.join(DIR, name), 'utf8');

  test('the package validates, with every core scene, The Line, POV and the four actions', () => {
    const result = validateTemplate(DIR);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.warnings, []);
    const manifest = JSON.parse(read('template.json'));
    assert.deepEqual(manifest.scenes.map((s) => s.id), SCENES);
    assert.deepEqual(manifest.actions.map((a) => a.id), ['titleCard', 'nowPlaying', 'chipOpening', 'chipOnAt']);
    assert.deepEqual(manifest.canvases.map((c) => `${c.id} ${c.width}x${c.height}`), ['h 1920x1080', 'v 1080x1920']);
  });

  test('no inline script or handler (the overlay CSP blocks them)', () => {
    const html = read('index.html');
    for (const tag of html.match(/<script\b[^>]*>/g)) assert.match(tag, /\ssrc="/, tag);
    assert.doesNotMatch(html, /<script\b[^>]*>[^<\s]/);
    assert.doesNotMatch(html, /\son[a-z]+=/i);
  });

  test('asset paths are relative (04 §4.5), never /assets or /shared', () => {
    assert.doesNotMatch(read('template.css'), /url\(\s*['"]?\//);
    assert.doesNotMatch(read('index.html'), /(src|href)="\/(?!\/)/);
    assert.doesNotMatch(read('template.js'), /['"`]\/(assets|shared)\//);
  });

  test('v0\'s hard-coded copy is settings now, with v0\'s words as the defaults', () => {
    const code = read('template.js') + read('template.css') + read('index.html');
    const defaults = JSON.stringify(JSON.parse(read('template.json')).definitions.settings.properties);
    for (const copy of ['NEXT SATURDAY', 'THE MUSIC DOESN\'T STOP', 'OUTSIDE · THE DOOR', 'Live From Toronto', 'MUSIC KEEPS RUNNING', 'THANKS FOR', 'DPRTMNT.COM']) {
      assert.ok(!code.includes(copy), `"${copy}" is hard-coded`);
      assert.ok(defaults.includes(copy), `"${copy}" is a setting's default`);
    }
  });
});

let browser;
before(async () => { if (!browserSkip) browser = await launchBrowser(); });
after(async () => { if (browser) await browser.close(); });
const opts = { skip: browserSkip };

// The page's problems, less fonts from the network (CI may have none) and the sample media URLs
// these tests point at, which are not real files.
const problems = (page) => page.problems.filter((p) => !/fonts\.(googleapis|gstatic)\.com|\/media\/[0-9a-f]{32}\//.test(p));

async function open(t, { template = TAKEOVER, settings = {}, canvas, state = {} } = {}) {
  const ctx = await startWithOverlay(t, { slug: 'tk', template, settings });
  for (const [key, value] of Object.entries(state)) ctx.platform.bus.setState(key, value);
  const vertical = canvas === 'v';
  const page = await browser.open(`${ctx.base}${vertical ? '?canvas=v' : ''}`, vertical ? { width: 1080, height: 1920 } : { width: 1920, height: 1080 });
  defer(t, () => page.close().catch(() => {}));
  await page.waitFor('window.SK && SK.scene && document.querySelector("[data-skp-scene-root] > *")', 10000);
  const channel = ctx.platform.overlays.resolve('tk').channel;
  const take = async (scene) => {
    ctx.platform.bus.publish('show.scene.changed', { scene, transition: 'cut' }, { target: ctx.overlay.id });
    channel.setLocalState('show.scene', scene);
    await page.waitFor(`SK.scene === ${JSON.stringify(scene)} && document.querySelectorAll("[data-skp-scene-root]").length === 1 && !!document.querySelector("[data-skp-scene-root] .scene")`);
  };
  const text = (sel) => page.eval(`[...document.querySelectorAll(${JSON.stringify(sel)})].filter((e) => !e.closest(".hide") && !e.closest("[hidden]")).map((e) => e.textContent.replace(/\\s+/g, " ").trim())`);
  const trigger = (name, { inMs = 200, durationMs = 2000, args = {} } = {}) =>
    ctx.platform.bus.publish('show.trigger', { name, args, startAt: Date.now() + inMs, durationMs }, { target: ctx.overlay.id });
  return { ...ctx, page, channel, take, text, trigger };
}

// A night like the demo's: go-live in 3 minutes, one act on now.
function night(now = Date.now()) {
  const pad = (n) => String(n).padStart(2, '0');
  const slot = (offsetMin, name, extra = {}) => {
    const at = now + offsetMin * MIN;
    const d = new Date(at);
    return { time: `${pad(d.getHours())}:${pad(d.getMinutes())}`, startAt: at, name, ...extra };
  };
  const d = new Date(now);
  return {
    'show.lineup': [
      slot(60, 'VIKKSTAR', { headliner: true, logo: `/media/${FILE_ID}/vikkstar.png` }),
      slot(-30, 'Trapment'),
      slot(120, 'UNDERCOVER', { closer: true }),
      slot(30, 'BIA', { b2b: 'DOLF', logo: 'javascript:alert(1)' }),
    ],
    'show.headliner': 'VIKKSTAR',
    'show.currentSlot': 1,
    'show.date': `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    'show.goLiveAt': now + 3 * MIN,
    'show.recStartedAt': now - 42 * MIN,
    'viewers.total': 1159,
  };
}

const NOTHING = /\b(undefined|null|NaN)\b|\[object /;

describe('TAKEOVER in a browser', () => {
  for (const look of ['takeover', 'event']) {
    for (const canvas of ['h', 'v']) {
      test(`every scene builds in the ${look} look on the ${canvas} canvas, with nothing broken`, opts, async (t) => {
        const { page, take } = await open(t, { settings: { look, address: '473 ADELAIDE ST W' }, canvas, state: night() });
        assert.equal(await page.eval('document.documentElement.getAttribute("data-look")'), look);
        for (const scene of SCENES) {
          await take(scene);
          const shown = await page.eval('document.querySelector("[data-skp-stage]").innerText');
          assert.doesNotMatch(shown, NOTHING, `${scene}: ${shown}`);
        }
        assert.deepEqual(problems(page), []);
      });
    }
  }

  test('with no show data nothing is a placeholder: absent values are hidden (H6)', opts, async (t) => {
    const { page, take, text } = await open(t);
    await take('program');
    assert.deepEqual(await text('[data-vw]'), [], 'no viewer count');
    assert.deepEqual(await text('[data-rec]'), [], 'no REC timecode');
    await take('starting');
    assert.deepEqual(await text('[data-count]'), [], 'no countdown');
    await take('lineup');
    assert.deepEqual(await text('.lineup .empty'), ['LINEUP TBA']);
    await take('pov');
    assert.deepEqual(await text('[data-who]'), []);
    for (const scene of SCENES) {
      await take(scene);
      assert.doesNotMatch(await page.eval('document.querySelector("[data-skp-stage]").innerText'), NOTHING, scene);
    }
    assert.deepEqual(problems(page), []);
  });

  test('the show\'s data reaches the scenes: count, REC, countdown, lineup, who\'s on', opts, async (t) => {
    const state = night();
    const { page, take, text, platform } = await open(t, { state });
    await take('program');
    assert.deepEqual(await text('[data-vw]'), ['1,159']);
    assert.match((await text('[data-rec]'))[0], /^REC 42:0\d$/);
    platform.bus.setState('viewers.stale', true);
    await page.waitFor('document.querySelector("[data-vw]").classList.contains("stale")');
    platform.bus.setState('viewers.total', undefined);
    await page.waitFor('document.querySelector("[data-vw]").classList.contains("hide")');
    await take('starting');
    const [count] = await text('[data-count]');
    assert.match(count, /^0[23]:\d\d$/);
    await take('lineup');
    // In start order, whatever order the lineup was written in; the operator's pick is marked live.
    const first = (sel) => page.eval(`[...document.querySelectorAll(${JSON.stringify(sel)})].map((e) => e.textContent)`);
    assert.deepEqual(await first('.lineup .row:not(.cap) .who > span:first-child'), ['Trapment', 'BIA', 'VIKKSTAR', 'UNDERCOVER']);
    assert.deepEqual(await first('.lineup .row.live .who > span:first-child'), ['Trapment']);
    assert.deepEqual(await text('.lineup .b2b-grp'), ['B2BDOLF']);
    assert.deepEqual(await text('.lineup .closer-tag'), ['· CLOSER']);
    await take('pov');
    assert.deepEqual(await text('[data-who] .name'), ['Trapment']);
    platform.bus.setState('show.currentSlot', 3); // BIA (index 3 in the lineup as written)
    await page.waitFor('document.querySelector("[data-who] .name") && document.querySelector("[data-who] .name").textContent === "BIA"');
    assert.deepEqual(await text('[data-who] .b2b'), ['B2B DOLF']);
    assert.deepEqual(problems(page), []);
  });

  test('the event look bills the headliner from show.headliner and dates the show from show.date', opts, async (t) => {
    const state = night();
    const { page, take, text, platform } = await open(t, { settings: { look: 'event' }, state });
    await take('starting');
    assert.deepEqual(await text('.vk-big'), ['VIKKSTAR']);
    const [, mm, dd] = /^\d{4}-(\d{2})-(\d{2})$/.exec(state['show.date']);
    assert.ok((await text('.vk-wm-date, .vk-bar')).some((s) => s.includes(`${mm}.${dd}`)));
    await take('program');
    assert.deepEqual(await text('.vk-lockup .vk-name'), ['VIKKSTAR']);
    // The lineup's headliner changes: the setting follows it (bound to show.headliner, 04 §4.3).
    platform.bus.setState('show.headliner', 'UNDERCOVER');
    await page.waitFor('document.querySelector(".vk-lockup .vk-name") && document.querySelector(".vk-lockup .vk-name").textContent === "UNDERCOVER"');
    assert.deepEqual(problems(page), []);
  });

  test('"auto" counts down to go-live, then goes live by itself, and follows go-live when it moves', opts, async (t) => {
    const state = { ...night(), 'show.goLiveAt': Date.now() + 2500 };
    const { page, take, platform } = await open(t, { state });
    await take('auto');
    assert.equal(await page.eval('!!document.querySelector("[data-skp-scene-root=auto] .starting")'), true);
    await page.waitFor('!!document.querySelector("[data-skp-scene-root=auto] .program")', 6000);
    assert.equal(await page.eval('SK.scene'), 'auto', 'still the one "auto" source');
    platform.bus.setState('show.goLiveAt', Date.now() + 10 * MIN);
    await page.waitFor('!!document.querySelector("[data-skp-scene-root=auto] .starting")');
    assert.deepEqual(problems(page), []);
  });

  test('actions show on the live scene from startAt and are gone by its end; elsewhere they do nothing', opts, async (t) => {
    const { page, take, text, trigger } = await open(t, { state: night() });
    await take('program');
    trigger('titleCard', { durationMs: 1800 });
    await page.waitFor('!!document.querySelector("[data-kind=title]")', 3000);
    assert.deepEqual(await text('[data-kind=title] .djname'), ['Trapment']);
    await page.waitFor('!document.querySelector("[data-kind=title]")', 4000);
    // Now playing names who's next; a cue can name the act; a logo comes from the lineup.
    trigger('nowPlaying', { args: { name: 'vikkstar' } });
    await page.waitFor('!!document.querySelector("[data-kind=np]")', 3000);
    assert.deepEqual(await text('[data-kind=np] .name'), ['VIKKSTAR']);
    assert.equal(await page.eval('document.querySelector("[data-kind=np] img.logo").getAttribute("src")'), `/media/${FILE_ID}/vikkstar.png`);
    assert.match((await text('[data-kind=np] .next .v'))[0], /^UNDERCOVER — \d{1,2}:\d\d [AP]M$/);
    // A logo that isn't media or https is never used.
    trigger('titleCard', { args: { name: 'BIA' } });
    await page.waitFor('!!document.querySelector("[data-kind=title]")', 3000);
    assert.equal(await page.eval('!!document.querySelector("[data-kind=title] img")'), false);
    // The schedule chips belong to the event look.
    trigger('chipOpening');
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(await page.eval('!!document.querySelector("[data-kind=chip]")'), false);
    await take('brb');
    trigger('titleCard');
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(await page.eval('!!document.querySelector("[data-kind]")'), false, 'only on the live scene');
    assert.deepEqual(problems(page), []);
  });

  test('the event look\'s chips: who opens, and when the headliner is on', opts, async (t) => {
    const state = night();
    const { page, take, text, trigger } = await open(t, { settings: { look: 'event' }, state });
    await take('program');
    trigger('chipOpening');
    await page.waitFor('!!document.querySelector("[data-kind=chip]")', 3000);
    assert.deepEqual(await text('[data-kind=chip] .v'), ['Trapment']);
    trigger('chipOnAt');
    await page.waitFor('document.querySelector("[data-kind=chip] .k") && document.querySelector("[data-kind=chip] .k").textContent === "VIKKSTAR"', 3000);
    assert.match((await text('[data-kind=chip] .v')).at(-1), /^ON AT \d{1,2}:\d\d [AP]M$/);
    assert.deepEqual(problems(page), []);
  });

  test('media.play shows the operator\'s clip under the scenes, media.stop hides it, and nothing else is played', opts, async (t) => {
    const { page, take, platform, overlay } = await open(t);
    await take('program');
    const send = (type, data) => platform.bus.publish(type, data, { target: overlay.id });
    send('media.play', { mediaId: 'med_x', url: 'javascript:alert(1)' });
    send('media.play', { mediaId: 'med_x', url: 'http://example.com/x.webm' });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(await page.eval('document.querySelector("[data-clip]").classList.contains("hide") && !document.querySelector("[data-clip] video")'), true);
    send('media.play', { mediaId: 'med_x', url: `/media/${FILE_ID}/stinger.webm` });
    await page.waitFor('!document.querySelector("[data-clip]").classList.contains("hide")');
    assert.equal(await page.eval('document.querySelector("[data-clip] video").getAttribute("src")'), `/media/${FILE_ID}/stinger.webm`);
    send('media.stop', {});
    await page.waitFor('document.querySelector("[data-clip]").classList.contains("hide")');
    assert.deepEqual(problems(page), []);
  });

  test('settings reach the page live: copy, the look, the event outro\'s line break', opts, async (t) => {
    const { page, take, text, platform } = await open(t, { settings: { brbTag: 'BACK IN FIVE' } });
    await take('brb');
    assert.deepEqual(await text('.brb .tag'), ['BACK IN FIVE']);
    platform.overlays.updateSettings('tk', { brbTag: 'HOLD TIGHT' });
    await page.waitFor('document.querySelector(".brb .tag") && document.querySelector(".brb .tag").textContent === "HOLD TIGHT"');
    platform.overlays.updateSettings('tk', { look: 'event', eventOutroBig: 'SEE YOU|<b>SOON</b>' });
    await page.waitFor('document.documentElement.getAttribute("data-look") === "event" && !!document.querySelector(".vk-brb")');
    await take('outro');
    assert.equal(await page.eval('document.querySelector(".vk-outro .vk-big").innerHTML'), 'SEE YOU<br>&lt;b&gt;SOON&lt;/b&gt;');
    // The star is the template's own until the headliner's mark is uploaded.
    const mark = 'getComputedStyle(document.querySelector(".vk-outro .vk-star")).webkitMaskImage';
    assert.match(await page.eval(mark), /\/assets\/star\.svg"\)$/);
    platform.overlays.updateSettings('tk', { look: 'event', eventMark: `/media/${FILE_ID}/mark.png` });
    await page.waitFor(`${mark}.endsWith(${JSON.stringify(`/media/${FILE_ID}/mark.png")`)})`);
    assert.deepEqual(problems(page), []);
  });

  test('mock mode (?mock=1) runs the template on sample data, the new show keys included', opts, async (t) => {
    const ctx = await startWithOverlay(t, { slug: 'tk', template: TAKEOVER, settings: { look: 'event' } });
    const page = await browser.open(`${ctx.base}?mock=1&scene=lineup`, { width: 1920, height: 1080 });
    defer(t, () => page.close().catch(() => {}));
    await page.waitFor('window.SK && SK.scene === "lineup" && !!document.querySelector(".vk-lineup .row.head")', 10000);
    assert.equal(await page.eval('SK.state("show.headliner")'), 'VIKKSTAR');
    assert.equal(await page.eval('typeof SK.state("show.goLiveAt")'), 'number');
    assert.match(await page.eval('SK.state("show.date")'), /^\d{4}-\d{2}-\d{2}$/);
    assert.deepEqual(problems(page), []);
  });
});

describe('the viewer-count widget (04 §4.12)', () => {
  test('hidden while the count is unknown, never 0; quieter while stale; the label and colour are settings', opts, async (t) => {
    const { page, platform } = await open(t, { template: VIEWERS, settings: { label: 'watching', accent: '#16E0FF' } });
    await page.waitFor('!!document.querySelector(".viewers")');
    assert.equal(await page.eval('document.querySelector(".viewers").hidden'), true);
    platform.bus.setState('viewers.total', 0);
    await page.waitFor('!document.querySelector(".viewers").hidden');
    assert.equal(await page.eval('document.querySelector(".viewers b").textContent'), '0', 'a known 0 is shown');
    platform.bus.setState('viewers.total', 12345);
    await page.waitFor('document.querySelector(".viewers b").textContent === "12,345"');
    assert.equal(await page.eval('document.querySelector(".viewers .label").textContent'), 'watching');
    assert.equal(await page.eval('getComputedStyle(document.documentElement).getPropertyValue("--dot").trim().toLowerCase()'), '#16e0ff');
    platform.bus.setState('viewers.stale', true);
    await page.waitFor('document.querySelector(".viewers").classList.contains("stale")');
    platform.bus.setState('viewers.total', undefined);
    await page.waitFor('document.querySelector(".viewers").hidden');
    assert.deepEqual(problems(page), []);
  });
});
