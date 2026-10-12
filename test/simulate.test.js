// POST /api/v1/overlays/{id}/simulate (08 §8.5): sample events and state into one overlay, so a
// template author can watch each state without going live.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SIM_HOLD_MS } from '../src/overlays/simulate.js';
import { DIAG, TESTBED, startWithOverlay } from './helpers.js';

// A platform with two testbed overlays (both would take any event) and a diagnostic one (which
// consumes only custom.*), and every envelope each one's channel sends.
async function setup(t) {
  const ctx = await startWithOverlay(t, { slug: 'bed', template: TESTBED, settings: {} });
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
    headers: { 'content-type': 'application/json', ...headers },
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

test('only JSON from the platform\'s own pages is accepted: no form posts, no other sites', async (t) => {
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
  const own = await post('bed', { kind: 'follow' }, { origin: platform.url });
  assert.equal(own.status, 200);
  await own.arrayBuffer();
  assert.equal(got.bed.length, 1);
  // No CORS grant: a browser on another site can't even send the JSON.
  const preflight = await fetch(`${platform.url}/api/v1/overlays/bed/simulate`, {
    method: 'OPTIONS',
    headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
  });
  assert.equal(preflight.headers.get('access-control-allow-origin'), null);
  await preflight.arrayBuffer();
});
