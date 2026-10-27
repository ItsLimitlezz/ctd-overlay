// The timeline (09 §9.3–9.6): cues fired by the server on its own clock, the scheduler's rules,
// operator overrides, cues generated from the lineup, planned shows, and (H19) a running server
// with its clock set ahead, through both daylight-saving nights.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { startPlatform } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { newId } from '../src/ids.js';
import { GRACE_MS, RECONNECT_MS } from '../src/shows/timeline.js';
import { fakeConnector } from './fixtures/connectors/fake.js';
import { defer, FIXTURE_TEMPLATES, memoryLogger, signedIn, tempDir, TESTBED } from './helpers.js';

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
// The TAKEOVER template that ships with the platform, at the version it ships at.
const TAKEOVER = { id: 'com.dprtmnt.takeover', version: JSON.parse(readFileSync(new URL('../templates/takeover/template.json', import.meta.url), 'utf8')).version };
// Saturday 17 October 2026 in Toronto (EDT, UTC-4): a club night past midnight.
const T0 = Date.UTC(2026, 9, 18, 2, 0); // 22:00
const LINEUP = [
  { time: '22:30', name: 'Manzone' },
  { time: '01:00', name: 'VIKKSTAR', headliner: true },
  { time: '03:00', name: 'Deecee', closer: true },
];
const SHOW = { name: 'Saturday TAKEOVER', overlays: ['tk', 'main-h'], date: '2026-10-17', timezone: 'America/Toronto', dayBoundary: '12:00', lineup: LINEUP };
const iso = (ms) => new Date(ms).toISOString();

// A hand-cranked clock for the platform's shows and timeline: time moves to each timer as it
// fires (the timeline's one-second tick included), as it would.
function fakeClock(start) {
  const c = { t: start, pending: [] };
  const add = (fn, ms, every) => {
    const h = { at: c.t + Math.max(0, ms || 0), fn, every };
    c.pending.push(h);
    return h;
  };
  const clear = (h) => {
    const i = c.pending.indexOf(h);
    if (i >= 0) c.pending.splice(i, 1);
  };
  c.timers = { setTimeout: (fn, ms) => add(fn, ms), clearTimeout: clear, setInterval: (fn, ms) => add(fn, ms, ms), clearInterval: clear };
  c.now = () => c.t;
  c.advance = (ms) => {
    const until = c.t + ms;
    for (;;) {
      let due = null;
      for (const h of c.pending) if (h.at <= until && (!due || h.at < due.at)) due = h;
      if (!due) break;
      c.t = Math.max(c.t, due.at);
      if (due.every) due.at += due.every;
      else clear(due);
      due.fn();
    }
    c.t = until;
  };
  c.to = (ms) => c.advance(ms - c.t);
  return c;
}

// A platform on a clock (fake or offset), with the TAKEOVER and testbed overlays, every envelope
// each one's channel sends, and its local API.
async function setup(t, { dataRoot = tempDir(t), clock, overlays = true, connectors } = {}) {
  const config = loadConfig({ argv: ['--port', '0'], env: { SKP_DATA_DIR: path.join(dataRoot, 'data'), SKP_CONFIG_DIR: path.join(dataRoot, 'config') } });
  const { log, entries } = memoryLogger();
  const platform = await startPlatform(config, { log, templateDirs: [FIXTURE_TEMPLATES], clock: clock && { now: clock.now, timers: clock.timers }, connectors });
  defer(t, () => platform.stop());
  if (overlays) {
    platform.overlays.create({ slug: 'tk', template: TAKEOVER, settings: {} });
    platform.overlays.create({ slug: 'main-h', template: TESTBED, settings: {} });
  }
  const got = {};
  const watch = (slug, fn) => {
    got[slug] = [];
    platform.overlays.resolve(slug).channel.subscribe((env) => { got[slug].push(env); fn?.(env); });
  };
  const local = (slug) => platform.overlays.resolve(slug).channel.snapshot().state;
  const api = (method, url, body) => fetch(`${platform.url}/api/v1${url}`, {
    method,
    headers: signedIn(platform, body === undefined ? {} : { 'content-type': 'application/json' }),
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (res) => ({ status: res.status, type: res.headers.get('content-type'), body: await res.json().catch(() => null) }));
  const timeline = platform.timeline;
  const cue = (id) => platform.store.get('cues', id).data;
  return { platform, config, entries, got, watch, local, api, timeline, cue, dataRoot };
}

const of = (envs, type) => envs.filter((e) => e.type === type);

test('the scheduler fires each cue when its time comes, durable before visible, and misses one more than five minutes late', async (t) => {
  const clock = fakeClock(T0);
  const { platform, timeline, watch, got, local, cue, entries } = await setup(t, { clock });
  const show = platform.shows.create(SHOW);
  let statusSeen;
  let brbCue;
  watch('main-h', (env) => { if (env.type === 'show.scene.changed') statusSeen = cue(brbCue.id).status; });
  brbCue = timeline.add(show.id, { at: '22:05', action: { type: 'show.scene', scene: 'brb' }, label: 'Break' });
  assert.equal(brbCue.at, '2026-10-18T02:05:00.000Z', 'a time of the show, resolved on its night');
  assert.equal(brbCue.time, '22:05');
  assert.equal(brbCue.status, 'armed');
  const late = timeline.add(show.id, { at: iso(T0 - 4 * MIN), action: { type: 'overlay.action', name: 'titleCard', args: { name: 'Late' } } });
  const tooLate = timeline.add(show.id, { at: iso(T0 - GRACE_MS - SEC), action: { type: 'overlay.action', name: 'titleCard', args: { name: 'Too late' } } });
  clock.advance(SEC);
  assert.equal(cue(late.id).status, 'fired', 'four minutes late: still fired');
  assert.deepEqual(of(got['main-h'], 'show.trigger').map((e) => e.data.args.name), ['Late']);
  assert.equal(cue(tooLate.id).status, 'missed', 'past the grace window: never fired');
  assert.ok(entries.some((e) => e.msg === 'a cue was more than five minutes late and was not fired'));
  clock.advance(4 * MIN);
  assert.equal(cue(brbCue.id).status, 'armed');
  clock.advance(MIN);
  assert.equal(cue(brbCue.id).status, 'fired');
  assert.ok(cue(brbCue.id).firedAt - cue(brbCue.id).at < SEC + 1, 'within the tick');
  assert.equal(local('tk')['show.scene'], 'brb');
  assert.equal(statusSeen, 'fired', 'the cue was written as fired before its effect was published');
  assert.deepEqual(timeline.list(show.id).map((c) => c.status), ['missed', 'fired', 'fired']);
});

test('a restart: what fell due while the platform was down fires at startup within five minutes, is missed after, and nothing fires twice', async (t) => {
  const dataRoot = tempDir(t);
  const first = await setup(t, { dataRoot, clock: fakeClock(T0) });
  const show = first.platform.shows.create(SHOW);
  const a = first.timeline.add(show.id, { at: '22:01', action: { type: 'show.scene', scene: 'brb' } });
  const b = first.timeline.add(show.id, { at: '22:03', action: { type: 'overlay.action', name: 'titleCard', args: { name: 'B' } } });
  const c = first.timeline.add(show.id, { at: iso(T0 - MIN), action: { type: 'show.scene', scene: 'starting' } });
  // Just inside five minutes late at the restart below, and past it once the pages have had
  // their seconds to reconnect: lateness counts as of startup, so it still fires.
  const d = first.timeline.add(show.id, { at: iso(T0 + 7 * MIN - GRACE_MS + 2 * SEC), action: { type: 'overlay.action', name: 'titleCard', args: { name: 'D' } } });
  assert.equal(first.cue(c.id).status, 'armed', 'not yet ticked');
  first.platform.timeline.tick();
  assert.equal(first.cue(c.id).status, 'fired');
  const firedC = first.cue(c.id).firedAt;
  await first.platform.stop();
  // Back at 22:07: a is six minutes late, b four. b waits a few seconds for the overlays' pages.
  const clock2 = fakeClock(T0 + 7 * MIN);
  const second = await setup(t, { dataRoot, clock: clock2, overlays: false });
  assert.equal(second.cue(a.id).status, 'missed', 'missed at once');
  assert.equal(second.cue(b.id).status, 'armed', 'held for the pages to reconnect');
  clock2.advance(RECONNECT_MS - SEC);
  assert.equal(second.cue(b.id).status, 'armed');
  clock2.advance(SEC);
  assert.equal(second.cue(b.id).status, 'fired');
  assert.equal(second.cue(c.id).firedAt, firedC, 'c was not fired again');
  assert.equal(second.local('tk')['show.scene'], 'starting', 'and a was not fired');
  assert.equal(second.cue(d.id).status, 'fired', 'late as of startup, not as of the wait');
  assert.deepEqual(second.entries.filter((e) => e.msg === 'cue fired').map((e) => e.context.cue), [d.id, b.id]);
  await second.platform.stop();
  const third = await setup(t, { dataRoot, clock: fakeClock(T0 + 8 * MIN), overlays: false });
  third.platform.timeline.tick();
  assert.deepEqual(third.entries.filter((e) => e.msg === 'cue fired'), [], 'a fired cue never fires again');
  assert.equal(third.cue(b.id).status, 'fired');
});

test('operator overrides: fire now, skip, re-arm, edit and delete, each recorded', async (t) => {
  const clock = fakeClock(T0);
  const { platform, timeline, watch, got, cue } = await setup(t, { clock });
  const show = platform.shows.create(SHOW);
  watch('main-h');
  const title = { type: 'overlay.action', name: 'titleCard', args: { name: 'X' } };
  const one = timeline.add(show.id, { at: '22:10', action: title });
  const fired = timeline.override(show.id, one.id, 'fire', { actor: 'local' });
  assert.equal(fired.status, 'fired');
  assert.equal(fired.firedAt, iso(T0));
  assert.equal(of(got['main-h'], 'show.trigger').length, 1);
  assert.throws(() => timeline.update(show.id, one.id, { at: '22:20' }), { code: 'fired', status: 409 });
  assert.equal(timeline.override(show.id, one.id, 'rearm').status, 'armed');
  clock.advance(10 * MIN);
  assert.equal(cue(one.id).status, 'fired', 're-armed, it fired again at its time');
  assert.equal(of(got['main-h'], 'show.trigger').length, 2);
  const two = timeline.add(show.id, { at: '22:15', action: title });
  assert.equal(timeline.override(show.id, two.id, 'skip').status, 'skipped');
  assert.throws(() => timeline.override(show.id, two.id, 'skip'), { code: 'not-armed', status: 409 });
  clock.advance(11 * MIN); // 22:21
  assert.equal(cue(two.id).status, 'skipped');
  assert.equal(of(got['main-h'], 'show.trigger').length, 2, 'a skipped cue does nothing');
  // Re-armed long after its time, it is missed rather than fired.
  timeline.override(show.id, two.id, 'rearm');
  clock.advance(SEC);
  assert.equal(cue(two.id).status, 'missed');
  // Edits: a new time, a new action, a label; then delete.
  const three = timeline.add(show.id, { at: '23:00', action: title });
  const moved = timeline.update(show.id, three.id, { at: '23:30', action: { type: 'show.scene', scene: 'brb', transition: 'cut' }, label: 'Late break' });
  assert.deepEqual([moved.at, moved.time, moved.action, moved.label], ['2026-10-18T03:30:00.000Z', '23:30', { type: 'show.scene', scene: 'brb', transition: 'cut' }, 'Late break']);
  assert.deepEqual(timeline.remove(show.id, three.id), { id: three.id });
  assert.throws(() => timeline.remove(show.id, three.id), { code: 'not-found', status: 404 });
  assert.throws(() => timeline.override(show.id, one.id, 'explode'), { code: 'invalid' });
  // Each override is in the audit log (07 §7.12), newest first.
  const ops = platform.audit.list({ action: 'cue' }).items.reverse();
  assert.deepEqual(ops.map((o) => [o.action, o.target]), [['cue.fire', one.id], ['cue.rearm', one.id], ['cue.skip', two.id], ['cue.rearm', two.id]]);
  assert.equal(ops[0].actor, 'local');
  assert.deepEqual(ops[0].details, { show: show.id, type: 'overlay.action' });
  assert.equal(ops[0].at, iso(T0), 'on the platform\'s clock');
});

test('what a cue must be: refusals say what to fix', async (t) => {
  const { platform, timeline } = await setup(t, { clock: fakeClock(T0) });
  const show = platform.shows.create(SHOW);
  const bad = (input, code, re) => assert.throws(() => timeline.add(show.id, input), (err) => err.code === code && (!re || re.test(err.message)), JSON.stringify(input));
  const ok = { type: 'show.scene', scene: 'brb' };
  bad({ at: '25:00', action: ok }, 'invalid', /HH:MM/);
  bad({ at: '2026-10-18T02:00:00', action: ok }, 'invalid', /offset/);
  bad({ at: 'tomorrow', action: ok }, 'invalid');
  bad({ at: '22:00' }, 'invalid', /action/);
  bad({ at: '22:00', action: { type: 'explode' } }, 'invalid', /show\.scene/);
  // connector.action (since step 16): a connection, or a connector with one connection on, and an
  // action its definition has.
  bad({ at: '22:00', action: { type: 'connector.action', connector: 'obs', name: 'setScene' } }, 'invalid', /no connection or connector "obs"/);
  bad({ at: '22:00', action: { type: 'connector.action', name: 'setScene' } }, 'invalid', /"connection".*"connector"/);
  bad({ at: '22:00', action: { type: 'connector.action', connector: 'obs', connection: 'con_x', name: 'setScene' } }, 'invalid', /not both/);
  bad({ at: '22:00', action: { type: 'webhook', url: 'https://example.com' } }, 'not-yet', /step 20/);
  bad({ at: '22:00', action: { type: 'show.scene', scene: 'Big Scene' } }, 'invalid');
  bad({ at: '22:00', action: { type: 'overlay.action', name: 'titleCard', args: { big: 'x'.repeat(5000) } } }, 'invalid', /4096/);
  bad({ at: '22:00', action: { type: 'show.slot', slot: -1 } }, 'invalid');
  bad({ at: '22:00', action: { type: 'media.play', mediaId: 'med_nope' } }, 'invalid', /uploaded/);
  bad({ at: '22:00', action: { type: 'sequence', steps: [] } }, 'invalid', /steps/);
  bad({ at: '22:00', action: { type: 'sequence', steps: [{ offsetMs: 0, action: { type: 'sequence', steps: [{ offsetMs: 0, action: ok }] } }] } }, 'invalid', /another sequence/);
  bad({ at: '22:00', action: { type: 'sequence', steps: [{ offsetMs: 2 * HOUR, action: ok }] } }, 'invalid', /hour/);
  bad({ at: '22:00', action: ok, label: 'x'.repeat(121) }, 'invalid', /label/);
  assert.throws(() => timeline.add('nope', { at: '22:00', action: ok }), { code: 'not-found' });
  assert.throws(() => timeline.override(show.id, 'cue_nope', 'fire'), { code: 'not-found', status: 404 });
  // A cue of another show is not this show's.
  platform.overlays.create({ slug: 'other', template: TESTBED, settings: {} });
  const other = platform.shows.create({ ...SHOW, name: 'Other', overlays: ['other'] });
  const theirs = timeline.add(other.id, { at: '22:00', action: ok });
  assert.throws(() => timeline.override(show.id, theirs.id, 'fire'), { code: 'not-found' });
  // Deleting a show deletes its cues.
  platform.shows.remove(other.id);
  assert.equal(platform.store.get('cues', theirs.id), undefined);
});

test('a connector.action cue runs the connection\'s action through the connector host; a failure is the cue\'s error', async (t) => {
  const clock = fakeClock(T0);
  const fake = fakeConnector();
  const { platform, timeline, cue } = await setup(t, { clock, connectors: { defs: [fake.def] } });
  const show = platform.shows.create(SHOW);
  const conn = platform.connectors.create({ connector: 'fake', name: 'Fake', config: { behaviour: 'push' } });
  // What a connection does settles on promises, not on the hand-cranked clock: wait in real time.
  assert.ok(await until(() => platform.connectors.get(conn.id).health.status === 'connected'));
  const echo = timeline.add(show.id, { at: '22:05', action: { type: 'connector.action', connection: conn.id, name: 'echo', args: { text: 'hi' } } });
  assert.deepEqual(echo.action, { type: 'connector.action', connection: conn.id, name: 'echo', args: { text: 'hi' } });
  const failing = timeline.add(show.id, { at: '22:06', action: { type: 'connector.action', connector: 'fake', name: 'fail' } });
  assert.throws(() => timeline.add(show.id, { at: '22:07', action: { type: 'connector.action', connection: conn.id, name: 'explode' } }), (err) => err.code === 'invalid' && /no action "explode"/.test(err.message));
  clock.advance(5 * MIN);
  assert.equal(cue(echo.id).status, 'fired');
  assert.ok(await until(() => platform.audit.list({ action: 'connection.action' }).items.length === 1));
  assert.equal(cue(echo.id).error, undefined);
  clock.advance(MIN);
  assert.ok(await until(() => cue(failing.id).error));
  assert.match(cue(failing.id).error, /failed: "fail" failed: the fake service said no/);
  // Turned off by the time its cue comes: it fires, and says why nothing happened.
  await platform.connectors.update(conn.id, { enabled: false });
  const late = timeline.add(show.id, { at: '22:08', action: { type: 'connector.action', connection: conn.id, name: 'echo' } });
  clock.advance(2 * MIN);
  assert.ok(await until(() => cue(late.id).error));
  assert.match(cue(late.id).error, /isn't connected/);
});

test('a recipe generates the night from the lineup, and a mid-show lineup edit fires nothing again', async (t) => {
  const clock = fakeClock(T0);
  const { platform, timeline, watch, got, local, cue } = await setup(t, { clock });
  const show = platform.shows.create(SHOW);
  watch('tk');
  watch('main-h');
  const cues = timeline.build(show.id);
  assert.equal(platform.shows.get(show.id).recipe.nowPlayingEveryMin, 10, 'the default recipe, kept with the show');
  // Manzone 22:30–01:00: on, title card, Event Intro at 22:35, now playing 22:40 … 00:50 (14).
  // VIKKSTAR 01:00–03:00: on, the headliner intro (a timed scene) in place of a title card, intro, 11.
  // Deecee from 03:00 (the last act, two hours): on, title card, intro, 11.
  assert.equal(cues.length, 17 + 14 + 14);
  assert.ok(cues.every((c) => c.generated && c.status === 'armed'));
  assert.deepEqual(cues.slice(0, 4).map((c) => [c.at.slice(11, 16), c.label]), [
    ['02:30', 'Manzone on'], ['02:30', 'Manzone: title card'], ['02:35', 'Manzone: Event Intro'], ['02:40', 'Manzone: now playing'],
  ]);
  assert.deepEqual(cues.filter((c) => c.at === '2026-10-18T05:00:00.000Z').map((c) => c.action), [{ type: 'show.slot', slot: 'VIKKSTAR' }, { type: 'overlay.action', name: 'headliner' }], 'who\'s on, by the act\'s name');
  // 22:30: who's on, then the title card, on the same tick.
  clock.to(Date.UTC(2026, 9, 18, 2, 30));
  const tkEnvs = got.tk.filter((e) => (e.type === 'state.changed' && e.data.key === 'show.currentSlot') || e.type === 'show.trigger');
  assert.deepEqual(tkEnvs.map((e) => e.type), ['state.changed', 'show.trigger']);
  assert.deepEqual(of(got['main-h'], 'show.trigger').map((e) => e.data.args), [{ name: 'Manzone' }]);
  assert.equal(local('tk')['show.currentSlot'], 0);
  // 22:35: the Event Intro, a timed scene, plays on program and returns.
  clock.to(Date.UTC(2026, 9, 18, 2, 35));
  assert.equal(local('tk')['show.scene'], 'intro');
  clock.advance(9 * SEC);
  assert.equal(local('tk')['show.scene'], 'program');
  // 22:40: now playing reaches the template that has it.
  clock.to(Date.UTC(2026, 9, 18, 2, 40));
  assert.equal(of(got.tk, 'show.trigger').filter((e) => e.data.name === 'nowPlaying').length, 1);
  assert.equal(of(got['main-h'], 'show.trigger').length, 1, 'the testbed has no nowPlaying');
  // The operator moves a now-playing by hand: it stays theirs through rebuilds.
  const np50 = timeline.list(show.id).find((c) => c.at === '2026-10-18T02:50:00.000Z');
  assert.equal(timeline.update(show.id, np50.id, { at: '22:52' }).edited, true);
  const firedBefore = timeline.list(show.id).filter((c) => c.status === 'fired');
  const acts = () => [...got.tk, ...got['main-h']].filter((e) => e.type !== 'state.changed').length;
  const sent = acts();
  // 22:41: an opener is added before Manzone, and VIKKSTAR moves to 01:30.
  clock.advance(MIN);
  platform.shows.update(show.id, { lineup: [{ time: '22:00', name: 'Opener' }, LINEUP[0], { ...LINEUP[1], time: '01:30' }, LINEUP[2]] });
  clock.advance(SEC);
  const after = timeline.list(show.id);
  for (const f of firedBefore) assert.equal(after.find((c) => c.id === f.id)?.status, 'fired', `${f.label} kept its id and status`);
  assert.equal(acts(), sent, 'nothing fired on the edit');
  assert.equal(of(got.tk, 'show.trigger').length + of(got.tk, 'show.scene.changed').length, 4, 'title card, intro and its return, one now playing: nothing more');
  const opener = after.filter((c) => c.label?.startsWith('Opener'));
  assert.deepEqual(opener, [], 'the opener\'s cues were all past: a rebuild never makes those');
  assert.equal(after.filter((c) => c.key).length, 0, 'keys stay inside');
  const vik = after.find((c) => c.label === 'VIKKSTAR on');
  assert.deepEqual([vik.at, vik.action], ['2026-10-18T05:30:00.000Z', { type: 'show.slot', slot: 'VIKKSTAR' }]);
  const manzoneNp = after.filter((c) => c.label === 'Manzone: now playing');
  assert.equal(manzoneNp.at(-1).at, '2026-10-18T05:20:00.000Z', 'Manzone\'s now-playing runs to VIKKSTAR\'s new start');
  const edited = after.find((c) => c.id === np50.id);
  assert.deepEqual([edited.at, edited.edited], ['2026-10-18T02:52:00.000Z', true]);
  assert.equal(after.filter((c) => c.label === 'Manzone: now playing' && c.at === '2026-10-18T02:50:00.000Z').length, 0, 'not made again beside the edited one');
  // Stopping the recipe: what is still to come goes; what happened, and the edited cue, stay.
  const stopped = timeline.build(show.id, null);
  assert.equal(platform.shows.get(show.id).recipe, undefined);
  assert.ok(stopped.every((c) => c.status !== 'armed' || c.edited));
  assert.ok(stopped.some((c) => c.status === 'fired' && c.generated));
  assert.equal(cue(np50.id).at, Date.UTC(2026, 9, 18, 2, 52));
});

test('a timed scene played by a cue waits for no one but plays from program only; fired by hand it plays anyway', async (t) => {
  const clock = fakeClock(T0);
  const { platform, timeline, local, cue } = await setup(t, { clock });
  const show = platform.shows.create(SHOW);
  platform.shows.take(show.id, 'brb');
  const intro = timeline.add(show.id, { at: '22:01', action: { type: 'overlay.action', name: 'intro' } });
  clock.advance(MIN);
  assert.equal(cue(intro.id).status, 'fired');
  assert.match(cue(intro.id).error, /Not shown: the show was on "brb"/);
  assert.equal(local('tk')['show.scene'], 'brb', 'the operator\'s BRB stands');
  const byHand = timeline.override(show.id, intro.id, 'fire');
  assert.equal(byHand.error, undefined);
  assert.equal(local('tk')['show.scene'], 'intro');
  clock.advance(9 * SEC);
  assert.equal(local('tk')['show.scene'], 'program');
  // An action no member has: fired, with why nothing happened.
  const nobody = timeline.add(show.id, { at: '22:05', action: { type: 'overlay.action', name: 'confetti' } });
  clock.advance(5 * MIN);
  assert.match(cue(nobody.id).error, /No template here has an action "confetti"/);
});

test('media and sequences: a clip plays on every member; the steps of a sequence follow at their offsets', async (t) => {
  const clock = fakeClock(T0);
  const { platform, timeline, watch, got, local, cue } = await setup(t, { clock });
  const show = platform.shows.create(SHOW);
  const mediaId = newId('med');
  const fileId = '0123456789abcdef0123456789abcdef';
  platform.store.put('media', mediaId, { name: 'line.mp4', fileId, type: 'video/mp4', kind: 'video', size: 10, status: 'ready' });
  watch('tk');
  watch('main-h');
  timeline.add(show.id, { at: '22:01', action: { type: 'media.play', mediaId } });
  clock.advance(MIN);
  for (const slug of ['tk', 'main-h']) assert.deepEqual(of(got[slug], 'media.play').map((e) => e.data), [{ mediaId, url: `/media/${fileId}/line.mp4` }]);
  const seq = timeline.add(show.id, {
    at: '22:02',
    action: { type: 'sequence', steps: [{ offsetMs: 30 * SEC, action: { type: 'show.scene', scene: 'program' } }, { offsetMs: 0, action: { type: 'show.scene', scene: 'brb', transition: 'cut' } }, { offsetMs: 60 * SEC, action: { type: 'media.stop' } }] },
  });
  assert.deepEqual(seq.action.steps.map((s) => s.offsetMs), [0, 30 * SEC, 60 * SEC], 'in order');
  clock.advance(MIN);
  assert.equal(local('tk')['show.scene'], 'brb');
  clock.advance(30 * SEC);
  assert.equal(local('tk')['show.scene'], 'program');
  clock.advance(30 * SEC);
  assert.equal(of(got.tk, 'media.stop').length, 1);
  // A clip that isn't ready when its cue comes: fired, with the reason.
  const failing = newId('med');
  platform.store.put('media', failing, { name: 'big.mov', fileId: 'f'.repeat(32), type: 'video/mp4', kind: 'video', size: 10, status: 'ready' });
  const late = timeline.add(show.id, { at: '22:05', action: { type: 'media.play', mediaId: failing } });
  platform.store.put('media', failing, { name: 'big.mov', fileId: 'f'.repeat(32), type: 'video/mp4', kind: 'video', size: 10, status: 'processing' });
  clock.advance(2 * MIN);
  assert.match(cue(late.id).error, /isn't ready \(processing\)/);
  // A sequence cut short by a stop leaves nothing behind.
  timeline.add(show.id, { at: '22:06', action: { type: 'sequence', steps: [{ offsetMs: 0, action: { type: 'show.scene', scene: 'brb' } }, { offsetMs: 30 * SEC, action: { type: 'show.scene', scene: 'outro' } }] } });
  clock.advance(MIN);
  assert.equal(local('tk')['show.scene'], 'brb');
  assert.ok(clock.pending.some((h) => !h.every), 'its second step is waiting');
  await platform.stop();
  assert.deepEqual(clock.pending, [], 'no timer of the timeline or the shows is left');
});

test('a new night: cues at show times move with the date and are armed again; generated ones start afresh; instants stay', async (t) => {
  const clock = fakeClock(T0);
  const { platform, timeline } = await setup(t, { clock });
  const show = platform.shows.create(SHOW);
  timeline.build(show.id);
  const brb = timeline.add(show.id, { at: '22:05', action: { type: 'show.scene', scene: 'brb' } });
  const fixed = timeline.add(show.id, { at: '2026-10-18T02:06:00Z', action: { type: 'show.scene', scene: 'program' } });
  clock.to(Date.UTC(2026, 9, 18, 2, 45));
  const before = timeline.list(show.id);
  assert.equal(before.find((c) => c.id === brb.id).status, 'fired');
  platform.shows.update(show.id, { date: '2026-10-24' });
  const after = timeline.list(show.id);
  const again = after.find((c) => c.id === brb.id);
  assert.deepEqual([again.at, again.status], ['2026-10-25T02:05:00.000Z', 'armed']);
  assert.equal(after.find((c) => c.id === fixed.id).status, 'fired', 'an instant is not the show\'s night');
  const made = after.filter((c) => c.generated && c.at.startsWith('2026-10-25'));
  assert.equal(made.length, 45);
  assert.ok(made.every((c) => c.status === 'armed'));
  const kept = after.filter((c) => c.generated && !c.at.startsWith('2026-10-25'));
  assert.deepEqual(kept.map((c) => c.id), before.filter((c) => c.generated && c.status === 'fired').map((c) => c.id), 'the old night\'s: what happened stays, as history; what was to come is gone');
  // The zone changes: armed cues at show times follow it.
  platform.shows.update(show.id, { timezone: 'America/Vancouver' });
  assert.equal(timeline.list(show.id).find((c) => c.id === brb.id).at, '2026-10-25T05:05:00.000Z');
});

test('a planned show becomes the show at its day boundary, waits while the show is on air, and is pruned after 14 days', async (t) => {
  const dataRoot = tempDir(t);
  const clock = fakeClock(T0);
  const { platform, timeline, local } = await setup(t, { dataRoot, clock });
  const show = platform.shows.create({ ...SHOW, goLive: '22:00' });
  timeline.build(show.id);
  const nextLineup = [{ time: '23:00', name: 'UNDERCOVER', headliner: true }];
  const plan = timeline.plans.add(show.id, { date: '2026-10-18', lineup: nextLineup, goLive: '23:00', overlaySettings: { tk: { look: 'event', address: 'Toronto' } } });
  assert.equal(plan.activateAt, '2026-10-18T16:00:00.000Z', 'noon on its date in the show\'s zone');
  assert.deepEqual(plan.lineup, nextLineup);
  const bad = (input, code, re) => assert.throws(() => timeline.plans.add(show.id, input), (err) => err.code === code && (!re || re.test(err.message)), JSON.stringify(input));
  bad({ date: '2026-10-18' }, 'plan-exists', /already has a plan/);
  bad({ date: '2026-10-10' }, 'invalid', /over/);
  bad({ date: '2026-13-01' }, 'invalid', /date/);
  bad({ date: '2026-10-25', lineup: [{ time: '9pm', name: 'X' }] }, 'invalid', /time/);
  bad({ date: '2026-10-25', overlaySettings: { solo: {} } }, 'invalid', /isn't one of the show's overlays/);
  bad({ date: '2026-10-25', overlaySettings: { tk: { look: 'neon' } } }, 'invalid', /don't fit/);
  bad({ date: '2026-10-25', name: 'Renamed' }, 'invalid', /not name/);
  // REC starts again at 05:00 (a late night): still live at noon, so the plan waits.
  clock.to(Date.UTC(2026, 9, 18, 9, 0));
  platform.shows.rec(show.id, 'start');
  clock.to(Date.UTC(2026, 9, 18, 16, 1));
  assert.equal(platform.shows.get(show.id).date, '2026-10-17', 'not while on air');
  assert.equal(timeline.plans.list(show.id)[0].activatedAt, undefined);
  // REC has run 12 hours at 21:00Z: within five minutes, the plan is the show.
  clock.to(Date.UTC(2026, 9, 18, 21, 5));
  const now = platform.shows.get(show.id);
  assert.deepEqual([now.date, now.goLive, now.lineup.map((s) => s.name), now.live, now.recStartedAt], ['2026-10-18', '23:00', ['UNDERCOVER'], false, undefined]);
  assert.equal(local('tk')['show.lineup'][0].name, 'UNDERCOVER');
  assert.equal(platform.overlays.resolve('tk').doc.data.settings.look, 'event', 'its overlay settings applied');
  const cues = timeline.list(show.id).filter((c) => c.generated && c.status === 'armed');
  assert.ok(cues.length && cues.every((c) => c.at.startsWith('2026-10-19')), 'the timeline rebuilt for the new night');
  assert.ok(timeline.plans.list(show.id)[0].activatedAt);
  // A plan for a date whose start passed while the platform was down activates at startup.
  timeline.plans.add(show.id, { date: '2026-10-20', goLive: '21:00' });
  await platform.stop();
  const back = await setup(t, { dataRoot, clock: fakeClock(Date.UTC(2026, 9, 20, 18, 0)), overlays: false });
  assert.deepEqual([back.platform.shows.get(show.id).date, back.platform.shows.get(show.id).goLive], ['2026-10-20', '21:00']);
  await back.platform.stop();
  // Fifteen days on, both plans are gone.
  const later = await setup(t, { dataRoot, clock: fakeClock(Date.UTC(2026, 10, 5, 0, 0)), overlays: false });
  assert.deepEqual(later.timeline.plans.list(show.id), []);
});

test('the timeline API and skp show build|cues|cue|plan|plans', async (t) => {
  const { platform, config, api } = await setup(t);
  const date = '2028-06-17'; // a fixed night far from a clock change (the counts below assume one)
  const created = await api('POST', '/shows', { ...SHOW, date });
  const id = created.body.id;
  const built = await api('POST', `/shows/${id}/cues/build`, { recipe: { nowPlayingEveryMin: 30, introOffsetMin: null } });
  assert.equal(built.status, 200);
  assert.equal(built.body.items.length, 2 + 4 + 2 + 3 + 2 + 3, 'on + card (or intro) per slot, and now-playing every half hour');
  assert.ok(!built.body.items.some((c) => c.label?.includes('Event Intro')));
  const added = await api('POST', `/shows/${id}/cues`, { at: '23:59', action: { type: 'show.scene', scene: 'brb' }, label: 'Midnight break' });
  assert.equal(added.status, 201);
  const cueId = added.body.id;
  assert.equal((await api('PATCH', `/shows/${id}/cues/${cueId}`, { label: 'Break' })).body.label, 'Break');
  assert.equal((await api('POST', `/shows/${id}/cues/${cueId}/skip`)).body.status, 'skipped');
  assert.equal((await api('POST', `/shows/${id}/cues/${cueId}/rearm`)).body.status, 'armed');
  assert.equal((await api('GET', `/shows/${id}/cues`)).body.items.length, built.body.items.length + 1);
  const plan = await api('POST', `/shows/${id}/plans`, { date: '2028-06-24' });
  assert.equal(plan.status, 201);
  assert.equal((await api('GET', `/shows/${id}/plans`)).body.items.length, 1);
  assert.equal((await api('DELETE', `/shows/${id}/plans/${plan.body.id}`)).status, 200);
  const problems = [
    [await api('POST', `/shows/${id}/cues`, { at: 'soon', action: { type: 'show.scene', scene: 'brb' } }), 422, 'invalid'],
    [await api('POST', `/shows/${id}/cues/${cueId}/explode`), 422, 'invalid'],
    [await api('POST', `/shows/${id}/cues/cue_nope/fire`), 404, 'not-found'],
    [await api('POST', `/shows/${id}/cues`, { at: '23:00', action: { type: 'webhook' } }), 422, 'not-yet'],
    [await api('POST', `/shows/${id}/cues/build`, { recipe: { nowPlayingEveryMin: 0 } }), 422, 'invalid'],
    [await api('DELETE', `/shows/${id}/plans/plan_nope`), 404, 'not-found'],
    [await api('POST', `/shows/${id}/cues`, [1]), 400, undefined],
  ];
  for (const [res, status, code] of problems) {
    assert.equal(res.status, status, JSON.stringify(res.body));
    assert.match(res.type, /application\/problem\+json/);
    if (code) assert.equal(res.body.type, `https://skp.dev/errors/${code}`);
  }
  // The command line.
  const { run } = await import('../src/cli.js');
  const env = { SKP_DATA_DIR: config.dataDir, SKP_CONFIG_DIR: config.configDir, SKP_PORT: String(platform.port) };
  const cli = async (argv) => {
    let stdout = '';
    let stderr = '';
    const code = await run(argv, { stdout: { write: (s) => { stdout += s; } }, stderr: { write: (s) => { stderr += s; } }, env });
    return { code, stdout, stderr };
  };
  const listed = await cli(['show', 'cues', 'Saturday TAKEOVER']);
  assert.equal(listed.code, 0, listed.stderr);
  assert.match(listed.stdout, new RegExp(`${date} 22:30  armed    Manzone on  \\(cue_`));
  assert.match(listed.stdout, /23:59  armed    Break {2}\(cue_/);
  const add = await cli(['show', 'cue', 'add', 'Saturday TAKEOVER', '--at', '23:15', '--action', 'titleCard', '--args', '{"name":"Guest"}', '--label', 'Guest card', '--json']);
  assert.equal(add.code, 0, add.stderr);
  const guest = JSON.parse(add.stdout);
  assert.deepEqual(guest.action, { type: 'overlay.action', name: 'titleCard', args: { name: 'Guest' } });
  const fired = await cli(['show', 'cue', 'fire', 'Saturday TAKEOVER', guest.id]);
  assert.match(fired.stdout, new RegExp(`${guest.id}: fired`));
  assert.match((await cli(['show', 'cue', 'delete', 'Saturday TAKEOVER', guest.id])).stdout, /deleted cue_/);
  const two = await cli(['show', 'cue', 'add', 'Saturday TAKEOVER', '--at', '23:15', '--scene', 'brb', '--stop']);
  assert.equal(two.code, 64);
  assert.match(two.stderr, /does one thing/);
  const dir = tempDir(t);
  const seqFile = path.join(dir, 'seq.json');
  writeFileSync(seqFile, JSON.stringify({ type: 'sequence', steps: [{ offsetMs: 0, action: { type: 'show.scene', scene: 'brb' } }, { offsetMs: 5000, action: { type: 'show.scene', scene: 'program' } }] }));
  assert.equal((await cli(['show', 'cue', 'add', 'Saturday TAKEOVER', '--at', '23:20', '--cue', seqFile])).code, 0);
  const settingsFile = path.join(dir, 'settings.json');
  writeFileSync(settingsFile, JSON.stringify({ tk: { look: 'event' } }));
  const planned = await cli(['show', 'plan', 'add', 'Saturday TAKEOVER', '--date', '2028-07-01', '--go-live', '22:00', '--settings', settingsFile]);
  assert.equal(planned.code, 0, planned.stderr);
  assert.match(planned.stdout, /^planned Saturday TAKEOVER for \d{4}-\d{2}-\d{2}: it becomes the show at /);
  assert.match((await cli(['show', 'plans', 'Saturday TAKEOVER'])).stdout, /activates .* go-live 22:00, settings for tk/);
  const stop = await cli(['show', 'build', 'Saturday TAKEOVER', '--recipe', 'none']);
  assert.match(stop.stdout, /no more generated cues/);
  assert.ok(!(await api('GET', `/shows/${id}/cues`)).body.items.some((c) => c.generated));
  assert.equal((await cli(['show', 'cue', 'skip', 'Saturday TAKEOVER', 'cue_nope', '--json'])).code, 1);
});

// H19: on a running server with its clock set ahead, scheduled cues fire on the server's own
// clock, through a spring-forward night and a fall-back night (09 §9.2).
async function onClock(t, at, options = {}) {
  const offset = at - Date.now();
  const clock = { now: () => Date.now() + offset, timers: { setTimeout, clearTimeout, setInterval, clearInterval } };
  return setup(t, { ...options, clock });
}
const until = async (check, ms = 5000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
  return true;
};

test('H19: spring forward: a lineup time the clock skips fires at the instant it moved to, on a running server', async (t) => {
  // 8 March 2026, Toronto: 02:00 EST becomes 03:00 EDT. 02:30 doesn't exist; it is 03:30 EDT, 07:30Z.
  const { api, local, watch, got } = await onClock(t, Date.UTC(2026, 2, 8, 7, 29, 58));
  const created = await api('POST', '/shows', { ...SHOW, date: '2026-03-07', lineup: [{ time: '22:30', name: 'Early' }, { time: '02:30', name: 'Gap' }] });
  assert.equal(created.body.lineup[1].clockGap, true);
  const id = created.body.id;
  watch('tk');
  const built = await api('POST', `/shows/${id}/cues/build`, { recipe: { titleCard: true, introOffsetMin: null, nowPlayingEveryMin: null } });
  assert.deepEqual(built.body.items.filter((c) => c.label.startsWith('Gap')).map((c) => [c.at, c.status]), [['2026-03-08T07:30:00.000Z', 'armed'], ['2026-03-08T07:30:00.000Z', 'armed']]);
  assert.ok(built.body.items.filter((c) => c.label.startsWith('Early')).every((c) => c.status === 'missed'), 'hours ago: missed from the start');
  const byHand = await api('POST', `/shows/${id}/cues`, { at: '03:30', action: { type: 'show.scene', scene: 'brb' } });
  assert.equal(byHand.body.at, '2026-03-08T07:30:00.000Z', '03:30 EDT is the same instant');
  assert.ok(await until(() => local('tk')['show.currentSlot'] === 1), 'Gap is on, on the server\'s clock');
  assert.ok(await until(() => local('tk')['show.scene'] === 'brb'));
  assert.deepEqual(of(got.tk, 'show.trigger').map((e) => e.data.args), [{ name: 'Gap' }]);
  const cues = (await api('GET', `/shows/${id}/cues`)).body.items;
  assert.ok(cues.filter((c) => c.at === '2026-03-08T07:30:00.000Z').every((c) => c.status === 'fired' && c.firedAt >= c.at));
});

test('H19: fall back: a repeated lineup time fires once, at its first occurrence, on a running server', async (t) => {
  // 1 November 2026, Toronto: 02:00 EDT becomes 01:00 EST. 01:30 happens at 05:30Z and at 06:30Z.
  const dataRoot = tempDir(t);
  const first = await onClock(t, Date.UTC(2026, 10, 1, 5, 29, 58), { dataRoot });
  const created = await first.api('POST', '/shows', { ...SHOW, date: '2026-10-31', lineup: [{ time: '01:30', name: 'Twice' }] });
  assert.equal(created.body.lineup[0].clockOverlap, true);
  const id = created.body.id;
  first.watch('tk');
  const cue = (await first.api('POST', `/shows/${id}/cues`, { at: '01:30', action: { type: 'overlay.action', name: 'titleCard', args: { name: 'Twice' } } })).body;
  assert.equal(cue.at, '2026-11-01T05:30:00.000Z', 'the first 01:30');
  assert.equal(cue.clockOverlap, true, 'flagged: the clock reads 01:30 twice that night');
  assert.ok(await until(() => of(first.got.tk, 'show.trigger').length === 1), 'fired at the first 01:30');
  const { firedAt } = (await first.api('GET', `/shows/${id}/cues`)).body.items[0];
  await first.platform.stop();
  // An hour later the clock reads 01:30 again: the cue has fired, and does not again (from
  // startup on: nothing fires in the new process, and the cue keeps its first firing).
  const second = await onClock(t, Date.UTC(2026, 10, 1, 6, 30, 1), { dataRoot, overlays: false });
  await new Promise((r) => setTimeout(r, 1500));
  assert.deepEqual(second.entries.filter((e) => e.msg === 'cue fired'), []);
  const [after] = (await second.api('GET', `/shows/${id}/cues`)).body.items;
  assert.deepEqual([after.status, after.firedAt], ['fired', firedAt]);
});

test('H19: a cue set a moment ahead fires on a running server on the real clock', async (t) => {
  const { api, local } = await setup(t);
  const created = await api('POST', '/shows', { ...SHOW, date: new Date().toISOString().slice(0, 10) });
  const at = new Date(Date.now() + 1500).toISOString();
  const cue = await api('POST', `/shows/${created.body.id}/cues`, { at, action: { type: 'show.scene', scene: 'outro' } });
  assert.equal(cue.body.status, 'armed');
  assert.ok(await until(() => local('tk')['show.scene'] === 'outro'));
  const [after] = (await api('GET', `/shows/${created.body.id}/cues`)).body.items;
  assert.equal(after.status, 'fired');
  assert.ok(Date.parse(after.firedAt) - Date.parse(at) < 1500, 'within a tick or so');
});

// ---- from the step 10 review: nothing fires twice ------------------------------------------------
test('a mid-show fix to a slot\'s time or name, a member leaving and coming back, a recipe toggled: nothing fires twice', async (t) => {
  const clock = fakeClock(T0);
  const { platform, timeline, watch, got } = await setup(t, { clock });
  const show = platform.shows.create(SHOW);
  watch('main-h');
  watch('tk');
  timeline.build(show.id);
  const cards = () => of(got['main-h'], 'show.trigger').filter((e) => e.data.name === 'titleCard').length;
  const plays = () => of(got.tk, 'show.trigger').filter((e) => e.data.name === 'nowPlaying').length;
  clock.to(Date.UTC(2026, 9, 18, 2, 30));
  assert.equal(cards(), 1);
  // 22:33: the act started late; the operator corrects its time, then its name.
  clock.to(Date.UTC(2026, 9, 18, 2, 33));
  platform.shows.update(show.id, { lineup: [{ ...LINEUP[0], time: '22:32' }, LINEUP[1], LINEUP[2]] });
  clock.advance(2 * SEC);
  platform.shows.update(show.id, { lineup: [{ time: '22:32', name: 'Manzone & strong' }, LINEUP[1], LINEUP[2]] });
  clock.advance(2 * SEC);
  assert.equal(cards(), 1, 'the title card isn\'t shown again');
  assert.ok(timeline.list(show.id).some((c) => c.label === 'Manzone: title card' && c.status === 'fired'), 'what happened stays, as history');
  // 22:42: now playing (ten minutes into the set). tk leaves and comes back; the recipe is turned
  // off and on; then another interval.
  clock.to(Date.UTC(2026, 9, 18, 2, 42));
  assert.equal(plays(), 1);
  platform.shows.update(show.id, { overlays: ['main-h'] });
  clock.advance(30 * SEC);
  platform.shows.update(show.id, { overlays: ['tk', 'main-h'] });
  clock.advance(2 * SEC);
  timeline.build(show.id, { nowPlayingEveryMin: null });
  timeline.build(show.id, { nowPlayingEveryMin: 10 });
  clock.advance(2 * SEC);
  timeline.build(show.id, { nowPlayingEveryMin: 5 });
  clock.advance(2 * SEC);
  assert.equal(plays(), 1, 'the now-playing that went out isn\'t sent again');
  const next = timeline.list(show.id).find((c) => c.label === 'Manzone & strong: now playing' && c.status === 'armed');
  assert.equal(next.at, '2026-10-18T02:47:00.000Z', 'every five minutes from now on');
  clock.to(Date.UTC(2026, 9, 18, 2, 47));
  assert.equal(plays(), 2);
});

test('the date changed away and back: what happened that night is given back, and fires nothing again', async (t) => {
  const clock = fakeClock(T0);
  const { platform, timeline, watch, got, cue } = await setup(t, { clock });
  const show = platform.shows.create(SHOW);
  watch('main-h');
  const card = timeline.add(show.id, { at: '22:05', action: { type: 'overlay.action', name: 'titleCard', args: { name: 'Hand' } } });
  const later = timeline.add(show.id, { at: '23:00', action: { type: 'show.scene', scene: 'brb' } });
  clock.to(Date.UTC(2026, 9, 18, 2, 6));
  const firedAt = cue(card.id).firedAt;
  platform.shows.update(show.id, { date: '2026-10-18' });
  assert.equal(cue(card.id).status, 'armed', 'another night: armed for its time then');
  platform.shows.update(show.id, { date: '2026-10-17' });
  clock.advance(5 * SEC);
  assert.equal(of(got['main-h'], 'show.trigger').length, 1);
  assert.deepEqual([cue(card.id).status, cue(card.id).firedAt], ['fired', firedAt], 'given back');
  assert.equal(cue(later.id).status, 'armed', 'still to come tonight');
  // A new night whose time has already passed: missed, not fired.
  platform.shows.update(show.id, { date: '2026-10-16' });
  assert.equal(cue(card.id).status, 'missed');
  assert.equal(cue(later.id).status, 'missed');
});

test('a cue missed under a wrong zone comes back when the zone is fixed and its time is still to come', async (t) => {
  const clock = fakeClock(T0);
  const { platform, timeline, cue } = await setup(t, { clock });
  const show = platform.shows.create(SHOW);
  const early = timeline.add(show.id, { at: '21:50', action: { type: 'show.scene', scene: 'brb' } });
  clock.advance(SEC);
  assert.equal(cue(early.id).status, 'missed');
  platform.shows.update(show.id, { timezone: 'America/Vancouver' });
  assert.deepEqual([cue(early.id).status, new Date(cue(early.id).at).toISOString()], ['armed', '2026-10-18T04:50:00.000Z']);
});

test('sequences: a failing step doesn\'t stop the others; skip or delete stops what remains; a restart goes on where it was', async (t) => {
  const dataRoot = tempDir(t);
  const clock = fakeClock(T0);
  const { platform, timeline, local, cue } = await setup(t, { dataRoot, clock });
  const show = platform.shows.create(SHOW);
  const step = (offsetMs, action) => ({ offsetMs, action });
  const seq = timeline.add(show.id, { at: '22:01', action: { type: 'sequence', steps: [step(0, { type: 'overlay.action', name: 'confetti' }), step(0, { type: 'show.scene', scene: 'brb' }), step(30 * SEC, { type: 'show.scene', scene: 'program' }), step(60 * SEC, { type: 'show.scene', scene: 'outro' })] } });
  clock.advance(MIN);
  assert.equal(local('tk')['show.scene'], 'brb', 'the step after the failing one ran');
  assert.match(cue(seq.id).error, /^step 1: No template here has an action "confetti"/);
  clock.advance(30 * SEC);
  assert.equal(local('tk')['show.scene'], 'program');
  assert.match(timeline.override(show.id, seq.id, 'skip').error, /remaining steps were skipped/);
  clock.advance(30 * SEC);
  assert.equal(local('tk')['show.scene'], 'program', 'skipped: no outro');
  const two = timeline.add(show.id, { at: '22:03', action: { type: 'sequence', steps: [step(0, { type: 'show.scene', scene: 'brb' }), step(30 * SEC, { type: 'show.scene', scene: 'outro' })] } });
  clock.to(Date.UTC(2026, 9, 18, 2, 3));
  assert.equal(local('tk')['show.scene'], 'brb');
  timeline.remove(show.id, two.id);
  clock.advance(MIN);
  assert.equal(local('tk')['show.scene'], 'brb', 'deleted: its last step never came');
  // Stopped five seconds into a sequence, back ten seconds later: it goes on from its next step.
  const three = timeline.add(show.id, { at: '22:05', action: { type: 'sequence', steps: [step(0, { type: 'show.scene', scene: 'starting' }), step(20 * SEC, { type: 'show.scene', scene: 'outro' }), step(40 * SEC, { type: 'show.scene', scene: 'program' })] } });
  clock.to(Date.UTC(2026, 9, 18, 2, 5, 5));
  assert.equal(local('tk')['show.scene'], 'starting');
  await platform.stop();
  const clock2 = fakeClock(Date.UTC(2026, 9, 18, 2, 5, 15));
  const back = await setup(t, { dataRoot, clock: clock2, overlays: false });
  clock2.advance(5 * SEC);
  assert.equal(back.local('tk')['show.scene'], 'outro', 'the step due at 22:05:20');
  clock2.advance(20 * SEC);
  assert.equal(back.local('tk')['show.scene'], 'program');
  assert.equal(back.cue(three.id).stepsDone, 3);
});

test('a generated cue the operator deletes stays deleted; an edit that changes nothing changes nothing; an edited cue keeps its time when its act goes', async (t) => {
  const clock = fakeClock(T0);
  const { platform, timeline, cue } = await setup(t, { clock });
  const show = platform.shows.create(SHOW);
  timeline.build(show.id);
  const intro = timeline.list(show.id).find((c) => c.label === 'VIKKSTAR: headliner intro');
  timeline.remove(show.id, intro.id);
  platform.shows.update(show.id, { lineup: [LINEUP[0], LINEUP[1], { ...LINEUP[2], time: '03:30' }] });
  timeline.build(show.id);
  assert.equal(timeline.list(show.id).filter((c) => c.label === 'VIKKSTAR: headliner intro').length, 0, 'not made again');
  assert.throws(() => timeline.update(show.id, intro.id, { label: 'x' }), { code: 'not-found' });
  const np = timeline.list(show.id).find((c) => c.label === 'Manzone: now playing');
  assert.equal(timeline.update(show.id, np.id, { label: np.label }).edited, undefined, 'the same label: not an edit');
  // The operator moves VIKKSTAR's Event Intro to 01:10; then VIKKSTAR is renamed and the zone fixed.
  const vikIntro = timeline.list(show.id).find((c) => c.label === 'VIKKSTAR: Event Intro');
  timeline.update(show.id, vikIntro.id, { at: '01:10' });
  platform.shows.update(show.id, { timezone: 'America/Vancouver', lineup: [LINEUP[0], { ...LINEUP[1], name: 'VIK' }, LINEUP[2]] });
  const kept = cue(vikIntro.id);
  assert.deepEqual([kept.generated, kept.time, new Date(kept.at).toISOString(), kept.status], [undefined, '01:10', '2026-10-18T08:10:00.000Z', 'armed'], 'the operator\'s now, at their time in the new zone');
});

test('plans follow the show\'s zone; only its members get settings; activation clears who\'s on; what failed is said', async (t) => {
  const clock = fakeClock(T0);
  const { platform, timeline } = await setup(t, { clock });
  const show = platform.shows.create(SHOW);
  timeline.plans.add(show.id, { date: '2026-10-18', overlaySettings: { tk: { look: 'event' } } });
  platform.shows.update(show.id, { timezone: 'America/Vancouver' });
  assert.equal(timeline.plans.list(show.id)[0].activateAt, '2026-10-18T19:00:00.000Z', 'noon in the new zone');
  platform.shows.update(show.id, { overlays: ['main-h'] }); // tk joins another show, on air
  platform.shows.create({ ...SHOW, name: 'Other', overlays: ['tk'] });
  platform.shows.setSlot(show.id, 1);
  clock.to(Date.UTC(2026, 9, 18, 16, 0));
  assert.equal(platform.shows.get(show.id).date, '2026-10-17', 'not at Toronto\'s noon any more');
  clock.to(Date.UTC(2026, 9, 18, 19, 0));
  const plan = timeline.plans.list(show.id)[0];
  assert.ok(plan.activatedAt);
  assert.equal(platform.shows.get(show.id).date, '2026-10-18');
  assert.equal(platform.shows.get(show.id).currentSlot, undefined, 'who\'s on: back to before the show');
  assert.equal(platform.overlays.resolve('tk').doc.data.settings.look, undefined, 'tk is another show\'s now: left alone');
  assert.equal(plan.warnings.length, 1);
  assert.match(plan.warnings[0], /^tk: no longer one of the show's overlays/);
});

test('a plan\'s settings follow their overlay through a rename, and never go to a new one that took the old slug', async (t) => {
  const clock = fakeClock(T0);
  const { platform, timeline, api } = await setup(t, { clock });
  const show = platform.shows.create(SHOW);
  const settings = { look: 'event', address: 'Toronto' };
  timeline.plans.add(show.id, { date: '2026-10-18', overlaySettings: { tk: settings } });
  assert.equal((await api('PATCH', '/overlays/tk', { slug: 'tk-old' })).status, 200);
  assert.deepEqual(timeline.plans.list(show.id)[0].overlaySettings, { 'tk-old': settings }, 'shown by the slug it has now');
  platform.overlays.create({ slug: 'tk', template: TAKEOVER, settings: {} });
  platform.shows.update(show.id, { overlays: ['tk-old', 'main-h', 'tk'] });
  clock.to(Date.UTC(2026, 9, 18, 16, 1));
  const plan = timeline.plans.list(show.id)[0];
  assert.ok(plan.activatedAt);
  assert.equal(plan.warnings, undefined);
  assert.deepEqual(platform.overlays.resolve('tk-old').doc.data.settings, settings, 'the renamed overlay got them');
  assert.deepEqual(platform.overlays.resolve('tk').doc.data.settings, {}, 'the new "tk" did not');
});

test('a plan\'s settings for an overlay deleted since are shown by the slug it had, never by its bare id or another overlay\'s slug', async (t) => {
  const clock = fakeClock(T0);
  const { platform, timeline, api } = await setup(t, { clock });
  const show = platform.shows.create(SHOW);
  const id = platform.overlays.resolve('tk').doc.id;
  timeline.plans.add(show.id, { date: '2026-10-18', overlaySettings: { tk: { look: 'event' }, 'main-h': {} } });
  assert.equal((await api('DELETE', '/overlays/tk')).status, 200);
  assert.deepEqual(Object.keys(timeline.plans.list(show.id)[0].overlaySettings), ['tk', 'main-h'], 'the slug it had when the plan was saved');
  assert.deepEqual(Object.keys((await api('GET', `/shows/${show.id}/plans`)).body.items[0].overlaySettings), ['tk', 'main-h']);
  // Another overlay takes the slug: "tk" names that one now, so the deleted one is shown by its id.
  assert.equal((await api('PATCH', '/overlays/main-h', { slug: 'tk' })).status, 200);
  assert.deepEqual(Object.keys(timeline.plans.list(show.id)[0].overlaySettings), [id, 'tk'], 'two entries still, neither hiding the other');
  assert.equal((await api('PATCH', '/overlays/tk', { slug: 'main-h' })).status, 200);
  clock.to(Date.UTC(2026, 9, 18, 16, 1));
  const plan = timeline.plans.list(show.id)[0];
  assert.ok(plan.activatedAt);
  assert.deepEqual(plan.warnings, ['tk: no longer one of the show\'s overlays; its settings were left alone']);
});

test('at startup only the latest plan whose day has begun is the show, by the show day\'s real end', async (t) => {
  const dataRoot = tempDir(t);
  const { platform, timeline } = await setup(t, { dataRoot, clock: fakeClock(T0) });
  const show = platform.shows.create(SHOW);
  timeline.plans.add(show.id, { date: '2026-10-21', goLive: '21:00' });
  timeline.plans.add(show.id, { date: '2026-10-20', goLive: '20:00' });
  await platform.stop();
  // Back on the 21st at 13:00 Toronto time: both days have begun; the 21st is the show.
  const back = await setup(t, { dataRoot, clock: fakeClock(Date.UTC(2026, 9, 21, 17, 0)), overlays: false });
  assert.deepEqual([back.platform.shows.get(show.id).date, back.platform.shows.get(show.id).goLive], ['2026-10-21', '21:00']);
  const [first, second] = back.timeline.plans.list(show.id);
  assert.match(first.error, /the plan for 2026-10-21 came after it/);
  assert.equal(second.error, undefined);
  await back.platform.stop();
  // On a 25-hour day (clocks fall back on 1 November), the 31 October plan's day lasts until noon
  // on the 1st, local time: 17:00Z.
  const p = await setup(t, { dataRoot, clock: fakeClock(Date.UTC(2026, 9, 25, 0, 0)), overlays: false });
  p.timeline.plans.add(show.id, { date: '2026-10-31', goLive: '22:00' });
  await p.platform.stop();
  const late = await setup(t, { dataRoot, clock: fakeClock(Date.UTC(2026, 10, 1, 16, 30)), overlays: false });
  assert.equal(late.platform.shows.get(show.id).date, '2026-10-31', 'its day wasn\'t over yet');
});

test('refusals: a media id that isn\'t one, a date that doesn\'t exist, a plan for the year 9999; a time a clock change skips is flagged', async (t) => {
  const { platform, timeline } = await setup(t, { clock: fakeClock(T0) });
  const show = platform.shows.create(SHOW);
  const ok = { type: 'show.scene', scene: 'brb' };
  for (const input of [
    { at: '22:00', action: { type: 'media.play', mediaId: 'has space' } },
    { at: '22:00', action: { type: 'media.play', mediaId: '' } },
    { at: '2026-02-30T10:00:00Z', action: ok },
    { at: '2026-10-18T24:00:00Z', action: ok },
    { at: '2026-10-18T10:60:00Z', action: ok },
    { at: '2026-10-18T10:00:00+25:00', action: ok },
  ]) assert.throws(() => timeline.add(show.id, input), { code: 'invalid' }, JSON.stringify(input));
  assert.throws(() => timeline.plans.add(show.id, { date: '9999-12-31' }), { code: 'invalid' });
  assert.throws(() => timeline.plans.add(show.id, { date: '2031-01-01' }), (err) => err.code === 'invalid' && /three years/.test(err.message));
  // Spring forward, 8 March 2026: 02:30 doesn't exist in Toronto; it is 03:30 EDT.
  platform.shows.update(show.id, { date: '2026-03-07' });
  const gap = timeline.add(show.id, { at: '02:30', action: ok });
  assert.deepEqual([gap.at, gap.clockGap], ['2026-03-08T07:30:00.000Z', true]);
});

// ---- v0 parity: re-arm all, a cue's act, the acts roster, a plan's own lineup -------------------
// A request with headers of its own (If-Match), over the API as a token.
const send = (platform, method, url, body, headers = {}) => fetch(`${platform.url}/api/v1${url}`, {
  method,
  headers: signedIn(platform, { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }),
  body: body === undefined ? undefined : JSON.stringify(body),
}).then(async (res) => ({ status: res.status, etag: res.headers.get('etag'), body: await res.json().catch(() => null) }));

test('re-arm all (v0\'s "re-arm"): every cue still to come that was skipped or fired early is armed again; what has passed stays; one override, recorded', async (t) => {
  const clock = fakeClock(T0);
  const { platform, timeline, api, cue, watch, got, local } = await setup(t, { clock });
  const show = platform.shows.create(SHOW);
  watch('main-h');
  timeline.build(show.id);
  const title = (name) => ({ type: 'overlay.action', name: 'titleCard', args: { name } });
  const past = timeline.add(show.id, { at: '22:01', action: title('Past') });
  const early = timeline.add(show.id, { at: '23:00', action: title('Early') });
  const skipped = timeline.add(show.id, { at: '23:30', action: title('Skipped') });
  const armed = timeline.add(show.id, { at: '23:45', action: title('Armed') });
  const seq = timeline.add(show.id, { at: '23:50', action: { type: 'sequence', steps: [{ offsetMs: 0, action: { type: 'show.scene', scene: 'brb' } }, { offsetMs: 30 * SEC, action: { type: 'show.scene', scene: 'outro' } }] } });
  clock.to(Date.UTC(2026, 9, 18, 2, 2)); // 22:02: the first has fired at its time
  timeline.override(show.id, early.id, 'fire');
  timeline.override(show.id, skipped.id, 'skip');
  timeline.override(show.id, seq.id, 'fire'); // BRB now; its outro would come 30 s later
  // A command, like the other overrides: no If-Match, an empty body.
  const res = await api('POST', `/shows/${show.id}/cues/rearm`, {});
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.items.map((c) => c.id), [early.id, skipped.id, seq.id], 'the cues it re-armed, in time order');
  assert.ok(res.body.items.every((c) => c.status === 'armed' && !c.firedAt && c.stepsDone === undefined && Number.isInteger(c.rev)));
  assert.equal(cue(past.id).status, 'fired', 'its time has passed: it stays as it is');
  assert.equal(platform.store.get('cues', armed.id).rev, 1, 'an armed cue isn\'t touched');
  clock.advance(MIN);
  assert.equal(local('main-h')['show.scene'], 'brb', 'the sequence fired early stops where it was');
  clock.to(Date.UTC(2026, 9, 18, 3, 30));
  assert.deepEqual(of(got['main-h'], 'show.trigger').map((e) => e.data.args.name).filter((n) => n !== 'Manzone'), ['Past', 'Early', 'Early', 'Skipped'], 'fired early, then again at its time; the skipped one at its time');
  // Nothing left to re-arm: an empty list. Another night's generated cues stay its history.
  platform.shows.update(show.id, { date: '2026-10-24' });
  const history = timeline.list(show.id).filter((c) => c.generated && c.status === 'fired' && c.at.startsWith('2026-10-18'));
  assert.ok(history.length);
  assert.deepEqual((await api('POST', `/shows/${show.id}/cues/rearm`, {})).body.items, []);
  assert.ok(history.every((c) => cue(c.id).status === 'fired'));
  // Recorded (07 §7.12), as one override each time.
  const ops = platform.audit.list({ action: 'cue' }).items.filter((e) => e.action === 'cue.rearm-all').reverse();
  assert.deepEqual(ops.map((e) => [e.target, e.details]), [[show.id, { show: show.id, cues: 3 }], [show.id, { show: show.id, cues: 0 }]]);
  assert.ok(ops[0].actor);
  // Refusals: a show that isn't, a body with fields. It takes what the other overrides take.
  assert.equal((await api('POST', '/shows/nope/cues/rearm', {})).status, 404);
  assert.equal((await api('POST', `/shows/${show.id}/cues/rearm`, { all: true })).status, 422);
  const doc = (await api('GET', '/openapi.json')).body;
  assert.equal(doc.paths['/api/v1/shows/{ref}/cues/rearm'].post['x-skp-scope'], doc.paths['/api/v1/shows/{ref}/cues/{cueId}/{op}'].post['x-skp-scope']);
});

test('a hand-made title card or now-playing names its act (args.name), checked; as a sequence it puts the act on, then shows the card', async (t) => {
  const clock = fakeClock(T0);
  const { platform, timeline, watch, got, local, cue, api } = await setup(t, { clock });
  const show = platform.shows.create(SHOW);
  watch('tk');
  const card = (args, name = 'titleCard') => ({ type: 'overlay.action', name, ...(args ? { args } : {}) });
  const later = (action) => timeline.add(show.id, { at: '04:00', action }).action;
  // Trimmed; an empty name (or null) is whoever is on; the template's other args stay as they are.
  assert.deepEqual(later(card({ name: '  VIKKSTAR ' })), card({ name: 'VIKKSTAR' }));
  assert.deepEqual(later(card({ name: ' ' })), card());
  assert.deepEqual(later(card({ name: null, extra: 1 }, 'nowPlaying')), card({ extra: 1 }, 'nowPlaying'));
  assert.deepEqual(later(card({ name: 'Guest', b2b: 'Friend' })), card({ name: 'Guest', b2b: 'Friend' }), 'an act not in the lineup shows by its name');
  // Refusals say what to fix, in a sequence's steps too, and over the API.
  for (const [args, re] of [[{ name: 5 }, /"args.name" is the act's name/], [{ name: 'x'.repeat(81) }, /at most 80/], [{ b2b: 'Friend' }, /goes with "args.name"/], [{ name: 'A', b2b: ['B'] }, /"args.b2b"/]]) {
    assert.throws(() => later(card(args)), (err) => err.code === 'invalid' && re.test(err.message), JSON.stringify(args));
    assert.throws(() => later({ type: 'sequence', steps: [{ offsetMs: 0, action: card(args, 'nowPlaying') }] }), { code: 'invalid' }, JSON.stringify(args));
  }
  const refused = await api('POST', `/shows/${show.id}/cues`, { at: '23:00', action: card({ name: 7 }, 'nowPlaying') });
  assert.deepEqual([refused.status, refused.body.type], [422, 'https://skp.dev/errors/invalid']);
  // Another action's args are its template's own: not read as an act. A now-playing held until
  // hidden is about an act, like the others.
  assert.deepEqual(later(card({ name: 5 }, 'chipOnAt')).args, { name: 5 });
  assert.deepEqual(later(card({ name: ' Deecee ' }, 'nowPlayingHold')), card({ name: 'Deecee' }, 'nowPlayingHold'));
  assert.throws(() => later(card({ b2b: 'Friend' }, 'nowPlayingHold')), { code: 'invalid' });
  // Fired: the card is about the act named, whoever is on.
  platform.shows.setSlot(show.id, 0);
  const vik = timeline.add(show.id, { at: '22:10', action: card({ name: 'VIKKSTAR' }) });
  clock.to(Date.UTC(2026, 9, 18, 2, 10));
  assert.equal(cue(vik.id).status, 'fired');
  assert.deepEqual(of(got.tk, 'show.trigger').map((e) => [e.data.name, e.data.args]), [['titleCard', { name: 'VIKKSTAR' }]]);
  assert.equal(local('tk')['show.currentSlot'], 0, 'who\'s on stays as it was');
  // v0's DJ title card: the act's show.slot, then its card, at one instant, one cue.
  const djtitle = (await api('POST', `/shows/${show.id}/cues`, { at: '22:20', action: { type: 'sequence', steps: [{ offsetMs: 0, action: { type: 'show.slot', slot: 'Deecee' } }, { offsetMs: 0, action: card({ name: 'Deecee' }) }] } })).body;
  const from = got.tk.length;
  await new Promise((r) => setTimeout(r, 150)); // the bus sends a key at most every 100 ms (02 §2.9), in real time
  clock.to(Date.UTC(2026, 9, 18, 2, 20));
  const seen = got.tk.slice(from).filter((e) => (e.type === 'state.changed' && e.data.key === 'show.currentSlot') || e.type === 'show.trigger');
  assert.deepEqual(seen.map((e) => e.type), ['state.changed', 'show.trigger'], 'the act is on before its card shows');
  assert.deepEqual(seen[1].data.args, { name: 'Deecee' });
  assert.equal(local('tk')['show.currentSlot'], 2);
  assert.deepEqual([cue(djtitle.id).status, cue(djtitle.id).stepsDone, cue(djtitle.id).error], ['fired', 2, undefined]);
});

test('the acts of every lineup and plan, partners too, latest night first: the names a lineup is offered (v0\'s roster)', async (t) => {
  const clock = fakeClock(T0);
  const { platform, timeline, api } = await setup(t, { clock });
  platform.overlays.create({ slug: 'other', template: TESTBED, settings: {} });
  const show = platform.shows.create({ ...SHOW, lineup: [{ time: '22:30', name: 'Manzone', b2b: 'strong' }, { time: '01:00', name: 'VIKKSTAR', headliner: true, logo: '/media/abc/vik.png' }] });
  platform.shows.create({ ...SHOW, name: 'Last month', overlays: ['other'], date: '2026-09-19', lineup: [{ time: '23:00', name: 'vikkstar', logo: '/media/old/vik.png' }, { time: '00:00', name: 'Old  Timer', logo: '/media/old/ot.png' }] });
  timeline.plans.add(show.id, { date: '2026-10-24', lineup: [{ time: '23:00', name: 'UNDERCOVER' }, { time: '00:00', name: 'manzone' }, { time: '01:00', name: 'VIKKSTAR' }] });
  const want = [
    { name: 'manzone', date: '2026-10-24' }, // spelled as on its latest night
    { name: 'UNDERCOVER', date: '2026-10-24' },
    { name: 'VIKKSTAR', date: '2026-10-24', logo: '/media/abc/vik.png' }, // the latest logo it had
    { name: 'strong', date: '2026-10-17' }, // a partner (B2B)
    { name: 'Old  Timer', date: '2026-09-19', logo: '/media/old/ot.png' },
  ];
  assert.deepEqual(timeline.acts(), want);
  // Over the API, a page at a time.
  const first = await api('GET', '/acts?limit=2');
  assert.equal(first.status, 200);
  assert.deepEqual(first.body.items, want.slice(0, 2));
  const rest = await api('GET', `/acts?limit=200&cursor=${first.body.next}`);
  assert.deepEqual([...first.body.items, ...rest.body.items], want);
  assert.equal(rest.body.next, undefined);
  // Kept nowhere of its own: a show deleted takes its names with it.
  platform.shows.remove('Last month');
  assert.deepEqual(timeline.acts().map((a) => a.name), ['manzone', 'UNDERCOVER', 'VIKKSTAR', 'strong']);
});

test('a plan is read, replaced whole with its If-Match, and applied by hand before its day (v0\'s "Load now"), never on air', async (t) => {
  const clock = fakeClock(T0);
  const { platform, local } = await setup(t, { clock });
  const call = (...args) => send(platform, ...args);
  const show = platform.shows.create({ ...SHOW, goLive: '22:00' });
  const base = `/shows/${show.id}/plans`;
  const made = (await call('POST', base, { date: '2026-10-24', goLive: '23:00', overlaySettings: { tk: { look: 'event' } } })).body;
  const read = await call('GET', `${base}/${made.id}`);
  assert.deepEqual([read.status, read.body, read.etag], [200, made, `"${made.id}-r${made.rev}"`]);
  // Replaced whole: its own lineup; go-live left out, so the show keeps its own that day.
  const lineup = [{ time: '23:00', name: 'UNDERCOVER', headliner: true }, { time: '01:00', name: 'Deecee', closer: true }];
  const put = await call('PUT', `${base}/${made.id}`, { date: '2026-10-31', lineup, overlaySettings: made.overlaySettings }, { 'if-match': read.etag });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.deepEqual([put.body.date, put.body.lineup, put.body.goLive, put.body.overlaySettings, put.body.activateAt], ['2026-10-31', lineup, undefined, { tk: { look: 'event' } }, '2026-10-31T16:00:00.000Z']);
  assert.equal(put.etag, `"${made.id}-r${made.rev + 1}"`);
  // What the If-Match read is no longer it: 412; the body is checked as a new plan's.
  assert.equal((await call('PUT', `${base}/${made.id}`, { date: '2026-10-31' }, { 'if-match': read.etag })).status, 412);
  const now = { 'if-match': put.etag };
  for (const [body, status, code] of [
    [{ date: '2026-10-31', lineup: [{ time: '9pm', name: 'X' }] }, 422, 'invalid'],
    [{ date: '2026-10-10' }, 422, 'invalid'],
    [{ date: '2026-10-31', name: 'Renamed' }, 422, 'unknown-field'],
    [{ lineup }, 422, 'invalid'],
  ]) {
    const res = await call('PUT', `${base}/${made.id}`, body, now);
    assert.deepEqual([res.status, res.body.type], [status, `https://skp.dev/errors/${code}`], JSON.stringify(body));
  }
  // Another plan's date: refused; its own date again is no clash.
  const other = (await call('POST', base, { date: '2026-11-07' })).body;
  const clash = await call('PUT', `${base}/${made.id}`, { date: '2026-11-07' }, now);
  assert.deepEqual([clash.status, clash.body.type], [409, 'https://skp.dev/errors/plan-exists']);
  // Its settings sent back as read are kept, even for an overlay that has left the show since;
  // changed, they are checked again.
  platform.shows.update(show.id, { overlays: ['main-h'] });
  const kept = await call('PUT', `${base}/${made.id}`, { date: '2026-10-31', lineup, goLive: '22:30', overlaySettings: { tk: { look: 'event' } } }, now);
  assert.deepEqual([kept.status, kept.body.goLive, kept.body.overlaySettings], [200, '22:30', { tk: { look: 'event' } }]);
  const changed = await call('PUT', `${base}/${made.id}`, { date: '2026-10-31', overlaySettings: { tk: { look: 'takeover' } } }, { 'if-match': kept.etag });
  assert.equal(changed.status, 422);
  assert.match(changed.body.detail, /isn't one of the show's overlays/);
  // Applied by hand: never while the show is live.
  platform.shows.rec(show.id, 'start');
  const live = await call('POST', `${base}/${made.id}/apply`, {});
  assert.deepEqual([live.status, live.body.type], [409, 'https://skp.dev/errors/live']);
  platform.shows.rec(show.id, 'reset');
  const applied = await call('POST', `${base}/${made.id}/apply`, {});
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  assert.ok(applied.body.activatedAt);
  const after = platform.shows.get(show.id);
  assert.deepEqual([after.date, after.goLive, after.lineup.map((s) => s.name)], ['2026-10-31', '22:30', ['UNDERCOVER', 'Deecee']]);
  assert.equal(local('main-h')['show.lineup'][0].name, 'UNDERCOVER', 'its members see it at once');
  assert.deepEqual(platform.audit.list({ action: 'plan' }).items.map((e) => [e.action, e.target, e.details]), [['plan.apply', made.id, { show: show.id, date: '2026-10-31' }]]);
  // Applied, it is history: not changed, not applied again. The other plan is still to come.
  assert.deepEqual((await call('PUT', `${base}/${made.id}`, { date: '2026-10-31' }, { 'if-match': `"${made.id}-r${applied.body.rev}"` })).body.type, 'https://skp.dev/errors/applied');
  assert.equal((await call('POST', `${base}/${made.id}/apply`, {})).status, 409);
  assert.equal((await call('GET', `${base}/${other.id}`)).body.activatedAt, undefined);
  assert.equal((await call('GET', `${base}/plan_nope`)).status, 404);
  assert.equal((await call('PUT', `${base}/plan_01ARZ3NDEKTSV4RRFFQ69G5FAV`, { date: '2026-11-14' }, now)).status, 404);
});

test('a plan the show couldn\'t send to its overlays is refused as the show\'s own change is; one stored anyway is refused by hand, stays to fix, and changes nothing on its day', async (t) => {
  const clock = fakeClock(T0);
  const { platform, local } = await setup(t, { clock });
  const call = (...args) => send(platform, ...args);
  const show = platform.shows.create({ ...SHOW, goLive: '22:00' });
  const base = `/shows/${show.id}/plans`;
  // 60 acts with long logo URLs: over 24 KiB as published (09 §9.1).
  const big = Array.from({ length: 60 }, (_, i) => ({ time: '23:00', name: `Act ${i + 1}`, logo: `https://cdn.example.com/${'x'.repeat(400)}/${i}.png` }));
  const tooLarge = (res, what) => assert.deepEqual([res.status, res.body.type], [422, 'https://skp.dev/errors/too-large'], what);
  const read = await call('GET', `/shows/${show.id}`);
  tooLarge(await call('PATCH', `/shows/${show.id}`, { lineup: big }, { 'if-match': read.etag }), 'the show\'s own change');
  tooLarge(await call('POST', base, { date: '2026-10-18', lineup: big }), 'a new plan');
  const made = (await call('POST', base, { date: '2026-10-18', lineup: [{ time: '23:00', name: 'UNDERCOVER' }] })).body;
  tooLarge(await call('PUT', `${base}/${made.id}`, { date: '2026-10-18', lineup: big }, { 'if-match': `"${made.id}-r${made.rev}"` }), 'a plan replaced');
  // Its date planned again: said as the change it is.
  const again = await call('POST', base, { date: '2026-10-18' });
  assert.equal(again.status, 409);
  assert.match(again.body.detail, /already has a plan for 2026-10-18: change that one, or delete it first/);
  // One stored before this was checked: by hand, refused before anything changes, and it stays a
  // plan to fix or apply later; nothing is recorded.
  const doc = platform.store.get('show_plans', made.id);
  platform.store.put('show_plans', made.id, { ...doc.data, changes: { ...doc.data.changes, lineup: big } });
  platform.shows.setSlot(show.id, 1);
  tooLarge(await call('POST', `${base}/${made.id}/apply`, {}), 'applied by hand');
  const kept = (await call('GET', `${base}/${made.id}`)).body;
  assert.deepEqual([kept.activatedAt, kept.error], [undefined, undefined]);
  assert.deepEqual(platform.audit.list({ action: 'plan' }).items, []);
  assert.equal(platform.shows.get(show.id).date, '2026-10-17');
  // On its day: nothing changes (not who's on either), and the plan says why.
  clock.to(Date.UTC(2026, 9, 18, 16, 1));
  const done = (await call('GET', `${base}/${made.id}`)).body;
  assert.match(done.error, /too large to send to its overlays/);
  assert.deepEqual([platform.shows.get(show.id).date, platform.shows.get(show.id).currentSlot, local('tk')['show.currentSlot']], ['2026-10-17', 1, 1]);
});