// The command line and the platform's own certificate (07 §7.3, §7.8): one it can't read is a
// configuration problem said in one line (exit 78), and one the platform no longer serves says
// how to fix it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { startPlatform } from '../src/app.js';
import { run } from '../src/cli.js';
import { loadConfig } from '../src/config.js';
import { defer, memoryLogger, tempDir } from './helpers.js';
import { selfSigned } from './tls.js';

async function cli(argv, env) {
  let stdout = '';
  let stderr = '';
  const code = await run(argv, { stdout: { write: (s) => { stdout += s; } }, stderr: { write: (s) => { stderr += s; } }, env });
  return { code, stdout, stderr };
}

test('an SKP_TLS_CERT that is missing, unreadable or not a certificate: a clear refusal, exit 78, no stack', async (t) => {
  const dir = tempDir(t);
  const key = path.join(dir, 'key.pem');
  writeFileSync(key, selfSigned().key);
  writeFileSync(path.join(dir, 'junk.pem'), 'not a certificate\n');
  mkdirSync(path.join(dir, 'folder.pem'));
  const env = { SKP_DATA_DIR: path.join(dir, 'data'), SKP_CONFIG_DIR: path.join(dir, 'config'), SKP_PORT: '1', SKP_TLS_KEY: key };
  for (const [name, why] of [['junk.pem', 'not a PEM certificate'], ['folder.pem', 'E[A-Z]+'], ['missing.pem', 'no such file']]) {
    const cert = path.join(dir, name);
    const r = await cli(['user', 'list'], { ...env, SKP_TLS_CERT: cert });
    assert.equal(r.code, 78, `${name}: ${r.stderr}`);
    assert.doesNotMatch(r.stderr, /unexpected error|\n\s+at /, name);
    assert.match(r.stderr, new RegExp(`^skp: Can't read the platform's certificate, SKP_TLS_CERT .*${name.replace('.', '\\.')} \\(${why}\\)`), name);
    const asJson = await cli(['user', 'list', '--json'], { ...env, SKP_TLS_CERT: cert });
    assert.equal(asJson.code, 78);
    assert.equal(JSON.parse(asJson.stdout).error, 'certificate');
  }
});

test('a certificate renewed on disk but not yet served: the refusal says to restart the platform', async (t) => {
  const dir = tempDir(t);
  const pair = (name) => {
    const { cert, key } = selfSigned('overlays.example.com');
    writeFileSync(path.join(dir, `${name}.pem`), cert);
    writeFileSync(path.join(dir, `${name}-key.pem`), key);
    return { SKP_TLS_CERT: path.join(dir, `${name}.pem`), SKP_TLS_KEY: path.join(dir, `${name}-key.pem`) };
  };
  const env = { SKP_DATA_DIR: path.join(dir, 'data'), SKP_CONFIG_DIR: path.join(dir, 'config'), ...pair('served') };
  const platform = await startPlatform(loadConfig({ argv: ['--port', '0'], env }), { log: memoryLogger().log, scrypt: { N: 1024 } });
  defer(t, () => platform.stop());
  const renewed = await cli(['user', 'list'], { ...env, ...pair('renewed'), SKP_PORT: String(platform.port) });
  assert.equal(renewed.code, 69);
  assert.match(renewed.stderr, /the local token wasn't sent.*If its certificate was renewed, restart the platform: it reads the certificate only when it starts\./);
});
