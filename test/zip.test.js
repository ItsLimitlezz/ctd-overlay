// The ZIP reader against well-formed archives and every hostile shape it must refuse (04 §4.1:
// zip-slip, zip bombs, links, damaged and inconsistent archives).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closeSync, mkdtempSync, openSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { checkName, fileSource, openZip, readZip, writeZip, ZipError } from '../src/templates/zip.js';

// Builds an archive with any field forged. entry: { name, data, method = 8, flags = 0x800,
// madeBy = 0x0314, mode = 0o100644, crc, size, compressed (stored bytes), localName,
// localMethod, local (offset override) }; opts: { comment, entriesOverride, zip64Locator }.
function forge(entries, opts = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const body = Buffer.from(e.data ?? '');
    const method = e.method ?? 8;
    const stored = e.compressed ?? (method === 8 ? zlib.deflateRawSync(body) : body);
    const name = Buffer.isBuffer(e.name) ? e.name : Buffer.from(e.name, 'utf8');
    const localName = e.localName ? Buffer.from(e.localName, 'utf8') : name;
    const flags = e.flags ?? 0x800;
    const crc = e.crc ?? (zlib.crc32(body) >>> 0);
    const size = e.size ?? body.length;
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(flags, 6);
    head.writeUInt16LE(e.localMethod ?? method, 8);
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(stored.length, 18);
    head.writeUInt32LE(size, 22);
    head.writeUInt16LE(localName.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(e.madeBy ?? 0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(stored.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((e.mode ?? 0o100644) << 16) >>> 0, 38);
    central.writeUInt32LE(e.local ?? offset, 42);
    locals.push(head, localName, stored);
    centrals.push(central, name);
    offset += 30 + localName.length + stored.length;
  }
  const cd = Buffer.concat(centrals);
  const comment = Buffer.from(opts.comment ?? '');
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(opts.entriesOverride ?? entries.length, 8);
  end.writeUInt16LE(opts.entriesOverride ?? entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(comment.length, 20);
  const locator = opts.zip64Locator ? Buffer.from([0x50, 0x4b, 0x06, 0x07, ...Buffer.alloc(16)]) : Buffer.alloc(0);
  return Buffer.concat([...locals, cd, locator, end, comment]);
}

const refuses = (buffer, code, pattern, limits) => {
  assert.throws(() => readZip(buffer, limits), (err) => {
    assert.ok(err instanceof ZipError, `expected ZipError, got ${err}`);
    if (code) assert.equal(err.code, code, err.message);
    if (pattern) assert.match(err.message, pattern);
    return true;
  });
};

test('what writeZip writes, readZip reads back, byte for byte, in order', () => {
  const files = [
    { name: 'template.json', data: '{"id":"x"}' },
    { name: 'assets/logo.svg', data: '<svg/>'.repeat(200) }, // compressible: deflated
    { name: 'assets/noise.bin', data: Buffer.from(Array.from({ length: 300 }, (_, i) => (i * 7919) % 256)) },
    { name: 'empty.txt', data: '' },
    { name: 'naïve/ünïcode.txt', data: 'ok' },
  ];
  const zip = writeZip(files);
  const { files: back, skipped } = readZip(zip);
  assert.deepEqual(back.map((f) => f.name), files.map((f) => f.name));
  for (let i = 0; i < files.length; i++) assert.ok(back[i].data.equals(Buffer.from(files[i].data)), files[i].name);
  assert.deepEqual(skipped, []);
  assert.ok(writeZip(files).equals(zip), 'the same files make the same bytes');
});

test('archives from other tools: data descriptors, Windows backslashes, directory entries, desktop clutter', () => {
  const zip = forge([
    { name: 'pkg/', data: '', method: 0, mode: 0o040755 },
    { name: 'pkg\\template.json', data: '{}', madeBy: 0x0014, mode: 0 }, // MS-DOS, PowerShell 5.1 style
    { name: 'pkg/a.css', data: 'a{}', flags: 0x808 }, // bit 3: sizes in a data descriptor
    { name: '__MACOSX/pkg/._a.css', data: 'junk' },
    { name: 'pkg/.DS_Store', data: 'junk' },
    { name: 'pkg/Thumbs.db', data: 'junk' },
  ]);
  const { files, skipped } = readZip(zip);
  assert.deepEqual(files.map((f) => f.name), ['pkg/template.json', 'pkg/a.css']);
  assert.deepEqual(skipped, ['__MACOSX/pkg/._a.css', 'pkg/.DS_Store', 'pkg/Thumbs.db']);
});

test('names that escape the package or break on some OS are refused (zip-slip)', () => {
  const bad = [
    '../evil.js', 'a/../../evil.js', '..\\evil.js', '/etc/passwd', '\\\\server\\share', 'C:/Windows/x', 'c:evil',
    'a//b', './a', 'a/./b', 'file:stream', 'nul', 'assets/CON.png', 'com1', 'LPT9.txt', 'trailing.', 'space ',
    'a\u0000b', 'tab\there', 'quote"', 'star*', 'q?', 'pipe|', 'lt<', 'x'.repeat(241),
  ];
  for (const name of bad) refuses(forge([{ name, data: 'x' }]), 'unsafe-path', undefined);
  for (const name of ['index.html', 'assets/font.woff2', 'a.b.c', 'con-tent.txt', 'com10.txt', 'nul-ish/x']) {
    assert.equal(checkName(name), name);
  }
});

test('links and special files are refused', () => {
  refuses(forge([{ name: 'link', data: '/etc/passwd', mode: 0o120777 }]), 'unsafe-path', /symbolic link/);
  refuses(forge([{ name: 'dev', data: '', mode: 0o020644 }]), 'unsafe-path', /not a regular file/);
  refuses(forge([{ name: 'fifo', data: '', mode: 0o010644 }]), 'unsafe-path');
});

test('names that collide on Windows or macOS are refused', () => {
  refuses(forge([{ name: 'a.css', data: '1' }, { name: 'a.css', data: '2' }]), 'duplicate', /twice/);
  refuses(forge([{ name: 'Logo.png', data: '1' }, { name: 'logo.png', data: '2' }]), 'duplicate', /case/);
  refuses(forge([{ name: 'caf\u00e9.txt', data: '1' }, { name: 'cafe\u0301.txt', data: '2' }]), 'duplicate'); // NFC vs NFD
  refuses(forge([{ name: 'assets/a.png', data: '1' }, { name: 'Assets/b.png', data: '2' }]), 'duplicate', /folders/);
  refuses(forge([{ name: 'assets', data: 'a file' }, { name: 'assets/x.png', data: '2' }]), 'duplicate');
});

test('names without the UTF-8 flag must be ASCII, and flagged names must be valid UTF-8', () => {
  refuses(forge([{ name: Buffer.from([0x63, 0x61, 0x66, 0x82]), data: 'x', flags: 0 }]), 'unsafe-path', /UTF-8/); // CP437 é
  refuses(forge([{ name: Buffer.from([0x61, 0xc3, 0x28]), data: 'x' }]), 'unsafe-path', /UTF-8/);
  assert.deepEqual(readZip(forge([{ name: 'plain.txt', data: 'x', flags: 0 }])).files.map((f) => f.name), ['plain.txt']);
});

test('zip bombs: declared sizes are capped before inflating, and inflating stops at the declared size', () => {
  const big = Buffer.alloc(3 * 1024 * 1024); // deflates to a few KB
  const limits = { fileBytes: 2 * 1024 * 1024, totalBytes: 4 * 1024 * 1024 };
  refuses(forge([{ name: 'big.bin', data: big }]), 'too-large', /one file/, limits);
  refuses(forge([{ name: 'a.bin', data: big.subarray(0, 1.5 * 1024 * 1024) }, { name: 'b.bin', data: big.subarray(0, 1.5 * 1024 * 1024) }, { name: 'c.bin', data: big.subarray(0, 1.5 * 1024 * 1024) }]), 'too-large', /uncompressed/, limits);
  // A lie: declares 1 KB, inflates to 3 MiB.
  refuses(forge([{ name: 'liar.bin', data: big, size: 1024 }]), 'too-large', /more than it declares/);
  // The archive itself, and the number of entries.
  refuses(Buffer.alloc(200), 'too-large', undefined, { archiveBytes: 100 });
  refuses(forge(Array.from({ length: 11 }, (_, i) => ({ name: `f${i}`, data: '' }))), 'too-many', undefined, { entries: 10 });
});

test('overlapping entries (one compressed stream counted many times) are refused', () => {
  const zip = writeZip([{ name: 'a.txt', data: 'x'.repeat(5000) }, { name: 'b.txt', data: 'y' }]);
  // Point b's directory entry at a's local header: the classic overlapping bomb.
  const cd = zip.readUInt32LE(zip.length - 6);
  const second = cd + 46 + 'a.txt'.length;
  const forged = Buffer.from(zip);
  forged.writeUInt32LE(0, second + 42);
  refuses(forged, undefined, /local header|overlaps|different name/);
  // Two directory entries naming one local entry.
  const twice = forge([{ name: 'x1.txt', data: 'abc' }, { name: 'x2.txt', data: 'abc', local: 0, localName: 'x1.txt' }]);
  refuses(twice);
});

test('damaged or inconsistent archives are refused', () => {
  refuses(Buffer.from('not a zip at all'), 'not-zip');
  const good = writeZip([{ name: 'a.txt', data: 'hello hello hello hello' }]);
  refuses(good.subarray(0, good.length - 5), 'not-zip'); // truncated
  refuses(forge([{ name: 'a.txt', data: 'hello', crc: 1234 }]), 'bad-crc');
  refuses(forge([{ name: 'a.txt', data: 'hello', localName: 'b.txt' }]), undefined, /different name/);
  refuses(forge([{ name: 'a.txt', data: 'hello', localMethod: 0 }]), undefined, /disagrees/);
  refuses(forge([{ name: 'a.txt', data: 'hello', method: 0, size: 99 }]), undefined, /inconsistent/);
  refuses(forge([{ name: 'a.txt', data: 'hello', compressed: Buffer.from('not deflate data at all') }]));
  refuses(forge([{ name: 'a.txt', data: 'hello', flags: 0x801 }]), 'unsupported', /encrypted/);
  refuses(forge([{ name: 'a.txt', data: 'hello', method: 12, compressed: Buffer.from('bz') }]), 'unsupported', /method 12/);
  refuses(forge([{ name: 'a.txt', data: 'x' }], { zip64Locator: true }), 'unsupported', /ZIP64/);
  refuses(forge([{ name: 'a.txt', data: 'x' }], { entriesOverride: 0xffff }), 'unsupported', /ZIP64/);
});

test('a second end record hidden in the archive comment is refused, not guessed between', () => {
  const inner = writeZip([{ name: 'evil.txt', data: 'evil' }]);
  const fakeEnd = inner.subarray(inner.length - 22); // a valid-looking record pointing elsewhere
  const zip = forge([{ name: 'good.txt', data: 'good' }], { comment: fakeEnd.toString('latin1') });
  refuses(zip, 'ambiguous');
  const commented = forge([{ name: 'good.txt', data: 'good' }], { comment: 'built by hand' });
  assert.deepEqual(readZip(commented).files.map((f) => f.name), ['good.txt']);
});

test('writeZip refuses names the reader would refuse', () => {
  assert.throws(() => writeZip([{ name: '../x', data: '' }]), ZipError);
});

test('an archive read from a file, one entry at a time, is the same as one read from memory', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'skp-zip-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const files = [{ name: 'a.txt', data: 'a'.repeat(10000) }, { name: 'b/c.bin', data: Buffer.from([1, 2, 3]) }];
  const file = path.join(dir, 'x.skp');
  writeFileSync(file, writeZip(files));
  const fd = openSync(file, 'r');
  try {
    const zip = openZip(fileSource(fd, statSync(file).size));
    assert.deepEqual(zip.entries, [{ name: 'a.txt', size: 10000 }, { name: 'b/c.bin', size: 3 }]);
    assert.ok(zip.read(zip.entries[1]).equals(Buffer.from([1, 2, 3])));
    assert.equal(zip.read(zip.entries[0]).toString(), 'a'.repeat(10000));
    assert.throws(() => zip.read({ name: 'nope' }), ZipError);
  } finally {
    closeSync(fd);
  }
});

test('fuzz: truncated and corrupted archives only ever give a ZipError, never a crash or a hang', () => {
  const zip = writeZip([
    { name: 'template.json', data: JSON.stringify({ id: 'a.b.c', text: 'x'.repeat(300) }) },
    { name: 'assets/a.svg', data: '<svg/>'.repeat(100) },
    { name: 'b.bin', data: Buffer.from(Array.from({ length: 64 }, (_, i) => i)) },
  ]);
  let seed = 42;
  const random = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const t0 = Date.now();
  for (let i = 0; i < 3000; i++) {
    let bytes = Buffer.from(zip);
    if (i % 3 === 0) bytes = bytes.subarray(0, Math.floor(random() * bytes.length));
    const flips = 1 + Math.floor(random() * 4);
    for (let f = 0; f < flips && bytes.length; f++) bytes[Math.floor(random() * bytes.length)] = Math.floor(random() * 256);
    try {
      readZip(bytes);
    } catch (err) {
      assert.ok(err instanceof ZipError, `case ${i}: ${err && err.stack}`);
    }
  }
  assert.ok(Date.now() - t0 < 10000);
});
