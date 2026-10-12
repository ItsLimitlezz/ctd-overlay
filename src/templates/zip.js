// ZIP archives (.skp template packages, 04 §4.1), read and written with node:zlib alone.
//
// The reader trusts nothing in the archive. It works from the central directory, checks every
// entry's local header against it, and refuses what a template package never needs and an attack
// relies on:
//   - names that escape the package or don't survive a round trip through every OS: `..`,
//     absolute paths, drive letters, `:` (NTFS streams), Windows' reserved names and characters,
//     trailing dots and spaces, control characters, and two names that differ only in case or
//     Unicode normalization (zip-slip, and files that overwrite each other on extraction);
//   - symlinks and other special files, encrypted entries, methods other than store and deflate,
//     ZIP64 and multi-disk archives (a package is at most 100 MiB, so neither is ever needed);
//   - entries whose data overlaps another's, or runs into the central directory (the
//     overlapping-entry zip bomb), and local headers that disagree with the central directory;
//   - more bytes than declared: inflation stops at the declared size, which is checked against
//     the limits before anything is inflated, so a bomb can't allocate more than the limit;
//   - a CRC-32 that doesn't match.
// Backslashes are read as separators (Windows PowerShell 5.1's Compress-Archive writes them), and
// macOS and Windows desktop clutter (__MACOSX/, .DS_Store, Thumbs.db, desktop.ini) is skipped.
import { readSync } from 'node:fs';
import zlib from 'node:zlib';

export const ZIP_LIMITS = Object.freeze({
  archiveBytes: 100 * 1024 * 1024, // the .skp file itself
  totalBytes: 100 * 1024 * 1024, // all files, uncompressed (04 §4.1)
  fileBytes: 50 * 1024 * 1024, // one file, uncompressed (04 §4.1)
  entries: 5000,
  pathLength: 240, // characters in the whole path, inside the package
  segmentBytes: 255, // UTF-8 bytes in one name: what ext4, ZFS and APFS allow
  ratio: 100, // uncompressed:compressed, for files over ratioFrom bytes (07 §7.11's ratio cap)
  ratioFrom: 1024 * 1024,
});

export class ZipError extends Error {
  constructor(message, code = 'bad-zip') {
    super(message);
    this.name = 'ZipError';
    this.code = code;
  }
}

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
export const JUNK = /(^|\/)(__MACOSX\/|\.DS_Store$|\._[^/]*$|Thumbs\.db$|desktop\.ini$)/i;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\.|$)/i;
const utf8 = new TextDecoder('utf-8', { fatal: true });

// The whole archive in memory: { files: [{ name, data }], skipped: [names] }, in archive order.
export function readZip(buffer, limits = {}) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError('readZip takes a Buffer');
  const zip = openZip(bufferSource(buffer), limits);
  return { files: zip.entries.map((e) => ({ name: e.name, data: zip.read(e) })), skipped: zip.skipped };
}

// Reads where a source says: { size, read(offset, length) → Buffer }. Every read is checked
// against the size, so a lying offset is a ZipError, never a RangeError.
export function bufferSource(buffer) {
  return { size: buffer.length, read: (offset, length) => slice(buffer, offset, length) };
}

// An open file, read in pieces: an install never holds the whole archive and all its files in
// memory at once.
export function fileSource(fd, size) {
  return {
    size,
    read(offset, length) {
      if (offset < 0 || length < 0 || offset + length > size) throw new ZipError('The archive is truncated or damaged.');
      const out = Buffer.allocUnsafe(length);
      let done = 0;
      while (done < length) {
        const n = readSync(fd, out, done, length - done, offset + done);
        if (n === 0) throw new ZipError('The archive is truncated or damaged.');
        done += n;
      }
      return out;
    },
  };
}

// Checks the whole directory and every local header up front; files are inflated one at a time
// by read(entry). Returns { entries: [{ name, size }], skipped: [names], read(entry) → Buffer }.
// Directory entries are dropped; their names are still checked. Throws ZipError with a message an
// operator can act on.
export function openZip(source, limits = {}) {
  const max = { ...ZIP_LIMITS, ...limits };
  if (source.size > max.archiveBytes) throw new ZipError(`The package is ${mib(source.size)}; the limit is ${mib(max.archiveBytes)}.`, 'too-large');

  const tailStart = Math.max(0, source.size - 22 - 0xffff);
  const tail = source.read(tailStart, source.size - tailStart);
  const endAt = findEnd(tail);
  const end = tailStart + endAt;
  const disk = tail.readUInt16LE(endAt + 4);
  const cdDisk = tail.readUInt16LE(endAt + 6);
  const onDisk = tail.readUInt16LE(endAt + 8);
  const count = tail.readUInt16LE(endAt + 10);
  const cdSize = tail.readUInt32LE(endAt + 12);
  const cdOffset = tail.readUInt32LE(endAt + 16);
  if (disk !== 0 || cdDisk !== 0 || onDisk !== count) throw new ZipError('Multi-part (spanned) archives are not supported.', 'unsupported');
  if ((endAt >= 20 && tail.readUInt32LE(endAt - 20) === SIG_ZIP64_LOCATOR) || count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new ZipError('ZIP64 archives are not supported; a package is at most 100 MiB, so zip it without ZIP64.', 'unsupported');
  }
  if (count > max.entries) throw new ZipError(`The package has ${count} entries; the limit is ${max.entries}.`, 'too-many');
  if (cdOffset + cdSize > end) throw new ZipError('The central directory runs past the end of the archive.');
  const cd = source.read(cdOffset, cdSize);

  const entries = [];
  const seen = new Map(); // folded file name → name
  const folders = new Map(); // folded folder path → folder path
  const addFolder = (dir, fold) => {
    const known = folders.get(fold(dir));
    if (known !== undefined && known !== dir) throw new ZipError(`The folders "${known}" and "${dir}" differ only in case or accents.`, 'duplicate');
    if (seen.has(fold(dir))) throw new ZipError(`"${dir}" is both a file and a folder.`, 'duplicate');
    folders.set(fold(dir), dir);
  };
  let total = 0;
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > cd.length || cd.readUInt32LE(p) !== SIG_CENTRAL) throw new ZipError('The central directory is damaged.');
    const madeBy = cd.readUInt16LE(p + 4);
    const flags = cd.readUInt16LE(p + 8);
    const method = cd.readUInt16LE(p + 10);
    const crc = cd.readUInt32LE(p + 16);
    const compressed = cd.readUInt32LE(p + 20);
    const size = cd.readUInt32LE(p + 24);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    const external = cd.readUInt32LE(p + 38);
    const local = cd.readUInt32LE(p + 42);
    if (p + 46 + nameLen + extraLen + commentLen > cd.length) throw new ZipError('The central directory is damaged.');
    const nameBytes = cd.subarray(p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    const raw = decodeName(nameBytes, flags);
    const isDir = raw.endsWith('/') || raw.endsWith('\\');
    const name = checkName(raw, max);
    if (JUNK.test(name + (isDir ? '/' : ''))) {
      entries.push({ skip: true, name });
      continue;
    }
    if (flags & 0x41) throw new ZipError(`"${name}" is encrypted; packages can't contain encrypted files.`, 'unsupported');
    if (method !== 0 && method !== 8) throw new ZipError(`"${name}" uses compression method ${method}; only store and deflate are supported.`, 'unsupported');
    if (madeBy >> 8 === 3) { // Unix: the file type is in the high 16 bits of the external attributes
      const type = (external >>> 16) & 0o170000;
      if (type === 0o120000) throw new ZipError(`"${name}" is a symbolic link; packages can't contain links.`, 'unsafe-path');
      if (type !== 0 && type !== 0o100000 && type !== 0o040000) throw new ZipError(`"${name}" is not a regular file.`, 'unsafe-path');
    }

    // Folded for comparison: two names that differ only in case or Unicode normalization are one
    // file on Windows and macOS and two on Linux, so the same package would serve different files.
    if (isDir) {
      addFolder(name, fold);
      continue;
    }
    const other = seen.get(fold(name));
    if (other !== undefined) {
      throw new ZipError(other === name ? `"${name}" appears twice.` : `"${other}" and "${name}" differ only in case or accents, so they'd overwrite each other on most systems.`, 'duplicate');
    }
    if (folders.has(fold(name))) throw new ZipError(`"${name}" is both a file and a folder.`, 'duplicate');
    seen.set(fold(name), name);
    const parts = name.split('/');
    for (let j = 1; j < parts.length; j++) addFolder(parts.slice(0, j).join('/'), fold);

    if (size > max.fileBytes) throw new ZipError(`"${name}" is ${mib(size)} uncompressed; the limit for one file is ${mib(max.fileBytes)}.`, 'too-large');
    if (size > max.ratioFrom && size / Math.max(1, compressed) > max.ratio) {
      throw new ZipError(`"${name}" expands more than ${max.ratio} times; real template files don't, zip bombs do.`, 'too-large');
    }
    total += size;
    if (total > max.totalBytes) throw new ZipError(`The package is over ${mib(max.totalBytes)} uncompressed.`, 'too-large');
    entries.push({ name, nameBytes, flags, method, crc, compressed, size, local });
  }

  // The directory's records fill exactly the size the end record gives it: nothing hidden after.
  if (p !== cd.length) throw new ZipError('The central directory is damaged.');

  // Each entry's local header and data must lie inside the archive, before the central
  // directory, and clear of every other entry's.
  const files = entries.filter((e) => !e.skip);
  for (const e of files) {
    e.start = localData(source, e, cdOffset);
    e.end = e.start + e.compressed;
  }
  const byOffset = files.slice().sort((a, b) => a.local - b.local);
  for (let i = 1; i < byOffset.length; i++) {
    if (byOffset[i].local < byOffset[i - 1].end) throw new ZipError(`"${byOffset[i].name}" overlaps "${byOffset[i - 1].name}" in the archive.`, 'overlap');
  }

  const listed = new Map(files.map((e) => [e.name, e]));
  return {
    entries: files.map((e) => ({ name: e.name, size: e.size })),
    skipped: entries.filter((e) => e.skip).map((e) => e.name),
    read(entry) {
      const e = listed.get(entry && entry.name);
      if (!e) throw new ZipError(`"${entry && entry.name}" is not in the archive.`);
      return inflate(e, source.read(e.start, e.compressed));
    },
  };
}

function inflate(e, stored) {
  let data;
  if (e.method === 0) {
    if (e.compressed !== e.size) throw new ZipError(`"${e.name}" has inconsistent sizes.`);
    data = stored;
  } else {
    let used;
    try {
      // One byte over the declared size is enough to know the declaration was a lie.
      const out = zlib.inflateRawSync(stored, { maxOutputLength: Math.max(1, e.size + 1), info: true });
      data = out.buffer;
      used = out.engine.bytesWritten; // the compressed bytes the stream actually took
    } catch (err) {
      if (err.code === 'ERR_BUFFER_TOO_LARGE') throw new ZipError(`"${e.name}" inflates to more than it declares.`, 'too-large');
      throw new ZipError(`"${e.name}" can't be decompressed (${err.code || err.message}).`);
    }
    if (data.length !== e.size) throw new ZipError(`"${e.name}" inflates to ${data.length} bytes but declares ${e.size}.`);
    // Bytes after the end of the stream belong to no file and no checksum covers them (another
    // tool could read them as an entry of its own, and they'd pad a bomb under the ratio cap).
    if (used !== stored.length) throw new ZipError(`"${e.name}" has ${stored.length - used} bytes after its compressed data.`, 'trailing-data');
  }
  if ((zlib.crc32(data) >>> 0) !== e.crc) throw new ZipError(`"${e.name}" is damaged (its checksum doesn't match).`, 'bad-crc');
  return data;
}

function slice(buffer, offset, length) {
  if (offset < 0 || length < 0 || offset + length > buffer.length) throw new ZipError('The archive is truncated or damaged.');
  return Buffer.from(buffer.subarray(offset, offset + length));
}

// The end-of-central-directory record in the archive's tail: one whose comment runs exactly to
// the end of the file. A comment holding a second such record would make tools disagree about the
// contents, so that is refused rather than guessed.
function findEnd(buffer) {
  let found = -1;
  for (let i = buffer.length - 22; i >= 0; i--) {
    if (buffer.readUInt32LE(i) !== SIG_END || i + 22 + buffer.readUInt16LE(i + 20) !== buffer.length) continue;
    if (found >= 0) throw new ZipError('The archive has two end records; it may have been tampered with.', 'ambiguous');
    found = i;
  }
  if (found < 0) throw new ZipError('This is not a ZIP archive (or it is truncated).', 'not-zip');
  return found;
}

function localData(source, e, cdOffset) {
  const p = e.local;
  if (p + 30 > cdOffset) throw new ZipError(`"${e.name}" has no local header where the directory says.`);
  const head = source.read(p, 30);
  if (head.readUInt32LE(0) !== SIG_LOCAL) throw new ZipError(`"${e.name}" has no local header where the directory says.`);
  const flags = head.readUInt16LE(6);
  const method = head.readUInt16LE(8);
  const nameLen = head.readUInt16LE(26);
  const extraLen = head.readUInt16LE(28);
  if (method !== e.method || (flags & 0x41) !== (e.flags & 0x41)) throw new ZipError(`"${e.name}" has a local header that disagrees with the directory.`);
  if (p + 30 + nameLen > cdOffset || !source.read(p + 30, nameLen).equals(e.nameBytes)) throw new ZipError(`"${e.name}" has a different name in its local header.`);
  const start = p + 30 + nameLen + extraLen;
  if (start + e.compressed > cdOffset) throw new ZipError(`"${e.name}" runs into the central directory.`);
  return start;
}

// Names are UTF-8: flagged as such (bit 11), or simply valid UTF-8, as many tools write them
// without the flag. Anything else is a legacy code page that can't be known.
function decodeName(bytes, flags) {
  try {
    return utf8.decode(bytes);
  } catch {
    throw new ZipError(flags & 0x800
      ? 'An entry name is not valid UTF-8.'
      : 'An entry name is in a legacy character set; re-create the package with "skp template pack" or 7-Zip, which write UTF-8 names.', 'unsafe-path');
  }
}

// A package-relative, "/"-separated path that is safe to create on Windows, macOS and Linux.
export function checkName(raw, { pathLength = ZIP_LIMITS.pathLength, segmentBytes = ZIP_LIMITS.segmentBytes } = {}) {
  const name = raw.replace(/\\/g, '/').replace(/\/$/, '');
  const bad = (why) => new ZipError(`"${raw}" is not an allowed path in a package: ${why}.`, 'unsafe-path');
  if (!name) throw bad('it is empty');
  if (name.length > pathLength) throw bad(`it is longer than ${pathLength} characters`);
  if (name.startsWith('/') || /^[a-zA-Z]:/.test(name)) throw bad('it is absolute');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f<>:"|?*]/.test(name)) throw bad('it contains a character Windows can\'t store (control characters, < > : " | ? *)');
  for (const segment of name.split('/')) {
    if (!segment) throw bad('it has an empty segment');
    if (segment === '.' || segment === '..') throw bad('it leaves its folder');
    if (/[. ]$/.test(segment)) throw bad('a name ends with a dot or a space');
    if (WINDOWS_RESERVED.test(segment)) throw bad(`"${segment}" is a reserved name on Windows`);
    if (Buffer.byteLength(segment, 'utf8') > segmentBytes) throw bad(`a name is longer than ${segmentBytes} bytes`);
  }
  return name;
}

// The form two names are compared in: what Windows and macOS treat as one name (case, Unicode
// normalization, and case pairs like ı/I and ſ/S that a plain lowercase misses) is one key.
export const fold = (s) => s.normalize('NFC').toUpperCase().toLowerCase();

// Writes an archive: deflated when that is smaller, stored otherwise, with UTF-8 names and a fixed
// timestamp, so the same files always make the same bytes. files: [{ name, data }].
export function writeZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of files) {
    const nameBytes = Buffer.from(checkName(name), 'utf8');
    const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const deflated = zlib.deflateRawSync(body, { level: 9 });
    const method = deflated.length < body.length ? 8 : 0;
    const stored = method === 8 ? deflated : body;
    const crc = zlib.crc32(body) >>> 0;
    const head = Buffer.alloc(30);
    head.writeUInt32LE(SIG_LOCAL, 0);
    head.writeUInt16LE(20, 4); // version needed: 2.0
    head.writeUInt16LE(0x800, 6); // UTF-8 names
    head.writeUInt16LE(method, 8);
    head.writeUInt16LE(0, 10); // 00:00
    head.writeUInt16LE(0x21, 12); // 1980-01-01
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(stored.length, 18);
    head.writeUInt32LE(body.length, 22);
    head.writeUInt16LE(nameBytes.length, 26);
    head.writeUInt16LE(0, 28);
    locals.push(head, nameBytes, stored);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(SIG_CENTRAL, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // made by Unix, 2.0
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(stored.length, 20);
    central.writeUInt32LE(body.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38); // a regular file, rw-r--r--
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + stored.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(SIG_END, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const mib = (n) => `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MiB`;
