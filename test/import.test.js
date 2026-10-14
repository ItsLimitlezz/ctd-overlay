// The v0 importer (src/import/v0.js, `skp import v0`): a D/PRTMNT Stream Kit data directory becomes
// a show, its TAKEOVER overlay, the Line clip, the timeline, planned dates and kept credentials.
// The fixtures under test/fixtures/v0/ are in v0's own formats: full (a real directory the week
// of a VIKKSTAR night), cfg-only (an install from before kit.json, its event in the legacy
// evParams form) and messy (every field of the wrong type, broken files).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openData } from '../src/app.js';
import { cliActor } from '../src/auth/audit.js';
import { run } from '../src/cli.js';
import { loadConfig } from '../src/config.js';
import { decodeCfg, ImportError, mapV0, matchHeadliner, PENDING_CONNECTIONS, readV0, upgradeSetup } from '../src/import/v0.js';
import { mediaUrl } from '../src/media/library.js';
import { resolveTime } from '../src/shows/time.js';
import { auditOf, DIAG, memoryLogger, tempDir } from './helpers.js';

const FIXTURES = fileURLToPath(new URL('./fixtures/v0/', import.meta.url));
const FULL = path.join(FIXTURES, 'full');
const CFG_ONLY = path.join(FIXTURES, 'cfg-only');
const MESSY = path.join(FIXTURES, 'messy');
const MANIFEST = JSON.parse(readFileSync(new URL('../templates/takeover/template.json', import.meta.url), 'utf8'));
const NO_FFMPEG = path.join(fileURLToPath(new URL('.', import.meta.url)), 'no-such-ffmpeg-here');
const FAKE_FFMPEG = [process.execPath, fileURLToPath(new URL('./fixtures/fake-ffmpeg.mjs', import.meta.url))];
const ZONE = 'America/Toronto';
// Thursday 15 October 2026, noon in Toronto: the Saturday show (17th) is still to come.
const NOW = Date.UTC(2026, 9, 15, 16, 0);
const SECRETS = ['TWITCH-SECRET-9f8e7d6c', 'KICK-SECRET-1a2b3c4d'];
const SHOW = 'CODA · TORONTO';
const at = (time, date = '2026-10-17') => new Date(resolveTime(date, time, { timezone: ZONE }).at).toISOString();

async function cli(args, env = {}, { now = NOW, ffmpeg } = {}) {
  let stdout = '';
  let stderr = '';
  const code = await run(args, {
    stdout: { write: (s) => { stdout += s; } },
    stderr: { write: (s) => { stderr += s; } },
    env: { ...process.env, SKP_STORE: '', SKP_DATA_DIR: '', SKP_CONFIG_DIR: '', SKP_LOG_LEVEL: '', TZ: '', SKP_FFMPEG: NO_FFMPEG, ...env },
    clock: { now: () => now },
    ffmpeg,
  });
  return { code, stdout, stderr };
}

function dirs(t) {
  const root = tempDir(t);
  const env = { SKP_DATA_DIR: path.join(root, 'data'), SKP_CONFIG_DIR: path.join(root, 'config') };
  return { root, env, config: loadConfig({ argv: [], env }) };
}

// The data directory, opened on the test's clock, closed when fn is done.
async function inspect(config, fn, now = NOW) {
  const data = openData(config, { log: memoryLogger().log, purpose: 'test', clock: { now: () => now } });
  try {
    return await fn(data);
  } finally {
    data.close();
  }
}

// Every file under a directory, as text: no secret may be in any of them.
function filesUnder(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true }).map((n) => path.join(dir, n)).filter((f) => statSync(f).isFile()).map((f) => readFileSync(f).toString('latin1'));
}
function noSecrets(...texts) {
  for (const text of texts) for (const secret of SECRETS) assert.ok(!text.includes(secret), `a v0 secret leaked: ${secret}`);
}

const IMPORT = ['import', 'v0', FULL, '--timezone', ZONE];
const EVENT_SETTINGS = {
  look: 'event', venue: SHOW, presents: 'D/PRTMNT × VIKKSTAR', ticker: true, tickerItems: ['DPRTMNT TAKEOVER', 'NO PHONES ON THE FLOOR', 'VIKKSTAR TONIGHT'],
  scanlines: false, starStyle: 'ghost', showPoster: false, lockup: false, stinger: true, address: '1 KING ST W',
};
const LINEUP = [
  { time: '22:30', name: 'Trapment' },
  { time: '23:30', name: 'BIA', b2b: 'DOLF' },
  { time: '00:30', name: 'Vik Starr', headliner: true },
  { time: '02:00', name: 'UNDERCOVER', closer: true },
];

// ---- reading and mapping, with no platform ----------------------------------------------------

test('mapV0: kit.json becomes the show, its overlay\'s settings, v0\'s recipe, its cues, plans and credentials', () => {
  const map = mapV0(readV0(FULL), { timezone: ZONE, timezoneSource: 'given', now: NOW, manifest: MANIFEST });
  // kit.json wins over the older setup in live.json's cfg.
  assert.equal(map.from, 'kit.json');
  assert.deepEqual(map.found.sort(), ['kit.json', 'live.json', 'rundown.json', 'shows.json', 'viewers.json']);
  const { lineup, ...show } = map.show;
  assert.deepEqual(show, { name: SHOW, date: '2026-10-17', goLive: '22:00', timezone: ZONE, dayBoundary: '12:00' });
  // v0's order kept; blank names and times skipped and said; "2:00" is 02:00; the event's artist
  // (VIKKSTAR) matched loosely to "Vik Starr", flagged headliner; the closer stays the closer (H8).
  assert.deepEqual(lineup, LINEUP);
  assert.deepEqual(map.headliner, { name: 'VIKKSTAR', source: 'the event\'s billed artist', slot: 2, matched: true });
  assert.ok(map.skipped.some((s) => /act 3 at 00:00 has no name/.test(s)));
  assert.ok(map.skipped.some((s) => /"Ghost" has no time/.test(s)));
  // Only what differs from the template's defaults; _cmig was done, so the operator's ticker item
  // stays; the matched headliner needs no setting (it follows show.headliner).
  assert.equal(map.overlay.look, 'event');
  assert.deepEqual(map.overlay.saved, EVENT_SETTINGS);
  assert.deepEqual(map.recipe, { titleCard: true, introOffsetMin: 7, nowPlayingEveryMin: 15, headliner: false });
  // v0's hand-made cues for that night, not done; its generated ones (4) come from the recipe.
  assert.equal(map.v0Generated, 4);
  assert.deepEqual(map.cues.map((c) => [c.at, c.v0, c.action.type, c.action.name ?? c.action.scene ?? c.action.steps?.map((s) => s.action.type).join('+')]), [
    ['22:55', 'sched:opening', 'overlay.action', 'chipOpening'],
    ['23:45', 'clip:play', 'media.play', undefined],
    ['23:50', 'clip:stop', 'media.stop', undefined],
    ['00:05', 'clubintro', 'show.scene', 'intro'],
    ['00:15', 'sched:onat', 'overlay.action', 'chipOnAt'],
    ['00:30', 'headliner', 'show.scene', 'headliner'],
    ['01:30', 'djnp', 'sequence', 'show.slot+overlay.action'],
    ['02:55', 'scene:outro', 'show.scene', 'outro'],
    ['23:20', 'title', 'overlay.action', 'titleCard'],
  ]);
  // A DJ cue's v0 position (3, counting the blank act) is the act it named, by name.
  assert.deepEqual(map.cues[6].action.steps.map((s) => s.action), [{ type: 'show.slot', slot: 'Vik Starr' }, { type: 'overlay.action', name: 'nowPlaying', args: { name: 'Vik Starr' } }]);
  for (const why of [/"djtitle" at 23:10: it already happened/, /"Confetti cannon" at 03:00: this platform has nothing like "confetti"/, /"Last week" at 22:00: it was for another night \(2026-10-10\)/]) {
    assert.ok(map.skipped.some((s) => why.test(s)), `skipped: ${why}`);
  }
  assert.ok(map.warnings.some((w) => /"np": its time "25:00" isn't HH:MM/.test(w)));
  // Plans from today on: the show's own date and one v0 had loaded are skipped; two past ones too.
  assert.equal(map.pastPlans, 2);
  assert.deepEqual(map.plans.map((p) => [p.date, p.look, p.goLive]), [['2026-10-24', 'takeover', '22:30'], ['2026-10-31', 'event', '22:00']]);
  assert.ok(map.skipped.some((s) => /plan for 2026-10-17: it is the show's own date/.test(s)));
  assert.ok(map.skipped.some((s) => /plan for 2026-11-07: v0 had already loaded it/.test(s)));
  // The plan for the 24th was never cleaned by v0 (_cmig): it is now.
  assert.deepEqual(map.plans[0].saved, { venue: SHOW, tickerItems: ['DPRTMNT TAKEOVER', 'DOORS 10:30PM'] });
  assert.deepEqual(map.plans[0].lineup, [{ time: '22:30', name: 'Manzone' }, { time: '00:30', name: 'Deecee', b2b: 'quim', closer: true }]);
  assert.ok(map.warnings.some((w) => /plan for 2026-10-24 had its own cue timings/.test(w)));
  assert.deepEqual(map.plans[1].saved, EVENT_SETTINGS);
  assert.deepEqual(map.plans[1].lineup, [{ time: '23:00', name: 'Trapment' }, { time: '01:00', name: 'VIKKSTAR', closer: true, headliner: true }]);
  // Credentials, as v0 had them; the Twitch login lowercased as v0 sent it.
  assert.deepEqual(map.connections, [
    { platform: 'twitch', clientId: 'twitchclientid0001', clientSecret: SECRETS[0], channel: 'dprtmnt', enabled: true },
    { platform: 'kick', clientId: 'kickclientid0002', clientSecret: SECRETS[1], channel: 'dprtmnt', enabled: true },
  ]);
  // The clip by its base name inside uploads/, with the name it was uploaded as.
  assert.equal(map.clip.name, '1760000000000-IMG_0042.mp4');
  assert.equal(map.clip.original, 'IMG_0042.MOV');
  assert.equal(map.clip.file, path.join(FULL, 'uploads', '1760000000000-IMG_0042.mp4'));
  for (const what of [/the roster \(6 names/, /v0's live state/, /1 other upload in uploads/, /crash\.log/]) assert.ok(map.notImported.some((n) => what.test(n)), `not imported: ${what}`);
});

test('decodeCfg and upgradeSetup: live.json\'s cfg, the legacy evParams form, and v0\'s one-time content cleanup', () => {
  const setup = { venue: 'CAFÉ · TORONTO ★', lineup: [{ name: 'Ñandú', time: '23:00' }] };
  // As v0's kit page encoded it: encodeURIComponent(btoa(unescape(encodeURIComponent(json)))).
  const cfg = encodeURIComponent(Buffer.from(JSON.stringify(setup), 'utf8').toString('base64'));
  assert.deepEqual(decodeCfg(cfg), setup);
  for (const bad of ['%E0%A4%A', 'bm90IGpzb24=', encodeURIComponent(Buffer.from('[1,2]').toString('base64'))]) assert.equal(decodeCfg(bad), undefined);

  const old = upgradeSetup({ doors: 'DOORS 10PM', ticker: ['A', 'NO PHONES ON THE FLOOR', 'DOORS 10PM'], evParams: 'event=vikstarr&star=b&headliner=Nobody%20Famous&viewers=live&poster=0' });
  assert.deepEqual(old, { doors: 'DOORS 10:30PM', ticker: ['A', 'DOORS 10:30PM'], event: 'vikstarr', evOpts: { star: 'b', headliner: 'Nobody Famous', poster: 0 }, viewersMode: 'live', _cmig: true });
  // A typed viewer number moved out of the event options too (and isn't imported: H6).
  assert.deepEqual(upgradeSetup({ evOpts: { viewers: '1,284' } }), { evOpts: {}, viewersMode: 'manual', viewersText: '1,284', _cmig: true });
  // Cleaned already (_cmig): the operator's own ticker item stays.
  const done = { _cmig: true, ticker: ['NO PHONES ON THE FLOOR'], doors: 'DOORS 10PM' };
  assert.deepEqual(upgradeSetup(done), done);
});

test('matchHeadliner: as v0\'s overlay matched it, exact first, then a prefix, in the night\'s order', () => {
  const slots = [{ time: '01:00', name: 'VIKKSTAR b2b Friends' }, { time: '23:00', name: 'Vik-Starr' }, { time: '00:00', name: 'Vikstar Jr' }];
  assert.equal(matchHeadliner(slots, 'VIKKSTAR'), 1); // exact (loosely) beats the earlier prefix
  assert.equal(matchHeadliner(slots.filter((s) => s.name !== 'Vik-Starr'), 'vik star'), 1); // a prefix: 00:00 before 01:00
  assert.equal(matchHeadliner(slots, 'Nobody'), -1);
  assert.equal(matchHeadliner(slots, '123'), -1); // no letters: no match
});

test('mapV0 without kit.json: the setup from live.json\'s cfg, its legacy event, a headliner off the lineup, a clip path that tries to leave uploads/', () => {
  const read = readV0(CFG_ONLY);
  assert.equal(read.clip, undefined); // secret.mp4 sits beside the data, not in uploads/: never read
  const map = mapV0(read, { timezone: ZONE, now: NOW, manifest: MANIFEST });
  assert.equal(map.from, 'live.json');
  assert.deepEqual(map.show.lineup, [{ time: '23:00', name: 'Trapment' }, { time: '00:00', name: 'BIA', b2b: 'DOLF' }, { time: '02:00', name: 'UNDERCOVER', closer: true }]);
  // Nobody on the lineup is "Nobody Famous": no act is flagged (the closer isn't made the
  // headliner), and the overlay shows the name, as v0 did.
  assert.deepEqual(map.headliner, { name: 'Nobody Famous', source: 'the event options', slot: -1, matched: false });
  assert.deepEqual(map.overlay.saved, { look: 'event', tickerItems: ['DPRTMNT TAKEOVER', 'DOORS 10:30PM'], starStyle: 'rise', showPoster: false, headliner: 'Nobody Famous' });
  assert.ok(map.warnings.some((w) => /clip "secret\.mp4" isn't a file in .*uploads; it isn't imported/.test(w)));
  assert.deepEqual([map.cues, map.plans, map.connections], [[], [], []]);
});

test('mapV0 tolerates every wrong type and broken file: each is skipped with a warning, nothing throws', () => {
  const map = mapV0(readV0(MESSY), { timezone: ZONE, now: NOW, manifest: MANIFEST });
  assert.equal(map.show.name, 'Imported show'); // the venue isn't text
  assert.equal(map.show.date, '2026-10-17'); // no date: the coming Saturday, as v0's kit page did
  assert.equal(map.show.goLive, '23:00'); // v0's default
  assert.deepEqual(map.show.lineup, [{ time: '23:00', name: 'Valid' }]);
  assert.equal(map.overlay.look, 'takeover');
  assert.deepEqual(map.overlay.saved, { tagline: 'OK TAGLINE', viewers: false });
  assert.deepEqual(map.recipe, { titleCard: true, introOffsetMin: 5, nowPlayingEveryMin: 8, headliner: false });
  for (const w of [
    /shows\.json isn't JSON/, /golive is boolean/, /venue is a list/, /presents is number/, /scanlines is string/, /tickerOn is string/,
    /clubIntroMin is string/, /ticker is string/, /evOpts is string/, /has the date 20261017, which isn't one/, /entry 1 is null/,
    /entry 2 is string/, /act 3's name is number/, /"Valid"'s b2b is number/, /"Valid"'s closer is string/, /the event "oktoberfest" isn't one v0 had/,
    /npIntervalMin 7\.5 becomes 8/, /rundown\.json has no list of cues/, /viewers\.json is a list/,
  ]) assert.ok(map.warnings.some((x) => w.test(x)), `warning: ${w}`);
  assert.ok(map.skipped.some((s) => /"Late" has the time "25:99"/.test(s)));
  assert.ok(map.notImported.some((n) => /typed viewer number \("1,284"\).*H6/.test(n)));
});

test('a directory with nothing to import is refused, as is one that isn\'t there', async (t) => {
  const { root, env } = dirs(t);
  const empty = path.join(root, 'empty');
  mkdirSync(empty);
  assert.throws(() => mapV0(readV0(empty), { timezone: ZONE }), (err) => err instanceof ImportError && err.code === 'nothing');
  const res = await cli(['import', 'v0', empty, '--json'], env);
  assert.equal(res.code, 1);
  assert.equal(JSON.parse(res.stdout).error, 'nothing');
  const missing = await cli(['import', 'v0', path.join(root, 'nope')], env);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /There is no directory/);
  assert.equal(existsSync(env.SKP_DATA_DIR), false);
  assert.equal((await cli(['import', 'v0'], env)).code, 64);
  assert.equal((await cli([...IMPORT, '--slug', 'Not A Slug'], env)).code, 64);
  assert.match((await cli(['import', 'v0', FULL, '--timezone', 'Mars/Olympus'], env)).stderr, /IANA time zone/);
});

// ---- the command -------------------------------------------------------------------------------

test('skp import v0 --dry-run says what it would do and changes nothing, not even making the data directory', async (t) => {
  const { env } = dirs(t);
  const res = await cli([...IMPORT, '--dry-run'], env);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /^A dry run: importing v0's data from .*full \(the setup from kit\.json\) would do this\./);
  assert.match(res.stdout, /Lineup: 4 acts: 22:30 Trapment, 23:30 BIA b2b DOLF, 00:30 Vik Starr \(headliner\), 02:00 UNDERCOVER \(closer\)\./);
  assert.match(res.stdout, /Overlay "takeover": would be made, from com\.dprtmnt\.takeover@1\.0\.0, in the headliner event look/);
  assert.match(res.stdout, /Twitch and Kick credentials would be kept, encrypted, for when connections arrive/);
  assert.match(res.stdout, /Nothing changed \(--dry-run\)\./);
  assert.equal(existsSync(env.SKP_DATA_DIR), false);
  assert.equal(existsSync(env.SKP_CONFIG_DIR), false);
  const json = await cli([...IMPORT, '--dry-run', '--json'], env);
  const out = JSON.parse(json.stdout);
  assert.equal(out.dryRun, true);
  assert.deepEqual(out.overlay.settings, EVENT_SETTINGS);
  assert.deepEqual(out.connections, [{ platform: 'twitch', channel: 'dprtmnt', secret: true }, { platform: 'kick', channel: 'dprtmnt', secret: true }]);
  noSecrets(res.stdout, res.stderr, json.stdout, json.stderr);
});

test('skp import v0: the show, its overlay with the Line clip, the timeline, plans and kept credentials, each change in the audit log', async (t) => {
  const { root, env, config } = dirs(t);
  const res = await cli(IMPORT, env);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /^Imported v0's data from .*full \(the setup from kit\.json\)\./);
  assert.match(res.stdout, /timezone America\/Toronto \(given with --timezone; v0 used its server's zone/);
  assert.match(res.stdout, /Timeline: 30 cues from the lineup/);
  assert.match(res.stdout, /Added 9 cues v0's operator set by hand/);
  assert.match(res.stdout, /Planned dates: 2026-10-24 \(with its own look\), 2026-10-31\./);
  assert.match(res.stdout, /Twitch and Kick credentials are kept, encrypted, for when connections arrive/);
  // What to do next: the OBS URLs, both canvases, with the overlay's key.
  assert.match(res.stdout, /horizontal, 1920 x 1080: http:\/\/127\.0\.0\.1:4848\/o\/takeover\?key=skp_ovl_\w+\n/);
  assert.match(res.stdout, /vertical, 1080 x 1920: http:\/\/127\.0\.0\.1:4848\/o\/takeover\?key=skp_ovl_\w+&canvas=v/);
  assert.match(res.stdout, /Kept as uploaded: ffmpeg isn't available/);

  await inspect(config, (data) => {
    const show = data.shows.get(SHOW);
    assert.deepEqual([show.date, show.timezone, show.dayBoundary, show.goLive, show.members], ['2026-10-17', ZONE, '12:00', '22:00', ['takeover']]);
    assert.deepEqual(show.lineup.map(({ startAt, ...s }) => s), LINEUP);
    assert.equal(show.lineup[2].startAt, Date.parse(at('00:30'))); // 00:30 is Sunday morning (H7)
    assert.deepEqual(show.recipe, { titleCard: true, introOffsetMin: 7, nowPlayingEveryMin: 15, headliner: false });

    // The clip: in the media library as uploaded (no ffmpeg here), and the overlay's Line clip.
    const [clip, ...more] = data.media.list();
    assert.equal(more.length, 0);
    assert.deepEqual([clip.data.name, clip.data.original.name, clip.data.status], ['IMG_0042.mp4', 'IMG_0042.MOV', 'ready']);
    const overlay = data.overlays.resolve('takeover');
    assert.equal(overlay.doc.data.template.id, 'com.dprtmnt.takeover');
    assert.deepEqual(overlay.doc.data.settings, { ...EVENT_SETTINGS, lineClip: mediaUrl(clip) });
    assert.equal(overlay.settings.headliner, 'Vik Starr'); // follows the show's headliner (H8)

    const cues = data.timeline.list(show.id);
    const generated = cues.filter((c) => c.generated);
    assert.equal(generated.length, 30);
    // v0's recipe: a title card at every start, the headliner's too; the Event Intro 7 minutes in;
    // now playing every 15 minutes until the next set.
    assert.deepEqual(generated.filter((c) => c.action.name === 'titleCard').map((c) => [c.at, c.action.args.name]), [[at('22:30'), 'Trapment'], [at('23:30'), 'BIA'], [at('00:30'), 'Vik Starr'], [at('02:00'), 'UNDERCOVER']]);
    assert.ok(!generated.some((c) => c.action.name === 'headliner'));
    assert.deepEqual(generated.filter((c) => c.action.name === 'intro').map((c) => c.at), [at('22:37'), at('23:37'), at('00:37'), at('02:07')]);
    assert.deepEqual(generated.filter((c) => c.action.name === 'nowPlaying' && c.action.args.name === 'Trapment').map((c) => c.at), [at('22:45'), at('23:00'), at('23:15')]);
    const manual = cues.filter((c) => !c.generated);
    assert.deepEqual(manual.map((c) => [c.time, c.label ?? null, c.action.type, c.status]), [
      ['22:55', 'Opening chip', 'overlay.action', 'armed'],
      ['23:20', null, 'overlay.action', 'armed'],
      ['23:45', 'Line clip', 'media.play', 'armed'],
      ['23:50', null, 'media.stop', 'armed'],
      ['00:05', 'Club intro', 'show.scene', 'armed'],
      ['00:15', 'VIKKSTAR on at', 'overlay.action', 'armed'],
      ['00:30', 'Headliner takeover', 'show.scene', 'armed'],
      ['01:30', null, 'sequence', 'armed'],
      ['02:55', null, 'show.scene', 'armed'],
    ]);
    assert.equal(manual[2].action.mediaId, clip.id);

    // Plans: the 24th in the TAKEOVER look carries the overlay's whole settings (applied, they
    // replace the overlay's), the clip included; the 31st looks like the show, so it carries none.
    const plans = data.timeline.plans.list(show.id);
    assert.deepEqual(plans.map((p) => [p.date, p.goLive, p.dayBoundary, p.lineup.length]), [['2026-10-24', '22:30', '12:00', 2], ['2026-10-31', '22:00', '12:00', 2]]);
    assert.deepEqual(plans[0].overlaySettings, { takeover: { venue: SHOW, tickerItems: ['DPRTMNT TAKEOVER', 'DOORS 10:30PM'], lineClip: mediaUrl(clip) } });
    assert.equal(plans[1].overlaySettings, undefined);
    assert.deepEqual(plans[1].lineup, [{ time: '23:00', name: 'Trapment' }, { time: '01:00', name: 'VIKKSTAR', headliner: true, closer: true }]);

    // Credentials kept for connections: the secret encrypted, bound to its record.
    for (const [i, platform, clientId] of [[0, 'twitch', 'twitchclientid0001'], [1, 'kick', 'kickclientid0002']]) {
      const doc = data.store.get(PENDING_CONNECTIONS, platform);
      const { clientSecret, ...rest } = doc.data;
      assert.deepEqual(rest, { platform, clientId, channel: 'dprtmnt', enabled: true, from: 'v0', importedAt: new Date(NOW).toISOString() });
      assert.match(clientSecret, /^enc:v1:/);
      assert.equal(data.secrets.decrypt(clientSecret, platform), SECRETS[i]);
      assert.throws(() => data.secrets.decrypt(clientSecret, platform === 'twitch' ? 'kick' : 'twitch'));
    }
  });

  // One audit entry per thing made, as the command line's user.
  const audit = auditOf(config);
  assert.deepEqual(audit.map((e) => e.action), [
    'import.v0.media.add', 'import.v0.overlay.create', 'import.v0.show.create', 'import.v0.cues.build',
    ...Array(9).fill('import.v0.cue.add'), 'import.v0.plan.add', 'import.v0.plan.add', 'import.v0.connection.keep', 'import.v0.connection.keep',
  ]);
  assert.ok(audit.every((e) => e.actor === cliActor()));
  assert.deepEqual(audit.at(-1).details, { platform: 'kick', channel: 'dprtmnt', replaced: false });
  // No secret in the output, the audit log, the logs, or anywhere in the data or config directory.
  noSecrets(res.stdout, res.stderr, JSON.stringify(audit), ...filesUnder(path.join(root, 'data')), ...filesUnder(path.join(root, 'config')));
});

test('importing again: refused without --replace; --replace replaces the show, its cues and plans, and reuses the overlay and the clip', async (t) => {
  const { env, config } = dirs(t);
  assert.equal((await cli(IMPORT, env)).code, 0);
  const before = await inspect(config, (data) => {
    const show = data.shows.get(SHOW);
    // The operator's own settings on the overlay, and a v0 one changed since.
    data.overlays.updateSettings('takeover', { ...data.overlays.resolve('takeover').doc.data.settings, brbTag: 'HOLD TIGHT', venue: 'SOMEWHERE ELSE' });
    return { show: show.id, overlay: data.overlays.resolve('takeover').doc.id, cues: data.timeline.list(show.id).map((c) => c.id), plans: data.timeline.plans.list(show.id).map((p) => p.id) };
  });
  const entries = auditOf(config).length;

  const refused = await cli(IMPORT, env);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /There is already a show called "CODA · TORONTO"\. Import again with --replace/);
  assert.equal(auditOf(config).length, entries);
  const dry = await cli([...IMPORT, '--dry-run'], env);
  assert.equal(dry.code, 1);
  assert.match(dry.stdout, /The Line's clip: \/media\/[0-9a-f]{32}\/IMG_0042\.mp4 \(imported before, would be used again\)/);
  assert.match(dry.stdout, /It would be refused: There is already a show called/);
  assert.equal(auditOf(config).length, entries);

  // A minute later (the audit log orders entries by time).
  const replaced = await cli([...IMPORT, '--replace'], env, { now: NOW + 60000 });
  assert.equal(replaced.code, 0, replaced.stderr);
  assert.match(replaced.stdout, /It replaces the show of that name, with its cues and plans\./);
  assert.match(replaced.stdout, /Overlay "takeover": updated \(it was there already\)/);
  assert.match(replaced.stdout, /\(imported before, used again\)/);
  await inspect(config, (data) => {
    const show = data.shows.get(SHOW);
    assert.notEqual(show.id, before.show);
    assert.equal(data.shows.list().length, 1);
    assert.equal(data.overlays.resolve('takeover').doc.id, before.overlay);
    // v0's settings again, the operator's own one kept.
    assert.deepEqual(data.overlays.resolve('takeover').doc.data.settings, { ...EVENT_SETTINGS, brbTag: 'HOLD TIGHT', lineClip: mediaUrl(data.media.list()[0]) });
    assert.equal(data.media.list().length, 1);
    const cues = [...data.store.list('cues', { limit: 1000 })];
    assert.equal(cues.length, before.cues.length);
    assert.ok(cues.every((c) => c.data.showId === show.id && !before.cues.includes(c.id)));
    const plans = data.timeline.plans.list(show.id);
    assert.equal(plans.length, 2);
    assert.ok(plans.every((p) => !before.plans.includes(p.id)));
  });
  const actions = auditOf(config).slice(entries).map((e) => e.action);
  assert.deepEqual(actions.slice(0, 4), ['import.v0.overlay.update', 'import.v0.show.delete', 'import.v0.show.create', 'import.v0.cues.build']);
  assert.ok(!actions.includes('import.v0.media.add'));
  assert.equal(auditOf(config).at(-1).details.replaced, true);
});

test('an overlay with the slug on another template, or in another show, is never taken over', async (t) => {
  const { env, config } = dirs(t);
  await inspect(config, (data) => {
    data.overlays.create({ slug: 'diag', template: DIAG, settings: {} });
    data.overlays.create({ slug: 'theirs', template: { id: 'com.dprtmnt.takeover', version: '1.0.0' }, settings: {} });
    data.shows.create({ name: 'Another night', overlays: ['theirs'], date: '2026-10-17', timezone: ZONE });
  });
  const other = await cli([...IMPORT, '--slug', 'diag', '--json'], env);
  assert.equal(other.code, 1);
  assert.deepEqual(JSON.parse(other.stdout), { error: 'slug-taken', message: 'The overlay "diag" uses dev.skp.diagnostic, not the TAKEOVER template; give the import another --slug.' });
  const held = await cli([...IMPORT, '--slug', 'theirs'], env);
  assert.equal(held.code, 1);
  assert.match(held.stderr, /The overlay "theirs" is in the show "Another night"/);
  assert.deepEqual(auditOf(config), []);
  // Under its own name and slug it goes ahead beside them.
  const own = await cli([...IMPORT, '--slug', 'takeover-2', '--name', 'Saturday TAKEOVER'], env);
  assert.equal(own.code, 0, own.stderr);
  assert.match(own.stdout, /\/o\/takeover-2\?key=/);
  await inspect(config, (data) => assert.deepEqual(data.shows.list().map((s) => [s.name, s.members]).sort(), [['Another night', ['theirs']], ['Saturday TAKEOVER', ['takeover-2']]]));
});

test('--json: what was made, the clip converted when ffmpeg is there, and never a secret', async (t) => {
  const { env } = dirs(t);
  const res = await cli([...IMPORT, '--json'], env, { ffmpeg: FAKE_FFMPEG });
  assert.equal(res.code, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.dryRun, false);
  assert.deepEqual(out.show, { id: out.show.id, name: SHOW, date: '2026-10-17', timezone: ZONE, goLive: '22:00', dayBoundary: '12:00', acts: 4 });
  assert.deepEqual(out.headliner, { name: 'VIKKSTAR', from: 'the event\'s billed artist', act: 'Vik Starr' });
  assert.equal(out.clip.converted, true);
  assert.deepEqual(out.cues, { generated: 30, manual: 9, total: 39 });
  assert.deepEqual(out.plans.map((p) => [p.date, p.settings]), [['2026-10-24', true], ['2026-10-31', false]]);
  assert.deepEqual(out.urls.map((u) => u.canvas), ['h', 'v']);
  assert.equal(out.pastPlans, 2);
  noSecrets(res.stdout, res.stderr);
});

test('without --timezone the show takes TZ (or this computer\'s zone), and says which; a clip path out of uploads/ is never followed', async (t) => {
  const { env, config } = dirs(t);
  const res = await cli(['import', 'v0', CFG_ONLY], { ...env, TZ: 'America/Vancouver' });
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /timezone America\/Vancouver \(from TZ; v0 used its server's zone, so pass --timezone if that was another\)/);
  assert.match(res.stdout, /Headliner: the event options named Nobody Famous, who isn't on the lineup, so no act is flagged/);
  assert.match(res.stdout, /clip "secret\.mp4" isn't a file in/);
  await inspect(config, (data) => {
    const show = data.shows.get('DPRTMNT · TORONTO');
    assert.equal(show.timezone, 'America/Vancouver');
    assert.equal(show.lineup.some((s) => s.headliner), false);
    assert.equal(data.overlays.resolve('takeover').settings.headliner, 'Nobody Famous');
    assert.deepEqual(data.media.list(), []);
  });
  const system = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const own = await cli(['import', 'v0', CFG_ONLY, '--name', 'Local', '--slug', 'local', '--dry-run'], env);
  assert.match(own.stdout, new RegExp(`timezone ${system.replace(/[/+]/g, '\\$&')} \\(this computer's zone`));
});

test('a planned date whose day has begun becomes the show at once, as v0 loaded it at noon', async (t) => {
  const { env, config } = dirs(t);
  const sat = Date.UTC(2026, 9, 24, 17, 0); // Saturday the 24th, 13:00 in Toronto
  const res = await cli(IMPORT, env, { now: sat });
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /The plan for 2026-10-24 is the show already: its day has begun\./);
  assert.match(res.stdout, /3 dates in shows\.json are past/);
  await inspect(config, (data) => {
    const show = data.shows.get(SHOW);
    assert.equal(show.date, '2026-10-24');
    assert.deepEqual(show.lineup.map((s) => s.name), ['Manzone', 'Deecee']);
    assert.equal(data.overlays.resolve('takeover').doc.data.settings.look, undefined); // the plan's TAKEOVER look
    const cues = data.timeline.list(show.id);
    assert.ok(cues.some((c) => c.generated && c.action.name === 'titleCard' && c.action.args.name === 'Manzone' && c.at === at('22:30', '2026-10-24')));
    // v0's own cues are at times of the show: they moved to the new night, still to come.
    assert.ok(cues.filter((c) => c.time).every((c) => c.status === 'armed' && Date.parse(c.at) > sat));
    assert.deepEqual(data.timeline.plans.list(show.id).map((p) => [p.date, Boolean(p.activatedAt)]), [['2026-10-24', true], ['2026-10-31', false]]);
  }, sat);
});

test('key rotate re-encrypts the kept credentials; the platform\'s lock keeps the import off a running platform\'s data', async (t) => {
  const { env, config } = dirs(t);
  assert.equal((await cli(IMPORT, env)).code, 0);
  const rotated = await cli(['key', 'rotate', '--json'], env);
  assert.equal(rotated.code, 0, rotated.stderr);
  assert.equal(JSON.parse(rotated.stdout).reencrypted, 3); // the overlay's key and the two secrets
  await inspect(config, async (data) => {
    const doc = data.store.get(PENDING_CONNECTIONS, 'twitch');
    assert.equal(data.secrets.keyIdOf?.(doc.data.clientSecret) ?? doc.data.clientSecret.split(':')[2], JSON.parse(rotated.stdout).to);
    assert.equal(data.secrets.decrypt(doc.data.clientSecret, 'twitch'), SECRETS[0]);
    // While something holds the data directory (the platform), the import waits for it.
    const locked = await cli([...IMPORT, '--replace'], env);
    assert.equal(locked.code, 75);
    assert.match(locked.stderr, /already uses the data directory/);
  });
});
