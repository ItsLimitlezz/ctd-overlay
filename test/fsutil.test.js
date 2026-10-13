import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync, fileStamp, moveAside } from '../src/fsutil.js';
import { tempDir } from './helpers.js';

test('atomicWriteFileSync creates and replaces a file and leaves no temp files behind', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'state.json');
  atomicWriteFileSync(file, '{"a":1}');
  assert.equal(readFileSync(file, 'utf8'), '{"a":1}');
  atomicWriteFileSync(file, '{"a":2}');
  assert.equal(readFileSync(file, 'utf8'), '{"a":2}');
  assert.deepEqual(readdirSync(dir), ['state.json']);
});

test('moveAside renames a file to <name>.corrupt-<timestamp>', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'skp.db');
  writeFileSync(file, 'garbage');
  const when = new Date(Date.UTC(2026, 9, 10, 21, 30, 5, 123));
  const aside = moveAside(file, when);
  assert.equal(path.basename(aside), 'skp.db.corrupt-2026-10-10T21-30-05-123Z');
  assert.equal(existsSync(file), false);
  assert.equal(readFileSync(aside, 'utf8'), 'garbage');
});

test('fileStamp has no characters Windows forbids in file names', () => {
  assert.doesNotMatch(fileStamp(), /[:<>"/\\|?*]/);
});
