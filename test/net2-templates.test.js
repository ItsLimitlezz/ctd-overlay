// A template's versions, page by page (03 §3.1), while versions come and go between the pages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { startPlatform } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { defer, DIAG_DIR, memoryLogger, packTemplate, signedIn, tempDir } from './helpers.js';

test('the versions\' cursor is a version: one installed or removed between pages neither repeats nor skips another', async (t) => {
  const root = tempDir(t);
  const config = loadConfig({ argv: ['--port', '0'], env: { SKP_DATA_DIR: path.join(root, 'data'), SKP_CONFIG_DIR: path.join(root, 'config') } });
  const platform = await startPlatform(config, { log: memoryLogger().log });
  defer(t, () => platform.stop());
  const install = (version) => platform.templates.install(packTemplate(DIAG_DIR, { manifest: { id: 'dev.skp.sample', version } }), { actor: 'test' });
  const page = async (query) => {
    const res = await fetch(`${platform.url}/api/v1/templates/dev.skp.sample/versions?${query}`, { headers: signedIn(platform) });
    const body = await res.json();
    return res.status === 200 ? { versions: body.items.map((v) => v.version), next: body.next } : { status: res.status, type: body.type };
  };
  for (const version of ['1.2.0', '1.10.0', '1.9.0', '1.2.0-rc.1']) install(version);

  const first = await page('limit=2');
  assert.deepEqual(first.versions, ['1.10.0', '1.9.0']);
  install('1.11.0'); // newer: it sorts before the cursor, on a page already read
  const second = await page(`limit=2&cursor=${first.next}`);
  assert.deepEqual(second, { versions: ['1.2.0', '1.2.0-rc.1'], next: undefined }, 'no 1.9.0 again');

  const top = await page('limit=1');
  assert.deepEqual(top.versions, ['1.11.0']);
  platform.templates.uninstall('dev.skp.sample', '1.11.0', { pinnedBy: platform.overlays.pinnedBy, actor: 'test' });
  const after = await page(`limit=2&cursor=${top.next}`);
  assert.deepEqual(after.versions, ['1.10.0', '1.9.0'], 'none skipped');
  assert.deepEqual(await page(`limit=2&cursor=${after.next}`), { versions: ['1.2.0', '1.2.0-rc.1'], next: undefined });

  // A cursor that isn't a version a page gave.
  for (const cursor of [Buffer.from('nope').toString('base64url'), '%25%25']) {
    const bad = await page(`cursor=${cursor}`);
    assert.equal(bad.status, 422, cursor);
    assert.match(bad.type, /\/invalid$/);
  }
});
