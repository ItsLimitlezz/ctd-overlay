// Uploaded media (03 §3.4, 07 §7.11, H12): what is accepted, how phone video is converted, the
// limits on conversions, and how files are served.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { startPlatform } from '../src/app.js';
import { run } from '../src/cli.js';
import { loadConfig } from '../src/config.js';
import { probeFfmpeg, runFfmpeg } from '../src/media/ffmpeg.js';
import { createMediaLibrary, MediaError, mediaName, mediaUrl } from '../src/media/library.js';
import { parseRange } from '../src/media/routes.js';
import { sniff } from '../src/media/sniff.js';
import { openStore } from '../src/store/index.js';
import { validateSettings } from '../src/templates/settings.js';
import { defer, DIAG_DIR, memoryLogger, packTemplate, tempDir } from './helpers.js';

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

// A library on its own store and data directory, closed when the test ends.
function library(t, { ffmpeg = FAKE, limits, dataDir = tempDir(t) } = {}) {
  const { log, entries } = memoryLogger();
  const store = openStore({ dataDir, backend: 'json', log });
  const media = createMediaLibrary({ dataDir, store, log, ffmpeg, limits });
  defer(t, () => { media.close(); store.close(); });
  return { media, store, log, entries, dataDir, root: path.join(dataDir, 'media') };
}

const leftovers = (root) => readdirSync(root).filter((n) => n.startsWith('.'));

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
  const [call] = readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const args = call.args.join(' ');
  for (const want of ['-c:v libx264', '-pix_fmt yuv420p', '-c:a aac', '-map_metadata -1', '-movflags +faststart', '-nostdin']) assert.ok(args.includes(want), `${want} in ${args}`);
  assert.ok(!call.args.includes('-noautorotate'), 'ffmpeg rotates on decode by default; that must stay on');
  assert.deepEqual(leftovers(root), [], 'no staging or work directories left');
  // HEIC photos become JPEG.
  const photo = await media.add(SAMPLES.heic, { name: 'IMG_0043.HEIC' });
  assert.deepEqual([photo.data.name, photo.data.type, photo.data.converted], ['IMG_0043.jpg', 'image/jpeg', true]);
});

test('without ffmpeg a video is kept as uploaded, with a note; a HEIC photo is refused with what to do', async (t) => {
  const { media, root, store } = library(t, { ffmpeg: NO_FFMPEG });
  assert.deepEqual(await media.ffmpeg(), { available: false });
  const doc = await media.add(SAMPLES.mov, { name: 'clip.mov' });
  assert.deepEqual([doc.data.status, doc.data.converted, doc.data.name, doc.data.type], ['ready', false, 'clip.mov', 'video/quicktime']);
  assert.match(doc.data.note, /ffmpeg isn't available, so OBS may not play this video/);
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
  const { pid } = JSON.parse(readFileSync(logFile, 'utf8').trim());
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'the ffmpeg process is gone');
  assert.deepEqual(leftovers(root), []);
});

test('at most two conversions run at once; the rest wait their turn', async (t) => {
  const dir = tempDir(t);
  const logFile = path.join(dir, 'ffmpeg.log');
  fake(t, 'copy', { delay: 300, logFile });
  const { media } = library(t);
  const docs = await Promise.all([1, 2, 3, 4, 5].map((n) => media.add(SAMPLES.mov, { name: `c${n}.mov` })));
  assert.ok(docs.every((d) => d.data.converted));
  const runs = readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(runs.length, 5);
  let most = 0;
  for (const r of runs) most = Math.max(most, runs.filter((o) => o.start < r.end && r.start < o.end).length);
  assert.ok(most <= 2, `${most} ran at once`);
  assert.ok(most === 2, 'two did run together');
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
  assert.throws(() => media.remove(doc.id, { usedBy: (url) => (url === mediaUrl(doc) ? ['main'] : []) }), (err) => err.code === 'in-use' && /used by "main"/.test(err.message));
  assert.ok(media.file(doc.data.fileId, 'a.png'));
  media.remove(doc.id);
  assert.equal(media.file(doc.data.fileId, 'a.png'), undefined);
  assert.equal(media.get(doc.id), undefined);
  assert.deepEqual(readdirSync(root), []);
  assert.throws(() => media.remove(doc.id), { code: 'not-found' });
});

test('shutting down stops a conversion in progress, and its upload is dropped', async (t) => {
  fake(t, 'hang');
  const { media, root } = library(t);
  const adding = media.add(SAMPLES.mov, { name: 'clip.mov' });
  await new Promise((r) => setTimeout(r, 300));
  media.close();
  await assert.rejects(adding, { code: 'conversion-failed' });
  assert.deepEqual(readdirSync(root), []);
  await assert.rejects(media.add(SAMPLES.png), { code: 'closed' });
});

// A platform with its own data, stopped when the test ends.
async function platformWith(t, options = {}) {
  const root = tempDir(t);
  const config = loadConfig({ argv: ['--port', '0'], env: { SKP_DATA_DIR: path.join(root, 'data'), SKP_CONFIG_DIR: path.join(root, 'config') } });
  const { log } = memoryLogger();
  const platform = await startPlatform(config, { log, ffmpeg: NO_FFMPEG, ...options });
  defer(t, () => platform.stop());
  return { platform, config };
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
  await past.arrayBuffer();
  const head = await fetch(url, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(Number(head.headers.get('content-length')), file.length);
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  // Exactly that name, that fileId: nothing else is served.
  for (const other of [`/media/${doc.data.fileId}/STINGER.webm`, `/media/${doc.data.fileId}/other.webm`, `/media/${'0'.repeat(32)}/stinger.webm`, `/media/${doc.data.fileId}/..%2f..%2fskp.lock`, `/media/${doc.data.fileId}`]) {
    const r = await fetch(`${platform.url}${other}`);
    assert.equal(r.status, 404, other);
    await r.arrayBuffer();
  }
  platform.media.remove(doc.id);
  assert.equal((await fetch(url)).status, 404);
});

test('an overlay whose settings point to a file keeps it from being removed, including the version kept for revert', async (t) => {
  const { platform } = await platformWith(t);
  const doc = await platform.media.add(SAMPLES.png, { name: 'poster.png' });
  const url = mediaUrl(doc);
  const settings = { type: 'object', properties: { poster: { type: 'string', 'x-skp-widget': 'media' }, size: { type: 'integer', default: 1 } } };
  platform.templates.install(packTemplate(DIAG_DIR, { manifest: { id: 'dev.skp.sample', version: '1.0.0', settings } }));
  platform.templates.install(packTemplate(DIAG_DIR, { manifest: { id: 'dev.skp.sample', version: '1.1.0', settings } }));
  platform.overlays.create({ slug: 'main', template: { id: 'dev.skp.sample', version: '1.0.0' }, settings: { poster: url } });
  assert.deepEqual(platform.overlays.mediaUsers(url), ['main']);
  assert.deepEqual(platform.overlays.mediaUsers(`${url}x`), [], 'the whole URL, not a prefix');
  await platform.overlays.upgrade('main', '1.1.0');
  platform.overlays.updateSettings('main', {});
  assert.deepEqual(platform.overlays.mediaUsers(url), ['main'], 'revert would bring it back');
  assert.throws(() => platform.media.remove(doc.id, { usedBy: (u) => platform.overlays.mediaUsers(u) }), { code: 'in-use' });
});

async function cli(argv, env) {
  let stdout = '';
  let stderr = '';
  const code = await run(argv, { stdout: { write: (s) => { stdout += s; } }, stderr: { write: (s) => { stderr += s; } }, env });
  return { code, stdout, stderr };
}

test('skp media add, list and remove, each change in operations.log', async (t) => {
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
  const ops = readFileSync(path.join(root, 'data', 'operations.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(ops.map((o) => o.op), ['media add', 'media add', 'media remove']);
  assert.equal(ops[0].url, doc.url);
});

test('ffmpeg is run with an argument array, at lowered priority, and a missing one is reported, not thrown', async () => {
  assert.deepEqual(await probeFfmpeg(NO_FFMPEG), { available: false });
  assert.equal((await probeFfmpeg(FAKE)).available, true);
  await assert.rejects(runFfmpeg(NO_FFMPEG, ['-version']), { code: 'missing' });
  // Shell metacharacters in an argument are just characters.
  await assert.rejects(runFfmpeg(FAKE, ['-i', 'nothing; echo pwned', 'out']), { code: 'failed' });
});

// With a real ffmpeg (CI's Linux runner has one), a clip it made itself goes through end to end.
test('a real ffmpeg converts a clip to H.264 MP4', async (t) => {
  if (!(await probeFfmpeg(['ffmpeg'])).available) {
    t.skip('no ffmpeg on this machine');
    return;
  }
  const dir = tempDir(t);
  const input = path.join(dir, 'in.mov');
  const { spawnSync } = await import('node:child_process');
  const made = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=1:size=320x180:rate=10', '-c:v', 'mpeg4', '-metadata', 'location=+43.6+079.4/', input]);
  assert.equal(made.status, 0, String(made.stderr));
  const { media, root } = library(t, { ffmpeg: ['ffmpeg'] });
  const doc = await media.add(input);
  assert.equal(doc.data.converted, true, doc.data.note);
  const out = readFileSync(path.join(root, doc.data.fileId, doc.data.name));
  assert.equal(out.toString('latin1', 4, 8), 'ftyp');
  const probe = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,pix_fmt:format_tags', '-of', 'json', path.join(root, doc.data.fileId, doc.data.name)], { encoding: 'utf8' });
  if (probe.status === 0) {
    const info = JSON.parse(probe.stdout);
    assert.equal(info.streams[0].codec_name, 'h264');
    assert.equal(info.streams[0].pix_fmt, 'yuv420p');
    assert.equal(info.format?.tags?.location, undefined, 'no location metadata');
  }
});
