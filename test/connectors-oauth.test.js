// Signing connections in (06 §6.4, 07 §7.7): PKCE (S256) with a state that is single use, lasts 10
// minutes and is bound to whoever started the flow; the callback finishes it only in their browser,
// anyone else is asked to paste the address where they started; a declined sign-in, a mismatched
// connector and a replayed callback are refused; the device flow polls as the service says
// (pending, slow_down), and expires; tokens are kept encrypted, renewed at 80 % of their life and on
// a 401 (rotating the refresh token), and a refused renewal is needs-reauth. Nothing of a token or
// a code reaches a log line, an answer or a Location header. Against a fake service on 127.0.0.1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { startPlatform } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createFlowTable, pkcePair } from '../src/connectors/oauth.js';
import { fakeClock, until } from './connector-helpers.js';
import { fakeConnector } from './fixtures/connectors/fake.js';
import { startFakeService } from './fixtures/fake-service.mjs';
import { defer, memoryLogger, tempDir } from './helpers.js';

const PASSWORD = 'correct horse battery staple';
const SEC = 1000;
const MIN = 60 * SEC;

async function start(t, { auth = 'oauth-pkce', clock } = {}) {
  const svc = await startFakeService();
  defer(t, () => svc.close());
  const fake = fakeConnector({ auth });
  const root = tempDir(t);
  const config = loadConfig({ argv: ['--port', '0'], env: { SKP_DATA_DIR: path.join(root, 'data'), SKP_CONFIG_DIR: path.join(root, 'config') } });
  const { log, entries } = memoryLogger();
  const platform = await startPlatform(config, { log, scrypt: { N: 1024 }, connectors: { defs: [fake.def], endpoints: { fake: svc.endpoints }, random: () => 0.5 }, ...(clock ? { clock: { now: clock.now, timers: clock.timers } } : {}) });
  defer(t, () => platform.stop());
  return { svc, fake, platform, entries };
}

// A browser signed in as someone: their cookie, CSRF token, and calls with them.
async function browser(platform, { username = 'juan', role } = {}, owner) {
  let res;
  if (!owner) {
    res = await fetch(`${platform.url}/api/v1/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: platform.auth.setupCode, username, password: PASSWORD }) });
  } else {
    await owner('POST', '/users', { username, password: PASSWORD, role });
    res = await fetch(`${platform.url}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password: PASSWORD }) });
  }
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const { csrf } = await res.json();
  const call = (method, p, body) => fetch(p.startsWith('http') ? p : `${platform.url}${p.startsWith('/api') || p.startsWith('/oauth') ? p : `/api/v1${p}`}`, { method, redirect: 'manual', headers: { cookie, 'x-skp-csrf': csrf, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })
    .then(async (r) => { const text = await r.text(); let json; try { json = JSON.parse(text); } catch { json = text; } return { status: r.status, body: json, headers: r.headers }; });
  call.cookie = cookie;
  return call;
}

// The service's authorize page, as a browser follows it: the address it sends back to.
async function landing(url) {
  const res = await fetch(url, { redirect: 'manual' });
  assert.equal(res.status, 302);
  return res.headers.get('location');
}

test('PKCE is S256 of 32 random bytes; a flow is single use, lasts 10 minutes, and the table keeps 50', () => {
  const { verifier, challenge } = pkcePair();
  assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.match(challenge, /^[A-Za-z0-9_-]{43}$/);
  let t = 0;
  const flows = createFlowTable({ now: () => t });
  flows.add('s1', { conn: 'c1' });
  assert.ok(flows.peek('s1').flow);
  assert.ok(flows.take('s1').flow);
  assert.deepEqual(flows.take('s1'), { reason: 'used' });
  flows.add('s2', { conn: 'c2' });
  t = 11 * MIN;
  assert.deepEqual(flows.peek('s2'), { reason: 'expired' });
  flows.add('s3', { conn: 'c3' });
  t += 9 * MIN;
  assert.ok(flows.peek('s3').flow);
  t += 2 * MIN;
  assert.equal(flows.peek('s3').flow, undefined);
  for (let i = 0; i < 60; i++) flows.add(`x${i}`, { conn: `c${i}` });
  assert.equal(flows.size, 50);
  assert.deepEqual(flows.peek('x0'), { reason: 'unknown' }, 'the oldest go first');
  // A new flow for a connection ends its open one.
  flows.add('a', { conn: 'same' });
  flows.add('b', { conn: 'same' });
  assert.deepEqual(flows.peek('a'), { reason: 'unknown' });
});

test('a redirect sign-in: PKCE S256, finished in the browser that started it, once; tokens kept encrypted', async (t) => {
  const { platform, svc, entries } = await start(t);
  const owner = await browser(platform);
  const made = await owner('POST', '/connections', { connector: 'fake', name: 'Fake', config: { behaviour: 'push', clientId: 'client-1' }, secrets: { clientSecret: 'client-secret-value' } });
  assert.equal(made.status, 201);
  const id = made.body.id;
  assert.ok(!JSON.stringify(made.body).includes('client-secret-value'));
  await until(async () => (await owner('GET', `/connections/${id}`)).body.health.status === 'needs-reauth', 5000, 'needs signing in');
  const begun = await owner('POST', `/connections/${id}/authorize`, {});
  assert.equal(begun.status, 200);
  assert.equal(begun.body.flow, 'redirect');
  assert.equal(begun.body.redirectUri, `${platform.url}/oauth/callback/fake`);
  const q = new URL(begun.body.url).searchParams;
  assert.deepEqual([q.get('client_id'), q.get('code_challenge_method'), q.get('redirect_uri'), q.get('scope')], ['client-1', 'S256', begun.body.redirectUri, 'viewers:read']);
  assert.match(q.get('state'), /^[A-Za-z0-9_-]{43}$/);
  assert.equal(begun.headers.get('idempotent-replayed'), null);
  const back = await landing(begun.body.url);
  const done = await owner('GET', back);
  assert.equal(done.status, 303);
  assert.equal(done.headers.get('location'), `/#/connections/${id}?authorize=done`);
  assert.equal(done.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(done.headers.get('cache-control'), 'no-store');
  const after = await until(async () => { const r = (await owner('GET', `/connections/${id}`)).body; return r.health.status === 'connected' && r; }, 5000, 'connected');
  assert.equal(after.signedIn, true);
  assert.deepEqual(after.account, { id: '144552210', login: 'dprtmnt', name: 'DPRTMNT' });
  assert.deepEqual(after.authorization, { flow: 'redirect', status: 'done' });
  const stored = platform.store.get('connection_tokens', id).data;
  assert.match(stored.user, /^enc:v1:/);
  // The code worked once; the same callback again is refused.
  const again = await owner('GET', back);
  assert.equal(again.status, 400);
  assert.match(again.body, /already used/);
  const authorized = platform.audit.list({ action: 'connection.authorize' }).items;
  assert.deepEqual([authorized.length, authorized[0].actor, authorized[0].details], [1, 'juan', { flow: 'redirect', account: 'dprtmnt' }]);
  // Nothing of a code or token anywhere it shouldn't be.
  const code = new URL(back).searchParams.get('code');
  const tokens = [...svc.tokens.keys()];
  const seen = JSON.stringify([entries, after, platform.audit.list({ limit: 200 }), done.headers.get('location')]);
  for (const s of [code, ...tokens, 'client-secret-value']) assert.ok(!seen.includes(s), `${s} leaked`);
});

test('the callback in another browser asks to paste the address; only who started it can finish it', async (t) => {
  const { platform } = await start(t);
  const owner = await browser(platform);
  const admin = await browser(platform, { username: 'ana', role: 'admin' }, owner);
  const id = (await owner('POST', '/connections', { connector: 'fake', config: { behaviour: 'push', clientId: 'client-1' } })).body.id;
  const begun = (await owner('POST', `/connections/${id}/authorize`, {})).body;
  const back = await landing(begun.url);
  // A phone with no session, then another admin's browser: a page saying to paste it; the flow stays.
  for (const res of [await fetch(back, { redirect: 'manual' }), await admin('GET', back)]) {
    assert.equal(res.status, 200);
    const text = typeof res.body === 'string' ? res.body : await res.text();
    assert.match(text, /Finish sign-in/);
    assert.ok(!text.includes(new URL(back).searchParams.get('code')));
  }
  const theirs = await admin('POST', `/connections/${id}/authorize/complete`, { url: back });
  assert.equal(theirs.status, 403);
  assert.match(theirs.body.detail, /Only whoever started this sign-in/);
  const mine = await owner('POST', `/connections/${id}/authorize/complete`, { url: back });
  assert.equal(mine.status, 200);
  assert.equal(mine.body.signedIn, true);
  assert.equal((await owner('POST', `/connections/${id}/authorize/complete`, { url: back })).status, 410, 'used');
  assert.equal((await owner('POST', `/connections/${id}/authorize/complete`, { url: 'not an address' })).status, 422);
});

test('declined at the service, sent to another connector\'s callback, or unknown: refused', async (t) => {
  const { platform } = await start(t);
  const owner = await browser(platform);
  const id = (await owner('POST', '/connections', { connector: 'fake', config: { behaviour: 'push', clientId: 'client-1' } })).body.id;
  let begun = (await owner('POST', `/connections/${id}/authorize`, {})).body;
  let state = new URL(begun.url).searchParams.get('state');
  const wrong = await owner('GET', `/oauth/callback/other?code=x&state=${state}`);
  assert.equal(wrong.status, 400);
  assert.match(wrong.body, /made for another service/);
  const declined = await owner('GET', `/oauth/callback/fake?error=access_denied&error_description=${encodeURIComponent('<script>x</script>')}&state=${state}`);
  assert.equal(declined.status, 303);
  assert.equal(declined.headers.get('location'), `/#/connections/${id}?authorize=denied`);
  assert.deepEqual((await owner('GET', `/connections/${id}`)).body.authorization, { flow: 'redirect', status: 'denied', detail: 'Fake didn\'t allow the sign-in (access_denied).' });
  assert.equal((await owner('GET', `/oauth/callback/fake?code=x&state=${state}`)).status, 400, 'used up');
  assert.equal((await owner('GET', '/oauth/callback/fake?code=x&state=made-up')).status, 400);
  // Signing in by redirect needs the client id; a connector without a sign-in says so.
  begun = (await owner('POST', `/connections/${id}/authorize`, {})).body;
  state = new URL(begun.url).searchParams.get('state');
  assert.deepEqual((await owner('DELETE', `/connections/${id}/authorize`)).body, { cancelled: true });
  assert.equal((await owner('GET', `/oauth/callback/fake?code=x&state=${state}`)).status, 400, 'a cancelled flow is gone');
});

test('the device flow: a code to type, polled as the service says (pending, slow_down), then signed in; tokens renewed at 80 % and on a 401; a refused renewal is needs-reauth', async (t) => {
  const clock = fakeClock(Date.now());
  const { platform, svc, entries } = await start(t, { auth: 'device-code', clock });
  svc.script.expiresIn = 100;
  svc.script.device = ['pending', 'slow_down', 'ok'];
  const c = platform.connectors.create({ connector: 'fake', name: 'Twitch', config: { behaviour: 'ok', clientId: 'client-1', pollMs: 1000 } });
  assert.equal((await until(() => platform.connectors.get(c.id).health.status === 'needs-reauth' && platform.connectors.get(c.id))).health.status, 'needs-reauth');
  const begun = await platform.connectors.authorize(c.id, { who: { kind: 'local', label: 'cli:juan', scopes: new Set(['connections:write']) } });
  assert.deepEqual(Object.keys(begun).sort(), ['expiresAt', 'flow', 'intervalS', 'userCode', 'verificationUri', 'verificationUriComplete']);
  assert.deepEqual([begun.flow, begun.userCode, begun.intervalS], ['device', 'WDJB-MJHT', 2]);
  assert.equal(platform.connectors.get(c.id).authorization.status, 'pending');
  const polls = () => svc.requests.filter((r) => r.form.grant_type === 'urn:ietf:params:oauth:grant-type:device_code').length;
  await clock.advance(2 * SEC);
  await until(() => polls() === 1);
  await clock.advance(2 * SEC);
  await until(() => polls() === 2);
  await clock.advance(6 * SEC);
  assert.equal(polls(), 2, 'slow_down: 5 s slower');
  await clock.advance(1 * SEC);
  await until(() => platform.connectors.get(c.id).signedIn);
  await until(() => platform.bus.getState('viewers.twitch') === 214, 5000, 'the viewer count');
  const first = platform.store.get('connection_tokens', c.id).data.obtainedAt;
  // Renewed at 80 % of 100 s, the refresh token rotating.
  await clock.advance(80 * SEC);
  await until(() => platform.store.get('connection_tokens', c.id).data.obtainedAt !== first, 5000, 'a renewal');
  assert.equal(svc.requests.filter((r) => r.form.grant_type === 'refresh_token').length, 1);
  // A 401: renewed once and sent again.
  svc.script.viewers = [{ status: 401 }, 300];
  await clock.advance(SEC);
  await until(() => platform.bus.getState('viewers.twitch') === 300, 5000, 'the count after a renewal');
  assert.equal(svc.requests.filter((r) => r.form.grant_type === 'refresh_token').length, 2);
  // The service refuses the next renewal: needs-reauth, said once, and nothing retried.
  svc.script.refresh = 'invalid';
  await clock.advance(80 * SEC);
  await until(() => platform.connectors.get(c.id).health.status === 'needs-reauth', 5000, 'needs-reauth');
  const refreshes = svc.requests.filter((r) => r.form.grant_type === 'refresh_token').length;
  await clock.advance(10 * MIN);
  assert.equal(svc.requests.filter((r) => r.form.grant_type === 'refresh_token').length, refreshes, 'no loop');
  assert.match(platform.connectors.get(c.id).needsReauth.reason, /no longer accepts/);
  const seen = JSON.stringify([entries, platform.connectors.list(), platform.audit.list({ limit: 200 })]);
  for (const s of [...svc.tokens.keys(), ...svc.requests.map((r) => r.form.device_code).filter(Boolean)]) assert.ok(!seen.includes(s), `${s} leaked`);
});

test('a device code that expires, or is declined, ends the flow and says so', async (t) => {
  const clock = fakeClock(Date.now());
  const { platform, svc } = await start(t, { auth: 'device-code', clock });
  const who = { who: { kind: 'local', label: 'cli:juan', scopes: new Set(['connections:write']) } };
  const c = platform.connectors.create({ connector: 'fake', name: 'Twitch', config: { behaviour: 'push', clientId: 'client-1' } });
  svc.script.device = ['pending'];
  await platform.connectors.authorize(c.id, who);
  await clock.advance(10 * MIN);
  await until(() => platform.connectors.get(c.id).authorization?.status === 'expired', 5000, 'expired');
  svc.script.device = ['denied'];
  await platform.connectors.authorize(c.id, who);
  await clock.advance(2 * SEC);
  await until(() => platform.connectors.get(c.id).authorization?.status === 'denied', 5000, 'denied');
  assert.equal(platform.connectors.get(c.id).signedIn, undefined);
  assert.deepEqual(platform.audit.list({ action: 'connection.authorize-failed' }).items.map((e) => e.details.reason), ['access_denied', 'expired']);
});
