import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger, redact } from '../src/log.js';
import { memoryLogger } from './helpers.js';

test('entries are JSON lines with ts, level, msg, component and context', () => {
  const lines = [];
  const log = createLogger({ write: (l) => lines.push(l), now: () => new Date(Date.UTC(2026, 9, 10)) });
  log.child('http').info('listening', { port: 4848 });
  assert.equal(lines.length, 1);
  assert.ok(lines[0].endsWith('\n'));
  assert.deepEqual(JSON.parse(lines[0]), {
    ts: '2026-10-10T00:00:00.000Z', level: 'info', msg: 'listening', component: 'http', context: { port: 4848 },
  });
});

test('entries below the level are dropped', () => {
  const { log, entries } = memoryLogger('warn');
  log.info('quiet');
  log.warn('loud');
  assert.deepEqual(entries.map((e) => e.msg), ['loud']);
});

test('values under secret-looking keys are redacted, at any depth', () => {
  const out = redact({
    clientSecret: 'abc', password: 'hunter2', masterKey: 'k', headers: { Authorization: 'Bearer x', cookie: 'c' },
    key: 'skp_ovl_abc', tokens: [{ access_token: 't' }], login: 'dprtmnt', empty: '',
  });
  assert.deepEqual(out, {
    clientSecret: '[redacted]', password: '[redacted]', masterKey: '[redacted]',
    headers: { Authorization: '[redacted]', cookie: '[redacted]' },
    key: '[redacted]', tokens: '[redacted]', login: 'dprtmnt', empty: '',
  });
});

test('secrets inside strings are redacted: overlay keys in URLs, bearer tokens, SKP tokens', () => {
  assert.equal(redact('GET /o/friday-main/stream?key=skp_ovl_Zx9&canvas=h'), 'GET /o/friday-main/stream?key=[redacted]&canvas=h');
  assert.equal(redact('callback?code=abc123&state=s'), 'callback?code=[redacted]&state=s');
  assert.equal(redact('Authorization: Bearer eyJhbGciOi.payload.sig'), 'Authorization: Bearer [redacted]');
  assert.equal(redact('token skp_pat_6vZq81 was revoked'), 'token skp_pat_[redacted] was revoked');
});

test('the message itself is redacted too', () => {
  const { log, entries } = memoryLogger();
  log.info('fetching https://x.test/?key=secretvalue');
  assert.equal(entries[0].msg, 'fetching https://x.test/?key=[redacted]');
});

test('errors keep name, message, code and stack, redacted', () => {
  const err = Object.assign(new Error('failed for ?key=skp_ovl_abc'), { code: 'EFAIL' });
  const out = redact(err);
  assert.equal(out.name, 'Error');
  assert.equal(out.message, 'failed for ?key=[redacted]');
  assert.equal(out.code, 'EFAIL');
  assert.match(out.stack, /key=\[redacted\]/);
});

test('cycles and very deep values do not throw', () => {
  const a = { name: 'a' };
  a.self = a;
  let deep = {};
  const root = deep;
  for (let i = 0; i < 20; i++) deep = deep.next = {};
  assert.equal(redact(a).self, '[circular]');
  assert.doesNotThrow(() => JSON.stringify(redact(root)));
});

test('a failing writer never throws into the caller', () => {
  const log = createLogger({ write: () => { throw new Error('EPIPE'); } });
  assert.doesNotThrow(() => log.error('still fine'));
});
