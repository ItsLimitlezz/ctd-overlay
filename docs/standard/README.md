# Stream Kit Platform Standard (SKP) — v1.0 draft

**Status:** Draft · **Date:** 2026-10-10 · **Identifier:** `skp/1` · [Changes](#changes)

A specification for a self-hosted live-stream overlay platform: a server that connects to
streaming platforms and OBS, normalizes everything into one data model, and serves styled
overlays to OBS browser sources. It is written so that an independent implementation — and
independent template authors — can build to it without reading anyone's source code.

It generalizes the D/PRTMNT Stream Kit (v0), which ran a live club night on this design. Every
rule marked as a **hard rule** in [11-hard-rules.md](11-hard-rules.md) was learned on air.

---

## The one principle

> **Templates style. The platform connects.**

A template never talks to Twitch, Kick, YouTube, Spotify or OBS. It never holds a token. It
declares what data it wants and where things go on screen; the platform does the connecting,
authenticating, normalizing, queueing, retrying and moderating. A chat template receives a
merged, already-moderated stream of chat messages from every platform in one shape — and its
whole job is to make them look good.

Everything else in this standard follows from that sentence.

---

## Documents

| # | Document | Covers |
|---|---|---|
| 01 | [Architecture](01-architecture.md) | Layers, vocabulary, the data flow, transport |
| 02 | [Data model](02-data-model.md) | Events, state, every normalized payload |
| 03 | [API](03-api.md) | REST surface, auth modes, errors, streaming, versioning |
| 04 | [Templates](04-templates.md) | Package format, manifest, runtime SDK, sandboxing |
| 05 | [Animation](05-animation.md) | Lifecycle, sequencing, alert queues, sync, performance |
| 06 | [Integrations](06-integrations.md) | Connector contract; Twitch, Kick, YouTube, Spotify, OBS; other apps |
| 07 | [Security](07-security.md) | Login, sessions, tokens, secrets at rest, exposure modes |
| 08 | [Admin UI](08-admin-ui.md) | Navigation, template gallery, previews, theming |
| 09 | [Timeline](09-timeline.md) | Shows, scheduled cues, the time rules |
| 10 | [Packaging](10-packaging.md) | TrueNAS, Docker, macOS, Linux; config; updates |
| 11 | [Hard rules](11-hard-rules.md) | Non-negotiables learned in production; migrating from v0 |
| — | [schemas/](schemas/) | JSON Schemas for manifests, events and payloads |

---

## Conformance language

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHOULD**, **SHOULD NOT**, **MAY** and
**OPTIONAL** are used as described in RFC 2119 and RFC 8174 when they appear in bold capitals.

Three conformance targets:

| Target | Who | Must satisfy |
|---|---|---|
| **Platform** | The server application | All documents |
| **Template** | A template package | 02 (as a consumer), 04, 05, 11 |
| **Integration client** | Any external app using the API | 02, 03, 06 §6.10, 07 §7.5 |

---

## Decisions this standard makes

These are settled. An implementation that departs from one is not SKP-conformant.

1. **Templates never connect.** No template-originated network requests to third parties for
   data. Enforced with a Content Security Policy, not just convention. *(04)*
2. **Overlay URLs are permanent.** Nothing configurable lives in an overlay URL — not the
   theme, not settings, not the template version. Changing any of it re-renders the sources
   already in OBS. Only an explicit key rotation changes a URL. *(01, 11)*
3. **HTTP to our own clients; no WebSocket.** Overlays and the admin UI receive live data over
   Server-Sent Events with a polling fallback — plain HTTP that survives OBS's embedded
   browser, reverse proxies and flaky Wi-Fi. The platform *does* open WebSocket connections
   outward where a third party requires it (obs-websocket, Twitch EventSub). *(01)*
4. **The server owns the show.** Scheduled cues fire on the server's clock. Closing every
   browser never stops a broadcast. *(09)*
5. **Bring your own platform credentials.** Each installation registers its own Twitch, Kick,
   Google and Spotify developer apps. A self-hosted app cannot share one client ID: Spotify
   caps development-mode apps at a handful of users and gates extended access behind
   organization review, and every platform requires redirect URIs registered to *your* host.
   The admin UI walks the user through it. *(06)*
6. **Never show a wrong number.** Missing or failed data hides; only real data renders. *(02)*
7. **Single tenant, multiple users.** One installation serves one streamer or crew, with
   role-based accounts. Multi-tenant hosting is out of scope for v1.
8. **No runtime dependencies in the core.** The core runs on its runtime's standard library
   alone: no npm packages at runtime, native or not. Development tools (bundler, test runner,
   linters) are fine. So it ships as a single executable on macOS and Linux and a small
   multi-arch image for TrueNAS. Media transcoding uses an external ffmpeg when present and is
   reported as unavailable when not. *(10)*

---

## Non-goals for v1

- A drag-and-drop canvas editor. Templates position their own elements and expose layout as
  settings. Composition happens in OBS by stacking overlay sources.
- Streaming or encoding video. OBS does that.
- Sending chat messages or moderating on platforms. Read-only for v1; the connector contract
  reserves capabilities for it.
- Hosted multi-tenant SaaS.

---

## Glossary

| Term | Meaning |
|---|---|
| **Platform** | The server application this standard specifies. |
| **Connector** | Platform code that integrates one service (Twitch, OBS…). |
| **Connection** | One authorized account on a service, created by a user through a connector. |
| **Template** | An installable design package: markup, styles, assets, manifest. |
| **Overlay** | A configured instance of a template, with its own settings and its own permanent URL. |
| **Scene** | A named state of an overlay (`starting`, `program`, `brb`…). |
| **Show** | A group of overlays that share scene state and a timeline — e.g. a horizontal and a vertical feed driven together. |
| **Timeline** | A show's list of scheduled cues. |
| **Cue** | An action scheduled for an absolute time. |
| **Event** | Something that happened (a chat message, a follow). Ephemeral. |
| **State** | A current value (viewer count, now playing, active scene). Snapshot-able. |
| **Bus** | The in-process router that carries events and state from connectors to overlays. |
| **Overlay key** | A per-overlay, read-only capability token that lets OBS load an overlay without logging in. |

---

## Changes

**2026-10-12.** From making it safe to expose (plan step 12):

1. `SKP_HOSTS`: more names the platform answers to in `lan`/`public` mode. In `public` mode,
   the local network may still use plain HTTP. *(07 §7.8, 10 §10.5)*
2. Overlay keys are needed by default in every mode; `GET /overlays/{id}/url`,
   `POST /overlays/{id}/key/rotate` and `PATCH /overlays/{id} { keyRequired }` (local and lan
   only). *(03 §3.4, 07 §7.6)*
3. `skp key rotate` keeps the old key as `master.key.<id>.retired`. *(07 §7.7)*

**2026-10-12.** From building sign-in (plan step 11):

1. Overlay pages are served with `sandbox allow-scripts`: a template's script has an origin of
   its own and can't use the operator's session or the API. *(04 §4.8, 07 §7.1)*
2. A new scope, `audit:read` (owner and admin). The command line signs in on its own machine
   with a local token written to the config directory. *(03 §3.3, 07 §7.3)*
3. Login protection counts a streak of failures, so its delay can reach the 15-minute cap;
   setup codes have the same protection. A TOTP code works once. *(07 §7.3, §7.4)*
4. `GET/DELETE /auth/sessions`, `POST /auth/password`; the audit log also records overlay
   upgrades, cue overrides, media changes and template updates, and `SKP_AUDIT_DAYS` sets how
   long it keeps them. *(03 §3.4, 07 §7.12, 10 §10.5)*

**2026-10-12.** From building the timeline (plan step 10):

1. A cue may be set at a time of the show (`"01:00"`). It belongs to the show's night and
   follows the date; a new night arms it only for a time still to come, and going back to a
   night gives back what happened. A fired cue that did nothing says why in `error`; a cue time
   in a clock change is flagged. `show.slot` may name the act. *(09 §9.3, cue.schema.json)*
2. Nothing that happened fires again by itself: a regeneration never makes a cue whose time has
   passed, and keeps what happened as history. Generated cues are known by slot time and act
   (now-playing by minutes into the set). A cue the operator edited stays theirs; one they
   deleted stays deleted. What fell due during downtime waits for pages to reconnect. *(09 §9.4)*
3. Only what members offer is generated. A timed scene played by a cue plays only from program,
   never off a BRB (it does when fired by hand). The headliner's intro replaces their title
   card. The recipe is kept with the show, and `null` stops it. *(09 §9.5)*
4. A sequence's steps survive a restart, don't stop at a failing step, and stop when the cue is
   skipped or deleted. *(09 §9.3)*
5. A plan carries `lineup`, `goLive`, `dayBoundary` and `overlaySettings` (applied to the show's
   members only). Its day follows the show's zone and boundary as they are when it comes. It waits
   while its show is live; after downtime, only the latest plan whose day has begun is the show.
   *(09 §9.6)*

**2026-10-12.** From building shows (plan step 9):

1. Show state is each member overlay's own. REC is anchored by the server at the first take of
   the live scene (or at go-live under `auto`, caught up after downtime, within 12 hours) and
   cleared by `starting`. A show is live while REC runs, for 12 hours at most, and what must not
   happen on air waits for it. *(09 §9.1)*
2. A timed scene's return is stored with the show: a restart mid-scene still returns, and any
   other take cancels it. *(09 §9.4)*
3. Automatic template upgrades wait while the overlay's show is live. *(04 §4.13)*
4. Scenes are taken by id or core, and each member gets the name its template knows. Who's on
   stays on the same act through a lineup edit. A lineup must fit an envelope (24 KiB as
   published; a logo URL at most 500 characters). *(09 §9.1)*

**2026-10-12.** Template sources (plan step 8b, at the operator's request):

1. New §4.13: a template can be followed from a GitHub repository's releases or an https URL;
   new releases install by themselves (https only, package limits, validated), a source keeps to
   one template id, and overlays move automatically only when §4.10 would need no confirmation.
   *(04 §4.13, 10 §10.5: `SKP_TEMPLATE_CHECK_MINUTES`, `SKP_GITHUB_TOKEN`)*
2. Version-control directories (`.git/`, `.svn/`, `.hg/`) are ignored in a package, like desktop
   clutter, so a template can be packed from its repository. *(04 §4.1)*
3. A template has one source: a first release whose id ships with the platform, comes from
   another source or is installed otherwise is refused unless the operator names it; only a
   version new to the source moves overlays (a revert stands), never past a `migrate.js`; a
   release that failed for good isn't downloaded again; downloads stay off private addresses
   unless the owner allows them (`SKP_ALLOW_PRIVATE_DOWNLOADS`). *(04 §4.13, 07 §7.11, 10 §10.5)*

**2026-10-12.** From porting the TAKEOVER template (plan step 8):

1. A show publishes `show.date` and `show.goLiveAt` beside `show.lineup`, so a countdown never
   re-reads wall-clock strings; a lineup slot may carry `logo` (uploaded media or an https URL).
   *(02 §2.5, 09 §9.1, show.schema.json)*
2. Simulated state is held on the targeted overlay only, ends by itself (60 s here) or at
   "Reset" and then gives the real values back, and never reaches settings bound to the key;
   the answer says whether the overlay consumes what was sent. *(08 §8.5)*
3. `media.stop` may leave out `url` (stop whatever plays). *(02 §2.6)*

**2026-10-12.** From building media (plan step 7):

1. What is accepted is decided by content: images (PNG, JPEG, GIF, WebP, AVIF, HEIC), video
   (MP4, MOV, MKV, AVI, WebM), audio (MP3, M4A, Ogg, FLAC, WAV) and fonts (WOFF2, WOFF, TTF,
   OTF). SVG is not: it is a document that can carry script. *(07 §7.11)*
2. With ffmpeg, phone video becomes H.264/AAC MP4 (rotation baked in, at most 1920 px, no
   metadata, HDR tone-mapped to SDR where the build can) and HEIC becomes JPEG, which needs
   ffmpeg 7.1 or later; WebM is kept, for stingers' alpha. Without it, video is kept as
   uploaded with a note and HEIC is refused. A failed conversion keeps the video as uploaded
   rather than losing it. ffmpeg runs below normal priority. *(10 §10.2)*
3. Media lives at `<data>/media/<fileId>/<name>`; the fileId is 128 random bits; the route
   answers byte ranges; a file an overlay's settings point to can't be deleted.
   *(10 §10.6, 03 §3.4)*

**2026-10-11.** From building template packages (plan step 6):

1. Package format: the 100 MiB limit applies to the archive and to its files uncompressed;
   store or deflate only; a 100:1 expansion cap above 1 MiB; portable paths only; `template.json`
   at the root or inside one top folder; desktop clutter ignored. *(04 §4.1)*
2. `id` at most 100 characters, `version` strict SemVer (no leading zeros) at most 64; a core
   scene mapped once; `then` names a scene id or core; `cut` and `fade` reserved as transition
   ids; ids of templates shipped with the platform reserved. *(04 §4.2, template.schema.json)*
3. The settings subset is spelled out (keywords, one type per field, identifier-like names,
   groups at most 3 deep without defaults, formats, pattern limits); a template without a
   settings schema has no settings; bound keys must be declared; stored values are the
   operator's, `SK.settings` the resolution. `show.headliner` is registered for the §4.3
   example's binding. *(04 §4.3, 02 §2.5)*
4. `<build>` hashes the package's files (path and content digest each), the same bundled or
   installed. Template files are served only as listed, with a sandboxing CSP.
   *(04 §4.5, §4.8, 07 §7.10)*
5. Installed versions never change; pinned versions that ship with the platform are kept; an
   upgrade goes to a newer version, with a dry run, a confirmation across a major version (0.y
   minors and prereleases included), and an installed package's `migrate.js` only on the
   operator's say-so; `migrate.js` is a classic script. *(04 §4.10, 03 §3.4)*
6. Validation findings are `{ level, code, path, message }`, with the added checks listed.
   *(04 §4.11)*
7. `tpl_` IDs dropped (templates use their manifest id); `DELETE /templates/{id}?version=`.
   *(03 §3.1, §3.4)*
8. alert.schema.json: an `amount` without `unit` no longer requires `currency`.
9. Installed templates' layout on disk, and one process per data directory. *(10 §10.6)*
10. From the review of the above: a settings `pattern` runs with a deadline and a value it
    can't be checked against in time is refused (bad shapes are a warning, no longer an error,
    and need no `maxLength`); keyword values must make sense; no default on the settings object
    and no binding on a group; `uri` and media values are `https` (or uploaded media); saved
    settings at most 24 KiB and defaults at most 6 KiB of UTF-8. *(04 §4.3)*
11. An upgrade's plan lists what `migrate.js` changed, a dry run refuses what the real run
    would, a version that drops anything the overlay uses needs a confirmation like a major
    one, and `POST /overlays/{id}/revert` undoes an upgrade; `migrate.js` may name its default
    export and returns at most 64 KiB. *(04 §4.10, 03 §3.4)*
12. Manifest lists are capped; a scene id may not be another scene's core; an installed version
    whose files changed is validated again, and a template that can't be used takes only its
    own overlays off air. *(04 §4.11, template.schema.json)*
13. A `<build>` is a content hash, not a secret: template files are public. Its exact input is
    spelled out (line format, UTF-8 byte order), so implementations agree. *(04 §4.5, 07 §7.6)*
14. JSON Schema formats: `time` and `date-time` are RFC 3339 (seconds and offset required);
    `$ref` is a JSON pointer. *(schemas)*

**2026-10-11.** From building the runtime SDK (plan step 5):

1. `canvas` selects a canvas by its `id` or by `<w>x<h>`. *(01 §1.4)*
2. `POST /o/{slug}/log` carries `SK.log` and runtime errors to the template log; it is the one
   overlay endpoint that isn't a `GET`, and it answers with `Access-Control-Allow-Origin: *`
   too. `/sdk/v1/mock.js` is listed. *(03 §3.4, 07 §7.10)*
3. A take publishes `show.scene.changed` before the `show.scene` state, and takes have no
   `startAt`. *(02 §2.6)*
4. Published lineup slots carry `startAt`, the instant their `time` resolves to. *(09 §9.1)*

**2026-10-10.** Fixes from the first implementation review:

1. Template files load from `/o/<slug>/t/<build>/` through a `<base>` the runtime inserts, with
   `<build>` taken from the package hash. Template files and media are served without the
   overlay key. *(03 §3.4, 04 §4.5, §4.8, 07 §7.6, H14)*
2. A live stream that hasn't opened within 5 s counts as failed, so an overlay stuck behind the
   browser's per-host connection limit falls back to polling. *(01 §1.5)*
3. Password hashing runs one call at a time, with scrypt's memory limit raised. *(07 §7.3,
   10 §10.2)*
4. The alert queue runs on the server, one per show, and gives each alert a display window, so
   every member overlay shows it together and the operator can pause, skip and replay it.
   *(01 §1.2, 02 §2.4, §2.6, 03 §3.4, 04 §4.2, §4.4, 05 §5.5, schemas)*
5. Lineup times that fall in a daylight-saving gap or overlap have a defined meaning, and are
   tested. *(09 §9.2, H19)*
6. Decision 8 is now "no runtime dependencies in the core". *(README, 06 §6.7, 07 §7.3)*
7. The admin UI must send `If-Match` on edits; token clients may omit it. *(03 §3.1, H16)*

**2026-10-09.** v1.0 draft.
