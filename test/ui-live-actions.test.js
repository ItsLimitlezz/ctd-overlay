// Live's actions and template versions on show night, in a real browser on a phone (08 §8.4), with
// the TAKEOVER template: a pressed action says what it did (a timed one is on air, a held card until
// hidden, Hide and Stop done, any other sent); outside a show only the cards that name the act on
// now say they have no act to name, and nothing is said to be on air; Play The Line's clip with no
// clip chosen says so rather than claim it played; a chip outside the event look says it shows
// nothing, and why, pressed and under the buttons; in a show half upgraded, an action says which
// overlay it didn't reach. Who's on: the lineup's times while nobody is picked, Next act early
// saying what it skipped, Nobody on meaning nobody; Auto past its go-live with no REC said. An overlay on an older version of its template than the newest installed says so quietly,
// on its stream's card and in its console, with a link to its Version tab: a show's overlays of one
// template upgraded together, before going live; once it is live, after the show. With no sideways
// scrolling and no console error.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startPlatform } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { browserSkip, launchBrowser } from './cdp.js';
import { defer, memoryLogger, signedIn, tempDir } from './helpers.js';

const OWNER = { username: 'juan', password: 'correct horse battery staple' };
const SHOW = { date: '2026-10-17', timezone: 'America/Toronto' };
const opts = { skip: browserSkip, timeout: 180000 };
// The TAKEOVER template that ships with the platform, at the version it ships at.
const TAKEOVER_DIR = fileURLToPath(new URL('../templates/takeover/', import.meta.url));
const MANIFEST = JSON.parse(readFileSync(path.join(TAKEOVER_DIR, 'template.json'), 'utf8'));
const TAKEOVER = { id: MANIFEST.id, version: MANIFEST.version };
// Its 1.0.0, as a NAS set up before 1.1.0 keeps it for the overlays pinned to it: without the held
// Now playing, Hide, and Play / Stop for The Line's clip.
const OLD = { id: MANIFEST.id, version: '1.0.0' };
const OLD_ACTIONS = MANIFEST.actions.filter((a) => ['titleCard', 'nowPlaying', 'chipOpening', 'chipOnAt'].includes(a.id));
// The Line's clip, as an uploaded file's URL (the file itself isn't needed: a phone's previews are lite).
const CLIP = '/media/med_line/the-line.mp4';

// A platform (with TAKEOVER 1.0.0 beside the shipped one when `old`), its owner signed in in a
// browser page at a phone's size.
async function start(t, { old = false } = {}) {
  const root = tempDir(t);
  const templateDirs = [];
  if (old) {
    const dir = path.join(root, 'templates', 'takeover-1.0.0');
    cpSync(TAKEOVER_DIR, dir, { recursive: true });
    writeFileSync(path.join(dir, 'template.json'), JSON.stringify({ ...MANIFEST, version: OLD.version, actions: OLD_ACTIONS }, null, 2));
    templateDirs.push(path.dirname(dir));
  }
  const config = loadConfig({ argv: ['--port', '0'], env: { SKP_DATA_DIR: path.join(root, 'data'), SKP_CONFIG_DIR: path.join(root, 'config') } });
  const platform = await startPlatform(config, { log: memoryLogger().log, scrypt: { N: 1024 }, templateDirs });
  defer(t, () => platform.stop());
  await platform.auth.createOwner({ code: platform.auth.setupCode, ...OWNER }, { ip: '127.0.0.1' });
  const api = async (method, p, body, headers = {}) => {
    const res = await fetch(`${platform.url}/api/v1${p}`, { method, headers: signedIn(platform, { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }), body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null), etag: res.headers.get('etag') };
  };
  const browser = await launchBrowser(t);
  const page = await browser.open(`${platform.url}/#/login`, { width: 390, height: 844 });
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await page.waitFor('document.querySelector("input[name=username]")', 15000);
  assert.equal(await page.eval(`fetch('/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(${JSON.stringify(OWNER)}) }).then((r) => r.status)`), 200);
  const before = page.problems.length; // the sign-in page's own 401 for "who am I" is expected
  // Every action sent: its path and body.
  await page.send('Network.enable');
  const fired = [];
  const off = browser.cdp.on((m) => {
    if (m.method !== 'Network.requestWillBeSent' || m.params.request.method !== 'POST') return;
    const p = new URL(m.params.request.url).pathname;
    if (/\/(actions|triggers)\//.test(p)) fired.push({ path: p, body: m.params.request.postData ? JSON.parse(m.params.request.postData) : undefined });
  });
  t.after(off);
  const problems = () => page.problems.slice(before).filter((p) => !p.startsWith('network:'));
  return { platform, api, page, fired, problems };
}

const click = (page, selector, text) => page.eval(`(() => {
  const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((b) => !b.closest('[hidden]') && (b.textContent.trim() === ${JSON.stringify(text)} || b.getAttribute('aria-label') === ${JSON.stringify(text)}));
  if (!el) throw new Error('nothing to click: ' + ${JSON.stringify(`${selector} ${text}`)});
  el.click();
})()`);
// A toast whose words are exactly these (an error one, when kind is "error").
const toastSaid = (page, text, kind) => page.waitFor(`[...document.querySelectorAll(".toast")].some((t) => t.querySelector("span").textContent === ${JSON.stringify(text)} && ${kind === 'error' ? 't.classList.contains("error")' : '!t.classList.contains("error")'})`, 8000);
const sideways = (page) => page.eval('document.documentElement.scrollWidth > innerWidth + 1');
const notes = (page, root = '[data-view]') => page.eval(`[...document.querySelectorAll(${JSON.stringify(`${root} .upgrade-note`)})].map((p) => p.textContent)`);

test('Live: an action says what it did, timed, held or sent; outside a show only the title cards have no act to name; Play The Line\'s clip with no clip says so', opts, async (t) => {
  const { platform, api, page, fired, problems } = await start(t);
  platform.overlays.create({ slug: 'tk-h', template: TAKEOVER, settings: { lineClip: CLIP } });
  platform.overlays.create({ slug: 'tk-v', template: TAKEOVER, settings: {} });
  platform.overlays.create({ slug: 'solo', template: TAKEOVER, settings: {} });
  const night = platform.shows.create({ name: 'Saturday', overlays: ['tk-h', 'tk-v'], ...SHOW }, { actor: 'test' });

  // ---- the show's console: what each button did --------------------------------------------------
  await page.goto(`${platform.url}/?signed=1#/live?show=${night.id}`);
  await page.waitFor('document.querySelector("[data-view] [role=group][aria-label=Actions] button")', 15000);
  const press = (label) => click(page, '[data-view] [role=group][aria-label="Actions"] button', label);
  await press('DJ title card');
  await toastSaid(page, 'DJ title card on air');
  await press('Now playing (hold)');
  await toastSaid(page, 'Now playing (hold) on air until hidden');
  await press('Hide title card and now playing');
  await toastSaid(page, 'Title card and now playing hidden');
  // The chips show in the event look only: said under the buttons, and when pressed.
  assert.match(await page.eval('[...document.querySelectorAll("[data-view] .card")].find((c) => c.querySelector("h2")?.textContent === "Actions").innerText'), /Opening DJ chip and Headliner on-at chip show nothing now: the chips show in the Headliner event look only\./);
  await press('Opening DJ chip');
  await toastSaid(page, 'Opening DJ chip sent, but it shows nothing: the chips show in the Headliner event look only.');
  // The Line's clip: chosen on one overlay only, then on both, then on neither.
  await press('Play The Line\'s clip');
  await toastSaid(page, 'Play The Line\'s clip sent. The Line\'s clip isn\'t set on tk-v, so nothing plays there: choose one in its settings.');
  const v = await api('GET', '/overlays/tk-v');
  assert.equal((await api('PATCH', '/overlays/tk-v', { settings: { lineClip: CLIP } }, { 'if-match': v.etag })).status, 200);
  await press('Play The Line\'s clip');
  await toastSaid(page, 'Play The Line\'s clip sent');
  for (const slug of ['tk-h', 'tk-v']) {
    const o = await api('GET', `/overlays/${slug}`);
    assert.equal((await api('PATCH', `/overlays/${slug}`, { settings: {} }, { 'if-match': o.etag })).status, 200);
  }
  await press('Play The Line\'s clip');
  await toastSaid(page, 'The Line\'s clip isn\'t set on tk-h or tk-v, so nothing plays. Choose one in each overlay\'s settings.', 'error');
  await press('Stop The Line\'s clip');
  await toastSaid(page, 'The Line\'s clip stopped');
  // Every press was sent to the show, with no act named.
  const trigger = (name) => `/api/v1/shows/${night.id}/triggers/${name}`;
  assert.deepEqual(fired.map((f) => f.path), ['titleCard', 'nowPlayingHold', 'hideCards', 'chipOpening', 'linePlay', 'linePlay', 'linePlay', 'lineStop'].map(trigger));
  assert.ok(fired.every((f) => JSON.stringify(f.body) === '{}'));

  // One of its overlays chosen: the same words, with its name.
  await page.eval(`location.hash = ${JSON.stringify(`#/live?show=${night.id}&overlay=tk-h`)}`);
  await page.waitFor('document.querySelector("[data-view] [role=group][aria-label=\'Actions of tk-h\']")', 15000);
  await click(page, '[data-view] [role=group][aria-label="Actions of tk-h"] button', 'Now playing (hold)');
  await toastSaid(page, 'tk-h: Now playing (hold) on air until hidden');
  await click(page, '[data-view] [role=group][aria-label="Actions of tk-h"] button', 'Opening DJ chip');
  await toastSaid(page, 'tk-h: Opening DJ chip sent, but it shows nothing: the chips show in the Headliner event look only.');
  // In the event look, with the chips on: on air, and nothing said under the buttons.
  const h = await api('GET', '/overlays/tk-h');
  assert.equal((await api('PATCH', '/overlays/tk-h', { settings: { look: 'event' } }, { 'if-match': h.etag })).status, 200);
  await page.waitFor('![...document.querySelectorAll("[data-view] section.card")].find((c) => c.querySelector("h2")?.textContent === "Actions")?.innerText.includes("show nothing now")', 8000);
  await click(page, '[data-view] [role=group][aria-label="Actions of tk-h"] button', 'Opening DJ chip');
  await toastSaid(page, 'tk-h: Opening DJ chip on air');
  await click(page, '[data-view] [role=group][aria-label="Actions of tk-h"] button', 'Play The Line\'s clip');
  await toastSaid(page, 'tk-h: The Line\'s clip isn\'t set, so nothing plays. Choose one in the overlay\'s settings.', 'error');
  assert.equal(await sideways(page), false, 'no sideways scrolling');

  // ---- outside a show: only the cards that name the act on now have no act to name ---------------
  await page.eval('location.hash = "#/live?overlay=solo"');
  await page.waitFor('document.querySelector("[data-view] h1")?.textContent === "solo" && document.querySelector("[data-view] [role=group][aria-label=\'Actions of solo\']")', 15000);
  const actions = await page.eval('[...document.querySelectorAll("[data-view] section.card")].find((c) => c.querySelector("h2")?.textContent === "Actions").innerText');
  assert.match(actions, /This overlay isn't in a show, so DJ title card, Now playing and Now playing \(hold\) have no act to name: they show nothing\./);
  const pressSolo = (label) => click(page, '[data-view] [role=group][aria-label="Actions of solo"] button', label);
  await pressSolo('DJ title card');
  await toastSaid(page, 'solo: DJ title card sent. It has no act to name until the overlay is in a show.');
  await pressSolo('Now playing (hold)');
  await toastSaid(page, 'solo: Now playing (hold) sent. It has no act to name until the overlay is in a show.');
  await pressSolo('Hide title card and now playing');
  await toastSaid(page, 'solo: Title card and now playing hidden');
  // A chip reads the lineup too: sent, not on air (and in this look it shows nothing anyway).
  await pressSolo('Opening DJ chip');
  await toastSaid(page, 'solo: Opening DJ chip sent, but it shows nothing: the chips show in the Headliner event look only.');
  await pressSolo('Play The Line\'s clip');
  await toastSaid(page, 'solo: The Line\'s clip isn\'t set, so nothing plays. Choose one in the overlay\'s settings.', 'error');
  // Its clip chosen: sent.
  const solo = await api('GET', '/overlays/solo');
  assert.equal((await api('PATCH', '/overlays/solo', { settings: { lineClip: CLIP } }, { 'if-match': solo.etag })).status, 200);
  await pressSolo('Play The Line\'s clip');
  await toastSaid(page, 'solo: Play The Line\'s clip sent');
  const soloId = platform.overlays.resolve('solo').doc.id;
  assert.deepEqual(fired.filter((f) => f.path.includes(soloId)).map((f) => f.path.split('/').at(-1)), ['titleCard', 'nowPlayingHold', 'hideCards', 'chipOpening', 'linePlay', 'linePlay']);
  assert.equal(await sideways(page), false, 'no sideways scrolling');
  assert.deepEqual(problems(), []);
});

test('Live, who\'s on: with nobody picked, the act the lineup\'s times are in; Next act early skips what was still to come for the acts before, said with it; on Auto past its go-live with no REC, said', opts, async (t) => {
  const { platform, api, page, problems } = await start(t);
  platform.overlays.create({ slug: 'tk', template: TAKEOVER, settings: {} });
  // Tonight in Toronto, on the real clock: the day starts two hours ago, so every time below is
  // that night's.
  const MIN = 60000;
  const ZONE = 'America/Toronto';
  const wall = (ms) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: ZONE, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour === '24' ? '00' : p.hour}:${p.minute}` };
  };
  const now = Date.now();
  const day = wall(now - 120 * MIN);
  const lineup = [{ time: wall(now - 30 * MIN).time, name: 'Opener' }, { time: wall(now + 60 * MIN).time, name: 'Headliner DJ' }, { time: wall(now + 150 * MIN).time, name: 'Closer DJ' }];
  // Made after its go-live: on Auto, with no REC.
  const made = await api('POST', '/shows', { name: 'Fast test', overlays: ['tk'], date: day.date, timezone: ZONE, dayBoundary: day.time, goLive: wall(now - 60 * MIN).time, lineup });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const id = made.body.id;
  assert.equal((await api('POST', `/shows/${id}/cues/build`, {})).status, 200);
  await page.goto(`${platform.url}/?signed=1#/live?show=${id}`);
  await page.waitFor('document.querySelector("[data-view] h1")?.textContent === "Fast test" && document.querySelector("[data-view] .card h2")', 15000);
  const card = (title) => page.eval(`[...document.querySelectorAll('[data-view] .card')].find((c) => c.querySelector('h2')?.textContent === ${JSON.stringify(title)})?.innerText || ''`);
  assert.match(await page.eval('document.querySelector("[data-view] .card").innerText'), /On Auto past its go-live \(.+\), the overlays show the show live, with no REC timecode\. Start REC counts from now; taking Auto again counts from .+\./);
  assert.match(await card('Who\'s on'), /Nobody picked yet: by the lineup's times, it is Opener's set\./);
  assert.equal(await page.eval('[...document.querySelectorAll("[data-view] button")].find((b) => b.textContent.startsWith("Next act")).textContent'), 'Next act: Opener', 'the act whose set it is');
  await click(page, '[data-view] button', 'Next act: Opener');
  await toastSaid(page, 'Opener is on');
  // Early: the headliner on an hour before their set. Opener's cues still to come are skipped.
  await page.waitFor('[...document.querySelectorAll("[data-view] button")].some((b) => b.textContent === "Next act: Headliner DJ" && !b.disabled)', 8000);
  await click(page, '[data-view] button', 'Next act: Headliner DJ');
  await page.waitFor('[...document.querySelectorAll(".toast span")].some((s) => /^Headliner DJ is on\\. \\d+ cues? still to come for Opener (was|were) skipped$/.test(s.textContent))', 8000);
  const cues = (await api('GET', `/shows/${id}/cues?limit=200`)).body.items;
  assert.ok(cues.filter((c) => c.label?.startsWith('Opener')).every((c) => c.status !== 'armed'), 'nothing of Opener\'s left to fire');
  assert.match(await card('Timeline'), /Headliner DJ/);
  // Nobody on: nobody, whatever the times say; Next act is the act whose set it is.
  await click(page, '[data-view] button', 'Nobody on');
  await toastSaid(page, 'Nobody is on now');
  await page.waitFor('document.querySelector("[data-view]").innerText.includes("Nobody is on.")', 8000);
  assert.equal(platform.overlays.resolve('tk').channel.snapshot().state['show.nobodyOn'], true);
  assert.equal(await sideways(page), false);
  assert.deepEqual(problems(), []);
});

test('Live: overlays on an older version of their template say so quietly, on the card and in the console, with a link to the Version tab: together before going live, after the show once live; a show half upgraded says which overlay an action didn\'t reach', opts, async (t) => {
  const { platform, api, page, problems } = await start(t, { old: true });
  const NEW = TAKEOVER.version;
  // Both overlays of the show on 1.0.0; another show half upgraded; one overlay alone on each version.
  for (const slug of ['takeover', 'takeover-v', 'twin-v', 'lone']) platform.overlays.create({ slug, template: OLD, settings: {} });
  for (const slug of ['twin-h', 'fresh']) platform.overlays.create({ slug, template: TAKEOVER, settings: {} });
  const saturday = platform.shows.create({ name: 'DPRTMNT Saturday', overlays: ['takeover', 'takeover-v'], ...SHOW }, { actor: 'test' });
  const twins = platform.shows.create({ name: 'Twins', overlays: ['twin-h', 'twin-v'], ...SHOW }, { actor: 'test' });
  const together = `takeover and takeover-v are on version 1.0.0 of D/PRTMNT TAKEOVER, and ${NEW} is installed: upgrade them together, each on its Version tab, before going live.`;
  const too = `twin-v is on version 1.0.0 of D/PRTMNT TAKEOVER, and ${NEW} is installed: upgrade it too, on its Version tab, before going live.`;
  const alone = `lone is on version 1.0.0 of D/PRTMNT TAKEOVER, and ${NEW} is installed: upgrade it on its Version tab before going live.`;

  // ---- the streams page: a quiet line on each card with one behind ---------------------------------
  await page.goto(`${platform.url}/?signed=1#/live`);
  await page.waitFor('document.querySelectorAll("[data-view] .stream-card").length === 4 && document.querySelectorAll("[data-view] .stream-card .upgrade-note").length === 3', 15000);
  const card = (name) => page.eval(`(() => {
    const c = [...document.querySelectorAll('[data-view] .stream-card')].find((x) => x.querySelector('h2').textContent === ${JSON.stringify(name)});
    return { notes: [...c.querySelectorAll('.upgrade-note')].map((p) => ({ text: p.textContent, muted: p.classList.contains('muted'), links: [...p.querySelectorAll('a')].map((a) => [a.textContent, a.getAttribute('href')]) })) };
  })()`);
  assert.deepEqual(await card('DPRTMNT Saturday'), { notes: [{ text: together, muted: true, links: [['takeover', '#/overlays/takeover?tab=version'], ['takeover-v', '#/overlays/takeover-v?tab=version']] }] });
  assert.deepEqual(await card('Twins'), { notes: [{ text: too, muted: true, links: [['twin-v', '#/overlays/twin-v?tab=version']] }] });
  assert.deepEqual(await card('lone'), { notes: [{ text: alone, muted: true, links: [['lone', '#/overlays/lone?tab=version']] }] });
  assert.deepEqual(await card('fresh'), { notes: [] }, 'on the newest: nothing said');
  assert.equal(await page.eval('document.querySelectorAll("[data-view] .upgrade-note").length === document.querySelectorAll("[data-view] .upgrade-note.small.muted").length && !document.querySelector("[data-view] .stream-card .upgrade-slot .notice")'), true, 'quiet: no notice');
  assert.equal(await sideways(page), false, 'no sideways scrolling');

  // ---- a show's console: the why too; once live, after the show --------------------------------
  await page.eval(`location.hash = ${JSON.stringify(`#/live?show=${saturday.id}`)}`);
  await page.waitFor('document.querySelector("[data-view] h1")?.textContent === "DPRTMNT Saturday" && document.querySelector("[data-view] .upgrade-note")', 15000);
  assert.deepEqual(await notes(page), [`${together} Half upgraded, an action reaches only some of them, and their settings differ.`]);
  assert.equal(await page.eval('!!document.querySelector("[data-view] .upgrade-note").closest(".card")?.querySelector(".stream-status")'), true, 'with the show\'s status');
  assert.equal((await api('POST', `/shows/${saturday.id}/rec`, { action: 'start' })).status, 200);
  const after = `takeover and takeover-v are on version 1.0.0 of D/PRTMNT TAKEOVER, and ${NEW} is installed: upgrade them, each on its Version tab, after the show, since an upgrade reloads them in OBS.`;
  await page.waitFor(`[...document.querySelectorAll("[data-view] .upgrade-note")].map((p) => p.textContent).join() === ${JSON.stringify(after)}`, 8000);
  assert.equal(await sideways(page), false, 'no sideways scrolling');

  // ---- half upgraded: the console says so, and an action says what it didn't reach ---------------
  await page.eval(`location.hash = ${JSON.stringify(`#/live?show=${twins.id}`)}`);
  await page.waitFor('document.querySelector("[data-view] h1")?.textContent === "Twins" && document.querySelector("[data-view] .upgrade-note") && document.querySelector("[data-view] [role=group][aria-label=Actions] button")', 15000);
  assert.deepEqual(await notes(page), [`${too} Until then, an action reaches only some of the show's overlays of that template, and their settings differ.`]);
  const press = (label) => click(page, '[data-view] [role=group][aria-label="Actions"] button', label);
  await press('Hide title card and now playing');
  await toastSaid(page, 'Title card and now playing hidden. It didn\'t reach twin-v: its version of the template doesn\'t have it.');
  await press('DJ title card');
  await toastSaid(page, 'DJ title card on air');

  // ---- an overlay alone: its console says it; the link opens its Version tab -------------------------
  await page.eval('location.hash = "#/live?overlay=lone"');
  await page.waitFor('document.querySelector("[data-view] h1")?.textContent === "lone" && document.querySelector("[data-view] .upgrade-note")', 15000);
  assert.deepEqual(await notes(page), [alone]);
  await page.eval('location.hash = "#/live?overlay=fresh"');
  await page.waitFor('document.querySelector("[data-view] h1")?.textContent === "fresh" && document.querySelector("[data-view] [role=group][aria-label=\'Actions of fresh\']")', 15000);
  assert.deepEqual(await notes(page), [], 'on the newest: nothing said');
  await page.eval('location.hash = "#/live?overlay=lone"');
  await page.waitFor('document.querySelector("[data-view] h1")?.textContent === "lone" && document.querySelector("[data-view] .upgrade-note a")', 15000);
  await click(page, '[data-view] .upgrade-note a', 'lone');
  await page.waitFor('location.hash === "#/overlays/lone?tab=version" && document.querySelector("#tab-version")?.getAttribute("aria-selected") === "true" && [...document.querySelectorAll("[data-view] button")].some((b) => b.textContent === "Upgrade…")', 15000);
  assert.equal(await sideways(page), false, 'no sideways scrolling');
  // The upgrade says what the new version brings: its new buttons, and what Play needs.
  await click(page, '[data-view] button', 'Upgrade…');
  await page.waitFor('document.querySelector("dialog[open] h3")', 10000);
  const brings = await page.eval('(() => { const h = [...document.querySelectorAll("dialog[open] h3")].find((x) => x.textContent === "New in this version"); return h ? [...h.nextElementSibling.querySelectorAll("li")].map((li) => li.textContent) : []; })()');
  assert.deepEqual(brings, [
    '"Now playing (hold)": a new button on Live, and something a cue can do; in the Headliner event look it shows only with "Now playing lower third" on.',
    '"Hide title card and now playing": a new button on Live, and something a cue can do.',
    '"Play The Line\'s clip": a new button on Live, and something a cue can do; it plays the clip chosen in the overlay\'s settings ("The Line · clip", a video uploaded in Media), so choose one before the show.',
    '"Stop The Line\'s clip": a new button on Live, and something a cue can do.',
  ]);
  await click(page, 'dialog[open] button', 'Cancel');
  assert.deepEqual(problems(), []);
});
