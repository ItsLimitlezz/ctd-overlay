// What keeps an uploaded file from being deleted (03 §3.4): anything that will still put it on air.
// An overlay's settings, a show's lineup (an act's logo), a cue that will play it, and a plan
// still to come; usedBy names each, for the operator.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { openData } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { paginate } from '../src/http/api.js';
import { mediaApiRoutes } from '../src/media/api.js';
import { mediaUrl, mediaUsers } from '../src/media/library.js';
import { defer, memoryLogger, tempDir } from './helpers.js';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(256, 7)]);
const TAKEOVER = { id: 'com.dprtmnt.takeover', version: '1.0.0' };
const DAY_MS = 24 * 60 * 60 * 1000;
const dayIn = (days) => new Date(Date.now() + days * DAY_MS).toISOString().slice(0, 10);

// The data directory as the platform opens it, closed when the test ends.
function open(t) {
  const root = tempDir(t);
  const config = loadConfig({ argv: [], env: { SKP_DATA_DIR: path.join(root, 'data'), SKP_CONFIG_DIR: path.join(root, 'config') } });
  const data = openData(config, { log: memoryLogger().log, media: { lowerPriority: false } });
  defer(t, () => data.close());
  return data;
}

// An overlay, a show with a logo in its lineup, a cue at a time of the show and a sequence at an
// instant that play files, and a plan whose lineup and overlay settings point to files.
async function staged(t) {
  const data = open(t);
  const { media, overlays, shows, timeline } = data;
  const files = {};
  for (const name of ['mark', 'logo', 'clip', 'step', 'planLogo', 'planMark', 'free']) files[name] = await media.add(PNG, { name: `${name}.png` });
  overlays.create({ slug: 'tk', template: TAKEOVER, settings: { look: 'event', eventMark: mediaUrl(files.mark) } });
  const show = shows.create({ name: 'Night', overlays: ['tk'], date: dayIn(3), timezone: 'America/Toronto', lineup: [{ time: '22:00', name: 'VIK', logo: mediaUrl(files.logo) }] });
  const atTime = timeline.add(show.id, { at: '23:00', action: { type: 'media.play', mediaId: files.clip.id } });
  const atInstant = timeline.add(show.id, {
    at: new Date(Date.now() + DAY_MS).toISOString(),
    action: { type: 'sequence', steps: [{ offsetMs: 0, action: { type: 'media.stop' } }, { offsetMs: 1000, action: { type: 'media.play', mediaId: files.step.id } }] },
  });
  const plan = timeline.plans.add(show.id, {
    date: dayIn(10),
    // An absolute URL to the same file counts too.
    lineup: [{ time: '22:00', name: 'B', logo: `https://show.example.com${mediaUrl(files.planLogo)}` }],
    overlaySettings: { tk: { look: 'event', eventMark: mediaUrl(files.planMark) } },
  });
  return { data, files, show, atTime, atInstant, plan };
}

test('a file that a show\'s lineup, a cue or a plan still uses is not deleted, and usedBy names each user (03 §3.4)', async (t) => {
  const { data, files, show, atTime, atInstant, plan } = await staged(t);
  const { media, overlays, shows, timeline } = data;
  const usedBy = mediaUsers(data);
  assert.deepEqual(usedBy(files.mark), ['tk']);
  assert.deepEqual(usedBy(files.logo), ['lineup of show Night']);
  assert.deepEqual(usedBy(files.clip), ['cue at 23:00 in show Night']);
  assert.deepEqual(usedBy(files.step), [`cue at ${atInstant.at} in show Night`]);
  assert.deepEqual(usedBy(files.planLogo), [`plan for ${plan.date} of show Night`]);
  assert.deepEqual(usedBy(files.planMark), [`plan for ${plan.date} of show Night`]);
  assert.deepEqual(usedBy(files.free), []);
  for (const name of ['mark', 'logo', 'clip', 'step', 'planLogo', 'planMark']) {
    assert.throws(() => media.remove(files[name].id, { usedBy: mediaUsers(data) }), { code: 'in-use' }, name);
  }
  assert.throws(() => media.remove(files.logo.id, { usedBy: mediaUsers(data) }), { message: 'logo.png is used by "lineup of show Night"; change it first.' });

  // What won't play it any more frees it: a cue at an instant that was skipped, a plan deleted,
  // a lineup without the logo.
  timeline.override(show.id, atInstant.id, 'skip');
  // A cue at a time of the show is armed again on another night: skipped tonight, it still counts.
  timeline.override(show.id, atTime.id, 'skip');
  timeline.plans.remove(show.id, plan.id);
  shows.update(show.id, { lineup: [{ time: '22:00', name: 'VIK' }] });
  assert.deepEqual(mediaUsers(data)(files.clip), ['cue at 23:00 in show Night']);
  for (const name of ['logo', 'step', 'planLogo', 'planMark', 'free']) assert.equal(media.remove(files[name].id, { usedBy: mediaUsers(data) }).id, files[name].id, name);
  // Without shows and a timeline, only overlays are asked.
  assert.deepEqual(mediaUsers({ overlays })(files.clip), []);
  assert.deepEqual(mediaUsers({ overlays })(files.mark), ['tk']);
});

test('the API\'s usedBy and DELETE /media/:id count them too, for one file and for the list', async (t) => {
  const { data, files, plan } = await staged(t);
  const { media, overlays, shows, timeline, audit } = data;
  const fake = { route: (def) => def, paginate };
  const routesOf = (deps) => {
    const routes = mediaApiRoutes({ api: fake, media, overlays, audit, ...deps });
    return (method, p, args) => routes.find((r) => r.method === method && r.path === p).run(args);
  };
  const run = routesOf({ shows, timeline });
  const who = { label: 'test' };
  const req = { client: { ip: '127.0.0.1' } };
  assert.deepEqual(run('GET', '/api/v1/media/:id', { params: { id: files.planMark.id } }).usedBy, [`plan for ${plan.date} of show Night`]);
  const list = run('GET', '/api/v1/media', { url: new URL('http://localhost/api/v1/media') }).items;
  assert.deepEqual(Object.fromEntries(list.map((m) => [m.name, m.usedBy.length])), { 'mark.png': 1, 'logo.png': 1, 'clip.png': 1, 'step.png': 1, 'planLogo.png': 1, 'planMark.png': 1, 'free.png': 0 });
  assert.throws(() => run('DELETE', '/api/v1/media/:id', { params: { id: files.logo.id }, who, req }), { code: 'in-use' });
  assert.deepEqual(run('DELETE', '/api/v1/media/:id', { params: { id: files.free.id }, who, req }), { removed: files.free.id });
  // Without shows and a timeline (a caller that has neither), overlays alone count.
  const bare = routesOf({});
  assert.deepEqual(bare('GET', '/api/v1/media/:id', { params: { id: files.logo.id } }).usedBy, []);
  assert.deepEqual(bare('GET', '/api/v1/media/:id', { params: { id: files.mark.id } }).usedBy, ['tk']);
});
