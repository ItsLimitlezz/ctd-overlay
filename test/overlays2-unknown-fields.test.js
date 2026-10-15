// Unknown fields inside a field of a fixed shape (03 §3.1, 07 §7.11): a template reference, a cue's
// action, a sequence's steps and their actions, a recipe. Each is refused (422 unknown-field) and
// nothing is saved, never taken with the field dropped; the OpenAPI document describes them (and
// these routes' 201s and pages).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { startPlatform } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { defer, FIXTURE_TEMPLATES, memoryLogger, signedIn, tempDir, TESTBED } from './helpers.js';

async function start(t) {
  const root = tempDir(t);
  const config = loadConfig({ argv: ['--port', '0'], env: { SKP_DATA_DIR: path.join(root, 'data'), SKP_CONFIG_DIR: path.join(root, 'config') } });
  const platform = await startPlatform(config, { log: memoryLogger().log, templateDirs: [FIXTURE_TEMPLATES] });
  defer(t, () => platform.stop());
  const api = async (method, p, body) => {
    const res = await fetch(`${platform.url}/api/v1${p}`, { method, headers: signedIn(platform, body !== undefined ? { 'content-type': 'application/json' } : {}), body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return { platform, api };
}

const UNKNOWN = 'https://skp.dev/errors/unknown-field';

test('a template reference takes id and version: POST /overlays with another field in it is refused, and nothing is made', async (t) => {
  const { platform, api } = await start(t);
  const res = await api('POST', '/overlays', { slug: 'main', template: { ...TESTBED, bogus: true }, settings: {} });
  assert.deepEqual([res.status, res.body.type], [422, UNKNOWN]);
  assert.match(res.body.detail, /Unknown field in "template": bogus\. It takes id, version\./);
  assert.equal(platform.overlays.resolve('main'), undefined);
  assert.deepEqual(platform.audit.list({ action: 'overlay' }).items, []);
  assert.equal((await api('POST', '/overlays', { slug: 'main', template: TESTBED, settings: {} })).status, 201, 'the reference as it is goes through');
});

test('the OpenAPI document says so too: the template reference\'s fields, the 201s, and the paged lists', async (t) => {
  const { api } = await start(t);
  const { paths } = (await api('GET', '/openapi.json')).body;
  const template = paths['/api/v1/overlays'].post.requestBody.content['application/json'].schema.properties.template;
  assert.deepEqual(template, { type: 'object', additionalProperties: false, properties: { id: {}, version: {} } });
  for (const p of ['/api/v1/overlays', '/api/v1/shows', '/api/v1/shows/{ref}/cues', '/api/v1/shows/{ref}/plans']) {
    assert.deepEqual(Object.keys(paths[p].post.responses).sort(), ['201', 'default'], `POST ${p}`);
    assert.deepEqual(paths[p].get.parameters.filter((x) => x.in === 'query').map((x) => x.name), ['limit', 'cursor'], `GET ${p}`);
  }
});

test('a cue\'s action, a sequence\'s step and a step\'s action take their own fields only: a misspelt one is refused, not dropped', async (t) => {
  const { platform, api } = await start(t);
  platform.overlays.create({ slug: 'main', template: TESTBED, settings: {} });
  assert.equal((await api('POST', '/shows', { name: 'Night', overlays: ['main'], date: '2026-10-17', timezone: 'America/Toronto' })).status, 201);
  const cues = () => platform.timeline.list('Night');
  const scene = (extra) => ({ type: 'show.scene', scene: 'brb', ...extra });
  for (const [action, where] of [
    [scene({ transiton: 'cut' }), /in "action": transiton\. An action of type show\.scene takes type, scene, transition\./],
    [{ type: 'overlay.action', name: 'titleCard', arg: { name: 'X' } }, /in "action": arg\. An action of type overlay\.action takes type, name, args\./],
    [{ type: 'show.slot', slot: 1, at: '01:00' }, /in "action": at\./],
    [{ type: 'media.stop', media: 'med_01' }, /in "action": media\./],
    [{ type: 'sequence', steps: [{ offsetMs: 0, action: scene() }], loop: true }, /in "action": loop\./],
    [{ type: 'sequence', steps: [{ offsetMs: 0, action: scene() }, { offsetMs: 500, action: scene(), label: 'x' }] }, /in step 2: label\. A step takes offsetMs, action\./],
    [{ type: 'sequence', steps: [{ offsetMs: 0, action: scene({ transiton: 'cut' }) }] }, /in a step's "action": transiton\./],
  ]) {
    const res = await api('POST', '/shows/Night/cues', { at: '23:00', action });
    assert.deepEqual([res.status, res.body.type], [422, UNKNOWN], JSON.stringify(action));
    assert.match(res.body.detail, where);
  }
  assert.deepEqual(cues(), [], 'nothing saved');
  // Every field known: taken, and kept as given.
  const made = await api('POST', '/shows/Night/cues', { at: '23:00', action: { type: 'sequence', steps: [{ offsetMs: 0, action: scene({ transition: 'cut' }) }, { offsetMs: 500, action: { type: 'overlay.action', name: 'titleCard', args: { name: 'X' } } }] } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.deepEqual(made.body.action.steps[0].action, scene({ transition: 'cut' }));
  // A change to the cue is held to the same: the cue stays as it was.
  const changed = await api('PATCH', `/shows/Night/cues/${made.body.id}`, { action: scene({ transiton: 'cut' }) });
  assert.deepEqual([changed.status, changed.body.type], [422, UNKNOWN]);
  assert.deepEqual(cues()[0].action, made.body.action);
});

test('a recipe takes its four fields: another is refused, and the show\'s recipe and cues stay as they were', async (t) => {
  const { platform, api } = await start(t);
  platform.overlays.create({ slug: 'main', template: TESTBED, settings: {} });
  assert.equal((await api('POST', '/shows', { name: 'Night', overlays: ['main'], date: '2026-10-17', timezone: 'America/Toronto', lineup: [{ time: '22:30', name: 'Manzone' }] })).status, 201);
  const res = await api('POST', '/shows/Night/cues/build', { recipe: { bogusKey: 5 } });
  assert.deepEqual([res.status, res.body.type], [422, UNKNOWN]);
  assert.match(res.body.detail, /Unknown field in "recipe": bogusKey\. A recipe takes titleCard, introOffsetMin, nowPlayingEveryMin, headliner\./);
  assert.equal(platform.shows.get('Night').recipe, undefined, 'no recipe set');
  assert.deepEqual(platform.timeline.list('Night'), []);
  const built = await api('POST', '/shows/Night/cues/build', { recipe: { titleCard: false, introOffsetMin: null, nowPlayingEveryMin: 15, headliner: true } });
  assert.equal(built.status, 200, JSON.stringify(built.body));
  assert.deepEqual(platform.shows.get('Night').recipe, { titleCard: false, introOffsetMin: null, nowPlayingEveryMin: 15, headliner: true });
});
