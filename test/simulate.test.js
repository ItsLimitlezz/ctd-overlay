// POST /api/v1/overlays/{id}/simulate (08 §8.5): sample events and state into one overlay, so a
// template author can watch each state without going live.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SIM_HOLD_MS } from '../src/overlays/simulate.js';
import { DIAG, TESTBED, TESTBED_DIR, packTemplate, signedIn, startWithOverlay } from './helpers.js';

// A platform with two testbed overlays (both would take any event) and a diagnostic one (which
// consumes only custom.*), and every envelope each one's channel sends.
async function setup(t, { install, settings = {}, options } = {}) {
  const ctx = await startWithOverlay(t, { slug: 'bed', template: TESTBED, settings, install, platform: options });
  const { platform } = ctx;
  platform.overlays.create({ slug: 'other', template: TESTBED, settings: {} });
  platform.overlays.create({ slug: 'diag', template: DIAG, settings: {} });
  const got = {};
  for (const slug of ['bed', 'other', 'diag']) {
    got[slug] = [];
    platform.overlays.resolve(slug).channel.subscribe((env) => got[slug].push(env));
  }
  const global = [];
  platform.bus.subscribeAll((env) => global.push(env));
  const post = (ref, body, headers = {}) => fetch(`${platform.url}/api/v1/overlays/${ref}/simulate`, {
    method: 'POST',
    headers: signedIn(platform, { 'content-type': 'application/json', ...headers }),
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const send = async (ref, body) => {
    const res = await post(ref, body);
    assert.equal(res.status, 200, `${JSON.stringify(body)}: ${res.status}`);
    return res.json();
  };
  return { ...ctx, got, global, post, send, snapshot: (slug) => platform.overlays.resolve(slug).channel.snapshot().state };
}

const settle = () => new Promise((r) => setTimeout(r, 150)); // past the 100 ms state coalescing window

test('each event kind reaches the targeted overlay only, tagged as the simulator', async (t) => {
  const { got, global, send } = await setup(t);
  const kinds = {
    chat: 'chat.message', follow: 'alert.follow', subscription: 'alert.subscription', gift: 'alert.gift',
    raid: 'alert.raid', cheer: 'alert.cheer', tip: 'alert.tip', 'media.stop': 'media.stop',
  };
  for (const [kind, type] of Object.entries(kinds)) {
    const body = await send('bed', { kind });
    assert.deepEqual(body.sent.map((s) => [s.type, s.delivered]), [[type, true]], kind);
  }
  const play = await send('bed', { kind: 'media.play', url: '/media/0123456789abcdef0123456789abcdef/stinger.webm' });
  assert.equal(play.sent[0].type, 'media.play');
  assert.deepEqual(got.bed.map((e) => e.type), [...Object.values(kinds), 'media.play']);
  assert.ok(got.bed.every((e) => e.src.connector === 'simulator'));
  assert.deepEqual(got.other, [], 'never another overlay, even one that would take it');
  assert.deepEqual(global, [], 'never the platform\'s own events (the events API, webhooks)');
});

test('options shape what is sent, within bounds', async (t) => {
  const { got, send } = await setup(t);
  await send('bed', { kind: 'gift' });
  await send('bed', { kind: 'gift', count: 5 });
  await send('bed', { kind: 'gift', count: -3 });
  await send('bed', { kind: 'raid', viewers: 42, name: 'Crew' });
  await send('bed', { kind: 'chat', text: 'hello <b>there</b>', name: 'x'.repeat(200) });
  const [gift, five, bad, raid, chat] = got.bed;
  assert.deepEqual([gift.data.amount.value, five.data.amount.value, bad.data.amount.value], [25, 5, 25]);
  assert.deepEqual([raid.data.amount, raid.data.user.name], [{ value: 42, unit: 'viewers' }, 'Crew']);
  assert.equal(chat.data.text, 'hello <b>there</b>', 'sent as text; templates escape it');
  assert.equal(chat.data.user.name.length, 60);
});

test('simulated state shows on that overlay only and comes back real at "reset"; the platform\'s state is untouched', async (t) => {
  const { platform, got, send, snapshot } = await setup(t);
  platform.bus.setState('viewers.total', 1000);
  await settle();
  const viewers = await send('bed', { kind: 'viewers', value: 5 });
  assert.deepEqual(viewers.sent, [{ state: 'viewers.total', delivered: true, holdMs: SIM_HOLD_MS }]);
  assert.equal(snapshot('bed')['viewers.total'], 5);
  assert.equal(snapshot('other')['viewers.total'], 1000);
  assert.equal(platform.bus.getState('viewers.total'), 1000);
  await send('bed', { kind: 'track', title: 'Opus', artist: 'Eric Prydz' });
  assert.equal(snapshot('bed')['music.nowPlaying'].title, 'Opus');
  assert.equal(snapshot('other')['music.nowPlaying'], undefined);
  await settle();
  // "Drop viewers to absent" (08 §8.5): absent there, though the platform has a count.
  await send('bed', { kind: 'viewers-clear' });
  assert.equal('viewers.total' in snapshot('bed'), false);
  await settle();
  platform.bus.setState('viewers.total', 1200);
  await settle();
  assert.equal('viewers.total' in snapshot('bed'), false, 'still simulated');
  const reset = await send('bed', { kind: 'reset' });
  assert.deepEqual(reset.sent, [{ reset: ['viewers.total', 'music.nowPlaying'] }]);
  await settle();
  assert.equal(snapshot('bed')['viewers.total'], 1200, 'the real count is back');
  assert.equal('music.nowPlaying' in snapshot('bed'), false);
  const last = got.bed.filter((e) => e.type === 'state.changed' && e.data.key === 'viewers.total').at(-1);
  assert.equal(last.data.value, 1200);
});

test('an overlay whose template doesn\'t consume a kind is told so, and gets nothing', async (t) => {
  const { got, send, snapshot } = await setup(t);
  const chat = await send('diag', { kind: 'chat' });
  assert.equal(chat.sent[0].delivered, false);
  const viewers = await send('diag', { kind: 'viewers', value: 3 });
  assert.deepEqual(viewers.sent, [{ state: 'viewers.total', delivered: false }]);
  assert.deepEqual(got.diag, []);
  assert.equal('viewers.total' in snapshot('diag'), false);
});

test('the overlay is found by slug or id; anything else is refused with a reason', async (t) => {
  const { overlay, post, send } = await setup(t);
  assert.equal((await send(overlay.id, { kind: 'follow' })).overlay, 'bed');
  const cases = [
    [['nope', { kind: 'follow' }], 404],
    [['bed', { kind: 'explode' }], 422],
    [['bed', { kind: 'media.play', url: 'javascript:alert(1)' }], 422],
    [['bed', { kind: 'media.play', url: '/media/../../skp.lock' }], 422],
    [['bed', { kind: 'media.play', url: 'https://example.com/x.webm' }], 422],
    [['bed', { kind: '__proto__' }], 422],
    [['bed', '[1, 2'], 400],
    [['bed', { kind: 'chat', text: 'x'.repeat(20000) }], 413],
  ];
  for (const [[ref, body], status] of cases) {
    const res = await post(ref, body);
    assert.equal(res.status, status, `${ref} ${JSON.stringify(body).slice(0, 80)}`);
    assert.match(res.headers.get('content-type'), /application\/problem\+json/);
    await res.arrayBuffer();
  }
});

test('only JSON from the platform\'s own pages or programs is accepted: no form posts, no other sites, no sandboxed pages', async (t) => {
  const { platform, post, got } = await setup(t);
  const form = await post('bed', 'kind=follow', { 'content-type': 'application/x-www-form-urlencoded' });
  assert.equal(form.status, 415);
  await form.arrayBuffer();
  const plain = await post('bed', JSON.stringify({ kind: 'follow' }), { 'content-type': 'text/plain' });
  assert.equal(plain.status, 415);
  await plain.arrayBuffer();
  const elsewhere = await post('bed', { kind: 'follow' }, { origin: 'https://evil.example' });
  assert.equal(elsewhere.status, 403);
  await elsewhere.arrayBuffer();
  const sandboxed = await post('bed', { kind: 'follow' }, { origin: 'null' });
  assert.equal(sandboxed.status, 403, 'an overlay page (a template\'s script) has origin "null"');
  await sandboxed.arrayBuffer();
  const own = await post('bed', { kind: 'follow' }, { origin: platform.url });
  assert.equal(own.status, 200, 'the admin UI\'s pages, signed in');
  await own.arrayBuffer();
  const program = await post('bed', { kind: 'follow' });
  assert.equal(program.status, 200);
  await program.arrayBuffer();
  assert.equal(got.bed.length, 2);
  // Signed in, or nothing: simulating takes overlays:control.
  const anonymous = await fetch(`${platform.url}/api/v1/overlays/bed/simulate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"kind":"follow"}' });
  assert.equal(anonymous.status, 401);
  assert.equal((await anonymous.json()).type, 'https://skp.dev/errors/unauthenticated');
  assert.equal(got.bed.length, 2);
  // No CORS grant: a browser on another site can't even send the JSON.
  const preflight = await fetch(`${platform.url}/api/v1/overlays/bed/simulate`, {
    method: 'OPTIONS',
    headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
  });
  assert.equal(preflight.headers.get('access-control-allow-origin'), null);
  await preflight.arrayBuffer();
});

test('a page that reaches the platform under another name (DNS rebinding) is refused, whatever its Origin says', async (t) => {
  const { platform, got } = await setup(t);
  const { request } = await import('node:http');
  const { port } = new URL(platform.url);
  const raw = (host, origin) => new Promise((resolve, reject) => {
    const body = JSON.stringify({ kind: 'raid' });
    const req = request({ host: '127.0.0.1', port, method: 'POST', path: '/api/v1/overlays/bed/simulate', headers: signedIn(platform, { host, ...(origin ? { origin } : {}), 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }) }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end(body);
  });
  assert.equal(await raw(`attacker.example:${port}`, `http://attacker.example:${port}`), 403, 'Host and Origin agree, and both are someone else');
  assert.equal(await raw(`attacker.example:${port}`), 403, 'no Origin at all');
  assert.equal(await raw(`127.0.0.1:${port}`, `http://attacker.example:${port}`), 403);
  assert.equal(await raw(`localhost:${port}`, `http://localhost:${port}`), 200, 'the platform\'s own names and origin');
  assert.equal(await raw(`127.0.0.1:${port}`), 200);
  assert.deepEqual(got.bed.map((e) => e.type), ['alert.raid', 'alert.raid']);
});

test('a simulation ends by itself after 60 s (shortened here), and the real value comes back', async (t) => {
  assert.equal(SIM_HOLD_MS, 60000, '08 §8.5: this platform holds simulated state for a minute');
  const { platform, send, snapshot } = await setup(t, { options: { simulateHoldMs: 300 } });
  platform.bus.setState('viewers.total', 1000);
  await settle();
  assert.deepEqual((await send('bed', { kind: 'viewers', value: 5 })).sent, [{ state: 'viewers.total', delivered: true, holdMs: 300 }]);
  assert.equal(snapshot('bed')['viewers.total'], 5);
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(snapshot('bed')['viewers.total'], 1000);
  assert.deepEqual(platform.overlays.resolve('bed').channel.simulating, []);
});

test('caller options can\'t break the payload shapes: a media id, chat roles, a stop', async (t) => {
  const { got, send, post } = await setup(t);
  const url = '/media/0123456789abcdef0123456789abcdef/a.webm';
  // 7000 arrays deep: fits the body limit, and would overflow the stack if anything recursed into it.
  const deep = `${'['.repeat(7000)}"x"${']'.repeat(7000)}`;
  for (const body of [`{"kind":"media.play","url":"${url}","mediaId":${deep}}`, `{"kind":"gift","count":${deep}}`]) {
    const res = await post('bed', body);
    assert.equal(res.status, 200, 'a hostile value is replaced, not a crash');
    await res.arrayBuffer();
  }
  got.bed.length = 0;
  await send('bed', { kind: 'media.play', url, mediaId: { __proto__: { x: 1 }, toString: 'nope' } });
  await send('bed', { kind: 'media.play', url, mediaId: 'med_01J9ZZZZZZZZZZZZZZZZZZZZZZ' });
  await send('bed', { kind: 'chat', roles: ['owner', 'moderator', 'moderator', 'vip', 42] });
  await send('bed', { kind: 'media.stop' });
  await send('bed', { kind: 'media.stop', url, mediaId: 'med_abc' });
  const plays = got.bed.filter((e) => e.type === 'media.play').map((e) => e.data.mediaId);
  assert.deepEqual(plays, ['med_sim', 'med_01J9ZZZZZZZZZZZZZZZZZZZZZZ']);
  assert.deepEqual(got.bed.find((e) => e.type === 'chat.message').data.user.roles, ['moderator', 'vip']);
  assert.deepEqual(got.bed.filter((e) => e.type === 'media.stop').map((e) => e.data), [{ mediaId: 'med_sim' }, { mediaId: 'med_abc', url }]);
});

test('a setting bound to a simulated key keeps the real value, during the hold and after it', async (t) => {
  const bound = { type: 'object', properties: { baseline: { type: 'integer', 'x-skp-bind': 'viewers.total' } } };
  const { platform, send } = await setup(t, { install: [packTemplate(TESTBED_DIR, { manifest: { version: '1.1.0', settings: bound } })] });
  platform.overlays.create({ slug: 'bound', template: { id: TESTBED.id, version: '1.1.0' }, settings: {} });
  const settings = () => platform.overlays.resolve('bound').settings;
  platform.bus.setState('viewers.total', 1000);
  await settle();
  assert.deepEqual(settings(), { baseline: 1000 });
  await send('bound', { kind: 'viewers', value: 5 });
  platform.bus.setState('viewers.total', 1200); // a real change re-resolves bound settings
  await settle();
  assert.deepEqual(settings(), { baseline: 1200 }, 'from the real count, not the simulated one');
  await send('bound', { kind: 'reset' });
  assert.deepEqual(settings(), { baseline: 1200 });
});
