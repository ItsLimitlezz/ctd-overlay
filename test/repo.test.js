// Repository rules that CI enforces, so they can't drift silently.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('the core has no runtime dependencies (standard, decision 8)', () => {
  assert.deepEqual(Object.keys(pkg.dependencies || {}), []);
  assert.deepEqual(Object.keys(pkg.optionalDependencies || {}), []);
  assert.deepEqual(Object.keys(pkg.peerDependencies || {}), []);
});

test('it targets Node.js 24 or later', () => {
  assert.equal(pkg.engines.node, '>=24');
  assert.equal(pkg.type, 'module');
});
