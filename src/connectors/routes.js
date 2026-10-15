// Connections over HTTP (03 §3.4 "Connections"), on the API's conventions (http/api.js):
//
//   GET    /api/v1/connectors                      what can be connected: fields, sign-in, scopes and
//                                                  why, the redirect URI, the setup guide (08 §8.7)
//   GET    /api/v1/connectors/:id
//   GET    /api/v1/connections                     every connection, paged by name
//   POST   /api/v1/connections                     { connector, name?, enabled?, config?, secrets? }
//   GET    /api/v1/connections/:id
//   PATCH  /api/v1/connections/:id                 { name?, enabled?, config?, secrets? } (If-Match);
//                                                  secrets: { field: "new" } sets, null clears, absent keeps
//   DELETE /api/v1/connections/:id                 → { id, name, overlays } (the overlays it fed)
//   POST   /api/v1/connections/:id/authorize       start signing in → { flow: 'device', userCode,
//                                                  verificationUri, … } or { flow: 'redirect', url, … }
//   POST   /api/v1/connections/:id/authorize/complete   { url } (the address landed on) or { code, state }
//   DELETE /api/v1/connections/:id/authorize       cancel a sign-in in progress, else sign out
//   POST   /api/v1/connections/:id/test            a live check → { ok, health, checks }
//   POST   /api/v1/connections/:id/actions/:name   { args } → { connection, action, result }
//   GET    /oauth/callback/:connector              where a service sends the operator back (outside
//                                                  /api/v1): finishes the sign-in, or asks to paste
//   POST   /hooks/:connector[/:connection]          a service's deliveries (outside /api/v1, 07 §7.9)
//
// Seeing connections takes connections:read and changing them connections:write (owners and
// admins: operators run the show without seeing credentials, 07 §7.5). An action takes
// overlays:control, or what its definition asks for. Answers never hold a secret; those that start
// or finish a sign-in, or run a live check, aren't kept for Idempotency-Key replay.
import { ApiError } from '../http/api.js';
import { refusedHere } from '../http/local.js';
import { BASE_HEADERS, readBytes } from '../http/server.js';
import { fromRedirect, principalOf, samePrincipal } from './oauth.js';

const HOOK_BYTES = 256 * 1024;

export function connectorRoutes({ api, host, auth, hosts, log }) {
  const tag = 'Connections';
  const r = (def) => api.route({ tag, ...def });
  const rev = (p) => host.rev(p.id);
  const ctx = (who, req) => ({ who, ip: req.client?.ip });

  // The OAuth callback and the hooks are served outside /api/v1, so the API's document (which
  // describes /api/v1 exactly) leaves them out; 03 §3.4 lists them.
  return [
    r({ method: 'GET', path: '/api/v1/connectors', scope: 'connections:read', summary: 'What can be connected: settings, sign-in, scopes and why, redirect URI, setup guide', paged: true, run: ({ url }) => api.paginate(host.definitions(), url, (d) => d.id) }),
    r({ method: 'GET', path: '/api/v1/connectors/:id', scope: 'connections:read', summary: 'One connector, with its setup guide', run: ({ params }) => host.connector(params.id) }),
    r({ method: 'GET', path: '/api/v1/connections', scope: 'connections:read', summary: 'Connections, by name, with their health', paged: true, run: ({ url }) => api.paginate(host.list().sort((a, b) => (key(a) < key(b) ? -1 : 1)), url, key) }),
    r({ method: 'POST', path: '/api/v1/connections', scope: 'connections:write', summary: 'Add a connection (its secrets are kept encrypted and never shown again)', body: { fields: ['connector', 'name', 'enabled', 'config', 'secrets'] }, status: 201, run: ({ body, who, req }) => {
      if (typeof body.connector !== 'string') throw new ApiError(422, 'invalid', '"connector" is the id of a connector from GET /api/v1/connectors.');
      return { status: 201, body: host.create(body, ctx(who, req)) };
    } }),
    r({ method: 'GET', path: '/api/v1/connections/:id', scope: 'connections:read', summary: 'A connection, its health and what it feeds', run: ({ params }) => host.get(params.id) }),
    r({ method: 'PATCH', path: '/api/v1/connections/:id', scope: 'connections:write', summary: 'Rename, turn on or off, or change settings and secrets (null clears a secret)', body: { fields: ['name', 'enabled', 'config', 'secrets'] }, resource: rev, run: ({ params, body, who, req, ifRev }) => host.update(params.id, body, { ...ctx(who, req), ifRev }) }),
    r({ method: 'DELETE', path: '/api/v1/connections/:id', scope: 'connections:write', summary: 'Delete a connection: overlays stop showing its chat and counts', resource: rev, run: ({ params, who, req, ifRev }) => host.remove(params.id, { ...ctx(who, req), ifRev }) }),
    r({ method: 'POST', path: '/api/v1/connections/:id/authorize', scope: 'connections:write', idempotent: false, summary: 'Start signing in: a code to type (device) or an address to open (redirect)', body: { fields: [] }, run: ({ params, who, req }) => host.authorize(params.id, ctx(who, req)) }),
    r({ method: 'POST', path: '/api/v1/connections/:id/authorize/complete', scope: 'connections:write', idempotent: false, summary: 'Finish signing in with the address the service sent you to ({ url }), or its { code, state }', body: { fields: ['url', 'code', 'state'] }, run: async ({ params, body, who, req }) => {
      let got;
      if (typeof body.url === 'string') got = fromRedirect(body.url.trim());
      else if (typeof body.code === 'string' && typeof body.state === 'string') got = { code: body.code, state: body.state };
      if (!got || !got.state) throw new ApiError(422, 'invalid', 'Paste the whole address the service sent you to (it has ?code=…&state=… in it).');
      await host.completeRedirect({ ...got, id: params.id }, ctx(who, req));
      return host.get(params.id);
    } }),
    r({ method: 'DELETE', path: '/api/v1/connections/:id/authorize', scope: 'connections:write', summary: 'Cancel a sign-in in progress; with none, sign the account out', run: ({ params, who, req }) => host.cancelAuthorization(params.id, ctx(who, req)) }),
    r({ method: 'POST', path: '/api/v1/connections/:id/test', scope: 'connections:write', idempotent: false, summary: 'A live check: settings, sign-in, and the service answering', body: { fields: [] }, run: ({ params, who, req }) => host.test(params.id, ctx(who, req)) }),
    r({ method: 'POST', path: '/api/v1/connections/:id/actions/:name', scope: 'overlays:control', command: true, summary: 'Run a connector action (obs.setScene …); some need connections:write', body: { fields: ['args'] }, run: async ({ params, body, who, req }) => {
      const scope = host.actionScope(params.id, params.name);
      if (!who.scopes.has(scope)) throw new ApiError(403, 'forbidden', `This action needs the "${scope}" permission, which ${who.label} doesn't have.`);
      return host.runAction(params.id, params.name, body.args ?? {}, ctx(who, req));
    } }),

    { method: 'GET', path: '/oauth/callback/:connector', handler: (x) => callback(x).catch((err) => fail(x, err)) },
    { method: 'POST', path: '/hooks/:connector', handler: (x) => hook(x).catch((err) => fail(x, err)) },
    { method: 'POST', path: '/hooks/:connector/:connection', handler: (x) => hook(x).catch((err) => fail(x, err)) },
  ];

  function fail({ res, req }, err) {
    log.error('a connection request failed', { path: String(req.url || '').split('?')[0], err: err.message });
    if (res.headersSent) return res.destroy();
    return page(res, 500, 'Something went wrong', 'The platform hit an unexpected error and logged it. Go back to Connections and try again.');
  }

  // The service's redirect back (06 §6.4). Its query (code, state) is never logged or echoed.
  async function callback({ req, res, params, url }) {
    if (refusedHere(req, res, hosts)) return undefined;
    const q = url.searchParams;
    const state = q.get('state') || '';
    const found = host.peekFlow(state);
    if (!found.flow) {
      return page(res, 400, 'This sign-in link no longer works', found.reason === 'used'
        ? 'It was already used. If the connection still isn\'t signed in, start again with Authorize on the Connections page.'
        : 'Sign-in links last 10 minutes and work once. Start again with Authorize on the Connections page.');
    }
    const f = found.flow;
    if (f.connector !== params.connector) return page(res, 400, 'This sign-in link doesn\'t match', 'It was made for another service. Start again with Authorize on the Connections page.');
    const back = (status) => {
      res.writeHead(303, { ...BASE_HEADERS, 'referrer-policy': 'no-referrer', location: `/#/connections/${encodeURIComponent(f.conn)}?authorize=${status}` });
      res.end();
    };
    // Who is this browser? Only whoever started the sign-in may finish it here; anyone else is
    // asked to paste the address where they started it (the flow stays open for them).
    const who = auth.authenticate(req, { touch: false }).principal;
    // Declined at the service: the flow is over, whoever's browser this is (its description is
    // the service's text, never echoed).
    if (q.get('error')) {
      host.denyFlow(state, q.get('error'), { who, ip: req.client?.ip });
      return back('denied');
    }
    if (!who || !samePrincipal(principalOf(who), f.principal) || !who.scopes.has('connections:write')) {
      return page(res, 200, 'Finish signing in', 'This browser isn\'t signed in to the platform as whoever started the sign-in. Copy this page\'s whole address (from the address bar), go back to the connection on the Connections page where you started, and paste it under "Finish sign-in". It works for 10 minutes.');
    }
    try {
      await host.completeRedirect({ state, code: q.get('code') || '', connector: params.connector }, { who, ip: req.client?.ip });
      return back('done');
    } catch {
      return back('failed');
    }
  }

  // A delivery: the raw body (signatures are over the exact bytes), at most 256 KiB.
  async function hook({ req, res, params }) {
    if (refusedHere(req, res, hosts)) return undefined;
    let body;
    try {
      body = await readBytes(req, HOOK_BYTES);
    } catch (err) {
      res.writeHead(err.status || 400, { ...BASE_HEADERS, ...(err.headers || {}) });
      return res.end();
    }
    let out;
    try {
      out = await host.inbound(params.connector, params.connection, { headers: req.headers, body, query: Object.fromEntries(new URL(req.url, 'http://x').searchParams) });
    } catch (err) {
      const status = err.status || 500;
      res.writeHead(status, { ...BASE_HEADERS, 'content-type': 'application/problem+json' });
      return res.end(JSON.stringify({ type: `https://skp.dev/errors/${err.code || 'refused'}`, title: 'Refused', status, detail: err.message }));
    }
    if (out.body === undefined || out.status === 204) {
      res.writeHead(out.status, BASE_HEADERS);
      return res.end();
    }
    res.writeHead(out.status, { ...BASE_HEADERS, 'content-type': typeof out.body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8' });
    return res.end(typeof out.body === 'string' ? out.body : JSON.stringify(out.body));
  }
}

const key = (c) => `${c.name.toLowerCase()}|${c.id}`;

// A small page of its own (the admin CSP: no inline script or style; the admin stylesheet).
function page(res, status, title, text) {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]));
  res.writeHead(status, { ...BASE_HEADERS, 'referrer-policy': 'no-referrer', 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title><link rel="stylesheet" href="/ui/styles.css"></head><body><main class="main narrow"><div class="card"><h1>${esc(title)}</h1><p>${esc(text)}</p><p><a class="btn primary" href="/#/connections">Go to Connections</a></p></div></main></body></html>`);
}
