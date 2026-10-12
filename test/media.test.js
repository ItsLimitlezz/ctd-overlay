// Uploaded media (03 §3.4, 07 §7.11, H12): what is accepted, how phone video is converted, the
// limits on conversions, and how files are served.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { constants, getPriority } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { openData, startPlatform } from '../src/app.js';
import { run } from '../src/cli.js';
import { loadConfig } from '../src/config.js';
import { probeFfmpeg, runFfmpeg } from '../src/media/ffmpeg.js';
import { createMediaLibrary, MEDIA_LIMITS, MediaError, mediaName, mediaUrl } from '../src/media/library.js';
import { parseRange } from '../src/media/routes.js';
import { sniff } from '../src/media/sniff.js';
import { openStore } from '../src/store/index.js';
import { validateSettings } from '../src/templates/settings.js';
import { auditOf, defer, DIAG_DIR, memoryLogger, packTemplate, tempDir } from './helpers.js';

const FAKE = [process.execPath, fileURLToPath(new URL('./fixtures/fake-ffmpeg.mjs', import.meta.url))];
const NO_FFMPEG = [path.join(fileURLToPath(new URL('.', import.meta.url)), 'no-such-ffmpeg-here')];

// The first bytes of each kind of file, enough to be told apart, padded to look like content.
const pad = (head, n = 256) => Buffer.concat([head, Buffer.alloc(n, 7)]);
const SAMPLES = {
  png: pad(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  jpeg: pad(Buffer.from([0xff, 0xd8, 0xff, 0xe0])),
  gif: pad(Buffer.from('GIF89a')),
  webp: pad(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')])),
  wav: pad(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE')])),
  avi: pad(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('AVI ')])),
  mov: pad(Buffer.concat([Buffer.from([0, 0, 0, 0x14]), Buffer.from('ftypqt  ')])),
  mp4: pad(Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom')])),
  m4a: pad(Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypM4A ')])),
  heic: pad(Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic')])),
  avif: pad(Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypavif')])),
  webm: pad(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0x82, 0x84, ...Buffer.from('webm')])),
  mkv: pad(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0xa3, 0x42, 0x86, 0x81, 0x01, 0x42, 0x82, 0x88, ...Buffer.from('matroska')])),
  ogg: pad(Buffer.from('OggS')),
  flac: pad(Buffer.from('fLaC')),
  mp3: pad(Buffer.from('ID3')),
  mp3Frame: pad(Buffer.from([0xff, 0xfb, 0x90, 0x00])),
  woff2: pad(Buffer.from('wOF2')),
  woff: pad(Buffer.from('wOFF')),
  otf: pad(Buffer.from('OTTO')),
  ttf: pad(Buffer.from([0x00, 0x01, 0x00, 0x00])),
};

test('a file is what its first bytes say: images, video, audio and fonts; anything else is refused', () => {
  const expect = {
    png: ['image/png', 'image'], jpeg: ['image/jpeg', 'image'], gif: ['image/gif', 'image'], webp: ['image/webp', 'image'],
    avif: ['image/avif', 'image'], heic: ['image/heic', 'image', 'image'],
    mov: ['video/quicktime', 'video', 'video'], mp4: ['video/mp4', 'video', 'video'], avi: ['video/x-msvideo', 'video', 'video'],
    mkv: ['video/x-matroska', 'video', 'video'], webm: ['video/webm', 'video'],
    wav: ['audio/wav', 'audio'], m4a: ['audio/mp4', 'audio'], ogg: ['audio/ogg', 'audio'], flac: ['audio/flac', 'audio'],
    mp3: ['audio/mpeg', 'audio'], mp3Frame: ['audio/mpeg', 'audio'],
    woff2: ['font/woff2', 'font'], woff: ['font/woff', 'font'], otf: ['font/otf', 'font'], ttf: ['font/ttf', 'font'],
  };
  for (const [name, [type, kind, convert]] of Object.entries(expect)) {
    const got = sniff(SAMPLES[name]);
    assert.deepEqual([got?.type, got?.kind, got?.convert], [type, kind, convert], name);
  }
  // A brand the compatible list names counts (an AVIF often says mif1 first); camera raw and
  // JPEG 2000 in an ISO box are not overlay media.
  const ftyp = (major, ...compatible) => {
    const box = Buffer.concat([Buffer.alloc(4), Buffer.from(`ftyp${major}`), Buffer.alloc(4), ...compatible.map((c) => Buffer.from(c))]);
    box.writeUInt32BE(box.length, 0);
    return pad(box);
  };
  assert.equal(sniff(ftyp('mif1', 'mif1', 'avif', 'miaf'))?.type, 'image/avif');
  assert.equal(sniff(ftyp('mif1', 'mif1', 'heic'))?.type, 'image/heic');
  assert.equal(sniff(ftyp('dash', 'iso6', 'mp41'))?.type, 'video/mp4');
  for (const raw of ['crx ', 'jp2 ']) assert.equal(sniff(ftyp(raw, 'isom')), undefined, raw);
  // SVG (a document that can carry script), HTML, text, executables, nothing at all.
  for (const other of ['<svg xmlns="http://www.w3.org/2000/svg"></svg>', '<!doctype html><script>', 'hello', 'MZ\x90\x00', '']) {
    assert.equal(sniff(Buffer.from(other)), undefined, other);
  }
});

test('a stored name is safe in a URL and on every OS, with the extension its content has', () => {
  assert.equal(mediaName('IMG_0042.MOV', 'mp4'), 'IMG_0042.mp4');
  assert.equal(mediaName('Logo final (2).PNG', 'png'), 'Logo-final-2.png');
  assert.equal(mediaName('../../etc/passwd', 'png'), 'passwd.png');
  assert.equal(mediaName('café déjà vu.jpg', 'jpg'), 'cafe-deja-vu.jpg');
  assert.equal(mediaName('...', 'png'), 'file.png');
  assert.equal(mediaName('', 'png'), 'file.png');
  assert.equal(mediaName('C:\\Users\\me\\clip.mov', 'mp4'), process.platform === 'win32' ? 'clip.mp4' : 'C-Users-me-clip.mp4');
  assert.ok(mediaName('x'.repeat(500), 'png').length <= 100);
});

test('byte ranges: one range in its forms, the rest answered in full, the unsatisfiable refused', () => {
  assert.deepEqual(parseRange('bytes=0-99', 1000), [0, 99]);
  assert.deepEqual(parseRange('bytes=900-', 1000), [900, 999]);
  assert.deepEqual(parseRange('bytes=-100', 1000), [900, 999]);
  assert.deepEqual(parseRange('bytes=-5000', 1000), [0, 999]);
  assert.deepEqual(parseRange('bytes=990-5000', 1000), [990, 999]);
  assert.equal(parseRange('bytes=1000-', 1000), 'invalid');
  assert.equal(parseRange('bytes=5-4', 1000), 'invalid');
  assert.equal(parseRange('bytes=-0', 1000), 'invalid');
  for (const full of [undefined, 'bytes=0-1,5-6', 'items=0-1', 'bytes=-', 'bytes=abc', 'nonsense']) assert.equal(parseRange(full, 1000), undefined, full);
});

// A library on its own store and data directory, closed when the test ends. The stand-in ffmpeg
// runs at normal priority (lowerPriority: false): lowered, it could starve on a busy machine and
// fail a timing test. One test checks the lowering itself.
function library(t, { ffmpeg = FAKE, limits, dataDir = tempDir(t), lowerPriority = false } = {}) {
  const { log, entries } = memoryLogger();
  const store = openStore({ dataDir, backend: 'json', log });
  const media = createMediaLibrary({ dataDir, store, log, ffmpeg, limits, lowerPriority });
  defer(t, async () => { await media.close(); store.close(); });
  return { media, store, log, entries, dataDir, root: path.join(dataDir, 'media') };
}

const leftovers = (root) => readdirSync(root).filter((n) => n.startsWith('.'));
// Every run of the stand-in, and its conversions (the ones with an output, not the stream
// listings before them).
const runsOf = (logFile) => (existsSync(logFile) ? readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const conversions = (logFile) => runsOf(logFile).filter((r) => !r.inspect);
const hanging = (logFile) => conversions(logFile).some((r) => r.hang);

async function until(check, ms = 10000) {
  const t0 = Date.now();
  while (!check()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
}

function fake(t, mode, { delay, logFile } = {}) {
  const saved = { mode: process.env.FAKE_FFMPEG, delay: process.env.FAKE_FFMPEG_DELAY, log: process.env.FAKE_FFMPEG_LOG };
  process.env.FAKE_FFMPEG = mode;
  if (delay !== undefined) process.env.FAKE_FFMPEG_DELAY = String(delay); else delete process.env.FAKE_FFMPEG_DELAY;
  if (logFile) process.env.FAKE_FFMPEG_LOG = logFile; else delete process.env.FAKE_FFMPEG_LOG;
  defer(t, () => {
    for (const [k, v] of [['FAKE_FFMPEG', saved.mode], ['FAKE_FFMPEG_DELAY', saved.delay], ['FAKE_FFMPEG_LOG', saved.log]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });
}

test('an image, sound or font is kept as uploaded, under a random, unguessable path', async (t) => {
  const { media, root } = library(t);
  const doc = await media.add(SAMPLES.png, { name: 'Logo.png', actor: 'test' });
  assert.match(doc.id, /^med_/);
  assert.match(doc.data.fileId, /^[0-9a-f]{32}$/, '128 random bits (07 §7.6)');
  assert.deepEqual({ ...doc.data, fileId: undefined, createdAt: undefined }, {
    name: 'Logo.png', fileId: undefined, type: 'image/png', kind: 'image', size: SAMPLES.png.length, status: 'ready', converted: false,
    original: { name: 'Logo.png', type: 'image/png', size: SAMPLES.png.length }, createdAt: undefined, actor: 'test',
  });
  assert.deepEqual(readFileSync(path.join(root, doc.data.fileId, 'Logo.png')), SAMPLES.png);
  assert.equal(mediaUrl(doc), `/media/${doc.data.fileId}/Logo.png`);
  // The URL is what a media setting may hold (04 §4.3).
  const manifest = { settings: { type: 'object', properties: { poster: { type: 'string', 'x-skp-widget': 'media' } } } };
  assert.deepEqual(validateSettings(manifest, { poster: mediaUrl(doc) }), []);
  for (const kind of ['webm', 'mp3', 'woff2', 'm4a']) {
    const d = await media.add(SAMPLES[kind], { name: `x.${kind}` });
    assert.equal(d.data.converted, false, kind);
  }
  assert.deepEqual(leftovers(root), []);
  assert.equal(media.list().length, 5);
  assert.equal(media.list()[0].id > media.list()[4].id, true, 'newest first');
});

test('phone video is converted to H.264 MP4 with the rotation baked in and no metadata (H12)', async (t) => {
  const dir = tempDir(t);
  const logFile = path.join(dir, 'ffmpeg.log');
  fake(t, 'copy', { logFile });
  const { media, root } = library(t);
  const doc = await media.add(SAMPLES.mov, { name: 'IMG_0042.MOV' });
  assert.equal(doc.data.status, 'ready');
  assert.equal(doc.data.converted, true);
  assert.equal(doc.data.name, 'IMG_0042.mp4');
  assert.equal(doc.data.type, 'video/mp4');
  assert.deepEqual(doc.data.original, { name: 'IMG_0042.MOV', type: 'video/quicktime', size: SAMPLES.mov.length });
  assert.ok(existsSync(path.join(root, doc.data.fileId, 'IMG_0042.mp4')));
  const [call] = conversions(logFile);
  const args = call.args.join(' ');
  for (const want of ['-c:v libx264', '-pix_fmt yuv420p', '-c:a aac', '-map_metadata -1', '-movflags +faststart', '-nostdin', '-color_primaries bt709 -color_trc bt709 -colorspace bt709']) assert.ok(args.includes(want), `${want} in ${args}`);
  assert.ok(!call.args.includes('-noautorotate'), 'ffmpeg rotates on decode by default; that must stay on');
  assert.ok(!args.includes('zscale'), 'an SDR clip isn\'t tone-mapped');
  assert.equal(call.args[call.args.indexOf('-fs') + 1], String(600 * 1024 * 1024), 'the output stops at the upload cap');
  assert.deepEqual(leftovers(root), [], 'no staging or work directories left');
  // HEIC photos become JPEG: one frame, and no metadata (a phone photo says where it was taken).
  const photo = await media.add(SAMPLES.heic, { name: 'IMG_0043.HEIC' });
  assert.deepEqual([photo.data.name, photo.data.type, photo.data.converted], ['IMG_0043.jpg', 'image/jpeg', true]);
  const heic = conversions(logFile).at(-1).args.join(' ');
  for (const want of ['-map_metadata -1', '-frames:v 1', '-nostdin', '-protocol_whitelist file']) assert.ok(heic.includes(want), `${want} in ${heic}`);
});

test('the limits: 600 MiB a file, two conversions at once, exactly the cap accepted and a byte more refused', async (t) => {
  assert.deepEqual({ ...MEDIA_LIMITS }, { fileBytes: 600 * 1024 * 1024, conversions: 2, conversionMs: 15 * 60 * 1000 });
  fake(t, 'copy');
  const { media, root, store } = library(t, { limits: { fileBytes: 1000 } });
  const sized = (n) => Buffer.concat([SAMPLES.png.subarray(0, 8), Buffer.alloc(n - 8, 7)]);
  assert.equal((await media.add(sized(1000), { name: 'exact.png' })).data.size, 1000);
  await assert.rejects(media.add(sized(1001), { name: 'over.png' }), { code: 'too-large' });
  // A converted file exactly at the cap is kept converted.
  const atCap = library(t, { limits: { fileBytes: SAMPLES.mov.length } });
  assert.equal((await atCap.media.add(SAMPLES.mov, { name: 'c.mov' })).data.converted, true);
  // An upload that never ends is cut off at the cap, its source stopped, and nothing kept.
  let sent = 0;
  const endless = new Readable({
    read() {
      sent += 64 * 1024;
      this.push(sent === 64 * 1024 ? Buffer.concat([SAMPLES.png, Buffer.alloc(64 * 1024 - SAMPLES.png.length)]) : Buffer.alloc(64 * 1024, 1));
    },
  });
  const big = library(t, { limits: { fileBytes: 1024 * 1024 } });
  await assert.rejects(big.media.add(endless, { name: 'endless.png' }), { code: 'too-large' });
  assert.ok(endless.destroyed, 'the source is stopped');
  assert.ok(sent < 4 * 1024 * 1024, `read ${sent} bytes for a 1 MiB cap`);
  assert.deepEqual(readdirSync(big.root), []);
  assert.equal(store.list('media').length, 1);
  assert.deepEqual(leftovers(root), []);
});

test('iPhone HDR video is tone-mapped to SDR; without the zscale filter it is converted all the same', async (t) => {
  const dir = tempDir(t);
  const logFile = path.join(dir, 'ffmpeg.log');
  fake(t, 'nozscale', { logFile });
  const saved = process.env.FAKE_FFMPEG_STREAMS;
  process.env.FAKE_FFMPEG_STREAMS = '  Stream #0:0[0x1](und): Video: hevc (Main 10) (hvc1 / 0x31637668), yuv420p10le(tv, bt2020nc/bt2020/arib-std-b67), 1920x1080, 30 fps\n  Stream #0:1[0x2](und): Audio: aac (LC), 44100 Hz, stereo\n';
  defer(t, () => { if (saved === undefined) delete process.env.FAKE_FFMPEG_STREAMS; else process.env.FAKE_FFMPEG_STREAMS = saved; });
  const { media, entries } = library(t);
  const doc = await media.add(SAMPLES.mov, { name: 'IMG_0099.MOV' });
  assert.equal(doc.data.converted, true);
  const runs = conversions(logFile);
  assert.equal(runs.length, 2, 'tone-mapped, then (no zscale here) without');
  assert.ok(runs[0].args.join(' ').includes('tonemap=hable'));
  assert.ok(!runs[1].args.join(' ').includes('zscale'));
  assert.ok(runs[1].args.join(' ').includes('-color_trc bt709'));
  assert.ok(entries.some((e) => /can't tone-map HDR/.test(e.msg)));
});

test('an MP4 with only sound is kept as audio, and one with neither picture nor sound is refused', async (t) => {
  fake(t, 'copy');
  const saved = process.env.FAKE_FFMPEG_STREAMS;
  defer(t, () => { if (saved === undefined) delete process.env.FAKE_FFMPEG_STREAMS; else process.env.FAKE_FFMPEG_STREAMS = saved; });
  process.env.FAKE_FFMPEG_STREAMS = '  Stream #0:0[0x1](und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, stereo, fltp\n';
  const { media, root } = library(t);
  const song = await media.add(SAMPLES.mp4, { name: 'set-recording.mp4' });
  assert.deepEqual([song.data.name, song.data.type, song.data.kind, song.data.converted, song.data.note], ['set-recording.m4a', 'audio/mp4', 'audio', false, undefined]);
  process.env.FAKE_FFMPEG_STREAMS = '  Stream #0:0[0x1](und): Data: none (tmcd / 0x64636D74)\n';
  await assert.rejects(media.add(SAMPLES.mp4, { name: 'odd.mp4' }), { code: 'unsupported-type' });
  assert.deepEqual(readdirSync(root).filter((n) => !n.startsWith('.')).length, 1);
  assert.equal(media.list().length, 1);
});

test('HEIC needs ffmpeg 7.1 or later: an older one is named in the refusal; ffmpeg\'s messages never show the data directory', async (t) => {
  const { readsHeic } = await import('../src/media/ffmpeg.js');
  for (const [v, yes] of [['7.1', true], ['7.1.1', true], ['n7.1', true], ['8.0', true], ['N-117000-gabcdef', true], ['7.0.2', false], ['6.1.1-3ubuntu5', false], ['4.4.2', false], ['', false]]) assert.equal(readsHeic(v), yes, v);
  const saved = process.env.FAKE_FFMPEG_VERSION;
  process.env.FAKE_FFMPEG_VERSION = '6.1.1-3ubuntu5';
  defer(t, () => { if (saved === undefined) delete process.env.FAKE_FFMPEG_VERSION; else process.env.FAKE_FFMPEG_VERSION = saved; });
  fake(t, 'fail');
  const { media, root, dataDir } = library(t);
  await assert.rejects(media.add(SAMPLES.heic, { name: 'p.heic' }), (err) => err.code === 'needs-ffmpeg' && /7\.1 or later.*this one is 6\.1\.1-3ubuntu5/.test(err.message));
  const kept = await media.add(SAMPLES.mov, { name: 'c.mov' });
  assert.match(kept.data.note, /Invalid data found/);
  assert.ok(!kept.data.note.includes(dataDir) && !kept.data.note.includes('.incoming-'), kept.data.note);
  assert.deepEqual(leftovers(root), []);
});

test('without ffmpeg a video is kept as uploaded, with a note; a HEIC photo is refused with what to do', async (t) => {
  const { media, root, store } = library(t, { ffmpeg: NO_FFMPEG });
  assert.deepEqual(await media.ffmpeg(), { available: false });
  const doc = await media.add(SAMPLES.mov, { name: 'clip.mov' });
  assert.deepEqual([doc.data.status, doc.data.converted, doc.data.name, doc.data.type], ['ready', false, 'clip.mov', 'video/quicktime']);
  assert.match(doc.data.note, /ffmpeg isn't available, so OBS may not play it .* any location the camera recorded stays in the file/);
  await assert.rejects(media.add(SAMPLES.heic, { name: 'p.heic' }), (err) => err instanceof MediaError && err.code === 'needs-ffmpeg' && /export the photo as JPEG/.test(err.message));
  assert.deepEqual(leftovers(root), []);
  assert.equal(store.list('media').length, 1);
});

test('a failed conversion keeps the video as uploaded (losing it would be worse) and leaves nothing behind', async (t) => {
  for (const mode of ['fail', 'partial', 'empty']) {
    fake(t, mode);
    const { media, root } = library(t);
    const doc = await media.add(SAMPLES.mov, { name: 'clip.mov' });
    assert.equal(doc.data.status, 'ready', mode);
    assert.equal(doc.data.converted, false, mode);
    assert.match(doc.data.note, /converting it failed/, mode);
    assert.deepEqual(readFileSync(path.join(root, doc.data.fileId, 'clip.mov')), SAMPLES.mov, mode);
    assert.deepEqual(leftovers(root), [], mode);
    // A photo can't be shown unconverted: refused, and nothing kept.
    await assert.rejects(media.add(SAMPLES.heic, { name: 'p.heic' }), { code: 'conversion-failed' });
    assert.equal(media.list().length, 1, mode);
    assert.deepEqual(readdirSync(root).filter((n) => !n.startsWith('.')).length, 1, mode);
  }
});

test('a conversion that runs past its time limit is stopped, and the video kept as uploaded', async (t) => {
  const dir = tempDir(t);
  const logFile = path.join(dir, 'ffmpeg.log');
  fake(t, 'hang', { logFile });
  const { media, root } = library(t, { limits: { conversionMs: 500 } });
  const t0 = Date.now();
  const doc = await media.add(SAMPLES.mov, { name: 'clip.mov' });
  assert.ok(Date.now() - t0 < 5000);
  assert.match(doc.data.note, /took longer than/);
  const { pid } = conversions(logFile).find((r) => r.hang);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'the ffmpeg process is gone');
  assert.deepEqual(leftovers(root), []);
});

test('at most two conversions run at once; the rest wait their turn', async (t) => {
  const dir = tempDir(t);
  const logFile = path.join(dir, 'ffmpeg.log');
  fake(t, 'copy', { delay: 300, logFile });
  const { media } = library(t);
  // The most that ran at any one moment: a sweep over starts and ends (counting the runs that
  // overlap one run would count a run that overlaps its predecessor and its successor as three).
  const most = (runs) => {
    const events = runs.flatMap((r) => [[r.start, 1], [r.end, -1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let now = 0;
    let peak = 0;
    for (const [, step] of events) peak = Math.max(peak, (now += step));
    return peak;
  };
  const wave = async (n, mode) => {
    process.env.FAKE_FFMPEG = mode;
    const before = conversions(logFile).length;
    const docs = await Promise.all(Array.from({ length: n }, (_, i) => media.add(SAMPLES.mov, { name: `${mode}${i}.mov` })));
    return { docs, runs: conversions(logFile).slice(before) };
  };
  const first = await wave(5, 'copy');
  assert.ok(first.docs.every((d) => d.data.converted));
  assert.equal(first.runs.length, 5);
  assert.equal(most(first.runs), 2, 'two ran together, never more');
  // Failed conversions hand their slots back too: the next wave still gets two at once.
  const failed = await wave(3, 'fail');
  assert.ok(failed.docs.every((d) => !d.data.converted && /converting it failed/.test(d.data.note)));
  assert.ok(most(failed.runs) <= 2);
  const again = await wave(4, 'copy');
  assert.ok(again.docs.every((d) => d.data.converted));
  assert.equal(most(again.runs), 2, 'still two at once after failures');
});

test('an upload over the size cap, empty, interrupted, or of an unknown type keeps nothing', async (t) => {
  const { media, root, store } = library(t, { limits: { fileBytes: 1000 } });
  await assert.rejects(media.add(pad(SAMPLES.png, 2000), { name: 'big.png' }), { code: 'too-large' });
  await assert.rejects(media.add(Buffer.alloc(0), { name: 'none.png' }), { code: 'empty' });
  await assert.rejects(media.add(Buffer.from('<svg onload="alert(1)"/>'), { name: 'x.svg' }), { code: 'unsupported-type' });
  // A stream that stops halfway (a client gone mid-upload).
  const broken = new Readable({ read() {} });
  broken.push(SAMPLES.png.subarray(0, 100));
  setImmediate(() => broken.destroy());
  await assert.rejects(media.add(broken, { name: 'cut.png' }), { code: 'aborted' });
  await assert.rejects(media.add(path.join(root, 'nope.png')), { code: 'not-found' });
  assert.deepEqual(readdirSync(root), []);
  assert.equal(store.list('media').length, 0);
});

test('what an interrupted upload or conversion left is cleared at the next start', async (t) => {
  const first = library(t, { ffmpeg: NO_FFMPEG });
  for (const name of ['.incoming-1', '.work-2', '.trash-3']) mkdirSync(path.join(first.root, name));
  writeFileSync(path.join(first.root, '.incoming-4'), 'x');
  const stuck = first.store.put('media', 'med_01HZZZZZZZZZZZZZZZZZZZZZZZ', { name: 'a.mp4', fileId: 'f'.repeat(32), status: 'processing', type: 'video/mp4', kind: 'video', size: 1, createdAt: new Date().toISOString() });
  first.media.close();
  first.store.close();
  const { log, entries } = memoryLogger();
  const store = openStore({ dataDir: first.dataDir, backend: 'json', log });
  defer(t, () => store.close());
  createMediaLibrary({ dataDir: first.dataDir, store, log, ffmpeg: NO_FFMPEG });
  assert.deepEqual(readdirSync(first.root), []);
  assert.equal(entries.filter((e) => /interrupted upload/.test(e.msg)).length, 4);
  const after = store.get('media', stuck.id);
  assert.equal(after.data.status, 'failed');
  assert.match(after.data.error, /stopped while this file was being converted/);
});

test('removal: refused while something uses the file; then the file and its URL are gone', async (t) => {
  const { media, root } = library(t);
  const doc = await media.add(SAMPLES.png, { name: 'a.png' });
  assert.throws(() => media.remove(doc.id, { usedBy: (d) => (d.id === doc.id ? ['main'] : []) }), (err) => err.code === 'in-use' && /used by "main"/.test(err.message));
  assert.ok(media.file(doc.data.fileId, 'a.png'));
  media.remove(doc.id);
  assert.equal(media.file(doc.data.fileId, 'a.png'), undefined);
  assert.equal(media.get(doc.id), undefined);
  assert.deepEqual(readdirSync(root), []);
  assert.throws(() => media.remove(doc.id), { code: 'not-found' });
});

test('shutting down stops the conversion in progress and the ones waiting; their uploads are dropped', async (t) => {
  const logFile = path.join(tempDir(t), 'ffmpeg.log');
  fake(t, 'hang', { logFile });
  const { media, root, store } = library(t, { limits: { conversions: 1 } });
  const running = media.add(SAMPLES.mov, { name: 'clip.mov' });
  const queued = media.add(SAMPLES.mov, { name: 'next.mov' });
  running.catch(() => {});
  queued.catch(() => {});
  await until(() => hanging(logFile));
  assert.equal(conversions(logFile).length, 1, 'one slot: the second waits');
  const closing = media.close();
  await assert.rejects(running, { code: 'conversion-failed' });
  await assert.rejects(queued, { code: 'conversion-failed' });
  await closing;
  assert.equal(conversions(logFile).length, 1, 'the waiting one never started');
  assert.throws(() => process.kill(conversions(logFile)[0].pid, 0), { code: 'ESRCH' });
  assert.deepEqual(readdirSync(root), []);
  assert.equal(store.list('media').length, 0, 'no record left saying "processing"');
  await assert.rejects(media.add(SAMPLES.png), { code: 'closed' });
});

test('stopping the platform mid-conversion waits for it to be cleared before the store closes', async (t) => {
  const logFile = path.join(tempDir(t), 'ffmpeg.log');
  fake(t, 'hang', { logFile });
  const { platform, config } = await platformWith(t, { ffmpeg: FAKE });
  const adding = platform.media.add(SAMPLES.mov, { name: 'clip.mov' });
  adding.catch(() => {});
  await until(() => hanging(logFile));
  assert.equal(platform.media.list()[0].data.status, 'processing');
  await platform.stop();
  await assert.rejects(adding, { code: 'conversion-failed' });
  assert.throws(() => process.kill(conversions(logFile)[0].pid, 0), { code: 'ESRCH' });
  const { log } = memoryLogger();
  const store = openStore({ dataDir: config.dataDir, backend: config.store, log });
  defer(t, () => store.close());
  assert.deepEqual(store.list('media'), [], 'its record was dropped, not left for the next start');
  assert.deepEqual(readdirSync(path.join(config.dataDir, 'media')), []);
});

test('a file being converted can\'t be removed, and one a crash interrupted is marked failed at the next start', async (t) => {
  const logFile = path.join(tempDir(t), 'ffmpeg.log');
  fake(t, 'hang', { logFile });
  const first = library(t);
  const adding = first.media.add(SAMPLES.mov, { name: 'clip.mov' });
  adding.catch(() => {});
  await until(() => hanging(logFile));
  const [doc] = first.media.list();
  assert.equal(doc.data.status, 'processing');
  assert.equal(first.media.file(doc.data.fileId, doc.data.name), undefined, 'not served before it is ready');
  assert.throws(() => first.media.remove(doc.id), (err) => err.code === 'busy' && /still being converted/.test(err.message));
  // The platform dies here, mid-conversion: the next start finds the record add() wrote.
  const { log } = memoryLogger();
  const second = createMediaLibrary({ dataDir: first.dataDir, store: first.store, log, ffmpeg: FAKE, lowerPriority: false });
  defer(t, () => second.close());
  const after = first.store.get('media', doc.id);
  assert.equal(after.data.status, 'failed');
  assert.match(after.data.error, /stopped while this file was being converted\. Upload it again/);
  assert.equal(second.file(doc.data.fileId, doc.data.name), undefined);
  assert.deepEqual(leftovers(first.root), [], 'its staged upload and work directory are swept');
  // A failed record can be removed.
  second.remove(doc.id);
  assert.equal(second.get(doc.id), undefined);
});

// A platform with its own data, stopped when the test ends. env: more of its environment.
async function platformWith(t, { env = {}, ...options } = {}) {
  const root = tempDir(t);
  const config = loadConfig({ argv: ['--port', '0'], env: { SKP_DATA_DIR: path.join(root, 'data'), SKP_CONFIG_DIR: path.join(root, 'config'), ...env } });
  const { log, entries } = memoryLogger();
  const platform = await startPlatform(config, { log, ffmpeg: env.SKP_FFMPEG ? undefined : NO_FFMPEG, media: { lowerPriority: false }, ...options });
  defer(t, () => platform.stop());
  return { platform, config, entries };
}

test('GET /media/<fileId>/<name> serves the file: immutable, sandboxed, byte ranges; anything else is 404', async (t) => {
  const { platform } = await platformWith(t);
  const body = Buffer.concat([SAMPLES.webm, Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256))]);
  const doc = await platform.media.add(body, { name: 'stinger.webm' });
  const url = `${platform.url}${mediaUrl(doc)}`;
  const file = readFileSync(path.join(platform.config.dataDir, 'media', doc.data.fileId, 'stinger.webm'));
  const res = await fetch(url);
  assert.equal(res.status, 200);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), file);
  assert.equal(res.headers.get('content-type'), 'video/webm');
  assert.equal(res.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.match(res.headers.get('content-security-policy'), /^sandbox; default-src 'none'/);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(res.headers.get('accept-ranges'), 'bytes');
  assert.equal(Number(res.headers.get('content-length')), file.length);
  // A <video> seeks with byte ranges.
  const part = await fetch(url, { headers: { range: 'bytes=10-19' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), `bytes 10-19/${file.length}`);
  assert.deepEqual(Buffer.from(await part.arrayBuffer()), file.subarray(10, 20));
  const tail = await fetch(url, { headers: { range: 'bytes=-5' } });
  assert.deepEqual(Buffer.from(await tail.arrayBuffer()), file.subarray(file.length - 5));
  const past = await fetch(url, { headers: { range: `bytes=${file.length}-` } });
  assert.equal(past.status, 416);
  assert.equal(past.headers.get('content-range'), `bytes */${file.length}`);
  assert.equal(past.headers.get('cache-control'), 'no-store', 'an answer about the request, never cached as the file');
  await past.arrayBuffer();
  const head = await fetch(url, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(Number(head.headers.get('content-length')), file.length);
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  // Exactly that name, that fileId: nothing else is served.
  for (const other of [`/media/${doc.data.fileId}/STINGER.webm`, `/media/${doc.data.fileId}/other.webm`, `/media/${'0'.repeat(32)}/stinger.webm`, `/media/${doc.data.fileId}/..%2f..%2fskp.lock`, `/media/${doc.data.fileId}`, `/media/${doc.data.fileId}/stinger.webm/x`]) {
    const r = await fetch(`${platform.url}${other}`);
    assert.equal(r.status, 404, other);
    // Even the router's own errors, so a sandboxed preview can tell an error from an outage.
    assert.equal(r.headers.get('access-control-allow-origin'), '*', other);
    await r.arrayBuffer();
  }
  platform.media.remove(doc.id);
  assert.equal((await fetch(url)).status, 404);
  // A file deleted behind the platform's back (its record still there): 404, not an error.
  const gone = await platform.media.add(SAMPLES.png, { name: 'gone.png' });
  rmSync(path.join(platform.config.dataDir, 'media', gone.data.fileId), { recursive: true, force: true });
  const missing = await fetch(`${platform.url}${mediaUrl(gone)}`);
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get('access-control-allow-origin'), '*');
  await missing.arrayBuffer();
});

test('clients that leave while a file is being opened leave no file handle open behind them', async (t) => {
  const { platform } = await platformWith(t);
  const doc = await platform.media.add(Buffer.concat([SAMPLES.webm, Buffer.alloc(256 * 1024, 5)]), { name: 'clip.webm' });
  const fsp = await import('node:fs/promises');
  const { syncBuiltinESMExports } = await import('node:module');
  const { open, stat } = fsp.default;
  // A slow disk: the client is gone before the file is open (or looked at).
  const slow = (fn) => async (...a) => { await new Promise((r) => setTimeout(r, 120)); return fn(...a); };
  fsp.default.open = slow(open);
  fsp.default.stat = slow(stat);
  syncBuiltinESMExports();
  defer(t, () => { Object.assign(fsp.default, { open, stat }); syncBuiltinESMExports(); });
  const handles = () => process.getActiveResourcesInfo().filter((r) => r === 'FileHandle').length;
  const before = handles();
  const net = await import('node:net');
  const { port } = new URL(platform.url);
  await Promise.all(Array.from({ length: 10 }, () => new Promise((resolve) => {
    const socket = net.connect(Number(port), '127.0.0.1', () => {
      socket.write(`GET ${mediaUrl(doc)} HTTP/1.1\r\nHost: 127.0.0.1\r\nRange: bytes=0-\r\n\r\n`);
      setTimeout(() => { socket.destroy(); resolve(); }, 30);
    });
    socket.on('error', resolve);
  })));
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(handles(), before, 'every opened file was closed again');
  // On Windows an open handle would keep the file from being removed.
  platform.media.remove(doc.id);
  assert.equal(existsSync(path.join(platform.config.dataDir, 'media', doc.data.fileId)), false);
});

test('an overlay whose settings point to a file keeps it from being removed, including the version kept for revert', async (t) => {
  const { platform } = await platformWith(t);
  const doc = await platform.media.add(SAMPLES.png, { name: 'poster.png' });
  const url = mediaUrl(doc);
  const settings = { type: 'object', properties: { poster: { type: 'string', 'x-skp-widget': 'media' }, size: { type: 'integer', default: 1 } } };
  platform.templates.install(packTemplate(DIAG_DIR, { manifest: { id: 'dev.skp.sample', version: '1.0.0', settings } }));
  platform.templates.install(packTemplate(DIAG_DIR, { manifest: { id: 'dev.skp.sample', version: '1.1.0', settings } }));
  platform.overlays.create({ slug: 'main', template: { id: 'dev.skp.sample', version: '1.0.0' }, settings: { poster: url } });
  const fileId = doc.data.fileId;
  assert.deepEqual(platform.overlays.mediaUsers(fileId), ['main']);
  assert.deepEqual(platform.overlays.mediaUsers('f'.repeat(32)), []);
  assert.deepEqual(platform.overlays.mediaUsers('not a file id'), []);
  await platform.overlays.upgrade('main', '1.1.0');
  platform.overlays.updateSettings('main', {});
  assert.deepEqual(platform.overlays.mediaUsers(fileId), ['main'], 'revert would bring it back');
  const usedBy = (d) => platform.overlays.mediaUsers(d.data.fileId);
  assert.throws(() => platform.media.remove(doc.id, { usedBy }), { code: 'in-use' });
  // The same file by its absolute URL (a public install's own address) counts too.
  const other = await platform.media.add(SAMPLES.png, { name: 'logo.png' });
  platform.overlays.create({ slug: 'abs', template: { id: 'dev.skp.sample', version: '1.1.0' }, settings: { poster: `https://show.example.com${mediaUrl(other)}` } });
  assert.throws(() => platform.media.remove(other.id, { usedBy }), (err) => err.code === 'in-use' && /"abs"/.test(err.message));
});

test('a conversion that would outgrow the upload cap keeps the upload as it is, never a cut-off file', async (t) => {
  const dir = tempDir(t);
  const logFile = path.join(dir, 'ffmpeg.log');
  fake(t, 'grow', { logFile });
  const { media, root } = library(t, { limits: { fileBytes: 4000 } });
  const doc = await media.add(SAMPLES.mov, { name: 'clip.mov' });
  assert.equal(doc.data.converted, false);
  assert.match(doc.data.note, /larger than/);
  assert.deepEqual(readFileSync(path.join(root, doc.data.fileId, 'clip.mov')), SAMPLES.mov);
  assert.deepEqual(leftovers(root), []);
  // ffmpeg was told the cap, read and wrote only files, and was never handed a bare path.
  const { args } = conversions(logFile)[0];
  assert.equal(args[args.indexOf('-fs') + 1], '4000');
  assert.equal(args[args.indexOf('-protocol_whitelist') + 1], 'file');
  assert.ok(args[args.indexOf('-i') + 1].startsWith('file:'));
  assert.ok(args[args.length - 1].startsWith('file:'));
  // The photo route writes one image, never a numbered-file pattern ('%' in a data directory).
  const { imageArgs } = await import('../src/media/ffmpeg.js');
  const image = imageArgs('/data/50%off/in.heic', '/data/50%off/out.jpg');
  assert.deepEqual(image.slice(-5), ['-f', 'image2', '-update', '1', 'file:/data/50%off/out.jpg']);
});

test('a store that fails mid-upload leaves no file behind, and the next start removes files with no record', async (t) => {
  const dataDir = tempDir(t);
  const { log, entries } = memoryLogger();
  const store = openStore({ dataDir, backend: 'json', log });
  defer(t, () => store.close());
  let failPut = true;
  const failing = new Proxy(store, {
    get(target, key) {
      if (key === 'put') return (...a) => { if (failPut && a[0] === 'media') throw Object.assign(new Error('no space left'), { code: 'ENOSPC' }); return target.put(...a); };
      const v = target[key];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  fake(t, 'copy');
  const media = createMediaLibrary({ dataDir, store: failing, log, ffmpeg: FAKE, lowerPriority: false });
  defer(t, () => media.close());
  const root = path.join(dataDir, 'media');
  await assert.rejects(media.add(SAMPLES.png, { name: 'a.png' }), { code: 'ENOSPC' });
  await assert.rejects(media.add(SAMPLES.mov, { name: 'c.mov' }), { code: 'ENOSPC' });
  assert.deepEqual(readdirSync(root), [], 'nothing on disk without a record');
  failPut = false;
  // A file left by a crash between the rename and the record: the next start removes it.
  mkdirSync(path.join(root, 'a'.repeat(32)));
  writeFileSync(path.join(root, 'a'.repeat(32), 'x.png'), SAMPLES.png);
  // A ready record whose file is gone: logged (its URL answers 404).
  store.put('media', 'med_01HZZZZZZZZZZZZZZZZZZZZZZZ', { name: 'gone.png', fileId: 'b'.repeat(32), status: 'ready', type: 'image/png', kind: 'image', size: 1, createdAt: new Date().toISOString() });
  createMediaLibrary({ dataDir, store, log, ffmpeg: FAKE, lowerPriority: false });
  assert.deepEqual(readdirSync(root), []);
  assert.ok(entries.some((e) => /media file with no record/.test(e.msg)));
  assert.ok(entries.some((e) => /missing from the data directory/.test(e.msg) && e.context.name === 'gone.png'));
});

test('a store that can\'t be written doesn\'t stop the library opening, even with an interrupted conversion to record', (t) => {
  const dataDir = tempDir(t);
  const { log, entries } = memoryLogger();
  const store = openStore({ dataDir, backend: 'json', log });
  defer(t, () => store.close());
  store.put('media', 'med_01HZZZZZZZZZZZZZZZZZZZZZZZ', { name: 'a.mp4', fileId: 'c'.repeat(32), status: 'processing', type: 'video/mp4', kind: 'video', size: 1, createdAt: new Date().toISOString() });
  const readOnlyStore = new Proxy(store, {
    get(target, key) {
      if (key === 'put') return () => { throw Object.assign(new Error('read-only file system'), { code: 'EROFS' }); };
      const v = target[key];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  const media = createMediaLibrary({ dataDir, store: readOnlyStore, log, ffmpeg: NO_FFMPEG });
  defer(t, () => media.close());
  assert.ok(entries.some((e) => /could not mark an interrupted conversion/.test(e.msg)));
  assert.equal(media.list().length, 1);
});

test('the converted file and every staged upload are synced to disk before a record says ready (10 §10.6)', async (t) => {
  fake(t, 'copy');
  const { media } = library(t);
  const fs = await import('node:fs');
  const { syncBuiltinESMExports } = await import('node:module');
  let syncs = 0;
  const originals = { fsync: fs.default.fsync, fsyncSync: fs.default.fsyncSync };
  fs.default.fsync = (...a) => { syncs++; return originals.fsync(...a); };
  fs.default.fsyncSync = (...a) => { syncs++; return originals.fsyncSync(...a); };
  syncBuiltinESMExports();
  defer(t, () => { Object.assign(fs.default, originals); syncBuiltinESMExports(); });
  await media.add(SAMPLES.png, { name: 'a.png' });
  assert.ok(syncs >= 1, 'the staged upload');
  const before = syncs;
  await media.add(SAMPLES.mov, { name: 'c.mov' });
  assert.ok(syncs >= before + 2, 'the staged upload and the converted output');
});

async function cli(argv, env) {
  let stdout = '';
  let stderr = '';
  const code = await run(argv, { stdout: { write: (s) => { stdout += s; } }, stderr: { write: (s) => { stderr += s; } }, env });
  return { code, stdout, stderr };
}

test('skp media add, list and remove, each change in the audit log', async (t) => {
  const root = tempDir(t);
  const env = { SKP_DATA_DIR: path.join(root, 'data'), SKP_CONFIG_DIR: path.join(root, 'config'), SKP_FFMPEG: NO_FFMPEG[0] };
  const file = path.join(root, 'My Logo.png');
  writeFileSync(file, SAMPLES.png);
  const added = await cli(['media', 'add', file, '--json'], env);
  assert.equal(added.code, 0, added.stderr);
  const doc = JSON.parse(added.stdout);
  assert.equal(doc.name, 'My-Logo.png');
  assert.equal(doc.url, `/media/${doc.fileId}/My-Logo.png`);
  const named = await cli(['media', 'add', file, '--name', 'Poster.png'], env);
  assert.match(named.stdout, /added med_\w+: Poster\.png \(image\/png/);
  const list = JSON.parse((await cli(['media', 'list', '--json'], env)).stdout);
  assert.deepEqual(list.map((d) => d.name), ['Poster.png', 'My-Logo.png']);
  writeFileSync(path.join(root, 'notes.txt'), 'just text');
  const refused = await cli(['media', 'add', path.join(root, 'notes.txt')], env);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /isn't a file type overlays can use/);
  const missing = await cli(['media', 'add', path.join(root, 'nope.png'), '--json'], env);
  assert.equal(missing.code, 1);
  assert.equal(JSON.parse(missing.stdout).error, 'not-found');
  const removed = await cli(['media', 'remove', doc.id], env);
  assert.equal(removed.code, 0, removed.stderr);
  assert.equal((await cli(['media', 'remove', doc.id], env)).code, 1);
  const ops = auditOf(loadConfig({ argv: [], env }));
  assert.deepEqual(ops.map((o) => o.action), ['media.add', 'media.add', 'media.remove']);
  assert.equal(ops[0].details.url, doc.url);
  // SKP_FFMPEG names an ffmpeg that isn't there: a phone clip is kept as uploaded, and says so.
  const clip = path.join(root, 'IMG_0001.MOV');
  writeFileSync(clip, SAMPLES.mov);
  const kept = await cli(['media', 'add', clip], env);
  assert.equal(kept.code, 0, kept.stderr);
  assert.match(kept.stdout, /added med_\w+: IMG_0001\.mov \(video\/quicktime/);
  assert.match(kept.stdout, /note: Kept as uploaded: ffmpeg isn't available/);
});

test('skp media remove refuses a file an overlay uses, and names the overlay', async (t) => {
  const root = tempDir(t);
  const env = { SKP_DATA_DIR: path.join(root, 'data'), SKP_CONFIG_DIR: path.join(root, 'config'), SKP_FFMPEG: NO_FFMPEG[0] };
  const file = path.join(root, 'poster.png');
  writeFileSync(file, SAMPLES.png);
  const doc = JSON.parse((await cli(['media', 'add', file, '--json'], env)).stdout);
  const data = openData(loadConfig({ argv: [], env }), { log: memoryLogger().log, purpose: 'test' });
  try {
    const settings = { type: 'object', properties: { poster: { type: 'string', 'x-skp-widget': 'media' } } };
    data.templates.install(packTemplate(DIAG_DIR, { manifest: { id: 'dev.skp.sample', version: '1.0.0', settings } }));
    data.overlays.create({ slug: 'main', template: { id: 'dev.skp.sample', version: '1.0.0' }, settings: { poster: doc.url } });
  } finally {
    data.close();
  }
  const refused = await cli(['media', 'remove', doc.id], env);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /poster\.png is used by "main"; change it first/);
  const asJson = await cli(['media', 'remove', doc.id, '--json'], env);
  assert.equal(asJson.code, 1);
  assert.equal(JSON.parse(asJson.stdout).error, 'in-use');
  assert.equal(JSON.parse((await cli(['media', 'list', '--json'], env)).stdout).length, 1, 'still there');
  assert.ok(existsSync(path.join(root, 'data', 'media', doc.fileId, 'poster.png')));
});

test('SKP_FFMPEG chooses the ffmpeg, and whether there is one is logged when the platform starts', async (t) => {
  const { platform, entries } = await platformWith(t, { env: { SKP_FFMPEG: NO_FFMPEG[0] } });
  await until(() => entries.some((e) => /ffmpeg not found/.test(e.msg)));
  const doc = await platform.media.add(SAMPLES.mov, { name: 'clip.mov' });
  assert.match(doc.data.note, /ffmpeg isn't available/);
});

test('ffmpeg runs below normal priority (the show comes first), with its arguments exactly as given', async (t) => {
  const logFile = path.join(tempDir(t), 'ffmpeg.log');
  fake(t, 'copy', { logFile });
  // The library's default: lowered, for the stream listing and the conversion both.
  const lowered = library(t, { lowerPriority: true });
  await lowered.media.add(SAMPLES.mov, { name: 'clip.mov' });
  const runs = runsOf(logFile);
  assert.equal(runs.length, 2);
  for (const r of runs) assert.ok(r.priority >= constants.priority.PRIORITY_BELOW_NORMAL, `ran at ${r.priority}`);
  // Not lowered (what the other tests use): the platform's own priority.
  const own = getPriority();
  await library(t).media.add(SAMPLES.mov, { name: 'clip.mov' });
  for (const r of runsOf(logFile).slice(2)) assert.equal(r.priority, own);
  // An argument array, never a shell: quotes, substitutions and variables arrive as characters.
  const odd = ['-metadata', 'title=a b "c" \'d\' $(echo hi) `x` %PATH% é', '-i', 'in; rm -rf / & echo pwned'];
  await assert.rejects(runFfmpeg(FAKE, odd, { lowerPriority: false }), { code: 'failed' });
  assert.deepEqual(runsOf(logFile).at(-1).args, odd);
});

test('a missing ffmpeg, or one that prints a version and fails, is reported as unavailable, not thrown', async (t) => {
  assert.deepEqual(await probeFfmpeg(NO_FFMPEG), { available: false });
  assert.deepEqual(await probeFfmpeg(FAKE), { available: true, version: '7.1-fake', heic: true });
  await assert.rejects(runFfmpeg(NO_FFMPEG, ['-version']), { code: 'missing' });
  const saved = process.env.FAKE_FFMPEG_VERSION_EXIT;
  process.env.FAKE_FFMPEG_VERSION_EXIT = '1';
  defer(t, () => { if (saved === undefined) delete process.env.FAKE_FFMPEG_VERSION_EXIT; else process.env.FAKE_FFMPEG_VERSION_EXIT = saved; });
  assert.deepEqual(await probeFfmpeg(FAKE), { available: false });
});

// With a real ffmpeg (CI's Linux runner has one), a clip it made itself goes through end to end.
test('a real ffmpeg converts a clip to H.264 MP4', async (t) => {
  if (!(await probeFfmpeg(['ffmpeg'])).available) {
    t.skip('no ffmpeg on this machine');
    return;
  }
  const dir = tempDir(t);
  const { spawnSync } = await import('node:child_process');
  const ff = (...args) => spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
  // ffprobe comes with ffmpeg; without it nothing here could be checked, so it is required.
  const probe = (file, stream = 'v:0') => {
    const r = spawnSync('ffprobe', ['-v', 'error', '-select_streams', stream, '-show_entries', 'stream=codec_name,pix_fmt,width,height,color_transfer,channels:stream_side_data:format_tags', '-of', 'json', file], { encoding: 'utf8' });
    assert.equal(r.status, 0, `ffprobe ${file}: ${r.error?.message || r.stderr}`);
    return JSON.parse(r.stdout);
  };
  const { media, root } = library(t, { ffmpeg: ['ffmpeg'] });
  const converted = async (file) => {
    const doc = await media.add(file);
    assert.equal(doc.data.converted, true, doc.data.note);
    const out = path.join(root, doc.data.fileId, doc.data.name);
    assert.equal(readFileSync(out).toString('latin1', 4, 8), 'ftyp');
    return { out, video: probe(out) };
  };

  // A phone clip with a location: H.264, 8-bit 4:2:0, SDR, and the location gone. The input is
  // checked to have one first, or its absence afterwards would prove nothing.
  const plainClip = path.join(dir, 'in.mov');
  assert.equal(ff('-f', 'lavfi', '-i', 'testsrc=duration=1:size=320x180:rate=10', '-c:v', 'mpeg4', '-metadata', 'location=+43.6+079.4/', '-metadata', 'make=Apple', plainClip).status, 0);
  const tags = probe(plainClip).format?.tags || {};
  assert.match(tags.location || '', /43\.6/, 'the test clip carries a location');
  const { video: info } = await converted(plainClip);
  assert.equal(info.streams[0].codec_name, 'h264');
  assert.equal(info.streams[0].pix_fmt, 'yuv420p');
  assert.equal(info.streams[0].color_transfer, 'bt709');
  assert.equal(info.format?.tags?.location, undefined, 'no location metadata');
  assert.equal(info.format?.tags?.make, undefined, 'no camera metadata');

  // Filmed held upright: the rotation is baked into the frames, not left as a flag.
  const rotated = path.join(dir, 'rotated.mov');
  if (ff('-display_rotation', '90', '-i', plainClip, '-c', 'copy', rotated).status === 0) {
    const { video: r } = await converted(rotated);
    assert.deepEqual([r.streams[0].width, r.streams[0].height], [180, 320], 'turned upright');
    assert.ok(!(r.streams[0].side_data_list || []).some((s) => /Display Matrix/i.test(s.side_data_type)), 'no rotation flag left');
  } else t.diagnostic('this ffmpeg has no -display_rotation; rotation not checked');

  // Larger than 1080p, with sound, filmed upright: at most 1920 on the long side, even
  // dimensions (H.264 4:2:0 needs them), the sound kept as AAC stereo.
  const big = path.join(dir, 'big.mov');
  assert.equal(ff('-f', 'lavfi', '-i', 'testsrc=duration=1:size=2560x1440:rate=5', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:v', 'mpeg4', '-c:a', 'aac', '-ac', '1', big).status, 0);
  const bigRotated = path.join(dir, 'big-rotated.mov');
  const turned = ff('-display_rotation', '90', '-i', big, '-c', 'copy', bigRotated).status === 0;
  const { out: bigOut, video: b } = await converted(turned ? bigRotated : big);
  assert.deepEqual([b.streams[0].width, b.streams[0].height], turned ? [1080, 1920] : [1920, 1080]);
  const sound = probe(bigOut, 'a:0').streams[0];
  assert.deepEqual([sound?.codec_name, sound?.channels], ['aac', 2]);
  // Odd dimensions become even.
  const odd = path.join(dir, 'odd.mov');
  assert.equal(ff('-f', 'lavfi', '-i', 'testsrc=duration=1:size=321x181:rate=5', '-c:v', 'png', odd).status, 0);
  const { video: o } = await converted(odd);
  assert.ok(o.streams[0].width % 2 === 0 && o.streams[0].height % 2 === 0, `${o.streams[0].width}x${o.streams[0].height}`);

  // iPhone HDR (10-bit HLG): tone-mapped to SDR where the build has zscale, tagged BT.709 always.
  const hlg = path.join(dir, 'hlg.mp4');
  if (ff('-f', 'lavfi', '-i', 'testsrc=duration=1:size=320x180:rate=10', '-c:v', 'libx264', '-pix_fmt', 'yuv420p10le', '-color_primaries', 'bt2020', '-color_trc', 'arib-std-b67', '-colorspace', 'bt2020nc', hlg).status === 0) {
    const { video: h } = await converted(hlg);
    assert.equal(h.streams[0].pix_fmt, 'yuv420p');
    assert.equal(h.streams[0].color_transfer, 'bt709');
  } else t.diagnostic('this ffmpeg can\'t encode 10-bit H.264; HDR not checked');
});
