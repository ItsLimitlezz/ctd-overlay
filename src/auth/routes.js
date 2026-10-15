// Sign-in and accounts over HTTP (03 §3.4 "Auth & users", 07 §7.2–7.5, §7.12):
//
//   GET    /api/v1/setup                 { needed }: whether the owner account is still to be made
//   POST   /api/v1/setup                 { code, username, password, keep? }: the owner, signed in
//   POST   /api/v1/auth/login            { username, password, code?, keep? }: a session cookie
//   POST   /api/v1/auth/logout
//   GET    /api/v1/auth/session          who is asking: user, role, scopes, and the CSRF token
//   GET    /api/v1/auth/sessions · DELETE /api/v1/auth/sessions/:id      your sessions
//   POST   /api/v1/auth/password         { current, password }
//   POST   /api/v1/auth/totp/enroll      { password } → { secret, uri }
//   POST   /api/v1/auth/totp/verify      { code } → { recoveryCodes } (shown once)
//   DELETE /api/v1/auth/totp             { password }
//   GET/POST /api/v1/users · GET/PATCH/DELETE /api/v1/users/:ref        (users:admin)
//   GET/POST /api/v1/tokens · DELETE /api/v1/tokens/:id                 your API tokens
//   GET    /api/v1/system/audit          ?limit=&cursor=&action= (audit:read)
//
// Every request goes through guard(): addressed to the platform by its own name, from its own
// origin if any (http/local.js), signed in (a session cookie, an API token, or the command line's
// local token), with the CSRF header on a cookie's changes, and holding the route's scope.
import { timingSafeEqual } from 'node:crypto';
import { refusedHere } from '../http/local.js';
import { sendProblem } from '../http/server.js';
import { AuthError, newestFirst } from './index.js';

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
const TITLES = { 401: 'Not signed in', 403: 'Forbidden', 404: 'Not found', 409: 'Conflict', 422: 'Not possible', 429: 'Too many requests' };
const problemType = (code) => `https://skp.dev/errors/${code}`;

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

// guard(req, res, scope, { touch }): the principal, or undefined once a problem has been sent.
// touch: false when checking again a principal already let in (an open stream, at each
// heartbeat), which isn't a use: the session still ends when idle (auth.authenticate).
export function createGuard({ auth, hosts }) {
  return function guard(req, res, scope, { touch } = {}) {
    if (refusedHere(req, res, hosts)) return undefined;
    const result = auth.authenticate(req, { touch });
    if (result.error) {
      sendProblem(res, 401, TITLES[401], result.error, { type: problemType('unauthenticated'), headers: { 'www-authenticate': 'Bearer', ...(result.clear ? { 'set-cookie': auth.clearCookie(Boolean(req.client?.https)) } : {}) } });
      return undefined;
    }
    const who = result.principal;
    if (!who) {
      sendProblem(res, 401, TITLES[401], `Sign in first (POST /api/v1/auth/login${auth.setupNeeded() ? '; there is no owner yet: run skp setup with the code in the log' : ''}), or send an API token: Authorization: Bearer skp_pat_….`, { type: problemType('unauthenticated'), headers: { 'www-authenticate': 'Bearer' } });
      return undefined;
    }
    // A cookie rides along with any request the browser makes, so a change made with one must
    // carry the session's CSRF token too (07 §7.3); a token in a header can't be sent by a page.
    if (who.kind === 'session' && !SAFE.has(req.method)) {
      const sent = req.headers['x-skp-csrf'];
      if (typeof sent !== 'string' || !safeEqual(sent, who.csrf)) {
        sendProblem(res, 403, TITLES[403], 'Send the X-SKP-CSRF header with the token from GET /api/v1/auth/session.', { type: problemType('csrf') });
        return undefined;
      }
    }
    if (scope && !who.scopes.has(scope)) {
      sendProblem(res, 403, TITLES[403], `This needs the "${scope}" permission, which ${who.label} (${who.kind === 'token' ? 'this token' : who.role}) doesn't have.`, { type: problemType('forbidden') });
      return undefined;
    }
    return who;
  };
}

export function authRoutes({ api, auth, audit }) {
  const tag = 'Accounts';
  const ctxOf = (req, who, body) => ({ ip: req.client?.ip ?? req.socket.remoteAddress, https: Boolean(req.client?.https), ua: req.headers['user-agent'], actor: who?.label, keep: body?.keep === true });
  // A sign-in's cookie goes in its header, never the body.
  const signIn = (status, value) => {
    const { cookie, ...rest } = value;
    return { status, body: rest, headers: cookie ? { 'set-cookie': cookie } : {} };
  };
  // Nothing an answer here holds (a session, a token's secret) is kept for replay.
  const r = (def) => api.route({ tag, idempotent: false, ...def });
  return [
    r({ method: 'GET', path: '/api/v1/setup', open: true, summary: 'Whether the owner account is still to be made', run: () => ({ needed: auth.setupNeeded() }) }),
    r({ method: 'POST', path: '/api/v1/setup', open: true, summary: 'Make the owner with the setup code', body: { fields: ['code', 'username', 'password', 'keep'] }, status: 201, run: async ({ body, req }) => signIn(201, await auth.createOwner(body, ctxOf(req, undefined, body))) }),
    r({ method: 'POST', path: '/api/v1/auth/login', open: true, summary: 'Sign in', body: { fields: ['username', 'password', 'code', 'keep'] }, run: async ({ body, req }) => signIn(200, await auth.login(body, ctxOf(req, undefined, body))) }),
    r({ method: 'POST', path: '/api/v1/auth/logout', summary: 'Sign out', body: { fields: [] }, run: ({ who, req }) => signIn(200, auth.logout(who, ctxOf(req, who))) }),
    r({ method: 'GET', path: '/api/v1/auth/session', summary: 'Who is asking: user, role, scopes, CSRF token', run: ({ who }) => auth.describe(who) }),
    r({ method: 'GET', path: '/api/v1/auth/sessions', summary: 'Your sessions, newest first', paged: true, run: ({ who, url }) => api.paginate(auth.sessions.list(who), url, (s) => newestFirst(s.id)) }),
    r({ method: 'DELETE', path: '/api/v1/auth/sessions/:id', summary: 'End one of your sessions', run: ({ who, params, req }) => {
      const ctx = ctxOf(req, who);
      const out = auth.sessions.revoke(who, params.id, ctx);
      return signIn(200, out.current ? { ...out, cookie: auth.clearCookie(ctx.https) } : out);
    } }),
    r({ method: 'POST', path: '/api/v1/auth/password', summary: 'Change your password', body: { fields: ['current', 'password'] }, run: async ({ who, body, req }) => signIn(200, await auth.changePassword(who, body, ctxOf(req, who))) }),
    r({ method: 'PUT', path: '/api/v1/auth/preferences', command: true, summary: 'Your admin UI look: theme, accent, density (08 §8.6)', body: { fields: ['theme', 'accent', 'density'] }, run: ({ who, body }) => auth.setPreferences(who, body) }),
    r({ method: 'POST', path: '/api/v1/auth/totp/enroll', summary: 'Start two-factor: a secret for your authenticator app', body: { fields: ['password'] }, run: ({ who, body, req }) => auth.totp.enroll(who, body, ctxOf(req, who)) }),
    r({ method: 'POST', path: '/api/v1/auth/totp/verify', summary: 'Turn two-factor on with a code: ten recovery codes, once', body: { fields: ['code'] }, run: ({ who, body, req }) => signIn(200, auth.totp.verify(who, body, ctxOf(req, who))) }),
    r({ method: 'DELETE', path: '/api/v1/auth/totp', summary: 'Turn two-factor off (with your password)', body: { fields: ['password'] }, run: async ({ who, body, req }) => signIn(200, await auth.totp.disable(who, body, ctxOf(req, who))) }),
    r({ method: 'GET', path: '/api/v1/users', scope: 'users:admin', summary: 'Accounts', paged: true, run: ({ url }) => api.paginate(auth.users.list(), url, (u) => `${u.createdAt}|${u.id}`) }),
    r({ method: 'POST', path: '/api/v1/users', scope: 'users:admin', summary: 'Add an account', body: { fields: ['username', 'password', 'role'] }, status: 201, run: async ({ who, body, req }) => ({ status: 201, body: await auth.users.create(body, ctxOf(req, who)) }) }),
    r({ method: 'GET', path: '/api/v1/users/:ref', scope: 'users:admin', summary: 'An account', run: ({ params }) => auth.users.get(params.ref) }),
    // An account has an ETag like any resource: the admin UI changes the one it read (If-Match).
    r({ method: 'PATCH', path: '/api/v1/users/:ref', scope: 'users:admin', summary: 'Change a role, set a password, or turn two-factor off', body: { fields: ['role', 'password', 'totp'] }, resource: (p) => auth.users.get(p.ref), run: ({ who, params, body, req, ifRev }) => auth.users.update(params.ref, body, { ...ctxOf(req, who), who, ifRev }) }),
    r({ method: 'DELETE', path: '/api/v1/users/:ref', scope: 'users:admin', summary: 'Remove an account, its sessions and tokens', run: ({ who, params, req }) => auth.users.remove(params.ref, ctxOf(req, who)) }),
    r({ method: 'GET', path: '/api/v1/tokens', summary: 'Your API tokens (?all=true: everyone\'s, for the owner)', paged: true, query: ['all'], run: ({ who, url }) => api.paginate(auth.tokens.list(who, { all: url.searchParams.get('all') === 'true' }), url) }),
    r({ method: 'POST', path: '/api/v1/tokens', summary: 'Create an API token (its secret is shown once)', body: { fields: ['name', 'scopes', 'expiresAt', 'expiresInDays', 'ips'] }, status: 201, run: ({ who, body, req }) => ({ status: 201, body: auth.tokens.create(who, body, ctxOf(req, who)) }) }),
    r({ method: 'DELETE', path: '/api/v1/tokens/:id', summary: 'Revoke an API token', run: ({ who, params, req }) => auth.tokens.revoke(who, params.id, ctxOf(req, who)) }),
    r({ method: 'GET', path: '/api/v1/system/audit', scope: 'audit:read', tag: 'System', summary: 'The audit log, newest first (?action=, ?limit=, ?cursor=)', paged: true, query: ['action'], run: ({ url }) => {
      const limit = Number(url.searchParams.get('limit') ?? 50);
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new AuthError('"limit" is 1 to 200.', 'invalid');
      return audit.list({ limit, cursor: url.searchParams.get('cursor') || undefined, action: url.searchParams.get('action') || undefined });
    } }),
  ];
}