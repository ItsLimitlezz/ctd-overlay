import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createCrashLog } from '../src/crashlog.js';
import { tempDir } from './helpers.js';

test('record appends one JSON line per error, with the stack and secrets redacted', (t) => {
  const file = path.join(tempDir(t), 'crash.log');
  const crash = createCrashLog(file);
  crash.record('request', new Error('boom at /o/x?key=skp_ovl_secret'), { url: '/o/x?key=skp_ovl_secret' });
  crash.record('scheduler', new Error('second'));
  const lines = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].kind, 'request');
  assert.match(lines[0].error.stack, /boom/);
  assert.doesNotMatch(JSON.stringify(lines[0]), /skp_ovl_secret/);
});

test('prune keeps only the last 30 days', (t) => {
  const file = path.join(tempDir(t), 'crash.log');
  const now = new Date(Date.UTC(2026, 9, 10));
  const day = 86400000;
  const entry = (ageDays) => JSON.stringify({ ts: new Date(now - ageDays * day).toISOString(), kind: 'x', error: {} });
  writeFileSync(file, [entry(40), entry(31), entry(29), 'not json', entry(1)].join('\n') + '\n');
  const crash = createCrashLog(file, { now: () => now });
  assert.equal(crash.prune(30), 3);
  const kept = readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(kept.length, 2);
});

test('recording to an unwritable place does not throw', () => {
  const crash = createCrashLog(path.join('/definitely/not/a/dir', 'crash.log'));
  assert.doesNotThrow(() => crash.record('x', new Error('y')));
  assert.equal(crash.prune(), 0);
});
