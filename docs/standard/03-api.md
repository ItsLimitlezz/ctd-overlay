# 03 · API

One API serves the admin UI, external apps, bots and hardware controllers. There is no private
admin API: anything the UI can do, an authorized client can do.

## 3.1 Conventions

| Topic | Rule |
|---|---|
| Base path | `/api/v1`. A breaking change ships as `/api/v2`; v1 stays served for at least one major release. |
| Format | JSON (`application/json; charset=utf-8`) for bodies and responses. |
| Description | The platform **MUST** serve an OpenAPI 3.1 document at `/api/v1/openapi.json`. |
| IDs | Opaque strings with a type prefix: `ovl_`, `con_`, `usr_`, `cue_`, `show_`, `med_`, `whk_`. Templates are addressed by their manifest's reverse-DNS `id` (04 §4.2). |
| Time | ISO 8601 UTC in resource bodies (`2026-08-29T05:00:00Z`); epoch ms only in live envelopes. |
| Names | `camelCase` fields; plural resource paths. |
| Pagination | Cursor based: `?limit=50&cursor=…` → `{ "items": [], "next": "…" }`. Max limit 200. |
| Concurrency | Mutable resources return `ETag`. Requests authenticated by session (the admin UI) **MUST** send `If-Match` on `PATCH` and `PUT`: without it the platform answers `428`, and with a stale tag `412`. Token-authenticated clients **SHOULD** send it and **MAY** omit it, accepting last-write-wins. Commands (taking a scene, firing actions, triggers and cue overrides, applying a plan, alert queue controls) take no `If-Match`. Two operators editing one overlay can't silently overwrite each other. `If-Match: *` matches any existing resource (from a token; a session must name the tag it read, else `428`). A list matches when one of its tags is current. Tags compare strongly: a weak tag (`W/"…"`) never matches, so the admin UI sends `"<id>-r<rev>"` built from the resource's `id` and `rev`. |
| Idempotency | `POST` accepts `Idempotency-Key`; a repeat within 24 h returns the original result (with `Idempotent-Replayed: true`). Required for anything a hardware button might fire twice. Keys are per principal. The request is its method, path, query and body (an upload by its bytes); the same key on another request is a `422`, and a repeat while the first is still being answered is a `409`. A streamed upload (`POST /media`) ignores the key: its body can't be compared before it is read. Answers that hold a secret (a session, a new token, an overlay's new key) are never kept for replay. |
| Unknown fields | A write takes the fields its resource has, and a field of a fixed shape (a template reference: `id`, `version`; lineup slots; cue actions, sequence steps, recipes) the fields of that shape; any other is refused (`422`, `unknown-field`), never silently dropped (07 §7.11). Free-form values (settings, checked against the template's schema; event data; state values) are not field-checked. |

## 3.2 Errors

RFC 9457 problem details, `application/problem+json`:

```json
{
  "type": "https://skp.dev/errors/quota-exhausted",
  "title": "YouTube quota exhausted",
  "status": 429,
  "detail": "Daily quota resets at midnight Pacific time. Chat will resume then.",
  "instance": "/api/v1/connections/con_7f3a/test"
}
```

`detail` **MUST** say what happened and what to do — it is shown to operators verbatim.
Stack traces **MUST NOT** appear in responses.

Statuses, besides those of sign-in (`401`, `403`), `If-Match` (`412`, `428`) and rate limits
(`429`):
- `409`: a conflict with what is there (in use, busy, exists, version exists, a confirmation
  needed).
- `413`: a body over its limit. `408`: a body too slow to arrive.
- `422`: anything else about the request.
- `500`: the platform failed (it is logged).
- `502` / `504`: a download failed upstream.
- `503`: the platform is shutting down or read-only, or a service it downloads from is
  rate-limiting it.

Settings that don't fit carry `problems: [{ path, message }]`; an upgrade refusal carries
`plan`; a package lint carries `findings`. A problem the operator fixes somewhere else carries
`fix`: `"connect-github"` (a private GitHub repository, or a token that can't read it: Settings →
Integrations → GitHub, 04 §4.13).

## 3.3 Authentication modes

| Mode | Used by | How |
|---|---|---|
| Session | Admin UI | HttpOnly cookie + CSRF header (07 §7.3) |
| API token | External apps, bots, Stream Deck | `Authorization: Bearer skp_pat_…`, scoped (07 §7.5) |
| Overlay key | OBS browser sources | `?key=` on `/o/*` only; read-only, one overlay (07 §7.6) |
| Webhook signature | Inbound service events | Per-service verification (07 §7.9) |

Session cookies **MUST NOT** authorize `/o/*`, and overlay keys **MUST NOT** authorize
`/api/*`.

### Token scopes
`overlays:read`, `overlays:write`, `overlays:control` (take scenes, fire actions),
`templates:read`, `templates:write`, `connections:read`, `connections:write`,
`timeline:read`, `timeline:write`, `events:read` (SSE), `events:publish`, `state:write`,
`media:write`, `audit:read`, `users:admin`, `system:admin`.

The command line on the platform's own machine signs in with a **local token** (`skp_cli_…`)
that the platform writes at each start to its config directory, readable by its own user only.
It acts as the owner and is accepted only from a loopback address, never through a proxy
(07 §7.8). Its changes are recorded as `cli:<user>` (07 §7.12).

## 3.4 Resources

### Auth & users
| Method · Path | Purpose |
|---|---|
| `GET /setup` · `POST /setup` | First-run: create the owner (07 §7.2). Disabled once an owner exists. |
| `POST /auth/login` · `POST /auth/logout` | Session start/end |
| `GET /auth/session` | Current user, role, CSRF token |
| `GET /auth/sessions` · `DELETE /auth/sessions/{id}` | Your active sessions, newest first (device, IP, last seen), and revoking one |
| `POST /auth/password` | `{ current, password }`: ends your other sessions |
| `POST /auth/totp/enroll` · `POST /auth/totp/verify` · `DELETE /auth/totp` | Two-factor |
| `PUT /auth/preferences` | Your admin UI look (08 §8.6): `{ theme: system\|light\|dark, accent: "#rrggbb"\|null, density: comfortable\|compact }`, any of them; in `GET /auth/session`'s `user.preferences` |
| `GET/POST /users` · `PATCH/DELETE /users/{id}` | Accounts and roles (users have an ETag: a session sends `If-Match`). The owner's own password and two-factor change only with the current password, above, or from the command line (07 §7.3) |
| `GET/POST /tokens` · `DELETE /tokens/{id}` | API tokens (secret shown once) |

### Templates
| Method · Path | Purpose |
|---|---|
| `GET /templates` | Installed templates (filter `?category=`) |
| `POST /templates` | Install: the `.skp` package as the raw body (`application/octet-stream`, its file name in `X-Skp-Filename` if you like), or JSON `{ "url": "…" }`: an https URL, `owner/name[@tag]`, or a GitHub release file's download link (read through the API with the GitHub token, so a private repository's too) |
| `GET /templates/{id}` | Manifest, versions, preview images |
| `GET /templates/{id}/versions` | Installed versions, newest first (a list: `{ items, next }`) |
| `DELETE /templates/{id}` | Uninstall every installed version, or one with `?version=` (refused while an overlay pins it; templates that ship with the platform can't be uninstalled) |
| `POST /templates/validate` | Lint a package without installing (04 §4.11) |
| `GET /templates/{id}/versions/{version}/previews/{path}` | A preview image: its path inside `previews/` (subfolders allowed), each part URL-encoded, as `GET /templates/{id}` lists it |
| `GET/POST /templates/sources` · `DELETE /templates/sources/{ref}` · `POST /templates/sources/check` | Followed repositories and URLs (04 §4.13); following takes `{ source, autoUpgrade?, template?, tagPrefix? }` |

### Integrations: GitHub (04 §4.13, 07 §7.7)
| Method · Path | Purpose |
|---|---|
| `GET /integrations/github` | Which token GitHub requests use (`using`: `saved`, `env` or `none`), whose (`saved: { login, method, scopes?, savedAt, savedBy }`), the device flow's client id and its state; never the token (`templates:write`) |
| `PUT /integrations/github/token` · `DELETE /integrations/github/token` | `{ token }`: checked with GitHub (`422 bad-token` if refused), then saved encrypted; or forgotten (Disconnect) (`system:admin`) |
| `PUT /integrations/github/app` | `{ clientId }` (or `null`): the OAuth app for signing in with GitHub (`system:admin`) |
| `POST /integrations/github/device` · `GET` · `DELETE` | Sign in with GitHub (the device flow): `{ status, userCode, verificationUri, expiresAt, intervalS }`, then `connected` (with `login`), `denied`, `expired` or `failed`; `DELETE` cancels (`system:admin`) |
| `GET /integrations/github/repos/{owner}/{name}/releases` | Whether the platform can read a repository (`private`, `using`, `login`) and its newest releases, newest first, with their `.skp`/`.zip` files (`templates:write`) |

### Overlays
| Method · Path | Purpose |
|---|---|
| `GET/POST /overlays` | List · create from a template (`connections`: `"all"`, the default, or connection ids, each whole or one of its profiles: `"<connection id>/<profile id>"`, 01 §1.3) |
| `GET/PATCH/DELETE /overlays/{id}` | Read · update settings, slug, `connections`, `role` (its role in OBS, `[a-z0-9-]` ≤ 54, `null` clears: 06 §6.11), `followObs` (outside a show, as a show's below, its template's scenes; it carries `sceneByObs` when OBS took its scene) and `keyRequired` (every field is checked before any is saved; `keyRequired: false` needs `system:admin`, the owner's; `connections` name connections that exist, and a `"<connection>/<profile>"` a profile that connection follows now, as its own feed (`422` otherwise; one the overlay already has is kept, its profile deleted or not)) · delete (the overlay also leaves its show). An overlay shows its `connections` and `bound`: what feeds it now, `[{ id, name, connector, status }]` per connection and `{ id, connection, profile, name ("Relay · DPRTMNT"), connector, status, missing? }` per profile of one (`missing`: the connection doesn't follow it now), and its `stream` (below) |
| `POST /overlays/{id}/upgrade` | Move to a newer installed version of the same template (settings migrated, 04 §4.10): `dryRun` returns the plan; a major version, or one that drops anything the overlay uses, needs `confirm`; an installed package's `migrate.js` runs only with `runMigrate`. `dryRun`, `confirm` and `runMigrate` are `true` or `false`; anything else is a `422` |
| `POST /overlays/{id}/revert` | Back to the version and settings the overlay had before its last upgrade (04 §4.10) |
| `POST /overlays/{id}/key/rotate` | New overlay key — **breaks the OBS URL** and ends streams opened with the old key; UI must confirm; never replayed for an `Idempotency-Key` (its answer holds the key) |
| `GET /overlays/{id}/url` | Production URL(s) per canvas |
| `PUT /overlays/{id}/scene` | `{ "scene": "brb", "transition": "fade" }` |
| `POST /overlays/{id}/actions/{name}` | Fire a template action (04 §4.6) |
| `POST /overlays/{id}/simulate` | Inject sample events into this overlay only (08 §8.5): `kind` and that kind's options (`name`, `text`, `roles`, `months`, `count`, `viewers`, `bits`, `title`, `artist`, `value`, `url`, `mediaId`); any other field is refused |
| `GET /overlays/{id}/alerts` · `POST /overlays/{id}/alerts/pause` · `/resume` · `/skip` · `/replay` | Alert queue of an overlay outside a show (05 §5.5) |

### Shows & timeline
| Method · Path | Purpose |
|---|---|
| `GET/POST /shows` · `GET/PATCH/DELETE /shows/{id}` | Shows and their member overlays. A show's ETag (`rev`) moves when what `PATCH` changes does, not with live control (a scene, who's on, REC), so an edit made mid-show isn't refused at every act change; `stateRev` moves with every change. `live` is true while REC runs; whether the show is on air on a platform is its `stream` (below). `followObs` (09 §9.7): `{ enabled, canvas: "landscape" \| "vertical", source?, map: [{ obsScene (≤ 200), obsSceneUuid?, scene }] (≤ 50), otherwise? }`, its scenes the members' (`422 unknown-scene` otherwise), unknown fields refused, `null` removes it; turned on without `source` while several feeds report OBS: `422 pick-obs`. `sceneByObs: { at, obsScene, canvas, source }`: the scene on now was taken by OBS |
| `PUT /shows/{id}/scene` | Take a scene on every member overlay |
| `POST /shows/{id}/triggers/{name}` | One-shot trigger to all members |
| `GET /alerts` · `POST /alerts/pause` · `/resume` · `/skip` · `/replay` | The alert queues (05 §5.5): one per show, or per overlay outside a show, each named by `queue` (the show's or the overlay's id). `GET` lists what is on screen and what waits; pause and resume apply to every queue; skip and replay take `{ queue }` (skip without it: every queue) |
| `GET/POST /shows/{id}/cues` · `PATCH/DELETE /shows/{id}/cues/{cueId}` | Timeline. A title card's or now-playing's act is `args.name` (`args.b2b` with it): text ≤ 80, trimmed, empty for whoever is on (09 §9.3) |
| `POST /shows/{id}/cues/{cueId}/fire` · `/skip` · `/rearm` | Operator overrides |
| `POST /shows/{id}/cues/rearm` | Re-arm all (09 §9.4): every cue still to come that was skipped or fired early, armed again; a command like the other overrides (`overlays:control`, no `If-Match`, an empty body), recorded once; answers `{ items }`, the cues it re-armed, each with its `rev` |
| `POST /shows/{id}/cues/build` | Regenerate cues from the lineup (09 §9.5) |
| `GET/POST /shows/{id}/plans` · `GET/PUT/DELETE /shows/{id}/plans/{planId}` | Pre-planned future dates (09 §9.6). `PUT` replaces a plan not yet applied, whole (`If-Match`): what it carries is what is sent; `409 applied` once applied, `409 plan-exists` for another plan's date; `422 too-large` for a lineup the show couldn't send to its overlays, as `PATCH /shows/{id}` |
| `POST /shows/{id}/plans/{planId}/apply` | The plan becomes the show now, before its day (`timeline:write`, a command); `409 live` while the show is live, `409 applied` once applied; `422` (with why) when the show can't take it, and the plan stays as it was |
| `GET /acts` | The names a lineup is offered (09 §9.1): every act of the shows' lineups and plans, B2B partners too, `{ name, date, logo? }` (its latest night, the latest logo it had), latest night first, a list (`timeline:read`) |

**Stream status.** A show and an overlay carry `stream`, worked out on each read (it never moves
the ETag): `{ connections: [{ id, name, connector, status, detail? }], onAir?, platforms: [{
platform, live?, title?, startedAt?, viewers?, stale? }], profiles?: [{ connection, profile, name,
color?, status, startedAt? }], viewers?, obs?: [{ source, name, landscape?, vertical?, streaming?,
recording?, stale?, seen?, scenes? }] }`. `obs` is what OBS shows, per feed of those connections that
reports it (`source`: `"<connection>"` or `"<connection>/<profile>"`, as `followObs.source` takes
it): each canvas's program scene `{ scene, sceneUuid?, since? }`, whether it streams and records,
`seen: { landscape, vertical }`, the OBS scenes it has shown since the platform started,
newest first, and `scenes: { landscape?, vertical? }`, each canvas's every scene in OBS's order
when OBS says them (`obs.scenes.<canvas>`, 02 §2.5): what Follow OBS offers to map. `profiles` are the CTD Relay profiles the
connected ones follow (06 §6.11; `status` `offline | starting | live | stopping`, or `missing` for
one bound by name that its connection doesn't follow any more), each on its own: all of a
connection's when it is bound whole, the ones named when bound by profile, whose `platforms` and
`viewers` are then that profile's only. `connections` are the
turned-on connections that feed it (an overlay's bindings; a show's members' together, and one
member bound to `"all"` makes the show's `"all"`), by name and status only, so whoever reads
overlays or shows sees it without `connections:read`. `platforms` come from those connections'
`stream.<platform>.*` and `viewers.<platform>` state, each value chosen as an overlay bound the
same way sees it (fresh over held, direct over relay, 01 §1.3), the core's own values left out.
`onAir` is `true` while any platform or profile is live, `false` when they said and none is, and absent
when nothing says (*Unknown*, never *Offline*); `viewers` adds up the known counts and is absent
when none is known, never `0`.

### Connections
Seeing connections takes `connections:read`, changing them `connections:write` (owners and
admins, 07 §7.5). Secrets are written, never read: a connection shows `secretFields`, the names
of its secret settings that hold a value.

| Method · Path | Purpose |
|---|---|
| `GET /connectors` · `GET /connectors/{id}` | Available connectors: capabilities, settings (a JSON Schema; `writeOnly` fields are secrets), sign-in kind, scopes and why, the redirect URI to register, whether a public URL is needed, the setup guide with the warnings that apply here, actions (a list: `{ items, next }`) |
| `GET/POST /connections` | Connections, by name, with their health · add one: `{ connector, name?, enabled?, config?, secrets? }` (`201`) |
| `GET/PATCH/DELETE /connections/{id}` | A connection: settings, `secretFields`, account, health, the values it sets now (`state`, `stale`; and its feeds', profile by profile: `feeds: [{ profile, state, stale? }]`), a sign-in in progress (`authorization`), the overlays it feeds, what it tells about itself (`info`: a CTD Relay connection's `profile`, or `everyProfile: true` and `profiles`, and `hub`, `choices`) · rename, turn on or off, change `config` (replaced) and `secrets` (`{ field: "new" }` sets, `null` clears, absent keeps), with an ETag · delete (answers `{ id, name, overlays }`: the overlays it fed). A changed client ID signs the account out |
| `POST /connections/{id}/authorize` | Start signing in → `{ "flow": "device", "userCode", "verificationUri", "verificationUriComplete"?, "expiresAt", "intervalS" }` or `{ "flow": "redirect", "url", "redirectUri", "expiresAt" }` or `{ "flow": "pairing", "code", "approveUrl"?, "expiresAt", "intervalS" }` (06 §6.4: approved at the service, polled by the platform); `422` for a connector without a sign-in. Never replayed for an `Idempotency-Key` |
| `POST /connections/{id}/authorize/complete` | Finish a redirect sign-in with the address the service sent the operator to (`{ "url" }`) or `{ "code", "state" }`, when the callback landed in another browser (06 §6.4); only whoever started it (`403`), once (`410`) |
| `DELETE /connections/{id}/authorize` | Cancel a sign-in in progress; with none, sign the account out (its tokens forgotten, revoked where the service allows) |
| `GET /oauth/callback/{connector}` | OAuth redirect target (outside `/api/v1`, not in its OpenAPI document) |
| `POST /connections/{id}/test` | Live check → `{ ok, health, checks: [{ name, ok, detail? }] }`; one every 5 s per connection (`429`) |
| `POST /connections/{id}/actions/{name}` | Connector actions (`obs.setScene`): `{ args }`; `overlays:control`, or `connections:write` where the action says; `409` not connected, `502` it failed, `504` no answer in 10 s |

### Live data
| Method · Path | Purpose |
|---|---|
| `GET /events` | SSE of everything the token may read (`?types=chat.*,alert.*`). It ends when whoever opened it may no longer read (signed out, session ended or expired, token revoked or expired, user removed), checked at each heartbeat and before events at most once a second. A client 1000 events behind is cut off and reconnects |
| `POST /events` | Publish a custom event (scope `events:publish`, §2.7) |
| `GET /state` · `GET /state/{key}` | Current state, installation-wide: each key's value from every connection by the rule of 02 §2.5.0, `viewers.total` summed over platforms |
| `PUT /state/{key}` | Set a `custom.*` / `x-*` key (scope `state:write`) |

### Media, webhooks, system
| Method · Path | Purpose |
|---|---|
| `POST /media` · `GET /media` · `DELETE /media/{id}` | Uploads (raw body, `?name=`), identified by content and transcoded when ffmpeg is present (10 §10.2). A delete is refused (`409`, `in-use`) while anything points to the file: an overlay's settings (or the version kept for revert), a show's lineup (an act's logo), a cue that will still play it (armed, or set at a time of the show, which is armed again each night, or a sequence that fired with a `media.play` step not yet done and not past the restart grace of 09 §9.4), or a plan not yet activated (its lineup or overlay settings). `usedBy` names them: overlay slugs, and phrases such as "lineup of show Night", "cue at 23:00 in show Night", "plan for 2026-10-24 of show Night" |
| `GET/POST /webhooks` · `DELETE /webhooks/{id}` · `GET /webhooks/{id}/deliveries` | Outbound webhooks (06 §6.10) |
| `POST /hooks/{connector}[/{connection}]` · `POST /hooks/custom/{id}` | Inbound webhooks (outside `/api/v1`): the raw body, at most 256 KiB, checked by the connector (07 §7.9); without a connection id, the one connection of that connector that is on |
| `GET /system/health` · `GET /system/info` | Status, version, capabilities (e.g. `ffmpeg: false`). Health lists every connection: `[{ id, name, connector, status, detail?, since, viewers?, stale?, profile?, profiles?: [{ id, name, color?, status, startedAt? }], everyProfile? }]` (`profiles`: the CTD Relay profiles it follows; `everyProfile`: each is a feed of its own, what "Fed by" offers one by one) for anyone signed in (the Live console's connection strip, 08 §8.4: operators don't hold `connections:read`), and is `degraded` while one turned on isn't connected |
| `GET /system/settings` · `PUT /system/settings` | The installation's display name and logo (an uploaded image's `/media/…` URL) for the admin UI (08 §8.6); setting them needs `system:admin` |
| `GET /openapi.json` | This API, described (OpenAPI 3.1, each operation's scope as `x-skp-scope`); no sign-in needed |
| `POST /system/backup` · `POST /system/restore` | Export/import (10 §10.7) |
| `GET /system/audit` | Audit log, newest first (`audit:read`: owner and admin) |

### Overlay-facing
| Path | Overlay key | Purpose |
|---|---|---|
| `GET /o/{slug}` | required | The overlay page |
| `GET /o/~p.{templateId}@{version}` | sign-in (`templates:read`) | A template's preview with sample data before any overlay uses it (08 §8.2); takes `?canvas=` and `?scene=`, has no live data |
| `GET /o/{slug}/snapshot` · `/stream` · `/poll` | required | Live data (01 §1.5) |
| `POST /o/{slug}/log` | required | `SK.log` and runtime errors for the template log: `{ "entries": [{ "level", "msg", "context"? }] }`, at most 20 per request and 64 KiB, 30 entries a minute per overlay; answers `204` |
| `GET /o/{slug}/t/{build}/*` | no | The pinned template version's files (04 §4.5) |
| `GET /media/{fileId}/{name}` | no | Uploaded media that settings, show lineups or `media.play` point to (07 §7.6); answers byte ranges, for video seeking |
| `GET /sdk/v1/sk.js` · `/sdk/v1/mock.js` | no | The runtime SDK, and its sample data for `?mock=1` (08 §8.5) |

Without its key, a known slug and an unknown one answer alike: `401`, problem type
`https://skp.dev/errors/overlay-key`.

These responses send `Referrer-Policy: no-referrer`. Template files and media never change at a
given URL, so they send `Cache-Control: public, max-age=31536000, immutable`. Everything else
sends `Cache-Control: no-store`.

## 3.5 Rate limits

Every authenticated response carries `RateLimit-Limit`, `RateLimit-Remaining` and
`RateLimit-Reset`. Defaults: 600 requests/min per token (a user's sessions count together; per
address when nobody is signed in, an IPv6 address by its /64); 10 login attempts/15 min per IP
and per account; `POST /events` 60/s per token, a budget of its own that doesn't count toward the
600/min, whose `RateLimit-*` headers describe that second. Over limit returns `429` with
`Retry-After`.

## 3.6 Example: a Stream Deck button

```http
PUT /api/v1/shows/show_sat/scene HTTP/1.1
Authorization: Bearer skp_pat_6vZ…
Idempotency-Key: 2b7c1d4e-brb-press-0412
Content-Type: application/json

{ "scene": "brb", "transition": "fade" }
```
```http
HTTP/1.1 200 OK
ETag: "show_sat-r48"

{ "id": "show_sat", "scene": "brb", "overlays": ["ovl_h", "ovl_v"] }
```
