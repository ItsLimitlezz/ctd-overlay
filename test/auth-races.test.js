// Changes made while a password is being checked (07 §7.3–7.5). A check waits for the hasher, and
// whatever happened to the account in that time (removed, a new role, a new password, two-factor
// turned on) stands: the request that was waiting neither undoes it nor gets a session it no
// longer should. A two-factor or recovery code is used once, however many sign-ins carry it at the
// same moment.
//
// Each test starts a request, which reads the account and then waits for the hasher, makes the
// change before the hash can finish (scrypt answers on a later turn of the event loop), and only
// then lets the request go on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { startPlatform } from '../src/app.js';
import { createAudit } from '../src/auth/audit.js';
import { createAuth } from '../src/auth/index.js';
import { createHasher } from '../src/auth/passwords.js';
import { hotp, stepAt } from '../src/auth/totp.js';
import { loadConfig } from '../src/config.js';
import { openStore } from '../src/store/index.js';
import { defer, memoryLogger, tempDir } from './helpers.js';

const PASSWORD = 'correct horse battery staple';
const MALLORY = 'mallory keeps a long password';
const AT = { ip: '127.0.0.1' };

async function setup(t) {
  const root = tempDir(t);
  const clock = { t: Date.UTC(2026, 9, 17, 18, 0) };
  const config = loadConfig({ argv: ['--port', '0'], env: { SKP_DATA_DIR: path.join(root, 'data'), SKP_CONFIG_DIR: path.join(root, 'config') } });
  const platform = await startPlatform(config, { log: memoryLogger().log, scrypt: { N: 1024 }, clock: { now: () => clock.t } });
  defer(t, () => platform.stop());
  const { auth } = platform;
  await auth.createOwner({ code: auth.setupCode, username: 'juan', password: PASSWORD }, AT);
  const { id } = await auth.users.create({ username: 'mallory', password: MALLORY, role: 'admin' }, { actor: 'juan', ...AT });
  const owner = { actor: 'juan', ...AT };
  const cli = auth.authenticate({ headers: { authorization: `Bearer ${auth.localToken}` }, socket: { remoteAddress: '127.0.0.1' } }).principal;
  const mallory = () => platform.store.get('users', id);
  const sessions = () => platform.store.list('sessions', { limit: 1000 }).filter((s) => s.data.userId === id);
  const principal = (signed) => auth.authenticate({ headers: { cookie: signed.cookie.split(';')[0] } }).principal;
  // Mallory signed in: her session, as a request carrying her cookie has it.
  const signIn = async (code) => principal(await auth.login({ username: 'mallory', password: MALLORY, code }, AT));
  // Two-factor on for her, and the clock on to the next step, so the code it shows is unused.
  const withTotp = async () => {
    const { secret } = await auth.totp.enroll(await signIn(), { password: MALLORY }, AT);
    const { recoveryCodes } = auth.totp.verify(await signIn(), { code: hotp(secret, stepAt(clock.t)) }, AT);
    clock.t += 30 * 1000;
    return { code: () => hotp(secret, stepAt(clock.t)), recoveryCodes };
  };
  return { platform, auth, clock, owner, cli, mallory, sessions, principal, signIn, withTotp };
}

const statuses = async (promises) => (await Promise.allSettled(promises)).map((r) => (r.status === 'fulfilled' ? 200 : r.reason.status)).sort();

test('removed while her password was checked: the sign-in signs nobody in, and brings nobody back', async (t) => {
  const { auth, owner, mallory, sessions } = await setup(t);
  const signing = auth.login({ username: 'mallory', password: MALLORY }, AT);
  auth.users.remove('mallory', owner);
  await assert.rejects(signing, { code: 'bad-credentials', status: 401 });
  assert.equal(mallory(), undefined, 'still removed');
  assert.deepEqual(sessions(), []);
});

test('demoted while her password was checked: the sign-in gets the new role, which stays', async (t) => {
  const { auth, owner, mallory, principal } = await setup(t);
  const signing = auth.login({ username: 'mallory', password: MALLORY }, AT);
  const demoting = auth.users.update('mallory', { role: 'viewer' }, owner);
  const [signed] = await Promise.all([signing, demoting]);
  assert.equal(mallory().data.role, 'viewer', 'the demotion stays');
  assert.equal(signed.user.role, 'viewer');
  assert.equal(principal(signed).role, 'viewer');
});

test('her password reset while a sign-in checked the old one: the old one signs nobody in, and the reset stays', async (t) => {
  const { auth, cli, sessions } = await setup(t);
  const resetting = auth.users.update('mallory', { password: 'the owner set this one' }, { who: cli, actor: cli.label, ...AT });
  const signing = auth.login({ username: 'mallory', password: MALLORY }, AT); // checked after the reset's hash
  await resetting;
  await assert.rejects(signing, { code: 'bad-credentials', status: 401 });
  assert.deepEqual(sessions(), []);
  await assert.rejects(auth.login({ username: 'mallory', password: MALLORY }, AT), { status: 401 });
  assert.equal((await auth.login({ username: 'mallory', password: 'the owner set this one' }, AT)).user.username, 'mallory');
});

test('her own password change while she is demoted or removed: refused, no session, and the owner\'s change stays', async (t) => {
  const { auth, owner, mallory, sessions, signIn } = await setup(t);
  const demoted = auth.changePassword(await signIn(), { current: MALLORY, password: 'mallory\'s next password' }, AT);
  await auth.users.update('mallory', { role: 'operator' }, owner);
  await assert.rejects(demoted, { status: 401 });
  assert.equal(mallory().data.role, 'operator', 'the demotion stays');
  assert.deepEqual(sessions(), [], 'no session handed back');
  const removed = auth.changePassword(await signIn(), { current: MALLORY, password: 'mallory\'s next password' }, AT);
  auth.users.remove('mallory', owner);
  await assert.rejects(removed, { status: 401 });
  assert.equal(mallory(), undefined, 'still removed');
  assert.deepEqual(sessions(), []);
});

test('two-factor set up or turned off while she is removed or demoted: refused, and the owner\'s change stays', async (t) => {
  const { auth, owner, mallory, sessions, signIn, withTotp } = await setup(t);
  const { code } = await withTotp();
  const off = auth.totp.disable(await signIn(code()), { password: MALLORY }, AT);
  await auth.users.update('mallory', { role: 'viewer' }, owner);
  await assert.rejects(off, { status: 401 });
  assert.deepEqual([mallory().data.role, Boolean(mallory().data.totp)], ['viewer', true], 'demoted, and two-factor still on');
  assert.deepEqual(sessions(), []);
  await auth.users.update('mallory', { totp: false }, owner);
  const enrolling = auth.totp.enroll(await signIn(), { password: MALLORY }, AT);
  auth.users.remove('mallory', owner);
  await assert.rejects(enrolling, { status: 401 });
  assert.equal(mallory(), undefined, 'still removed');
});

test('the owner sets her password while she turns two-factor on: both stand; with If-Match, the owner is told it changed', async (t) => {
  const { auth, clock, cli, mallory, signIn } = await setup(t);
  const { secret } = await auth.totp.enroll(await signIn(), { password: MALLORY }, AT);
  const read = auth.users.get('mallory');
  const who = await signIn();
  const resetting = auth.users.update('mallory', { password: 'the owner set this one' }, { who: cli, actor: cli.label, ...AT });
  const { recoveryCodes } = auth.totp.verify(who, { code: hotp(secret, stepAt(clock.t)) }, AT);
  await resetting;
  assert.ok(mallory().data.totp, 'two-factor stays on');
  const signed = await auth.login({ username: 'mallory', password: 'the owner set this one', code: recoveryCodes[0] }, AT);
  assert.equal(signed.user.totp, true, 'the new password, and her recovery codes');
  // The admin UI's change is made to the revision it read, or not at all.
  const before = mallory().data.passwordHash;
  await assert.rejects(auth.users.update('mallory', { password: 'from a stale page 1' }, { who: cli, actor: cli.label, ifRev: read.rev, ...AT }), { name: 'ConflictError' });
  assert.equal(mallory().data.passwordHash, before);
});

// Auth on a store of its own, with the owner and Mallory: authAt(N) is one more on the same store,
// hashing at scrypt cost N, and hooks.hashing() is called each time one starts hashing a password.
async function onOneStore(t) {
  const store = openStore({ dataDir: tempDir(t) });
  defer(t, () => store.close());
  const audit = createAudit({ store });
  const hooks = { hashing: () => {} };
  const authAt = (N) => {
    const hasher = createHasher({ params: { N, r: 8, p: 1 } });
    const hash = (password) => {
      const out = hasher.hash(password);
      hooks.hashing();
      return out;
    };
    return createAuth({ store, audit, log: memoryLogger().log, hasher: { ...hasher, hash, verify: hasher.verify } });
  };
  const first = authAt(2048);
  first.start();
  await first.createOwner({ code: first.setupCode, username: 'juan', password: PASSWORD }, AT);
  await first.users.create({ username: 'mallory', password: MALLORY, role: 'admin' }, { actor: 'juan', ...AT });
  const mallory = () => store.list('users', { limit: 1000 }).find((d) => d.data.username === 'mallory');
  const login = (auth, password = MALLORY) => auth.login({ username: 'mallory', password }, AT);
  return { audit, hooks, authAt, first, mallory, login };
}

test('her own password change while a sign-in checked the old one: the old one signs nobody in', async (t) => {
  const { hooks, first: auth, login } = await onOneStore(t);
  const signed = await login(auth);
  const who = auth.authenticate({ headers: { cookie: signed.cookie.split(';')[0] } }).principal;
  // The sign-in reads her record as the change hashes the new password, and its check of the old
  // one ends after the change is saved.
  let signing;
  hooks.hashing = () => {
    hooks.hashing = () => {};
    signing = login(auth);
  };
  await auth.changePassword(who, { current: MALLORY, password: 'mallory\'s next password' }, AT);
  await assert.rejects(signing, { code: 'bad-credentials', status: 401 });
  assert.equal((await login(auth, 'mallory\'s next password')).user.username, 'mallory');
});

// The scrypt cost changed since her password was hashed (07 §7.3): a sign-in rehashes it, and that
// is still her password, not a new one. Auth on one store at two costs, each made after the last
// one's sessions so it knows them: whichever cost her hash isn't at, a sign-in there rehashes.
test('her password rehashed meanwhile (the scrypt cost changed) is still hers: two sign-ins at once, and her change beside one, all go through', async (t) => {
  const { audit, authAt, mallory, login } = await onOneStore(t);
  const cost = () => /^scrypt\$N=(\d+),/.exec(mallory().data.passwordHash)[1];

  const cheaper = authAt(1024);
  assert.deepEqual(await statuses([login(cheaper), login(cheaper)]), [200, 200], 'both sign in');
  assert.equal(cost(), '1024', 'rehashed');
  const signed = await login(cheaper);

  const dearer = authAt(2048);
  const who = dearer.authenticate({ headers: { cookie: signed.cookie.split(';')[0] } }).principal;
  const signing = login(dearer); // rehashes while her change waits for the hasher
  const changing = dearer.changePassword(who, { current: MALLORY, password: 'mallory\'s next password' }, AT);
  assert.deepEqual(await statuses([signing, changing]), [200, 200], 'her change goes through');
  await assert.rejects(login(dearer), { code: 'bad-credentials' });
  assert.equal((await login(dearer, 'mallory\'s next password')).user.username, 'mallory');
  assert.deepEqual(audit.list({ action: 'login.failure' }).items.map((e) => e.details.reason), ['password'], 'only the old password, last, failed');
});

test('a two-factor code, or a recovery code, carried by two sign-ins at once signs in once', async (t) => {
  const { auth, signIn, withTotp } = await setup(t);
  const { code, recoveryCodes } = await withTotp();
  const login = (c) => auth.login({ username: 'mallory', password: MALLORY, code: c }, AT);
  assert.deepEqual(await statuses([login(code()), login(code())]), [200, 401]);
  assert.deepEqual(await statuses([login(recoveryCodes[0]), login(recoveryCodes[0])]), [200, 401]);
  await assert.rejects(login(recoveryCodes[0]), { code: 'bad-code' });
  assert.ok(await signIn(recoveryCodes[1]), 'the others still work');
});
