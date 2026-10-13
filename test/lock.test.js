// The data-directory lock (src/lock.js): one holder at a time, even when processes race for it,
// and what counts as a lock that is held or abandoned. (A second platform being refused and a
// dead holder's lock being taken over are in registry.test.js; the platform keeping its lock
// fresh is at the end of this file.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs, { existsSync, readdirSync, readFileSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { hostname } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { openData } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { lockDataDir, LockError, REFRESH_MS } from '../src/lock.js';
import { defer, memoryLogger, startWithOverlay, tempDir } from './helpers.js';

const LOCK_URL = new URL('../src/lock.js', import.meta.url).href;
const DEAD_PID = 2 ** 22 + 7; // above every OS's pid limit
const BOOT_ID = '/proc/sys/kernel/random/boot_id';
const ATTEMPTS = 40; // src/lock.js
const guardFile = (dir) => path.join(dir, 'skp.lock.takeover');

const lockFile = (dir) => path.join(dir, 'skp.lock');
const writeLock = (dir, content) => writeFileSync(lockFile(dir), typeof content === 'string' ? content : JSON.stringify(content));
const readLock = (dir) => JSON.parse(readFileSync(lockFile(dir), 'utf8'));
const age = (dir, ms) => { const when = new Date(Date.now() - ms); utimesSync(lockFile(dir), when, when); };
const leftovers = (dir) => readdirSync(dir).filter((name) => name.startsWith('skp.lock.'));

function take(t, dir, options) {
  const lock = lockDataDir(dir, options);
  defer(t, () => lock.release());
  return lock;
}

function refused(dir, pattern, options) {
  let error;
  assert.throws(() => lockDataDir(dir, options), (err) => {
    assert.ok(err instanceof LockError, String(err));
    if (pattern) assert.match(err.message, pattern);
    error = err;
    return true;
  });
  return error;
}

// Replaces fs[name] until the test ends, for src/lock.js too: its named imports from node:fs are
// live bindings that syncBuiltinESMExports() points at the replacement.
function hook(t, name, replacement) {
  const original = fs[name];
  fs[name] = (...args) => replacement(original, ...args);
  syncBuiltinESMExports();
  defer(t, () => { fs[name] = original; syncBuiltinESMExports(); });
}

const hooked = (code) => Object.assign(new Error(`${code}: hooked`), { code });

// Child processes running `source` as an ES module, stopped when the test ends. Each one's
// next() is its next line of output, parsed as JSON.
function children(t, source, count, args) {
  const script = path.join(tempDir(t, 'skp-child-'), 'child.mjs');
  writeFileSync(script, source);
  return Array.from({ length: count }, () => {
    const child = spawn(process.execPath, [script, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    const exited = new Promise((resolve) => child.on('exit', resolve));
    defer(t, async () => { if (child.exitCode === null) child.kill(); await exited; });
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    return {
      pid: child.pid,
      async next() {
        const { value, done } = await lines.next();
        if (done) throw new Error(`child ${child.pid} ended early: ${stderr}`);
        return JSON.parse(value);
      },
    };
  });
}

// A process racing for the lock. Each round it says it is ready, waits to be armed (once every
// racer is ready, so none spins while the others start up), spins until the round's "go" file
// appears (so all racers start within microseconds of each other), reports its attempt, and holds
// what it got until the round's "done" file appears, so a late racer can't legitimately get the
// lock after the winner let go.
const RACER = `
import { existsSync } from 'node:fs';
import path from 'node:path';
const [lockUrl, dataDir, signals, rounds] = process.argv.slice(2);
const { lockDataDir } = await import(lockUrl);
const signal = (name) => existsSync(path.join(signals, name));
// Waits for the line to go out: a pipe can be asynchronous, and the spin below blocks.
const say = (msg) => new Promise((resolve) => process.stdout.write(JSON.stringify(msg) + '\\n', resolve));
for (let round = 0; round < Number(rounds); round++) {
  await say({ ready: round });
  while (!signal('arm-' + round)) await new Promise((r) => setTimeout(r, 1));
  await say({ armed: round });
  while (!signal('go-' + round)) { /* spin */ }
  let tookOver = false;
  const log = { warn: () => { tookOver = true; } };
  let lock;
  try {
    lock = lockDataDir(dataDir, { log, purpose: 'race' });
    await say({ round, ok: true, tookOver });
  } catch (err) {
    await say({ round, ok: false, tookOver, name: err.name, message: err.message, holder: err.holder ?? null });
  }
  while (!signal('done-' + round)) await new Promise((r) => setTimeout(r, 1));
  lock?.release();
  await say({ released: round });
}
`;

// `rounds` races between `count` processes; `before(dir)` sets the data directory up for each.
async function race(t, { count = 6, rounds = 5, before = () => {} } = {}) {
  const dir = tempDir(t);
  const signals = tempDir(t, 'skp-signals-');
  const racers = children(t, RACER, count, [LOCK_URL, dir, signals, String(rounds)]);
  const results = [];
  const signal = (name) => writeFileSync(path.join(signals, name), '');
  for (let round = 0; round < rounds; round++) {
    for (const r of racers) assert.deepEqual(await r.next(), { ready: round });
    before(dir);
    signal(`arm-${round}`);
    for (const r of racers) assert.deepEqual(await r.next(), { armed: round });
    signal(`go-${round}`);
    const answers = [];
    for (const r of racers) answers.push({ pid: r.pid, ...(await r.next()) });
    results.push(answers);
    signal(`done-${round}`);
    for (const r of racers) assert.deepEqual(await r.next(), { released: round });
    assert.ok(!existsSync(lockFile(dir)), 'the winner released the lock');
    assert.deepEqual(leftovers(dir), [], 'no temp or aside files left behind');
  }
  return results;
}

function exactlyOneHolder(answers, round) {
  const winners = answers.filter((a) => a.ok);
  assert.equal(winners.length, 1, `round ${round}: ${winners.length} processes hold the lock at once: ${JSON.stringify(answers)}`);
  for (const loser of answers.filter((a) => !a.ok)) {
    assert.equal(loser.name, 'LockError', loser.message);
    // Every loser read the winner's whole record: never a half-written lock, never another holder.
    assert.equal(loser.holder?.pid, winners[0].pid, `round ${round}: ${loser.message}`);
    assert.equal(loser.holder.purpose, 'race');
  }
}

test('processes racing for a free lock: exactly one gets it each round, the others are told who has it', { timeout: 60000 }, async (t) => {
  const results = await race(t);
  results.forEach((answers, round) => {
    exactlyOneHolder(answers, round);
    assert.ok(answers.every((a) => !a.tookOver), 'nothing was abandoned');
  });
});

test('processes racing to take over an abandoned lock: exactly one holds it each round, and one took it over', { timeout: 120000 }, async (t) => {
  const results = await race(t, { rounds: 10, before: (dir) => writeLock(dir, { pid: DEAD_PID, purpose: 'platform' }) });
  results.forEach((answers, round) => {
    exactlyOneHolder(answers, round);
    assert.equal(answers.filter((a) => a.tookOver).length, 1, `round ${round}: one process took the abandoned lock over: ${JSON.stringify(answers)}`);
  });
});

test('a lock taken by another process between ours judging it abandoned and removing it is left alone', (t) => {
  const dir = tempDir(t);
  writeLock(dir, { pid: DEAD_PID, host: 'some-other-host', purpose: 'platform' });
  age(dir, 4 * 60000);
  const newcomer = { pid: process.ppid, host: hostname(), purpose: 'platform', since: '2026-10-11T00:00:00.000Z' };
  // The first reading of the clock stamps our record, the second judges the stale lock: right
  // then another process takes it over first, as a racer could.
  let calls = 0;
  const now = () => { if (++calls === 2) writeLock(dir, newcomer); return Date.now(); };
  const { log, entries } = memoryLogger();
  const err = refused(dir, /^The platform is running with the data directory /, { log, now });
  assert.ok(calls >= 2, 'the stale lock was judged by the clock');
  assert.equal(err.holder.pid, process.ppid);
  assert.deepEqual(readLock(dir), newcomer, 'the newcomer\'s lock is still in place');
  assert.ok(!entries.some((e) => /took over a lock/.test(e.msg)));
  assert.deepEqual(readdirSync(dir), ['skp.lock']);
});

// Says it is ready, waits for its "go-<pid>" file, takes the lock once, writes what it got to its
// "<pid>" file (renamed into place, so never read half-written), and holds the lock until stopped.
const HOLDER = `
import { existsSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const [lockUrl, dataDir, signals] = process.argv.slice(2);
const { lockDataDir } = await import(lockUrl);
const file = path.join(signals, String(process.pid));
process.stdout.write('{"ready":true}\\n');
while (!existsSync(path.join(signals, 'go-' + process.pid))) await new Promise((r) => setTimeout(r, 1));
let answer;
try {
  lockDataDir(dataDir, { purpose: 'race' });
  answer = { ok: true };
} catch (err) {
  answer = { ok: false, name: err.name, message: err.message };
}
writeFileSync(file + '.tmp', JSON.stringify(answer));
renameSync(file + '.tmp', file);
setInterval(() => {}, 60000);
`;

// Tells a HOLDER to go and blocks this process (so it stays exactly where it is in lockDataDir)
// until the holder has answered.
function goAndAnswer(signals, holder) {
  writeFileSync(path.join(signals, `go-${holder.pid}`), '');
  const file = path.join(signals, String(holder.pid));
  const nap = new Int32Array(new SharedArrayBuffer(4));
  for (const until = Date.now() + 10000; Date.now() < until; Atomics.wait(nap, 0, 0, 1)) {
    if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  }
  throw new Error(`process ${holder.pid} never answered`);
}

// The window where a takeover could go wrong, made to happen every time: ours holds the takeover
// guard and is about to remove the abandoned lock when another process judges the same lock
// abandoned. That one may not remove anything: it waits, and gives up.
test('while one process is taking an abandoned lock over, another can\'t remove it too', async (t) => {
  const dir = tempDir(t);
  const signals = tempDir(t, 'skp-signals-');
  writeLock(dir, { pid: DEAD_PID, host: 'some-other-host', purpose: 'platform' });
  age(dir, 4 * 60000);
  const [b] = children(t, HOLDER, 1, [LOCK_URL, dir, signals]);
  assert.deepEqual(await b.next(), { ready: true });
  const answers = {};
  hook(t, 'unlinkSync', (unlinkSync, file) => {
    if (file === lockFile(dir) && !answers.B) {
      assert.ok(existsSync(guardFile(dir)), 'ours holds the guard');
      answers.B = goAndAnswer(signals, b);
    }
    return unlinkSync(file);
  });
  const { log, entries } = memoryLogger();
  take(t, dir, { log });
  assert.equal(answers.B.ok, false);
  assert.match(answers.B.message, /keeps taking it/);
  assert.equal(readLock(dir).pid, process.pid);
  assert.ok(entries.some((e) => /took over a lock/.test(e.msg)));
  assert.deepEqual(leftovers(dir), []);
});

test('a takeover guard left by a process that died mid-takeover is cleared once it is old', (t) => {
  const dir = tempDir(t);
  writeLock(dir, { pid: DEAD_PID, host: hostname(), purpose: 'platform' });
  writeFileSync(guardFile(dir), JSON.stringify({ pid: DEAD_PID }));
  // Young: someone is taking it over right now, so ours waits and gives up.
  refused(dir, /keeps taking it/);
  assert.ok(existsSync(guardFile(dir)));
  const when = new Date(Date.now() - 11000);
  utimesSync(guardFile(dir), when, when);
  const lock = take(t, dir);
  assert.equal(readLock(dir).pid, process.pid);
  assert.deepEqual(leftovers(dir), []);
  lock.release();
});

// Reads skp.lock as fast as it can until the stop file appears, then says how often it found a
// whole record and how often something else. The first time it finds a whole record it makes
// the seen file.
const WATCHER = `
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const [file, stop, seen] = process.argv.slice(2);
let whole = 0;
let partial = 0;
process.stdout.write('{"ready":true}\\n', () => {
  for (let i = 1; !(i % 256 === 0 && existsSync(stop)); i++) {
    let text;
    try { text = readFileSync(file, 'utf8'); } catch { continue; } // absent, or being deleted
    let parsed = true;
    try { JSON.parse(text); } catch { parsed = false; }
    if (!parsed) partial++;
    else if (whole++ === 0) writeFileSync(seen, '');
  }
  process.stdout.write(JSON.stringify({ whole, partial }) + '\\n');
});
`;

test('a lock is never seen half-written: it appears with its whole record', async (t) => {
  const dir = tempDir(t);
  const signals = tempDir(t, 'skp-signals-');
  const stop = path.join(signals, 'stop');
  const seen = path.join(signals, 'seen');
  const [watcher] = children(t, WATCHER, 1, [lockFile(dir), stop, seen]);
  assert.deepEqual(await watcher.next(), { ready: true });
  // For a quarter of a second, and on until the watcher has seen the lock at least once: on a
  // busy machine it may not get to run for a while.
  const start = Date.now();
  while (Date.now() - start < 250 || (!existsSync(seen) && Date.now() - start < 10000)) lockDataDir(dir).release();
  writeFileSync(stop, '');
  const { whole, partial } = await watcher.next();
  assert.equal(partial, 0, `another process found the lock without its record ${partial} times`);
  assert.ok(whole > 0, 'the other process saw the lock');
});

test('a lock without its record yet is held while it is young, and taken over once it is old', (t) => {
  const dir = tempDir(t);
  // JSON that isn't a record counts too: a record has an integer pid.
  for (const content of ['', '{"pid":12', 'not json', '{}', '{"pid":"12"}']) {
    writeLock(dir, content);
    refused(dir, /^Another process is starting with the data directory /);
    assert.equal(readFileSync(lockFile(dir), 'utf8'), content, 'left as it was');
    age(dir, 5000);
    refused(dir, /Another process is starting/);
    age(dir, 11000);
    const { log, entries } = memoryLogger();
    const lock = take(t, dir, { log });
    assert.equal(readLock(dir).pid, process.pid);
    assert.ok(entries.some((e) => /took over a lock/.test(e.msg)));
    lock.release();
    assert.ok(!existsSync(lockFile(dir)));
  }
});

test('the refusal names the lock file, so an operator knows what to delete if nothing is running', (t) => {
  const dir = tempDir(t);
  const file = lockFile(dir);
  writeLock(dir, { pid: process.ppid, host: hostname(), purpose: 'platform' });
  const err = refused(dir, /^The platform is running with the data directory .* \(pid \d+\)\. Stop it first\./);
  assert.ok(err.message.endsWith(`(If nothing is running, delete ${file}.)`), err.message);
  assert.match(err.message, /delete .*skp\.lock/);
  assert.equal(err.holder.pid, process.ppid);
  // So do the refusals for a lock with no record yet and for a CLI command holding it.
  writeLock(dir, '');
  assert.ok(refused(dir, /Another process is starting/).message.includes(`delete ${file}`));
  writeLock(dir, { pid: process.ppid, host: hostname(), purpose: 'template install' });
  assert.ok(refused(dir, /^"skp template install" is running/).message.includes(`delete ${file}`));
});

test('a lock that changes hands every time it is judged is given up on after a bounded number of tries, naming the file', (t) => {
  const dir = tempDir(t);
  // Whenever ours judges the lock abandoned, another process has just put a different abandoned
  // lock in its place, so what ours would remove is never what it judged, and it leaves it.
  let n = 0;
  const replace = () => {
    writeLock(dir, { pid: DEAD_PID, host: 'some-other-host', purpose: 'platform', since: String(n) });
    age(dir, 4 * 60000);
  };
  replace();
  const now = () => { if (++n >= 2) replace(); return Date.now(); };
  const { log, entries } = memoryLogger();
  const err = refused(dir, /^Could not take the lock on .*; another process keeps taking it\./, { log, now });
  assert.ok(err.message.endsWith(`(If nothing is running, delete ${lockFile(dir)}.)`), err.message);
  assert.equal(n, ATTEMPTS + 1, 'the clock stamped our record, then judged the lock once on each try');
  assert.ok(!entries.some((e) => /took over a lock/.test(e.msg)));
  assert.deepEqual(readdirSync(dir), ['skp.lock']);
});

test('a lock from before a reboot is taken over where the OS has a boot id, and held where it has none', (t) => {
  const dir = tempDir(t);
  // A live pid: after a reboot it may belong to any process, so only the boot id can tell.
  writeLock(dir, { pid: process.ppid, host: hostname(), boot: 'some-other-boot', purpose: 'platform' });
  if (existsSync(BOOT_ID)) {
    const lock = take(t, dir);
    assert.equal(readLock(dir).boot, readFileSync(BOOT_ID, 'utf8').trim());
    lock.release();
  } else {
    assert.equal(refused(dir, /The platform is running/).holder.pid, process.ppid);
    assert.equal(readLock(dir).boot, 'some-other-boot', 'left in place');
  }
});

test('a lock with our own pid that this process doesn\'t hold is from a previous life, and is taken over', (t) => {
  const dir = tempDir(t);
  // A restarted container got the same pid as the process that left the lock.
  writeLock(dir, { pid: process.pid, host: hostname(), purpose: 'platform', since: '2026-01-01T00:00:00.000Z' });
  const { log, entries } = memoryLogger();
  const lock = take(t, dir, { log });
  assert.ok(entries.some((e) => /took over a lock/.test(e.msg)));
  assert.notEqual(readLock(dir).since, '2026-01-01T00:00:00.000Z', 'our own record now');
  // Held by this process now: refused, not taken over again.
  refused(dir, /This process already uses the data directory/);
  lock.release();
  assert.ok(!existsSync(lockFile(dir)));
});

test('a lock from another host is held while it is kept fresh, and taken over once it is three minutes stale', (t) => {
  const dir = tempDir(t);
  // Its pid means nothing here (none such exists on this host): only the lock's age counts.
  writeLock(dir, { pid: DEAD_PID, host: 'some-other-host', purpose: 'platform' });
  assert.equal(refused(dir, /^The platform is running on some-other-host with the data directory /).holder.host, 'some-other-host');
  age(dir, 2 * 60000);
  refused(dir, /on some-other-host/);
  age(dir, 4 * 60000);
  const lock = take(t, dir);
  assert.equal(readLock(dir).host, hostname());
  lock.release();
  assert.ok(!existsSync(lockFile(dir)));
  // Nor does a pid that happens to be alive here keep a stale lock from another host.
  writeLock(dir, { pid: process.ppid, host: 'some-other-host', purpose: 'platform' });
  age(dir, 4 * 60000);
  const again = take(t, dir);
  const { pid, host } = readLock(dir);
  assert.deepEqual({ pid, host }, { pid: process.pid, host: hostname() });
  again.release();
});

test('release removes only our own lock: a record another holder put in its place is left alone', (t) => {
  const dir = tempDir(t);
  const others = [
    { pid: process.ppid, host: hostname(), purpose: 'platform' }, // another process here
    { pid: process.pid, host: 'some-other-host', purpose: 'platform' }, // our pid, on another host
  ];
  for (const other of others) {
    const lock = take(t, dir);
    writeLock(dir, other);
    lock.release();
    assert.deepEqual(readLock(dir), other);
    unlinkSync(lockFile(dir));
  }
  // Released all the same: this process can take the lock again.
  take(t, dir).release();
  assert.ok(!existsSync(lockFile(dir)));
});

test('refresh brings the lock\'s mtime up to now, and does nothing once released', (t) => {
  const dir = tempDir(t);
  let clock = Date.now();
  const lock = take(t, dir, { now: () => clock });
  age(dir, 10 * 60000);
  clock = Date.now() + 5000;
  lock.refresh();
  assert.ok(Math.abs(statSync(lockFile(dir)).mtimeMs - clock) < 2000, 'refreshed to now');
  lock.release();
  // Another host's lock in its place: a released handle must not keep that one looking alive.
  writeLock(dir, { pid: process.ppid, host: 'some-other-host', purpose: 'platform' });
  age(dir, 10 * 60000);
  const before = statSync(lockFile(dir)).mtimeMs;
  lock.refresh();
  const moved = statSync(lockFile(dir)).mtimeMs - before;
  assert.equal(moved, 0, `mtime moved by ${moved} ms`);
});

test('refresh of a held lock whose file was deleted neither throws nor brings it back', (t) => {
  const dir = tempDir(t);
  const lock = take(t, dir);
  // As the refusal tells an operator to. The platform refreshes from a timer, where a throw
  // would bring it down.
  unlinkSync(lockFile(dir));
  assert.doesNotThrow(() => lock.refresh());
  assert.ok(!existsSync(lockFile(dir)));
});

test('where the filesystem has no hard links, an exclusive create takes the lock, and a held lock is still refused', (t) => {
  let code;
  let refusedLinks = 0;
  hook(t, 'linkSync', () => {
    refusedLinks++;
    throw hooked(code);
  });
  for (code of ['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV', 'EISDIR']) {
    const dir = tempDir(t);
    refusedLinks = 0;
    const lock = take(t, dir);
    assert.equal(refusedLinks, 1, `${code}: links were probed once, then not used`);
    assert.equal(readLock(dir).pid, process.pid);
    assert.deepEqual(readdirSync(dir), ['skp.lock'], 'its own record\'s file removed');
    lock.release();
    const other = { pid: process.ppid, host: hostname(), purpose: 'platform' };
    writeLock(dir, other);
    assert.equal(refused(dir, /^The platform is running /).holder.pid, process.ppid);
    assert.deepEqual(readLock(dir), other, 'not overwritten');
    assert.deepEqual(readdirSync(dir), ['skp.lock']);
  }
});

test('a takeover whose removal is refused for a moment (Windows, while another process reads it) is tried again', (t) => {
  let busy;
  let removals = 0;
  let dir;
  hook(t, 'unlinkSync', (unlinkSync, file) => {
    if (file === lockFile(dir)) {
      removals++;
      if (busy) { const code = busy; busy = undefined; throw hooked(code); }
    }
    return unlinkSync(file);
  });
  for (const code of ['EBUSY', 'EPERM', 'EACCES']) {
    dir = tempDir(t);
    writeLock(dir, { pid: DEAD_PID, host: hostname(), purpose: 'platform' });
    busy = code;
    removals = 0;
    const { log, entries } = memoryLogger();
    const lock = take(t, dir, { log });
    assert.equal(removals, 2, `${code}: removed on the second try`);
    assert.equal(readLock(dir).pid, process.pid);
    assert.ok(entries.some((e) => /took over a lock/.test(e.msg)));
    assert.deepEqual(readdirSync(dir), ['skp.lock']);
    lock.release();
    assert.ok(!existsSync(lockFile(dir)));
  }
});

test('no temp or aside files are left behind by taking, refusing, taking over or releasing', (t) => {
  const dir = tempDir(t);
  const lock = take(t, dir);
  assert.deepEqual(readdirSync(dir), ['skp.lock']);
  lock.release();
  // Refusals made after our record was written to a file of its own.
  writeLock(dir, '');
  assert.throws(() => lockDataDir(dir), LockError);
  assert.deepEqual(readdirSync(dir), ['skp.lock']);
  writeLock(dir, { pid: process.ppid, host: hostname(), purpose: 'platform' });
  assert.throws(() => lockDataDir(dir), LockError);
  assert.deepEqual(readdirSync(dir), ['skp.lock']);
  writeLock(dir, { pid: DEAD_PID, host: hostname(), purpose: 'platform' });
  const again = take(t, dir);
  assert.deepEqual(readdirSync(dir), ['skp.lock']);
  again.release();
  assert.deepEqual(readdirSync(dir), []);
});

test('a CLI command holding the data directory keeps its lock fresh too (a long conversion outlasts the 3 minutes)', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const root = tempDir(t);
  const config = loadConfig({ argv: [], env: { SKP_DATA_DIR: path.join(root, 'data'), SKP_CONFIG_DIR: path.join(root, 'config') } });
  const data = openData(config, { log: memoryLogger().log, purpose: 'media add' });
  defer(t, () => data.close());
  for (let minute = 1; minute <= 4; minute++) {
    age(config.dataDir, 10 * 60000);
    t.mock.timers.tick(REFRESH_MS);
    const behind = Date.now() - statSync(lockFile(config.dataDir)).mtimeMs;
    assert.ok(Math.abs(behind) < 5000, `minute ${minute}: the lock is ${behind} ms old`);
  }
  data.close();
  writeLock(config.dataDir, { pid: process.ppid, host: 'some-other-host', purpose: 'platform' });
  age(config.dataDir, 10 * 60000);
  const stale = statSync(lockFile(config.dataDir)).mtimeMs;
  t.mock.timers.tick(REFRESH_MS);
  assert.equal(statSync(lockFile(config.dataDir)).mtimeMs, stale, 'closed: it stops refreshing');
});

test('a running platform keeps its lock fresh every minute, and leaves the lock file alone once stopped', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { platform, config } = await startWithOverlay(t);
  const dir = config.dataDir;
  for (let minute = 1; minute <= 2; minute++) {
    age(dir, 10 * 60000);
    t.mock.timers.tick(REFRESH_MS);
    const behind = Date.now() - statSync(lockFile(dir)).mtimeMs;
    assert.ok(Math.abs(behind) < 5000, `minute ${minute}: the lock is ${behind} ms old`);
  }
  await platform.stop();
  // Another host's lock in its place: the stopped platform doesn't keep it looking alive.
  writeLock(dir, { pid: process.ppid, host: 'some-other-host', purpose: 'platform' });
  age(dir, 10 * 60000);
  const before = statSync(lockFile(dir)).mtimeMs;
  t.mock.timers.tick(REFRESH_MS);
  assert.equal(statSync(lockFile(dir)).mtimeMs, before);
});
