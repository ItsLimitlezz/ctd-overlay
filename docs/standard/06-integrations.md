# 06 · Integrations

The platform does all connecting. This document defines the contract every connector meets,
then the specifics for each service in v1, then how other apps plug in.

> **Verified 2026-10-09.** Platform APIs change. Each service section lists what was confirmed
> against official documentation or developer announcements on that date. Implementers
> **MUST** re-check scopes, endpoints and limits against the linked sources before release and
> update this file.

## 6.1 Connector contract

```ts
interface Connector {
  id: string                         // "twitch"
  name: string                       // "Twitch"
  platform?: Platform                // its platform; platforms?: every one a relay speaks for
  relay?: boolean                    // relays other platforms (a direct connection wins ties)
  capabilities: Capability[]         // see 6.2
  fields: JSONSchema                 // what the user supplies; writeOnly = a secret (client
                                     // secret, password, token), x-skp-egress: 'lan' = an address
                                     // they type, x-skp-reauth = changing it signs the account out
  auth: 'oauth-pkce' | 'oauth-code' | 'device-code' | 'client-credentials'
      | 'password' | 'pairing' | 'none'
  oauth?: { authorizeUrl?, tokenUrl, deviceUrl?, revokeUrl?, scopes: { scope, why }[], pkce? }
  pairing?: { secret, start(), poll() }  // the service's own code-to-approve flow (6.4)
  sharesOverlays?: boolean           // gets ctx.overlays: the overlays bound to it, keyed URLs
  retire?(…): Promise<void>          // deleted or turned off: undo what it registered there
  requiresPublicUrl?: boolean        // true if the service pushes to us (webhooks)
  guide: SetupGuide                  // 6.4, 08 §8.7
  actions?: Record<string, ActionSpec>

  create(ctx: ConnectorContext): {   // one instance per start of a connection
    start(): Promise<void>           // resolves once connected; its failure is caught (H11)
    stop(): Promise<void>
    test?(): Check | Check[]         // POST /connections/{id}/test
    actions?: Record<string, (args) => Promise<unknown>>
  }
}

interface ConnectorContext {
  connection: { id, name, config, secrets }    // decrypted, in memory only
  publish(type, data, { platform?, dedupeKey?, profile? }): void  // events its capabilities allow (6.2)
  setState(key: string, value: unknown, { platform?, profile? }): void  // state; undefined = remove
                                      // profile: one of the streams it follows at its service, a
                                      // feed of its own ("<connection>/<profile>", 01 §1.3; 6.11)
  hold(keys?: string[]): void        // a value can't be had now: held 120 s, stale (02 §2.8)
  setHealth({ status, detail, warnings, quota }): void  // connected | degraded | connecting
  fail(err, { retryAfterMs?, retry? }): void   // give up this start: held, started again later
  reauth(detail: string): void       // a credential the service refuses: needs-reauth
  saveTokens(tokens: TokenSet): Promise<void>  // persisted encrypted
  auth: { hasUser, accessToken(), appToken() } // renewed at 80 % and on a 401 (single flight)
  http: HttpClient                    // timeouts, retries, 429 handling built in (6.1.1)
  memory: { get, set }                // kept between starts (a cursor), at most 16 KiB
  quota: { use(n), exhausted({ resetsAt, detail }) }
  signal: AbortSignal                 // aborted when the instance stops
  log: Logger                         // redacts secrets, its own included
  publicUrl?: string                  // SKP_PUBLIC_URL, when set
  schedule(ms, fn): Cancel · every(ms, fn): Cancel · wrap(fn): fn  // a throw fails the instance
  setInfo(key, value): void           // what it tells about itself, on the connection (`info`)
  suggestName(name): void             // the connection's name, while nobody has named it
  overlays?: { baseUrl?, list(), onChange(fn), create(spec) }  // sharesOverlays only (6.11)
}
```

The **connector host** runs each connection: it creates the instance, gives `start()` 30 s, and
on any failure (a throw, a rejection, a hang, a timer that throws) stops it, holds its values
(02 §2.8) and starts it again with backoff (01 §1.7), from 1 s; 60 s connected starts the count
over, and a service's `Retry-After` or quota reset (at most a day) is waited out. A callback from
an instance that has been stopped changes nothing. Settings that don't fit are an `error` with no
retry until they change; a sign-in that is missing or refused is `needs-reauth`, never retried in
a loop. An instance publishes at most 200 events a second that overlays play as they arrive (and
5000 of moderation and backfill), and sends at most 20 requests. Past the limit a publish is
refused with an error, which fails the instance, never dropped unnoticed; a connector reading a
fast feed waits for room instead.

#### 6.1.1 The HTTP client
Retries only what is safe to send twice (`GET`, `HEAD`, `PUT`, `DELETE`, or a request marked
idempotent), at most twice, on network errors, `500`/`502`/`503`/`504` and a `429` asking for
30 s or less; never a `POST` or a token request. A `429` otherwise cools the service's origin
down for its `Retry-After` (60 s without one): requests to it fail at once until then. Answers
are capped (1 MiB by default), requests time out (10 s; a stream until its headers), and a
redirect is an error. Destinations (07 §7.11): a service's own API over HTTPS; an address the
operator typed (OBS, CTD Relay) on the local network, plain HTTP only to private
addresses, never link-local, unspecified or multicast, a self-signed certificate trusted by its
SHA-256 fingerprint, checked before the request is sent.

A connector **MUST**:
- never block the event loop or throw out of `start`; failures become `health.status = "error"`;
- refresh tokens before expiry (at 80 % of lifetime) and once more on any `401`, then stop and
  report `needs-reauth` rather than retrying in a loop;
- honour `429` and `Retry-After`; back off exponentially with jitter on `5xx` and network
  errors (base 1 s, ×2, cap 5 min);
- stop calling a service whose quota is exhausted until the documented reset, and say so in
  `health.detail`;
- publish only normalized types (02) — never raw service payloads;
- follow the absence rules (02 §2.8): never publish `0` for a failure;
- deduplicate pushed events by the service's message ID for at least 10 minutes;
- keep credentials and tokens in memory only via `ctx.connection`, never in logs or envelopes.

## 6.2 Capabilities

| Capability | Produces |
|---|---|
| `chat.read` | `chat.*` events |
| `alerts` | `alert.*` events |
| `viewers` | `viewers.<platform>` state |
| `stream.status` | `stream.<platform>.*` state, and `stream.clock` (02 §2.5.2) |
| `music` | `music.nowPlaying` state |
| `obs` | `obs.*` state; scene/source actions |
| `chat.write`, `moderation` | reserved for v2 |

The UI uses capabilities to show users what each connection will feed and which overlays can
bind to it.

## 6.3 Health

```json
{
  "status": "connected",
  "detail": "Receiving chat · 2 subscriptions active",
  "since": "2026-10-09T02:14:00Z",
  "lastEventAt": "2026-10-09T02:31:12Z",
  "quota": { "used": 3120, "limit": 10000, "resetsAt": "2026-10-09T07:00:00Z" },
  "warnings": []
}
```

`status` ∈ `disabled`, `connecting`, `connected`, `degraded` (partially working — e.g. Kick
viewers OK but chat unavailable), `needs-reauth`, `error`. The connector sets `connected`,
`degraded` and `connecting` with a detail; the host sets the rest. Every change publishes
`system.connection` (at most one a second per connection, the latest state, 02 §2.6). The
dashboard shows all connections at a glance; `GET /system/health` lists them for anyone signed
in. A `detail` is shown as it is: the host takes the connection's secrets out of it.

## 6.4 Authorization flows

Every installation registers its own developer apps (README decision 5). The admin UI **MUST**
include, per connector, step-by-step instructions with the exact redirect URI to register,
copied from the installation's configuration.

| Flow | When | Redirect URI needed |
|---|---|---|
| **Device code** | Preferred wherever offered (Twitch). The user opens a short URL on any device and types a code. Works behind NAT, on a NAS, with no public URL. | No |
| **Auth code + PKCE** | Kick, Google, Spotify | Yes — `SKP_PUBLIC_URL/oauth/callback/<connector>`, or a loopback URL for a desktop install |
| **Client credentials** | App-only reads (viewer counts) | No |
| **Password** | obs-websocket | No |
| **Pairing** | CTD Relay (§6.11): the service shows a code an admin approves in its own settings, then hands over a token once | No |

OAuth requests **MUST** use `state` bound to the user's session and **MUST** use PKCE (S256)
whenever the service supports it, even for confidential clients.

How the platform does it:
- **The redirect URI** is `SKP_PUBLIC_URL/oauth/callback/<connector>` when the public URL is set,
  else the address the platform listens at, as a loopback IP (`http://127.0.0.1:<port>/…`, never
  `localhost`: services compare redirect URIs as text). The setup screen shows it to copy, and
  warns when the admin UI was opened at another address.
- **`state`** is 32 random bytes, single use, valid 10 minutes, and bound to whoever started the
  flow (a user, an API token, the command line); PKCE's verifier is 32 random bytes. The callback
  is a `GET` with the code in the query (no `form_post`), answered `no-store`, `no-referrer`.
- **The callback** finishes the flow only in a browser signed in as whoever started it, with
  `connections:write`, then sends it to the connection's page (`?authorize=done|failed|denied`).
  Anywhere else (a phone, a loopback redirect URI opened from another device) it shows a page
  asking to copy the address and **paste it back** on the connection's page
  (`POST /connections/{id}/authorize/complete`), and the flow stays open for them. A declined
  sign-in (`?error=`) ends the flow; its description is never echoed.
- **The device flow** shows the code and the address, and the platform polls at the interval the
  service gives, 5 s slower on each `slow_down`, until it is used, declined or expired.
- **Pairing** works the same way for a service with a flow of its own: the connection's page shows
  the code, where to approve it and its countdown; the platform polls (never the browser) with a
  secret it keeps to itself, and saves what the service hands over into the connection's secret
  field, encrypted, as if typed. Denied, expired or cancelled, it says so; Connect again starts over.
- **Tokens** are kept encrypted (07 §7.7), renewed at 80 % of their life and once on a `401`;
  a renewal's new refresh token is saved before the new access token is used. A refused renewal
  (`invalid_grant`) is `needs-reauth`, said once. Deleting a connection, or signing it out,
  revokes its tokens where the service allows.

---

## 6.5 Twitch

**Auth:** Device Code Flow (generally available; supports public and confidential app types),
falling back to Authorization Code. One user token from the broadcaster's account serves an
installed app — no separate bot account. App token (client credentials) for public reads.

**Chat — EventSub over WebSocket.**
- Connect to the EventSub WebSocket endpoint; on the welcome message, create subscriptions
  using its session ID before the documented deadline; handle `session_keepalive`,
  `session_reconnect` (connect to the new URL before closing the old) and revocations.
- `channel.chat.message` with condition `broadcaster_user_id` + `user_id`, where `user_id`
  **MUST** be the account that owns the token (mismatches return 403). Scope: `user:read:chat`
  (formerly `chat:read`). Bot scopes (`user:bot`, `channel:bot`) are only needed for webhook or
  Conduit transports, which v1 does not use.
- Moderation: `channel.chat.message_delete` → `chat.message.deleted`;
  `channel.chat.clear_user_messages` → `chat.user.cleared`; `channel.chat.clear` →
  `chat.cleared`.
- `channel.chat.notification` carries subs, resubs, gift bombs, raids and announcements as
  they appear in chat; map to `alert.*` where the dedicated subscription isn't used, and dedupe
  against it.
- Emotes arrive as fragments with IDs; resolve to the emote CDN. Badges resolve via the global
  and channel chat-badge endpoints, cached for 24 h.

**Alerts:** `channel.follow` (v2, `moderator:read:followers`), `channel.subscribe`,
`channel.subscription.gift`, `channel.subscription.message` (`channel:read:subscriptions`),
`channel.cheer` (`bits:read`), `channel.raid`.

**Viewers & status:** `GET /helix/streams?user_login=<login>` → `data[0].viewer_count`; an
empty `data` array means offline (authoritative zero). `stream.online` / `stream.offline` via
EventSub update `stream.twitch.live` instantly.

**Sources:** dev.twitch.tv/docs/eventsub, dev.twitch.tv/docs/chat/authenticating,
dev.twitch.tv/docs/authentication/getting-tokens-oauth.

---

## 6.6 Kick

**Auth:** OAuth 2.1 with PKCE for the broadcaster's user token; client credentials for public
reads. The broadcaster must authorize the installation's app before any of their events flow.

**Viewers & status:** `GET https://api.kick.com/public/v1/channels?slug=<slug>` with
`Authorization: Bearer <token>` → `data[0].stream.viewer_count` and `stream.is_live`.

**Chat and alerts — webhooks only.** Kick's public API delivers events (`chat.message.sent`,
follows, subscriptions, gifts, kicks, livestream status) exclusively by **webhook**: the
installation subscribes via `POST /public/v1/events/subscriptions` (scope `events:subscribe`)
and Kick POSTs each event to a public HTTPS URL. Consequences the platform **MUST** handle:

- **A public URL is required.** In `local` or `lan` exposure mode (07 §7.8), the Kick connector
  runs **degraded**: viewer count and live status work; chat and alerts are unavailable, and the
  UI says exactly that and how to fix it (public mode, or a tunnel that provides HTTPS).
- **Verify every delivery.** Check the signature header against Kick's public key (fetched from
  `/public/v1/public-key`, cached, refetched on verification failure), require a fresh
  timestamp (±5 min), and dedupe on the message ID.
- **Re-subscribe defensively.** Kick removes subscriptions whose endpoint fails for about a
  day. On startup and every 6 hours, list subscriptions and recreate missing ones.
- **Expect gaps.** Developers have reported stalled chat delivery. Health **MUST** turn
  `degraded` when no chat event has arrived for 10 minutes while the channel is live.

An unofficial Pusher-based chat feed exists and works without a public URL. It is not part of
Kick's public API. A connector **MAY** offer it only as an explicit opt-in labelled
"Unofficial — may break without notice", never as the default.

**Viewer-count caveat:** when a streamer hides their viewer count, the official API reports 0
while unofficial sources report the real number. The platform uses the official value.

**Sources:** docs.kick.com, github.com/KickEngineering/KickDevDocs (webhook security, events).

---

## 6.7 YouTube

**Auth:** Google OAuth (Authorization Code + PKCE), scope `youtube.readonly`, with the user's
own Google Cloud project.

**Quota is the constraint.** The YouTube Data API grants **10,000 units per day by default**,
resetting at midnight Pacific time. Every request — including failed ones — costs at least one
unit. The connector **MUST**:
- keep a running unit estimate and expose it in `health.quota`;
- on `quotaExceeded`, stop all YouTube calls until the reset and set health to `degraded` with
  the reset time. Treating it as a rate limit and retrying has burned entire days of quota in
  real deployments;
- let the owner set a daily budget below the quota, leaving headroom for other tools.

**Finding the chat:** `liveBroadcasts.list` (`broadcastStatus=active`, `mine=true`) →
`snippet.liveChatId`. Re-check every 5 minutes while not live; stop when live.

**Chat:** prefer `liveChatMessages.streamList` — a server-streaming connection Google
recommends for low latency and quota efficiency — when the runtime's standard library can consume
it (README decision 8). Confirm its transport before relying on it. Otherwise, and as the
fallback, use `liveChatMessages.list`, honouring the returned `pollingIntervalMillis` and
`nextPageToken` exactly; never poll faster. The quota
cost of `streamList` was not documented at verification time; measure it in the Cloud Console
before release and record it here.

**Alerts** arrive as chat items by `snippet.type`: `superChatEvent`, `superStickerEvent` →
`alert.superchat`; `newSponsorEvent`, `memberMilestoneChatEvent` → `alert.membership`.

**Viewers:** `videos.list?part=liveStreamingDetails&id=<videoId>` →
`liveStreamingDetails.concurrentViewers` (absent when hidden or offline → key absent). Poll no
faster than every 30 s.

**Sources:** developers.google.com/youtube/v3/live/docs, developers.google.com/youtube/v3/determine_quota_cost.

---

## 6.8 Spotify

**Auth:** Authorization Code + PKCE, scopes `user-read-currently-playing` and
`user-read-playback-state`. Register the redirect URI exactly; for a desktop install use a
loopback IP redirect (`http://127.0.0.1:<port>/oauth/callback/spotify`) — confirm Spotify's
current redirect rules at implementation.

**Every installer brings their own app, and must have Premium.** Since February 2026, Spotify
development-mode apps require the app owner to hold an active Spotify Premium subscription and
are limited to a small number of users; extended access is restricted to organizations meeting
review criteria. A self-hosted platform therefore cannot ship a shared client ID. The setup
guide **MUST** say so plainly, before the user starts.

**Now playing:** `GET https://api.spotify.com/v1/me/player/currently-playing` — `200` with
`item`, or `204` when nothing is playing (key `music.nowPlaying` removed). Poll every 3 s while
playing, every 15 s while paused or idle; on `429` wait `Retry-After`. Use `progress_ms` with
the response `timestamp` to fill `progressMs` / `progressAt`; the runtime interpolates.

**Other music sources:** anything that can `PUT /api/v1/state/custom.music` (a desktop helper,
a DJ-software bridge) can feed a now-playing template. A connector **MAY** map such a source to
`music.nowPlaying` so music templates work unchanged.

**Sources:** developer.spotify.com/documentation/web-api, the February 2026 migration guide, and
the April 2025 extended-access criteria announcement.

---

## 6.9 OBS Studio

OBS has no webhooks; integration is through **obs-websocket**, built into OBS Studio since 28.
The platform connects as a **client** to OBS, which listens on port **4455** by default
(configurable in OBS under Tools → WebSocket Server Settings).

**Handshake (protocol v5):**
1. Server sends `Hello` (op 0) with `authentication.challenge` and `authentication.salt` when a
   password is set.
2. Client computes `secret = base64(sha256(password + salt))`, then
   `auth = base64(sha256(secret + challenge))`.
3. Client sends `Identify` (op 1) with `rpcVersion`, `authentication` and `eventSubscriptions`
   (a bitmask; use the `All` value of the protocol version being targeted — it grew when the
   Canvases category was added, so don't hardcode a number).
4. Server replies `Identified` (op 2). Then: `Request` (6) / `RequestResponse` (7), `Event` (5),
   `RequestBatch` (8) / `RequestBatchResponse` (9), `Reidentify` (3).

**State:** `obs.scene` from `GetCurrentProgramScene` and the `CurrentProgramSceneChanged`
event; `obs.streaming` from `GetStreamStatus` / `StreamStateChanged`; `obs.recording` from
`RecordStateChanged`.

**Actions:** `obs.setScene` (`SetCurrentProgramScene`), `obs.listScenes` (`GetSceneList`),
`obs.toggleSource`, and `obs.addOverlay` — creates a browser source for an overlay via
`CreateInput` with the overlay URL and the canvas width/height, so "Add to OBS" is one click.

**Scene mapping.** An overlay or show **MAY** map OBS scenes to overlay scenes
(`"BRB" → brb`, `"Live" → program`). When OBS changes scene, the platform takes the mapped
overlay scene — the operator switches once, in OBS, and the graphics follow. Timeline cues
**MAY** do the reverse with `obs.setScene`.

**Placement and security.** OBS usually runs on the streaming PC while the platform runs on a
NAS, so the connection is LAN-to-LAN. A password is **REQUIRED**. obs-websocket **MUST NOT** be
port-forwarded to the internet; the UI warns if the configured host is not a private address.
Reconnect with backoff when OBS closes — it restarts often.

**Sources:** github.com/obsproject/obs-websocket — docs/generated/protocol.md.

---

## 6.10 Connecting other apps

### Inbound
| Mechanism | Use |
|---|---|
| REST with API token | Bots, scripts, Stream Deck / Bitfocus Companion HTTP actions, game integrations |
| `POST /api/v1/events` | Push custom events onto the bus (`custom.*`, `x-<vendor>.*`) |
| `PUT /api/v1/state/{key}` | Set custom state a template can display |
| `POST /hooks/custom/{id}` | A generic inbound webhook with its own secret; a JSON mapping turns the payload into an event (`{ "type": "alert.tip", "map": { "user.name": "$.donor", "amount.value": "$.amount" } }`) — this is how donation services without a connector plug in |

### Outbound webhooks
Users subscribe a URL to event types. Each delivery:
- is a `POST` of the envelope with `Content-Type: application/json`;
- carries `SKP-Signature: t=<unix-seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">` keyed with
  the webhook's secret, plus `SKP-Delivery: <id>`;
- is retried on non-2xx with backoff (1 min, 5 min, 30 min, 2 h, 12 h) then marked failed;
- is logged (status, latency, response excerpt) and replayable from the UI.

Receivers **MUST** reject timestamps older than 5 minutes and duplicate delivery IDs.

### Live stream for apps
`GET /api/v1/events` (SSE, token with `events:read`) gives dashboards, bots and companion
apps the same live feed overlays get, filtered by `?types=`.

### Server-side connector plugins
A connector **MAY** be added as a plugin (a directory with `connector.json` and an ES module
implementing §6.1). Plugins run in-process with full trust; installing one is an owner-only
action and the UI **MUST** say it grants access to credentials.

---

## 6.11 CTD Relay

The operator's multistreaming server ([ctd-multi-stream](https://github.com/ItsLimitlezz/ctd-multi-stream),
its `docs/API.md` v1.2) streams to every platform at once and merges their chat into this
standard's envelope. Its **profiles** are independent streaming set-ups, live at the same time
("DPRTMNT", "Miami or Bust"). Its connector (`ctd-multistream`) is a **relay**: where a direct
connector also sets a value (`viewers.twitch`), the direct one is shown (02 §2.5.0). **One
connection follows every profile** its token reads (or one): each profile is a **feed** of the
connection (`src.profile`, 02 §2.1), a stream of its own here, and an overlay is assigned to a
profile by being fed by it, `"<connection id>/<profile id>"` in its bindings (01 §1.3); bound to
the whole connection (or `"all"`), it is fed by every profile, new ones too.

**Auth: pairing** (its §9.3). The operator types the LAN URL ending in `/api/v1` (plain HTTP on the
local network, or its HTTPS address with the certificate's SHA-256 fingerprint when self-signed)
and presses Connect: `POST /pairing` (no token) asks for `status:read`, `chat:read`, `apps:read`,
`apps:write` with `appName: "CTD Overlay"`, `kind: "ctd-overlay"`, `profileId: null`. The code
shows on the connection's page with its `approveUrl`; an admin approves it in CTD Relay →
Settings → API and picks the profile, or every profile. The platform polls `POST /pairing/{id}/token` every
`interval` s (`202` pending, `200` the token, once; `403` denied, `410` expired; a `429` waits for
its `Retry-After`), and saves the token as the connection's token secret; the poll secret is
never answered, logged or stored. Too many requests waiting (`429` on `POST /pairing`) is said in
words. A pasted token (`ctd_pat_…`, Settings → API → New token) still works. A `401` means the
token was revoked or is wrong: `needs-reauth` until Connect again (or a new token). A `403` (a
missing scope) is an error until it is fixed; a `429` is waited out.

**Profiles:** `GET /api/v1/` names the token's `profileId`. A token limited to a profile reads
that one (`GET /profiles/{id}`): the connection is that profile, its data its own (no
`src.profile`). A token for every profile (`null`, pasted tokens from before v1.2 too) follows
**every profile** while the connection's Profile setting is empty or `*` ("Every profile", the
default): `GET /profiles` lists them, **one** event stream reads them all (`/events?profile=*`,
each envelope's `src.profile` naming its profile; one cursor), and `/status` and `/chat` are read
per profile (`?profile=<id>`); what it publishes for a profile carries `src.profile`. A profile made
there is followed at once (`profiles.changed`, or the first event naming it: its status read, its
recent chat buffered quietly); one deleted there is dropped, its values gone, and an overlay bound
to it alone gets nothing more (its `bound` and `stream` say `missing`). `system.reset` reads the
profiles, then each one's status and chat, again. Events about no single profile
(`profiles.changed`, `system.notice`, `app.message`) are the connection's. Each profile (name,
colour, `offline | starting | live | stopping`, since when) is in the connection's `info.profiles`
(with `info.everyProfile: true`, and in `GET /system/health`), kept fresh by `profile.status`. A
connection nobody named is called "Relay". With one profile picked in the setting instead,
it passes `?profile=<id>` on `/status`, `/chat` and `/events`, always: the profile is the
connection's `info.profile`, `profiles.changed` reads it again, a profile deleted there is an
`error` saying so, and a connection nobody named is called "Relay · <profile name>". A
cursor kept from the other kind of stream (one profile, every profile) is never resumed from. A
stream fed by a profile (src/streams.js) shows it and is **on air when the profile is live**,
before any platform says so. A server older than v1.2 (no `profileId` in `GET /`) is read as
before. (Upgrading: a connection whose setting named the default profile, set so before "Every
profile" existed, follows every profile; store migration 3.)

**Hub** (its §9.2), with `apps:write`: the connection registers the overlays it feeds (bound to
it, or to every connection) with `PUT /apps/{appId}`, `appId` `ctd-overlay-<profile slug>` for a
token limited to a profile and `ctd-overlay` for one that reads every profile: `{ name: "CTD
Overlay", kind: "ctd-overlay", version, baseUrl, capabilities: ["overlays", "overlay.create"],
resources }`. One resource per canvas: `{ type: "overlay", id: "<overlay id>:<canvas id>", name:
"<slug> — <canvas>", profileId, url, width, height, meta: { canvas, slot, transparent: true } }`.
`profileId` is the profile it follows. Following every profile, an overlay is registered once
per profile it is fed by, assigned to it, id `<overlay id>:<canvas id>:<profile id>`, the same URL,
canvas and slot each time: the profiles of its `"<connection>/<profile>"` bindings, or every
profile followed now when it is bound to the whole connection or to `"all"` (the OBS plugin lists
a profile's overlays with `GET /profiles/{id}/overlays`, which leaves unassigned ones out). A
profile made or deleted there registers them again.
`url` is the overlay's URL for OBS, its key included, at `baseUrl`: `SKP_PUBLIC_URL`, else the
first `SKP_HOSTS` name with its port (lan and public modes; `192.168.1.50:4850` →
`http://192.168.1.50:4850`); without one the connection warns and shares no URLs. `canvas` is
`landscape` or `vertical`: a canvas id `h`/`v` says so, else in a template with a `v` canvas the
others are the main output's, else its shape (width ≥ height). `slot` is the overlay's **Role in
OBS** (`role`, ≤ 54 of `[a-z0-9-]`, set on the overlay) or its template id's last part, plus the
canvas: `takeover-landscape`, `chat-main-vertical`: the same for the equivalent overlay of every
profile, so the OBS plugin re-points its sources when it switches profile. Sent every 30 s (the
hub counts an app offline after 90 s) and about a second after an overlay is made, deleted,
renamed, re-keyed, re-bound or re-roled; at most 200 resources and 256 KB (the first ones, by slug,
and a warning). `409 app_owned` (another token registered that id) is a warning saying to delete
the old app in Settings → API; it registers again by itself once it can. Deleting or turning off
the connection unregisters it (`DELETE /apps/{appId}`, best effort). The connection shows what it
shares (`info.hub`: "Shared with the OBS plugin: 4 overlays").

**Messages** (its `app.message`, with `apps:read`): only requests addressed to this app id are
answered, and every one is (`POST /messages { to: <from>, from: <appId>, type, profileId,
replyTo: <id>, data }`): `overlay.create { template, canvas? }` makes an overlay when the
connection's **Let other apps create overlays** is on (the default): `template` is an installed
template's id, or its id's last part or its name (any case); `canvas` `landscape` or `vertical`
picks that canvas (absent: every canvas). The overlay is named `<template short name>-<profile
slug>` (`-2`, `-3`… when taken), fed by this connection only (following every profile: by the
message's `profileId`, `"<connection>/<profile>"`, or by the whole connection when it names none;
a profile it doesn't follow is refused), recorded in the audit log as
`app:<from>` (`via` the connection), registered, then answered `overlay.created { ok: true,
resource }` (or `resources`). Anything else is `{ ok: false, reason }` in plain words: the switch
off, no such template or canvas, no address for OBS, more than 10 a minute; a type it doesn't
handle is answered `error { ok: false, reason }`. Broadcasts and replies are never answered; each
message is handled once (its id remembered across restarts); a request replayed after the
connection was away over two minutes is refused; at most 100 answers a minute (the hub takes 120).

**Events:** `GET /events` (SSE) with `types=chat.*,alert.*,stream.status,destination.*,system.notice`
(and `profile.status,profiles.changed`, and `app.message` with `apps:read`; `profile=*` following
every profile),
resumed with `Last-Event-ID` from the last frame's id, kept between starts. On a first start, or
when it says `system.reset` (the cursor left its buffer, or it restarted), the platform reads
`/status` and `/chat?limit=200` again; that chat goes into the chat buffer **without being sent
live** (a snapshot shows it; overlays never replay old chat at once). Chat replayed after more than
a minute is buffered the same way; an alert more than two minutes old is dropped. Every event is
deduplicated by its id (a chat message by its own id).

**Mapping:** `chat.message`, `chat.message.deleted`, `chat.user.cleared` and `alert.<kind>` keep
their payloads in this standard's shapes (nulls left out, roles of the closed set, a fragment type
not known here as text, text cut at 1000 characters, Twitch tiers as `1`, `2`, `3`, `prime`),
with `src.platform` from the envelope (an unknown platform is `custom`). A `chat.cleared` for one
platform removes that platform's messages (one `chat.message.deleted` each), not every
platform's. While alerts are on, an alert's chat line (`kind: "event"`) is left out (a setting).
A "<name> joined" presence line (`join: true`, Instagram and TikTok, v1.3) is not a comment: it is
left out unless the connection's "Show who joined" is on, and then reaches overlays marked `join`.
`viewers.<platform>` and `stream.<platform>.live | title | startedAt` come from `/status` and each
`destination.status`; a count it doesn't know (`null`) is absent, never 0.

**Stream clock** (its §4, `GET /clock`, v1.3), with `status:read`: the connection measures CTD
Relay's clock against its own, NTP-style, and publishes each profile's `stream.clock` (02 §2.5.2)
as that profile's state (or the connection's, following one profile), so a template counts the
stream's run time and timecode from `SK.clock` with no request per frame. A **sync** asks
`GET /clock?t0=<this server's time>` (with `?profile=` as `/status`) 6 times, a second apart
(following every profile: at least once per profile, the profiles in turn); for each answer, with
`t3` its arrival, `offset = ((receivedAt − t0) + (sentAt − t3)) / 2` and
`delay = (t3 − t0) − (sentAt − receivedAt)`; the **lowest delay's offset** is kept (one server
answers for every profile, so one offset serves them all). Each profile's last answer gives its
`session.startedAt` (CTD's clock) and `fps`: `stream.clock` is `{ startedAt: session.startedAt −
offset` (absent while no session runs)`, fps, offsetMs: offset, at }` (`at`: when the kept sample
was taken). It syncs on every start (so after every reconnect), after `system.reset`, and every
5 minutes (30 s after one that failed); a session that starts or stops in between
(`stream.status`, `profile.status`) is read again at once, one answer, with the last offset; a
profile new here is read at once. Times come from the connector's `ctx.now()` and waits from
`ctx.schedule` (a test's fake clock in tests). A Relay older than v1.3 answers `404`: asked once a
start, no clock state, one warning ("older than v1.3: overlays get no stream clock"); a `403` stops
it quietly; anything else tries again later, never failing the connection. A deleted profile's
clock goes with its other values.

**Health:** `connected` while the stream is open; `degraded` while a destination is down, saying
which and why (`Instagram: ended the live (copyright)…`); its `system.notice`s are the
connection's warnings, for the operator only. Nothing for 45 s (it sends a heartbeat every 15 s)
reconnects.
