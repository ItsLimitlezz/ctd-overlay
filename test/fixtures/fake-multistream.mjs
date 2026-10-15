// A pretend CTD Multi-Stream (its docs/API.md, v1.1) on 127.0.0.1, for the step 16b connector's
// tests: Bearer tokens, GET /api/v1/, /status, /chat, and /events as Server-Sent Events with ids,
// resume from Last-Event-ID (a cursor no longer buffered gets system.reset first), the current
// state on a fresh connect, heartbeats, 401 for a revoked token and 429 for too many streams.
//
//   const ms = await startFakeMultistream();
//   ms.url · ms.token · ms.status (what /status answers; change it freely)
//   ms.emit(type, data, { platform, destination })   an event, buffered and sent to open streams
//   ms.dropStreams()     ends every open stream (a restart, a network blip)
//   ms.forget()          empties the buffer (as after a restart: the next resume gets system.reset)
//   ms.revoked = true    the token is refused (401)
//   ms.tooMany = 1       the next n stream requests get 429 + Retry-After: 1
//   ms.openStreams       how many event streams are open now (the real server allows maxStreams,
//                        5 per token: a 6th gets 429 + Retry-After: 30)
//   ms.skewMs = -90000   its clock runs that far from this machine's (envelope ts and Date header)
//   ms.requests          [{ method, path, query, headers }]
import http from 'node:http';
import { createUlid } from '../../src/ids.js';

export async function startFakeMultistream({ heartbeatMs = 200 } = {}) {
  const ulid = createUlid();
  const streams = new Set();
  const ms = {
    token: `ctd_pat_${'Q'.repeat(43)}`,
    revoked: false,
    tooMany: 0,
    maxStreams: 5,
    skewMs: 0,
    scopes: ['chat:read', 'status:read'],
    requests: [],
    buffer: [],
    chat: [],
    status: {
      session: { status: 'live', startedAt: '2026-10-17T03:00:04Z', title: 'DPRTMNT Saturday', testMode: false, autoGoLive: true },
      feeds: [],
      destinations: [
        { id: 'd-tw', name: 'Twitch', platform: 'twitch', enabled: true, phase: 'live', live: true, down: false, message: null, viewers: 214, since: '2026-10-17T03:00:09Z' },
        { id: 'd-yt', name: 'YouTube', platform: 'youtube', enabled: true, phase: 'live', live: true, down: false, message: null, viewers: 30, since: '2026-10-17T03:00:12Z' },
        { id: 'd-ig', name: 'Instagram', platform: 'instagram', enabled: true, phase: 'recovering', live: false, down: true, message: 'Instagram ended the live (copyright). Starting a new one…', viewers: null, since: '2026-10-17T04:12:40Z' },
      ],
      platforms: [
        { platform: 'twitch', destinations: ['d-tw'], live: true, title: 'DPRTMNT Saturday', startedAt: 1791831609000, viewers: 214, error: null },
        { platform: 'youtube', destinations: ['d-yt'], live: true, title: 'DPRTMNT Saturday', startedAt: 1791831612000, viewers: 30, error: null },
        { platform: 'instagram', destinations: ['d-ig'], live: false, title: 'DPRTMNT Saturday', startedAt: null, viewers: null, error: 'Instagram ended the live (copyright). Starting a new one…' },
      ],
    },
  };
  const envelope = (type, data, { platform = 'core', destination = 'core' } = {}) => ({ id: ulid(), type, ts: Date.now() + ms.skewMs, src: { connector: 'ctd-multi-stream', connection: destination, platform }, data });
  const wants = (types, type) => !types.length || types.some((g) => (g.endsWith('.*') ? type.startsWith(g.slice(0, -1)) : g === type));
  const frame = (res, env, withId = true) => res.write(`${withId ? `id: ${env.id}\n` : ''}event: ${env.type}\ndata: ${JSON.stringify(env)}\n\n`);

  ms.emit = (type, data, opts) => {
    const env = envelope(type, data, opts);
    ms.buffer.push(env);
    if (type === 'chat.message') ms.chat.push(env);
    if (type === 'chat.message.deleted') ms.chat = ms.chat.filter((e) => e.data.id !== data.messageId);
    for (const s of streams) if (wants(s.types, type)) frame(s.res, env);
    return env;
  };
  ms.dropStreams = () => { for (const s of streams) s.res.destroy(); streams.clear(); };
  ms.forget = () => { ms.buffer = []; };
  Object.defineProperty(ms, 'openStreams', { get: () => streams.size });

  const problem = (res, status, code, detail, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/problem+json', ...headers });
    res.end(JSON.stringify({ title: code, status, detail, code }));
  };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    ms.requests.push({ method: req.method, path: u.pathname, query: Object.fromEntries(u.searchParams), headers: req.headers });
    if (ms.skewMs) res.setHeader('date', new Date(Date.now() + ms.skewMs).toUTCString());
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1];
    if (bearer !== ms.token || ms.revoked) return problem(res, 401, 'unauthenticated', 'No/unknown/revoked token');
    const json = (body) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (u.pathname === '/api/v1/' || u.pathname === '/api/v1') return json({ name: 'ctd-multi-stream', version: '0.2.0', apiVersion: 1, token: { name: 'CTD Overlay', scopes: ms.scopes } });
    if (u.pathname === '/api/v1/status') return json(ms.status);
    if (u.pathname === '/api/v1/chat') {
      const limit = Number(u.searchParams.get('limit') || 200);
      const items = ms.chat.slice(-limit);
      return json({ items, next: items.at(-1)?.id ?? null });
    }
    if (u.pathname === '/api/v1/events') {
      if (streams.size >= ms.maxStreams) return problem(res, 429, 'rate_limited', 'Too many streams', { 'retry-after': '30' });
      if (ms.tooMany > 0) {
        ms.tooMany--;
        return problem(res, 429, 'rate_limited', 'Too many streams', { 'retry-after': '1' });
      }
      const types = (u.searchParams.get('types') || '').split(',').map((s) => s.trim()).filter(Boolean);
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
      res.write('retry: 3000\n\n');
      const cursor = req.headers['last-event-id'];
      if (cursor) {
        const at = ms.buffer.findIndex((e) => e.id === cursor);
        if (at < 0) res.write('event: system.reset\ndata: {}\n\n');
        else for (const e of ms.buffer.slice(at + 1)) if (wants(types, e.type)) frame(res, e);
      } else {
        frame(res, envelope('stream.status', ms.status.session), false);
        for (const d of ms.status.destinations) frame(res, envelope('destination.status', d, { platform: d.platform, destination: d.id }), false);
      }
      const s = { res, types };
      streams.add(s);
      const beat = setInterval(() => res.write(': ping\n\n'), heartbeatMs);
      res.on('close', () => { clearInterval(beat); streams.delete(s); });
      return undefined;
    }
    return problem(res, 404, 'not_found', 'Unknown path');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  ms.url = `http://127.0.0.1:${server.address().port}`;
  ms.close = () => new Promise((resolve) => { ms.dropStreams(); server.closeAllConnections(); server.close(() => resolve()); });
  return ms;
}
