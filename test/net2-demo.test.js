// npm run demo: the command line it prints drives the demo's show (its config folder is a
// temporary one, so the command has to name it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defer, tempDir } from './helpers.js';

const REPO = fileURLToPath(new URL('..', import.meta.url));

test('the demo prints a command line that reaches its show', async (t) => {
  // The demo's temporary folder inside the test's, so it goes when the test ends: killed, the
  // demo can't remove it itself.
  const tmp = tempDir(t);
  const demo = spawn(process.execPath, [path.join(REPO, 'scripts', 'takeover-demo.js'), '--port', '0'], { cwd: REPO, env: { ...process.env, TMP: tmp, TEMP: tmp, TMPDIR: tmp }, stdio: ['pipe', 'pipe', 'pipe'] });
  defer(t, async () => {
    if (demo.exitCode !== null || demo.signalCode !== null) return;
    const gone = new Promise((resolve) => demo.once('exit', resolve));
    demo.kill();
    await gone;
  });
  let out = '';
  await new Promise((resolve, reject) => {
    demo.stdout.on('data', (chunk) => {
      out += chunk;
      if (/^Commands:/m.test(out)) resolve();
    });
    demo.once('exit', (code) => reject(new Error(`the demo stopped (${code}): ${out}`)));
  });
  const printed = /npm run skp -- show list --port (\d+) --config-dir "([^"]+)"/.exec(out);
  assert.ok(printed, `no command line among: ${out}`);
  assert.ok(printed[2].startsWith(tmp), printed[2]);
  // What npm run skp runs, with the arguments printed.
  const { stdout } = await new Promise((resolve, reject) => {
    execFile(process.execPath, [path.join(REPO, 'src', 'main.js'), 'show', 'list', '--port', printed[1], '--config-dir', printed[2]], { cwd: REPO }, (err, so, se) => (err ? reject(new Error(`${err.message}\n${se}`)) : resolve({ stdout: so })));
  });
  assert.match(stdout, /^Saturday TAKEOVER .*overlays: takeover, event$/m);
});
