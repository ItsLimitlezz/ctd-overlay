// A pretend GitHub on 127.0.0.1 (no real network), for the GitHub token and private template
// repositories: api.github.com (/user, a repository, its releases, one by tag or the latest, a
// release file that redirects to a signed link on another host), objects.githubusercontent.com
// (the signed link), github.com (public download links, and the device sign-in played from a
// script). The platform reaches it through `fetch`: each https URL the platform asks for goes to
// this server with the host as the first part of the path, so the platform's own rules (https
// only, every hop checked, the token to api.github.com only) apply, and what arrives here is a
// real HTTP request.
//
//   const gh = await startFakeGithub();
//   gh.fetch, gh.lookup              the platform's test hooks (every host is public)
//   gh.token('ghp_…', { login, repos: ['owner/name', …] | '*', scopes: 'repo' })   a token GitHub knows
//   gh.repo('owner/name', { private: true })
//   gh.release('owner/name', tag, { assets: [{ name, data }], prerelease, draft })   newest last
//   gh.limit(on)                     the API answers 403, x-ratelimit-remaining 0
//   gh.script.device = ['pending', 'slow_down', 'ok']   (or 'expired', 'denied'), in order
//   gh.clientId                      the OAuth app the device sign-in knows
//   gh.requests                      [{ method, host, path, query, headers, form }]
//   await gh.close()
import { createHash } from 'node:crypto';
import http from 'node:http';

export async function startFakeGithub() {
  const tokens = new Map(); // token → { login, repos, scopes }
  const repos = new Map(); // owner/name → { private, releases: [{ id, tag, assets: [{ id, name, data }], prerelease, draft, publishedAt }] }
  let n = 0;
  let limited = false;
  const gh = { requests: [], script: { device: ['ok'] }, clientId: 'Ov23liFakeClient01', issued: [] };
  const next = (list) => (list.length > 1 ? list.shift() : list[0]);

  const send = (res, status, body, headers = {}) => {
    const text = body === undefined ? '' : JSON.stringify(body);
    res.writeHead(status, { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers });
    res.end(text);
  };
  // A JSON answer with an ETag, or 304 when If-None-Match has it.
  const tagged = (req, res, body) => {
    const etag = `"${createHash('sha1').update(JSON.stringify(body)).digest('hex').slice(0, 16)}"`;
    if (req.headers['if-none-match'] === etag) return send(res, 304, undefined, { etag });
    return send(res, 200, body, { etag });
  };
  const releaseJson = (repo, r) => ({
    id: r.id,
    tag_name: r.tag,
    name: r.name ?? r.tag,
    draft: Boolean(r.draft),
    prerelease: Boolean(r.prerelease),
    published_at: r.draft ? null : r.publishedAt,
    created_at: r.publishedAt,
    body: 'Release notes.',
    assets: r.assets.map((a) => ({
      id: a.id,
      name: a.name,
      size: a.data.length,
      url: `https://api.github.com/repos/${repo}/releases/assets/${a.id}`,
      browser_download_url: `https://github.com/${repo}/releases/download/${encodeURIComponent(r.tag)}/${encodeURIComponent(a.name)}`,
    })),
    zipball_url: `https://api.github.com/repos/${repo}/zipball/${encodeURIComponent(r.tag)}`,
  });
  const findAsset = (id) => {
    for (const [repo, r] of repos) for (const rel of r.releases) for (const a of rel.assets) if (a.id === id) return { repo, a };
    return undefined;
  };

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      const u = new URL(req.url, 'http://x');
      const [, host, ...rest] = u.pathname.split('/');
      const p = `/${rest.join('/')}`;
      const form = Object.fromEntries(new URLSearchParams(raw));
      gh.requests.push({ method: req.method, host, path: p, query: Object.fromEntries(u.searchParams), headers: req.headers, form });
      const bearer = /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1];
      let m;

      if (host === 'api.github.com') {
        if (limited) return send(res, 403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1900000000' });
        const who = bearer === undefined ? undefined : tokens.get(bearer);
        if (bearer !== undefined && !who) return send(res, 401, { message: 'Bad credentials' });
        const sees = (repo) => {
          const r = repos.get(repo);
          return r && (!r.private || (who && (who.repos === '*' || who.repos.includes(repo)))) ? r : undefined;
        };
        if (p === '/user') {
          if (!who) return send(res, 401, { message: 'Requires authentication' });
          return send(res, 200, { login: who.login, id: 1 }, who.scopes !== undefined ? { 'x-oauth-scopes': who.scopes } : {});
        }
        if ((m = /^\/repos\/([^/]+\/[^/]+)$/.exec(p))) {
          const r = sees(m[1]);
          return r ? send(res, 200, { full_name: m[1], private: r.private, visibility: r.private ? 'private' : 'public' }) : send(res, 404, { message: 'Not Found' });
        }
        if ((m = /^\/repos\/([^/]+\/[^/]+)\/releases$/.exec(p))) {
          const r = sees(m[1]);
          if (!r) return send(res, 404, { message: 'Not Found' });
          // Read from the URL as text: a test may be counting the query parameters the platform reads.
          const per = Number(/[?&]per_page=(\d+)/.exec(req.url)?.[1]) || 30;
          return tagged(req, res, [...r.releases].reverse().slice(0, per).map((x) => releaseJson(m[1], x)));
        }
        if ((m = /^\/repos\/([^/]+\/[^/]+)\/releases\/(?:latest|tags\/(.+))$/.exec(p))) {
          const r = sees(m[1]);
          if (!r) return send(res, 404, { message: 'Not Found' });
          const tag = m[2] === undefined ? undefined : decodeURIComponent(m[2]);
          const rel = tag === undefined ? [...r.releases].reverse().find((x) => !x.draft && !x.prerelease) : r.releases.find((x) => x.tag === tag);
          return rel ? tagged(req, res, releaseJson(m[1], rel)) : send(res, 404, { message: 'Not Found' });
        }
        if ((m = /^\/repos\/([^/]+\/[^/]+)\/releases\/assets\/(\d+)$/.exec(p))) {
          const found = findAsset(Number(m[2]));
          if (!found || found.repo !== m[1] || !sees(m[1])) return send(res, 404, { message: 'Not Found' });
          if (req.headers.accept !== 'application/octet-stream') return send(res, 200, { name: found.a.name, note: 'metadata, not the file' });
          return send(res, 302, undefined, { location: `https://objects.githubusercontent.com/github-production-release-asset/${found.a.id}?X-Amz-Signature=sig${found.a.id}` });
        }
        return send(res, 404, { message: 'Not Found' });
      }

      if (host === 'objects.githubusercontent.com' && (m = /^\/github-production-release-asset\/(\d+)$/.exec(p))) {
        const found = findAsset(Number(m[1]));
        if (!found || /[?&]X-Amz-Signature=([^&]*)/.exec(req.url)?.[1] !== `sig${found.a.id}`) return send(res, 403, { message: 'bad signature' });
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(found.a.data.length) });
        return res.end(found.a.data);
      }

      if (host === 'github.com') {
        if (req.method === 'POST' && p === '/login/device/code') {
          if (form.client_id !== gh.clientId) return send(res, 404, { error: 'Not Found' });
          return send(res, 200, { device_code: `dc-${++n}-${'d'.repeat(20)}`, user_code: 'WDJB-MJHT', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 1 });
        }
        if (req.method === 'POST' && p === '/login/oauth/access_token') {
          if (form.client_id !== gh.clientId || !/^dc-/.test(form.device_code || '') || form.grant_type !== 'urn:ietf:params:oauth:grant-type:device_code') return send(res, 200, { error: 'incorrect_device_code' });
          const step = next(gh.script.device);
          if (step === 'pending') return send(res, 200, { error: 'authorization_pending' });
          if (step === 'slow_down') return send(res, 200, { error: 'slow_down', interval: 3 });
          if (step === 'expired') return send(res, 200, { error: 'expired_token' });
          if (step === 'denied') return send(res, 200, { error: 'access_denied' });
          const token = `gho_${String(++n).padStart(4, '0')}${'o'.repeat(32)}`;
          tokens.set(token, { login: 'device-person', repos: '*', scopes: 'repo' });
          gh.issued.push(token);
          return send(res, 200, { access_token: token, token_type: 'bearer', scope: 'repo' });
        }
        if ((m = /^\/([^/]+\/[^/]+)\/releases\/download\/([^/]+)\/(.+)$/.exec(p))) {
          const r = repos.get(m[1]);
          const rel = r && !r.private && r.releases.find((x) => x.tag === decodeURIComponent(m[2]));
          const a = rel && rel.assets.find((x) => x.name === decodeURIComponent(m[3]));
          return a ? send(res, 302, undefined, { location: `https://objects.githubusercontent.com/github-production-release-asset/${a.id}?X-Amz-Signature=sig${a.id}` }) : send(res, 404, { error: 'Not Found' });
        }
      }
      return send(res, 404, { message: 'Not Found' });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  Object.assign(gh, {
    base,
    // The platform's fetch: the URL's host as the first part of the path, nothing followed.
    fetch: (url, init = {}) => {
      const u = new URL(url);
      if (u.protocol !== 'https:') throw new TypeError('only https');
      return fetch(`${base}/${u.host}${u.pathname}${u.search}`, { method: init.method || 'GET', headers: init.headers, body: init.body, signal: init.signal, redirect: 'manual' });
    },
    lookup: async () => [{ address: '140.82.112.6', family: 4 }],
    token(value, { login = 'someone', repos: list = [], scopes } = {}) { tokens.set(value, { login, repos: list, scopes }); },
    repo(name, { private: priv = false } = {}) { if (!repos.has(name)) repos.set(name, { private: priv, releases: [] }); else repos.get(name).private = priv; },
    release(name, tag, { assets = [], prerelease = false, draft = false } = {}) {
      if (!repos.has(name)) gh.repo(name);
      const r = repos.get(name);
      r.releases.push({ id: ++n, tag, prerelease, draft, publishedAt: new Date(Date.UTC(2026, 0, 1) + n * 60000).toISOString(), assets: assets.map((a) => ({ id: ++n, name: a.name, data: Buffer.from(a.data) })) });
    },
    limit(on = true) { limited = on; },
    // The requests to one host (and path pattern).
    to(host, pattern) { return gh.requests.filter((q) => q.host === host && (!pattern || pattern.test(q.path))); },
    close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }),
  });
  return gh;
}
