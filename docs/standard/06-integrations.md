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
  capabilities: Capability[]         // see 6.2
  credentials: CredentialSpec        // what the user must supply (client ID, secret, password…)
  auth: 'oauth-pkce' | 'oauth-code' | 'device-code' | 'client-credentials'
      | 'password' | 'none'
  requiresPublicUrl?: boolean        // true if the service pushes to us (webhooks)

  start(ctx: ConnectorContext): Promise<void>
  stop(): Promise<void>
  health(): Health                    // see 6.3
  actions?: Record<string, ActionSpec>
}

interface ConnectorContext {
  connection: Connection              // decrypted credentials + tokens, in memory only
  publish(envelope: EnvelopeInput): void       // events
  setState(key: string, value: unknown): void   // state; undefined = remove
  saveTokens(tokens: TokenSet): Promise<void>  // persisted encrypted
  http: HttpClient                    // timeouts, retries, 429 handling built in
  log: Logger                         // redacts secrets
  publicUrl?: string                  // SKP_PUBLIC_URL, when set
  schedule(ms: number, fn: () => void): Cancel
}
```

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
| `stream.status` | `stream.<platform>.*` state |
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
viewers OK but chat unavailable), `needs-reauth`, `error`. Every change publishes
`system.connection`. The dashboard shows all connections at a glance.

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

OAuth requests **MUST** use `state` bound to the user's session and **MUST** use PKCE (S256)
whenever the service supports it, even for confidential clients.

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
