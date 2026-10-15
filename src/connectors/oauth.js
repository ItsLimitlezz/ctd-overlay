// Signing a connection in to its service (06 §6.4, 07 §7.7): OAuth 2.0 with PKCE (S256) whenever
// the service supports it, the device flow (RFC 8628) where offered, client credentials for an
// app's own reads, refresh and revocation.
//
// Redirect flows: `state` is 32 random bytes, single use, gone after 10 minutes, and bound to whoever
// started the flow (a user, a token, the command line): the callback completes it only for them.
// The table keeps the state's hash, never the state itself, and at most 50 flows (the oldest
// forgotten first). A finished or failed flow is remembered as used until it would have expired,
// so a replayed callback says so instead of "unknown".
//
// Token requests are POSTs sent once, never retried (a code can be used once, a refresh token may
// rotate): the caller decides what a failure means. Errors say what the service said
// (invalid_grant, access_denied …) and whether trying again later may help (transient).
import { createHash, randomBytes } from 'node:crypto';

export const FLOW_TTL_MS = 10 * 60 * 1000;
export const MAX_FLOWS = 50;

const b64url = (buf) => Buffer.from(buf).toString('base64url');
export const sha256 = (s) => createHash('sha256').update(String(s)).digest('hex');

// { verifier, challenge } for PKCE S256 (RFC 7636): 32 random bytes as the verifier.
export function pkcePair(random = randomBytes) {
  const verifier = b64url(random(32));
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}
export const newState = (random = randomBytes) => b64url(random(32));

export class OAuthError extends Error {
  constructor(message, { code = 'oauth', status, transient = false } = {}) {
    super(message);
    this.name = 'OAuthError';
    this.code = code;
    if (status !== undefined) this.status = status;
    this.transient = transient;
  }
}

// principal: who may finish a flow: { kind: 'user' | 'token' | 'local', id }.
export function principalOf(who) {
  if (!who) return { kind: 'nobody', id: '' };
  if (who.kind === 'session') return { kind: 'user', id: who.user?.id || '' };
  if (who.kind === 'token') return { kind: 'token', id: who.tokenId || '' };
  return { kind: who.kind, id: '' };
}
export const samePrincipal = (a, b) => Boolean(a && b && a.kind === b.kind && a.id === b.id && a.kind !== 'nobody');

export function createFlowTable({ now = Date.now, ttlMs = FLOW_TTL_MS, max = MAX_FLOWS } = {}) {
  const flows = new Map(); // sha256(state) → { …flow, expiresAt, used? }
  const prune = () => {
    const t = now();
    for (const [k, f] of flows) if (f.expiresAt <= t) flows.delete(k);
    while (flows.size > max) flows.delete(flows.keys().next().value);
  };
  return {
    // Keeps a flow; returns its expiry. One open redirect flow per connection: a new one ends the old.
    add(state, flow) {
      prune();
      for (const [k, f] of flows) if (f.conn === flow.conn && !f.used) flows.delete(k);
      const expiresAt = now() + ttlMs;
      flows.set(sha256(state), { ...flow, expiresAt });
      prune();
      return expiresAt;
    },
    // { flow } still open, or { reason: 'unknown' | 'expired' | 'used' }; changes nothing.
    peek(state) {
      if (typeof state !== 'string' || !state) return { reason: 'unknown' };
      const f = flows.get(sha256(state));
      if (!f) return { reason: 'unknown' };
      if (f.expiresAt <= now()) return { reason: 'expired' };
      if (f.used) return { reason: 'used' };
      return { flow: f };
    },
    // The open flow for state, marked used (single use); or { reason }.
    take(state) {
      const out = this.peek(state);
      if (out.flow) out.flow.used = true;
      return out;
    },
    // Ends the open flows of a connection; returns how many there were.
    cancel(conn) {
      let n = 0;
      for (const [k, f] of flows) {
        if (f.conn === conn && !f.used) { flows.delete(k); n++; }
      }
      return n;
    },
    open(conn) {
      prune();
      return [...flows.values()].find((f) => f.conn === conn && !f.used);
    },
    get size() { prune(); return flows.size; },
  };
}

// A service's OAuth endpoints, for one connection's client id and secret. post(url, { form,
// headers }) sends a form POST once and answers { status, data } (the connection's HTTP client
// with retries: 0, expect: 'json', and no throw on 4xx: see host.js).
export function createOAuthClient({ oauth, clientId, clientSecret, post, now = Date.now }) {
  const clientAuth = oauth.clientAuth || (clientSecret ? 'body' : 'none');
  const withClient = (form) => {
    const out = { ...form, client_id: clientId };
    const headers = {};
    if (clientSecret && clientAuth === 'body') out.client_secret = clientSecret;
    if (clientSecret && clientAuth === 'basic') {
      delete out.client_id;
      headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`).toString('base64')}`;
    }
    return { form: out, headers };
  };
  const scopeText = (list) => list.join(oauth.scopeSeparator ?? ' ');
  const wanted = () => (oauth.scopes || []).map((s) => (typeof s === 'string' ? s : s.scope));

  async function tokenRequest(url, form, what) {
    let res;
    try {
      res = await post(url, withClient(form));
    } catch (err) {
      throw new OAuthError(`${what}: the service could not be reached (${err.message})`, { code: 'unreachable', transient: true });
    }
    const d = res.data && typeof res.data === 'object' ? res.data : {};
    if (res.status >= 200 && res.status < 300 && typeof d.access_token === 'string' && d.access_token) return tokenSet(d);
    const code = typeof d.error === 'string' ? d.error : res.status >= 500 ? 'server-error' : 'refused';
    const said = typeof d.error_description === 'string' ? d.error_description.slice(0, 200) : typeof d.message === 'string' ? d.message.slice(0, 200) : '';
    throw new OAuthError(`${what}: ${code}${said ? ` (${said})` : ''}`, { code, status: res.status, transient: res.status >= 500 || res.status === 429 });
  }

  // { accessToken, refreshToken?, tokenType, expiresAt?, scope: [], obtainedAt }
  function tokenSet(d) {
    const obtainedAt = now();
    const life = Number(d.expires_in);
    const scope = Array.isArray(d.scope) ? d.scope.map(String) : typeof d.scope === 'string' ? d.scope.split(/[\s,]+/).filter(Boolean) : [];
    return {
      accessToken: d.access_token,
      ...(typeof d.refresh_token === 'string' && d.refresh_token ? { refreshToken: d.refresh_token } : {}),
      tokenType: typeof d.token_type === 'string' ? d.token_type : 'bearer',
      ...(Number.isFinite(life) && life > 0 ? { expiresAt: obtainedAt + life * 1000 } : {}),
      scope,
      obtainedAt,
    };
  }

  return {
    wanted,
    // The address to send the operator to (a redirect flow).
    authorizeUrl({ redirectUri, state, challenge }) {
      const u = new URL(oauth.authorizeUrl);
      u.searchParams.set('response_type', 'code');
      u.searchParams.set('client_id', clientId);
      u.searchParams.set('redirect_uri', redirectUri);
      const scopes = wanted();
      if (scopes.length) u.searchParams.set('scope', scopeText(scopes));
      u.searchParams.set('state', state);
      if (oauth.pkce !== false) {
        u.searchParams.set('code_challenge', challenge);
        u.searchParams.set('code_challenge_method', 'S256');
      }
      for (const [k, v] of Object.entries(oauth.extraParams || {})) u.searchParams.set(k, String(v));
      return u.toString();
    },
    exchange({ code, redirectUri, verifier }) {
      return tokenRequest(oauth.tokenUrl, { grant_type: 'authorization_code', code, redirect_uri: redirectUri, ...(oauth.pkce !== false ? { code_verifier: verifier } : {}) }, 'Signing in failed');
    },
    refresh(refreshToken) {
      return tokenRequest(oauth.tokenUrl, { grant_type: 'refresh_token', refresh_token: refreshToken }, 'Renewing the sign-in failed');
    },
    clientCredentials() {
      return tokenRequest(oauth.tokenUrl, { grant_type: 'client_credentials', ...(oauth.appScopes?.length ? { scope: scopeText(oauth.appScopes) } : {}) }, 'Getting an app token failed');
    },
    // The device flow's start (RFC 8628 §3.1–3.2).
    async deviceStart() {
      let res;
      try {
        res = await post(oauth.deviceUrl, withClient({ ...(wanted().length ? { scope: scopeText(wanted()) } : {}) }));
      } catch (err) {
        throw new OAuthError(`Starting sign-in failed: the service could not be reached (${err.message})`, { code: 'unreachable', transient: true });
      }
      const d = res.data && typeof res.data === 'object' ? res.data : {};
      if (res.status < 200 || res.status >= 300 || typeof d.device_code !== 'string' || typeof d.user_code !== 'string' || typeof d.verification_uri !== 'string') {
        throw new OAuthError(`Starting sign-in failed: ${typeof d.error === 'string' ? d.error : res.status}${typeof d.error_description === 'string' ? ` (${d.error_description.slice(0, 200)})` : ''}`, { code: typeof d.error === 'string' ? d.error : 'refused', status: res.status, transient: res.status >= 500 });
      }
      return {
        deviceCode: d.device_code,
        userCode: d.user_code,
        verificationUri: d.verification_uri,
        ...(typeof d.verification_uri_complete === 'string' ? { verificationUriComplete: d.verification_uri_complete } : {}),
        expiresAt: now() + (Number(d.expires_in) > 0 ? Number(d.expires_in) : 600) * 1000,
        intervalS: Number(d.interval) > 0 ? Number(d.interval) : 5,
      };
    },
    // One poll: { tokens } | { pending: true } | { slowDown: true }; throws for expired or denied.
    async devicePoll(deviceCode) {
      try {
        return { tokens: await tokenRequest(oauth.tokenUrl, { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: deviceCode }, 'Signing in failed') };
      } catch (err) {
        if (err.code === 'authorization_pending') return { pending: true };
        if (err.code === 'slow_down') return { slowDown: true };
        if (err.transient) return { pending: true, retry: err };
        throw err;
      }
    },
    // Best effort (RFC 7009): true when the service took it back.
    async revoke(token, hint = 'refresh_token') {
      if (!oauth.revokeUrl || !token) return false;
      try {
        const res = await post(oauth.revokeUrl, withClient({ token, token_type_hint: hint }));
        return res.status >= 200 && res.status < 300;
      } catch {
        return false;
      }
    },
  };
}

// The code (or error) a service's redirect carried, from the address the operator landed on (or
// pasted): { code, state } | { error, state } | undefined.
export function fromRedirect(address) {
  let q;
  try { q = Object.fromEntries(new URL(address).searchParams); } catch { return undefined; }
  const state = q.state || undefined;
  if (q.error) return { error: q.error.slice(0, 100), state };
  if (q.code) return { code: q.code, state };
  return undefined;
}
