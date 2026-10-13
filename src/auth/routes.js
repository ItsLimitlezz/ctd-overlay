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
import { jsonBody, refusedHere } from '../http/local.js';
import { sendJson, sendProblem } from '../http/server.js';
import { AuthError } from './index.js';

const BODY_LIMIT = 16 * 1024;
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
const TITLES = { 401: 'Not signed in', 403: 'Forbidden', 404: 'Not found', 409: 'Conflict', 422: 'Not possible', 429: 'Too many requests' };
const problemType = (code) => `https://skp.dev/errors/${code}`;

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

// guard(req, res, scope): the principal, or undefined once a problem has been sent.
export function createGuard({ auth, hosts }) {
  return function guard(req, res, scope) {
    if (refusedHere(req, res, hosts)) return undefined;
    const result = auth.authenticate(req);
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

export function authRoutes({ auth, audit, guard, hosts, log }) {
  // open: no sign-in needed (setup, login). scope: what the principal must hold; null for any.
  const route = (method, path, { open = false, scope = null } = {}, run) => ({
    method,
    path,
    async handler({ req, res, params, url }) {
      let who;
      if (open) {
        if (refusedHere(req, res, hosts)) return;
      } else {
        who = guard(req, res, scope);
        if (!who) return;
      }
      const body = method === 'GET' ? {} : await jsonBody(req, res, BODY_LIMIT);
      if (body === undefined) return;
      if (!body || typeof body !== 'object' || Array.isArray(body)) return sendProblem(res, 400, 'Bad request', 'The body must be a JSON object.');
      const ctx = { ip: req.client?.ip ?? req.socket.remoteAddress, https: Boolean(req.client?.https), ua: req.headers['user-agent'], actor: who?.label, keep: body.keep === true };
      try {
        const [status, value] = await run({ who, params, body, ctx, url });
        // A sign-in's cookie goes in its header, never the body.
        const isObject = value && typeof value === 'object' && !Array.isArray(value);
        const { cookie, ...rest } = isObject ? value : {};
        sendJson(res, status, isObject ? rest : value, cookie ? { 'set-cookie': cookie } : {});
      } catch (err) {
        if (err instanceof AuthError) {
          return sendProblem(res, err.status, TITLES[err.status] || 'Refused', err.message, { type: problemType(err.code), headers: err.retryAfterS ? { 'retry-after': String(err.retryAfterS) } : {} });
        }
        if (err.name === 'ConflictError') return sendProblem(res, 409, 'Conflict', 'That changed meanwhile; read it again and retry.', { type: problemType('conflict') });
        log.error('an account request failed', { method, path, err });
        throw err;
      }
    },
  });

  return [
    route('GET', '/api/v1/setup', { open: true }, () => [200, { needed: auth.setupNeeded() }]),
    route('POST', '/api/v1/setup', { open: true }, async ({ body, ctx }) => [201, await auth.createOwner(body, ctx)]),
    route('POST', '/api/v1/auth/login', { open: true }, async ({ body, ctx }) => [200, await auth.login(body, ctx)]),
    route('POST', '/api/v1/auth/logout', {}, ({ who, ctx }) => [200, auth.logout(who, ctx)]),
    route('GET', '/api/v1/auth/session', {}, ({ who }) => [200, auth.describe(who)]),
    route('GET', '/api/v1/auth/sessions', {}, ({ who }) => [200, auth.sessions.list(who)]),
    route('DELETE', '/api/v1/auth/sessions/:id', {}, ({ who, params, ctx }) => {
      const out = auth.sessions.revoke(who, params.id, ctx);
      return [200, out.current ? { ...out, cookie: auth.clearCookie(ctx.https) } : out];
    }),
    route('POST', '/api/v1/auth/password', {}, async ({ who, body, ctx }) => [200, await auth.changePassword(who, body, ctx)]),
    route('POST', '/api/v1/auth/totp/enroll', {}, async ({ who, body }) => [200, await auth.totp.enroll(who, body)]),
    route('POST', '/api/v1/auth/totp/verify', {}, ({ who, body, ctx }) => [200, auth.totp.verify(who, body, ctx)]),
    route('DELETE', '/api/v1/auth/totp', {}, async ({ who, body, ctx }) => [200, await auth.totp.disable(who, body, ctx)]),
    route('GET', '/api/v1/users', { scope: 'users:admin' }, () => [200, auth.users.list()]),
    route('POST', '/api/v1/users', { scope: 'users:admin' }, async ({ body, ctx }) => [201, await auth.users.create(body, ctx)]),
    route('GET', '/api/v1/users/:ref', { scope: 'users:admin' }, ({ params }) => [200, auth.users.get(params.ref)]),
    route('PATCH', '/api/v1/users/:ref', { scope: 'users:admin' }, async ({ params, body, ctx }) => [200, await auth.users.update(params.ref, body, ctx)]),
    route('DELETE', '/api/v1/users/:ref', { scope: 'users:admin' }, ({ params, ctx }) => [200, auth.users.remove(params.ref, ctx)]),
    route('GET', '/api/v1/tokens', {}, ({ who, url }) => [200, auth.tokens.list(who, { all: url.searchParams.get('all') === 'true' })]),
    route('POST', '/api/v1/tokens', {}, ({ who, body, ctx }) => [201, auth.tokens.create(who, body, ctx)]),
    route('DELETE', '/api/v1/tokens/:id', {}, ({ who, params, ctx }) => [200, auth.tokens.revoke(who, params.id, ctx)]),
    route('GET', '/api/v1/system/audit', { scope: 'audit:read' }, ({ url }) => {
      const limit = Number(url.searchParams.get('limit') ?? 50);
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new AuthError('"limit" is 1 to 200.', 'invalid');
      return [200, audit.list({ limit, cursor: url.searchParams.get('cursor') || undefined, action: url.searchParams.get('action') || undefined })];
    }),
  ];
}
