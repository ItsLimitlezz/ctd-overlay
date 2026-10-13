import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createSseWriter, frame } from '../src/overlays/sse.js';

// A response whose socket can be "backed up" on demand.
function fakeRes() {
  const res = new EventEmitter();
  res.chunks = [];
  res.backedUp = false;
  res.ended = false;
  res.write = (chunk) => { res.chunks.push(chunk); return !res.backedUp; };
  res.end = () => { res.ended = true; };
  res.drain = () => { res.backedUp = false; res.emit('drain'); };
  return res;
}

const env = (n, type = 'custom.x') => ({ id: `01J${String(n).padStart(23, '0')}`, type, ts: n, src: { connector: 'core' }, data: { n } });

test('a frame carries id, event and the envelope as one data line', () => {
  const e = env(1, 'chat.message');
  e.data.text = 'two\nlines';
  const f = frame(e);
  assert.ok(f.startsWith(`id: ${e.id}\nevent: chat.message\ndata: {`));
  assert.ok(f.endsWith('}\n\n'));
  assert.equal(f.split('\n').length, 5); // id, event, data, blank, ''
  assert.deepEqual(JSON.parse(f.split('\n')[2].slice(6)), e);
});

test('envelopes are written in order, and held while the socket is backed up', () => {
  const res = fakeRes();
  const w = createSseWriter(res);
  w.send(env(1));
  res.backedUp = true;
  w.send(env(2)); // written, but the socket reports it's full
  w.send(env(3));
  w.send(env(4));
  assert.equal(res.chunks.length, 2);
  assert.equal(w.queued, 2);
  res.drain();
  assert.equal(res.chunks.length, 4);
  assert.deepEqual(res.chunks.map((c) => JSON.parse(c.split('\n')[2].slice(6)).data.n), [1, 2, 3, 4]);
});

test('past 1000 queued, the oldest chat messages go first and the next envelope says how many (02 §2.9)', () => {
  const res = fakeRes();
  const w = createSseWriter(res);
  res.backedUp = true;
  w.send(env(0)); // goes out and backs up the socket
  w.send(env(1, 'chat.message'));
  w.send(env(2, 'chat.message'));
  for (let i = 3; i <= 1001; i++) w.send(env(i));
  assert.equal(w.queued, 1000); // 1001 queued, one chat message dropped
  w.send(env(1002));
  assert.equal(w.queued, 1000); // the second chat message dropped
  res.drain();
  const sent = res.chunks.slice(1).map((c) => JSON.parse(c.split('\n')[2].slice(6)));
  assert.equal(sent[0].data.n, 3);
  assert.deepEqual(sent[0].meta, { chatDropped: 2 });
  assert.equal(sent[1].meta, undefined);
  assert.equal(res.ended, false);
});

test('with nothing droppable left, the stream is ended rather than leaving a silent gap', () => {
  const res = fakeRes();
  const w = createSseWriter(res);
  res.backedUp = true;
  for (let i = 0; i <= 1001; i++) w.send(env(i));
  assert.equal(res.ended, true);
  w.send(env(2000));
  assert.equal(w.queued, 0);
});

test('heartbeats are comment lines, skipped while the socket is backed up', () => {
  const res = fakeRes();
  const w = createSseWriter(res);
  w.comment('hb');
  assert.equal(res.chunks.at(-1), ': hb\n\n');
  res.backedUp = true;
  w.send(env(1));
  w.comment('hb');
  assert.equal(res.chunks.length, 2);
});
