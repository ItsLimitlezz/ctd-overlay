// A connection's tokens (06 §6.1, 07 §7.7): the account's (from a sign-in) and the app's own
// (client credentials). The account's are kept encrypted in the store; the app's only in memory.
//
// - Renewed at 80 % of their lifetime, and once more on a 401 (http.js), one renewal at a time
//   (single flight): every request waiting for a token gets the same new one.
// - A renewal's new refresh token is saved before the new access token is used: a crash between
//   the two can't leave only a refresh token the service has already replaced.
// - The service unreachable or failing (5xx): the old token is kept and the renewal tried again
//   later. The service refusing the refresh token (invalid_grant, 400, 401): the connection needs
//   signing in again, said once and saved, never retried in a loop.
import { nextDelay } from './backoff.js';
import { HttpError } from './http.js';

const EARLY_MS = 30 * 1000; // a token this close to expiring is renewed before use
const RETRY_MS = 30 * 1000;

export function createTokenManager({ id, records, oauth, now = Date.now, timers, log, onNeedsReauth = () => {}, onChange = () => {} }) {
  let user = null; // { accessToken, refreshToken?, tokenType, expiresAt?, scope, obtainedAt }
  let app = null; // { accessToken, expiresAt?, obtainedAt }
  let refreshing = null;
  let appFetching = null;
  let timer = null;
  let attempt = 0;
  let stopped = false;

  try {
    user = records.tokensOf(id)?.user || null;
  } catch (err) {
    log?.error('a connection\'s tokens could not be decrypted (another master key?): it needs signing in again', { connection: id, err: err.message });
    user = null;
  }

  const lifetimeLeft = (t) => (t?.expiresAt ? t.expiresAt - now() : Infinity);
  const dueAt = (t) => (t?.expiresAt ? t.obtainedAt + 0.8 * (t.expiresAt - t.obtainedAt) : Infinity);
  // Said once: the first reason stands (a request in flight finding no token afterwards is the
  // same problem, not a new one).
  let said;
  const reauth = (reason) => {
    if (!said) {
      said = reason;
      try { records.markNeedsReauth(id, reason); } catch (err) { log?.error('could not save that a connection needs signing in again', { connection: id, err: err.message }); }
      onNeedsReauth(reason);
    }
    return new HttpError(`Sign in again: ${said}.`, { status: 401, code: 'needs-reauth' });
  };

  function schedule() {
    if (timer) timers.clearTimeout(timer);
    timer = null;
    if (stopped || !user?.expiresAt || !user.refreshToken) return;
    const wait = Math.max(0, Math.min(dueAt(user) - now(), 2 ** 31 - 1));
    timer = timers.setTimeout(() => {
      timer = null;
      refresh().catch(() => { /* said by refresh: kept for later, or needs-reauth */ });
    }, wait);
    timer?.unref?.();
  }

  // Renews the account's token (single flight).
  function refresh() {
    if (refreshing) return refreshing;
    if (!user?.refreshToken) return Promise.reject(reauth('the sign-in has expired and can\'t be renewed'));
    if (!oauth()) return Promise.reject(reauth('the connection has no app (client ID) to renew its sign-in with'));
    refreshing = (async () => {
      try {
        const next = await oauth().refresh(user.refreshToken);
        const merged = { ...next, refreshToken: next.refreshToken || user.refreshToken };
        records.saveTokens(id, merged); // before it is used
        user = merged;
        attempt = 0;
        onChange();
        schedule();
        return user.accessToken;
      } catch (err) {
        if (err.transient) {
          // The old token may still work; try again later.
          const wait = Math.max(RETRY_MS, nextDelay(attempt++));
          if (timer) timers.clearTimeout(timer);
          if (!stopped) {
            timer = timers.setTimeout(() => { timer = null; refresh().catch(() => {}); }, wait);
            timer?.unref?.();
          }
          log?.warn('renewing a connection\'s sign-in failed; trying again later', { connection: id, err: err.message, waitMs: wait });
          throw new HttpError(`Renewing the sign-in failed for now (${err.message}).`, { code: 'network' });
        }
        user = null;
        throw reauth(`the service no longer accepts the sign-in (${err.code || err.message})`);
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  }

  function fetchApp() {
    if (appFetching) return appFetching;
    if (!oauth()) return Promise.reject(new HttpError('The connection has no app (client ID and secret) for its own requests.', { code: 'unauthorized' }));
    appFetching = (async () => {
      try {
        const next = await oauth().clientCredentials();
        app = { accessToken: next.accessToken, ...(next.expiresAt ? { expiresAt: next.expiresAt } : {}), obtainedAt: next.obtainedAt };
        onChange();
        return app.accessToken;
      } catch (err) {
        throw new HttpError(`The service refused the app's client ID or secret (${err.code || err.message}): check them.`, { code: err.transient ? 'network' : 'unauthorized' });
      } finally {
        appFetching = null;
      }
    })();
    return appFetching;
  }

  async function accessToken() {
    if (!user?.accessToken) throw reauth('the connection is not signed in');
    if (lifetimeLeft(user) < EARLY_MS) return refresh();
    return user.accessToken;
  }
  async function appToken() {
    if (app && now() < dueAt(app)) return app.accessToken;
    return fetchApp();
  }

  return {
    hasUser: () => Boolean(user?.accessToken),
    accessToken,
    appToken,
    // For http.js: the Authorization header, a forced renewal after a 401, and a second 401.
    auth: {
      header: async (kind) => `Bearer ${kind === 'user' ? await accessToken() : await appToken()}`,
      refresh: (kind) => {
        if (kind === 'user') return refresh();
        app = null;
        return fetchApp();
      },
      rejected: (kind, reason) => {
        if (kind !== 'user') { app = null; return; }
        user = null;
        reauth(reason);
      },
    },
    // A new sign-in (a flow finished, or the connector's own saveTokens).
    save(set, extra = {}) {
      records.saveTokens(id, set, extra);
      user = set;
      said = undefined;
      attempt = 0;
      onChange();
      schedule();
    },
    start() { stopped = false; schedule(); },
    stop() {
      stopped = true;
      if (timer) timers.clearTimeout(timer);
      timer = null;
    },
    forgetApp() { app = null; },
    // Every token value, so logs and answers can be scrubbed of them.
    values: () => [user?.accessToken, user?.refreshToken, app?.accessToken].filter(Boolean),
    get user() { return user; },
  };
}
