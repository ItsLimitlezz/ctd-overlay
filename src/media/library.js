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
import { createReadStream, createWriteStream, existsSync, mkdirSync, openSync, readdirSync, readSync, closeSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { renameRetrying } from '../fsutil.js';
import { newId } from '../ids.js';
import { ffmpegCommand, FfmpegError, imageArgs, probeFfmpeg, runFfmpeg, videoArgs } from './ffmpeg.js';
import { SNIFF_BYTES, sniff } from './sniff.js';

export const MEDIA_LIMITS = Object.freeze({
  fileBytes: 600 * 1024 * 1024, // 07 §7.11
  conversions: 2, // at once (07 §7.11)
  conversionMs: 15 * 60 * 1000, // a 600 MiB phone clip at veryfast on a small machine
});
const NAME_CHARS = 100;

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

export function createMediaLibrary({ dataDir, store, log, ffmpeg = 'ffmpeg', limits = {}, readOnly = false }) {
  const max = { ...MEDIA_LIMITS, ...limits };
  const root = path.join(dataDir, 'media');
  const command = ffmpegCommand(ffmpeg);
  const byFileId = new Map(); // fileId → record
  const running = new Set(); // { abort } of conversions in progress
  const waiting = []; // resolvers for a conversion slot
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
    // A conversion the last run didn't finish: its upload was in staging, now swept.
    if (doc.data.status === 'processing' && !readOnly) {
      const failed = store.put('media', doc.id, { ...doc.data, status: 'failed', error: 'The platform stopped while this file was being converted. Upload it again.' });
      byFileId.set(failed.data.fileId, failed);
    } else {
      byFileId.set(doc.data.fileId, doc);
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
      await pipeline(source, cap, createWriteStream(staging, { flags: 'wx', mode: 0o644 }));
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

  // Moves a finished file into <root>/<fileId>/<name> in one rename.
  function place(from, fileId, name) {
    const dir = path.join(root, fileId);
    mkdirSync(dir, { recursive: true });
    renameRetrying(from, path.join(dir, name));
  }

  // Converts staging → a file in a work directory; returns its path. The work directory is
  // removed by the caller.
  async function convert(kind, staging, work) {
    const output = path.join(work, kind === 'video' ? 'out.mp4' : 'out.jpg');
    const args = kind === 'video' ? videoArgs(staging, output) : imageArgs(staging, output);
    await slot();
    let job;
    try {
      if (closed) throw new FfmpegError('ffmpeg was stopped (the platform is shutting down).', 'aborted');
      await runFfmpeg(command, args, { timeoutMs: max.conversionMs, onStart: (j) => { job = j; running.add(j); } });
    } finally {
      if (job) running.delete(job);
      release();
    }
    if (!existsSync(output) || statSync(output).size === 0) throw new FfmpegError('ffmpeg finished without writing a file.', 'failed');
    return output;
  }

  // Adds a file. input: a path, a Buffer or a readable stream; name: what it was called (for its
  // URL); actor: who added it. Resolves with the record once the file is ready (or kept as
  // uploaded); rejects with MediaError when nothing was kept.
  async function add(input, { name, actor = 'cli' } = {}) {
    if (readOnly) throw new MediaError('Media can\'t be added here: another process holds the data directory.', 'read-only');
    if (closed) throw new MediaError('The platform is shutting down.', 'closed');
    const { staging, size } = await stage(input);
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
    if (!what.convert) {
      place(staging, fileId, record.name);
      return save(id, record);
    }

    const ffmpegHere = (await ffmpegInfo()).available;
    if (!ffmpegHere && what.convert === 'image') {
      rmSync(staging, { force: true });
      throw new MediaError('HEIC photos need ffmpeg to be converted for browsers. Install ffmpeg (or set SKP_FFMPEG), or export the photo as JPEG.', 'needs-ffmpeg');
    }
    if (!ffmpegHere) {
      place(staging, fileId, record.name);
      return save(id, { ...record, note: 'Kept as uploaded: ffmpeg isn\'t available, so OBS may not play this video (H12). Install ffmpeg, or upload H.264 MP4 or WebM.' });
    }

    const target = what.convert === 'video' ? { type: 'video/mp4', ext: 'mp4' } : { type: 'image/jpeg', ext: 'jpg' };
    const converted = { ...record, name: mediaName(originalName, target.ext), type: target.type, converted: true };
    save(id, { ...converted, status: 'processing' });
    const work = path.join(root, `.work-${randomBytes(8).toString('hex')}`);
    mkdirSync(work);
    try {
      const output = await convert(what.convert, staging, work);
      const outSize = statSync(output).size;
      place(output, fileId, converted.name);
      rmSync(staging, { force: true });
      log.info('media converted', { id, from: what.type, to: target.type, bytes: outSize });
      return save(id, { ...converted, size: outSize, status: 'ready' });
    } catch (err) {
      if (!(err instanceof FfmpegError)) {
        rmSync(staging, { force: true });
        store.delete('media', id);
        byFileId.delete(fileId);
        throw err;
      }
      log.warn('media conversion failed', { id, code: err.code, err: err.message });
      if (err.code === 'aborted' || what.convert === 'image') {
        rmSync(staging, { force: true });
        store.delete('media', id);
        byFileId.delete(fileId);
        throw new MediaError(`${what.convert === 'image' ? 'The photo' : 'The video'} could not be converted: ${err.message}`, 'conversion-failed');
      }
      // A video is kept as uploaded rather than lost.
      place(staging, fileId, record.name);
      return save(id, { ...record, note: `Kept as uploaded: converting it failed (${err.message}), so OBS may not play it (H12).` });
    } finally {
      rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  }

  function save(id, record) {
    const doc = store.put('media', id, record);
    byFileId.set(record.fileId, doc);
    return doc;
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
    // Removes a file. usedBy(url) → names of what points to it: any, and nothing is removed.
    remove(id, { usedBy = () => [] } = {}) {
      if (readOnly) throw new MediaError('Media can\'t be removed here: another process holds the data directory.', 'read-only');
      const doc = store.get('media', id);
      if (!doc) throw new MediaError(`There is no media file ${id}.`, 'not-found');
      if (doc.data.status === 'processing') throw new MediaError(`${doc.data.name} is still being converted; remove it once that is done.`, 'busy');
      const users = usedBy(mediaUrl(doc));
      if (users.length) throw new MediaError(`${doc.data.name} is used by ${users.map((u) => `"${u}"`).join(', ')}; change ${users.length === 1 ? 'it' : 'them'} first.`, 'in-use');
      const dir = path.join(root, doc.data.fileId);
      if (existsSync(dir)) {
        // Renamed aside first, so a half-deleted file is never served.
        const aside = path.join(root, `.trash-${randomBytes(8).toString('hex')}`);
        renameRetrying(dir, aside);
        rmSync(aside, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      }
      store.delete('media', id);
      byFileId.delete(doc.data.fileId);
      log.info('media removed', { id, name: doc.data.name });
      return doc;
    },
    // Stops conversions in progress (their uploads are dropped) and refuses new ones.
    close() {
      closed = true;
      for (const job of running) job.abort();
      for (const next of waiting.splice(0)) next();
    },
  };
}
