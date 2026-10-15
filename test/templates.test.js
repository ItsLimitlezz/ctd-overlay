import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { startPlatform } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { pickCanvas } from '../src/templates/registry.js';
import { defer, DIAG_DIR, memoryLogger, packTemplate, signedIn, tempDir } from './helpers.js';

// A running platform, and the API as the command line calls it (its local token).
async function start(t) {
  const root = tempDir(t);
  const config = loadConfig({ argv: ['--port', '0'], env: { SKP_DATA_DIR: path.join(root, 'data'), SKP_CONFIG_DIR: path.join(root, 'config') } });
  const platform = await startPlatform(config, { log: memoryLogger().log });
  defer(t, () => platform.stop());
  const get = async (p) => {
    const res = await fetch(`${platform.url}${p}`, { headers: signedIn(platform) });
    const type = res.headers.get('content-type') || '';
    return { status: res.status, type, body: /json/.test(type) ? await res.json() : await res.text() };
  };
  return { platform, get };
}

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

test('every preview a template lists is served at the URL the API gives: in a subfolder, with a space, # or % in its name (03 §3.4)', async (t) => {
  const { platform, get } = await start(t);
  const names = ['previews/sub/a b.svg', 'previews/x#1.svg', 'previews/100%.svg'];
  const svg = (i) => `<svg xmlns="http://www.w3.org/2000/svg"><title>${i}</title></svg>`;
  platform.templates.install(packTemplate(DIAG_DIR, { manifest: { id: 'dev.skp.sample', version: '1.0.0', previews: names }, files: Object.fromEntries(names.map((n, i) => [n, svg(i)])) }), { actor: 'test' });
  const { previews } = (await get('/api/v1/templates/dev.skp.sample')).body;
  assert.equal(previews.length, names.length);
  for (const [i, url] of previews.entries()) {
    const img = await get(url);
    assert.deepEqual([img.status, img.type, img.body], [200, 'image/svg+xml', svg(i)], `${names[i]} at ${url}`);
  }
  // Only the previews: not a folder, not another file of the package, nothing outside it.
  for (const p of ['previews/sub', 'previews/..%2Ftemplate.json', 'previews/..%2F..%2F..%2Finstall.json', 'previews/sub%2F..%2F..%2Ftemplate.json', 'template.json']) {
    assert.equal((await get(`/api/v1/templates/dev.skp.sample/versions/1.0.0/${p}`)).status, 404, p);
  }
});

test('a template\'s versions are a list like any other: { items, next }, newest first by SemVer (03 §3.1)', async (t) => {
  const { platform, get } = await start(t);
  for (const version of ['1.2.0', '1.10.0', '1.9.0']) platform.templates.install(packTemplate(DIAG_DIR, { manifest: { id: 'dev.skp.sample', version } }), { actor: 'test' });
  const base = '/api/v1/templates/dev.skp.sample/versions';
  const all = (await get(base)).body;
  assert.deepEqual([all.items.map((v) => v.version), all.next], [['1.10.0', '1.9.0', '1.2.0'], undefined]);
  const first = (await get(`${base}?limit=2`)).body;
  assert.deepEqual(first.items.map((v) => v.version), ['1.10.0', '1.9.0']);
  const rest = (await get(`${base}?limit=2&cursor=${first.next}`)).body;
  assert.deepEqual([rest.items.map((v) => v.version), rest.next], [['1.2.0'], undefined]);
  assert.equal((await get(`${base}?limit=0`)).status, 422);
  assert.equal((await get('/api/v1/templates/dev.skp.nothing/versions')).status, 404);
});
