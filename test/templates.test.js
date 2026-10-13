import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickCanvas } from '../src/templates/registry.js';

const manifest = {
  canvases: [
    { id: 'h', width: 1920, height: 1080, default: true },
    { id: 'v', width: 1080, height: 1920 },
    { id: '720x1280', width: 1280, height: 720 }, // an id that reads like a size
  ],
};

test('pickCanvas takes an id, or <w>x<h> matched against the declared sizes (01 §1.4)', () => {
  assert.equal(pickCanvas(manifest, 'v').id, 'v');
  assert.equal(pickCanvas(manifest, '1080x1920').id, 'v');
  assert.equal(pickCanvas(manifest, '1920x1080').id, 'h');
  assert.equal(pickCanvas(manifest, '720x1280').id, '720x1280', 'an id wins over a size');
  assert.equal(pickCanvas(manifest, '1280x720').id, '720x1280');
});

test('pickCanvas falls back to the default canvas, then the first', () => {
  for (const requested of [null, undefined, '', 'square', '1000x1000', '1080X1920', ' 1080x1920', '1080x1920px']) {
    assert.equal(pickCanvas(manifest, requested).id, 'h', String(requested));
  }
  assert.equal(pickCanvas({ canvases: [{ id: 'a', width: 1, height: 2 }, { id: 'b', width: 3, height: 4 }] }, 'nope').id, 'a');
});
