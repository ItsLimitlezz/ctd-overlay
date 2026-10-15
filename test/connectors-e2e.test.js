// End to end, on a running platform with a fake service on 127.0.0.1: a connection's viewer count
// reaches an overlay bound to every connection (the default) as viewers.twitch and viewers.total;
// with the service down the count is held, marked stale, then removed: never 0 (H6, 02 §2.8); and
// every change of its health is on /api/v1/events as system.connection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { startPlatform } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { readSse } from '../src/connectors/sse-client.js';
import { until } from './connector-helpers.js';
import { fakeConnector } from './fixtures/connectors/fake.js';
import { startFakeService } from './fixtures/fake-service.mjs';
import { defer, FIXTURE_TEMPLATES, memoryLogger, signedIn, tempDir, TESTBED } from './helpers.js';

test('a connection\'s count reaches an overlay bound to all; the service down: held, stale, then absent, never 0', { timeout: 60000 }, async (t) => {
  const svc = await startFakeService();
  defer(t, () => svc.close());
  const fake = fakeConnector({ auth: 'client-credentials' });
  const root = tempDir(t);
  const config = loadConfig({ argv: ['--port', '0'], env: { SKP_DATA_DIR: path.join(root, 'data'), SKP_CONFIG_DIR: path.join(root, 'config') } });
  const { log, entries } = memoryLogger();
  const platform = await startPlatform(config, { log, templateDirs: [FIXTURE_TEMPLATES], connectors: { defs: [fake.def], endpoints: { fake: svc.endpoints }, holdMs: 800, random: () => 0.5 } });
  defer(t, () => platform.stop());
  platform.overlays.create({ slug: 'main', template: TESTBED, settings: {} });
  platform.overlays.setKeyRequired('main', false);
  const snapshot = async () => (await (await fetch(`${platform.url}/o/main/snapshot`)).json()).state;

  // The live feed of the API, as a dashboard reads it.
  const ctrl = new AbortController();
  defer(t, () => ctrl.abort());
  const health = [];
  const events = await fetch(`${platform.url}/api/v1/events?types=system.connection`, { headers: signedIn(platform), signal: ctrl.signal });
  assert.equal(events.status, 200);
  readSse(events.body, (f) => { health.push(JSON.parse(f.data).data); }).catch(() => {});

  const made = await fetch(`${platform.url}/api/v1/connections`, { method: 'POST', headers: signedIn(platform, { 'content-type': 'application/json' }), body: JSON.stringify({ connector: 'fake', name: 'Twitch', config: { clientId: 'cid', pollMs: 50 }, secrets: { clientSecret: 'client-secret-value' } }) });
  assert.equal(made.status, 201);
  const id = (await made.json()).id;
  await until(async () => (await snapshot())['viewers.total'] === 214, 5000, 'the count on the overlay');
  const state = await snapshot();
  assert.deepEqual([state['viewers.twitch'], state['viewers.total'], state['stream.twitch.live']], [214, 214, undefined], 'live status: not something this template consumes');
  const wide = await (await fetch(`${platform.url}/api/v1/state`, { headers: signedIn(platform) })).json();
  assert.deepEqual([wide['viewers.twitch'], wide['viewers.total'], wide['stream.twitch.live']], [214, 214, true]);
  assert.ok(svc.requests.some((r) => r.form.grant_type === 'client_credentials'), 'an app token');
  await until(() => health.some((h) => h.connection === id && h.status === 'connected'), 5000, 'system.connection connected');

  // The service goes down: the count holds, marked stale, then goes. Never 0.
  svc.down = true;
  await until(async () => (await snapshot())['viewers.stale'] === true, 10000, 'held');
  const held = await snapshot();
  assert.deepEqual([held['viewers.twitch'], held['viewers.twitch.stale'], held['viewers.total']], [214, true, 214]);
  await until(async () => !('viewers.twitch' in (await snapshot())), 10000, 'removed');
  const gone = await snapshot();
  assert.ok(!('viewers.total' in gone) && !('viewers.stale' in gone), JSON.stringify(gone));
  await until(() => health.some((h) => h.connection === id && h.status === 'degraded' && /Viewer count unavailable/.test(h.detail)), 5000, 'system.connection degraded');
  assert.equal(platform.connectors.summary()[0].status, 'degraded');

  // Back: the count with it.
  svc.down = false;
  await until(async () => (await snapshot())['viewers.twitch'] === 214, 10000, 'back');
  assert.ok(!JSON.stringify(entries).includes('client-secret-value'));
});
