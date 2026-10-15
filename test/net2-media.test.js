// What keeps an uploaded file from being deleted (03 §3.4), as the running platform and the
// command line apply it: an overlay's settings, a show's lineup, a cue that will still play it (a
// sequence that has fired, with a step still to come, too) and a plan still to come.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { openData, startPlatform } from '../src/app.js';
import { run } from '../src/cli.js';
import { loadConfig } from '../src/config.js';
import { mediaUrl, mediaUsers } from '../src/media/library.js';
import { defer, memoryLogger, signedIn, tempDir } from './helpers.js';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(256, 7)]);
const TAKEOVER = { id: 'com.dprtmnt.takeover', version: '1.0.0' };
const DAY_MS = 24 * 60 * 60 * 1000;
const dayIn = (days) => new Date(Date.now() + days * DAY_MS).toISOString().slice(0, 10);
// A sequence that stops what plays now, and plays a clip a minute later.
const later = (mediaId) => ({ type: 'sequence', steps: [{ offsetMs: 0, action: { type: 'media.stop' } }, { offsetMs: 60000, action: { type: 'media.play', mediaId } }] });

function dirs(t) {
  const root = tempDir(t);
  return { SKP_DATA_DIR: path.join(root, 'data'), SKP_CONFIG_DIR: path.join(root, 'config') };
}

async function cli(argv, env) {
  let stdout = '';
  let stderr = '';
  const code = await run(argv, { stdout: { write: (s) => { stdout += s; } }, stderr: { write: (s) => { stderr += s; } }, env });
  return { code, stdout, stderr };
}

test('the running platform refuses to delete a file a lineup, a cue or a running sequence uses, and names them', async (t) => {
  let now = Date.now();
  const config = loadConfig({ argv: ['--port', '0'], env: dirs(t) });
  const platform = await startPlatform(config, { log: memoryLogger().log, clock: { now: () => now } });
  defer(t, () => platform.stop());
  const api = async (method, p, body) => {
    const res = await fetch(`${platform.url}/api/v1${p}`, { method, body, headers: signedIn(platform, body ? { 'content-type': 'application/octet-stream' } : {}) });
    return { status: res.status, body: await res.json() };
  };
  const upload = async (name) => {
    const r = await api('POST', `/media?name=${name}`, PNG);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body;
  };
  const logo = await upload('logo.png');
  const clip = await upload('clip.png');
  const step = await upload('step.png');
  platform.overlays.create({ slug: 'tk', template: TAKEOVER, settings: {} });
  const show = platform.shows.create({ name: 'Night', overlays: ['tk'], date: dayIn(3), timezone: 'America/Toronto', lineup: [{ time: '22:00', name: 'VIK', logo: logo.url }] });
  platform.timeline.add(show.id, { at: '23:00', action: { type: 'media.play', mediaId: clip.id } });
  const seq = platform.timeline.add(show.id, { at: new Date(now + DAY_MS).toISOString(), action: later(step.id) });
  platform.timeline.override(show.id, seq.id, 'fire', { actor: 'test' });

  assert.deepEqual((await api('GET', `/media/${logo.id}`)).body.usedBy, ['lineup of show Night']);
  assert.deepEqual((await api('GET', `/media/${clip.id}`)).body.usedBy, ['cue at 23:00 in show Night']);
  assert.deepEqual((await api('GET', `/media/${step.id}`)).body.usedBy, [`cue at ${seq.at} in show Night`], 'its media.play step is a minute away');
  for (const doc of [logo, clip, step]) {
    const refused = await api('DELETE', `/media/${doc.id}`);
    assert.equal(refused.status, 409, doc.name);
    assert.match(refused.body.type, /\/in-use$/);
    assert.match(refused.body.detail, new RegExp(`${doc.name.replace('.', '\\.')} is used by "`));
  }
  assert.equal((await fetch(`${platform.url}${logo.url}`)).status, 200, 'the logo is still served');
  // The step's time passing isn't enough: until it has played it may still, a restart's grace late
  // (H5). Once that is over too (on the timeline's clock), the sequence no longer uses the file.
  now += 60001;
  assert.deepEqual((await api('GET', `/media/${step.id}`)).body.usedBy, [`cue at ${seq.at} in show Night`]);
  now += platform.timeline.graceMs;
  assert.deepEqual((await api('GET', `/media/${step.id}`)).body.usedBy, []);
  assert.deepEqual(await api('DELETE', `/media/${step.id}`), { status: 200, body: { removed: step.id } });
});

test('a fired sequence counts while a media.play step is still to come, and not after', async (t) => {
  const data = openData(loadConfig({ argv: [], env: dirs(t) }), { log: memoryLogger().log, media: { lowerPriority: false } });
  defer(t, () => data.close());
  const { media, overlays, shows, timeline } = data;
  const clip = await media.add(PNG, { name: 'clip.png' });
  overlays.create({ slug: 'tk', template: TAKEOVER, settings: {} });
  const show = shows.create({ name: 'Night', overlays: ['tk'], date: dayIn(3), timezone: 'America/Toronto' });
  const cue = timeline.add(show.id, { at: new Date(Date.now() + DAY_MS).toISOString(), action: later(clip.id) });
  const fired = timeline.override(show.id, cue.id, 'fire');
  assert.equal(fired.status, 'fired');
  const firedAt = Date.parse(fired.firedAt);
  assert.deepEqual(mediaUsers({ ...data, now: () => firedAt + 59999 })(clip), [`cue at ${cue.at} in show Night`]);
  assert.throws(() => media.remove(clip.id, { usedBy: mediaUsers({ ...data, now: () => firedAt + 59999 }) }), { code: 'in-use' });
  // Due but not yet played (the platform was down): a restart still plays it within the grace.
  assert.deepEqual(mediaUsers({ ...data, now: () => firedAt + 60000 + 60000 })(clip), [`cue at ${cue.at} in show Night`], 'a restart can still play it');
  assert.deepEqual(mediaUsers({ ...data, now: () => firedAt + 60000 + timeline.graceMs })(clip), [], 'too late: it would be missed, not played');
  // Skipping the sequence marks its steps done: the file is free at once.
  const third = await media.add(PNG, { name: 'third.png' });
  const again = timeline.add(show.id, { at: new Date(Date.now() + DAY_MS).toISOString(), action: later(third.id) });
  timeline.override(show.id, again.id, 'fire');
  assert.equal(mediaUsers(data)(third).length, 1);
  timeline.override(show.id, again.id, 'skip');
  assert.deepEqual(mediaUsers(data)(third), []);
  // A sequence whose media.play step came first has played it: it doesn't hold the file.
  const first = await media.add(PNG, { name: 'first.png' });
  const early = timeline.add(show.id, { at: new Date(Date.now() + DAY_MS).toISOString(), action: { type: 'sequence', steps: [{ offsetMs: 0, action: { type: 'media.play', mediaId: first.id } }, { offsetMs: 60000, action: { type: 'media.stop' } }] } });
  timeline.override(show.id, early.id, 'fire');
  assert.deepEqual(mediaUsers(data)(first), []);
});

test('skp media remove refuses a file a show\'s lineup or a cue uses, as the API does', async (t) => {
  const env = { ...dirs(t), SKP_FFMPEG: path.join(tempDir(t), 'no-ffmpeg-here') };
  const data = openData(loadConfig({ argv: [], env }), { log: memoryLogger().log });
  let logo;
  let clip;
  let free;
  try {
    logo = await data.media.add(PNG, { name: 'logo.png' });
    clip = await data.media.add(PNG, { name: 'clip.png' });
    free = await data.media.add(PNG, { name: 'free.png' });
    data.overlays.create({ slug: 'tk', template: TAKEOVER, settings: {} });
    const show = data.shows.create({ name: 'Night', overlays: ['tk'], date: dayIn(3), timezone: 'America/Toronto', lineup: [{ time: '22:00', name: 'VIK', logo: mediaUrl(logo) }] });
    data.timeline.add(show.id, { at: '23:00', action: { type: 'media.play', mediaId: clip.id } });
  } finally {
    data.close();
  }
  const lineup = await cli(['media', 'remove', logo.id], env);
  assert.equal(lineup.code, 1, lineup.stdout);
  assert.match(lineup.stderr, /logo\.png is used by "lineup of show Night"; change it first/);
  const cue = await cli(['media', 'remove', clip.id, '--json'], env);
  assert.equal(cue.code, 1);
  assert.deepEqual(JSON.parse(cue.stdout), { error: 'in-use', message: 'clip.png is used by "cue at 23:00 in show Night"; change it first.' });
  const root = env.SKP_DATA_DIR;
  assert.ok(existsSync(path.join(root, 'media', logo.data.fileId, 'logo.png')));
  assert.ok(existsSync(path.join(root, 'media', clip.data.fileId, 'clip.png')));
  assert.equal((await cli(['media', 'remove', free.id], env)).code, 0, 'a file nothing uses goes');
});
