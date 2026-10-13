// Uploaded media (03 §3.4, 07 §7.11, H12): clips, images, sounds and fonts that settings,
// lineups and media.play point to, served at /media/<fileId>/<name>.
//
//   <dataDir>/media/<fileId>/<name>   the file, never changed again (its URL is immutable, H14)
//   store collection "media"          one record per file (id med_…)
//
// A fileId is 128 random bits (07 §7.6): the path can't be guessed, and nothing else protects
// it. An upload is written to a staging file under the size cap, identified by its first bytes,
// and moved into place in one rename; phone video is converted to H.264 MP4 and HEIC photos to
// JPEG first, at most two conversions at a time. Without ffmpeg (or when a conversion fails), a
// video is kept as uploaded, with a note that OBS may not play it: losing the upload would be
// worse. Startup removes what an interrupted upload left.
import { randomBytes } from 'node:crypto';
import { closeSync, createReadStream, createWriteStream, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { renameRetrying } from '../fsutil.js';
import { newId } from '../ids.js';
import { ffmpegCommand, FfmpegError, imageArgs, inspect, probeFfmpeg, runFfmpeg, videoArgs } from './ffmpeg.js';
import { SNIFF_BYTES, sniff } from './sniff.js';

export const MEDIA_LIMITS = Object.freeze({
  fileBytes: 600 * 1024 * 1024, // 07 §7.11
  conversions: 2, // at once (07 §7.11)
  conversionMs: 15 * 60 * 1000, // a 600 MiB phone clip at veryfast on a small machine
});
const NAME_CHARS = 100;
const CLOSE_WAIT_MS = 10000;

export class MediaError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'MediaError';
    this.code = code;
  }
}

// A file name that is safe in a URL path segment and on every OS: letters, digits, ".", "_" and
// "-", not starting with a dot; its extension is the one its content has.
export function mediaName(original, ext) {
  const base = path.basename(String(original || '')).replace(/\.[^.]*$/, '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '') // é → e
    .replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, NAME_CHARS - ext.length - 1);
  return `${base || 'file'}.${ext}`;
}

export const mediaUrl = (doc) => `/media/${doc.data.fileId}/${doc.data.name}`;

// fsync, so a record never says ready for bytes still in the OS's cache (10 §10.6).
function syncFile(file) {
  const fd = openSync(file, 'r+');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

// Makes a directory's entries durable. POSIX only: Windows can't open a directory to sync it.
function syncDir(dir) {
  if (process.platform === 'win32') return;
  let fd;
  try {
    fd = openSync(dir, 'r');
    fsyncSync(fd);
  } catch {
    // Some filesystems refuse to sync a directory; the file itself is synced.
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// lowerPriority: false runs ffmpeg at normal priority (tests only).
export function createMediaLibrary({ dataDir, store, log, ffmpeg = 'ffmpeg', limits = {}, readOnly = false, lowerPriority = true }) {
  const max = { ...MEDIA_LIMITS, ...limits };
  const root = path.join(dataDir, 'media');
  const command = ffmpegCommand(ffmpeg);
  const byFileId = new Map(); // fileId → record
  const running = new Set(); // { abort } of conversions in progress
  const waiting = []; // resolvers for a conversion slot
  const adding = new Set(); // add() promises not yet settled
  let active = 0;
  let closed = false;
  let probe;

  if (!readOnly) {
    mkdirSync(root, { recursive: true });
    for (const name of readdirSync(root)) {
      if (!name.startsWith('.incoming-') && !name.startsWith('.work-') && !name.startsWith('.trash-')) continue;
      try {
        rmSync(path.join(root, name), { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
        log.info('removed what an interrupted upload left', { file: name });
      } catch (err) {
        log.warn('could not remove what an interrupted upload left', { file: name, err: err.message });
      }
    }
  }
  for (const doc of all()) {
    byFileId.set(doc.data.fileId, doc);
    if (readOnly) continue;
    // A conversion the last run didn't finish: its upload was in staging, now swept. Recording
    // that is bookkeeping: a store that can't be written now must not stop the platform starting.
    if (doc.data.status === 'processing') {
      try {
        byFileId.set(doc.data.fileId, store.put('media', doc.id, { ...doc.data, status: 'failed', error: 'The platform stopped while this file was being converted. Upload it again.' }));
      } catch (err) {
        log.warn('could not mark an interrupted conversion as failed', { id: doc.id, err: err.message });
      }
    } else if (doc.data.status === 'ready' && !existsSync(path.join(root, doc.data.fileId, doc.data.name))) {
      log.warn('a media file is missing from the data directory; its URL answers 404', { id: doc.id, name: doc.data.name });
    }
  }
  // A file whose record was never written (the store failed mid-upload) is nobody's: removed.
  if (!readOnly) {
    for (const name of readdirSync(root)) {
      if (!/^[0-9a-f]{32}$/.test(name) || byFileId.has(name)) continue;
      try {
        rmSync(path.join(root, name), { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
        log.info('removed a media file with no record', { fileId: name });
      } catch (err) {
        log.warn('could not remove a media file with no record', { fileId: name, err: err.message });
      }
    }
  }

  function* all() {
    for (let after = ''; ;) {
      const page = store.list('media', { after, limit: 1000 });
      yield* page;
      if (page.length < 1000) break;
      after = page[page.length - 1].id;
    }
  }

  // ffmpeg is looked for once, when first needed (or asked about).
  function ffmpegInfo() {
    probe ??= probeFfmpeg(command).then((info) => {
      log.info(info.available ? 'ffmpeg found; phone video will be converted' : 'ffmpeg not found; uploads are kept as they are (OBS may not play phone video)', info);
      return info;
    });
    return probe;
  }

  async function slot() {
    if (active < max.conversions) { active++; return; }
    await new Promise((resolve) => waiting.push(resolve));
  }

  function release() {
    const next = waiting.shift();
    if (next) next(); // the slot passes straight to the next conversion
    else active--;
  }

  // Copies the upload to a staging file, refusing more than the cap: a path, a Buffer or a
  // readable stream (an HTTP request body, later). Returns its path and size.
  async function stage(input) {
    const staging = path.join(root, `.incoming-${randomBytes(8).toString('hex')}`);
    let size = 0;
    const cap = new Transform({
      transform(chunk, _enc, done) {
        size += chunk.length;
        if (size > max.fileBytes) done(new MediaError(`The file is larger than ${Math.round(max.fileBytes / 1024 / 1024)} MiB.`, 'too-large'));
        else done(null, chunk);
      },
    });
    const source = Buffer.isBuffer(input) ? Readable.from([input]) : typeof input === 'string' ? createReadStream(input) : input;
    try {
      // flush: synced to disk when the stream closes (10 §10.6), before any record says ready.
      await pipeline(source, cap, createWriteStream(staging, { flags: 'wx', mode: 0o644, flush: true }));
    } catch (err) {
      rmSync(staging, { force: true });
      if (err instanceof MediaError) throw err;
      if (err.code === 'ENOENT' && typeof input === 'string') throw new MediaError(`There is no file ${input}.`, 'not-found');
      if (err.code === 'ERR_STREAM_PREMATURE_CLOSE' || err.code === 'ECONNRESET' || err.code === 'ABORT_ERR') throw new MediaError('The upload was interrupted; nothing was kept.', 'aborted');
      throw new MediaError(`The upload could not be written (${err.code || err.message}).`, 'write-failed');
    }
    if (size === 0) {
      rmSync(staging, { force: true });
      throw new MediaError('The file is empty.', 'empty');
    }
    return { staging, size };
  }

  function head(file) {
    const fd = openSync(file, 'r');
    try {
      const buf = Buffer.alloc(SNIFF_BYTES);
      return buf.subarray(0, readSync(fd, buf, 0, SNIFF_BYTES, 0));
    } finally {
      closeSync(fd);
    }
  }

  // Moves a finished (synced) file into <root>/<fileId>/<name> in one rename, and makes the
  // rename durable.
  function place(from, fileId, name) {
    const dir = path.join(root, fileId);
    mkdirSync(dir, { recursive: true });
    renameRetrying(from, path.join(dir, name));
    syncDir(dir);
    syncDir(root);
  }

  // Undoes place() when the record that would point at the file can't be written.
  function unplace(fileId) {
    try { rmSync(path.join(root, fileId), { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } catch { /* the next start removes it */ }
  }

  // Converts staging → a file in a work directory: { output } (its path), or { audio: true } for
  // an MP4 that turns out to hold only sound (kept as it is), or { empty: true } for one with
  // neither. The work directory is removed by the caller.
  async function convert(kind, staging, work) {
    const output = path.join(work, kind === 'video' ? 'out.mp4' : 'out.jpg');
    const jobs = [];
    const run = (args) => runFfmpeg(command, args, { timeoutMs: max.conversionMs, lowerPriority, onStart: (j) => { jobs.push(j); running.add(j); } });
    await slot();
    try {
      if (closed) throw new FfmpegError('ffmpeg was stopped (the platform is shutting down).', 'aborted');
      if (kind === 'image') {
        await run(imageArgs(staging, output));
      } else {
        const streams = await inspect(command, staging, { lowerPriority, onStart: (j) => { jobs.push(j); running.add(j); } });
        if (!streams.video) return streams.audio ? { audio: true } : { empty: true };
        const opts = { maxBytes: max.fileBytes, hdr: streams.hdr };
        try {
          await run(videoArgs(staging, output, opts));
        } catch (err) {
          // A build without zscale can't tone-map HDR: convert without it (flatter colours,
          // still playable) rather than not at all.
          if (!(streams.hdr && err.code === 'failed' && /zscale|tonemap/i.test(err.message))) throw err;
          log.warn('this ffmpeg can\'t tone-map HDR video (no zscale filter); converting without it');
          rmSync(output, { force: true });
          await run(videoArgs(staging, output, { ...opts, tonemap: false }));
        }
      }
    } finally {
      for (const j of jobs) running.delete(j);
      release();
    }
    const size = existsSync(output) ? statSync(output).size : 0;
    if (size === 0) throw new FfmpegError('ffmpeg finished without writing a file.', 'failed');
    // ffmpeg stops at the cap (-fs) and calls that success: a cut-off file is no conversion.
    if (size > max.fileBytes) throw new FfmpegError(`the converted file would be larger than ${Math.round(max.fileBytes / 1024 / 1024)} MiB`, 'too-large');
    syncFile(output);
    return { output };
  }

  // ffmpeg's messages name the staging and work paths: an operator needs neither.
  const plain = (message) => String(message).split(root + path.sep).join('').replace(/(file:)?[^\s:]*\.(incoming|work)-[0-9a-f]+[^\s:]*/g, 'the upload');

  // Adds a file. input: a path, a Buffer or a readable stream; name: what it was called (for its
  // URL); actor: who added it. Resolves with the record once the file is ready (or kept as
  // uploaded); rejects with MediaError when nothing was kept.
  function add(input, options) {
    const job = addNow(input, options);
    adding.add(job);
    const done = () => adding.delete(job);
    job.then(done, done);
    return job;
  }

  async function addNow(input, { name, actor = 'cli' } = {}) {
    if (readOnly) throw new MediaError('Media can\'t be added here: another process holds the data directory.', 'read-only');
    if (closed) throw new MediaError('The platform is shutting down.', 'closed');
    const { staging, size } = await stage(input);
    if (closed) {
      rmSync(staging, { force: true });
      throw new MediaError('The platform is shutting down; the upload was dropped.', 'closed');
    }
    const what = sniff(head(staging));
    if (!what) {
      rmSync(staging, { force: true });
      throw new MediaError('This isn\'t a file type overlays can use. Upload an image (PNG, JPEG, GIF, WebP, AVIF, HEIC), a video (MP4, MOV, WebM, MKV), audio (MP3, M4A, Ogg, FLAC, WAV) or a font (WOFF2, WOFF, TTF, OTF).', 'unsupported-type');
    }
    const originalName = typeof input === 'string' && !name ? path.basename(input) : name || 'upload';
    const id = newId('med');
    const fileId = randomBytes(16).toString('hex');
    const record = {
      name: mediaName(originalName, what.ext),
      fileId,
      type: what.type,
      kind: what.kind,
      size,
      status: 'ready',
      converted: false,
      original: { name: String(originalName).slice(0, 255), type: what.type, size },
      createdAt: new Date().toISOString(),
      actor,
    };
    if (!what.convert) return keep(staging, id, record);

    const info = await ffmpegInfo();
    if (what.convert === 'image' && !info.heic) {
      rmSync(staging, { force: true });
      const need = info.available ? `ffmpeg 7.1 or later to be converted for browsers (this one is ${info.version})` : 'ffmpeg 7.1 or later to be converted for browsers. Install it (or set SKP_FFMPEG)';
      throw new MediaError(`HEIC photos need ${need}, or export the photo as JPEG.`, 'needs-ffmpeg');
    }
    if (!info.available) return keep(staging, id, { ...record, note: KEPT('ffmpeg isn\'t available') });

    const target = what.convert === 'video' ? { type: 'video/mp4', ext: 'mp4' } : { type: 'image/jpeg', ext: 'jpg' };
    const converted = { ...record, name: mediaName(originalName, target.ext), type: target.type, converted: true };
    try {
      save(id, { ...converted, status: 'processing' });
    } catch (err) {
      rmSync(staging, { force: true });
      throw err;
    }
    const work = path.join(root, `.work-${randomBytes(8).toString('hex')}`);
    mkdirSync(work);
    let output;
    try {
      const result = await convert(what.convert, staging, work);
      if (!result.output) {
        rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
        if (result.audio) {
          // An MP4 with only sound (an .m4a by another name): kept as audio, no conversion.
          return keep(staging, id, { ...record, name: mediaName(originalName, 'm4a'), type: 'audio/mp4', kind: 'audio', original: { ...record.original, type: 'audio/mp4' } });
        }
        rmSync(staging, { force: true });
        forget(id, fileId);
        throw new MediaError('This file has no picture or sound that ffmpeg can read.', 'unsupported-type');
      }
      output = result.output;
    } catch (err) {
      rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      if (err instanceof MediaError) throw err;
      const message = err instanceof FfmpegError ? plain(err.message) : err.message;
      if (err instanceof FfmpegError) log.warn('media conversion failed', { id, code: err.code, err: message });
      // A photo can't be shown unconverted, and an upload interrupted by shutdown is dropped;
      // a video is kept as uploaded rather than lost.
      if (!(err instanceof FfmpegError) || err.code === 'aborted' || what.convert === 'image') {
        rmSync(staging, { force: true });
        forget(id, fileId);
        if (!(err instanceof FfmpegError)) throw err;
        const advice = what.convert === 'image' ? ' (or export the photo as JPEG)' : '';
        throw new MediaError(`${what.convert === 'image' ? 'The photo' : 'The video'} could not be converted: ${message}${advice}.`, 'conversion-failed');
      }
      return keep(staging, id, { ...record, note: KEPT(`converting it failed: ${message}`) });
    }
    try {
      const outSize = statSync(output).size;
      place(output, fileId, converted.name);
      const doc = save(id, { ...converted, size: outSize, status: 'ready' });
      rmSync(staging, { force: true });
      log.info('media converted', { id, from: what.type, to: target.type, bytes: outSize });
      return doc;
    } catch (err) {
      unplace(fileId);
      rmSync(staging, { force: true });
      forget(id, fileId);
      throw err;
    } finally {
      rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  }

  // The note on a video kept as uploaded. Its metadata (where a phone filmed it) is kept too.
  const KEPT = (why) => `Kept as uploaded: ${why}, so OBS may not play it (H12), and any location the camera recorded stays in the file. Install ffmpeg, or upload H.264 MP4 or WebM.`;

  // Places a staged upload as it is and records it; nothing is left behind if the record can't
  // be written.
  function keep(staging, id, record) {
    try {
      place(staging, record.fileId, record.name);
      return save(id, record);
    } catch (err) {
      unplace(record.fileId);
      rmSync(staging, { force: true });
      forget(id, record.fileId);
      throw err;
    }
  }

  function save(id, record) {
    const doc = store.put('media', id, record);
    byFileId.set(record.fileId, doc);
    return doc;
  }

  // Drops a record that never became a file (the next start marks it failed if this can't).
  function forget(id, fileId) {
    byFileId.delete(fileId);
    try { store.delete('media', id); } catch (err) { log.warn('could not remove the record of a failed upload', { id, err: err.message }); }
  }

  return {
    add,
    get: (id) => store.get('media', id),
    // Newest first.
    list: () => [...all()].sort((a, b) => (a.data.createdAt < b.data.createdAt ? 1 : a.data.createdAt > b.data.createdAt ? -1 : 0)),
    ffmpeg: ffmpegInfo,
    // The file at /media/<fileId>/<name>: { doc, file } when it is ready and named exactly so.
    file(fileId, name) {
      const doc = byFileId.get(fileId);
      if (!doc || doc.data.status !== 'ready' || doc.data.name !== name) return undefined;
      return { doc, file: path.join(root, fileId, name) };
    },
    // Removes a file. usedBy(doc) → names of what points to it: any, and nothing is removed. The
    // record goes first (the URL answers 404 at once); a directory that can't be deleted now is
    // removed at the next start, since no record names it.
    remove(id, { usedBy = () => [] } = {}) {
      if (readOnly) throw new MediaError('Media can\'t be removed here: another process holds the data directory.', 'read-only');
      const doc = store.get('media', id);
      if (!doc) throw new MediaError(`There is no media file ${id}.`, 'not-found');
      if (doc.data.status === 'processing') throw new MediaError(`${doc.data.name} is still being converted; remove it once that is done.`, 'busy');
      const users = usedBy(doc);
      if (users.length) throw new MediaError(`${doc.data.name} is used by ${users.map((u) => `"${u}"`).join(', ')}; change ${users.length === 1 ? 'it' : 'them'} first.`, 'in-use');
      store.delete('media', id);
      byFileId.delete(doc.data.fileId);
      const dir = path.join(root, doc.data.fileId);
      if (existsSync(dir)) {
        // Renamed aside first, so a half-deleted file is never served.
        try {
          const aside = path.join(root, `.trash-${randomBytes(8).toString('hex')}`);
          renameRetrying(dir, aside);
          rmSync(aside, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
        } catch (err) {
          log.warn('a removed media file is still in use on disk; it is deleted at the next start', { id, err: err.message });
        }
      }
      log.info('media removed', { id, name: doc.data.name });
      return doc;
    },
    // Stops conversions in progress (their uploads are dropped) and refuses new ones. Resolves
    // once every add in progress has finished with the store (its record written or dropped), so
    // the store can be closed after it; at most CLOSE_WAIT_MS, for an upload that never ends.
    close() {
      closed = true;
      for (const job of running) job.abort();
      for (const next of waiting.splice(0)) next();
      let timer;
      const bound = new Promise((resolve) => { timer = setTimeout(resolve, CLOSE_WAIT_MS); timer.unref?.(); });
      return Promise.race([Promise.allSettled([...adding]), bound]).then(() => clearTimeout(timer));
    },
  };
}
