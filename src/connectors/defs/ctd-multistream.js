// CTD Relay (PLAN steps 16b, 16c): the operator's multistreaming server merges chat from
// every destination it relays to (Twitch, YouTube, Kick, Facebook, X, Instagram, TikTok) and serves
// it in this standard's envelope (its docs/API.md, v1.2). This connector follows it with an API
// token, its profiles (streaming set-ups of their own, live at the same time: "DPRTMNT", "Miami
// or Bust") each a stream of its own here:
//
// - Connect is pairing (its §9.3, auth 'pairing' in host.js): POST /pairing asks for a token
//   (status:read, chat:read, apps:read, apps:write), CTD Relay shows the code, an admin
//   approves it there and picks the profile (or every profile); the platform polls
//   /pairing/<id>/token at the interval it gives and saves the token it hands over (once) as the
//   connection's token. A token pasted in the settings still works. A refused token (401) needs
//   Connect again.
// - GET / says which profile the token is limited to (or none: every profile). Limited: that
//   profile, read with GET /profiles/<id>; the connection's data is that profile's.
// - A token for every profile follows every profile (the Profile setting empty or "Every
//   profile", the default): GET /profiles lists them, one /events stream reads them all
//   (?profile=*, each envelope's src.profile says whose), /status and /chat are read per profile
//   (?profile=<id>). Each profile is a feed of the connection (bus/owners.js): what it publishes
//   carries src.profile, so an overlay is fed by one profile ("<connection>/<profile>") or all of
//   them (the connection). A profile made there is followed at once (profiles.changed, or the first
//   event naming it); one deleted is dropped, its values gone. Their names, colours and live
//   status are the connection's info.profiles, kept fresh by profile.status. Events about no single
//   profile (profiles.changed, system.notice, app.message) are the connection's. Named
//   "Relay" until someone names it.
// - The Profile setting picks one instead: ?profile=<id> on /status, /chat and /events, so the
//   connection is that profile (as a limited token). Its name, colour and live status are the
//   connection's info.profile (the Live page's "DPRTMNT · Live"), kept fresh by profile.status;
//   profiles.changed reads it again, and a profile deleted there is an error saying so. The
//   connection is named "Relay · <profile>" until someone names it.
// - A server older than v1.2 (no profiles) is read as before.
// - With apps:write it shares the overlays bound to it with the hub, and answers other apps'
//   requests for new ones (ctd-multistream-hub.js).
// - GET /status first (every platform's live state, title and viewers), then the event stream
//   (GET /events, SSE) from the last event seen (Last-Event-ID, kept between starts). With no
//   cursor yet, or when the server says system.reset (the cursor is older than its buffer, or it
//   restarted), the recent chat (GET /chat) goes into the chat buffer quietly (snapshots show it;
//   overlays never replay minutes of old chat at once) and /status is read again (every profile,
//   and which there are, for every profile). A cursor kept from the other kind of stream (one
//   profile, or every one) is never resumed from: it starts afresh.
// - chat.message, its deletions, bans and clears, and alert.<kind> become this platform's events,
//   with src.platform from the envelope and its id as the dedupe key. A platform this standard
//   doesn't know becomes "custom". An alert's chat line is left out while alerts are on and "Hide
//   an alert's chat line" is (the alert shows instead): CTD sends the alert right after its line,
//   with the line's id as its messageId, so a kind "event" line waits for the next frame (300 ms
//   at most) and is dropped only when that frame is its alert. Event lines no alert follows (a
//   Twitch /announce, Kick's Kicks, YouTube's Jewels, TikTok's gifts) are shown. A clear on one
//   destination removes the lines from it that are still in the chat buffer: the others stay on
//   screen. A ban that names the user only also removes their lines that carry an id.
// - It waits for room under the platform's publish limit (ctx.room) rather than lose a burst, and
//   the cursor moves only past a frame whose events were published.
// - viewers.<platform> and stream.<platform>.live | title | startedAt from /status and every
//   destination.status: a count multi-stream doesn't know (null) is absent, never 0 (02 §2.8).
// - Health: connected while the stream is open; degraded, saying why, while a destination is down
//   ("Instagram: ended the live (copyright)…", "Instagram (DPRTMNT): …" following several
//   profiles); its notices are the connection's warnings, for the
//   operator, never for overlays. A refused token (401) needs a new one; a missing permission
//   (403) waits for the token to be fixed; a 429 waits as long as the server asks.
// - The stream clock (its §4, GET /clock, v1.3), with status:read: each profile's session start and
//   frame rate become stream.clock, { startedAt?, fps, offsetMs, at } (02 §2.5.2), its start moved
//   onto this server's clock, so templates count the run time and its timecode from SK.clock. One
//   server answers for every profile, so one offset serves them all: NTP-style, CLOCK_SAMPLES
//   answers a second apart (the profiles' in turn, each one's last answer its session), the one
//   with the lowest round trip kept; again every 5 min, on every start (a reconnect) and after
//   system.reset; a session that starts or stops in between is read again at once (one answer).
//   No per-frame anything: templates run the clock themselves. A Relay older than v1.3 (404) is
//   asked once a start and says so in one warning; no clock state then.
// - Replayed after a restart of this platform: chat older than a minute goes to the buffer quietly,
//   an alert older than two minutes is dropped (its moment has passed). Only the replay (what
//   arrives before the stream's first heartbeat) is judged, and on CTD's clock (the Date its
//   answers carry), so a server whose clock is off never makes live chat look old.
//
// A relay: where a direct connection (Twitch, step 17) also sets viewers.twitch, the direct one
// is shown (bus/index.js).
import { readSse } from '../sse-client.js';
import { VERSION } from '../../version.js';
import { APP_ID, appIdFor, createHub } from './ctd-multistream-hub.js';

const PLATFORMS = ['twitch', 'youtube', 'kick', 'facebook', 'x', 'instagram', 'tiktok', 'custom'];
const ROLES = new Set(['broadcaster', 'moderator', 'vip', 'subscriber', 'member', 'verified', 'founder', 'artist', 'bot']);
const FRAGMENTS = new Set(['text', 'emote', 'mention', 'link', 'cheermote']);
const UNITS = new Set(['months', 'count', 'bits', 'kicks', 'viewers', 'currency']);
const TIERS = { 1000: '1', 2000: '2', 3000: '3', Prime: 'prime', prime: 'prime' };
const TEXT_CHARS = 1000; // 02 §2.9
const QUIET_TICKS = 3; // ticks of 15 s with nothing arriving (it sends a heartbeat every 15 s)
const OLD_CHAT_MS = 60 * 1000;
const OLD_ALERT_MS = 2 * 60 * 1000;
const HOLD_MS = 300; // how long an event line waits for its alert (sent right after it)
const NOTICE_MS = 10 * 60 * 1000;
const CLOCK_SAMPLES = 6; // answers per sync, a second apart (its §4: 4–8); more when more profiles
const CLOCK_GAP_MS = 1000;
const CLOCK_RESYNC_MS = 5 * 60 * 1000;
const CLOCK_RETRY_MS = 30 * 1000; // a sync that failed (unreachable a moment) tries again this soon
const CLOCK_SETTLE_MS = 300; // a session change waits this long for the rest of its events
const CLOCK_OLD = 'This CTD Relay is older than v1.3: overlays get no stream clock (run time, timecode). Update CTD Relay to use them.';
const SCOPES = ['status:read', 'chat:read', 'apps:read', 'apps:write']; // what pairing asks for
const TOKEN = /^ctd_pat_[A-Za-z0-9_-]{16,200}$/;
const EVERY = '*'; // the Profile setting's "Every profile" (empty means it too)
const NOT_CONNECTED = 'Not connected yet: press Connect, then approve the code in CTD Relay → Settings → API (or paste a token into this connection\'s settings).';
const REAUTH = 'CTD Relay refused the token: it was revoked or is wrong. Press Connect again and approve the code in CTD Relay → Settings → API (or paste a new token into this connection\'s settings).';

const platformOf = (p) => (PLATFORMS.includes(p) ? p : 'custom');
const userIdOf = (id) => (PLATFORMS.includes(id.split(':')[0]) ? id : `custom:${id}`);
const str = (v) => typeof v === 'string' && v.length > 0;
const https = (v) => str(v) && /^https:\/\/\S+$/.test(v) && v.length <= 2048;
const COLOR = /^#[0-9A-Fa-f]{6}$/;
const minutes = (ms) => (ms >= 90000 ? `${Math.ceil(ms / 60000)} min` : `${Math.max(1, Math.ceil(ms / 1000))} s`);

// Requests to the API at the configured address (LAN egress, the certificate pinned when set),
// with the token when there is one.
function apiOf({ config, token, http }) {
  const base = String(config.baseUrl).replace(/\/+$/, '');
  const tls = config.tlsFingerprint256 ? { fingerprint256: config.tlsFingerprint256 } : undefined;
  return (path, { headers, ...rest } = {}) => http.request(`${base}${path}`, { egress: 'lan', ...(tls ? { tls } : {}), ...rest, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(headers || {}) } });
}

// A profile as the connection shows it (its info, the Live page): nothing it doesn't need.
function profileView(p) {
  return {
    id: p.id,
    name: str(p.name) ? p.name.slice(0, 80) : p.id,
    ...(str(p.slug) ? { slug: p.slug.slice(0, 64) } : {}),
    ...(str(p.color) && COLOR.test(p.color) ? { color: p.color } : {}),
    status: ['offline', 'starting', 'live', 'stopping'].includes(p.status) ? p.status : 'offline',
    ...(str(p.startedAt) && Number.isFinite(Date.parse(p.startedAt)) ? { startedAt: new Date(Date.parse(p.startedAt)).toISOString() } : {}),
    ...(p.testMode === true ? { testMode: true } : {}),
    ...(Number.isInteger(p.live) ? { live: p.live } : {}),
    ...(Number.isInteger(p.down) ? { down: p.down } : {}),
  };
}

export const ctdMultistream = {
  id: 'ctd-multistream',
  name: 'CTD Relay',
  platform: 'custom',
  platforms: PLATFORMS,
  relay: true,
  capabilities: ['chat.read', 'alerts', 'viewers', 'stream.status'],
  auth: 'pairing',
  sharesOverlays: true,
  fields: {
    type: 'object',
    required: ['baseUrl'],
    properties: {
      baseUrl: { type: 'string', title: 'API address', maxLength: 300, examples: ['http://192.168.1.50:30080/api/v1'], description: 'The LAN URL from CTD Relay → Settings → API, ending in /api/v1.', 'x-skp-egress': 'lan' },
      token: { type: 'string', title: 'API token', writeOnly: true, pattern: '^ctd_pat_[A-Za-z0-9_-]{16,200}$', description: 'Only to paste a token instead of Connect: ctd_pat_… from CTD Relay → Settings → API, with chat:read and status:read (and apps:read, apps:write to share overlays with the OBS plugin).' },
      tlsFingerprint256: { type: 'string', title: 'Certificate fingerprint (SHA-256)', pattern: '^([0-9A-Fa-f]{2}:?){31}[0-9A-Fa-f]{2}$', description: 'Only for an https:// address with a self-signed certificate: the fingerprint shown in Settings → API.' },
      profile: { type: 'string', title: 'Profile', maxLength: 100, pattern: '^[^\\s/?#]+$', 'x-skp-choices': true, description: 'Only for a token that reads every profile: "Every profile" (the default; each profile is its own stream here, new ones too), or the one profile this connection follows.' },
      chat: { type: 'boolean', title: 'Chat', default: true, description: 'Chat from every platform it streams to, merged.' },
      alerts: { type: 'boolean', title: 'Alerts', default: true, description: 'Subscriptions, gifts, cheers, raids, memberships and Super Chats.' },
      hideAlertChatLines: { type: 'boolean', title: 'Hide an alert\'s chat line', default: true, description: 'While alerts are on, a sub or a raid shows as the alert, not also as a line of chat.' },
      showJoins: { type: 'boolean', title: 'Show who joined', default: false, description: 'Instagram and TikTok mix "dj_fan joined" lines into their comments, many of them on a busy live. Off: chat shows comments only. On: they reach overlays marked as joins (a template may show them lighter).' },
      allowAppOverlays: { type: 'boolean', title: 'Let other apps create overlays', default: true, description: 'The CTD OBS plugin can ask for a new overlay (a TAKEOVER for this profile, say): it is made from an installed template and fed by this connection only.' },
    },
  },
  guide: {
    before: 'CTD Relay streams to every platform at once and merges their chat. This connection follows its profiles (every one, or one): each profile\'s merged chat, alerts, viewer counts and live status, over your local network, each profile a stream of its own here. It also shares the overlays it feeds with the CTD OBS plugin through CTD Relay.',
    steps: [
      'In CTD Relay, open Settings → API and copy the LAN URL (it ends in /api/v1, like http://192.168.1.50:30080/api/v1) into "API address".',
      'Press Connect: a code appears here.',
      'In CTD Relay → Settings → API, a banner says CTD Overlay wants to connect: check the code is the same, pick the profile (every profile, or one), and approve.',
      'It connects by itself within seconds. Following every profile, each one shows up here on its own (new ones too): pick which profile feeds each overlay in its "Fed by".',
    ],
    warnings: [
      { text: 'Chat from Instagram, TikTok, X and Facebook profiles is read from their live pages: it has no moderation events, so a message deleted there stays on screen.' },
    ],
  },

  validate(config) {
    let u;
    try { u = new URL(config.baseUrl); } catch { return 'The API address isn\'t a URL: copy the LAN URL from CTD Relay → Settings → API.'; }
    if (!/\/api\/v1\/?$/.test(u.pathname)) return 'The API address ends in /api/v1: copy the LAN URL from CTD Relay → Settings → API.';
    if (config.tlsFingerprint256 && u.protocol !== 'https:') return 'A certificate fingerprint is only for an https:// address.';
    return undefined;
  },

  // Pairing (its §9.3): the code to show, then polls until the token is handed over. The poll
  // secret stays in `state`, which only the platform keeps.
  pairing: {
    secret: 'token',
    async start({ config, http }) {
      const api = apiOf({ config, http });
      let r;
      try {
        r = await api('/pairing', { method: 'POST', json: { appName: 'CTD Overlay', kind: 'ctd-overlay', scopes: SCOPES, profileId: null }, retries: 0 });
      } catch (err) {
        if (err.status === 429) throw Object.assign(new Error(`It has too many connection requests waiting. Approve or deny them in its Settings → API, or press Connect again in ${minutes(err.retryAfterMs || 60000)}.`), { status: 429, retryAfterMs: err.retryAfterMs });
        if (err.status === 404) throw new Error('This CTD Relay can\'t pair (it is older than v1.2): paste a token from its Settings → API into this connection\'s settings instead, or update it.');
        throw new Error(`It couldn't be asked to connect: ${err.message}`);
      }
      const d = r.data && typeof r.data === 'object' ? r.data : {};
      if (!str(d.pairingId) || !str(d.pollSecret) || !str(d.code)) throw new Error('It answered the connection request with something this version doesn\'t understand.');
      return { code: d.code, approveUrl: d.approveUrl, expiresInS: d.expiresIn, intervalS: d.interval, state: { id: d.pairingId, secret: d.pollSecret } };
    },
    async poll({ config, http }, state) {
      const api = apiOf({ config, http });
      let r;
      try {
        r = await api(`/pairing/${encodeURIComponent(state.id)}/token`, { method: 'POST', json: { pollSecret: state.secret }, retries: 0, timeoutMs: 8000 });
      } catch (err) {
        if (err.status === 403) throw Object.assign(new Error('The connection was denied in CTD Relay. Press Connect again if that was a mistake.'), { code: 'denied' });
        if (err.status === 410) throw Object.assign(new Error('The code expired before it was approved (or CTD Relay restarted). Press Connect again for a new one.'), { code: 'expired' });
        if (err.status === 429) return { pending: true, waitMs: err.retryAfterMs };
        if (err.status >= 400 && err.status < 500) throw new Error(`CTD Relay refused the connection request: ${err.message}`);
        return { pending: true }; // unreachable for a moment, or a 5xx: it keeps trying until the code expires
      }
      const d = r.data && typeof r.data === 'object' ? r.data : {};
      if (r.status === 202 || d.status === 'pending') return { pending: true };
      if (d.status === 'approved' && TOKEN.test(d.token || '')) {
        return { secrets: { token: d.token }, audit: { profile: str(d.profileId) ? d.profileId : 'every profile', scopes: (Array.isArray(d.scopes) ? d.scopes.filter(str) : []).join(' ').slice(0, 200) } };
      }
      throw new Error('CTD Relay approved the connection but sent no token this version can use. Press Connect again.');
    },
  },

  // Deleted or turned off: the app it registered in the hub goes (best effort; revoking the token
  // in CTD Relay removes it too).
  async retire({ config, secrets, memory, http }) {
    if (!TOKEN.test(secrets.token || '') || !APP_ID.test(memory?.hubApp || '')) return;
    try {
      await apiOf({ config, token: secrets.token, http })(`/apps/${memory.hubApp}`, { method: 'DELETE', expect: 'none', retries: 0, timeoutMs: 4000 });
    } catch (err) {
      if (err.status !== 404 && err.status !== 401) throw err;
    }
  },

  create(ctx) {
    const cfg = ctx.connection.config;
    const token = ctx.connection.secrets.token;
    const get = apiOf({ config: cfg, token, http: ctx.http });

    let scopes = [];
    let v12 = false; // the server has profiles (its GET / names the token's profile)
    let limitedTo = null; // the profile the token is limited to
    let every = false; // it follows every profile, each a feed of its own (src.profile)
    let profile = null; // following one: that profile's view (profileView)
    let hub = null;
    const fatal = (message) => Object.assign(new Error(message), { fatal: true });

    // What it follows, each with its own destinations and status: one feed ('') following one
    // profile (or a server without profiles), or one per profile following every profile, whose
    // values and events carry the profile (src.profile: overlays are bound to "<connection>/<id>").
    const feeds = new Map();
    // clock: its last /clock answer ({ startedAt on CTD's clock, or null; fps }); clockKey: the
    // session (status and start) that answer was for.
    const newFeed = (id, scope) => ({ id, scope, view: undefined, dests: new Map(), startedAt: new Map(), session: null, shown: new Set(), clock: null, clockKey: undefined });
    const one = () => feeds.get('');
    const feedName = (f) => f.view?.name || f.id || '';
    // ?profile= on /status and /chat: following every profile, the feed's; following one with a
    // token for every profile, that one (one connection, one profile).
    const pathFor = (path, feed) => {
      const id = every ? feed?.id : v12 && !limitedTo && profile ? profile.id : undefined;
      return id ? `${path}${path.includes('?') ? '&' : '?'}profile=${encodeURIComponent(id)}` : path;
    };
    const as = (feed) => (feed?.scope ? { profile: feed.scope } : {});

    let skew = 0; // CTD's clock minus this machine's, from the Date its answers carry
    let caughtUp = false; // a heartbeat came after the replay: everything since is live
    let held = null; // { env, frameId, feed, cancel }: an event line waiting to see whether its alert follows
    let notices = []; // [{ text, cancel }]
    let open = false;
    let active = false;
    let quiet = 0;
    let stopping = false;
    let rereading = null; // a profiles re-read asked for (a profile it hadn't heard of)
    const streamStop = new AbortController();
    // The stream clock: the best sample of the last sync ({ offset: CTD's clock minus this
    // server's, delay: its round trip, at: when it was taken }), whether CTD has no /clock (older
    // than v1.3), the next sync's timer, and a sync under way (and one more wanted after it: a
    // profile new here while the first one ran).
    let clock = null;
    let clockOld = false; // 'old' (no /clock: said in a warning) or 'denied' (403: quietly)
    let clockNext = null;
    let clockBusy = false;
    let clockAgain = false;

    // ---- state -----------------------------------------------------------------------------
    function applyStatus(feed, s) {
      if (!s || typeof s !== 'object') return;
      feed.session = s.session && typeof s.session === 'object' ? s.session : feed.session;
      feed.dests.clear();
      for (const d of Array.isArray(s.destinations) ? s.destinations : []) if (d && str(d.id)) feed.dests.set(d.id, d);
      feed.startedAt.clear();
      for (const p of Array.isArray(s.platforms) ? s.platforms : []) {
        if (p && Number.isFinite(p.startedAt)) feed.startedAt.set(platformOf(p.platform), p.startedAt);
      }
      publishState(feed);
    }

    function rollup(feed, platform) {
      const ds = [...feed.dests.values()].filter((d) => platformOf(d.platform) === platform);
      const live = ds.some((d) => d.live === true);
      const counts = ds.map((d) => d.viewers).filter((v) => Number.isInteger(v) && v >= 0);
      let since = feed.startedAt.get(platform);
      if (live && !Number.isFinite(since)) {
        const t = ds.filter((d) => d.live === true).map((d) => Date.parse(d.since)).filter(Number.isFinite);
        if (t.length) feed.startedAt.set(platform, (since = Math.min(...t)));
      }
      if (!live) feed.startedAt.delete(platform);
      return { live, viewers: counts.length ? counts.reduce((a, b) => a + b, 0) : undefined, title: str(feed.session?.title) ? feed.session.title : undefined, startedAt: live ? since : undefined };
    }

    const KEYS = (p) => [`viewers.${p}`, `stream.${p}.live`, `stream.${p}.title`, `stream.${p}.startedAt`];
    function publishState(feed) {
      const now = new Set([...feed.dests.values()].map((d) => platformOf(d.platform)));
      for (const p of now) {
        const r = rollup(feed, p);
        ctx.setState(`viewers.${p}`, r.viewers, as(feed));
        ctx.setState(`stream.${p}.live`, r.live, as(feed));
        ctx.setState(`stream.${p}.title`, r.title, as(feed));
        ctx.setState(`stream.${p}.startedAt`, Number.isFinite(r.startedAt) ? r.startedAt : undefined, as(feed));
      }
      for (const p of feed.shown) {
        if (now.has(p)) continue;
        for (const k of KEYS(p)) ctx.setState(k, undefined, as(feed));
      }
      feed.shown = now;
      health();
    }

    function health() {
      if (!open) return;
      const all = [...feeds.values()].flatMap((f) => [...f.dests.values()].map((d) => ({ d, f })));
      const down = all.filter((x) => x.d.down === true);
      const several = every && feeds.size > 1;
      const said = ({ d, f }) => {
        const msg = str(d.message) ? d.message : 'not reaching the platform';
        const name = str(d.name) ? d.name : platformOf(d.platform);
        return `${name}${several ? ` (${feedName(f)})` : ''}: ${msg.startsWith(`${name} `) ? msg.slice(name.length + 1) : msg}`;
      };
      const kinds = [cfg.chat && 'chat', cfg.alerts && 'alerts'].filter(Boolean);
      const of = every ? ` of ${feeds.size === 1 ? feedName([...feeds.values()][0]) : `${feeds.size} profiles (${[...feeds.values()].map(feedName).join(', ')})`}` : profile ? ` of ${profile.name}` : '';
      ctx.setHealth({
        status: down.length ? 'degraded' : 'connected',
        detail: down.length ? `${said(down[0])}${down.length > 1 ? ` (and ${down.length - 1} more down)` : ''}` : `Receiving ${[...kinds, 'live status'].join(', ')} from ${all.length} destination${all.length === 1 ? '' : 's'}${of}.`,
        warnings: [...(hub?.warning ? [hub.warning] : []), ...(clockOld === 'old' ? [CLOCK_OLD] : []), ...notices.map((n) => n.text)],
      });
    }

    // ---- profiles ----------------------------------------------------------------------------
    // The settings' Profile choice (x-skp-choices) for a token that reads every profile: every
    // profile (the default), or one of them.
    function offerProfiles(items) {
      ctx.setInfo('choices', { profile: [{ value: '*', label: 'Every profile' }, ...items.slice(0, 49).map((p) => ({ value: p.id.slice(0, 100), label: str(p.name) ? p.name.slice(0, 80) : p.id.slice(0, 80) }))] });
    }

    function setProfile(p) {
      profile = profileView(p);
      ctx.setInfo('profile', profile);
      ctx.suggestName(`Relay · ${profile.name}`);
    }

    // Following every profile: each one's status, on the connection (info.profiles).
    // A profile made or deleted: the hub gets the overlays again (each one per profile it feeds).
    let followed = '';
    function showProfiles() {
      ctx.setInfo('profiles', [...feeds.values()].map((f) => f.view || profileView({ id: f.id })));
      const ids = [...feeds.keys()].join('\n');
      if (ids !== followed) { followed = ids; hub?.soon(); }
    }

    // A profile that is gone: its values go, and what is bound to it alone gets nothing more.
    function dropFeed(feed) {
      for (const p of feed.shown) for (const k of KEYS(p)) ctx.setState(k, undefined, as(feed));
      if (feed.clock) ctx.setState('stream.clock', undefined, as(feed));
      feeds.delete(feed.id);
      if (held?.feed === feed) { held.cancel(); held = null; }
    }

    // A profile it hadn't heard of (made a moment ago): followed at once, read properly soon.
    function feedFor(id) {
      let f = feeds.get(id);
      if (f) return f;
      f = newFeed(id, id);
      f.view = profileView({ id });
      f.unread = true; // its status and recent chat are read with the profiles
      feeds.set(id, f);
      showProfiles();
      if (!rereading) rereading = ctx.schedule(500, () => { rereading = null; return profilesChanged(); });
      return f;
    }

    // The profiles a token for every profile reads (GET /profiles): every one is followed, those
    // gone are dropped. Returns the ones new since the last read.
    async function readProfiles() {
      const r = await get('/profiles');
      const items = (Array.isArray(r.data?.items) ? r.data.items : []).filter((p) => p && str(p.id) && /^[^\s/]{1,100}$/.test(p.id));
      offerProfiles(items);
      if (!every) return { items, added: [] };
      const added = [];
      for (const p of items) {
        let f = feeds.get(p.id);
        if (!f) { f = newFeed(p.id, p.id); feeds.set(p.id, f); added.push(f); }
        f.view = profileView(p);
      }
      for (const f of [...feeds.values()]) if (!items.some((p) => p.id === f.id)) dropFeed(f);
      if (!feeds.size) throw fatal('CTD Relay has no profile to follow.');
      showProfiles();
      return { items, added };
    }

    // Which profile: the token's; or, a token for every profile, every one (the default), or the
    // one picked in the settings. The list goes to the settings' Profile choice.
    async function readProfile() {
      if (!v12) { feeds.set('', newFeed(null)); return; }
      if (limitedTo) {
        let r;
        try { r = await get(`/profiles/${encodeURIComponent(limitedTo)}`); } catch (err) {
          if (err.status === 404) throw fatal('The CTD Relay profile this connection\'s token reads was deleted: press Connect again and pick another profile.');
          throw err;
        }
        if (!r.data || !str(r.data.id)) throw new Error('CTD Relay answered GET /profiles/<id> with something this version doesn\'t understand.');
        feeds.set('', newFeed(r.data.id));
        return setProfile(r.data);
      }
      const { items } = await readProfiles();
      if (every) {
        ctx.setInfo('everyProfile', true);
        ctx.suggestName('Relay');
        return undefined;
      }
      const p = items.find((x) => x.id === cfg.profile);
      if (!p) throw fatal('The profile picked in this connection\'s settings isn\'t in CTD Relay any more: pick another in its settings (or "Every profile").');
      feeds.set('', newFeed(p.id));
      return setProfile(p);
    }

    // profiles.changed: one was made, renamed or deleted. Following every profile: a new one is
    // followed (its status and chat read), a deleted one dropped. Following one that was deleted:
    // an error saying so.
    async function profilesChanged() {
      if (every) {
        const { added } = await readProfiles();
        for (const f of new Set([...added, ...[...feeds.values()].filter((x) => x.unread)])) {
          f.unread = false;
          if (feeds.get(f.id) === f) {
            await refreshFeed(f, true);
            readClockSoon(f);
          }
        }
        health();
        return;
      }
      if (!profile) return;
      let r;
      try { r = await get(`/profiles/${encodeURIComponent(profile.id)}`, { retries: 0 }); } catch (err) {
        if (err.status === 404) {
          ctx.fail(new Error(limitedTo
            ? `The profile "${profile.name}" was deleted in CTD Relay, and this connection's token reads only that profile: press Connect again and pick another.`
            : `The profile "${profile.name}" was deleted in CTD Relay: pick another in this connection's settings (or "Every profile").`), { retry: false });
          return;
        }
        throw err;
      }
      if (r.data && str(r.data.id)) setProfile(r.data);
      if (!limitedTo) {
        const list = await get('/profiles', { retries: 0 }).catch(() => undefined);
        const items = (Array.isArray(list?.data?.items) ? list.data.items : []).filter((p) => p && str(p.id));
        if (items.length) offerProfiles(items);
      }
      health();
    }

    function notice(d) {
      const text = str(d?.message) ? d.message.slice(0, 200) : undefined;
      if (!text) return;
      const n = { text };
      n.cancel = ctx.schedule(NOTICE_MS, () => { notices = notices.filter((x) => x !== n); health(); });
      notices = [...notices.slice(-2), n];
      health();
    }

    // ---- the stream clock (its §4, v1.3) -------------------------------------------------------
    // GET /clock?t0=<this server's time> answers when CTD received and sent it (its clock), each
    // profile's session start (its clock) and the feed's frame rate. Times are ctx.now() (the
    // platform's clock, a test's in tests) and waits ctx.schedule, so tests run it on a fake clock.
    const alive = (feed) => [...feeds.values()].includes(feed);
    const pause = (ms) => new Promise((resolve) => { ctx.schedule(ms, resolve); });
    const clockAllowed = () => !clockOld && !stopping && scopes.includes('status:read');
    // A session as a key (running or not, and since which second), whatever told it: /clock
    // (epoch ms), stream.status or profile.status (ISO); a change between syncs is read again.
    function sessionKey(status, startedAt) {
      const t = typeof startedAt === 'number' ? startedAt : Date.parse(typeof startedAt === 'string' ? startedAt : '');
      const running = ['live', 'starting', 'stopping'].includes(status) || Number.isFinite(t);
      return running ? `on:${Number.isFinite(t) ? Math.floor(t / 1000) : ''}` : 'off';
    }

    // One answer for a feed: { offset, delay, at, data }, offset = CTD's clock minus this server's
    // and delay = the round trip without CTD's own time (its §4); undefined when there is nothing
    // to read: no /clock (older than v1.3, said once) or a profile deleted meanwhile.
    async function clockSample(feed) {
      const t0 = ctx.now();
      const r = await get(pathFor(`/clock?t0=${t0}`, feed), { retries: 0, timeoutMs: 5000, acceptStatus: (s) => s === 404 || s === 403 });
      const t3 = ctx.now();
      if (r.status === 404 && r.data?.code === 'unknown_profile') return undefined;
      if (r.status === 404 || r.status === 403) {
        // 403: the token can't read it after all; nothing to say about the server.
        clockOld = r.status === 404 ? 'old' : 'denied';
        if (r.status === 404) {
          ctx.log.info('CTD Relay has no stream clock (older than v1.3)');
          health();
        }
        return undefined;
      }
      const d = r.data && typeof r.data === 'object' ? r.data : {};
      if (!Number.isFinite(d.receivedAt) || !Number.isFinite(d.sentAt)) throw new Error('CTD Relay answered GET /clock with something this version doesn\'t understand.');
      return { offset: ((d.receivedAt - t0) + (d.sentAt - t3)) / 2, delay: (t3 - t0) - (d.sentAt - d.receivedAt), at: t3, data: d };
    }

    function takeAnswer(feed, d) {
      const s = d.session && typeof d.session === 'object' ? d.session : {};
      const startedAt = Number.isFinite(s.startedAt) && s.startedAt > 0 ? s.startedAt : null;
      feed.clock = { startedAt, fps: Number.isFinite(d.fps) && d.fps >= 1 && d.fps <= 240 ? Math.round(d.fps) : 30 };
      feed.clockKey = sessionKey(s.status, startedAt);
    }

    // stream.clock (02 §2.5.2): the session's start on this server's clock (absent while it isn't
    // running), the frame rate, the offset to CTD's clock, and when that was measured.
    function publishClock(feed) {
      if (!clock || !feed.clock || !alive(feed)) return;
      const start = feed.clock.startedAt;
      ctx.setState('stream.clock', {
        ...(Number.isFinite(start) ? { startedAt: Math.round(start - clock.offset) } : {}),
        fps: feed.clock.fps,
        offsetMs: Math.round(clock.offset),
        at: Math.round(clock.at),
      }, as(feed));
    }

    // A sync: CLOCK_SAMPLES answers a second apart (at least one per profile, in turn), the lowest
    // round trip's offset kept; each profile's session from its last answer. Then again in 5 min.
    // A sync already under way is fresh enough (system.reset right after a start).
    async function syncClock() {
      if (!clockAllowed() || clockBusy) return;
      clockBusy = true;
      clockNext?.();
      clockNext = null;
      let wait = CLOCK_RESYNC_MS;
      try {
        const list = [...feeds.values()];
        let best = null;
        const answers = new Map();
        for (let i = 0; list.length && i < Math.max(CLOCK_SAMPLES, list.length) && !clockOld; i++) {
          if (i) await pause(CLOCK_GAP_MS);
          if (stopping) return;
          const feed = list[i % list.length];
          if (!alive(feed)) continue;
          const s = await clockSample(feed);
          if (!s) continue;
          if (!best || s.delay < best.delay) best = s;
          answers.set(feed, s.data);
        }
        if (!best) return;
        clock = { offset: best.offset, delay: best.delay, at: best.at };
        for (const [feed, d] of answers) {
          takeAnswer(feed, d);
          publishClock(feed);
        }
      } catch (err) {
        wait = CLOCK_RETRY_MS;
        ctx.log.debug('the stream clock could not be read; trying again soon', { err: err.message });
      } finally {
        clockBusy = false;
        if (clockAllowed()) {
          clockNext = ctx.schedule(clockAgain ? 0 : wait, syncClock);
          clockAgain = false;
        }
      }
    }

    // A sync now (a start, system.reset): never a failure of the connection.
    function startClock() {
      syncClock().catch((err) => ctx.log.debug('the stream clock sync stopped', { err: err.message }));
    }

    // One feed read again (a session started or stopped, a profile new here), with the offset of
    // the last sync.
    function readClockSoon(feed) {
      if (!feed || !clockAllowed()) return;
      if (!clock) { // the first sync is still under way: one more after it, with this feed in it
        if (clockBusy) clockAgain = true;
        return;
      }
      feed.clockSoon?.();
      feed.clockSoon = ctx.schedule(CLOCK_SETTLE_MS, async () => {
        feed.clockSoon = null;
        try {
          const s = await clockSample(feed);
          if (!s || !alive(feed)) return;
          takeAnswer(feed, s.data);
          publishClock(feed);
        } catch (err) {
          ctx.log.debug('the stream clock could not be read for a session change', { err: err.message });
        }
      });
    }
    function sessionSeen(feed, status, startedAt) {
      if (feed && feed.clockKey !== undefined && sessionKey(status, startedAt) !== feed.clockKey) readClockSoon(feed);
    }

    // ---- chat and alerts -------------------------------------------------------------------
    // Only the replay after connecting can be old: CTD writes it before its first heartbeat, so
    // what follows a heartbeat is live, whatever its ts says (a clock set back mid-show). Ages are
    // measured on CTD's clock: its envelopes' ts against its Date, never this machine's.
    const old = (env, ms) => !caughtUp && typeof env.ts === 'number' && ctx.now() + skew - env.ts > ms;
    function clockFrom(res) {
      const t = Date.parse(res?.headers?.get?.('date') ?? '');
      if (Number.isFinite(t)) skew = t - ctx.now();
    }
    // A line's dedupe key: its id (and its profile, following every profile: two profiles never
    // hide each other's lines).
    const lineKey = (feed, id) => (feed?.scope ? `chat:${feed.scope}:${id}` : `chat:${id}`);

    function chat(env, { backfill = false, frameId, feed } = {}) {
      const d = env.data;
      if (!cfg.chat || !d || typeof d !== 'object' || !str(d.id)) return;
      // A "<name> joined" presence line (Instagram, TikTok, v1.3): not a comment.
      if (d.join === true && !cfg.showJoins) return;
      // From the stream (not /chat, which has no alerts), an event line waits for its alert.
      if (d.kind === 'event' && d.join !== true && cfg.alerts && cfg.hideAlertChatLines && !backfill) {
        held = { env, frameId, feed, cancel: ctx.schedule(HOLD_MS, () => release(true)) };
        return;
      }
      const platform = platformOf(env.src?.platform ?? d.platform);
      ctx.publish('chat.message', chatMessage(d, platform), { platform, dedupeKey: lineKey(feed, d.id), backfill: backfill || old(env, OLD_CHAT_MS), ...as(feed) });
    }

    // The held line had no alert after it: it is shown after all (and the cursor may pass it).
    function release(saveCursor = false) {
      const h = held;
      if (!h) return;
      held = null;
      h.cancel();
      const d = h.env.data;
      const platform = platformOf(h.env.src?.platform ?? d.platform);
      ctx.publish('chat.message', chatMessage(d, platform), { platform, dedupeKey: lineKey(h.feed, d.id), backfill: old(h.env, OLD_CHAT_MS), ...as(h.feed) });
      if (saveCursor) cursor(h.frameId);
    }

    // Lines from one destination (or platform) of a feed still in the chat buffer, newest first.
    function linesOf(feed, platform, destinationId) {
      return ctx.recentChat({ profile: feed?.scope }).filter((m) => m.platform === platform && (!str(destinationId) || m.destinationId === destinationId)).reverse();
    }

    // The feed an envelope belongs to: the one followed, or (every profile) its src.profile's.
    function feedOfEnv(env) {
      if (!every) return one();
      const p = env.src?.profile;
      return str(p) && /^[^\s/]{1,100}$/.test(p) ? feedFor(p) : undefined;
    }

    // Returns true when an alert was shown (now or before), so its chat line can stay hidden.
    function handle(env, frameId) {
      const { type } = env;
      const d = env.data && typeof env.data === 'object' ? env.data : {};
      // About no single profile, or about the connection: handled for all of it.
      if (type === 'system.notice') return notice(d);
      if (type === 'app.message') {
        hub?.message(d, env);
        return undefined;
      }
      if (type === 'profile.status') {
        if (every && str(d.id) && /^[^\s/]{1,100}$/.test(d.id)) {
          const f = feedFor(d.id);
          f.view = profileView(d);
          sessionSeen(f, d.status, d.startedAt);
          showProfiles();
          health();
        } else if (profile && d.id === profile.id) {
          setProfile(d);
          sessionSeen(one(), d.status, d.startedAt);
          health();
        }
        return undefined;
      }
      const feed = feedOfEnv(env);
      if (!feed) return undefined; // a profile's event without its profile: nothing to put it in
      const platform = platformOf(env.src?.platform ?? d.platform);
      const opts = (extra) => ({ platform, ...as(feed), ...extra });
      const key = `env:${env.id}`;
      if (type === 'chat.message') return chat(env, { frameId, feed });
      if (type === 'chat.message.deleted') {
        if (cfg.chat && str(d.messageId)) ctx.publish('chat.message.deleted', { messageId: d.messageId }, opts({ dedupeKey: key }));
        return undefined;
      }
      if (type === 'chat.user.cleared') {
        if (!cfg.chat || !str(d.userId)) return undefined;
        const userId = userIdOf(d.userId);
        ctx.publish('chat.user.cleared', { userId }, opts({ dedupeKey: key }));
        // Named only ("<platform>:name:<name>"), or their lines are: those lines carry another id,
        // so they're taken off one by one, matched by name or login as CTD's own buffer does.
        const nameOnly = (id) => typeof id === 'string' && id.startsWith(`${platform}:name:`);
        const name = (str(d.userName) ? d.userName : nameOnly(userId) ? userId.slice(platform.length + 6) : '').toLowerCase();
        if (!name) return undefined;
        for (const m of linesOf(feed, platform, d.destinationId)) {
          if (m.user?.id === userId || (!nameOnly(userId) && !nameOnly(m.user?.id))) continue;
          if (m.user?.name?.toLowerCase() === name || m.user?.login?.toLowerCase() === name) ctx.publish('chat.message.deleted', { messageId: m.id }, opts());
        }
        return undefined;
      }
      if (type === 'chat.cleared') {
        // One destination's chat was cleared: its lines go, the others' stay (a chat.cleared here
        // would clear every platform's on every overlay). Worked out from the chat buffer, so the
        // lines from before a reconnect go too, and a clear seen twice removes nothing more.
        if (!cfg.chat) return undefined;
        for (const m of linesOf(feed, platform, d.destinationId)) ctx.publish('chat.message.deleted', { messageId: m.id }, opts());
        return undefined;
      }
      if (/^alert\.[a-z]+$/.test(type)) {
        if (!cfg.alerts || old(env, OLD_ALERT_MS)) return false;
        const a = alertOf(d, type.slice(6), platform);
        if (!a) return false;
        return ctx.publish(type, a, opts({ dedupeKey: key })) !== undefined || ctx.seen(key);
      }
      if (type === 'stream.status') {
        feed.session = d;
        sessionSeen(feed, d.status, d.startedAt);
        return publishState(feed);
      }
      if (type === 'destination.status') {
        if (str(d.id)) feed.dests.set(d.id, d);
        return publishState(feed);
      }
      if (type === 'destination.down' || type === 'destination.up') {
        const x = feed.dests.get(d.destinationId);
        if (x) {
          x.down = type === 'destination.down';
          if (x.down && str(d.reason)) x.message = d.reason;
          if (!x.down) x.message = null;
          publishState(feed);
        }
        return undefined;
      }
      return undefined; // feed.status and anything newer: not used here
    }

    // ---- the stream --------------------------------------------------------------------------
    // A feed's status, and (withChat) its recent chat into the buffer, quietly. Following every
    // profile, one deleted meanwhile is dropped.
    async function refreshFeed(feed, withChat) {
      try {
        const status = await get(pathFor('/status', feed));
        clockFrom(status);
        applyStatus(feed, status.data);
        if (withChat && cfg.chat) {
          const r = await get(pathFor('/chat?limit=200', feed));
          for (const env of Array.isArray(r.data?.items) ? r.data.items : []) if (env && env.type === 'chat.message') chat(env, { backfill: true, feed });
        }
      } catch (err) {
        if (every && err.status === 404 && feeds.get(feed.id) === feed) { dropFeed(feed); showProfiles(); return; }
        throw err;
      }
    }
    async function refresh(withChat) {
      for (const feed of [...feeds.values()]) await refreshFeed(feed, withChat);
    }

    // The cursor is a frame's id (what Last-Event-ID resumes from); a frame without one (the
    // current state sent on connecting) leaves it where it was.
    function cursor(id) {
      if (str(id) && id.length <= 64) ctx.memory.set('cursor', id);
    }

    async function onFrame(frame) {
      ctx.event();
      // Room for this frame's event and a held line it lets go: a burst (the replay after a
      // reconnect) waits for it rather than being lost. Reading waits meanwhile.
      await ctx.room(2);
      if (frame.event === 'system.reset') {
        // Everything again: which profiles there are, then each one's status and chat.
        release(true);
        if (every) await readProfiles();
        await refresh(true);
        cursor(frame.id);
        startClock();
        return;
      }
      let env;
      try { env = JSON.parse(frame.data); } catch { return; }
      if (!env || typeof env !== 'object' || typeof env.type !== 'string') return;
      if (env.type === 'profiles.changed') {
        release(true);
        await profilesChanged();
        cursor(frame.id);
        return;
      }
      if (held && /^alert\.[a-z]+$/.test(env.type) && env.data?.messageId === held.env.data.id && (env.src?.profile ?? null) === (held.env.src?.profile ?? null)) {
        // The held line's alert: shown, it stays hidden; refused (alerts off, too old), it shows.
        const h = held;
        if (handle(env, frame.id)) {
          held = null;
          h.cancel();
        } else release();
      } else {
        release(true);
        handle(env, frame.id);
      }
      // A line still held keeps the cursor before it: a stop now replays it rather than lose it.
      if (!held) cursor(frame.id);
    }

    async function follow() {
      const types = [
        ...(cfg.chat ? ['chat.*'] : []), ...(cfg.alerts ? ['alert.*'] : []), 'stream.status', 'destination.status', 'destination.down', 'destination.up', 'system.notice',
        ...(v12 ? ['profile.status', 'profiles.changed'] : []), ...(hub && scopes.includes('apps:read') ? ['app.message'] : []),
      ];
      const from = ctx.memory.get('cursor');
      // Every profile in one stream (?profile=*, its §4): each envelope says whose (src.profile).
      const path = `/events?types=${encodeURIComponent(types.join(','))}`;
      const res = await get(every ? `${path}&profile=*` : pathFor(path), { expect: 'stream', retries: 0, signal: streamStop.signal, headers: { accept: 'text/event-stream', ...(str(from) ? { 'last-event-id': from } : {}) } });
      clockFrom(res);
      open = true;
      active = true;
      health();
      readSse(res.body, onFrame, { onActivity: () => { active = true; }, onComment: () => { caughtUp = true; } }).then(
        () => { if (!stopping) ctx.fail(new Error('CTD Relay closed the event stream; reconnecting.')); },
        (err) => { if (!stopping) ctx.fail(err); },
      );
    }

    // Who the token is: its scopes, and the profile it is limited to (v1.2; none: every profile).
    // A token for every profile follows every one unless one is picked in the settings.
    async function whoAmI() {
      const r = await get('/');
      clockFrom(r);
      const t = r.data?.token && typeof r.data.token === 'object' ? r.data.token : {};
      scopes = Array.isArray(t.scopes) ? t.scopes.filter(str) : [];
      v12 = Object.hasOwn(t, 'profileId');
      limitedTo = str(t.profileId) ? t.profileId : null;
      every = v12 && !limitedTo && (!str(cfg.profile) || cfg.profile === EVERY);
    }

    // The cursor belongs to the stream it was read from (every profile, or one): another one's
    // is no place to resume, so it starts afresh (the recent chat read again, quietly).
    function cursorFits() {
      const scope = every ? EVERY : 'one';
      if ((ctx.memory.get('cursorScope') ?? 'one') === scope) return;
      ctx.memory.set('cursor', undefined);
      ctx.memory.set('cursorScope', scope === 'one' ? undefined : scope);
    }

    // The hub: with apps:write the overlays it feeds are shared with the OBS plugin.
    function hubFor() {
      if (!v12 || (!profile && !every)) {
        ctx.setInfo('hub', { status: 'off', detail: 'This CTD Relay is older than v1.2: it has no hub to share overlays through.' });
        return null;
      }
      if (!scopes.includes('apps:write')) {
        ctx.setInfo('hub', { status: 'off', detail: 'The token can\'t share overlays with the OBS plugin (it lacks apps:write): press Connect again to get one that can.' });
        return null;
      }
      return createHub(ctx, {
        request: get,
        appId: appIdFor({ limited: Boolean(limitedTo), slug: profile?.slug, id: profile?.id }),
        profileId: every ? null : profile.id,
        profileSlug: every ? undefined : profile.slug || profile.id,
        every,
        profileOf: (id) => { const f = feeds.get(id); return f && f.scope ? { id: f.id, slug: f.view?.slug } : undefined; },
        profiles: () => (every ? [...feeds.values()].filter((f) => f.scope).map((f) => f.id) : []),
        version: VERSION,
        allowMaking: () => cfg.allowAppOverlays !== false,
        isOld: (env) => old(env, OLD_ALERT_MS),
        onChange: health,
        reauth: () => ctx.reauth(REAUTH),
      });
    }

    return {
      async start() {
        if (!str(token)) return ctx.reauth(NOT_CONNECTED);
        try {
          await whoAmI();
          await readProfile();
          cursorFits();
          hub = hubFor();
          await refresh(!str(ctx.memory.get('cursor')));
          await follow();
        } catch (err) {
          if (err.status === 401) return ctx.reauth(REAUTH);
          if (err.status === 403) return ctx.fail(new Error('The token can\'t read everything this needs: press Connect again, or give it chat:read and status:read in CTD Relay → Settings → API.'), { retry: false });
          if (err.fatal) return ctx.fail(err, { retry: false });
          throw err;
        }
        hub?.start();
        startClock();
        // Nothing for 45 s (it sends a heartbeat every 15): the stream is dead without saying so.
        ctx.every(15000, () => {
          if (active) { active = false; quiet = 0; return; }
          if (++quiet >= QUIET_TICKS) ctx.fail(new Error('CTD Relay went quiet for 45 s; reconnecting.'));
        });
        return undefined;
      },
      stop() {
        stopping = true;
        streamStop.abort();
        hub?.stop();
      },
      async test() {
        if (!str(token)) return [{ name: 'Connected to CTD Relay', ok: false, detail: NOT_CONNECTED }];
        let r;
        try {
          r = await get('/', { retries: 0 });
        } catch (err) {
          if (err.status === 401) return [{ name: 'Token', ok: false, detail: REAUTH }];
          return [{ name: 'Reaching CTD Relay', ok: false, detail: err.message }];
        }
        const has = Array.isArray(r.data?.token?.scopes) ? r.data.token.scopes : [];
        const missing = ['chat:read', 'status:read'].filter((s) => !has.includes(s));
        const t = r.data?.token || {};
        const following = every ? `every profile: ${[...feeds.values()].map(feedName).join(', ') || 'not read yet'}` : profile ? profile.name : 'not read yet';
        return [
          { name: 'Reaching CTD Relay', ok: true, detail: `${str(r.data?.name) ? r.data.name : 'ctd-multi-stream'}${str(r.data?.version) ? ` ${r.data.version}` : ''}` },
          ...(Object.hasOwn(t, 'profileId') ? [{ name: 'Profile', ok: true, detail: `${following}${str(t.profileId) ? ' (the token reads only this profile)' : every ? ' (the token reads every profile: pick one in the settings to follow only that)' : ' (the token reads every profile: "Every profile" in the settings follows them all)'}` }] : []),
          { name: 'Token permissions', ok: !missing.length, detail: missing.length ? `The token lacks ${missing.join(' and ')}: press Connect again, or add ${missing.length > 1 ? 'them' : 'it'} in CTD Relay → Settings → API.` : 'chat:read and status:read' },
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
  const uid = userIdOf(str(u.id) ? u.id : `${platform}:name:${str(u.name) ? u.name : 'unknown'}`);
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
    ...(d.join === true ? { join: true } : {}),
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
