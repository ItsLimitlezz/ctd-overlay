// The overlays API's writes (03 §3.1, §3.4): a PATCH saves every field it carries or none, and an
// upgrade's flags are true or false, so what is done is what is recorded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { startPlatform } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { DIAG_DIR, defer, FIXTURE_TEMPLATES, memoryLogger, packTemplate, signedIn, tempDir, TESTBED } from './helpers.js';

async function start(t) {
  const root = tempDir(t);
  const config = loadConfig({ argv: ['--port', '0'], env: { SKP_DATA_DIR: path.join(root, 'data'), SKP_CONFIG_DIR: path.join(root, 'config') } });
  const platform = await startPlatform(config, { log: memoryLogger().log, templateDirs: [FIXTURE_TEMPLATES] });
  defer(t, () => platform.stop());
  const api = async (method, p, body, headers = {}) => {
    const res = await fetch(`${platform.url}/api/v1${p}`, { method, headers: signedIn(platform, { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }), body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
  };
  const audited = () => platform.audit.list({ action: 'overlay' }).items.map((e) => e.action).reverse();
  return { platform, api, audited };
}

test('a PATCH saves every field or none: a refused one leaves the settings, the slug, the ETag and the audit log as they were', async (t) => {
  const { platform, api, audited } = await start(t);
  for (const slug of ['main', 'other']) platform.overlays.create({ slug, template: TESTBED, settings: { size: 3 } });
  const read = async () => {
    const r = await api('GET', '/overlays/main');
    return { status: r.status, etag: r.headers.get('etag'), slug: r.body?.slug, settings: r.body?.settings, keyRequired: r.body?.keyRequired };
  };
  const before = await read();
  for (const [body, status, code] of [
    [{ settings: { size: 5 }, slug: 'other' }, 409, 'slug-taken'],
    [{ settings: { size: 6 }, slug: 'Bad Slug' }, 422, 'bad-slug'],
    [{ settings: { size: 7 }, slug: 7 }, 422, 'bad-slug'],
    [{ slug: 'renamed', keyRequired: false, settings: { size: 99 } }, 422, 'bad-settings'],
  ]) {
    const res = await api('PATCH', '/overlays/main', body, { 'if-match': before.etag });
    assert.deepEqual([res.status, res.body.type], [status, `https://skp.dev/errors/${code}`], JSON.stringify(body));
    assert.deepEqual(await read(), before, JSON.stringify(body));
  }
  assert.equal((await api('GET', '/overlays/renamed')).status, 404);
  assert.deepEqual(audited(), []);
  // Every field fine: one save, one revision.
  const done = await api('PATCH', '/overlays/main', { settings: { size: 5 }, slug: 'main-h', keyRequired: false }, { 'if-match': before.etag });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.deepEqual([done.body.slug, done.body.settings, done.body.keyRequired], ['main-h', { size: 5 }, false]);
  assert.equal(done.headers.get('etag'), before.etag.replace(/-r(\d+)"$/, (_, n) => `-r${Number(n) + 1}"`));
  assert.equal(platform.overlays.resolve('main-h').settings.size, 5, 'the overlay sees its new settings');
  assert.equal(platform.overlays.resolve('main'), undefined);
  assert.deepEqual(audited(), ['overlay.rename', 'overlay.key-required']);
  // Nothing to change: nothing saved.
  const same = await api('PATCH', '/overlays/main-h', { slug: 'main-h' });
  assert.equal(same.headers.get('etag'), done.headers.get('etag'));
});

test('an upgrade\'s flags are true or false: "true" is refused, never taken as a real upgrade with nothing in the audit log', async (t) => {
  const { platform, api, audited } = await start(t);
  for (const version of ['1.0.0', '1.1.0']) platform.templates.install(packTemplate(DIAG_DIR, { manifest: { id: 'dev.skp.sample', version } }), { actor: 'test' });
  platform.overlays.create({ slug: 'up', template: { id: 'dev.skp.sample', version: '1.0.0' }, settings: {} });
  const version = () => platform.overlays.resolve('up').doc.data.template.version;
  for (const [flag, value] of [['dryRun', 'true'], ['dryRun', 1], ['dryRun', 'false'], ['confirm', 'yes'], ['runMigrate', null]]) {
    const res = await api('POST', '/overlays/up/upgrade', { version: '1.1.0', [flag]: value });
    assert.deepEqual([res.status, res.body.type], [422, 'https://skp.dev/errors/invalid'], `${flag}: ${JSON.stringify(value)}`);
    assert.match(res.body.detail, new RegExp(`"${flag}" is true or false`));
    assert.equal(version(), '1.0.0', `${flag}: ${JSON.stringify(value)}`);
  }
  const dry = await api('POST', '/overlays/up/upgrade', { version: '1.1.0', dryRun: true });
  assert.deepEqual([dry.status, dry.body.to, version()], [200, '1.1.0', '1.0.0']);
  assert.deepEqual(audited(), []);
  const done = await api('POST', '/overlays/up/upgrade', { version: '1.1.0', dryRun: false });
  assert.deepEqual([done.status, done.body.overlay.template.version, version()], [200, '1.1.0', '1.1.0']);
  assert.deepEqual(audited(), ['overlay.upgrade'], 'what was done is what was recorded');
});
