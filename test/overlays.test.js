import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { startPlatform } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { injectRuntime, overlayCsp } from '../src/overlays/routes.js';
import { DIAG, defer, memoryLogger, startWithOverlay, tempDir } from './helpers.js';

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

function rawGet(port, rawPath) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: rawPath }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject);
  });
}

test('the page is the entry document with the runtime injected first in <head>', async (t) => {
  const { base, build } = await startWithOverlay(t);
  const res = await fetch(base);
  assert.equal(res.status, 200);
  const html = await res.text();
  const head = html.indexOf('<head>') + '<head>'.length;
  assert.equal(html.indexOf(`<base href="/o/diag-1/t/${build}/">`), head);
  assert.ok(html.indexOf('<script src="/sdk/v1/sk.js"></script>') < html.indexOf('template.css'));
  const meta = JSON.parse(/<meta name="skp" content="([^"]*)">/.exec(html)[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
  assert.equal(meta.slug, 'diag-1');
  assert.deepEqual(meta.canvas, { id: 'h', width: 1920, height: 1080, default: true });
  const v = await (await fetch(`${base}?canvas=v`)).text();
  assert.match(v, /&quot;id&quot;:&quot;v&quot;,&quot;width&quot;:1080/);
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
  const { platform, base, build } = await startWithOverlay(t);
  const css = await fetch(`${base}/t/${build}/template.css`);
  assert.equal(css.status, 200);
  assert.equal(css.headers.get('content-type'), 'text/css; charset=utf-8');
  assert.equal(css.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.equal((await fetch(`${base}/t/${build}/previews/diagnostic.svg`)).headers.get('content-type'), 'image/svg+xml');
  assert.equal((await fetch(`${base}/t/0000000000000000/template.css`)).status, 404);
  assert.equal((await fetch(`${base}/t/${build}/missing.css`)).status, 404);
  assert.equal((await fetch(`${base}/t/${build}/previews`)).status, 404);
  for (const p of ['%2e%2e/%2e%2e/package.json', '..%2f..%2fpackage.json', 'previews/..%5c..%5ctemplate.json', '%2e%2e%2f%2e%2e%2f%2e%2e%2fpackage.json']) {
    assert.equal(await rawGet(platform.port, `/o/diag-1/t/${build}/${p}`), 404, p);
  }
});

test('an unknown slug is a 404 that says so', async (t) => {
  const { platform } = await startWithOverlay(t);
  const res = await fetch(`${platform.url}/o/nope`);
  assert.equal(res.status, 404);
  assert.match((await res.json()).detail, /No overlay has the slug "nope"/);
});

test('the snapshot has the cursor, the overlay settings and what the template consumes', async (t) => {
  const { platform, base } = await startWithOverlay(t);
  platform.bus.setState('custom.diag.counter', 3);
  platform.bus.setState('obs.scene', 'Live'); // not consumed
  const snap = await (await fetch(`${base}/snapshot`)).json();
  assert.equal(snap.cursor, platform.bus.cursor());
  assert.deepEqual(snap.state, { 'custom.diag.counter': 3, 'overlay.settings': { accent: '#16e0ff' } });
});

test('poll returns what happened after the cursor; an expired cursor is 410', async (t) => {
  const { platform, base } = await startWithOverlay(t);
  const { cursor } = await (await fetch(`${base}/snapshot`)).json();
  platform.bus.publish('custom.diag.tick', { n: 1 });
  platform.bus.publish('custom.diag.tick', { n: 2 });
  const body = await (await fetch(`${base}/poll?cursor=${cursor}`)).json();
  assert.deepEqual(body.envelopes.map((e) => e.data.n), [1, 2]);
  assert.equal(body.cursor, body.envelopes[1].id);
  const gone = await fetch(`${base}/poll?cursor=00000000000000000000000000`);
  assert.equal(gone.status, 410);
  assert.equal(gone.headers.get('content-type'), 'application/problem+json');
  assert.equal((await fetch(`${base}/poll`)).status, 410);
});

test('the stream sends backlog, then live envelopes, as id/event/data frames', async (t) => {
  const { platform, base } = await startWithOverlay(t);
  const { cursor } = await (await fetch(`${base}/snapshot`)).json();
  platform.bus.publish('custom.diag.tick', { n: 1 }); // before the stream: backlog
  const ctrl = new AbortController();
  defer(t, () => ctrl.abort());
  const res = await fetch(`${base}/stream?cursor=${cursor}`, { signal: ctrl.signal });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  const next = frames(res);
  assert.deepEqual(await next(), { comment: 'open' });
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

test('an idle stream gets a heartbeat comment', async (t) => {
  const { base } = await startWithOverlay(t, { heartbeatMs: 50 });
  const { cursor } = await (await fetch(`${base}/snapshot`)).json();
  const ctrl = new AbortController();
  defer(t, () => ctrl.abort());
  const next = frames(await fetch(`${base}/stream?cursor=${cursor}`, { signal: ctrl.signal }));
  await next();
  assert.deepEqual(await next(1000), { comment: 'hb' });
});

test('deleting the overlay ends its open streams', async (t) => {
  const { platform, base, overlay } = await startWithOverlay(t);
  const { cursor } = await (await fetch(`${base}/snapshot`)).json();
  const next = frames(await fetch(`${base}/stream?cursor=${cursor}`));
  await next();
  platform.overlays.remove(overlay.id);
  assert.deepEqual(await next(), { done: true });
  assert.equal((await fetch(base)).status, 404);
});

// Opens a stream with plain http (Node's fetch pools connections, like a browser) and resolves
// with the status once the response starts.
function openStream(t, url, userAgent = 'OBS/31.1') {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers: { 'user-agent': userAgent } }, (res) => {
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

test('overlays survive a restart, with the same slug and settings', async (t) => {
  const root = tempDir(t);
  const config = loadConfig({ argv: ['--port', '0'], env: { SKP_DATA_DIR: path.join(root, 'd'), SKP_CONFIG_DIR: path.join(root, 'c') } });
  const first = await startPlatform(config, { log: memoryLogger().log });
  first.overlays.create({ slug: 'friday-main', template: DIAG, settings: { accent: 'gold' } });
  await first.stop();
  const second = await startPlatform(config, { log: memoryLogger().log });
  defer(t, () => second.stop());
  const snap = await (await fetch(`${second.url}/o/friday-main/snapshot`)).json();
  assert.deepEqual(snap.state['overlay.settings'], { accent: 'gold' });
});

test('slugs must be valid and unique; the template must be installed', async (t) => {
  const { platform } = await startWithOverlay(t);
  assert.throws(() => platform.overlays.create({ slug: 'Diag 2', template: DIAG }), (e) => e.code === 'bad-slug');
  assert.throws(() => platform.overlays.create({ slug: 'diag-1', template: DIAG }), (e) => e.code === 'slug-taken');
  assert.throws(() => platform.overlays.create({ slug: 'x', template: { id: 'nope', version: '1.0.0' } }), (e) => e.code === 'no-template');
});

test('injectRuntime handles documents with and without <head> or <html>', () => {
  const meta = { slug: 'a', note: '"quoted" <b>& \'single\'' };
  const full = injectRuntime('<!doctype html><html lang="en"><HEAD data-x="1"><title>t</title></HEAD><body></body></html>', 'a', 'b1', meta);
  assert.ok(full.startsWith('<!doctype html><html lang="en"><HEAD data-x="1"><base href="/o/a/t/b1/"><meta name="skp" content="'));
  const attr = /<meta name="skp" content="([^"]*)"><script src="\/sdk\/v1\/sk.js"><\/script><title>/.exec(full)[1];
  assert.doesNotMatch(attr, /[<>"]/);
  const unescaped = attr.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  assert.deepEqual(JSON.parse(unescaped), meta);
  const noHead = injectRuntime('<html><body>x</body></html>', 'a', 'b1', meta);
  assert.ok(noHead.startsWith('<html><head><base'));
  const fragment = injectRuntime('<link rel="stylesheet" href="template.css">', 'a', 'b1', meta); // 04 §4.12
  assert.ok(fragment.startsWith('<!doctype html><html><head><base'));
  assert.ok(fragment.endsWith('</head><link rel="stylesheet" href="template.css">'));
});

test('extra font hosts are allowed only when the manifest lists them', () => {
  const csp = overlayCsp({ fonts: ['https://fonts.googleapis.com/css2?family=Archivo', 'https://use.typekit.net/abc.css', 'http://insecure.example/x.css', 'not a url'] });
  assert.match(csp, /style-src 'self' 'unsafe-inline' https:\/\/fonts.googleapis.com https:\/\/use.typekit.net;/);
  assert.match(csp, /font-src 'self' https:\/\/fonts.gstatic.com data: https:\/\/use.typekit.net;/);
  assert.doesNotMatch(csp, /insecure/);
});
