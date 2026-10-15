// The connector host (06 §6.1, 01 §1.7, H6, H11): connections that fail, hang or throw are
// stopped, held and started again with backoff, never taking anything else down; values held
// through an error are marked stale for 120 s, then removed, never replaced by 0; a deliberate stop
// removes them at once; sign-ins that are missing aren't retried in a loop; secrets never reach a
// health detail, a log line, an answer or the audit log; v0's kept credentials become connections.
// All on a hand-cranked clock, with a fake service behind fetch: no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createAudit } from '../src/auth/audit.js';
import { createBus } from '../src/bus/index.js';
import { nextDelay, parseRetryAfter } from '../src/connectors/backoff.js';
import { createDedupe } from '../src/connectors/dedupe.js';
import { createConnectorHost } from '../src/connectors/host.js';
import { createConnectorRegistry, validateDefinition } from '../src/connectors/registry.js';
import { migrate } from '../src/store/migrate.js';
import { migrations } from '../src/store/migrations.js';
import { openStore } from '../src/store/index.js';
import { createSecrets } from '../src/secrets.js';
import { fakeClock, fakeFetch } from './connector-helpers.js';
import { fakeConnector } from './fixtures/connectors/fake.js';
import { defer, memoryLogger, tempDir } from './helpers.js';

const SEC = 1000;
const SECRET = 'super-secret-client-value-123';

async function setup(t, { defs, fetch = fakeFetch(), clock = fakeClock(), holdMs, start = true } = {}) {
  const store = openStore({ dataDir: tempDir(t), backend: 'sqlite' });
  defer(t, () => store.close());
  const { log, entries } = memoryLogger();
  migrate(store, migrations, { log });
  const bus = createBus({ now: clock.now, timers: clock.timers });
  const secrets = createSecrets({ key: randomBytes(32) });
  const audit = createAudit({ store, now: clock.now });
  const host = createConnectorHost({ store, bus, secrets, audit, log, registry: createConnectorRegistry(defs), now: clock.now, timers: clock.timers, fetch, random: () => 0.5, ...(holdMs ? { holdMs } : {}) });
  host.setOrigin('http://127.0.0.1:4848');
  defer(t, () => host.stop());
  const events = [];
  bus.subscribeAll((env) => { if (env.type === 'system.connection') events.push(env.data); });
  if (start) await host.start();
  return { host, bus, store, secrets, audit, entries, clock, events };
}

const statusOf = (host, id) => host.get(id).health.status;

test('backoff: 1 s, 2 s, 4 s … to 5 minutes, ±20 %; Retry-After as seconds or a date, a day at most', () => {
  assert.deepEqual([0, 1, 2, 3, 8, 9, 20].map((n) => nextDelay(n, { random: () => 0.5 })), [1000, 2000, 4000, 8000, 256000, 300000, 300000]);
  assert.equal(nextDelay(0, { random: () => 0 }), 800);
  assert.equal(nextDelay(0, { random: () => 1 }), 1200);
  assert.equal(parseRetryAfter('30'), 30000);
  assert.equal(parseRetryAfter('Wed, 21 Oct 2026 07:28:00 GMT', Date.UTC(2026, 9, 21, 7, 27)), 60000);
  assert.equal(parseRetryAfter('9999999'), 24 * 60 * 60 * 1000);
  assert.equal(parseRetryAfter('soon'), undefined);
});

test('dedupe: a message id is seen once for 10 minutes; the oldest go first past the cap', () => {
  let t = 0;
  const d = createDedupe({ now: () => t, max: 3 });
  assert.equal(d.seen('a'), false);
  assert.equal(d.seen('a'), true);
  t = 10 * 60 * 1000;
  assert.equal(d.seen('a'), false, 'remembered 10 minutes');
  for (const k of ['b', 'c', 'd', 'e']) d.seen(k);
  assert.ok(d.size <= 3);
});

test('definitions are checked once, by name: a broken one stops startup, not the show', () => {
  const { def } = fakeConnector();
  assert.doesNotThrow(() => validateDefinition(def));
  assert.throws(() => validateDefinition({ ...def, id: 'Bad Id' }), /needs an id/);
  assert.throws(() => validateDefinition({ ...def, capabilities: ['telepathy'] }), /capability/);
  assert.throws(() => validateDefinition({ ...def, auth: 'oauth-pkce', oauth: undefined }), /oauth\.tokenUrl/);
  assert.throws(() => validateDefinition({ ...def, guide: {} }), /setup guide/);
  assert.throws(() => validateDefinition({ ...def, fields: { type: 'object', properties: { pin: { type: 'integer', writeOnly: true } } } }), /secret field "pin"/);
  assert.throws(() => createConnectorRegistry([def, def]), /Two connector definitions/);
});

test('a connection that fails to start is started again after 1 s, 2 s, 4 s, saying why and when', async (t) => {
  const fake = fakeConnector();
  const { host, clock, events } = await setup(t, { defs: [fake.def] });
  const c = host.create({ connector: 'fake', name: 'Broken', config: { behaviour: 'fail-start' } });
  await clock.flush();
  assert.equal(fake.live.length, 1);
  assert.equal(statusOf(host, c.id), 'error');
  assert.match(host.get(c.id).health.detail, /cannot start\. Trying again in 1 s\./);
  await clock.advance(999);
  assert.equal(fake.live.length, 1);
  await clock.advance(1);
  assert.equal(fake.live.length, 2);
  assert.match(host.get(c.id).health.detail, /Trying again in 2 s/);
  await clock.advance(2 * SEC);
  assert.equal(fake.live.length, 3);
  await clock.advance(4 * SEC);
  assert.equal(fake.live.length, 4);
  // Every change was published (operator-only), at most one a second, the latest state each time.
  await clock.advance(SEC);
  assert.ok(events.length >= 2);
  assert.ok(events.every((e) => e.connection === c.id && e.name === 'Broken' && e.connector === 'fake'));
  assert.equal(events.at(-1).status, 'error');
});

test('a start that rejects, hangs for 30 s or throws later from a timer fails that connection only', async (t) => {
  const fake = fakeConnector();
  const { host, clock } = await setup(t, { defs: [fake.def] });
  const good = host.create({ connector: 'fake', name: 'Good', config: { behaviour: 'push' } });
  const rejects = host.create({ connector: 'fake', name: 'Rejects', config: { behaviour: 'reject' } });
  const hangs = host.create({ connector: 'fake', name: 'Hangs', config: { behaviour: 'hang' } });
  const later = host.create({ connector: 'fake', name: 'Later', config: { behaviour: 'throw-later' } });
  await clock.flush();
  assert.equal(statusOf(host, good.id), 'connected');
  assert.match(host.get(rejects.id).health.detail, /rejected at start/);
  assert.equal(statusOf(host, hangs.id), 'connecting');
  assert.equal(statusOf(host, later.id), 'connected');
  await clock.advance(500);
  assert.equal(statusOf(host, later.id), 'error');
  assert.match(host.get(later.id).health.detail, /a timer crashed/);
  await clock.advance(29.5 * SEC);
  assert.equal(statusOf(host, hangs.id), 'error');
  assert.match(host.get(hangs.id).health.detail, /longer than 30 s to start/);
  assert.equal(statusOf(host, good.id), 'connected', 'the others never noticed');
});

test('health from the connector is published at most once a second, the latest state when it ends', async (t) => {
  const fake = fakeConnector();
  const { host, clock, events } = await setup(t, { defs: [fake.def] });
  const c = host.create({ connector: 'fake', name: 'Chatty', config: { behaviour: 'push' } });
  await clock.advance(2 * SEC);
  events.length = 0;
  const { ctx } = fake.live.at(-1);
  ctx.setHealth({ status: 'degraded', detail: 'one' });
  ctx.setHealth({ status: 'connected', detail: 'two' });
  ctx.setHealth({ status: 'degraded', detail: 'three' });
  assert.deepEqual(events.map((e) => [e.status, e.detail]), [['degraded', 'one']]);
  await clock.advance(SEC);
  assert.deepEqual(events.map((e) => [e.status, e.detail]), [['degraded', 'one'], ['degraded', 'three']]);
  assert.throws(() => ctx.setHealth({ status: 'error' }), /ctx\.fail/);
  assert.equal(host.get(c.id).health.detail, 'three');
});

test('a sign-in that is needed and missing is needs-reauth: never started, never retried in a loop', async (t) => {
  const fake = fakeConnector({ auth: 'device-code' });
  const fetch = fakeFetch();
  const { host, clock } = await setup(t, { defs: [fake.def], fetch });
  const c = host.create({ connector: 'fake', name: 'Twitch', config: { behaviour: 'ok', clientId: 'cid' } });
  await clock.advance(10 * 60 * SEC);
  assert.equal(statusOf(host, c.id), 'needs-reauth');
  assert.match(host.get(c.id).health.detail, /Sign in/);
  assert.equal(fake.live.length, 0);
  assert.equal(fetch.calls.length, 0);
});

test('an error holds the values 120 s, marked stale, then removes them; never 0; set again, they stay', async (t) => {
  const fake = fakeConnector();
  const { host, bus, clock } = await setup(t, { defs: [fake.def] });
  const c = host.create({ connector: 'fake', name: 'Push', config: { behaviour: 'push' } });
  await clock.flush();
  const { ctx } = fake.live.at(-1);
  ctx.setState('viewers.twitch', 214);
  ctx.hold();
  assert.equal(bus.getState('viewers.twitch'), 214, 'held, as it was');
  assert.equal(bus.getState('viewers.twitch.stale'), true);
  assert.equal(bus.getState('viewers.stale'), true);
  assert.deepEqual(host.get(c.id).stale, ['viewers.twitch']);
  await clock.advance(119 * SEC);
  assert.equal(bus.getState('viewers.twitch'), 214);
  await clock.advance(2 * SEC);
  assert.equal(bus.getState('viewers.twitch'), undefined, 'gone after 120 s: absent, never 0');
  assert.equal(bus.getState('viewers.total'), undefined);
  assert.equal(bus.getState('viewers.stale'), undefined);
  // Set again within the hold: fresh, and it stays.
  ctx.setState('viewers.twitch', 300);
  ctx.hold();
  await clock.advance(60 * SEC);
  ctx.setState('viewers.twitch', 301);
  assert.equal(bus.getState('viewers.twitch.stale'), undefined);
  await clock.advance(120 * SEC);
  assert.equal(bus.getState('viewers.twitch'), 301);
  // A failure holds them too, while the connection starts again.
  ctx.fail(new Error('the service hung up'));
  assert.equal(bus.getState('viewers.twitch'), 301);
  assert.equal(bus.getState('viewers.twitch.stale'), true);
  assert.equal(statusOf(host, c.id), 'error');
  await clock.advance(121 * SEC);
  assert.equal(bus.getState('viewers.twitch'), undefined);
});

test('turned off, edited or deleted: its values go at once, nothing held', async (t) => {
  const fake = fakeConnector();
  const { host, bus, clock } = await setup(t, { defs: [fake.def] });
  const c = host.create({ connector: 'fake', name: 'Push', config: { behaviour: 'push' } });
  await clock.flush();
  fake.live.at(-1).ctx.setState('viewers.twitch', 5);
  fake.live.at(-1).ctx.hold();
  await host.update(c.id, { enabled: false });
  assert.equal(bus.getState('viewers.twitch'), undefined);
  assert.equal(statusOf(host, c.id), 'disabled');
  await host.update(c.id, { enabled: true });
  await clock.flush();
  fake.live.at(-1).ctx.setState('viewers.twitch', 6);
  await host.update(c.id, { config: { behaviour: 'push', channel: 'other' } });
  await clock.flush();
  assert.equal(bus.getState('viewers.twitch'), undefined, 'an edit restarts it from nothing');
  fake.live.at(-1).ctx.setState('viewers.twitch', 7);
  // A rename restarts nothing.
  const n = fake.live.length;
  await host.update(c.id, { name: 'Renamed' });
  assert.equal(fake.live.length, n);
  assert.equal(bus.getState('viewers.twitch'), 7);
  const out = await host.remove(c.id);
  assert.deepEqual(out, { id: c.id, name: 'Renamed', overlays: [] });
  assert.equal(bus.getState('viewers.twitch'), undefined);
  assert.equal(host.exists(c.id), false);
});

test('a pushed message seen before is published once, across restarts of the instance', async (t) => {
  const fake = fakeConnector();
  const { host, bus, clock } = await setup(t, { defs: [fake.def] });
  host.create({ connector: 'fake', name: 'Push', config: { behaviour: 'push' } });
  await clock.flush();
  const msg = { id: 'm1', user: { id: 'twitch:1', name: 'a', roles: [] }, text: 'hi', fragments: [{ type: 'text', text: 'hi' }] };
  const first = fake.live.at(-1);
  assert.ok(first.push('chat.message', msg, { dedupeKey: 'm1' }));
  assert.equal(first.push('chat.message', msg, { dedupeKey: 'm1' }), undefined);
  first.ctx.fail(new Error('reconnect'));
  await clock.advance(SEC);
  const second = fake.live.at(-1);
  assert.notEqual(second, first);
  assert.equal(second.push('chat.message', msg, { dedupeKey: 'm1' }), undefined);
  assert.equal(bus.chatRecent().length, 1);
  // A connector may publish only what its capabilities and platforms allow.
  assert.throws(() => second.ctx.publish('show.trigger', {}), /isn't an event/);
  assert.throws(() => second.ctx.setState('viewers.total', 5), /isn't state/);
  assert.throws(() => second.ctx.setState('viewers.kick', 5), /isn't state/);
  assert.throws(() => second.ctx.setState('viewers.twitch.stale', true), /connector host/);
});

test('a stopped instance\'s late callbacks change nothing', async (t) => {
  const fake = fakeConnector();
  const { host, bus, clock } = await setup(t, { defs: [fake.def] });
  const c = host.create({ connector: 'fake', name: 'Push', config: { behaviour: 'push' } });
  await clock.flush();
  const old = fake.live.at(-1).ctx;
  let ran = 0;
  old.schedule(5 * SEC, () => { ran++; });
  old.fail(new Error('gone'));
  await clock.advance(SEC);
  assert.equal(statusOf(host, c.id), 'connected');
  old.setState('viewers.twitch', 999);
  assert.equal(old.publish('chat.cleared', {}), undefined);
  old.setHealth({ status: 'degraded', detail: 'from the past' });
  await clock.advance(10 * SEC);
  assert.equal(ran, 0, 'its timer was cleared');
  assert.equal(bus.getState('viewers.twitch'), undefined);
  assert.equal(statusOf(host, c.id), 'connected');
  await assert.rejects(old.http.request('https://fake.example/api/viewers'), /stopped/);
});

test('secrets reach no health detail, log line, answer or audit entry; they are stored encrypted', async (t) => {
  const fake = fakeConnector();
  const { host, clock, entries, audit, store } = await setup(t, { defs: [fake.def] });
  const c = host.create({ connector: 'fake', name: 'Leaky', config: { behaviour: 'secret-error' }, secrets: { clientSecret: SECRET } }, { who: { label: 'juan' } });
  await clock.flush();
  assert.match(host.get(c.id).health.detail, /the service refused \[redacted\]/);
  await host.update(c.id, { secrets: { clientSecret: `${SECRET}-2` } }, { who: { label: 'juan' } });
  await clock.flush();
  const everything = JSON.stringify([host.get(c.id), host.list(), host.summary(), entries, audit.list({ limit: 200 })]);
  assert.ok(!everything.includes(SECRET), 'nowhere');
  assert.deepEqual(host.get(c.id).secretFields, ['clientSecret']);
  assert.match(store.get('connections', c.id).data.secrets, /^enc:v1:/);
  assert.deepEqual(audit.list({ action: 'connection.update' }).items[0].details, { fields: ['clientSecret'] });
});

test('settings are checked: unknown ones refused, secrets only as secrets, an address that is link-local refused', async (t) => {
  const fake = fakeConnector();
  const { host } = await setup(t, { defs: [fake.def] });
  assert.throws(() => host.create({ connector: 'nope' }), { code: 'unknown-connector' });
  assert.throws(() => host.create({ connector: 'fake', config: { colour: 'red' } }), { code: 'unknown-field' });
  assert.throws(() => host.create({ connector: 'fake', config: { clientSecret: 'x' } }), (err) => err.code === 'unknown-field' && /"secrets", never in "config"/.test(err.message));
  assert.throws(() => host.create({ connector: 'fake', config: { pollMs: 5 } }), /pollMs must be at least 20/);
  assert.throws(() => host.create({ connector: 'fake', config: { host: 'http://169.254.169.254/' } }), /link-local/);
  assert.throws(() => host.create({ connector: 'fake', config: { host: 'http://user:pw@nas.local/' } }), /user name or password/);
  const ok = host.create({ connector: 'fake', config: { host: 'http://192.168.1.50:30080/api/v1' } });
  assert.equal(ok.config.host, 'http://192.168.1.50:30080/api/v1');
});

test('a quota used up: degraded until it resets, then started again', async (t) => {
  const fake = fakeConnector();
  const { host, clock } = await setup(t, { defs: [fake.def] });
  const c = host.create({ connector: 'fake', name: 'Quota', config: { behaviour: 'quota' } });
  await clock.advance(20);
  assert.equal(statusOf(host, c.id), 'degraded');
  assert.match(host.get(c.id).health.detail, /quota is used up/);
  assert.ok(host.get(c.id).health.quota.resetsAt);
  const n = fake.live.length;
  await clock.advance(60 * SEC);
  assert.equal(fake.live.length, n + 1, 'started again at the reset');
});

test('credentials the v0 importer kept become a turned-off connection when a connector for their platform exists', async (t) => {
  const fake = fakeConnector({ platform: 'twitch' });
  const { host, store, secrets, audit } = await setup(t, { defs: [fake.def], start: false });
  const kept = (id, platform) => store.put('pending_connections', id, { platform, clientId: 'cid-1', clientSecret: secrets.encrypt(SECRET, id), channel: 'dprtmnt', enabled: true, from: 'v0', importedAt: '2026-10-15T00:00:00.000Z' });
  kept('twitch', 'twitch');
  kept('kick', 'kick');
  await host.start();
  const list = host.list();
  assert.equal(list.length, 1);
  assert.deepEqual([list[0].name, list[0].enabled, list[0].config, list[0].secretFields, list[0].source], ['Fake (dprtmnt)', false, { channel: 'dprtmnt', clientId: 'cid-1' }, ['clientSecret'], 'v0']);
  assert.equal(store.get('pending_connections', 'twitch'), undefined, 'taken');
  assert.ok(store.get('pending_connections', 'kick'), 'no Kick connector yet: kept for later');
  assert.deepEqual(audit.list({ action: 'connection.import' }).items.map((e) => e.details.platform), ['twitch']);
  assert.ok(!JSON.stringify(list).includes(SECRET));
});

test('an action runs on a connected connection, within 10 s; refusals say why', async (t) => {
  const fake = fakeConnector();
  const { host, clock, audit } = await setup(t, { defs: [fake.def] });
  const c = host.create({ connector: 'fake', name: 'Acts', config: { behaviour: 'push' } });
  await clock.flush();
  assert.deepEqual(await host.runAction(c.id, 'echo', { text: 'hi' }, { who: { label: 'juan' } }), { connection: c.id, action: 'echo', result: { echoed: 'hi' } });
  assert.deepEqual((await host.runAction('fake', 'echo', {})).result, { echoed: null }, 'by its connector, when one is on');
  await assert.rejects(host.runAction(c.id, 'echo', { text: 5 }), { code: 'invalid' });
  await assert.rejects(host.runAction(c.id, 'nope'), { code: 'not-found' });
  await assert.rejects(host.runAction(c.id, 'fail'), (err) => err.code === 'action-failed' && /said no/.test(err.message));
  const slow = host.runAction(c.id, 'slow');
  const done = assert.rejects(slow, { code: 'timeout' });
  await clock.advance(10 * SEC);
  await done;
  assert.equal(audit.list({ action: 'connection.action' }).items[0].details.name, 'echo');
  await host.update(c.id, { enabled: false });
  await assert.rejects(host.runAction(c.id, 'echo'), { code: 'not-connected' });
});
