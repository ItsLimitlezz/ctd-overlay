// GitHub for template sources (04 §4.13, 07 §7.7): the token this platform reads private
// repositories with, saved from the admin UI (Settings → Integrations → GitHub) rather than set in
// the server's environment, and GitHub's device sign-in to get one without copying a token.
//
//   store collection "integrations", id "github": { token? (encrypted, associated data
//     "github:token"), method?: 'token' | 'device', login?, scopes?, savedAt?, savedBy?, clientId? }
//
// Which token a GitHub request uses (installs, update checks, release lists): the one saved here,
// else SKP_GITHUB_TOKEN from the server's environment, else none (public repositories only). The
// token never leaves: no answer carries it, the log redacts it (ghp_, github_pat_, gho_, ghu_ …,
// log.js), the audit log names only its account, and `skp key rotate` re-encrypts it with the
// other secrets (secrets.js ENCRYPTED). It goes to api.github.com only (sources.js request()).
//
// The device flow (RFC 8628) needs an OAuth app's client id, no secret (the operator registers the
// app on GitHub and ticks "Enable Device Flow"): GitHub shows a code to enter at
// github.com/login/device, and this platform asks every `interval` seconds until it is entered,
// refused or expired. The device code stays in this process's memory, never in an answer or the
// log. One sign-in at a time; starting another ends the one before.
//
//   GET    /api/v1/integrations/github                        which token is used, whose (templates:write)
//   PUT    /api/v1/integrations/github/token { token }        check it with GitHub, save it (system:admin)
//   DELETE /api/v1/integrations/github/token                  forget it: Disconnect (system:admin)
//   PUT    /api/v1/integrations/github/app { clientId }       the OAuth app for the device flow (system:admin)
//   POST   /api/v1/integrations/github/device                 start the device sign-in (system:admin)
//   GET    /api/v1/integrations/github/device                 how it's going (system:admin)
//   DELETE /api/v1/integrations/github/device                 cancel it (system:admin)
//   GET    /api/v1/integrations/github/repos/:owner/:name/releases   can it be read, and its releases (templates:write)
import { randomBytes } from 'node:crypto';
import { pinnedFetch } from '../net.js';
import { anySignal, authOf, defaultLookup, githubReleases, readJson, request, SOURCE_LIMITS, SourceError } from './sources.js';

const COLLECTION = 'integrations';
const ID = 'github';
export const GITHUB_AAD = 'github:token';
const API = 'https://api.github.com';
export const DEVICE_CODE_URL = 'https://github.com/login/device/code';
export const DEVICE_TOKEN_URL = 'https://github.com/login/oauth/access_token';
// Classic OAuth apps have no read-only scope for private repositories: "repo" is the one that
// reads them (07 §7.7 says so to the operator).
export const DEVICE_SCOPE = 'repo';
const TOKEN = /^[A-Za-z0-9_]{20,255}$/;
const CLIENT_ID = /^[A-Za-z0-9._-]{1,100}$/;
const FORM = { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' };

// config: githubToken (SKP_GITHUB_TOKEN), githubClientId (SKP_GITHUB_CLIENT_ID),
// allowPrivateDownloads. fetch, lookup, limits, now, timers and secondMs (how long a second of
// GitHub's polling interval is): test hooks.
export function createGithub({ store, secrets, config = {}, audit, log, fetch, lookup: lookupFn = defaultLookup, limits, now = Date.now, timers = { setTimeout, clearTimeout }, secondMs = 1000 }) {
  const allowPrivate = Boolean(config.allowPrivateDownloads);
  const fetchFn = fetch || pinnedFetch({ lookup: lookupFn, allowPrivate });
  const max = { ...SOURCE_LIMITS, ...limits };
  const net = { lookup: lookupFn, allowPrivate };
  const stopping = new AbortController();
  let warned = false;
  let flow = null; // the device sign-in: { …, deviceCode (memory only), timer }

  const read = () => store.get(COLLECTION, ID)?.data || {};
  const record = (entry) => audit?.record(entry);

  // Who GitHub is asked as (sources.js authOf): { token, from: 'saved', login } | { token, from:
  // 'env' } | { from: 'none' }. A saved token that can't be decrypted (another master key) is said
  // once in the log, and SKP_GITHUB_TOKEN (or nothing) is used instead.
  function auth() {
    const d = read();
    if (d.token) {
      try {
        return { token: secrets.decrypt(d.token, GITHUB_AAD), from: 'saved', login: d.login };
      } catch (err) {
        if (!warned) log?.warn('the saved GitHub token can\'t be decrypted; connect GitHub again in Settings → Integrations', { err: err.message });
        warned = true;
      }
    }
    return authOf({ token: config.githubToken });
  }

  const clientIdOf = () => {
    const d = read();
    if (d.clientId) return { clientId: d.clientId, from: 'saved' };
    if (config.githubClientId) return { clientId: config.githubClientId, from: 'env' };
    return { clientId: null, from: null };
  };

  // What anyone who installs templates may know: which token is used and whose, never the token.
  function status() {
    const d = read();
    const using = auth().from;
    const app = clientIdOf();
    return {
      using,
      ...(d.token ? { saved: { login: d.login, method: d.method || 'token', ...(d.scopes ? { scopes: d.scopes } : {}), savedAt: d.savedAt, ...(d.savedBy ? { savedBy: d.savedBy } : {}) } } : {}),
      env: Boolean(config.githubToken),
      clientId: app.clientId,
      clientIdFrom: app.from,
      device: deviceView(),
    };
  }

  // The account a token belongs to (GET /user): { login, scopes? } (scopes: a classic token's).
  async function whoIs(token) {
    const signal = anySignal(stopping.signal, max.apiMs);
    const res = await request(fetchFn, `${API}/user`, { headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' }, token, signal, max, net });
    if (res.status === 401) {
      await res.body?.cancel().catch(() => {});
      throw new SourceError('GitHub refused this token: it is mistyped, expired or was revoked. Make a new one and paste it again.', 'bad-token');
    }
    if ((res.status === 403 || res.status === 429) && res.headers.get('x-ratelimit-remaining') === '0') {
      await res.body?.cancel().catch(() => {});
      const reset = Number(res.headers.get('x-ratelimit-reset'));
      throw new SourceError(`GitHub's limit on requests from this address is used up${reset ? ` until ${new Date(reset * 1000).toISOString()}` : ' for now'}. Try again then.`, 'rate-limited');
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new SourceError(`GitHub answered ${res.status} when asked whose token this is. Try again in a minute.`, 'bad-response');
    }
    const body = await readJson(res, signal, max);
    if (!body || typeof body.login !== 'string') throw new SourceError('GitHub\'s answer has no account in it.', 'bad-response');
    const scopes = res.headers.get('x-oauth-scopes');
    return { login: body.login, ...(scopes !== null ? { scopes: scopes.split(',').map((s) => s.trim()).filter(Boolean) } : {}) };
  }

  // Checks a token with GitHub, then saves it, encrypted. who: { actor, ip }. method: 'token'
  // (pasted) or 'device' (the device sign-in).
  async function saveToken(token, { actor = 'unknown', ip, method = 'token' } = {}) {
    const value = typeof token === 'string' ? token.trim() : '';
    if (!TOKEN.test(value)) throw new SourceError('That isn\'t a GitHub token. A fine-grained token starts with github_pat_, a classic one with ghp_.', 'bad-token');
    const who = await whoIs(value);
    const d = read();
    store.put(COLLECTION, ID, {
      ...(d.clientId ? { clientId: d.clientId } : {}),
      token: secrets.encrypt(value, GITHUB_AAD),
      method, login: who.login, ...(who.scopes ? { scopes: who.scopes } : {}),
      savedAt: new Date(now()).toISOString(), savedBy: actor,
    });
    warned = false;
    record({ action: 'github.connect', actor, ip, target: `@${who.login}`, method });
    log?.info('a GitHub token was saved for template sources', { login: who.login, method });
    return status();
  }

  // Disconnect: the saved token is forgotten (GitHub keeps it until it is revoked there).
  function disconnect({ actor = 'unknown', ip } = {}) {
    const d = read();
    if (d.token) {
      const { clientId } = d;
      if (clientId) store.put(COLLECTION, ID, { clientId });
      else store.delete(COLLECTION, ID);
      record({ action: 'github.disconnect', actor, ip, target: `@${d.login}` });
    }
    return status();
  }

  // The OAuth app's client id for the device flow (not a secret: GitHub shows it to anyone who
  // signs in); null or '' removes it.
  function setClientId(clientId, { actor = 'unknown', ip } = {}) {
    const value = typeof clientId === 'string' ? clientId.trim() : clientId;
    if (value !== null && value !== '' && (typeof value !== 'string' || !CLIENT_ID.test(value))) throw new SourceError('A client ID is the letters and digits GitHub shows on the OAuth app\'s page, like Ov23liAbCdEf0123.', 'bad-option');
    const rest = { ...read() };
    delete rest.clientId;
    if (value) store.put(COLLECTION, ID, { ...rest, clientId: value });
    else if (Object.keys(rest).length) store.put(COLLECTION, ID, rest);
    else store.delete(COLLECTION, ID);
    record({ action: 'github.app', actor, ip, ...(value ? { clientId: value } : { removed: true }) });
    return status();
  }

  // ---- the device sign-in (RFC 8628) ------------------------------------------------------------
  function deviceView() {
    if (!flow) return { status: 'none' };
    return {
      status: flow.status,
      ...(flow.status === 'pending' ? { userCode: flow.userCode, verificationUri: flow.verificationUri, expiresAt: new Date(flow.expiresAt).toISOString(), intervalS: flow.intervalS } : {}),
      ...(flow.login ? { login: flow.login } : {}),
      ...(flow.message ? { message: flow.message } : {}),
    };
  }

  const post = (url, form) => request(fetchFn, url, { method: 'POST', headers: FORM, body: new URLSearchParams(form).toString(), signal: anySignal(stopping.signal, max.apiMs), max, net });
  const said = (d) => (typeof d?.error_description === 'string' ? d.error_description.slice(0, 200) : typeof d?.error === 'string' ? d.error : '');

  async function deviceStart({ actor = 'unknown', ip } = {}) {
    const { clientId } = clientIdOf();
    if (!clientId) throw new SourceError('Signing in with GitHub needs an OAuth app\'s client ID first (or paste a token instead).', 'no-client-id');
    deviceCancel();
    const res = await post(DEVICE_CODE_URL, { client_id: clientId, scope: DEVICE_SCOPE });
    let d = {};
    try { d = await readJson(res, stopping.signal, max); } catch { /* said below by its status */ }
    if (!res.ok || typeof d?.device_code !== 'string' || typeof d?.user_code !== 'string' || typeof d?.verification_uri !== 'string') {
      if (d?.error === 'device_flow_disabled') throw new SourceError('The OAuth app doesn\'t allow the device flow: on GitHub, open the app\'s settings, tick "Enable Device Flow" and save.', 'device-refused');
      if (res.status === 404 || d?.error === 'incorrect_client_credentials' || d?.error === 'Not Found') throw new SourceError('GitHub doesn\'t know this client ID: copy it again from the OAuth app\'s page.', 'device-refused');
      throw new SourceError(`GitHub didn't start the sign-in (${said(d) || res.status}).`, 'device-refused');
    }
    // Only an https page on github.com is offered as where to enter the code.
    let page = 'https://github.com/login/device';
    try {
      const u = new URL(d.verification_uri);
      if (u.protocol === 'https:' && u.hostname === 'github.com') page = u.href;
    } catch { /* the usual page */ }
    const life = Number(d.expires_in) > 0 ? Number(d.expires_in) : 900;
    flow = {
      id: randomBytes(8).toString('hex'),
      deviceCode: d.device_code,
      userCode: String(d.user_code).slice(0, 20),
      verificationUri: page,
      expiresAt: now() + life * 1000,
      intervalS: Number(d.interval) > 0 ? Number(d.interval) : 5,
      status: 'pending',
      clientId, actor, ip,
    };
    schedule(flow);
    return deviceView();
  }

  function schedule(f) {
    timers.clearTimeout(f.timer);
    f.timer = timers.setTimeout(() => { poll(f).catch((err) => log?.error('the GitHub sign-in failed', { err })); }, f.intervalS * secondMs);
    f.timer?.unref?.();
  }

  function finish(f, status, message, login) {
    timers.clearTimeout(f.timer);
    f.status = status;
    f.deviceCode = undefined;
    if (message) f.message = message;
    if (login) f.login = login;
  }

  async function poll(f) {
    if (flow !== f || f.status !== 'pending' || stopping.signal.aborted) return;
    if (now() >= f.expiresAt) return finish(f, 'expired', 'The code expired before it was entered. Start again.');
    let res;
    let d = {};
    try {
      res = await post(DEVICE_TOKEN_URL, { client_id: f.clientId, device_code: f.deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' });
      d = await readJson(res, stopping.signal, max);
    } catch (err) {
      // GitHub out of reach for a moment: ask again at the next interval, until the code expires.
      if (flow === f && f.status === 'pending' && !stopping.signal.aborted) {
        log?.warn('asking GitHub about the sign-in failed; asking again', { err: err.message });
        schedule(f);
      }
      return undefined;
    }
    if (flow !== f || f.status !== 'pending') return undefined; // cancelled meanwhile
    if (typeof d?.access_token === 'string' && d.access_token) {
      f.status = 'saving';
      try {
        const saved = await saveToken(d.access_token, { actor: f.actor, ip: f.ip, method: 'device' });
        return finish(f, 'connected', undefined, saved.saved?.login);
      } catch (err) {
        return finish(f, 'failed', err.message);
      }
    }
    switch (d?.error) {
      case 'authorization_pending':
        return schedule(f);
      case 'slow_down':
        // GitHub says the new interval; else 5 seconds more (RFC 8628 §3.5).
        f.intervalS = Number(d.interval) > f.intervalS ? Number(d.interval) : f.intervalS + 5;
        return schedule(f);
      case 'expired_token':
        return finish(f, 'expired', 'The code expired before it was entered. Start again.');
      case 'access_denied':
        return finish(f, 'denied', 'The sign-in was cancelled on GitHub. Start again to connect.');
      default:
        return finish(f, 'failed', `GitHub refused the sign-in (${said(d) || res.status}). Start again, or paste a token instead.`);
    }
  }

  function deviceCancel() {
    if (flow) timers.clearTimeout(flow.timer);
    flow = null;
    return { status: 'none' };
  }

  // A repository's releases, read with the token in use (sources.js githubReleases), and whose.
  async function releases(repo) {
    const a = auth();
    const out = await githubReleases(repo, { auth: a, fetch: fetchFn, lookup: lookupFn, allowPrivate, signal: stopping.signal, limits });
    return { ...out, using: a.from, ...(a.login ? { login: a.login } : {}) };
  }

  return {
    auth,
    status,
    saveToken,
    disconnect,
    setClientId,
    deviceStart,
    deviceStatus: deviceView,
    deviceCancel,
    releases,
    stop() {
      stopping.abort();
      deviceCancel();
    },
  };
}

// The routes (03; the list above). Setting or removing the token is the owner's (system:admin);
// whoever installs templates (templates:write) sees whether one is used, and tests a repository.
export function githubRoutes({ api, github }) {
  const tag = 'Integrations';
  const r = (def) => api.route({ tag, ...def });
  const who = (w, req) => ({ actor: w.label, ip: req.client?.ip });
  return [
    r({ method: 'GET', path: '/api/v1/integrations/github', scope: 'templates:write', summary: 'Which GitHub token template installs use (never the token)', run: () => github.status() }),
    r({ method: 'PUT', path: '/api/v1/integrations/github/token', scope: 'system:admin', summary: 'Save a GitHub token for private template repositories (checked with GitHub first)', body: { fields: ['token'] }, run: ({ body, req, who: w }) => {
      if (typeof body.token !== 'string' || !body.token.trim()) throw new SourceError('Paste the token GitHub showed you ("token").', 'bad-token');
      return github.saveToken(body.token, { ...who(w, req), method: 'token' });
    } }),
    r({ method: 'DELETE', path: '/api/v1/integrations/github/token', scope: 'system:admin', summary: 'Forget the saved GitHub token (Disconnect)', run: ({ req, who: w }) => github.disconnect(who(w, req)) }),
    r({ method: 'PUT', path: '/api/v1/integrations/github/app', scope: 'system:admin', summary: 'The GitHub OAuth app\'s client ID, for signing in with GitHub (null removes it)', body: { fields: ['clientId'] }, run: ({ body, req, who: w }) => {
      if (!('clientId' in body)) throw new SourceError('Send { "clientId": "…" }, or null to remove it.', 'bad-option');
      return github.setClientId(body.clientId, who(w, req));
    } }),
    r({ method: 'POST', path: '/api/v1/integrations/github/device', scope: 'system:admin', summary: 'Start signing in with GitHub: a code to enter at github.com/login/device', body: { fields: [] }, idempotent: false, run: ({ req, who: w }) => github.deviceStart(who(w, req)) }),
    r({ method: 'GET', path: '/api/v1/integrations/github/device', scope: 'system:admin', summary: 'How signing in with GitHub is going', run: () => github.deviceStatus() }),
    r({ method: 'DELETE', path: '/api/v1/integrations/github/device', scope: 'system:admin', summary: 'Cancel signing in with GitHub', run: () => github.deviceCancel() }),
    r({ method: 'GET', path: '/api/v1/integrations/github/repos/:owner/:name/releases', scope: 'templates:write', summary: 'Whether a repository can be read, and its newest releases with their .zip and .skp files', run: ({ params }) => github.releases(`${params.owner}/${params.name}`) }),
  ];
}
