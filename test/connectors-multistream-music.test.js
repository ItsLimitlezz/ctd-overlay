// CTD Relay's Spotify now playing (its §13, v1.8): what a profile's Spotify plays reaches this
// platform as that profile's music.nowPlaying, a Track (02 §2.5.1). Against a pretend Relay: read
// from GET /music on connecting, then kept by music.nowplaying (another song, a pause, nothing
// playing); progressAt on this server's clock however far Relay's runs from it; two profiles never
// mix; a profile deleted there takes its track with it; Relay's song-request reply is a chat line
// that shows; a Relay older than v1.8 still connects, asked once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { startPlatform } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { trackOf } from '../src/connectors/defs/ctd-multistream.js';
import { until } from './connector-helpers.js';
import { startFakeMultistream } from './fixtures/fake-multistream.mjs';
import { defer, FIXTURE_TEMPLATES, memoryLogger, signedIn, tempDir, TESTBED } from './helpers.js';

const running = (s) => ['connected', 'degraded'].includes(s);
const ONE_MORE_TIME = {
  id: '4uLU6hMCjMI75M1A2tKUQC', uri: 'spotify:track:4uLU6hMCjMI75M1A2tKUQC', title: 'One More Time', artists: ['Daft Punk'], album: 'Discovery',
  artUrl: 'https://i.scdn.co/image/ab67616d00001e02aaaa', durationMs: 320357, explicit: false, url: 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC',
};
const STROBE = { id: 'strobe', title: 'Strobe', artists: ['deadmau5'], album: 'For Lack of a Better Name', artUrl: 'https://i.scdn.co/image/strobe', durationMs: 637000, explicit: false, url: 'https://open.spotify.com/track/strobe' };

async function start(t, prepare = () => {}) {
  const ms = await startFakeMultistream();
  defer(t, () => ms.close());
  prepare(ms);
  const root = tempDir(t);
  const config = loadConfig({ argv: ['--port', '0'], env: { SKP_DATA_DIR: path.join(root, 'data'), SKP_CONFIG_DIR: path.join(root, 'config') } });
  const platform = await startPlatform(config, { log: memoryLogger().log, templateDirs: [FIXTURE_TEMPLATES], connectors: { random: () => 0.5 } });
  defer(t, () => platform.stop());
  const token = ms.addToken();
  const r = await fetch(`${platform.url}/api/v1/connections`, { method: 'POST', headers: signedIn(platform, { 'content-type': 'application/json' }), body: JSON.stringify({ connector: 'ctd-multistream', config: { baseUrl: `${ms.url}/api/v1` }, secrets: { token } }) });
  const conn = await r.json();
  assert.equal(r.status, 201, JSON.stringify(conn));
  const get = () => platform.connectors.get(conn.id);
  await until(() => running(get().health.status) && get().info?.profiles?.length === 2, 8000, 'connected');
  return { ms, platform, id: conn.id, get };
}
// A feed's (a profile's) values, as the connection shows them.
const feedState = (get, profile) => get().feeds?.find((f) => f.profile === profile)?.state || {};
const playing = (get, profile = 'default') => feedState(get, profile)['music.nowPlaying'];

test('every profile: now playing read on connecting, then kept by music.nowplaying; another song, a pause, nothing playing; per profile', { timeout: 60000 }, async (t) => {
  // Relay's clock runs 90 s behind this one: progressAt is still this server's time.
  const ctx = await start(t, (ms) => {
    ms.skewMs = -90000;
    ms.setMusic({ track: ONE_MORE_TIME, progressMs: 61234, emit: false });
  });
  const { ms, platform, id, get } = ctx;
  assert.deepEqual(ms.requests.filter((r) => r.path === '/api/v1/music').map((r) => r.query.profile).sort(), ['default', 'p-dprtmnt'], 'read per profile');
  assert.ok(ms.requests.find((r) => r.path === '/api/v1/events').query.types.split(',').includes('music.nowplaying'), 'subscribed to music.nowplaying');
  const { progressAt, ...track } = playing(get);
  assert.deepEqual(track, {
    title: 'One More Time', artists: ['Daft Punk'], album: 'Discovery', art: ONE_MORE_TIME.artUrl, url: ONE_MORE_TIME.url,
    durationMs: 320357, progressMs: 61234, playing: true, source: 'spotify',
  });
  assert.ok(Math.abs(progressAt - ms.music.default.at - 90000) < 2000, `progressAt on this server's clock (${progressAt - ms.music.default.at})`);
  assert.equal(playing(get, 'p-dprtmnt'), undefined, 'DPRTMNT has no Spotify connected');
  // Owned by Miami or Bust's feed, src.platform spotify.
  assert.deepEqual(platform.bus.entriesOf('music.nowPlaying').map((x) => x.owner), [`${id}/default`]);

  // An overlay fed by Miami or Bust shows it; SK.music reads it.
  platform.overlays.create({ slug: 'np', template: TESTBED, settings: {}, connections: [`${id}/default`] });
  assert.equal(platform.overlays.resolve('np').channel.snapshot().state['music.nowPlaying'].title, 'One More Time');

  // Another song.
  ms.setMusic({ track: STROBE, progressMs: 0 });
  await until(() => playing(get)?.title === 'Strobe', 5000, 'the next song');
  assert.deepEqual([playing(get).artists, playing(get).progressMs, playing(get).playing], [['deadmau5'], 0, true]);
  // Paused: the track stays, not playing.
  ms.setMusic({ track: STROBE, playing: false, progressMs: 120400 });
  await until(() => playing(get)?.playing === false, 5000, 'paused');
  assert.equal(playing(get).progressMs, 120400);
  // DPRTMNT connects Spotify: its own, Miami or Bust's unchanged.
  ms.setMusic({ profile: 'p-dprtmnt', track: ONE_MORE_TIME, progressMs: 5000 });
  await until(() => playing(get, 'p-dprtmnt')?.title === 'One More Time', 5000, 'DPRTMNT\'s track');
  assert.equal(playing(get).title, 'Strobe');
  // Nothing plays (a podcast, an ad, Spotify closed): the key goes.
  ms.setMusic({ track: null, playing: false });
  await until(() => playing(get) === undefined, 5000, 'nothing playing');
  assert.equal(platform.overlays.resolve('np').channel.snapshot().state['music.nowPlaying'], undefined);
  // A profile deleted there takes its track with it.
  ms.deleteProfile('p-dprtmnt');
  await until(() => platform.bus.entriesOf('music.nowPlaying').length === 0, 5000, 'DPRTMNT\'s track gone');
});

test('a reset reads now playing again; a song request\'s reply is a chat line that shows', { timeout: 60000 }, async (t) => {
  const ctx = await start(t);
  const { ms, platform, id, get } = ctx;
  platform.overlays.create({ slug: 'np', template: TESTBED, settings: {}, connections: [`${id}/default`] });
  const live = [];
  platform.overlays.resolve('np').channel.subscribe((env) => live.push(env));
  // A viewer's !sr: Relay's answer as an event line (no alert after it), shown after its wait.
  const text = '🎵 NightOwl added One More Time — Daft Punk';
  ms.emit('chat.message', { id: 'twitch:sr-1', platform: 'twitch', destinationId: 'd-tw', user: { id: 'twitch:52174911', name: 'NightOwl', roles: [] }, text, fragments: [{ type: 'text', text }], kind: 'event', ts: Date.now() }, { platform: 'twitch', destination: 'd-tw' });
  await until(() => live.some((e) => e.type === 'chat.message' && e.data.id === 'twitch:sr-1'), 5000, 'the reply line');
  assert.equal(live.find((e) => e.data.id === 'twitch:sr-1').data.kind, 'event');
  // Relay restarted while a song started: the reset reads it.
  ms.dropStreams();
  ms.setMusic({ track: ONE_MORE_TIME, progressMs: 1000, emit: false });
  ms.forget();
  await until(() => playing(get)?.title === 'One More Time', 10000, 'read again after the reset');
});

test('a Relay older than v1.8 still connects: /music asked once a start, no track, no warning', { timeout: 30000 }, async (t) => {
  const { ms, get } = await start(t, (m) => { m.noMusicRoute = true; });
  assert.equal(ms.requests.filter((r) => r.path === '/api/v1/music').length, 1, 'asked once, not per profile');
  assert.equal(playing(get), undefined);
  assert.ok(!get().health.warnings.some((w) => /spotify|music|playing|v1\.8/i.test(w)), JSON.stringify(get().health.warnings));
});

test('a nowPlaying as this standard\'s Track: progress never past the end, only https links, nothing without a title and artist', () => {
  const np = { playing: true, track: { ...ONE_MORE_TIME, artUrl: 'http://insecure/art.jpg' }, progressMs: 400000, at: 1791830000123 };
  assert.deepEqual(trackOf(np, 1000), {
    title: 'One More Time', artists: ['Daft Punk'], album: 'Discovery', url: ONE_MORE_TIME.url,
    durationMs: 320357, progressMs: 320357, progressAt: 1791829999123, playing: true, source: 'spotify',
  });
  assert.equal(trackOf(null), undefined, 'no Spotify connected');
  assert.equal(trackOf({ playing: false, track: null, progressMs: 0, at: 1 }), undefined, 'nothing playing');
  assert.equal(trackOf({ playing: true, track: { ...STROBE, artists: [] }, progressMs: 0, at: 1 }), undefined, 'no artist');
  assert.deepEqual(trackOf({ playing: 'yes', track: { title: 'x', artists: ['y', 7] } }), { title: 'x', artists: ['y'], playing: false, source: 'spotify' });
});
