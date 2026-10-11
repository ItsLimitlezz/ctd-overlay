// Limits on the SDK itself (04 §4.4): dependency-free and under 25 KB gzipped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const read = (name) => readFileSync(new URL(`../src/sdk/${name}`, import.meta.url), 'utf8');

test('sk.js is under 25 KB gzipped (04 §4.4)', () => {
  const size = gzipSync(read('sk.js'), { level: 9 }).length;
  assert.ok(size < 25 * 1024, `sk.js is ${size} bytes gzipped`);
});

test('sk.js imports nothing and loads no other script except the mock data in mock mode', () => {
  const code = read('sk.js');
  assert.doesNotMatch(code, /\bimport\s*[({'"]|\brequire\s*\(/);
  assert.deepEqual(code.match(/\.src\s*=\s*['"][^'"]+['"]/g), [".src = '/sdk/v1/mock.js'"]);
});
