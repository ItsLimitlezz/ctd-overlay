import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUlid, newId, ulidTime, ULID_PATTERN } from '../src/ids.js';

test('a ULID is 26 Crockford base32 characters carrying its creation time', () => {
  const ulid = createUlid();
  const t = Date.UTC(2026, 9, 10, 21, 30);
  const id = ulid(t);
  assert.match(id, ULID_PATTERN);
  assert.equal(ulidTime(id), t);
});

test('ULIDs made in the same millisecond still sort in creation order', () => {
  const ulid = createUlid();
  const t = Date.UTC(2027, 3, 1);
  const ids = Array.from({ length: 1000 }, () => ulid(t));
  assert.deepEqual([...ids].sort(), ids);
  assert.equal(new Set(ids).size, ids.length);
});

test('ULIDs stay ordered when the clock steps backwards', () => {
  const ulid = createUlid();
  const a = ulid(Date.UTC(2028, 0, 1, 0, 0, 1));
  const b = ulid(Date.UTC(2028, 0, 1, 0, 0, 0));
  assert.ok(b > a);
  assert.equal(ulidTime(b), ulidTime(a));
});

test('ULIDs from later milliseconds sort after earlier ones', () => {
  const ulid = createUlid();
  const a = ulid(Date.UTC(2029, 0, 1));
  const b = ulid(Date.UTC(2029, 0, 1) + 1);
  assert.ok(b > a);
  assert.equal(ulidTime(b) - ulidTime(a), 1);
});

test('resource IDs carry their type prefix and the current time', () => {
  const id = newId('ovl');
  assert.match(id, /^ovl_[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.ok(Math.abs(ulidTime(id) - Date.now()) < 60000);
});
