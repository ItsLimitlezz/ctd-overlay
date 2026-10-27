# 02 · Data model

Every piece of live data in the platform is either an **event** or **state**, wrapped in one
envelope. Connectors produce them, templates and external apps consume them, and none of them
need to know which service a value came from unless they want to.

## 2.1 Envelope

```json
{
  "id": "01J9Z6M3Q8T6C9V4PZ7XKQ2N1H",
  "type": "chat.message",
  "ts": 1791582412345,
  "src": { "connector": "twitch", "connection": "con_7f3a", "platform": "twitch" },
  "data": { }
}
```

| Field | Rule |
|---|---|
| `id` | **MUST** be unique and sortable by creation time (ULID recommended). Doubles as the SSE cursor. |
| `type` | **MUST** be a registered type (§2.6) or a namespaced custom type (§2.7). |
| `ts` | Server epoch milliseconds at which the platform accepted the event. |
| `src` | Where it came from. `platform` is the user-facing service name (`twitch`, `kick`, `youtube`, `facebook`, `x`, `instagram`, `tiktok`, `spotify`, `obs`, `custom`); `connection` identifies the account. Core-originated envelopes use `{ "connector": "core" }`. A relayed envelope (CTD Relay, 06 §6.11) names the platform it was relayed from. `profile` (optional, with `connection`): the stream at the service that the connection's data belongs to, when it follows several (a CTD Relay profile id, no spaces or `/`, ≤ 100): that connection's **feed** `"<connection>/<profile>"`, which overlays are bound to on its own (01 §1.3) and whose values are kept apart from the connection's other feeds (§2.5.0). |
| `data` | Type-specific payload, defined below. |

Schema: [schemas/envelope.schema.json](schemas/envelope.schema.json).

## 2.2 Events vs state

| | Event | State |
|---|---|---|
| Meaning | Something happened | Something *is* |
| Example | a chat message, a follow, a cue fired | viewer count, now playing, active scene |
| In snapshot | No (except the chat buffer, §2.3) | Yes, always |
| Delivery | Once, in order | Latest value wins; changes arrive as `state.changed` |
| Missed while disconnected | Replayed from buffer, else lost | Recovered from the next snapshot |

### State changes
```json
{ "type": "state.changed", "data": { "key": "viewers.total", "value": 1159, "prev": 1140 } }
```

State keys are dotted lowercase. Values **MUST** be JSON. A key that has no current value
**MUST** be absent rather than `null` or `0` — see §2.8.

## 2.3 Chat

Chat is the most demanding stream, so the platform does the heavy lifting: it merges
platforms, parses emotes into fragments, applies deletions and bans, and keeps a rolling
buffer so a template that loads mid-stream isn't empty.

### `chat.message`
```json
{
  "id": "msg_01J9Z6…",
  "platformMessageId": "b6c1e…",
  "channel": "dprtmnt",
  "user": {
    "id": "twitch:12345",
    "login": "trapment",
    "name": "Trapment",
    "color": "#16E0FF",
    "avatar": "https://…/profile_image.png",
    "roles": ["subscriber", "vip"],
    "badges": [ { "id": "subscriber/12", "label": "12-month subscriber", "image": "https://…" } ]
  },
  "text": "that drop 🔥 PogChamp",
  "fragments": [
    { "type": "text",  "text": "that drop 🔥 " },
    { "type": "emote", "text": "PogChamp", "image": "https://…/3.0", "animated": false }
  ],
  "reply": null,
  "highlighted": false,
  "action": false
}
```

- `user.id` **MUST** be prefixed with the platform (`twitch:`, `kick:`, `youtube:`) so IDs never
  collide across platforms.
- `roles` is normalized across platforms to this closed set: `broadcaster`, `moderator`, `vip`,
  `subscriber`, `member`, `verified`, `founder`, `artist`, `bot`. A template styles roles, not
  platform-specific badge IDs.
- `fragments` types: `text`, `emote`, `mention`, `link`, `cheermote`. Concatenating every
  fragment's `text` **MUST** reproduce `text`.
- `color` **MAY** be absent (YouTube has none). Templates **MUST** handle that.
- Third-party emote sets (7TV, BTTV, FFZ) **MAY** be resolved by an optional connector into
  `emote` fragments; templates see no difference.

### `chat.message.deleted`
`{ "messageId": "msg_01J9Z6…" }` — the template **MUST** remove it from screen. The runtime
also removes it from its buffer and from any not-yet-rendered queue.

### `chat.user.cleared`
`{ "userId": "twitch:12345" }` — a ban or timeout: remove all of that user's messages.

### `chat.cleared`
`{}` — the channel's chat was cleared: remove everything.

### Chat buffer in the snapshot
The snapshot **MUST** include `chat.recent`: the last N messages (N declared by the template,
default 50, max 200) that are still visible after moderation, oldest first.

## 2.4 Alerts

Alerts are one event family with a common core so a template can style them uniformly and
differentiate by `kind`.

Type: `alert.<kind>` · Common payload:

```json
{
  "kind": "subscription",
  "user": { "id": "kick:991", "name": "BIA", "avatar": "https://…" },
  "amount": { "value": 1, "unit": "months" },
  "tier": "1",
  "message": { "text": "first sub!", "fragments": [ ] },
  "gift": null
}
```

| Kind | `amount.unit` | Platforms |
|---|---|---|
| `follow` | — | Twitch, Kick |
| `subscription` | `months` | Twitch, Kick |
| `gift` | `count` (subs gifted) | Twitch, Kick |
| `cheer` | `bits` | Twitch |
| `kicks` | `kicks` | Kick |
| `raid` | `viewers` | Twitch, Kick (host) |
| `membership` | `months` | YouTube |
| `superchat` | `currency` + `value` | YouTube (Super Chat, Super Sticker) |
| `tip` | `currency` + `value` | external donation services via API |

Money amounts **MUST** carry an ISO 4217 `currency` and a decimal `value` as a string
(`"5.00"`), never a float. The platform **MUST NOT** convert currencies.

Alerts are queued on the server, per show (or per overlay outside a show), never by the template
or the browser — see 05 §5.5. When the queue releases an alert to an overlay it adds
`"display": { "startAt": …, "durationMs": … }` in server time, so every member of a show shows it
at the same moment. Alerts read through `GET /api/v1/events` or webhooks arrive as they happen,
without `display`.

## 2.5 State keys

| Key | Value | Source |
|---|---|---|
| `viewers.total` | integer — sum across bound platforms, worked out per overlay | core |
| `viewers.<platform>` | integer | connector |
| `viewers.stale` | `true` while a `viewers.<platform>` the overlay shows is held through an error | core |
| `<key>.stale` | `true` while the value shown for `<key>` is held through an error (§2.8) | core |
| `stream.<platform>.live` | boolean | connector |
| `stream.<platform>.title` | string | connector |
| `stream.<platform>.startedAt` | epoch ms | connector |
| `stream.clock` | object — the stream's start and frame rate on this server's clock, for run times and timecodes (§2.5.2) | connector (CTD Relay, 06 §6.11) |
| `music.nowPlaying` | Track object (§2.5.1) | music connector |
| `obs.scene` | string — current program scene (the main, landscape canvas's) | OBS |
| `obs.scene.landscape` | `{ scene, sceneUuid?, appId?, since }` — the landscape (main) canvas's program scene; `appId`: the OBS machine that reported it (CTD Relay), `since`: epoch ms it became the program scene | OBS |
| `obs.scene.vertical` | the same, for the vertical canvas (Aitum Vertical) | OBS |
| `obs.scenes.landscape` | `[{ scene, sceneUuid? }]` — every scene of the landscape canvas, in OBS's order, when OBS says them (the CTD OBS plugin through CTD Relay v1.6) | OBS |
| `obs.scenes.vertical` | the same, for the vertical canvas | OBS |
| `obs.streaming` | boolean — any output but the recording runs | OBS |
| `obs.recording` | boolean | OBS |
| `show.scene` | string — the overlay's active scene | core |
| `show.lineup` | array of slots (see 09) | core |
| `show.headliner` | string — the name on the lineup slot flagged `headliner` (09 §9.1), for settings bound to it (04 §4.3) | core |
| `show.currentSlot` | integer index | core |
| `show.nobodyOn` | `true` while the operator said nobody is on (09 §9.1): no act, whatever the lineup's times say; absent otherwise (no pick yet: a template may go by the clock) | core |
| `show.date` | string — the show's date, `YYYY-MM-DD` (09 §9.1) | core |
| `show.timezone` | string — the show's IANA time zone (09 §9.1), for clocks and settings bound to it | core |
| `show.goLiveAt` | epoch ms — the instant the show's `goLive` resolves to (09 §9.2) | core |
| `show.recStartedAt` | epoch ms | core |
| `overlay.settings` | the overlay's resolved settings | core |

### 2.5.0 One value from many connections
Each connection keeps its own value for a key; two accounts on one platform, or a relay beside
a direct connector, never overwrite each other. An overlay shows one value per key, chosen among
the connections it is bound to (01 §1.3), by one rule:
1. a value the core set itself (a demo, `PUT /state` from an app) wins;
2. a fresh value wins over one held through an error (§2.8);
3. a direct connection wins over a relay (CTD Relay, 06 §6.11);
4. the older connection wins.

A connection's feeds (`src.profile`, §2.1: its CTD Relay profiles) keep their own values
the same way, and rank as their connection does; between two feeds of one connection, the lower
profile id wins (as two accounts on one platform: an overlay fed by every profile of a
connection that stream to the same platform shows one profile's count for it).

`viewers.total` is the sum of the `viewers.<platform>` values the overlay shows, one per
platform (two accounts on one platform count once), unless the core set `viewers.total` itself;
a held value counts until it is removed. `GET /api/v1/state` and the `/events` stream show the
same choice made with every connection. A change reaches an overlay only when the value it shows
changes.

A connection that relays OBS for several streams (CTD Relay's profiles, 06 §6.11) sets the `obs.*`
keys per feed like any other value: an overlay fed by one profile sees that profile's OBS. Shows
follow `obs.scene.<canvas>` (09 §9.7).

### 2.5.1 Track
```json
{
  "title": "Strobe", "artists": ["deadmau5"], "album": "For Lack of a Better Name",
  "art": "https://i.scdn.co/image/…", "url": "https://open.spotify.com/track/…",
  "durationMs": 637000, "progressMs": 120400, "progressAt": 1791582412000,
  "playing": true, "source": "spotify"
}
```
`progressAt` is the server time at which `progressMs` was true. The runtime interpolates
progress locally between updates; templates read `SK.music.progress()` and never poll.

### 2.5.2 Stream clock
```json
{ "startedAt": 1791831604000, "fps": 30, "offsetMs": -38, "at": 1791839012250 }
```
A shared reference for run times and timecodes, so overlays on several machines show the same
second and frame. All times are **this server's** (`SK.clock.now()`'s clock):
- `startedAt` — when the stream's session started; **absent** while no session runs (§2.8).
- `fps` — the integer frame rate timecodes count in (the feed's, else 30).
- `offsetMs` — the source's clock minus this server's (its own timecodes, such as a UTC time of
  day, are on `SK.clock.now() + offsetMs`).
- `at` — when that offset was measured.

It is state, never an event per frame or second: a template computes run time as
`SK.clock.now() − startedAt` and a non-drop-frame timecode `HH:MM:SS:FF` with
`FF = floor((ms mod 1000) × fps / 1000)` itself, as often as it paints. CTD Relay's connector sets
it per profile (06 §6.11): an overlay fed by one profile gets that profile's.

## 2.6 Registered event types

| Type | Payload |
|---|---|
| `state.changed` | §2.2 |
| `chat.message`, `chat.message.deleted`, `chat.user.cleared`, `chat.cleared` | §2.3 |
| `alert.<kind>` | §2.4 |
| `alerts.cut` | `{ "alertId": "…" }` — end that alert now (an operator skip, 05 §5.5). Delivered to every overlay that consumes `alert.*`. |
| `show.scene.changed` | `{ "scene": "brb", "prev": "program", "transition": "cut" }` — a take. The platform publishes it, then the `show.scene` state, in the same tick; the runtime uses the event's transition. It carries no `startAt`: members switch on receipt, so two of them can differ by their delivery time (up to one poll interval for a polling source). |
| `show.trigger` | `{ "name": "titleCard", "args": { }, "startAt": 1791582412000, "durationMs": 7000 }` |
| `show.cue.fired` | `{ "cueId": "cue_…", "action": "…" }` |
| `media.play`, `media.stop` | `{ "mediaId": "…", "url": "/media/…" }`; a stop **MAY** leave out `url`, meaning whatever plays |
| `system.connection` | connection health change (06 §6.3): `{ "connection", "connector", "name", "status", "prev"?, "detail"?, "since", "lastEventAt"?, "quota"?, "warnings" }`, at most one a second per connection (the latest state). Operator-facing, never sent to an overlay. |
| `system.notice` | `{ "level": "info" }` — operator-facing, never rendered on air |

## 2.7 Custom types

External apps and connectors outside this standard **MUST** use one of:
- `custom.<name>` — installation-local, ad hoc;
- `x-<vendor>.<name>` — published by a third-party integration (`x-streamdeck.button`).

State keys follow the same rule: `custom.*` or `x-<vendor>.*`. Unprefixed types and keys are
reserved for this standard. The platform **MUST** reject unprefixed custom publishes with `422`.

## 2.8 Absence, staleness and zero

This is a hard rule (11 §H6). For any value displayed on air:
- **Unknown** → the key is absent. Templates hide the element.
- **Real zero** → `0`. Only when a service authoritatively reported zero (e.g. a channel that is
  verifiably offline).
- **Error** → hold the last good value for up to 120 s with `<key>.stale = true`, then remove
  the key.

A connector **MUST NOT** publish `0` because a request failed. The connector host does the
holding: when a connection fails (or its connector says a value can't be had now), every value it
set is marked stale and kept 120 s, then removed unless the connector set it again. `<key>.stale`
follows the value an overlay shows (§2.5.0): another connection's fresh value for the key shows
instead, unmarked. A connection stopped on purpose (turned off, edited, deleted) takes its values
away at once; nothing is held across a restart of the platform.

## 2.9 Size and rate limits

- An envelope **MUST NOT** exceed 64 KiB serialized. Chat messages longer than 1000 characters
  are truncated by the connector with `"truncated": true`.
- The bus **MUST** coalesce `state.changed` for the same key to at most 10 per second per
  overlay.
- If an overlay's outbound queue exceeds 1000 envelopes, the platform drops the oldest
  `chat.message` events first and sets `chat.dropped` in the next envelope's metadata.
