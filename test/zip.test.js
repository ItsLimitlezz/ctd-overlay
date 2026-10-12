// The ZIP reader against well-formed archives and every hostile shape it must refuse (04 §4.1:
// zip-slip, zip bombs, links, damaged and inconsistent archives).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closeSync, mkdtempSync, openSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { checkName, fileSource, openZip, readZip, writeZip, ZipError } from '../src/templates/zip.js';

// Builds an archive with any field forged. entry: { name, data, method = 8, flags = 0x800
// (0x808 with a descriptor), madeBy = 0x0314, mode = 0o100644, crc, size, compressed (stored
// bytes), compressedSize (declared), localName, localMethod, localFlags, local (offset override),
// centralOnly (a directory record with no local entry of its own), descriptor (16 or 12: the CRC
// and sizes follow the data, with or without the PK\x07\x08 signature, and the local header holds
// zeros) }; opts: { comment, entriesOverride, zip64Locator, cdExtra (bytes after the directory's
// records, counted in its size), disk, cdDisk, onDisk (the end record's disk fields) }.
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
    const flags = e.flags ?? (e.descriptor ? 0x808 : 0x800);
    const crc = e.crc ?? (zlib.crc32(body) >>> 0);
    const size = e.size ?? body.length;
    const compressedSize = e.compressedSize ?? stored.length;
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(e.localFlags ?? flags, 6);
    head.writeUInt16LE(e.localMethod ?? method, 8);
    if (!e.descriptor) {
      head.writeUInt32LE(crc, 14);
      head.writeUInt32LE(compressedSize, 18);
      head.writeUInt32LE(size, 22);
    }
    head.writeUInt16LE(localName.length, 26);
    let descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(crc, 4);
    descriptor.writeUInt32LE(compressedSize, 8);
    descriptor.writeUInt32LE(size, 12);
    descriptor = descriptor.subarray(16 - (e.descriptor ?? 0));
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(e.madeBy ?? 0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressedSize, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((e.mode ?? 0o100644) << 16) >>> 0, 38);
    central.writeUInt32LE(e.local ?? offset, 42);
    centrals.push(central, name);
    if (e.centralOnly) continue;
    locals.push(head, localName, stored, descriptor);
    offset += 30 + localName.length + stored.length + descriptor.length;
  }
  const cd = Buffer.concat([...centrals, opts.cdExtra ?? Buffer.alloc(0)]);
  const comment = Buffer.from(opts.comment ?? '');
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(opts.disk ?? 0, 4);
  end.writeUInt16LE(opts.cdDisk ?? 0, 6);
  end.writeUInt16LE(opts.onDisk ?? opts.entriesOverride ?? entries.length, 8);
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
    { name: 'pkg/a.css', data: 'a{}', descriptor: 16 }, // bit 3: CRC and sizes in a data descriptor
    { name: '__MACOSX/pkg/._a.css', data: 'junk' },
    { name: 'pkg/.DS_Store', data: 'junk' },
    { name: 'pkg/Thumbs.db', data: 'junk' },
  ]);
  const { files, skipped } = readZip(zip);
  assert.deepEqual(files.map((f) => f.name), ['pkg/template.json', 'pkg/a.css']);
  assert.equal(files[1].data.toString(), 'a{}');
  assert.deepEqual(skipped, ['__MACOSX/pkg/._a.css', 'pkg/.DS_Store', 'pkg/Thumbs.db']);
});

test('data descriptors, with or without their signature, are read by the directory\'s sizes', () => {
  // With bit 3 the local header holds zeros and the CRC and sizes follow the data, so only the
  // central directory says where each entry ends and the next begins.
  const files = [
    { name: 'signed.css', data: 'a{color:red}'.repeat(50), descriptor: 16 },
    { name: 'bare.js', data: 'let x = 1;\n'.repeat(50), descriptor: 12 },
    { name: 'stored.bin', data: Buffer.from([1, 2, 3, 4]), method: 0, descriptor: 16 },
    { name: 'plain.txt', data: 'after the descriptors' },
  ];
  const zip = forge(files);
  assert.deepEqual([zip.readUInt32LE(14), zip.readUInt32LE(18), zip.readUInt32LE(22)], [0, 0, 0], 'the fixture leaves the local CRC and sizes empty');
  const { files: back } = readZip(zip);
  assert.deepEqual(back.map((f) => f.name), files.map((f) => f.name));
  for (let i = 0; i < files.length; i++) assert.ok(back[i].data.equals(Buffer.from(files[i].data)), files[i].name);
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
  // One name may be 255 UTF-8 bytes. A precomposed é is 2 bytes, so 128 of them are 256 bytes in
  // 128 characters: the 240-character path limit isn't what refuses it.
  const e = '\u00e9';
  refuses(forge([{ name: e.repeat(128), data: 'x' }]), 'unsafe-path', /longer than 255 bytes/);
  assert.equal(checkName(e.repeat(127) + 'x'), e.repeat(127) + 'x');
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
  // Case pairs a plain lowercase misses: long s uppercases to S, dotless i to I.
  refuses(forge([{ name: '\u017f.txt', data: '1' }, { name: 's.txt', data: '2' }]), 'duplicate', /case/);
  refuses(forge([{ name: '\u0131.txt', data: '1' }, { name: 'i.txt', data: '2' }]), 'duplicate', /case/);
  refuses(forge([{ name: 'assets/a.png', data: '1' }, { name: 'Assets/b.png', data: '2' }]), 'duplicate', /folders/);
  refuses(forge([{ name: 'assets', data: 'a file' }, { name: 'assets/x.png', data: '2' }]), 'duplicate', /"assets" is both a file and a folder/);
  // The other order: the folder is known before the file that takes its name.
  refuses(forge([{ name: 'assets/x.png', data: '2' }, { name: 'assets', data: 'a file' }]), 'duplicate', /"assets" is both a file and a folder/);
  refuses(forge([{ name: 'Assets/x.png', data: '2' }, { name: 'assets', data: 'a file' }]), 'duplicate', /"assets" is both a file and a folder/);
});

test('names without the UTF-8 flag must be ASCII, and flagged names must be valid UTF-8', () => {
  refuses(forge([{ name: Buffer.from([0x63, 0x61, 0x66, 0x82]), data: 'x', flags: 0 }]), 'unsafe-path', /UTF-8/); // CP437 é
  refuses(forge([{ name: Buffer.from([0x61, 0xc3, 0x28]), data: 'x' }]), 'unsafe-path', /UTF-8/);
  assert.deepEqual(readZip(forge([{ name: 'plain.txt', data: 'x', flags: 0 }])).files.map((f) => f.name), ['plain.txt']);
});

test('zip bombs: declared sizes are capped before inflating, and inflating stops at the declared size', () => {
  const big = Buffer.alloc(3 * 1024 * 1024); // deflates to a few KB
  const limits = { fileBytes: 2 * 1024 * 1024, totalBytes: 4 * 1024 * 1024, ratio: Infinity };
  refuses(forge([{ name: 'big.bin', data: big }]), 'too-large', /one file/, limits);
  refuses(forge([{ name: 'a.bin', data: big.subarray(0, 1.5 * 1024 * 1024) }, { name: 'b.bin', data: big.subarray(0, 1.5 * 1024 * 1024) }, { name: 'c.bin', data: big.subarray(0, 1.5 * 1024 * 1024) }]), 'too-large', /uncompressed/, limits);
  // The ratio cap: 1.5 MiB of zeros deflates about 1000:1.
  refuses(forge([{ name: 'zeros.bin', data: big.subarray(0, 1.5 * 1024 * 1024) }]), 'too-large', /expands more than 100 times/);
  assert.equal(readZip(forge([{ name: 'small.txt', data: Buffer.alloc(100000) }])).files.length, 1, 'small files may compress well');
  // A lie: declares 1 KB, inflates to 3 MiB.
  refuses(forge([{ name: 'liar.bin', data: big, size: 1024 }]), 'too-large', /more than it declares/);
  // The archive itself, and the number of entries.
  refuses(Buffer.alloc(200), 'too-large', undefined, { archiveBytes: 100 });
  refuses(forge(Array.from({ length: 11 }, (_, i) => ({ name: `f${i}`, data: '' }))), 'too-many', undefined, { entries: 10 });
});

test('the ratio cap refuses more than 100:1 (exactly 100 is read) in files over 1 MiB (exactly 1 MiB is read)', () => {
  const zeros = Buffer.alloc(1024 * 1024 + 1);
  const mib = zeros.subarray(0, 1024 * 1024);
  assert.ok(mib.length / zlib.deflateRawSync(mib).length > 100, 'the fixture expands more than 100 times');
  assert.ok(readZip(forge([{ name: 'zeros.bin', data: mib }])).files[0].data.equals(mib));
  refuses(forge([{ name: 'zeros.bin', data: zeros }]), 'too-large', /"zeros\.bin" expands more than 100 times/);

  // The cap is 100:1 by behaviour, not just by the message: zeros alone deflate about 1000:1, so
  // these add deterministic noise (xorshift32) to land just either side of 100.
  const noise = (n) => {
    const out = Buffer.alloc(n);
    let x = 2463534242;
    for (let i = 0; i < n; i++) {
      x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
      out[i] = x & 0xff;
    }
    return out;
  };
  const over = Buffer.concat([Buffer.alloc(2 * 1024 * 1024), noise(17000)]);
  const under = Buffer.concat([Buffer.alloc(2 * 1024 * 1024), noise(19000)]);
  const overRatio = over.length / zlib.deflateRawSync(over).length; // the stream forge stores
  const underRatio = under.length / zlib.deflateRawSync(under).length;
  assert.ok(overRatio > 100 && overRatio < 110, `the refused fixture expands ${overRatio} times`);
  assert.ok(underRatio > 90 && underRatio < 100, `the accepted fixture expands ${underRatio} times`);
  refuses(forge([{ name: 'over.bin', data: over }]), 'too-large', /"over\.bin" expands more than 100 times/);
  assert.ok(readZip(forge([{ name: 'under.bin', data: under }])).files[0].data.equals(under));

  // Exactly 100:1 is not more than 100. The stream is built to an exact length: zeros deflated and
  // flushed to a byte boundary, then one final stored block (0x01, LEN, ~LEN, LEN bytes). With z
  // zeros flushed to f bytes and n stored, size = 100 * compressed means 99n = z - 100(f + 5).
  let z = 2 * 1024 * 1024;
  let flushed;
  let n;
  for (let tries = 0; n === undefined; tries++) {
    assert.ok(tries < 10, 'the exact fixture settles in a few tries');
    flushed = zlib.deflateRawSync(Buffer.alloc(z), { finishFlush: zlib.constants.Z_SYNC_FLUSH });
    const rest = (z - 100 * (flushed.length + 5)) % 99;
    if (rest === 0) n = (z - 100 * (flushed.length + 5)) / 99;
    else z += 99 - rest;
  }
  const block = Buffer.alloc(5);
  block[0] = 0x01; // the last block, stored
  block.writeUInt16LE(n, 1);
  block.writeUInt16LE(n ^ 0xffff, 3);
  const stream = Buffer.concat([flushed, block, Buffer.alloc(n)]);
  const exact = Buffer.alloc(z + n);
  assert.equal(exact.length, 100 * stream.length, 'the fixture expands exactly 100 times');
  assert.ok(readZip(forge([{ name: 'exact.bin', data: exact, compressed: stream }])).files[0].data.equals(exact));
});

test('overlapping entries (one compressed stream counted many times) are refused', () => {
  // outer.bin is stored, and its bytes are a whole local entry for inner.txt. Both are listed, each
  // name matches its local header, and neither runs into the central directory: only the overlap
  // check stands between this and inner.txt's data being counted twice.
  const inner = { name: 'inner.txt', data: 'inner '.repeat(100) };
  const alone = forge([inner]);
  const innerEntry = alone.subarray(0, alone.readUInt32LE(alone.length - 6));
  const nested = forge([
    { name: 'outer.bin', data: innerEntry, method: 0 },
    { ...inner, local: 30 + 'outer.bin'.length, centralOnly: true },
  ]);
  refuses(nested, 'overlap', /"inner\.txt" overlaps "outer\.bin"/);

  // A directory entry pointed at another entry's local header is caught by the name first (both
  // are deflated, so the method agrees).
  const zip = writeZip([{ name: 'a.txt', data: 'x'.repeat(5000) }, { name: 'b.txt', data: 'y'.repeat(100) }]);
  const cd = zip.readUInt32LE(zip.length - 6);
  const second = cd + 46 + 'a.txt'.length;
  const forged = Buffer.from(zip);
  forged.writeUInt32LE(0, second + 42);
  refuses(forged, 'bad-zip', /"b\.txt" has a different name in its local header/);
  // Two directory entries naming one local entry: under another name, or under the same one.
  const twice = forge([{ name: 'x1.txt', data: 'abc' }, { name: 'x2.txt', data: 'abc', local: 0, centralOnly: true }]);
  refuses(twice, 'bad-zip', /"x2\.txt" has a different name in its local header/);
  const same = forge([{ name: 'x1.txt', data: 'abc' }, { name: 'x1.txt', data: 'abc', local: 0, centralOnly: true }]);
  refuses(same, 'duplicate', /"x1\.txt" appears twice/);
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
  refuses(forge([{ name: 'a.txt', data: 'hello', flags: 0x840 }]), 'unsupported', /encrypted/); // strong encryption alone
  refuses(forge([{ name: 'a.txt', data: 'hello', method: 12, compressed: Buffer.from('bz') }]), 'unsupported', /method 12/);
  refuses(forge([{ name: 'a.txt', data: 'x' }], { zip64Locator: true }), 'unsupported', /ZIP64/);
  refuses(forge([{ name: 'a.txt', data: 'x' }], { entriesOverride: 0xffff }), 'unsupported', /ZIP64/);
});

test('bytes after the end of an entry\'s compressed stream are refused: no file and no checksum covers them', () => {
  const body = Buffer.from('hello '.repeat(50));
  const stream = zlib.deflateRawSync(body);
  // A whole local entry hidden inside a.txt's data, where a streaming reader would find it.
  const extra = writeZip([{ name: 'evil.js', data: 'alert(1)' }]);
  const hidden = extra.subarray(0, extra.readUInt32LE(extra.length - 6));
  refuses(forge([{ name: 'a.txt', data: body, compressed: Buffer.concat([stream, hidden]) }]), 'trailing-data', /bytes after its compressed data/);
  refuses(forge([{ name: 'a.txt', data: body, compressed: Buffer.concat([stream, Buffer.from('JUNK')]) }]), 'trailing-data', /4 bytes after/);
  assert.ok(readZip(forge([{ name: 'a.txt', data: body, compressed: stream }])).files[0].data.equals(body));
});

test('a central directory with room for more than its records is refused', () => {
  // A record hidden past the count: a tool that walks the directory by its size sees hidden.js.
  const other = writeZip([{ name: 'hidden.js', data: 'evil' }]);
  const hidden = other.subarray(other.readUInt32LE(other.length - 6), other.length - 22);
  refuses(forge([{ name: 'a.txt', data: 'x' }], { cdExtra: hidden }), 'bad-zip', /^The central directory is damaged\.$/);
});

test('an entry whose declared data runs into the central directory is refused', () => {
  const data = 'hello '.repeat(20);
  const compressedSize = zlib.deflateRawSync(Buffer.from(data)).length + 10;
  refuses(forge([{ name: 'a.txt', data, compressedSize }]), 'bad-zip', /"a\.txt" runs into the central directory/);
});

test('a local header that says encrypted where the directory says not is refused', () => {
  refuses(forge([{ name: 'a.txt', data: 'hello', localFlags: 0x801 }]), 'bad-zip', /"a\.txt" has a local header that disagrees with the directory/);
  refuses(forge([{ name: 'a.txt', data: 'hello', localFlags: 0x840 }]), 'bad-zip', /disagrees with the directory/); // strong encryption
});

test('multi-disk (spanned) archives are refused', () => {
  const one = [{ name: 'a.txt', data: 'x' }];
  refuses(forge(one, { disk: 1 }), 'unsupported', /Multi-part/);
  refuses(forge(one, { cdDisk: 1 }), 'unsupported', /Multi-part/);
  refuses(forge([...one, { name: 'b.txt', data: 'y' }], { onDisk: 1 }), 'unsupported', /Multi-part/); // 1 of 2 on this disk
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
