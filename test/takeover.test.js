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
const TAKEOVER = { id: 'com.dprtmnt.takeover', version: '1.1.0' };
const VIEWERS = { id: 'dev.skp.viewers', version: '1.0.0' };
const SCENES = ['auto', 'starting', 'program', 'brb', 'lineup', 'outro', 'bg', 'intro', 'headliner', 'line', 'pov'];
const MIN = 60000;
const FILE_ID = '0123456789abcdef0123456789abcdef';

describe('what the port had to fix (docs/PLAN.md)', () => {
  const read = (name) => readFileSync(path.join(DIR, name), 'utf8');

  test('the package validates, with every core scene, The Line, POV and v0\'s operator actions', () => {
    const result = validateTemplate(DIR);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.warnings, []);
    const manifest = JSON.parse(read('template.json'));
    assert.equal(manifest.version, TAKEOVER.version);
    assert.deepEqual(manifest.scenes.map((s) => s.id), SCENES);
    assert.deepEqual(manifest.actions.map((a) => a.id), ['titleCard', 'nowPlaying', 'nowPlayingHold', 'hideCards', 'chipOpening', 'chipOnAt', 'linePlay', 'lineStop']);
    // What has no end on a clock declares no duration: the templates page shows none for it, and the
    // runtime still lets a late trigger in for the platform's default window.
    assert.deepEqual(manifest.actions.filter((a) => a.durationMs === undefined).map((a) => a.id), ['nowPlayingHold', 'hideCards', 'linePlay', 'lineStop']);
    // The hold times' defaults are v0's, and the actions' durations say the same.
    const props = manifest.definitions.settings.properties;
    assert.deepEqual([props.cardSec.default * 1000, props.npSec.default * 1000], manifest.actions.slice(0, 2).map((a) => a.durationMs));
    assert.equal(props.autoCard.default, false, 'off: a timeline built from the lineup shows each title card already');
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

async function open(t, { template = TAKEOVER, settings = {}, canvas, state = {}, query = {} } = {}) {
  const ctx = await startWithOverlay(t, { slug: 'tk', template, settings });
  for (const [key, value] of Object.entries(state)) ctx.platform.bus.setState(key, value);
  const vertical = canvas === 'v';
  const params = new URLSearchParams({ ...(vertical ? { canvas: 'v' } : {}), ...query }).toString();
  const page = await browser.open(`${ctx.base}${params ? `?${params}` : ''}`, vertical ? { width: 1080, height: 1920 } : { width: 1920, height: 1080 });
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

  for (const look of ['takeover', 'event']) {
    test(`with no show data nothing is a placeholder in the ${look} look: absent values are hidden (H6)`, opts, async (t) => {
      const { page, take, text } = await open(t, { settings: { look } });
      await take('program');
      assert.deepEqual(await text('[data-vw]'), [], 'no viewer count');
      assert.deepEqual(await text('[data-rec]'), [], 'no REC timecode');
      assert.deepEqual(await text('.vk-date, [data-lockup]'), [], 'no date, no TONIGHT lockup');
      await take('starting');
      assert.deepEqual(await text('[data-count]'), [], 'no countdown');
      await take('lineup');
      assert.deepEqual(await text('.lineup .empty, .vk-tt .row .n'), ['LINEUP TBA']);
      await take('pov');
      assert.deepEqual(await text('[data-who]'), []);
      for (const scene of SCENES) {
        await take(scene);
        assert.doesNotMatch(await page.eval('document.querySelector("[data-skp-stage]").innerText'), NOTHING, scene);
        assert.deepEqual(await text('.vk-date, .vk-wm-date'), [], `${scene}: no date`);
      }
      assert.deepEqual(problems(page), []);
    });
  }

  test('REC counts only from show.recStartedAt, and the REC and viewer toggles hide them', opts, async (t) => {
    // No anchor, and an act that started 90 minutes ago: v0 would have counted REC from it.
    const state = night();
    delete state['show.recStartedAt'];
    state['show.lineup'] = state['show.lineup'].map((s, i) => (i === 1 ? { ...s, startAt: Date.now() - 90 * MIN } : s));
    const { page, take, text, platform } = await open(t, { state });
    for (const scene of ['program', 'line', 'pov']) {
      await take(scene);
      assert.deepEqual(await text('[data-rec]'), [], `${scene}: no recording anchor, no REC (not one made up from the lineup)`);
    }
    platform.bus.setState('show.recStartedAt', Date.now() - 5 * MIN);
    await page.waitFor('/^REC 0[45]:\\d\\d$/.test((document.querySelector("[data-rec]") || {}).textContent || "")');
    platform.overlays.updateSettings('tk', { rec: false, viewers: false });
    await page.waitFor('document.querySelector("[data-rec]").classList.contains("hide") && document.querySelector("[data-vw]").classList.contains("hide")');
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
    const { page, take, platform } = await open(t, { state: { ...night(), 'show.goLiveAt': Date.now() + 10 * MIN } });
    // Go-live set once the page is open, so a slow start can't use up the countdown.
    platform.bus.setState('show.goLiveAt', Date.now() + 2500);
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
    send('media.play', { mediaId: 'med_x', url: 'https://example.com/x.webm' }); // the CSP would refuse it
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(await page.eval('document.querySelector("[data-clip]").classList.contains("hide") && !document.querySelector("[data-clip] video")'), true);
    send('media.play', { mediaId: 'med_x', url: `/media/${FILE_ID}/stinger.webm` });
    await page.waitFor('!document.querySelector("[data-clip]").classList.contains("hide")');
    assert.equal(await page.eval('document.querySelector("[data-clip] video").getAttribute("src")'), `/media/${FILE_ID}/stinger.webm`);
    // That file doesn't exist: no picture, so no black plate over the camera.
    await page.waitFor('document.querySelector("[data-clip] video").error !== null', 3000);
    assert.equal(await page.eval('getComputedStyle(document.querySelector("[data-clip]")).backgroundColor'), 'rgba(0, 0, 0, 0)');
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('TAKEOVER on air', () => {
  for (const look of ['takeover', 'event']) {
    test(`actions show on "auto" once it is live (${look} look), never over its countdown`, opts, async (t) => {
      const { page, take, trigger, platform } = await open(t, { settings: { look }, state: { ...night(), 'show.goLiveAt': Date.now() - MIN } });
      await take('auto');
      await page.waitFor('!!document.querySelector("[data-skp-scene-root=auto] .program, [data-skp-scene-root=auto] .vk-program")');
      trigger('titleCard', { durationMs: 1500 });
      await page.waitFor('!!document.querySelector("[data-skp-scene-root=auto] [data-kind=title]")', 3000);
      if (look === 'event') {
        trigger('chipOpening', { durationMs: 1500 });
        await page.waitFor('!!document.querySelector("[data-skp-scene-root=auto] [data-kind=chip]")', 3000);
      }
      await page.waitFor('!document.querySelector("[data-kind]")', 4000);
      platform.bus.setState('show.goLiveAt', Date.now() + 10 * MIN);
      await page.waitFor('!!document.querySelector("[data-skp-scene-root=auto] .starting, [data-skp-scene-root=auto] .vk-starting")');
      trigger('nowPlaying', { durationMs: 1500 });
      await sleep(700);
      assert.equal(await page.eval('!!document.querySelector("[data-kind]")'), false, 'not over the countdown');
      assert.deepEqual(problems(page), []);
    });
  }

  test('an action on air stays for its whole window: through new data, a settings edit and a scene round-trip', opts, async (t) => {
    const state = night();
    const { page, take, trigger, platform } = await open(t, { state });
    await take('program');
    const t0 = Date.now();
    trigger('nowPlaying', { durationMs: 7000 });
    await page.waitFor('!!document.querySelector("[data-kind=np]")', 3000);
    await page.eval('document.querySelector("[data-kind=np]").dataset.mark = "1"');
    // Marking the next act current doesn't rebuild the live scene: the card names them in place.
    platform.bus.setState('show.currentSlot', 3);
    await page.waitFor('document.querySelector("[data-kind=np] .name") && document.querySelector("[data-kind=np] .name").textContent === "BIA"', 1500);
    assert.equal(await page.eval('document.querySelector("[data-kind=np]").dataset.mark'), '1', 'the same card, not rebuilt');
    // A lineup edit and a settings edit rebuild the scene; the card comes back where it was.
    platform.bus.setState('show.lineup', [...state['show.lineup'], { time: '05:00', startAt: Date.now() + 300 * MIN, name: 'LATE ADD' }]);
    await sleep(300);
    await page.waitFor('!!document.querySelector("[data-kind=np]")', 1000);
    platform.overlays.updateSettings('tk', { tagline: 'NEW TAGLINE' });
    await sleep(300);
    await page.waitFor('!!document.querySelector("[data-kind=np]")', 1000);
    await take('lineup');
    await take('program');
    await page.waitFor('!!document.querySelector("[data-kind=np]")', 1000);
    // And it still ends with its window.
    await page.waitFor('!document.querySelector("[data-kind=np]")', 8000);
    assert.ok(Date.now() - t0 > 5000, `gone after ${Date.now() - t0} ms of a 7 s window`);
    assert.deepEqual(problems(page), []);
  });

  test('who\'s on follows the clock when nobody picked; a lineup edit shows at once; the timed intro is never rebuilt', opts, async (t) => {
    const state = night();
    delete state['show.currentSlot'];
    const { page, take, text, platform } = await open(t, { state });
    const lineup = state['show.lineup'].map((s) => (s.name === 'BIA' ? { ...s, startAt: Date.now() + 1500 } : s));
    platform.bus.setState('show.lineup', lineup);
    await take('lineup');
    const live = 'document.querySelector(".lineup .row.live .who > span") && document.querySelector(".lineup .row.live .who > span").textContent';
    await page.waitFor(`${live} === "Trapment"`);
    await page.waitFor(`${live} === "BIA"`, 4000);
    await take('pov');
    assert.deepEqual(await text('[data-who] .name'), ['BIA']);
    await take('lineup');
    platform.bus.setState('show.lineup', [...lineup, { time: '04:00', startAt: Date.now() + 200 * MIN, name: 'NEW ACT' }]);
    await page.waitFor('[...document.querySelectorAll(".lineup .who > span:first-child")].some((e) => e.textContent === "NEW ACT")');
    await take('intro');
    await page.eval('document.querySelector("[data-skp-scene-root=intro] .scene").dataset.mark = "1"');
    platform.overlays.updateSettings('tk', { tagline: 'CHANGED' });
    platform.bus.setState('show.headliner', 'BIA');
    await sleep(400);
    assert.equal(await page.eval('document.querySelector("[data-skp-scene-root=intro] .scene").dataset.mark'), '1', 'the intro runs on');
    assert.deepEqual(problems(page), []);
  });

  test('"Nobody on" (show.nobodyOn) names no act, whatever the clock says: a held Now playing goes, and comes back with the act picked', opts, async (t) => {
    const state = night();
    delete state['show.currentSlot'];
    const { page, take, text, trigger, platform } = await open(t, { state });
    await take('program');
    trigger('nowPlayingHold');
    const npName = (name) => `document.querySelector("[data-kind=np] .name") && document.querySelector("[data-kind=np] .name").textContent === ${JSON.stringify(name)}`;
    await page.waitFor(npName('Trapment'), 3000);
    platform.bus.setState('show.nobodyOn', true);
    await page.waitFor('!document.querySelector("[data-kind=np]")', 3000);
    await take('pov');
    assert.deepEqual(await text('[data-who] .name'), [], 'nobody, though Trapment\'s set has started by the clock');
    await take('program');
    platform.bus.setState('show.nobodyOn', undefined);
    platform.bus.setState('show.currentSlot', 3);
    await page.waitFor(npName('BIA'), 3000);
    assert.deepEqual(problems(page), []);
  });

  test('The Line\'s clip plays on through data and settings changes; one from another site is refused', opts, async (t) => {
    const clip = `/media/${FILE_ID}/line.mp4`;
    const { page, take, platform } = await open(t, { settings: { lineClip: clip }, state: night() });
    assert.throws(() => platform.overlays.updateSettings('tk', { lineClip: 'https://example.com/line.mp4' }), 'the overlay CSP could never play it');
    await take('line');
    await page.waitFor('!!document.querySelector(".line .clip video")');
    await page.eval('window.__clip = document.querySelector(".line .clip video"); document.querySelector(".line").dataset.mark = "1"; true');
    platform.bus.setState('show.currentSlot', 3);
    platform.bus.setState('show.headliner', 'UNDERCOVER');
    platform.bus.setState('show.lineup', [...night()['show.lineup'], { time: '06:00', startAt: Date.now() + 400 * MIN, name: 'X' }]);
    await sleep(400);
    assert.equal(await page.eval('document.querySelector(".line").dataset.mark'), '1', 'not rebuilt for data it doesn\'t show');
    assert.equal(await page.eval('document.querySelector(".line .clip video") === window.__clip'), true);
    platform.overlays.updateSettings('tk', { lineClip: clip, lineLabel: 'THE QUEUE' });
    await page.waitFor('document.querySelector(".line .scene-label") && document.querySelector(".line .scene-label").textContent === "THE QUEUE"');
    assert.equal(await page.eval('document.querySelector(".line .clip video") === window.__clip'), true, 'rebuilt, with the same clip moved in');
    // The file doesn't exist: no picture, no black plate over the camera.
    await page.waitFor('window.__clip.error !== null', 3000);
    assert.equal(await page.eval('getComputedStyle(document.querySelector(".line .clip")).backgroundColor'), 'rgba(0, 0, 0, 0)');
    assert.deepEqual(problems(page), []);
  });

  test('lite mode (phone previews) plays no video', opts, async (t) => {
    const { page, take, platform, overlay } = await open(t, { settings: { lineClip: `/media/${FILE_ID}/line.mp4` }, query: { lite: '1' } });
    await take('line');
    platform.bus.publish('media.play', { mediaId: 'med_x', url: `/media/${FILE_ID}/s.webm` }, { target: overlay.id });
    await take('program');
    platform.shows.fireOverlay('tk', 'linePlay');
    await sleep(700);
    assert.equal(await page.eval('document.querySelectorAll("video").length'), 0);
  });

  test('at most two endless animations per scene in idle, each on transform or opacity only (05 §5.8)', opts, async (t) => {
    for (const settings of [{ look: 'takeover', ticker: true }, { look: 'event' }, { look: 'event', starStyle: 'ghost' }, { look: 'event', starStyle: 'stamp' }]) {
      const { page, take, platform } = await open(t, { settings, state: night() });
      for (const scene of SCENES) {
        await take(scene);
        await sleep(650); // past the scene's own enter
        const loops = await page.eval(`(() => {
          const root = document.querySelector('[data-skp-scene-root]');
          return root.getAnimations({ subtree: true })
            .filter((a) => a.effect && a.effect.getTiming().iterations === Infinity)
            .map((a) => ({ name: a.animationName, props: [...new Set(a.effect.getKeyframes().flatMap((k) => Object.keys(k)))].filter((p) => !['offset', 'computedOffset', 'easing', 'composite'].includes(p)) }));
        })()`);
        const what = `${JSON.stringify(settings)} ${scene}: ${loops.map((l) => l.name).join(', ')}`;
        assert.ok(loops.length <= 2, what);
        for (const l of loops) assert.deepEqual(l.props.filter((p) => p !== 'transform' && p !== 'opacity'), [], `${what} (${l.name} animates ${l.props})`);
      }
      await platform.stop();
    }
  });

  test('names in any script, a quote in a poster URL, and markup in the lineup are shown as they are', opts, async (t) => {
    const now = Date.now();
    const lineup = [
      { time: '22:00', startAt: now - MIN, name: '宇多田' },
      { time: '23:00', startAt: now + MIN, name: '坂本', headliner: true },
      { time: '00:00', startAt: now + 2 * MIN, name: 'A<b>&</b>B', b2b: '<i>C</i>' },
    ];
    const poster = "https://example.invalid/vik's-poster.jpg";
    const { page, take, text, platform } = await open(t, { settings: { look: 'event', posterH: poster }, state: { 'show.lineup': lineup, 'show.headliner': '坂本' } });
    await take('starting');
    assert.deepEqual(await text('.vk-big'), ['坂本'], 'the headliner, not the first name with no Latin letters');
    assert.match(await page.eval('getComputedStyle(document.querySelector(".vk-poster")).backgroundImage'), /vik's-poster\.jpg/);
    await take('lineup');
    assert.equal(await page.eval('document.querySelectorAll(".vk-tt .row.head").length'), 1);
    const noMarkup = 'document.querySelectorAll("[data-skp-stage] b, [data-skp-stage] i:not(.x)").length === 0';
    assert.equal(await page.eval(noMarkup), true);
    assert.ok((await text('.vk-tt .n')).some((s) => s.includes('A<b>&</b>B') && s.includes('<i>C</i>')));
    platform.overlays.updateSettings('tk', { look: 'takeover' });
    await page.waitFor('document.documentElement.getAttribute("data-look") === "takeover" && !!document.querySelector(".lineup")');
    assert.equal(await page.eval(noMarkup), true);
    assert.ok((await text('.lineup .who')).some((s) => s.includes('A<b>&</b>B')));
    platform.bus.setState('show.currentSlot', 2);
    await take('pov');
    assert.deepEqual(await text('[data-who] .name'), ['A<b>&</b>B']);
    assert.equal(await page.eval(noMarkup), true);
    // Names with no letters at all must match exactly: two such names are two acts.
    platform.overlays.updateSettings('tk', { look: 'event', posterH: poster });
    platform.bus.setState('show.lineup', [{ time: '22:00', startAt: now, name: '✦✦✦' }, { time: '23:00', startAt: now + MIN, name: '★★★', headliner: true }]);
    platform.bus.setState('show.headliner', '★★★');
    await take('starting');
    await page.waitFor('document.querySelector(".vk-big") && document.querySelector(".vk-big").textContent === "★★★"');
    assert.deepEqual(problems(page).filter((p) => !/example\.invalid/.test(p)), []);
  });

  test('performers\' logos are fetched before an action first shows them', opts, async (t) => {
    const { page } = await open(t, { state: night() });
    await page.waitFor('performance.getEntriesByType("resource").some((e) => e.name.endsWith("/vikkstar.png"))', 3000);
  });
});

// What each page put on screen and took off, on this machine's clock (both pages share it): an
// action's graphic as it is mounted, with the act it names, and as it is removed.
const RECORD = `(() => {
  window.__seen = [];
  const name = (n) => ((n.querySelector('.djname, .t-name, .name, .who') || {}).textContent || '').trim();
  new MutationObserver((list) => {
    for (const m of list) {
      for (const n of m.addedNodes) if (n.nodeType === 1 && n.hasAttribute('data-kind')) window.__seen.push({ kind: n.getAttribute('data-kind'), name: name(n), at: Date.now() });
      for (const n of m.removedNodes) if (n.nodeType === 1 && n.hasAttribute('data-kind')) window.__seen.push({ kind: n.getAttribute('data-kind'), gone: Date.now() });
    }
  }).observe(document.body, { childList: true, subtree: true });
  return true;
})()`;
const seen = (page) => page.eval('window.__seen');
const near = (value, want, within, what) => assert.ok(Math.abs(value - want) <= within, `${what}: ${Math.round(value - want)} ms off`);

describe('v0\'s operator controls', () => {
  // The vertical page in a browser of its own, as each OBS source is: a browser's tab behind
  // another has its timers held back, which no source on air has.
  let second;
  const otherBrowser = async () => (second ??= await launchBrowser());
  after(async () => { if (second) await second.close(); });

  // On the night: one overlay for the horizontal canvas and one for the vertical, members of one
  // show, each page with its own envelope for every change the show makes.
  async function showPair(t, settings) {
    const ctx = await startWithOverlay(t, { slug: 'tk', template: TAKEOVER, settings });
    const { platform } = ctx;
    platform.overlays.create({ slug: 'tk-v', template: TAKEOVER, settings });
    platform.overlays.setKeyRequired('tk-v', false);
    const lineup = [{ time: '22:00', name: 'Trapment' }, { time: '23:00', name: 'BIA', b2b: 'DOLF' }, { time: '00:30', name: 'VIKKSTAR', headliner: true }];
    const show = platform.shows.create({ name: 'Saturday', overlays: ['tk', 'tk-v'], date: '2026-10-17', timezone: 'America/Toronto', lineup });
    platform.shows.setSlot(show.id, 0);
    platform.shows.take(show.id, 'program', { transition: 'cut' });
    const load = async (url, size, from = browser) => {
      const page = await from.open(url, size);
      defer(t, () => page.close().catch(() => {}));
      await page.waitFor('window.SK && SK.scene === "program" && !!document.querySelector("[data-skp-scene-root] .program")', 10000);
      await page.eval(RECORD);
      return page;
    };
    const h = await load(ctx.base, { width: 1920, height: 1080 });
    const v = await load(`${platform.url}/o/tk-v?canvas=v`, { width: 1080, height: 1920 }, await otherBrowser());
    return { ...ctx, show, h, v, load };
  }

  test('the title card and Now playing stay as long as the settings say, longer or shorter than the action\'s default', opts, async (t) => {
    const { page, take, platform } = await open(t, { settings: { cardSec: 9, npSec: 3 }, state: night() });
    await take('program');
    await page.eval(RECORD);
    // As the Live page and a cue fire them: the platform's trigger carries template.json's 7 s and 22 s.
    platform.shows.fireOverlay('tk', 'titleCard');
    platform.shows.fireOverlay('tk', 'nowPlaying');
    await page.waitFor('window.__seen.filter((s) => s.gone).length === 2', 12000);
    const list = await seen(page);
    const span = (kind) => list.find((s) => s.kind === kind && s.gone).gone - list.find((s) => s.kind === kind && s.at).at;
    near(span('np'), 3050, 400, 'Now playing for npSec, not 22 s');
    near(span('title'), 9050, 400, 'the title card for cardSec, past the action\'s 7 s');
    assert.deepEqual(problems(page), []);
  });

  test('Now playing (hold) stays until Hide, through a rebuild; Hide takes the title card with it', opts, async (t) => {
    const { page, take, platform } = await open(t, { settings: { npSec: 3 }, state: night() });
    await take('program');
    platform.shows.fireOverlay('tk', 'nowPlayingHold');
    await page.waitFor('!!document.querySelector("[data-kind=np]")', 3000);
    assert.equal(await page.eval('document.querySelector("[data-kind=np] .name").textContent'), 'Trapment');
    await sleep(4000); // past npSec, and past the 7 s a trigger without a duration of its own is given
    platform.overlays.updateSettings('tk', { npSec: 3, tagline: 'REBUILT' });
    await sleep(3500);
    assert.equal(await page.eval('!!document.querySelector("[data-kind=np]")'), true, 'held');
    platform.shows.fireOverlay('tk', 'titleCard');
    await page.waitFor('!!document.querySelector("[data-kind=title]")', 3000);
    const t0 = Date.now();
    platform.shows.fireOverlay('tk', 'hideCards');
    await page.waitFor('!document.querySelector("[data-kind=np], [data-kind=title]")', 3000);
    assert.ok(Date.now() - t0 < 1500, 'at once');
    // A timed Now playing after a hold is timed again.
    platform.shows.fireOverlay('tk', 'nowPlayingHold');
    await page.waitFor('!!document.querySelector("[data-kind=np]")', 3000);
    platform.shows.fireOverlay('tk', 'nowPlaying');
    await sleep(600);
    await page.waitFor('!document.querySelector("[data-kind=np]")', 4500);
    assert.deepEqual(problems(page), []);
  });

  test('a held Now playing and a title card from its button follow who\'s on, in place, on both canvases; one a cue names stays theirs', opts, async (t) => {
    const { platform, show, h, v } = await showPair(t, { cardSec: 30 });
    const names = '[...document.querySelectorAll("[data-kind=np] .name, [data-kind=title] .djname")].map((e) => e.textContent).join()';
    platform.shows.trigger(show.id, 'nowPlayingHold');
    platform.shows.trigger(show.id, 'titleCard');
    for (const page of [h, v]) await page.waitFor(`${names} === "Trapment,Trapment"`, 3000);
    // v0's Hold: pick who's on, and the card on air names them. No Hide, and no new entrance.
    platform.shows.setSlot(show.id, 1);
    for (const page of [h, v]) {
      await page.waitFor(`${names} === "BIA,BIA"`, 1500);
      assert.deepEqual(await page.eval('[...document.querySelectorAll("[data-kind=np] .b2b, [data-kind=title] .djb2b")].map((e) => e.textContent)'), ['B2B DOLF', 'B2B DOLF']);
      assert.equal((await seen(page)).filter((s) => s.at).length, 2, 'each card came on once');
    }
    platform.shows.trigger(show.id, 'titleCard', { args: { name: 'Trapment' } });
    await h.waitFor('document.querySelectorAll("[data-kind=title]").length === 1 && document.querySelector("[data-kind=title] .djname").textContent === "Trapment"', 3000);
    platform.shows.setSlot(show.id, 2);
    await h.waitFor('document.querySelector("[data-kind=np] .name").textContent === "VIKKSTAR"', 1500);
    assert.equal(await h.eval('document.querySelector("[data-kind=title] .djname").textContent'), 'Trapment');
    assert.deepEqual([...problems(h), ...problems(v)], []);
  });

  test('the title card by itself: on both canvases on the same frame, timed from the server\'s change, then Now playing; a reload replays nothing', opts, async (t) => {
    const { platform, show, h, v, load } = await showPair(t, { autoCard: true, autoCardSec: 3, cardSec: 2, npSec: 3 });
    // The vertical page is busy when the act changes, so it hears of it 1.5 s late (a slow OBS, a
    // poll): timed from when it heard, its card would come 1.5 s after the other's.
    const busy = v.eval('(() => { const end = Date.now() + 1500; while (Date.now() < end) {} return true; })()');
    await sleep(100);
    const t0 = Date.now();
    platform.shows.setSlot(show.id, 1);
    await busy;
    for (const page of [h, v]) await page.waitFor('window.__seen.some((s) => s.kind === "np")', 8000);
    const [hs, vs] = [await seen(h), await seen(v)];
    const first = (list, kind) => list.find((s) => s.kind === kind && s.at);
    for (const [list, canvas] of [[hs, 'h'], [vs, 'v']]) {
      assert.deepEqual([first(list, 'title').name, first(list, 'np').name], ['BIA', 'BIA'], canvas);
      near(first(list, 'title').at, t0 + 3000, 500, `${canvas}: the title card autoCardSec after the change`);
      near(first(list, 'np').at, t0 + 5000, 500, `${canvas}: Now playing as the card ends`);
    }
    near(first(hs, 'title').at, first(vs, 'title').at, 250, 'the same frame on both canvases');
    // A page loaded afterwards doesn't know when BIA came on: it shows nothing for them.
    await h.close();
    const again = await load(`${platform.url}/o/tk`, { width: 1920, height: 1080 });
    await sleep(5000);
    assert.deepEqual(await seen(again), []);
    assert.equal((await seen(v)).filter((s) => s.at).length, 2, 'and the other page nothing again');
    assert.deepEqual([...problems(again), ...problems(v)], []);
  });

  test('with nobody picked, the clock\'s act gets theirs: their set\'s start plus the delay, on both canvases', opts, async (t) => {
    const state = night();
    delete state['show.currentSlot'];
    const { page, take, platform, base } = await open(t, { settings: { autoCard: true, autoCardSec: 2, cardSec: 2 }, state });
    const v = await (await otherBrowser()).open(`${base}?canvas=v`, { width: 1080, height: 1920 });
    defer(t, () => v.close().catch(() => {}));
    await take('program');
    await v.waitFor('SK.scene === "program" && !!document.querySelector("[data-skp-scene-root] .program")');
    for (const p of [page, v]) await p.eval(RECORD);
    const startAt = Date.now() + 1500;
    platform.bus.setState('show.lineup', state['show.lineup'].map((s) => (s.name === 'BIA' ? { ...s, startAt } : s)));
    for (const p of [page, v]) await p.waitFor('window.__seen.some((s) => s.kind === "title")', 6000);
    for (const p of [page, v]) {
      const card = (await seen(p)).find((s) => s.kind === 'title');
      assert.equal(card.name, 'BIA');
      near(card.at, startAt + 2000, 500, 'the set\'s start plus autoCardSec');
    }
    assert.deepEqual([...problems(page), ...problems(v)], []);
  });

  test('the automatic card isn\'t shown twice: a title card for that act since they came on (the timeline\'s) stands for it, with no delay too; off, nothing shows', opts, async (t) => {
    const { platform, show, h, v } = await showPair(t, { autoCard: true, autoCardSec: 0, cardSec: 2, npSec: 3 });
    const shown = async (page) => (await seen(page)).filter((s) => s.at).map((s) => [s.kind, s.name]);
    const settings = async (values) => {
      for (const slug of ['tk', 'tk-v']) platform.overlays.updateSettings(slug, values);
      for (const page of [h, v]) await page.waitFor(`SK.settings.autoCard === ${values.autoCard === true} && SK.settings.autoCardSec === ${values.autoCardSec}`);
    };
    // What "Build from lineup" fires at a set's start: who's on, then their title card, which
    // starts a moment after the change. With no delay, the card by itself still waits for it.
    platform.shows.setSlot(show.id, 'BIA');
    platform.shows.trigger(show.id, 'titleCard', { args: { name: 'BIA' } });
    await sleep(4500);
    for (const page of [h, v]) assert.deepEqual(await shown(page), [['title', 'BIA']], 'one title card, and no Now playing after it');
    await settings({ autoCard: true, autoCardSec: 2, cardSec: 2, npSec: 3 });
    platform.shows.setSlot(show.id, 'VIKKSTAR');
    platform.shows.trigger(show.id, 'titleCard', { args: { name: 'VIKKSTAR' } });
    await sleep(5500);
    assert.deepEqual(await shown(h), [['title', 'BIA'], ['title', 'VIKKSTAR']]);
    // Switched off (the default), a pick brings nothing.
    await settings({ autoCardSec: 2, cardSec: 2, npSec: 3 });
    platform.shows.setSlot(show.id, 'Trapment');
    await sleep(3500);
    assert.equal((await shown(h)).length, 2);
    assert.deepEqual([...problems(h), ...problems(v)], []);
  });

  test('Play The Line\'s clip shows it under every scene until Stop, one video throughout; The Line itself plays on', opts, async (t) => {
    const clip = `/media/${FILE_ID}/line.mp4`;
    const { page, take, platform } = await open(t, { state: night() });
    const layer = 'document.querySelector("[data-clip]")';
    await take('program');
    platform.shows.fireOverlay('tk', 'linePlay');
    await sleep(500);
    assert.equal(await page.eval(`${layer}.classList.contains("hide") && !${layer}.querySelector("video")`), true, 'no clip set: nothing');
    platform.overlays.updateSettings('tk', { lineClip: clip });
    await page.waitFor(`SK.settings.lineClip === ${JSON.stringify(clip)}`);
    platform.shows.fireOverlay('tk', 'linePlay');
    await page.waitFor(`!${layer}.classList.contains("hide") && !!${layer}.querySelector("video")`, 3000);
    await page.eval(`window.__clip = ${layer}.querySelector("video"); true`);
    assert.equal(await page.eval('window.__clip.getAttribute("src")'), clip);
    assert.equal(await page.eval('window.__clip.loop'), true);
    // Taking The Line keeps it where it is (no restart, no dip in the crossfade).
    await take('line');
    assert.equal(await page.eval(`window.__clip.parentNode === ${layer} && !document.querySelector(".line .clip video")`), true);
    // Stop on The Line: the scene's own clip plays on, as in v0: the same video, moved in.
    platform.shows.fireOverlay('tk', 'lineStop');
    await page.waitFor(`${layer}.classList.contains("hide") && document.querySelector(".line .clip video") === window.__clip`, 3000);
    await take('program');
    assert.equal(await page.eval(`${layer}.classList.contains("hide")`), true);
    // Play again: the same video back in the layer; Stop pauses it there.
    platform.shows.fireOverlay('tk', 'linePlay');
    await page.waitFor(`!${layer}.classList.contains("hide") && ${layer}.querySelector("video") === window.__clip`, 3000);
    platform.shows.fireOverlay('tk', 'lineStop');
    await page.waitFor(`${layer}.classList.contains("hide") && window.__clip.paused`, 3000);
    // The Line's clip played as media (a v0 cue imported) is the same Play, and media.stop its Stop.
    const send = (type, data) => platform.bus.publish(type, data, { target: platform.overlays.resolve('tk').doc.id });
    send('media.play', { mediaId: 'med_x', url: clip });
    await page.waitFor(`!${layer}.classList.contains("hide") && ${layer}.querySelectorAll("video").length === 1 && ${layer}.querySelector("video") === window.__clip`, 3000);
    send('media.stop', {});
    await page.waitFor(`${layer}.classList.contains("hide")`, 3000);
    assert.deepEqual(problems(page), []);
  });

  test('the event look\'s switches: the opening and on-at chips, and Now playing', opts, async (t) => {
    const { page, take, platform } = await open(t, { settings: { look: 'event', scheduleChips: false, nowPlayingBar: false }, state: night() });
    await take('program');
    for (const name of ['chipOpening', 'nowPlaying', 'titleCard']) platform.shows.fireOverlay('tk', name);
    await page.waitFor('!!document.querySelector("[data-kind=title]")', 3000);
    await sleep(400);
    assert.equal(await page.eval('!!document.querySelector("[data-kind=chip], [data-kind=np]")'), false, 'both off; the title card still shows');
    platform.overlays.updateSettings('tk', { look: 'event' });
    await page.waitFor('SK.settings.scheduleChips === true && SK.settings.nowPlayingBar === true');
    for (const name of ['chipOpening', 'nowPlaying']) platform.shows.fireOverlay('tk', name);
    await page.waitFor('!!document.querySelector("[data-kind=chip]") && !!document.querySelector("[data-kind=np]")', 3000);
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
    // Its settings change live.
    platform.overlays.updateSettings('tk', { label: 'online', accent: '#36D67B' });
    await page.waitFor('document.querySelector(".viewers .label").textContent === "online" && getComputedStyle(document.documentElement).getPropertyValue("--dot").trim().toLowerCase() === "#36d67b"');
    platform.bus.setState('viewers.total', undefined);
    await page.waitFor('document.querySelector(".viewers").hidden');
    assert.deepEqual(problems(page), []);
  });
});
