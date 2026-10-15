import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { startPlatform } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { BOOT_BADGE, injectRuntime, overlayCsp } from '../src/overlays/routes.js';
import { DIAG, DIAG_DIR, defer, FIXTURE_TEMPLATES, memoryLogger, packTemplate, startWithOverlay, tempDir, withKey } from './helpers.js';

// Reads SSE frames from a fetch response; each call returns the next frame or throws on timeout.
function frames(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  return async function next(timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const i = buf.indexOf('\n\n');
      if (i >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (block.startsWith(':')) return { comment: block.slice(2) };
        const f = {};
        for (const line of block.split('\n')) {
          const c = line.indexOf(': ');
          f[line.slice(0, c)] = line.slice(c + 2);
        }
        return { id: f.id, event: f.event, env: JSON.parse(f.data) };
      }
      const left = deadline - Date.now();
      if (left <= 0) throw new Error('timed out waiting for an SSE frame');
      const chunk = await Promise.race([reader.read(), new Promise((r) => setTimeout(() => r({ timeout: true }), left))]);
      if (chunk.timeout) continue;
      if (chunk.done) return { done: true };
      buf += decoder.decode(chunk.value, { stream: true });
    }
  };
}

// The runtime settings the page carries in <meta name="skp">.
function pageMeta(html) {
  const attr = /<meta name="skp" content="([^"]*)">/.exec(html)[1];
  return JSON.parse(attr.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
}

// A GET with the path sent exactly as written (fetch would normalize it); { status, body }.
function rawGet(port, rawPath) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: rawPath }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}

test('the page is the entry document with the runtime injected first in <head>', async (t) => {
  const { base, build } = await startWithOverlay(t);
  const res = await fetch(base);
  assert.equal(res.status, 200);
  const html = await res.text();
  const head = html.indexOf('<head>') + '<head>'.length;
  assert.equal(html.indexOf(`<base href="/o/diag-1/t/${build}/">`), head);
  const sdk = html.search(/<script crossorigin src="\/sdk\/v1\/sk\.js\?v=[0-9a-f]{12}"><\/script>/);
  assert.ok(sdk > 0 && sdk < html.indexOf('template.css'), 'the SDK comes before the template\'s assets');
  assert.match(html, /<script crossorigin src="template\.js"><\/script>/);
  const meta = pageMeta(html);
  assert.equal(meta.slug, 'diag-1');
  assert.equal(meta.build, build);
  assert.deepEqual(meta.canvas, { id: 'h', width: 1920, height: 1080 });
  assert.deepEqual(meta.template, { id: 'dev.skp.diagnostic', version: '1.0.0' });
  assert.deepEqual(meta.consumes, { state: ['custom.*'], events: ['custom.*'], chat: null });
  assert.deepEqual(meta.settings, { accent: '#16e0ff' }, 'the saved settings, for ?mock=1');
  assert.ok(html.indexOf('<body>') < html.indexOf('data-skp-boot'), 'the boot badge is in the body');
});

test('?canvas= picks a declared canvas by id or as <w>x<h> (01 §1.4)', async (t) => {
  const { base } = await startWithOverlay(t);
  const canvas = async (q) => pageMeta(await (await fetch(`${base}?canvas=${q}`)).text()).canvas;
  assert.deepEqual(await canvas('v'), { id: 'v', width: 1080, height: 1920 });
  assert.deepEqual(await canvas('1080x1920'), { id: 'v', width: 1080, height: 1920 });
  assert.deepEqual(await canvas('1920x1080'), { id: 'h', width: 1920, height: 1080 });
  assert.deepEqual(await canvas('720x1280'), { id: 'h', width: 1920, height: 1080 }); // undeclared: the default
});

test('the page sends the overlay CSP and caching rules (04 §4.8, 03 §3.4)', async (t) => {
  const { base } = await startWithOverlay(t);
  const res = await fetch(base);
  assert.equal(res.headers.get('content-security-policy'), overlayCsp({}));
  assert.match(res.headers.get('content-security-policy'), /script-src 'self'; .*connect-src 'self'; .*base-uri 'self'/);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
});

test('template files are served under the build hash, immutable; anything else is 404', async (t) => {
  const { base, build } = await startWithOverlay(t);
  const css = await fetch(`${base}/t/${build}/template.css`);
  assert.equal(css.status, 200);
  assert.equal(css.headers.get('content-type'), 'text/css; charset=utf-8');
  assert.equal(css.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.equal((await fetch(`${base}/t/${build}/previews/diagnostic.svg`)).headers.get('content-type'), 'image/svg+xml');
  assert.equal((await fetch(`${base}/t/0000000000000000/template.css`)).status, 404);
  assert.equal((await fetch(`${base}/t/${build}/missing.css`)).status, 404);
  assert.equal((await fetch(`${base}/t/${build}/previews`)).status, 404);
});

test('an encoded ../ never reaches past the template\'s files: not its receipt, not the data directory', async (t) => {
  const { platform, build, config } = await startWithOverlay(t);
  const served = platform.overlays.resolve('diag-1').template.dir; // <dataDir>/templates/<id>/<build>/package
  const secret = `not for overlays ${Math.random()}`;
  writeFileSync(path.join(config.dataDir, 'leak.txt'), secret);
  // Both targets exist, so a 404 means the route refused them, not that nothing was there.
  const receipt = readFileSync(path.join(served, '..', 'install.json'), 'utf8');
  assert.match(receipt, /"installedAt"/);
  assert.ok(existsSync(path.join(served, '..', '..', '..', '..', 'leak.txt')));
  // The %5c (backslash) forms only matter where backslash separates paths (Windows); elsewhere
  // they name a file that doesn't exist.
  const paths = [
    '../install.json', '%2e%2e/install.json', 'previews/../../install.json', 'previews/%2e%2e/%2e%2e/install.json',
    '..%2finstall.json', '%2e%2e%2finstall.json', '..%5cinstall.json', 'previews/..%2f..%2finstall.json',
    'previews%2f..%2f..%2finstall.json', 'previews/..%5c..%5cinstall.json',
    '..%2f..%2f..%2f..%2fleak.txt', '%2e%2e%5c%2e%2e%5c%2e%2e%5c%2e%2e%5cleak.txt',
  ];
  for (const p of paths) {
    const { status, body } = await rawGet(platform.port, `/o/diag-1/t/${build}/${p}`);
    assert.equal(status, 404, p);
    assert.ok(!body.includes('installedAt') && !body.includes(secret), `${p} leaked a file`);
  }
});

test('template files and the SDK allow any origin, errors included, for the sandboxed preview', async (t) => {
  const { platform, base, build } = await startWithOverlay(t);
  const urls = [
    [`${base}/t/${build}/template.js`, 200],
    [`${base}/t/${build}/missing.js`, 404],
    [`${base}/t/0000000000000000/template.js`, 404], // another build
    [`${platform.url}/o/nope/t/${build}/template.js`, 404], // no such overlay
    [`${platform.url}/sdk/v1/sk.js`, 200],
    [`${platform.url}/sdk/v1/mock.js`, 200],
    [`${platform.url}/sdk/v1/nope.js`, 404], // from the router
  ];
  for (const [url, status] of urls) {
    const res = await fetch(url);
    await res.arrayBuffer();
    assert.equal(res.status, status, url);
    assert.equal(res.headers.get('access-control-allow-origin'), '*', url);
  }
  const wrongMethod = await fetch(`${platform.url}/sdk/v1/sk.js`, { method: 'POST' });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get('access-control-allow-origin'), '*');
});

test('an unknown slug answers as a missing or wrong key does: nothing says which slugs exist', async (t) => {
  const { platform } = await startWithOverlay(t, { slug: 'main', keyed: true });
  // Each answer with its slug taken out, which the path (instance) and the hint name.
  const answer = async (slug, query) => {
    const res = await fetch(`${platform.url}/o/${slug}/snapshot${query}`);
    return { status: res.status, type: res.headers.get('content-type'), body: (await res.text()).replaceAll(slug, '<slug>') };
  };
  for (const query of ['', '?key=skp_ovl_wrong']) {
    const known = await answer('main', query);
    assert.equal(known.status, 401);
    assert.deepEqual(await answer('nope', query), known, query);
  }
  const { detail } = JSON.parse((await answer('nope', '')).body);
  assert.match(detail, /No overlay here has this slug and key/);
  assert.match(detail, /skp overlay url <slug>/, 'still says what to do');
});

test('the snapshot has the cursor, the build, the overlay settings and what the template consumes', async (t) => {
  const { platform, base, build } = await startWithOverlay(t);
  platform.bus.setState('custom.diag.counter', 3);
  platform.bus.setState('obs.scene', 'Live'); // not consumed
  const snap = await (await fetch(`${base}/snapshot`)).json();
  assert.equal(snap.cursor, platform.bus.cursor());
  assert.equal(snap.build, build);
  assert.deepEqual(snap.state, { 'custom.diag.counter': 3, 'overlay.settings': { accent: '#16e0ff' } });
});

test('a key set to null is absent from the snapshot, not null (02 §2.2)', async (t) => {
  const { platform, base } = await startWithOverlay(t);
  platform.bus.setState('custom.diag.counter', 3);
  platform.bus.setState('custom.diag.counter', null);
  const snap = await (await fetch(`${base}/snapshot`)).json();
  assert.equal('custom.diag.counter' in snap.state, false);
});

test('poll returns what happened after the cursor; an expired cursor is 410', async (t) => {
  const { platform, base, build } = await startWithOverlay(t);
  const { cursor } = await (await fetch(`${base}/snapshot`)).json();
  platform.bus.publish('custom.diag.tick', { n: 1 });
  platform.bus.publish('custom.diag.tick', { n: 2 });
  const body = await (await fetch(`${base}/poll?cursor=${cursor}`)).json();
  assert.deepEqual(body.envelopes.map((e) => e.data.n), [1, 2]);
  assert.equal(body.cursor, body.envelopes[1].id);
  assert.equal(body.build, build);
  assert.equal(typeof body.ts, 'number');
  const gone = await fetch(`${base}/poll?cursor=00000000000000000000000000`);
  assert.equal(gone.status, 410);
  assert.equal(gone.headers.get('content-type'), 'application/problem+json');
  assert.equal((await fetch(`${base}/poll`)).status, 410);
});

test('a well-formed cursor from the future (a run whose clock was ahead) is 410 too', async (t) => {
  const { base } = await startWithOverlay(t);
  const future = '7ZZZZZZZZZZZZZZZZZZZZZZZZZ';
  assert.equal((await fetch(`${base}/poll?cursor=${future}`)).status, 410);
  assert.equal((await fetch(`${base}/stream?cursor=${future}`)).status, 410);
  assert.equal((await fetch(`${base}/stream`, { headers: { 'last-event-id': future } })).status, 410);
});

test('the stream sends backlog, then live envelopes, as id/event/data frames', async (t) => {
  const { platform, base, build } = await startWithOverlay(t);
  const { cursor } = await (await fetch(`${base}/snapshot`)).json();
  platform.bus.publish('custom.diag.tick', { n: 1 }); // before the stream: backlog
  const ctrl = new AbortController();
  defer(t, () => ctrl.abort());
  const res = await fetch(`${base}/stream?cursor=${cursor}`, { signal: ctrl.signal });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  const next = frames(res);
  const open = await next();
  assert.match(open.comment, new RegExp(`^open \\d{13} ${build}$`));
  const first = await next();
  assert.equal(first.event, 'custom.diag.tick');
  assert.equal(first.id, first.env.id);
  assert.equal(first.env.data.n, 1);
  platform.bus.setState('custom.diag.counter', 7);
  const second = await next();
  assert.equal(second.event, 'state.changed');
  assert.deepEqual(second.env.data, { key: 'custom.diag.counter', value: 7 });
});

test('Last-Event-ID resumes a stream; an expired one gets 410', async (t) => {
  const { platform, base } = await startWithOverlay(t);
  const a = platform.bus.publish('custom.diag.tick', { n: 1 });
  platform.bus.publish('custom.diag.tick', { n: 2 });
  const ctrl = new AbortController();
  defer(t, () => ctrl.abort());
  const res = await fetch(`${base}/stream`, { headers: { 'last-event-id': a.id }, signal: ctrl.signal });
  const next = frames(res);
  await next(); // ": open"
  assert.equal((await next()).env.data.n, 2);
  assert.equal((await fetch(`${base}/stream?cursor=00000000000000000000000000`)).status, 410);
});

test('an idle stream gets a heartbeat comment, with server time and the overlay\'s current build', async (t) => {
  const { base, build } = await startWithOverlay(t, { heartbeatMs: 50 });
  const { cursor } = await (await fetch(`${base}/snapshot`)).json();
  const ctrl = new AbortController();
  defer(t, () => ctrl.abort());
  const next = frames(await fetch(`${base}/stream?cursor=${cursor}`, { signal: ctrl.signal }));
  await next();
  assert.match((await next(1000)).comment, new RegExp(`^hb \\d{13} ${build}$`));
});

test('a stream that outlives a change of pin hears the new build in its heartbeats', async (t) => {
  const sample = (version) => packTemplate(DIAG_DIR, { manifest: { id: 'dev.skp.sample', version } });
  const { platform, base, build, overlay } = await startWithOverlay(t, {
    heartbeatMs: 50, template: { id: 'dev.skp.sample', version: '1.0.0' }, install: [sample('1.0.0'), sample('1.1.0')],
  });
  const newBuild = platform.templates.get('dev.skp.sample', '1.1.0').build;
  assert.notEqual(newBuild, build);
  const { cursor } = await (await fetch(`${base}/snapshot`)).json();
  const ctrl = new AbortController();
  defer(t, () => ctrl.abort());
  const next = frames(await fetch(`${base}/stream?cursor=${cursor}`, { signal: ctrl.signal }));
  assert.match((await next()).comment, new RegExp(`^open \\d{13} ${build}$`));

  // Re-pinned without a channel reset (an upgrade would end the stream), so only the heartbeat
  // can tell this page to reload.
  const doc = platform.store.get('overlays', overlay.id);
  platform.store.put('overlays', doc.id, { ...doc.data, template: { id: 'dev.skp.sample', version: '1.1.0' } }, { ifRev: doc.rev });
  platform.overlays.reopen('dev.skp.sample', '1.1.0');
  const changedAt = Date.now();

  // Heartbeats already on their way may still name the old build; the first one stamped after the
  // change must name the new one.
  for (let i = 0; ; i++) {
    assert.ok(i < 100, 'no heartbeat after the change');
    const f = await next(1000);
    assert.notEqual(f.done, true, 'the stream ended');
    const hb = /^hb (\d{13}) (\S+)$/.exec(f.comment || '');
    if (!hb || Number(hb[1]) <= changedAt) continue;
    assert.equal(hb[2], newBuild);
    break;
  }
});

test('deleting the overlay ends its open streams', async (t) => {
  const { platform, base, overlay } = await startWithOverlay(t);
  const { cursor } = await (await fetch(`${base}/snapshot`)).json();
  const next = frames(await fetch(`${base}/stream?cursor=${cursor}`));
  await next();
  platform.overlays.remove(overlay.id);
  assert.deepEqual(await next(), { done: true });
  assert.equal((await fetch(base)).status, 401, 'gone: answered as an unknown slug');
});

test('a new key ends the streams opened with the old one, and asking for the key ends those opened without', async (t) => {
  const { platform, base, key } = await startWithOverlay(t, { keyed: true });
  const open = async (k) => {
    const { cursor } = await (await fetch(withKey(`${base}/snapshot`, k))).json();
    const ctrl = new AbortController();
    defer(t, () => ctrl.abort());
    const next = frames(await fetch(withKey(`${base}/stream?cursor=${cursor}`, k), { signal: ctrl.signal }));
    assert.match((await next()).comment, /^open /);
    return next;
  };
  const old = await open(key);
  platform.overlays.rotateKey('diag-1');
  assert.deepEqual(await old(), { done: true }, 'a leaked URL stops showing anything at once');
  platform.overlays.setKeyRequired('diag-1', false);
  const keyless = await open(undefined);
  platform.overlays.setKeyRequired('diag-1', false); // no change: the stream goes on
  platform.bus.publish('custom.diag.tick', { n: 1 });
  assert.equal((await keyless()).env.data.n, 1);
  platform.overlays.setKeyRequired('diag-1', true);
  assert.deepEqual(await keyless(), { done: true });
  assert.equal((await fetch(`${base}/snapshot`)).status, 401);
});

// Opens a stream with plain http (Node's fetch pools connections, like a browser) and resolves
// with the status once the response starts.
function openStream(t, url, userAgent = 'OBS/31.1', headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers: { 'user-agent': userAgent, ...headers } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); resolve({ status: res.statusCode, headers: res.headers, close: () => {} }); return; }
      res.once('data', () => resolve({ status: 200, close: () => req.destroy() }));
    });
    req.on('error', () => {});
    defer(t, () => req.destroy());
    setTimeout(() => reject(new Error('stream did not respond')), 3000).unref();
  });
}

test('one browser gets four live streams; further overlays are told to poll (01 §1.5)', async (t) => {
  const { base, entries } = await startWithOverlay(t);
  const { cursor } = await (await fetch(`${base}/snapshot`)).json();
  const url = `${base}/stream?cursor=${cursor}`;
  const streams = [];
  for (let i = 0; i < 4; i++) streams.push(await openStream(t, url));
  assert.deepEqual(streams.map((s) => s.status), [200, 200, 200, 200]);

  const fifth = await openStream(t, url);
  assert.equal(fifth.status, 429);
  assert.equal(fifth.headers['retry-after'], '60');
  assert.equal(fifth.headers['content-type'], 'application/problem+json');

  // Another browser (the operator's laptop on the same address) has its own allowance.
  assert.equal((await openStream(t, url, 'Mozilla/5.0 Chrome/141')).status, 200);

  // A stream closing frees its slot.
  streams[0].close();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal((await openStream(t, url)).status, 200);
  assert.equal(entries.filter((e) => /live-stream limit/.test(e.msg)).length, 1);
});

test('behind a trusted proxy, a browser is the address it forwarded: two sites never share four streams', async (t) => {
  const root = tempDir(t);
  const config = loadConfig({ argv: ['--port', '0'], env: { SKP_DATA_DIR: path.join(root, 'd'), SKP_CONFIG_DIR: path.join(root, 'c'), SKP_TRUST_PROXY: '127.0.0.1' } });
  const { log, entries } = memoryLogger();
  const platform = await startPlatform(config, { log, templateDirs: [FIXTURE_TEMPLATES] });
  defer(t, () => platform.stop());
  platform.overlays.create({ slug: 'diag-1', template: DIAG, settings: {} });
  platform.overlays.setKeyRequired('diag-1', false);
  const base = `${platform.url}/o/diag-1`;
  const { cursor } = await (await fetch(`${base}/snapshot`)).json();
  // Two sites, both on the same OBS version, through the one proxy.
  const from = (address) => openStream(t, `${base}/stream?cursor=${cursor}`, 'OBS/31.1', { 'x-forwarded-for': address });
  const site = [];
  for (let i = 0; i < 4; i++) site.push(await from('203.0.113.10'));
  assert.deepEqual(site.map((s) => s.status), [200, 200, 200, 200]);
  assert.equal((await from('203.0.113.10')).status, 429);
  assert.equal((await from('198.51.100.20')).status, 200, 'the other site has its own four');
  assert.deepEqual(entries.filter((e) => /live-stream limit/.test(e.msg)).map((e) => e.context.address), ['203.0.113.10']);
});

test('overlays survive a restart, with the same slug and settings', async (t) => {
  const root = tempDir(t);
  const config = loadConfig({ argv: ['--port', '0'], env: { SKP_DATA_DIR: path.join(root, 'd'), SKP_CONFIG_DIR: path.join(root, 'c') } });
  const first = await startPlatform(config, { log: memoryLogger().log });
  first.overlays.create({ slug: 'friday-main', template: DIAG, settings: { accent: 'gold' } });
  const key = first.overlays.key('friday-main');
  await first.stop();
  const second = await startPlatform(config, { log: memoryLogger().log });
  defer(t, () => second.stop());
  const snap = await (await fetch(`${second.url}/o/friday-main/snapshot?key=${key}`)).json();
  assert.deepEqual(snap.state['overlay.settings'], { accent: 'gold' });
  assert.equal(second.overlays.key('friday-main'), key, 'and the same key: the URL in OBS still works');
});

test('slugs must be valid and unique; the template must be installed', async (t) => {
  const { platform } = await startWithOverlay(t);
  assert.throws(() => platform.overlays.create({ slug: 'Diag 2', template: DIAG }), (e) => e.code === 'bad-slug');
  assert.throws(() => platform.overlays.create({ slug: 'diag-1', template: DIAG }), (e) => e.code === 'slug-taken');
  assert.throws(() => platform.overlays.create({ slug: 'x', template: { id: 'nope', version: '1.0.0' } }), (e) => e.code === 'no-template');
});

// POSTs `body` with node:http: chunked, or with a declared Content-Length of which only the first
// 1000 bytes are sent (a 413 must not wait for the rest). Resolves with the reply.
function postStream(url, body, { declare } = {}) {
  return new Promise((resolve, reject) => {
    const headers = declare ? { 'content-length': String(declare) } : { 'transfer-encoding': 'chunked' };
    const req = http.request(url, { method: 'POST', headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { text += d; });
      res.on('end', () => {
        req.destroy();
        resolve({ status: res.statusCode, headers: res.headers, text });
      });
    });
    req.on('error', reject); // after the reply, a no-op
    if (declare) {
      req.write(body.slice(0, 1000));
    } else {
      for (let i = 0; i < body.length; i += 1000) req.write(body.slice(i, i + 1000));
      req.end();
    }
  });
}

const DROPPED = 'template log entries were dropped by the rate limit';
const batch = (n, size = 20) => JSON.stringify({ entries: Array.from({ length: size }, (_, i) => ({ level: 'info', msg: `m${n}.${i}` })) });
const templateEntries = (entries) => entries.filter((e) => e.component === 'template' && e.msg !== DROPPED);
const dropReports = (entries) => entries.filter((e) => e.msg === DROPPED).map((e) => e.context.dropped);

test('SK.log entries reach the template log, 30 a minute per overlay, with a summary of the drops', async (t) => {
  const { platform, base, entries } = await startWithOverlay(t);
  for (let n = 0; n < 3; n++) {
    const res = await fetch(`${base}/log`, { method: 'POST', body: batch(n) });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
  }
  const logged = templateEntries(entries);
  assert.equal(logged.length, 30);
  assert.deepEqual(logged[0].context, { overlay: 'diag-1', template: 'dev.skp.diagnostic@1.0.0' });
  assert.equal(logged[29].msg, 'm1.9');
  assert.deepEqual(dropReports(entries), [10], 'at the first drop, without spending a token');
  await platform.stop();
  assert.deepEqual(dropReports(entries), [10, 20], 'drops still waiting for their minute are reported at shutdown');
});

test('drops at the tail of a flood are reported when the minute ends', async (t) => {
  const { base, entries } = await startWithOverlay(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (let n = 0; n < 3; n++) assert.equal((await postStream(`${base}/log`, batch(n))).status, 204);
  assert.deepEqual(dropReports(entries), [10]);
  t.mock.timers.tick(59000);
  assert.deepEqual(dropReports(entries), [10]); // at most once a minute
  t.mock.timers.tick(1000);
  assert.deepEqual(dropReports(entries), [10, 20]);
});

test('a clock stepped back does not silence the template log once the minute is up again', async (t) => {
  const { base, entries } = await startWithOverlay(t);
  const t0 = Date.now();
  t.mock.timers.enable({ apis: ['Date'], now: t0 });
  const post = (body) => fetch(`${base}/log`, { method: 'POST', body });
  await post(batch(0));
  await post(batch(1, 10)); // the minute's 30 spent
  t.mock.timers.setTime(t0 - 60000); // the clock steps back a minute
  await post(batch(2, 1)); // dropped: nothing refilled
  t.mock.timers.setTime(t0); // a minute after the step: the bucket is full again
  await post(batch(3, 1));
  // Unclamped, the step would have drained the bucket to -30 and this minute only back to 0.
  assert.deepEqual(templateEntries(entries).slice(30).map((e) => e.msg), ['m3.0']);
});

test('the log takes bodies up to 64 KiB, cuts each context to 2000 characters, and refuses more', async (t) => {
  const { base, entries } = await startWithOverlay(t);
  const body = JSON.stringify({ entries: [{ level: 'error', msg: 'big', context: { blob: 'x'.repeat(9000) } }] });
  const res = await fetch(`${base}/log`, { method: 'POST', body });
  assert.equal(res.status, 204);
  const big = entries.find((e) => e.msg === 'big');
  assert.equal(big.level, 'error');
  assert.equal(big.context.context.truncated.length, 2000);
  assert.ok(big.context.context.truncated.startsWith('{"blob":"xxx'));

  const tooBig = JSON.stringify({ entries: [{ msg: 'x'.repeat(70000) }] });
  for (const declare of [undefined, Buffer.byteLength(tooBig)]) {
    const what = declare ? 'declared length' : 'chunked';
    const r = await postStream(`${base}/log`, tooBig, { declare });
    assert.equal(r.status, 413, what);
    assert.equal(r.headers['content-type'], 'application/problem+json', what);
    assert.equal(r.headers['access-control-allow-origin'], '*', what);
    assert.equal(r.headers.connection, 'close', what);
    assert.match(JSON.parse(r.text).detail, /65536/, what);
  }
  assert.equal((await fetch(`${base}/log`, { method: 'POST', body: batch(0, 1) })).status, 204); // still serving
});

test('a log body that isn\'t { entries: [{ msg }] } is a 400; unknown levels are logged as warn', async (t) => {
  const { base, entries } = await startWithOverlay(t);
  const bad = ['nope', 'null', '5', '[]', '{"entries":"x"}', '{"level":"warn","msg":"no entries"}', '{"entries":[null]}', '{"entries":[{"msg":5}]}'];
  for (const body of bad) {
    const res = await fetch(`${base}/log`, { method: 'POST', body });
    assert.equal(res.status, 400, body);
    assert.equal(res.headers.get('content-type'), 'application/problem+json', body);
    assert.equal(res.headers.get('access-control-allow-origin'), '*', body);
    assert.match((await res.json()).detail, /"entries"/, body);
  }
  assert.equal(templateEntries(entries).length, 0);
  const res = await fetch(`${base}/log`, { method: 'POST', body: JSON.stringify({ entries: [{ level: 'debug', msg: 'quiet' }, { msg: 'no level' }] }) });
  assert.equal(res.status, 204);
  assert.deepEqual(templateEntries(entries).map((e) => [e.level, e.msg]), [['warn', 'quiet'], ['warn', 'no level']]);
});

test('injectRuntime handles documents with and without <head> or <html>', () => {
  const meta = { slug: 'a', note: '"quoted" <b>& \'single\'' };
  const full = injectRuntime('<!doctype html><html lang="en"><HEAD data-x="1"><title>t</title></HEAD><body></body></html>', 'a', 'b1', meta);
  assert.ok(full.startsWith('<!doctype html><html lang="en"><HEAD data-x="1"><base href="/o/a/t/b1/"><meta name="skp" content="'));
  const attr = /<meta name="skp" content="([^"]*)"><script crossorigin src="\/sdk\/v1\/sk.js"><\/script><title>/.exec(full)[1];
  assert.doesNotMatch(attr, /[<>"]/);
  const unescaped = attr.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  assert.deepEqual(JSON.parse(unescaped), meta);
  const noHead = injectRuntime('<html><body>x</body></html>', 'a', 'b1', meta);
  assert.ok(noHead.startsWith('<html><head><base'));
  const fragment = injectRuntime('<link rel="stylesheet" href="template.css">', 'a', 'b1', meta); // 04 §4.12
  assert.ok(fragment.startsWith('<!doctype html><html><head><base'));
  assert.ok(fragment.includes('</head><link rel="stylesheet" href="template.css">'));
  assert.ok(fragment.endsWith('</div>'), 'no <body>: the boot badge goes at the end');
});

test('injectRuntime ignores tags inside HTML comments', () => {
  const tags = '<base href="/o/a/t/b1/">';
  const headInComment = injectRuntime('<!doctype html><!-- the runtime goes in <head> --><html><head><title>t</title></head><body>x</body></html>', 'a', 'b1', {});
  assert.ok(headInComment.includes('<!-- the runtime goes in <head> --><html><head><base href'), 'the comment is untouched');
  assert.ok(headInComment.includes(`<body>${BOOT_BADGE}x`));
  const bodyInHead = injectRuntime('<html><head><!-- <body class="later"> --><title>t</title></head><body class="x">y</body></html>', 'a', 'b1', {});
  assert.ok(bodyInHead.includes('<!-- <body class="later"> --><title>'));
  assert.ok(bodyInHead.includes(`<body class="x">${BOOT_BADGE}y`));
  const htmlInComment = injectRuntime('<!-- <html lang="xx"> --><html><body>z</body></html>', 'a', 'b1', {});
  assert.ok(htmlInComment.startsWith(`<!-- <html lang="xx"> --><html><head>${tags}`));
  // An unclosed comment runs to the end, and <!--> is an empty comment, as HTML parses them.
  const odd = injectRuntime('<html><head><!--><title>t</title></head><body>w</body><!-- <body>', 'a', 'b1', {});
  assert.ok(odd.includes(`<head>${tags}`));
  assert.ok(odd.includes(`<body>${BOOT_BADGE}w</body><!-- <body>`));
  assert.ok(odd.endsWith('<!-- <body>'));
});

test('the entry\'s external scripts load with crossorigin, so the sandboxed preview sees their errors', () => {
  const entry =
    '<html><head><script src="a.js"></script><script>inline()</script>' +
    '<script crossorigin="use-credentials" src="b.js"></script><!-- <script src="c.js"></script> -->' +
    '<SCRIPT type="text/javascript"\nSRC=\'d.js\' data-note="<script src=x>"></SCRIPT>' +
    '<script data-src="e.js">inline2()</script><script type="module" src="f.mjs"></script></head><body></body></html>';
  const out = injectRuntime(entry, 'a', 'b1', {}, 'abc123');
  assert.match(out, /<head><base href="\/o\/a\/t\/b1\/"><meta name="skp" content="[^"]*"><script crossorigin src="\/sdk\/v1\/sk\.js\?v=abc123"><\/script>/);
  assert.ok(out.includes('<script crossorigin src="a.js"></script>'));
  assert.ok(out.includes('<script>inline()</script>'), 'inline scripts are left alone');
  assert.ok(out.includes('<script crossorigin="use-credentials" src="b.js">'), 'an explicit crossorigin is kept');
  assert.ok(out.includes('<!-- <script src="c.js"></script> -->'), 'comments are left alone');
  assert.ok(out.includes('<SCRIPT crossorigin type="text/javascript"\nSRC=\'d.js\' data-note="<script src=x>"></SCRIPT>'));
  assert.ok(out.includes('<script data-src="e.js">inline2()</script>'));
  assert.ok(out.includes('<script crossorigin type="module" src="f.mjs">'));
  assert.equal(out.match(/crossorigin/g).length, 5);
});

test('text that only looks like a tag (in attribute values, a script\'s code, a title) is never rewritten', () => {
  const entry =
    '<html><head data-note="<head>"><title><body> & <script src=t></title>' +
    '<script>const s = "<script src=x.js><body>";</script><style>a::after { content: "<body>"; }</style></head>' +
    '<body data-x="<body>"><img alt="<script src=y.js>"></body></html>';
  const out = injectRuntime(entry, 'a', 'b1', {});
  assert.ok(out.includes('<head data-note="<head>"><base href="/o/a/t/b1/">'), 'the runtime goes in the real <head>');
  assert.ok(out.includes('<title><body> & <script src=t></title>'));
  assert.ok(out.includes('"<script src=x.js><body>"'));
  assert.ok(out.includes('content: "<body>"'));
  assert.ok(out.includes(`<body data-x="<body>">${BOOT_BADGE}<img alt="<script src=y.js>">`), 'the badge goes in the real <body>');
  assert.equal(out.match(/crossorigin/g).length, 1); // the SDK's own tag
});

test('extra font hosts are allowed only when the manifest lists them', () => {
  const csp = overlayCsp({ fonts: ['https://fonts.googleapis.com/css2?family=Archivo', 'https://use.typekit.net/abc.css', 'http://insecure.example/x.css', 'not a url'] });
  assert.match(csp, /style-src 'self' 'unsafe-inline' https:\/\/fonts.googleapis.com https:\/\/use.typekit.net;/);
  assert.match(csp, /font-src 'self' https:\/\/fonts.gstatic.com data: https:\/\/use.typekit.net;/);
  assert.doesNotMatch(csp, /insecure/);
});
