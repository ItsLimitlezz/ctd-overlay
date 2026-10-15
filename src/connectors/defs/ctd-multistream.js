// CTD Multi-Stream (PLAN step 16b): the operator's multistreaming server merges chat from every
// destination it relays to (Twitch, YouTube, Kick, Facebook, X, Instagram, TikTok) and serves it in
// this standard's envelope (its docs/API.md, v1.1). This connector follows it with an API token:
//
// - GET /status first (every platform's live state, title and viewers), then the event stream
//   (GET /events, SSE) from the last event seen (Last-Event-ID, kept between starts). With no
//   cursor yet, or when the server says system.reset (the cursor is older than its buffer, or it
//   restarted), the recent chat (GET /chat) goes into the chat buffer quietly (snapshots show it;
//   overlays never replay minutes of old chat at once) and /status is read again.
// - chat.message, its deletions, bans and clears, and alert.<kind> become this platform's events,
//   with src.platform from the envelope and its id as the dedupe key. A platform this standard
//   doesn't know becomes "custom". An alert's chat line (kind "event") is left out while alerts are
//   on and "Hide an alert's chat line" is (the alert shows instead). A clear on one platform
//   removes that platform's messages only: the others stay on screen.
// - viewers.<platform> and stream.<platform>.live | title | startedAt from /status and every
//   destination.status: a count multi-stream doesn't know (null) is absent, never 0 (02 §2.8).
// - Health: connected while the stream is open; degraded, saying why, while a destination is down
//   ("Instagram: ended the live (copyright)…"); its notices are the connection's warnings, for the
//   operator, never for overlays. A refused token (401) needs a new one; a missing permission
//   (403) waits for the token to be fixed; a 429 waits as long as the server asks.
// - Replayed after a restart of this platform: chat older than a minute goes to the buffer quietly,
//   an alert older than two minutes is dropped (its moment has passed).
//
// A relay: where a direct connection (Twitch, step 17) also sets viewers.twitch, the direct one
// is shown (bus/index.js).
import { readSse } from '../sse-client.js';

const PLATFORMS = ['twitch', 'youtube', 'kick', 'facebook', 'x', 'instagram', 'tiktok', 'custom'];
const ROLES = new Set(['broadcaster', 'moderator', 'vip', 'subscriber', 'member', 'verified', 'founder', 'artist', 'bot']);
const FRAGMENTS = new Set(['text', 'emote', 'mention', 'link', 'cheermote']);
const UNITS = new Set(['months', 'count', 'bits', 'kicks', 'viewers', 'currency']);
const TIERS = { 1000: '1', 2000: '2', 3000: '3', Prime: 'prime', prime: 'prime' };
const TEXT_CHARS = 1000; // 02 §2.9
const QUIET_TICKS = 3; // ticks of 15 s with nothing arriving (it sends a heartbeat every 15 s)
const OLD_CHAT_MS = 60 * 1000;
const OLD_ALERT_MS = 2 * 60 * 1000;
const RECENT_IDS = 500;
const NOTICE_MS = 10 * 60 * 1000;
const REAUTH = 'CTD Multi-Stream refused the token: it was revoked or is wrong. Make a new one in CTD Multi-Stream → Settings → API (chat:read and status:read), and paste it into this connection\'s settings.';

const platformOf = (p) => (PLATFORMS.includes(p) ? p : 'custom');
const str = (v) => typeof v === 'string' && v.length > 0;
const https = (v) => str(v) && /^https:\/\/\S+$/.test(v) && v.length <= 2048;

export const ctdMultistream = {
  id: 'ctd-multistream',
  name: 'CTD Multi-Stream',
  platform: 'custom',
  platforms: PLATFORMS,
  relay: true,
  capabilities: ['chat.read', 'alerts', 'viewers', 'stream.status'],
  auth: 'password',
  fields: {
    type: 'object',
    required: ['baseUrl', 'token'],
    properties: {
      baseUrl: { type: 'string', title: 'API address', maxLength: 300, examples: ['http://192.168.1.50:30080/api/v1'], description: 'The LAN URL from CTD Multi-Stream → Settings → API, ending in /api/v1.', 'x-skp-egress': 'lan' },
      token: { type: 'string', title: 'API token', writeOnly: true, pattern: '^ctd_pat_[A-Za-z0-9_-]{16,200}$', description: 'ctd_pat_… from CTD Multi-Stream → Settings → API, with chat:read and status:read.' },
      tlsFingerprint256: { type: 'string', title: 'Certificate fingerprint (SHA-256)', pattern: '^([0-9A-Fa-f]{2}:?){31}[0-9A-Fa-f]{2}$', description: 'Only for an https:// address with a self-signed certificate: the fingerprint shown in Settings → API.' },
      chat: { type: 'boolean', title: 'Chat', default: true, description: 'Chat from every platform it streams to, merged.' },
      alerts: { type: 'boolean', title: 'Alerts', default: true, description: 'Subscriptions, gifts, cheers, raids, memberships and Super Chats.' },
      hideAlertChatLines: { type: 'boolean', title: 'Hide an alert\'s chat line', default: true, description: 'While alerts are on, a sub or a raid shows as the alert, not also as a line of chat.' },
    },
  },
  guide: {
    before: 'CTD Multi-Stream streams to every platform at once and merges their chat. This connection reads its merged chat, alerts, viewer counts and live status, over your local network.',
    steps: [
      'In CTD Multi-Stream, open Settings → API.',
      'Copy the LAN URL (it ends in /api/v1, like http://192.168.1.50:30080/api/v1) into "API address".',
      'Make a new token there with chat:read and status:read, and paste it into "API token". It is shown once; here it is kept encrypted.',
      'Using the https:// address with a self-signed certificate instead? Copy the SHA-256 fingerprint shown there into "Certificate fingerprint".',
      'Save, then Test: it checks the address and the token\'s permissions.',
    ],
    warnings: [
      { text: 'Chat from Instagram, TikTok, X and Facebook profiles is read from their live pages: it has no moderation events, so a message deleted there stays on screen.' },
    ],
  },

  validate(config) {
    let u;
    try { u = new URL(config.baseUrl); } catch { return 'The API address isn\'t a URL: copy the LAN URL from CTD Multi-Stream → Settings → API.'; }
    if (!/\/api\/v1\/?$/.test(u.pathname)) return 'The API address ends in /api/v1: copy the LAN URL from CTD Multi-Stream → Settings → API.';
    if (config.tlsFingerprint256 && u.protocol !== 'https:') return 'A certificate fingerprint is only for an https:// address.';
    return undefined;
  },

  create(ctx) {
    const cfg = ctx.connection.config;
    const base = String(cfg.baseUrl).replace(/\/+$/, '');
    const token = ctx.connection.secrets.token;
    const tls = cfg.tlsFingerprint256 ? { fingerprint256: cfg.tlsFingerprint256 } : undefined;
    const get = (path, { headers, ...rest } = {}) => ctx.http.request(`${base}${path}`, { egress: 'lan', ...(tls ? { tls } : {}), ...rest, headers: { authorization: `Bearer ${token}`, ...(headers || {}) } });

    const dests = new Map(); // destination id → its status
    const startedAt = new Map(); // platform → epoch ms, from /status
    const recent = new Map(); // platform → message ids this connection published (for a clear)
    let session = null;
    let shown = new Set(); // platforms whose state is set
    let notices = []; // [{ text, cancel }]
    let open = false;
    let active = false;
    let quiet = 0;
    let stopping = false;
    const streamStop = new AbortController();

    // ---- state -----------------------------------------------------------------------------
    function applyStatus(s) {
      if (!s || typeof s !== 'object') return;
      session = s.session && typeof s.session === 'object' ? s.session : session;
      dests.clear();
      for (const d of Array.isArray(s.destinations) ? s.destinations : []) if (d && str(d.id)) dests.set(d.id, d);
      startedAt.clear();
      for (const p of Array.isArray(s.platforms) ? s.platforms : []) {
        if (p && Number.isFinite(p.startedAt)) startedAt.set(platformOf(p.platform), p.startedAt);
      }
      publishState();
    }

    function rollup(platform) {
      const ds = [...dests.values()].filter((d) => platformOf(d.platform) === platform);
      const live = ds.some((d) => d.live === true);
      const counts = ds.map((d) => d.viewers).filter((v) => Number.isInteger(v) && v >= 0);
      let since = startedAt.get(platform);
      if (live && !Number.isFinite(since)) {
        const t = ds.filter((d) => d.live === true).map((d) => Date.parse(d.since)).filter(Number.isFinite);
        if (t.length) startedAt.set(platform, (since = Math.min(...t)));
      }
      if (!live) startedAt.delete(platform);
      return { live, viewers: counts.length ? counts.reduce((a, b) => a + b, 0) : undefined, title: str(session?.title) ? session.title : undefined, startedAt: live ? since : undefined };
    }

    function publishState() {
      const now = new Set([...dests.values()].map((d) => platformOf(d.platform)));
      for (const p of now) {
        const r = rollup(p);
        ctx.setState(`viewers.${p}`, r.viewers);
        ctx.setState(`stream.${p}.live`, r.live);
        ctx.setState(`stream.${p}.title`, r.title);
        ctx.setState(`stream.${p}.startedAt`, Number.isFinite(r.startedAt) ? r.startedAt : undefined);
      }
      for (const p of shown) {
        if (now.has(p)) continue;
        for (const k of [`viewers.${p}`, `stream.${p}.live`, `stream.${p}.title`, `stream.${p}.startedAt`]) ctx.setState(k, undefined);
      }
      shown = now;
      health();
    }

    function health() {
      if (!open) return;
      const down = [...dests.values()].filter((d) => d.down === true);
      const said = (d) => {
        const msg = str(d.message) ? d.message : 'not reaching the platform';
        const name = str(d.name) ? d.name : platformOf(d.platform);
        return `${name}: ${msg.startsWith(`${name} `) ? msg.slice(name.length + 1) : msg}`;
      };
      const feeds = [cfg.chat && 'chat', cfg.alerts && 'alerts'].filter(Boolean);
      ctx.setHealth({
        status: down.length ? 'degraded' : 'connected',
        detail: down.length ? `${said(down[0])}${down.length > 1 ? ` (and ${down.length - 1} more down)` : ''}` : `Receiving ${[...feeds, 'live status'].join(', ')} from ${dests.size} destination${dests.size === 1 ? '' : 's'}.`,
        warnings: notices.map((n) => n.text),
      });
    }

    function notice(d) {
      const text = str(d?.message) ? d.message.slice(0, 200) : undefined;
      if (!text) return;
      const n = { text };
      n.cancel = ctx.schedule(NOTICE_MS, () => { notices = notices.filter((x) => x !== n); health(); });
      notices = [...notices.slice(-2), n];
      health();
    }

    // ---- chat and alerts -------------------------------------------------------------------
    function remember(platform, id) {
      const list = recent.get(platform) || [];
      list.push(id);
      if (list.length > RECENT_IDS) list.splice(0, list.length - RECENT_IDS);
      recent.set(platform, list);
    }
    const old = (env, ms) => typeof env.ts === 'number' && ctx.now() - env.ts > ms;

    function chat(env, { backfill = false } = {}) {
      const d = env.data;
      if (!cfg.chat || !d || typeof d !== 'object' || !str(d.id)) return;
      if (d.kind === 'event' && cfg.alerts && cfg.hideAlertChatLines) return;
      const platform = platformOf(env.src?.platform ?? d.platform);
      const msg = chatMessage(d, platform);
      const out = ctx.publish('chat.message', msg, { platform, dedupeKey: `chat:${d.id}`, backfill: backfill || old(env, OLD_CHAT_MS) });
      if (out) remember(platform, d.id);
    }

    function handle(env) {
      const { type } = env;
      const d = env.data && typeof env.data === 'object' ? env.data : {};
      const platform = platformOf(env.src?.platform ?? d.platform);
      const key = `env:${env.id}`;
      if (type === 'chat.message') return chat(env);
      if (type === 'chat.message.deleted') {
        if (cfg.chat && str(d.messageId)) ctx.publish('chat.message.deleted', { messageId: d.messageId }, { platform, dedupeKey: key });
        return undefined;
      }
      if (type === 'chat.user.cleared') {
        if (cfg.chat && str(d.userId)) ctx.publish('chat.user.cleared', { userId: d.userId }, { platform, dedupeKey: key });
        return undefined;
      }
      if (type === 'chat.cleared') {
        // One platform's chat was cleared: its messages go, the others' stay (a chat.cleared here
        // would clear every platform's on every overlay).
        if (!cfg.chat || ctx.seen(key)) return undefined;
        for (const id of recent.get(platform) || []) ctx.publish('chat.message.deleted', { messageId: id }, { platform });
        recent.delete(platform);
        return undefined;
      }
      if (/^alert\.[a-z]+$/.test(type)) {
        if (!cfg.alerts || old(env, OLD_ALERT_MS)) return undefined;
        const a = alertOf(d, type.slice(6), platform);
        if (a) ctx.publish(type, a, { platform, dedupeKey: key });
        return undefined;
      }
      if (type === 'stream.status') { session = d; return publishState(); }
      if (type === 'destination.status') {
        if (str(d.id)) dests.set(d.id, d);
        return publishState();
      }
      if (type === 'destination.down' || type === 'destination.up') {
        const x = dests.get(d.destinationId);
        if (x) {
          x.down = type === 'destination.down';
          if (x.down && str(d.reason)) x.message = d.reason;
          if (!x.down) x.message = null;
          publishState();
        }
        return undefined;
      }
      if (type === 'system.notice') return notice(d);
      return undefined; // feed.status and anything newer: not used here
    }

    // ---- the stream --------------------------------------------------------------------------
    async function refresh(withChat) {
      const status = await get('/status');
      applyStatus(status.data);
      if (withChat && cfg.chat) {
        const r = await get('/chat?limit=200');
        for (const env of Array.isArray(r.data?.items) ? r.data.items : []) if (env && env.type === 'chat.message') chat(env, { backfill: true });
      }
    }

    async function onFrame(frame) {
      ctx.event();
      if (frame.event === 'system.reset') {
        await refresh(true);
        if (str(frame.id) && frame.id.length <= 64) ctx.memory.set('cursor', frame.id);
        return;
      }
      let env;
      try { env = JSON.parse(frame.data); } catch { return; }
      if (!env || typeof env !== 'object' || typeof env.type !== 'string') return;
      handle(env);
      // The cursor is the frame's id (what Last-Event-ID resumes from); a frame without one (the
      // current state sent on connecting) leaves it where it was.
      if (str(frame.id) && frame.id.length <= 64) ctx.memory.set('cursor', frame.id);
    }

    async function follow() {
      const types = [...(cfg.chat ? ['chat.*'] : []), ...(cfg.alerts ? ['alert.*'] : []), 'stream.status', 'destination.status', 'destination.down', 'destination.up', 'system.notice'];
      const cursor = ctx.memory.get('cursor');
      const res = await get(`/events?types=${encodeURIComponent(types.join(','))}`, { expect: 'stream', retries: 0, signal: streamStop.signal, headers: { accept: 'text/event-stream', ...(str(cursor) ? { 'last-event-id': cursor } : {}) } });
      open = true;
      active = true;
      health();
      readSse(res.body, onFrame, { onActivity: () => { active = true; } }).then(
        () => { if (!stopping) ctx.fail(new Error('CTD Multi-Stream closed the event stream; reconnecting.')); },
        (err) => { if (!stopping) ctx.fail(err); },
      );
    }

    return {
      async start() {
        try {
          await refresh(!str(ctx.memory.get('cursor')));
          await follow();
        } catch (err) {
          if (err.status === 401) return ctx.reauth(REAUTH);
          if (err.status === 403) return ctx.fail(new Error('The token can\'t read everything this needs: give it chat:read and status:read in CTD Multi-Stream → Settings → API (or make a new one).'), { retry: false });
          throw err;
        }
        // Nothing for 45 s (it sends a heartbeat every 15): the stream is dead without saying so.
        ctx.every(15000, () => {
          if (active) { active = false; quiet = 0; return; }
          if (++quiet >= QUIET_TICKS) ctx.fail(new Error('CTD Multi-Stream went quiet for 45 s; reconnecting.'));
        });
        return undefined;
      },
      stop() {
        stopping = true;
        streamStop.abort();
      },
      async test() {
        let r;
        try {
          r = await get('/', { retries: 0 });
        } catch (err) {
          if (err.status === 401) return [{ name: 'Token', ok: false, detail: REAUTH }];
          return [{ name: 'Reaching CTD Multi-Stream', ok: false, detail: err.message }];
        }
        const scopes = Array.isArray(r.data?.token?.scopes) ? r.data.token.scopes : [];
        const missing = ['chat:read', 'status:read'].filter((s) => !scopes.includes(s));
        return [
          { name: 'Reaching CTD Multi-Stream', ok: true, detail: `${str(r.data?.name) ? r.data.name : 'ctd-multi-stream'}${str(r.data?.version) ? ` ${r.data.version}` : ''}` },
          { name: 'Token permissions', ok: !missing.length, detail: missing.length ? `The token lacks ${missing.join(' and ')}: add ${missing.length > 1 ? 'them' : 'it'} in CTD Multi-Stream → Settings → API.` : 'chat:read and status:read' },
        ];
      },
    };
  },
};

// A chat.message in this standard's shape (02 §2.3, chat-message.schema.json): nulls left out,
// roles to the closed set, a fragment type it doesn't know as text, long text cut at 1000
// characters (marked truncated), platform and destination kept for templates that tell them apart.
export function chatMessage(d, platform) {
  const u = d.user && typeof d.user === 'object' ? d.user : {};
  let uid = str(u.id) ? u.id : `${platform}:name:${str(u.name) ? u.name : 'unknown'}`;
  if (!PLATFORMS.includes(uid.split(':')[0])) uid = `custom:${uid}`;
  let text = typeof d.text === 'string' ? d.text : '';
  let fragments = Array.isArray(d.fragments) ? d.fragments.filter((f) => f && typeof f.text === 'string').map((f) => fragment(f)) : [];
  if (fragments.map((f) => f.text).join('') !== text) fragments = [{ type: 'text', text }];
  let truncated = false;
  if ([...text].length > TEXT_CHARS) {
    text = [...text].slice(0, TEXT_CHARS).join('');
    fragments = [{ type: 'text', text }];
    truncated = true;
  }
  const badges = Array.isArray(u.badges) ? u.badges.filter((b) => b && str(b.id)).slice(0, 20).map((b) => ({ id: b.id, ...(str(b.label) ? { label: b.label } : {}), ...(https(b.image) ? { image: b.image } : {}) })) : [];
  const reply = d.reply && typeof d.reply === 'object'
    ? Object.fromEntries(['messageId', 'userName', 'text'].filter((k) => str(d.reply[k])).map((k) => [k, d.reply[k]]))
    : null;
  return {
    id: d.id,
    ...(str(d.platformMessageId) ? { platformMessageId: d.platformMessageId } : {}),
    ...(str(d.channel) ? { channel: d.channel } : {}),
    user: {
      id: uid,
      ...(str(u.login) ? { login: u.login } : {}),
      name: str(u.name) ? u.name : str(u.login) ? u.login : 'Someone',
      ...(str(u.color) && /^#[0-9A-Fa-f]{6}$/.test(u.color) ? { color: u.color } : {}),
      ...(https(u.avatar) ? { avatar: u.avatar } : {}),
      roles: [...new Set((Array.isArray(u.roles) ? u.roles : []).filter((r) => ROLES.has(r)))],
      ...(badges.length ? { badges } : {}),
    },
    text,
    ...(truncated ? { truncated: true } : {}),
    fragments,
    reply: reply && Object.keys(reply).length ? reply : null,
    highlighted: d.highlighted === true,
    action: d.action === true,
    platform,
    ...(str(d.destinationId) ? { destinationId: d.destinationId } : {}),
    ...(d.kind === 'event' ? { kind: 'event' } : {}),
  };
}

function fragment(f) {
  if (!FRAGMENTS.has(f.type)) return { type: 'text', text: f.text };
  const out = { type: f.type, text: f.text };
  if (https(f.image)) out.image = f.image;
  if (typeof f.animated === 'boolean') out.animated = f.animated;
  if (f.type === 'link' && /^https?:\/\/\S+$/.test(f.url || '')) out.url = f.url;
  if (str(f.userId)) out.userId = f.userId;
  if (Number.isInteger(f.amount)) out.amount = f.amount;
  return out;
}

// An alert in this standard's shape (02 §2.4, alert.schema.json): Twitch's tiers as 1, 2, 3 and
// prime; money as a decimal string with its currency, never converted.
export function alertOf(d, kind, platform) {
  if (!/^[a-z]+$/.test(kind)) return undefined;
  const u = d.user && typeof d.user === 'object' ? d.user : {};
  const out = {
    kind,
    user: {
      ...(str(u.id) ? { id: u.id } : {}),
      name: str(u.name) ? u.name : u.anonymous === true ? 'Anonymous' : 'Someone',
      ...(https(u.avatar) ? { avatar: u.avatar } : {}),
      ...(u.anonymous === true ? { anonymous: true } : {}),
    },
    platform,
  };
  const a = d.amount;
  if (a && typeof a === 'object' && UNITS.has(a.unit)) {
    if (a.unit === 'currency') {
      if (typeof a.value === 'string' && /^\d+(\.\d{1,4})?$/.test(a.value) && typeof a.currency === 'string' && /^[A-Z]{3}$/.test(a.currency)) out.amount = { value: a.value, unit: 'currency', currency: a.currency };
    } else if (Number.isInteger(a.value) && a.value >= 0) out.amount = { value: a.value, unit: a.unit };
  }
  if (d.tier !== undefined && d.tier !== null) out.tier = TIERS[d.tier] ?? String(d.tier).slice(0, 20);
  if (d.message && typeof d.message === 'object' && typeof d.message.text === 'string') out.message = { text: d.message.text.slice(0, TEXT_CHARS), ...(Array.isArray(d.message.fragments) ? { fragments: d.message.fragments.filter((f) => f && typeof f.text === 'string').map(fragment) } : {}) };
  if (d.gift && typeof d.gift === 'object') {
    const g = {};
    if (Array.isArray(d.gift.recipients)) g.recipients = d.gift.recipients.filter(str).slice(0, 100);
    if (Number.isInteger(d.gift.total)) g.total = d.gift.total;
    out.gift = g;
  }
  if (str(d.destinationId)) out.destinationId = d.destinationId;
  if (str(d.messageId)) out.messageId = d.messageId;
  return out;
}
