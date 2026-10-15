// A pretend streaming service for connector tests, on 127.0.0.1 (no real network): OAuth (an
// authorize page that redirects back, a token endpoint that checks PKCE and rotates refresh
// tokens, a device flow played from a script, client credentials, revocation), and an API
// (GET /api/viewers, GET /api/me). Every request is recorded; what the API answers next is scripted.
//
//   const svc = await startFakeService();
//   svc.url                       http://127.0.0.1:<port>
//   svc.endpoints                 { api, authorizeUrl, tokenUrl, deviceUrl, revokeUrl } for the host
//   svc.script.viewers = [214, { status: 500 }, { status: 429, retryAfter: 2 }, null, …]
//                                 answers, in order; the last one repeats
//   svc.script.device = ['pending', 'slow_down', 'ok'] (or 'expired', 'denied'), in order
//   svc.script.refresh = 'ok' | 'invalid' | 'down'
//   svc.script.expiresIn = 3600   the access tokens' lifetime, in seconds
//   svc.down = true               every request gets 503
//   svc.requests                  [{ method, path, query, headers, form }]
//   await svc.close()
import { createHash } from 'node:crypto';
import http from 'node:http';

export async function startFakeService() {
  const codes = new Map(); // code → { challenge, redirectUri, clientId }
  const tokens = new Map(); // access token → { kind: 'user' | 'app' }
  let refreshCurrent;
  let n = 0;
  const svc = {
    script: { viewers: [214], device: ['ok'], refresh: 'ok', expiresIn: 3600 },
    down: false,
    requests: [],
    revoked: [],
    tokens,
  };
  const next = (list) => (list.length > 1 ? list.shift() : list[0]);
  const json = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };
  const issue = (kind) => {
    n++;
    const access = `${kind === 'app' ? 'app' : 'at'}-${n}-${'x'.repeat(12)}`;
    tokens.set(access, { kind });
    const out = { access_token: access, token_type: 'bearer', expires_in: svc.script.expiresIn, scope: ['viewers:read'] };
    if (kind === 'user') {
      refreshCurrent = `rt-${n}-${'y'.repeat(12)}`;
      out.refresh_token = refreshCurrent;
    }
    return out;
  };

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const u = new URL(req.url, 'http://x');
      const form = Object.fromEntries(new URLSearchParams(body));
      svc.requests.push({ method: req.method, path: u.pathname, query: Object.fromEntries(u.searchParams), headers: req.headers, form });
      if (svc.down) return json(res, 503, { error: 'down' });
      const bearer = /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1];

      if (req.method === 'GET' && u.pathname === '/authorize') {
        const code = `code-${++n}-${'z'.repeat(10)}`;
        codes.set(code, { challenge: u.searchParams.get('code_challenge'), method: u.searchParams.get('code_challenge_method'), redirectUri: u.searchParams.get('redirect_uri'), clientId: u.searchParams.get('client_id') });
        const back = new URL(u.searchParams.get('redirect_uri'));
        back.searchParams.set('code', code);
        back.searchParams.set('state', u.searchParams.get('state'));
        res.writeHead(302, { location: back.toString() });
        return res.end();
      }
      if (req.method === 'POST' && u.pathname === '/token') {
        if (form.grant_type === 'authorization_code') {
          const c = codes.get(form.code);
          codes.delete(form.code);
          const s256 = form.code_verifier ? createHash('sha256').update(form.code_verifier).digest('base64url') : undefined;
          if (!c || c.method !== 'S256' || s256 !== c.challenge || c.redirectUri !== form.redirect_uri) return json(res, 400, { error: 'invalid_grant', error_description: 'bad code or verifier' });
          return json(res, 200, issue('user'));
        }
        if (form.grant_type === 'refresh_token') {
          if (svc.script.refresh === 'down') return json(res, 500, { error: 'server_error' });
          if (svc.script.refresh === 'invalid' || form.refresh_token !== refreshCurrent) return json(res, 400, { error: 'invalid_grant', error_description: 'Invalid refresh token' });
          return json(res, 200, issue('user'));
        }
        if (form.grant_type === 'client_credentials') return json(res, 200, { ...issue('app'), scope: undefined });
        if (form.grant_type === 'urn:ietf:params:oauth:grant-type:device_code') {
          const step = next(svc.script.device);
          if (step === 'pending') return json(res, 400, { error: 'authorization_pending' });
          if (step === 'slow_down') return json(res, 400, { error: 'slow_down' });
          if (step === 'expired') return json(res, 400, { error: 'expired_token' });
          if (step === 'denied') return json(res, 400, { error: 'access_denied' });
          return json(res, 200, issue('user'));
        }
        return json(res, 400, { error: 'unsupported_grant_type' });
      }
      if (req.method === 'POST' && u.pathname === '/device') {
        return json(res, 200, { device_code: `dc-${++n}-${'d'.repeat(12)}`, user_code: 'WDJB-MJHT', verification_uri: 'https://fake.example/activate', verification_uri_complete: 'https://fake.example/activate?code=WDJB-MJHT', expires_in: 600, interval: 2 });
      }
      if (req.method === 'POST' && u.pathname === '/revoke') {
        svc.revoked.push(form.token);
        return json(res, 200, {});
      }
      if (req.method === 'GET' && u.pathname === '/api/me') {
        if (!bearer || tokens.get(bearer)?.kind !== 'user') return json(res, 401, { message: 'invalid token' });
        return json(res, 200, { id: '144552210', login: 'dprtmnt', name: 'DPRTMNT' });
      }
      if (req.method === 'GET' && u.pathname === '/api/viewers') {
        const a = next(svc.script.viewers);
        if (a && typeof a === 'object') {
          if (a.status === 401) tokens.delete(bearer);
          return json(res, a.status, { message: `scripted ${a.status}` }, a.retryAfter !== undefined ? { 'retry-after': String(a.retryAfter) } : {});
        }
        if (bearer && !tokens.has(bearer)) return json(res, 401, { message: 'invalid token' });
        return json(res, 200, a === null ? { viewers: null, live: false } : { viewers: a, live: true });
      }
      return json(res, 404, { error: 'not_found' });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  svc.url = `http://127.0.0.1:${server.address().port}`;
  svc.endpoints = { api: `${svc.url}/api`, authorizeUrl: `${svc.url}/authorize`, tokenUrl: `${svc.url}/token`, deviceUrl: `${svc.url}/device`, revokeUrl: `${svc.url}/revoke` };
  svc.close = () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); });
  return svc;
}
