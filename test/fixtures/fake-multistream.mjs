// A pretend CTD Relay (its docs/API.md, v1.2) on 127.0.0.1, for the ctd-multistream
// connector's tests: Bearer tokens, GET /api/v1/, /status, /chat, and /events as Server-Sent Events
// with ids, resume from Last-Event-ID (a cursor no longer buffered gets system.reset first), the
// current state on a fresh connect, heartbeats, 401 for a revoked token and 429 for too many
// streams. v1.2: profiles (each with its own status and chat; src.profile on every envelope, null
// for events about none; ?profile= on /status, /chat, /events; tokens limited to one profile),
// pairing, the hub (apps and messages).
//
//   const ms = await startFakeMultistream();
//   ms.url · ms.token · ms.status (what /status answers for the default profile; change it freely)
//   ms.emit(type, data, { platform, destination, profile })   an event, buffered and sent to open
//                        streams (profile: 'default' unless given; null for events about none)
//   ms.dropStreams()     ends every open stream (a restart, a network blip)
//   ms.forget()          empties the buffer (as after a restart: the next resume gets system.reset)
//   ms.revoked = true    every token is refused (401)
//   ms.tooMany = 1       the next n stream requests get 429 + Retry-After: 1
//   ms.openStreams       how many event streams are open now (the real server allows maxStreams,
//                        5 per token: a 6th gets 429 + Retry-After: 30)
//   ms.skewMs = -90000   its clock runs that far from this machine's (envelope ts and Date header)
//   ms.requests          [{ method, path, query, headers, at, body? }]
//
// ms.token is a token from before v1.2 (every profile), with ms.scopes and limited to
// ms.tokenProfile (null). A token for every profile reads the default profile without ?profile=,
// and every profile at once with ?profile=* on /events (each envelope's src.profile says whose).
//   ms.profiles · ms.statuses[id]   the profiles, and each one's /status (the default's is ms.status)
//   ms.setProfileStatus(id, 'live') · ms.renameProfile(id, name) · ms.deleteProfile(id)
//   ms.addProfile({ id, name, slug, color }, status?)   a new profile (profiles.changed)
//   ms.addToken({ profileId, scopes }) → a token, as an admin makes in Settings → API
//   pairing: ms.pairings; ms.approve({ code?, profileId, scopes? }) → its token; ms.deny(); ms.expire();
//            ms.pairingLimited = n (the next n POST /pairing get 429); ms.pairingInterval (s)
//   hub: ms.apps (id → registration), ms.registrations [{ appId, body }], ms.heartbeats,
//        ms.messages (POST /messages bodies), ms.ownApp(id) (registered by another token),
//        ms.injectMessage({ from, to, type, profileId, data }) → the message id (an app.message)
//   ms.legacy = true     answers as before v1.2: no profiles, pairing or hub
//   OBS (its §10, v1.4–v1.6): ms.obsScene({ profile, appId, canvas, scene, sceneUuid, previous,
//        scenes, atMs, eventId, emit }) keeps a canvas's program scene (and its scene list
//        [{ name, uuid }], v1.6) for GET /profiles/<id>/obs and (emit,
//        the default) sends obs.scene with appId, eventId and at; ms.obsOutput({ profile, appId,
//        output, canvas, state, emit }) the same for an output; ms.obsOffline(appId, profile) marks
//        an app offline; ms.noObsRoute = true answers 404 there (a Relay older than v1.4)
//   v1.3's clock (GET /clock?t0=…&profile=…, status:read): ms.clock = {
//     offsetMs   its clock minus the asker's (default ms.skewMs)
//     samples    [{ outMs, procMs, backMs }] used one per request, then none (0, 0, 0): the way out,
//                its own time, the way back; receivedAt = t0 + outMs + offsetMs, sentAt = that + procMs
//     advance    (ms) => …   moves the asker's clock by the whole round trip before answering (a
//                test's fake clock), so its t3 is t0 + outMs + procMs + backMs
//     fps        the feed's frame rate (30)
//     missing    true: answers 404 as a Relay older than v1.3 }
//   Spotify (its §13, v1.8): ms.music[profile] is what GET /music?profile= answers as nowPlaying
//        (null: none connected); ms.setMusic({ profile, playing, track, progressMs, at, emit })
//        keeps one and (emit, the default) sends music.nowplaying; ms.noMusicRoute = true answers
//        404 there (a Relay older than v1.8)
//   The session's startedAt is Date.parse(status.session.startedAt): on its clock, as written.
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import { createUlid } from '../../src/ids.js';

const NO_PROFILE = new Set(['profiles.changed', 'apps.changed', 'system.reset']);
const SCOPE_OF = [[/^(chat|alert)\.|^music\.request$/, 'chat:read'], [/^(stream|feed|destination|profile|profiles|obs|music)\.|^system\.notice$/, 'status:read'], [/^apps?\./, 'apps:read']];
const CODE_CHARS = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

export async function startFakeMultistream({ heartbeatMs = 200, pairingInterval = 1 } = {}) {
  const ulid = createUlid();
  const streams = new Set();
  const t0 = '2026-10-11T18:00:00Z';
  const ms = {
    token: `ctd_pat_${'Q'.repeat(43)}`,
    revoked: false,
    tooMany: 0,
    maxStreams: 5,
    skewMs: 0,
    scopes: ['chat:read', 'status:read'],
    tokenProfile: null,
    legacy: false,
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
    profiles: [
      { id: 'default', name: 'Miami or Bust', slug: 'main', color: '#3B82F6', createdAt: t0, updatedAt: t0 },
      { id: 'p-dprtmnt', name: 'DPRTMNT', slug: 'dprtmnt', color: '#E11D48', createdAt: t0, updatedAt: t0 },
    ],
    statuses: {
      'p-dprtmnt': {
        session: { status: 'idle', startedAt: null, title: 'DPRTMNT Takeover', testMode: false, autoGoLive: true },
        feeds: [],
        destinations: [{ id: 'd2-kk', name: 'Kick', platform: 'kick', enabled: true, phase: 'idle', live: false, down: false, message: null, viewers: null, since: t0 }],
        platforms: [{ platform: 'kick', destinations: ['d2-kk'], live: false, title: 'DPRTMNT Takeover', startedAt: null, viewers: null, error: null }],
      },
    },
    tokens: new Map(), // token → { profileId, scopes, v12 }
    pairings: [],
    pairingInterval,
    pairingLimited: 0,
    apps: new Map(), // id → { id, owner, profileId, …registration }
    registrations: [],
    heartbeats: [],
    messages: [],
    clock: { offsetMs: undefined, samples: [], advance: null, fps: 30, missing: false },
  };

  const statusFor = (id) => (id === 'default' ? ms.status : ms.statuses[id]);
  const profileOf = (id) => ms.profiles.find((p) => p.id === id);
  const view = (p) => {
    const s = statusFor(p.id) || { session: { status: 'idle' }, destinations: [] };
    const st = ['live', 'starting', 'stopping'].includes(s.session?.status) ? s.session.status : 'offline';
    const on = (s.destinations || []).filter((d) => d.enabled);
    return { ...p, status: st, startedAt: st === 'live' ? s.session.startedAt ?? null : null, testMode: s.session?.testMode === true, destinations: on.length, live: on.filter((d) => d.live).length, down: on.filter((d) => d.down).length };
  };
  const envelope = (type, data, { platform = 'core', destination = 'core', ...rest } = {}) => {
    const profile = Object.hasOwn(rest, 'profile') ? rest.profile : NO_PROFILE.has(type) ? null : 'default';
    return { id: ulid(), type, ts: Date.now() + ms.skewMs, src: { connector: 'ctd-multi-stream', connection: destination, platform, profile }, data };
  };
  const wants = (types, type) => !types.length || types.some((g) => (g.endsWith('.*') ? type.startsWith(g.slice(0, -1)) : g === type));
  const scopeFor = (type) => SCOPE_OF.find(([re]) => re.test(type))?.[1];
  // Whether a stream gets an envelope: its types, its profile (or none), its token's scopes, and for
  // a message, the token that registered the app it is for.
  const reaches = (s, env) => {
    if (!wants(s.types, env.type)) return false;
    if (env.src.profile !== null && s.profile !== '*' && env.src.profile !== s.profile) return false;
    const need = scopeFor(env.type);
    if (need && !s.tok.scopes.includes(need)) return false;
    if (env.type === 'app.message' && env.data.to !== null && ms.apps.get(env.data.to)?.owner !== s.tok.key) return false;
    return true;
  };
  const frame = (res, env, withId = true) => res.write(`${withId ? `id: ${env.id}\n` : ''}event: ${env.type}\ndata: ${JSON.stringify(env)}\n\n`);

  ms.emit = (type, data, opts) => {
    const env = envelope(type, data, opts);
    ms.buffer.push(env);
    if (type === 'chat.message') ms.chat.push(env);
    if (type === 'chat.message.deleted') ms.chat = ms.chat.filter((e) => e.data.id !== data.messageId);
    for (const s of streams) if (reaches(s, env)) frame(s.res, env);
    return env;
  };
  ms.dropStreams = () => { for (const s of streams) s.res.destroy(); streams.clear(); };

  // ---- OBS (its §10) ------------------------------------------------------------------------------
  ms.obs = {}; // profile → Map(appId → { appId, online, updatedAt, scenes: [], outputs: [] })
  ms.noObsRoute = false;
  const obsApp = (profile, appId) => {
    const apps = (ms.obs[profile] ??= new Map());
    if (!apps.has(appId)) apps.set(appId, { appId, online: true, updatedAt: Date.now(), feeds: [], outputs: [], scenes: [], issues: [] });
    return apps.get(appId);
  };
  let obsSeq = 0;
  const obsEmit = (type, data, profile, appId, eventId) => ms.emit(type, { ...data, appId, eventId: eventId ?? `e${++obsSeq}`, at: Date.now() + ms.skewMs }, { platform: 'obs', destination: appId, profile });
  ms.obsScene = ({ profile = 'default', appId = 'ctd-obs-plugin-studio', canvas = 'landscape', scene, sceneUuid, previous, scenes, atMs = Date.now(), eventId, emit = true } = {}) => {
    const app = obsApp(profile, appId);
    // v1.6: the canvas's scene list, kept when an event comes without one.
    const list = scenes ?? app.scenes.find((s) => s.canvas === canvas)?.scenes;
    app.scenes = [...app.scenes.filter((s) => s.canvas !== canvas), { canvas, scene, ...(sceneUuid ? { sceneUuid } : {}), atMs, ...(list ? { scenes: list } : {}), updatedAt: Date.now() }];
    app.updatedAt = Date.now();
    if (!emit) return undefined;
    return obsEmit('obs.scene', { canvas, scene, ...(sceneUuid ? { sceneUuid } : {}), ...(previous !== undefined ? { previous } : {}), ...(scenes ? { scenes } : {}), atMs }, profile, appId, eventId);
  };
  ms.obsOutput = ({ profile = 'default', appId = 'ctd-obs-plugin-studio', output = 'main', canvas, state = 'live', eventId, emit = true } = {}) => {
    const app = obsApp(profile, appId);
    app.outputs = [...app.outputs.filter((o) => o.output !== output), { output, ...(canvas ? { canvas } : {}), state, updatedAt: Date.now() }];
    if (!emit) return undefined;
    return obsEmit('obs.output', { output, ...(canvas ? { canvas } : {}), state }, profile, appId, eventId);
  };
  ms.obsOffline = (appId = 'ctd-obs-plugin-studio', profile = 'default') => { obsApp(profile, appId).online = false; };

  // ---- Spotify (its §13) ----------------------------------------------------------------------------
  ms.music = {}; // profile → nowPlaying (absent or null: no Spotify connected)
  ms.noMusicRoute = false;
  ms.setMusic = ({ profile = 'default', playing = true, track = null, progressMs = 0, at = Date.now() + ms.skewMs, emit = true } = {}) => {
    const np = { playing, track, progressMs, at };
    ms.music[profile] = np;
    return emit ? ms.emit('music.nowplaying', np, { profile }) : undefined;
  };
  ms.forget = () => { ms.buffer = []; };
  Object.defineProperty(ms, 'openStreams', { get: () => streams.size });

  // ---- profiles ---------------------------------------------------------------------------------
  ms.setProfileStatus = (id, status) => {
    const s = statusFor(id);
    s.session = { ...s.session, status: status === 'offline' ? 'idle' : status, startedAt: status === 'live' ? new Date().toISOString() : null };
    return ms.emit('profile.status', view(profileOf(id)), { profile: id });
  };
  ms.renameProfile = (id, name) => {
    profileOf(id).name = name;
    ms.emit('profile.status', view(profileOf(id)), { profile: id });
    return ms.emit('profiles.changed', {}, { profile: null });
  };
  ms.addProfile = (p, status) => {
    ms.profiles.push({ createdAt: t0, updatedAt: t0, ...p });
    ms.statuses[p.id] = status || { session: { status: 'idle', startedAt: null, title: p.name, testMode: false, autoGoLive: true }, feeds: [], destinations: [], platforms: [] };
    return ms.emit('profiles.changed', {}, { profile: null });
  };
  ms.deleteProfile = (id) => {
    ms.profiles = ms.profiles.filter((p) => p.id !== id);
    delete ms.statuses[id];
    for (const app of ms.apps.values()) app.resources = (app.resources || []).filter((r) => r.profileId !== id);
    return ms.emit('profiles.changed', {}, { profile: null });
  };

  // ---- tokens and pairing -------------------------------------------------------------------------
  const newToken = () => `ctd_pat_${randomBytes(32).toString('base64url')}`;
  ms.addToken = ({ profileId = null, scopes = ['status:read', 'chat:read', 'apps:read', 'apps:write'] } = {}) => {
    const token = newToken();
    ms.tokens.set(token, { profileId, scopes, v12: true });
    return token;
  };
  const pairingBy = (code) => (code ? ms.pairings.find((p) => p.code === code) : ms.pairings.filter((p) => p.state === 'pending').at(-1));
  ms.approve = ({ code, profileId = null, scopes } = {}) => {
    const p = pairingBy(code);
    p.token = ms.addToken({ profileId, scopes: scopes ?? p.scopes });
    p.profileId = profileId;
    p.state = 'approved';
    return p.token;
  };
  ms.deny = (code) => { pairingBy(code).state = 'denied'; };
  ms.expire = (code) => { pairingBy(code).state = 'expired'; };

  // ---- the hub ----------------------------------------------------------------------------------
  ms.ownApp = (id, { profileId = null } = {}) => ms.apps.set(id, { id, owner: 'someone-else', name: 'CTD Overlay', kind: 'ctd-overlay', profileId, resources: [] });
  ms.injectMessage = ({ from = 'ctd-obs-plugin-studio', to, type, profileId = null, data = {}, replyTo = null }) => {
    if (!ms.apps.has(from)) ms.apps.set(from, { id: from, owner: 'plugin', name: 'CTD OBS plugin', kind: 'ctd-obs-plugin', profileId: null, resources: [] });
    const id = ulid();
    ms.emit('app.message', { id, from, to, type, profileId, replyTo, data, ts: Date.now() }, { profile: profileId });
    return id;
  };

  const problem = (res, status, code, detail, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/problem+json', ...headers });
    res.end(JSON.stringify({ title: code, status, detail, code }));
  };
  const readBody = (req) => new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
  const tokenOf = (bearer) => {
    if (!bearer || ms.revoked) return undefined;
    if (bearer === ms.token) return { key: 'main', profileId: ms.tokenProfile, scopes: ms.scopes, v12: false };
    const t = ms.tokens.get(bearer);
    return t ? { key: bearer, ...t } : undefined;
  };
  // The profile a request reads: the token's, else ?profile= (* for every one, /events only), else
  // the default (its §9.1: as before profiles existed, whatever the token).
  function profileFor(tok, asked, { every = false } = {}) {
    if (tok.profileId) {
      if (asked && asked !== '*' && asked !== 'all' && asked !== tok.profileId) return { error: [403, 'profile_forbidden', 'This token is limited to another profile.'] };
      return { profile: tok.profileId };
    }
    if (asked === '*' || asked === 'all') return every ? { profile: '*' } : { error: [400, 'invalid', 'profile=* is for /events only'] };
    if (asked) return profileOf(asked) ? { profile: asked } : { error: [404, 'unknown_profile', `No profile ${asked}`] };
    return { profile: 'default' };
  }

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const body = ['POST', 'PUT'].includes(req.method) ? await readBody(req) : undefined;
    let json;
    try { json = body?.length ? JSON.parse(body.toString('utf8')) : undefined; } catch { json = undefined; }
    ms.requests.push({ method: req.method, path: u.pathname, query: Object.fromEntries(u.searchParams), headers: req.headers, at: Date.now(), ...(json !== undefined ? { body: json } : {}) });
    if (ms.skewMs) res.setHeader('date', new Date(Date.now() + ms.skewMs).toUTCString());
    const send = (status, out) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(out)); };
    const json200 = (out) => send(200, out);
    const path = u.pathname.replace(/\/+$/, '') || '/';

    // Pairing: no token.
    if (path === '/api/v1/pairing' && req.method === 'POST') {
      if (ms.legacy) return problem(res, 404, 'not_found', 'Unknown path');
      if (ms.pairingLimited > 0) { ms.pairingLimited--; return problem(res, 429, 'rate_limited', 'Too many pending', { 'retry-after': '30' }); }
      if (!json || typeof json.appName !== 'string' || typeof json.kind !== 'string' || !Array.isArray(json.scopes)) return problem(res, 400, 'invalid', 'appName, kind and scopes are needed');
      const id = randomBytes(9).toString('base64url');
      const code = [0, 1, 2, '-', 3, 4, 5].map((x) => (x === '-' ? '-' : CODE_CHARS[randomBytes(1)[0] % CODE_CHARS.length])).join('');
      const p = { id, secret: randomBytes(24).toString('base64url'), code, state: 'pending', appName: json.appName, kind: json.kind, scopes: json.scopes.filter((s) => typeof s === 'string'), wish: json.profileId ?? null };
      ms.pairings.push(p);
      return send(201, { pairingId: id, pollSecret: p.secret, code, expiresIn: 600, interval: ms.pairingInterval, approveUrl: `${ms.url.replace('http:', 'https:')}/settings?tab=api&pair=${id}` });
    }
    const poll = /^\/api\/v1\/pairing\/([^/]+)\/token$/.exec(path);
    if (poll && req.method === 'POST') {
      const p = ms.pairings.find((x) => x.id === decodeURIComponent(poll[1]));
      if (!p || json?.pollSecret !== p.secret || ['expired', 'collected'].includes(p.state)) return problem(res, 410, 'expired', 'Expired, collected or unknown');
      if (p.state === 'denied') return problem(res, 403, 'denied', 'Denied by the admin');
      if (p.state === 'pending') return send(202, { status: 'pending' });
      p.state = 'collected';
      return json200({ status: 'approved', token: p.token, profileId: p.profileId, scopes: ms.tokens.get(p.token).scopes });
    }

    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1];
    const tok = tokenOf(bearer);
    if (!tok) return problem(res, 401, 'unauthenticated', 'No/unknown/revoked token');
    const needs = (scope) => {
      if (tok.scopes.includes(scope)) return false;
      problem(res, 403, 'missing_scope', `This token needs the ${scope} scope.`);
      return true;
    };
    const pick = (opts) => {
      const r = profileFor(tok, u.searchParams.get('profile'), opts);
      if (r.error) { problem(res, ...r.error); return undefined; }
      return r.profile;
    };

    if (path === '/api/v1') return json200({ name: 'ctd-multi-stream', version: '0.2.0', apiVersion: 1, token: { name: 'CTD Overlay', scopes: tok.scopes, ...(ms.legacy ? {} : { profileId: tok.profileId }) } });
    if (path === '/api/v1/status') {
      const p = ms.legacy ? 'default' : pick();
      return p && json200(statusFor(p));
    }
    if (path === '/api/v1/chat') {
      const p = ms.legacy ? 'default' : pick();
      if (!p) return undefined;
      const limit = Number(u.searchParams.get('limit') || 200);
      const items = ms.chat.filter((e) => e.src.profile === p).slice(-limit);
      return json200({ items, next: items.at(-1)?.id ?? null });
    }
    if (path === '/api/v1/events') {
      const p = ms.legacy ? 'default' : pick({ every: true });
      if (!p) return undefined;
      const types = (u.searchParams.get('types') || '').split(',').map((s) => s.trim()).filter(Boolean);
      const lacking = types.map((t) => scopeFor(t.replace(/\*$/, 'x'))).find((s) => s && !tok.scopes.includes(s));
      if (lacking) return problem(res, 403, 'missing_scope', `The requested types need ${lacking}.`);
      if (streams.size >= ms.maxStreams) return problem(res, 429, 'rate_limited', 'Too many streams', { 'retry-after': '30' });
      if (ms.tooMany > 0) {
        ms.tooMany--;
        return problem(res, 429, 'rate_limited', 'Too many streams', { 'retry-after': '1' });
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
      res.write('retry: 3000\n\n');
      const s = { res, types, profile: p, tok };
      const cursor = req.headers['last-event-id'];
      if (cursor) {
        const at = ms.buffer.findIndex((e) => e.id === cursor);
        if (at < 0) res.write('event: system.reset\ndata: {}\n\n');
        else for (const e of ms.buffer.slice(at + 1)) if (reaches(s, e)) frame(res, e);
      } else {
        for (const pr of p === '*' ? ms.profiles.map((x) => x.id) : [p]) {
          const st = statusFor(pr);
          if (!st) continue;
          frame(res, envelope('stream.status', st.session, { profile: pr }), false);
          for (const d of st.destinations) frame(res, envelope('destination.status', d, { platform: d.platform, destination: d.id, profile: pr }), false);
        }
      }
      streams.add(s);
      const beat = setInterval(() => res.write(': ping\n\n'), heartbeatMs);
      res.on('close', () => { clearInterval(beat); streams.delete(s); });
      return undefined;
    }
    if (ms.legacy) return problem(res, 404, 'not_found', 'Unknown path');

    if (path === '/api/v1/clock') {
      const c = ms.clock;
      if (c.missing) return problem(res, 404, 'not_found', 'Unknown path');
      if (needs('status:read')) return undefined;
      const p = pick();
      if (!p) return undefined;
      const asked = Number(u.searchParams.get('t0'));
      const t0 = Number.isFinite(asked) ? asked : Date.now();
      const { outMs = 0, procMs = 0, backMs = 0 } = c.samples.shift() || {};
      const receivedAt = t0 + outMs + (c.offsetMs ?? ms.skewMs);
      const sentAt = receivedAt + procMs;
      c.advance?.(outMs + procMs + backMs);
      const session = statusFor(p)?.session || {};
      const started = Date.parse(session.startedAt ?? '');
      const running = ['live', 'starting', 'stopping'].includes(session.status) && Number.isFinite(started);
      return json200({
        t0: Number.isFinite(asked) ? asked : null, receivedAt, sentAt, iso: new Date(sentAt).toISOString(), utcOffsetMinutes: 0, profileId: p,
        session: { status: session.status || 'idle', startedAt: running ? started : null, elapsedMs: running ? sentAt - started : null },
        fps: c.fps, fpsSource: 'landscape', timecode: { run: null, utc: '00:00:00:00', local: '00:00:00:00' },
      });
    }

    if (path === '/api/v1/music') {
      if (ms.noMusicRoute) return problem(res, 404, 'not_found', 'Unknown path');
      if (needs('status:read')) return undefined;
      const p = pick();
      return p && json200({ nowPlaying: ms.music[p] ?? null });
    }

    if (path === '/api/v1/profiles') {
      if (needs('status:read')) return undefined;
      return json200({ items: ms.profiles.filter((p) => !tok.profileId || p.id === tok.profileId).map(view) });
    }
    const obsOf = /^\/api\/v1\/profiles\/([^/]+)\/obs$/.exec(path);
    if (obsOf) {
      if (ms.noObsRoute) return problem(res, 404, 'not_found', 'Unknown path');
      if (needs('status:read')) return undefined;
      const id = decodeURIComponent(obsOf[1]);
      if (tok.profileId && id !== tok.profileId) return problem(res, 403, 'profile_forbidden', 'Another profile');
      if (!profileOf(id)) return problem(res, 404, 'unknown_profile', `No profile ${id}`);
      return json200({ apps: [...(ms.obs[id]?.values() || [])].map((a) => structuredClone(a)) });
    }
    const one = /^\/api\/v1\/profiles\/([^/]+)$/.exec(path);
    if (one) {
      if (needs('status:read')) return undefined;
      const id = decodeURIComponent(one[1]);
      if (tok.profileId && id !== tok.profileId) return problem(res, 403, 'profile_forbidden', 'Another profile');
      const p = profileOf(id);
      return p ? json200(view(p)) : problem(res, 404, 'unknown_profile', `No profile ${id}`);
    }

    if (path === '/api/v1/apps' && req.method === 'GET') {
      if (needs('apps:read')) return undefined;
      return json200({ items: [...ms.apps.values()].map(({ owner: _o, ...a }) => a) });
    }
    const app = /^\/api\/v1\/apps\/([^/]+)(\/heartbeat)?$/.exec(path);
    if (app) {
      if (needs('apps:write')) return undefined;
      const id = decodeURIComponent(app[1]);
      if (!/^[a-z0-9-]{1,40}$/.test(id)) return problem(res, 400, 'invalid', 'Bad app id');
      const had = ms.apps.get(id);
      if (had && had.owner !== tok.key) return problem(res, 409, 'app_owned', `The app "${id}" was registered by another token.`);
      if (app[2] && req.method === 'POST') {
        if (!had) return problem(res, 404, 'not_found', 'Not registered');
        ms.heartbeats.push({ appId: id, at: Date.now() });
        return json200(had);
      }
      if (req.method === 'DELETE') {
        if (!had) return problem(res, 404, 'not_found', 'Not registered');
        ms.apps.delete(id);
        res.writeHead(204);
        return res.end();
      }
      if (req.method !== 'PUT') return problem(res, 404, 'not_found', 'Unknown path');
      if (body.length > 256 * 1024) return problem(res, 413, 'invalid', 'Body over 256 KB');
      if (!json || typeof json.name !== 'string' || typeof json.kind !== 'string') return problem(res, 400, 'invalid', 'name and kind are needed');
      const resources = Array.isArray(json.resources) ? json.resources : [];
      if (resources.length > 200) return problem(res, 400, 'invalid', 'At most 200 resources');
      if (resources.some((r) => r.type === 'overlay' && !/^https?:\/\//.test(r.url || ''))) return problem(res, 400, 'invalid', 'An overlay needs its url');
      if (tok.profileId && resources.some((r) => r.profileId && r.profileId !== tok.profileId)) return problem(res, 403, 'profile_forbidden', 'A resource of another profile');
      ms.registrations.push({ appId: id, body: json, at: Date.now() });
      const saved = { id, owner: tok.key, ...json, resources: resources.filter((r) => !r.profileId || profileOf(r.profileId)), profileId: tok.profileId, registeredAt: had?.registeredAt ?? new Date().toISOString(), lastSeenAt: new Date().toISOString(), online: true };
      ms.apps.set(id, saved);
      const { owner: _o, ...shown } = saved;
      return json200(shown);
    }
    if (path === '/api/v1/messages' && req.method === 'POST') {
      if (needs('apps:write')) return undefined;
      if (!json || typeof json.type !== 'string' || !Object.hasOwn(json, 'to')) return problem(res, 400, 'invalid', 'to and type are needed');
      if (json.to !== null && !ms.apps.has(json.to)) return problem(res, 404, 'not_found', `No app ${json.to}`);
      ms.messages.push({ ...json, at: Date.now() });
      const id = ulid();
      ms.emit('app.message', { id, from: json.from ?? null, to: json.to, type: json.type, profileId: json.profileId ?? tok.profileId ?? null, replyTo: json.replyTo ?? null, data: json.data ?? {}, ts: Date.now() }, { profile: json.profileId ?? null });
      return send(201, { id });
    }
    return problem(res, 404, 'not_found', 'Unknown path');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  ms.url = `http://127.0.0.1:${server.address().port}`;
  ms.close = () => new Promise((resolve) => { ms.dropStreams(); server.closeAllConnections(); server.close(() => resolve()); });
  return ms;
}
