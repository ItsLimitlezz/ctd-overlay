# 03 · API

One API serves the admin UI, external apps, bots and hardware controllers. There is no private
admin API: anything the UI can do, an authorized client can do.

## 3.1 Conventions

| Topic | Rule |
|---|---|
| Base path | `/api/v1`. A breaking change ships as `/api/v2`; v1 stays served for at least one major release. |
| Format | JSON (`application/json; charset=utf-8`) for bodies and responses. |
| Description | The platform **MUST** serve an OpenAPI 3.1 document at `/api/v1/openapi.json`. |
| IDs | Opaque strings with a type prefix: `ovl_`, `tpl_`, `con_`, `usr_`, `cue_`, `show_`, `med_`, `whk_`. |
| Time | ISO 8601 UTC in resource bodies (`2026-08-29T05:00:00Z`); epoch ms only in live envelopes. |
| Names | `camelCase` fields; plural resource paths. |
| Pagination | Cursor based: `?limit=50&cursor=…` → `{ "items": [], "next": "…" }`. Max limit 200. |
| Concurrency | Mutable resources return `ETag`. Requests authenticated by session (the admin UI) **MUST** send `If-Match` on `PATCH` and `PUT`: without it the platform answers `428`, and with a stale tag `412`. Token-authenticated clients **SHOULD** send it and **MAY** omit it, accepting last-write-wins. Commands (taking a scene, firing actions, triggers and cue overrides, alert queue controls) take no `If-Match`. Two operators editing one overlay can't silently overwrite each other. |
| Idempotency | `POST` accepts `Idempotency-Key`; a repeat within 24 h returns the original result. Required for anything a hardware button might fire twice. |

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
`media:write`, `users:admin`, `system:admin`.

## 3.4 Resources

### Auth & users
| Method · Path | Purpose |
|---|---|
| `GET /setup` · `POST /setup` | First-run: create the owner (07 §7.2). Disabled once an owner exists. |
| `POST /auth/login` · `POST /auth/logout` | Session start/end |
| `GET /auth/session` | Current user, role, CSRF token |
| `POST /auth/totp/enroll` · `POST /auth/totp/verify` · `DELETE /auth/totp` | Two-factor |
| `GET/POST /users` · `PATCH/DELETE /users/{id}` | Accounts and roles |
| `GET/POST /tokens` · `DELETE /tokens/{id}` | API tokens (secret shown once) |

### Templates
| Method · Path | Purpose |
|---|---|
| `GET /templates` | Installed templates (filter `?category=`) |
| `POST /templates` | Install: upload `.skp` package (multipart) or `{ "url": "…" }` |
| `GET /templates/{id}` | Manifest, versions, preview images |
| `GET /templates/{id}/versions` | Installed versions |
| `DELETE /templates/{id}` | Uninstall (refused while an overlay pins it) |
| `POST /templates/validate` | Lint a package without installing (04 §4.11) |

### Overlays
| Method · Path | Purpose |
|---|---|
| `GET/POST /overlays` | List · create from a template |
| `GET/PATCH/DELETE /overlays/{id}` | Read · update settings/bindings/slug · delete |
| `POST /overlays/{id}/upgrade` | Move to a newer template version (settings migrated, 04 §4.10) |
| `POST /overlays/{id}/key/rotate` | New overlay key — **breaks the OBS URL**; UI must confirm |
| `GET /overlays/{id}/url` | Production URL(s) per canvas |
| `PUT /overlays/{id}/scene` | `{ "scene": "brb", "transition": "fade" }` |
| `POST /overlays/{id}/actions/{name}` | Fire a template action (04 §4.6) |
| `POST /overlays/{id}/simulate` | Inject sample events into this overlay only (08 §8.5) |
| `GET /overlays/{id}/alerts` · `POST /overlays/{id}/alerts/pause` · `/resume` · `/skip` · `/replay` | Alert queue of an overlay outside a show (05 §5.5) |

### Shows & timeline
| Method · Path | Purpose |
|---|---|
| `GET/POST /shows` · `GET/PATCH/DELETE /shows/{id}` | Shows and their member overlays |
| `PUT /shows/{id}/scene` | Take a scene on every member overlay |
| `POST /shows/{id}/triggers/{name}` | One-shot trigger to all members |
| `GET /shows/{id}/alerts` · `POST /shows/{id}/alerts/pause` · `/resume` · `/skip` · `/replay` | The show's alert queue (05 §5.5) |
| `GET/POST /shows/{id}/cues` · `PATCH/DELETE /shows/{id}/cues/{cueId}` | Timeline |
| `POST /shows/{id}/cues/{cueId}/fire` · `/skip` · `/rearm` | Operator overrides |
| `POST /shows/{id}/cues/build` | Regenerate cues from the lineup (09 §9.5) |
| `GET/POST /shows/{id}/plans` | Pre-planned future dates (09 §9.6) |

### Connections
| Method · Path | Purpose |
|---|---|
| `GET /connectors` | Available connectors, capabilities, required credentials |
| `GET/POST /connections` · `DELETE /connections/{id}` | Accounts |
| `POST /connections/{id}/authorize` | Start OAuth or device flow → `{ "url" }` or `{ "userCode", "verificationUri" }` |
| `GET /oauth/callback/{connector}` | OAuth redirect target (outside `/api/v1`, public) |
| `POST /connections/{id}/test` | Live check, returns health |
| `POST /connections/{id}/actions/{name}` | Connector actions (`obs.setScene`) |

### Live data
| Method · Path | Purpose |
|---|---|
| `GET /events` | SSE of everything the token may read (`?types=chat.*,alert.*`) |
| `POST /events` | Publish a custom event (scope `events:publish`, §2.7) |
| `GET /state` · `GET /state/{key}` | Current state |
| `PUT /state/{key}` | Set a `custom.*` / `x-*` key (scope `state:write`) |

### Media, webhooks, system
| Method · Path | Purpose |
|---|---|
| `POST /media` · `GET /media` · `DELETE /media/{id}` | Uploads; transcoded when ffmpeg is present |
| `GET/POST /webhooks` · `DELETE /webhooks/{id}` · `GET /webhooks/{id}/deliveries` | Outbound webhooks (06 §6.10) |
| `POST /hooks/{connector}` · `POST /hooks/custom/{id}` | Inbound webhooks (outside `/api/v1`) |
| `GET /system/health` · `GET /system/info` | Status, version, capabilities (e.g. `ffmpeg: false`) |
| `POST /system/backup` · `POST /system/restore` | Export/import (10 §10.7) |
| `GET /system/audit` | Audit log (owner/admin) |

### Overlay-facing
| Path | Overlay key | Purpose |
|---|---|---|
| `GET /o/{slug}` | required | The overlay page |
| `GET /o/{slug}/snapshot` · `/stream` · `/poll` | required | Live data (01 §1.5) |
| `POST /o/{slug}/log` | required | `SK.log` and runtime errors for the template log: `{ "entries": [{ "level", "msg", "context"? }] }`, at most 20 per request and 64 KiB, 30 entries a minute per overlay; answers `204` |
| `GET /o/{slug}/t/{build}/*` | no | The pinned template version's files (04 §4.5) |
| `GET /media/{fileId}/{name}` | no | Uploaded media that settings or `media.play` point to (07 §7.6) |
| `GET /sdk/v1/sk.js` · `/sdk/v1/mock.js` | no | The runtime SDK, and its sample data for `?mock=1` (08 §8.5) |

These responses send `Referrer-Policy: no-referrer`. Template files and media never change at a
given URL, so they send `Cache-Control: public, max-age=31536000, immutable`. Everything else
sends `Cache-Control: no-store`.

## 3.5 Rate limits

Every authenticated response carries `RateLimit-Limit`, `RateLimit-Remaining` and
`RateLimit-Reset`. Defaults: 600 requests/min per token; 10 login attempts/15 min per IP and per
account; `POST /events` 60/s per token. Over limit returns `429` with `Retry-After`.

## 3.6 Example: a Stream Deck button

```http
POST /api/v1/shows/show_sat/scene HTTP/1.1
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
