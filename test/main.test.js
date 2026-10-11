// End to end: the real entry point as a child process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defer, tempDir } from './helpers.js';

const MAIN = fileURLToPath(new URL('../src/main.js', import.meta.url));

function run(args, env) {
  const child = spawn(process.execPath, [MAIN, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  return { child, exited, out: () => stdout, err: () => stderr };
}

test('a configuration error exits with code 78 and says what to fix', async (t) => {
  const root = tempDir(t);
  const p = run([], { SKP_DATA_DIR: path.join(root, 'd'), SKP_CONFIG_DIR: path.join(root, 'c'), SKP_PORT: 'eighty' });
  assert.equal(await p.exited, 78);
  assert.match(p.err(), /configuration error: SKP_PORT must be a port number/);
});

test('it starts, serves /healthz, and logs JSON lines', async (t) => {
  const root = tempDir(t);
  const p = run(['--port', '0'], { SKP_DATA_DIR: path.join(root, 'd'), SKP_CONFIG_DIR: path.join(root, 'c'), SKP_LOG_LEVEL: 'info' });
  defer(t, async () => { p.child.kill(); await p.exited; });
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no "listening" line in time:\n${p.out()}\n${p.err()}`)), 10000);
    p.child.stdout.on('data', () => {
      for (const line of p.out().split('\n').filter(Boolean)) {
        const entry = JSON.parse(line);
        if (entry.msg === 'listening') { clearTimeout(timer); resolve(entry.context.url); }
      }
    });
  });
  assert.equal(await (await fetch(`${url}healthz`)).text(), 'ok');
  const starting = JSON.parse(p.out().split('\n')[0]);
  assert.equal(starting.msg, 'starting');
  assert.equal(starting.context.config.exposure, 'local');
});
