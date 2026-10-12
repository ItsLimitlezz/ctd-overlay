// A real browser for tests, with no dependencies: launches the installed Chrome or Edge headless and
// drives it over the Chrome DevTools Protocol with Node's built-in WebSocket client.
//
//   const browser = await launchBrowser(t);            // closed when the test ends
//   const page = await browser.open(url, { width: 1920, height: 1080 });
//   await page.waitFor('window.SK && SK.transport.mode === "stream"');
//   const n = await page.eval('document.querySelectorAll("[data-skp-scene-root]").length');
//   page.problems  // console errors, uncaught exceptions and CSP violations seen so far
//
// Set SKP_TEST_BROWSER to a browser executable's path to choose one. Without a browser, browserPath
// is undefined and browser tests skip, except on CI, where a missing browser is a failure.
//
// Every CDP command fails after 15 s unless given its own timeout (cdp.send's 4th argument,
// page.send's 3rd, page.eval's 2nd), so a page promise that never settles fails one test instead
// of hanging CI.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defer } from './helpers.js';

const SEND_TIMEOUT_MS = 15000;
const configured = process.env.SKP_TEST_BROWSER;
export const browserPath = findBrowser();
// A wrong SKP_TEST_BROWSER says so rather than quietly testing some other browser.
const noBrowser = configured && !browserPath
  ? `SKP_TEST_BROWSER does not exist: ${configured}`
  : 'no Chrome or Edge found (set SKP_TEST_BROWSER)';
export const browserSkip = browserPath || process.env.CI ? false : noBrowser;

function findBrowser() {
  if (configured) return existsSync(configured) ? configured : undefined;
  const env = process.env;
  const candidates = {
    win32: [
      `${env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`,
      `${env['ProgramFiles(x86)']}\\Google\\Chrome\\Application\\chrome.exe`,
      `${env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
      `${env['ProgramFiles(x86)']}\\Microsoft\\Edge\\Application\\msedge.exe`,
      `${env.ProgramFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
    ],
    darwin: [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ],
  }[process.platform];
  if (candidates) return candidates.find((p) => p && existsSync(p));
  for (const name of ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser', 'microsoft-edge']) {
    for (const dir of (env.PATH || '').split(path.delimiter)) {
      const p = path.join(dir, name);
      if (existsSync(p)) return p;
    }
  }
  return undefined;
}

// With a test context, the browser closes when that test ends; without one (a browser shared by
// a whole file), the caller closes it.
export async function launchBrowser(t) {
  if (!browserPath) throw new Error(noBrowser);
  const profile = mkdtempSync(path.join(tmpdir(), 'skp-browser-'));
  const args = [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-breakpad', // no crash handler processes holding the profile open after exit
    '--disable-crash-reporter',
    '--mute-audio',
    '--autoplay-policy=no-user-gesture-required', // OBS plays muted media without a gesture
    'about:blank',
  ];
  if (process.platform === 'linux' && process.env.CI) args.unshift('--no-sandbox'); // CI runners restrict user namespaces
  let child;
  try {
    child = spawn(browserPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (err) { // some failures throw at once (on Windows, a .cmd or .bat path: EINVAL)
    removeProfile(profile);
    throw new Error(`could not start ${browserPath}: ${err.message}`);
  }
  // Most spawn failures (EACCES, a bad path) arrive as an event instead; unheard, it would crash
  // the test process.
  let spawnError;
  child.on('error', (err) => { spawnError ??= err; });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
  // A child that never spawned has no pid and may never emit exit.
  const exited = new Promise((resolve) => {
    child.on('exit', resolve);
    child.on('error', () => { if (child.pid === undefined) resolve(); });
  });

  let cdp;
  try {
    const wsUrl = await waitForDevTools(profile, child, () => stderr, () => spawnError);
    cdp = await connect(wsUrl);
  } catch (err) {
    // No browser object exists to close, so don't leak the browser, its profile, or the stderr
    // pipe that would keep the test process alive.
    try { child.kill(); } catch {}
    await within(exited, 2000);
    child.stderr.destroy();
    removeProfile(profile);
    throw err;
  }

  let closing;
  const browser = {
    cdp,
    // Opens a page (a new target) and waits for its load event.
    async open(url, { width = 1280, height = 720 } = {}) {
      const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
      const page = makePage(cdp, sessionId, targetId);
      try {
        await page.send('Runtime.enable');
        await page.send('Log.enable');
        await page.send('Page.enable');
        await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
        await page.goto(url);
      } catch (err) {
        await page.close().catch(() => {}); // drops its listener too
        throw err;
      }
      return page;
    },
    // Idempotent. The browser may exit before it answers Browser.close, so the reply is only
    // awaited briefly; a browser that won't exit is killed.
    close() {
      closing ??= (async () => {
        await cdp.send('Browser.close', {}, undefined, 2000).catch(() => {});
        cdp.close();
        const timer = setTimeout(() => child.kill(), 3000);
        await exited;
        clearTimeout(timer);
        removeProfile(profile);
      })();
      return closing;
    },
  };
  if (t) defer(t, () => browser.close());
  return browser;
}

// Resolves when the promise settles or after ms, whichever is first, leaving no timer behind.
async function within(promise, ms) {
  let timer;
  try {
    await Promise.race([promise, new Promise((r) => { timer = setTimeout(r, ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

// A helper process that outlives the browser can hold the profile locked on Windows; a leftover
// temp directory must not fail a suite that passed.
function removeProfile(profile) {
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch (err) {
    console.warn(`could not remove the browser profile ${profile}: ${err.message}`);
  }
}

async function waitForDevTools(profile, child, stderr, spawnError) {
  const file = path.join(profile, 'DevToolsActivePort');
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (spawnError()) throw new Error(`could not start ${browserPath}: ${spawnError().message}`);
    if (child.exitCode !== null) throw new Error(`the browser exited (${child.exitCode}): ${stderr()}`);
    if (existsSync(file)) {
      let text = '';
      // On Windows the file can be locked for a moment while the browser writes it: try again.
      try { text = readFileSync(file, 'utf8'); } catch (err) { if (!['EBUSY', 'EPERM', 'EACCES', 'ENOENT'].includes(err.code)) throw err; }
      const [port, wsPath] = text.split('\n');
      if (port && wsPath) return `ws://127.0.0.1:${port.trim()}${wsPath.trim()}`;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`the browser did not start DevTools in time: ${stderr()}`);
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let nextId = 1;
    const pending = new Map();
    const listeners = new Set();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { resolve: ok, reject: fail, method } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) fail(new Error(`${method}: ${msg.error.message}`));
        else ok(msg.result);
      } else if (msg.method) {
        for (const fn of listeners) fn(msg);
      }
    });
    // A closed or closing socket drops sends without an error (WHATWG), so reject instead of
    // leaving a promise pending forever, and fail whatever was still waiting when it closes.
    ws.addEventListener('close', () => {
      for (const { reject: fail, method } of pending.values()) fail(new Error(`${method}: connection closed`));
      pending.clear();
    });
    ws.addEventListener('open', () => resolve({
      send(method, params = {}, sessionId, timeoutMs = SEND_TIMEOUT_MS) {
        if (ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error(`${method}: connection closed`));
        const id = nextId++;
        ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
        return new Promise((ok, fail) => {
          // A late reply finds no pending entry and is dropped.
          const timer = setTimeout(() => {
            pending.delete(id);
            fail(new Error(`${method}: no reply within ${timeoutMs} ms`));
          }, timeoutMs);
          pending.set(id, {
            resolve: (v) => { clearTimeout(timer); ok(v); },
            reject: (e) => { clearTimeout(timer); fail(e); },
            method,
          });
        });
      },
      on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      close() { try { ws.close(); } catch {} },
    }));
    ws.addEventListener('error', () => reject(new Error(`could not connect to ${url}`)));
  });
}

function makePage(cdp, sessionId, targetId) {
  const problems = [];
  const consoleLog = [];
  const loadWaiters = new Set();
  const off = cdp.on((msg) => {
    if (msg.sessionId !== sessionId) return;
    const p = msg.params;
    if (msg.method === 'Runtime.consoleAPICalled') {
      const text = p.args.map((a) => a.value ?? a.description ?? '').join(' ');
      consoleLog.push({ type: p.type, text });
      if (p.type === 'error') problems.push(`console.error: ${text}`);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      problems.push(`uncaught: ${p.exceptionDetails.exception?.description || p.exceptionDetails.text}`);
    } else if (msg.method === 'Log.entryAdded' && (p.entry.level === 'error' || /Content Security Policy/i.test(p.entry.text))) {
      problems.push(`${p.entry.source}: ${p.entry.text}${p.entry.url ? ` (${p.entry.url})` : ''}`);
    } else if (msg.method === 'Page.loadEventFired') {
      for (const fn of loadWaiters) fn();
      loadWaiters.clear();
    }
  });

  const page = {
    problems,
    consoleLog,
    send: (method, params, timeoutMs) => cdp.send(method, params, sessionId, timeoutMs),
    async goto(url) {
      const loaded = new Promise((resolve) => loadWaiters.add(resolve));
      await page.send('Page.navigate', { url });
      let timer;
      const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`load timed out: ${url}`)), 15000); });
      try {
        await Promise.race([loaded, timeout]);
      } finally {
        clearTimeout(timer);
      }
    },
    // Evaluates an expression in the page (awaiting promises) and returns its JSON value; fails
    // if that takes longer than timeoutMs.
    async eval(expression, timeoutMs) {
      const r = await page.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, timeoutMs);
      if (r.exceptionDetails) throw new Error(`in page: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
      return r.result.value;
    },
    // Resolves when the expression is truthy, checking every 20 ms.
    async waitFor(expression, timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        let value;
        // A hung evaluation counts against this deadline, not the 15 s command timeout.
        try { value = await page.eval(expression, Math.max(deadline - Date.now(), 1000)); } catch { value = undefined; }
        if (value) return value;
        if (Date.now() > deadline) throw new Error(`timed out waiting for: ${expression}`);
        await new Promise((r) => setTimeout(r, 20));
      }
    },
    async resize(width, height) {
      await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    },
    async screenshot() {
      const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
      return Buffer.from(data, 'base64');
    },
    close() {
      off(); // a page per test would otherwise leave a listener per test on a shared browser
      return cdp.send('Target.closeTarget', { targetId });
    },
  };
  return page;
}
