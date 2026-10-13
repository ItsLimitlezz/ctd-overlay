# Build plan

This repo is the platform that implements the [Stream Kit Platform Standard](standard/README.md)
(`skp/1`). The working prototype it replaces is v0, the D/PRTMNT Stream Kit
(`ItsLimitlezz/DPRTMNT-stream-Kit`), which still runs the Saturday show until this one passes a
rehearsal next to it.

**How to work it:** read `docs/standard/README.md`, the documents the step cites, and this file.
One PR per numbered step. Each PR builds and passes tests on Linux, macOS and Windows in CI, and
says in its description any decision the standard doesn't cover. Where it doesn't, pick the
option that keeps a live show running with nobody touching it.

## Ground rules

- Node.js 24 LTS, ES modules, plain JavaScript (like v0). No npm packages at runtime (decision 8);
  dev-only tools such as a bundler for the single executable are fine.
- Tests: `node --test` for units. Anything scheduled is also tested on a running server with the
  clock a few minutes ahead, including a daylight-saving night (H19).
- Until step 12 lands, the server binds to `127.0.0.1` only. Nothing before then is safe to
  expose.
- The SDK and bundled templates must run in OBS 30's browser (Chromium 103). No CSS nesting,
  `:has()` or container queries in them.

## What carries over from v0

| v0 | Goes to | Change on the way |
|---|---|---|
| Crash guards (`server.js` handler wrapper, `uncaughtException`, `crash.log`) | step 2 | Same idea, plus per-connector isolation (01 §1.7) |
| Viewer polling: Twitch/Kick client-credentials, 2-min stale hold, never `0` on error | step 17 | Becomes the `viewers` capability of each connector; credentials encrypted |
| Rundown scheduler: 1 s tick, 5-min grace, fired state kept across rebuilds | step 10 | Show timezone instead of container `TZ`, configurable day boundary, DST rule, atomic writes |
| `transcode()`: ffmpeg with an argument array, timeout, partial-file cleanup | step 7 | Unchanged; output served at `/media/<fileId>/…` |
| Planned shows (noon activation, 14-day prune) | step 10 | Activation at the show's day boundary |
| TAKEOVER look: `overlay.js` scene builders, `overlay.css`, `brand.css`, assets | step 8 | Becomes the first template package |
| DJ logos (`djs.js`, `assets/djs/`) | step 8 | Per-performer media on the lineup instead of a list in code |
| Stream Kit, Live Control, Settings pages | step 14 | Replaced by the admin UI. Keep v0's phone lessons: lazy lite previews, actions behind a menu |

## What the port must fix

- **No authentication anywhere.** On a port-forwarded box, anyone can take scenes, rewrite the
  show, change the Twitch/Kick credentials or upload 600 MB files. Steps 11–12.
- **State files are written in place** (`writeFileSync`), so a crash mid-write corrupts them
  (10 §10.6). Step 2.
- **Times use the container's timezone**, with no per-show timezone and no DST rule. Step 10.
- **`overlay.css` still breaks H10.** `.intro-blur` uses `backdrop-filter`. `.scan` uses
  `mix-blend-mode: multiply` over transparent areas: the whole Line scene when no clip plays,
  and a 42 % fill in the intro. Only POV overrides it. Step 8.
- **`overlay.html` uses inline scripts** (its error ladder), which the overlay CSP blocks. Step 8.
- **Absolute asset paths** (`/assets/…`, `/shared/…`) become relative (04 §4.5). Step 8.
- **Copy is hard-coded** ("NEXT SATURDAY", "THE MUSIC DOESN'T STOP", "OUTSIDE · THE DOOR",
  "Live From Toronto"). It becomes template settings. Step 8.
- **One-shot graphics use counters timed on each receiver's clock** (`{n, dur}`). They become
  `startAt` + `durationMs` on server time (01 §1.6). Steps 5 and 9.

## Steps

### Milestone 0: foundations
0. **Docs.** Standard moved here as Markdown + schemas, review fixes applied, this plan. *(Done.)*
1. **Tooling.** `package.json` with no dependencies, `node --test`, CI matrix on Linux, macOS and
   Windows, `.editorconfig`, `.gitignore`.
2. **Core skeleton.** Config with startup validation (10 §10.5), JSON-lines logger that redacts
   secrets (10 §10.8), crash isolation (H11), `/healthz`, storage interface over `node:sqlite`
   with an atomic JSON-file fallback, forward-only migrations with a backup first (10 §10.6),
   ULIDs.

### Milestone 1: overlays render in OBS (local mode)
3. **Bus.** Envelope, state store, `consumes` filtering, per-overlay replay buffer, coalescing
   and size limits (01 §1.2, 02).
4. **Overlay transport.** `/o/<slug>` page with the CSP, `<base>` injection and caching rules;
   snapshot, stream, poll; heartbeats; `410`; the 5 s open timeout (01 §1.5, 03 §3.4, 04 §4.5,
   §4.8). Test with eight browser sources in one OBS.
5. **Runtime SDK** (`sk.js`). Clock and skew, state and events, scenes and transitions, element
   lifecycle on deadlines (H9), actions and triggers on `startAt`, chat and music helpers, mock
   mode, lite mode (04 §4.4, 05). CI checks it stays under 25 KB gzipped. Deferred: live settings
   and scrubbing over `postMessage` in previews (step 14); triggers and alerts still inside their
   window surviving a reload (steps 9 and 19).
6. **Template packages.** Zip reader on `node:zlib` with zip-slip and zip-bomb guards, manifest
   validation, install/validate/uninstall, build hash, settings resolution and upgrade migration
   (04 §4.1–4.3, §4.10, §4.11). Through a CLI for now (the HTTP routes need auth: steps 11–13),
   which records each change in `<dataDir>/operations.log` until the audit log exists (step 11).
   Settings patterns run with a deadline (a vm timeout), since no shape rule bounds
   backtracking. Upgrades keep the previous version for `revert`. Deferred: the headless
   `?mock=1` check (step 14 or 24), installing from a URL over HTTP (step 13; the CLI has it
   since step 8b). Carried forward: the upgrade
   route's "run this package's migrate.js" must be an owner/admin decision (steps 11 and 13);
   template file URLs are public by design (07 §7.6), and if private templates ever matter,
   step 12 can key the build path per installation (an HMAC of the build with a server secret).
7. **Media.** Uploads with size caps, ffmpeg transcode (H12), `/media/<fileId>/<name>`
   (03 §3.4, 07 §7.11). Through the CLI for now (`skp media add|list|remove`); the library takes
   a stream, so `POST /media` is a thin route once auth exists (step 13). Deferred: stripping
   location metadata from JPEGs kept as uploaded (it needs rewriting EXIF without losing the
   orientation); for now only converted files lose their metadata. Carried forward to step 13,
   which makes uploads remote: cap the uploads staged at once and the conversions queued (today
   the CLI runs one at a time); make `remove` asynchronous, so deleting a large file never holds
   the event loop; and have `DELETE /media` end the streams serving that file before it is
   renamed aside (Windows can't remove an open file; today it is logged and swept at the next
   start).
8. **TAKEOVER template.** Port the v0 look with the fixes listed above: all core scenes plus The
   Line and POV, actions `titleCard`, `nowPlaying`, `chipOpening`, `chipOnAt`, Event Intro, DJ
   logos from lineup media. Add the viewer-count widget from 04 §4.12 and the Simulate endpoint.
   **Result:** the TAKEOVER overlays render in OBS from the new server with mock or hand-set data.
   Done as `com.dprtmnt.takeover` (both looks, both canvases) and `dev.skp.viewers`, with
   `npm run demo`. The event look's star is a plain one unless the headliner's mark is uploaded
   (v0 drew VIKKSTAR's monogram for every headliner). Until shows exist (step 9) the demo
   publishes `show.*` itself; the Simulate endpoint is open to this machine only, like every
   route until auth (steps 11–13), and refuses form posts and other origins.

8b. **Template sources** (added 2026-10-12 at the operator's request). Templates install from a
   `.zip` as well as a `.skp`, from an https URL, or from a GitHub repository's release; and a
   followed repository's new releases install by themselves, with overlays moved to them when
   the upgrade can't break anything (04 §4.13). Through the CLI for now (`skp template install
   owner/name`, `template follow|unfollow|sources|update`); the running platform checks every
   hour. A template has one source (a release can't take over a template installed otherwise
   without `--template`), a `migrate.js` waits for the operator, a revert stands until a newer
   version, and downloads stay off private addresses (07 §7.11) unless the owner allows them.
   Carried forward: automatic upgrades reload the overlay's page, so once shows exist (step 9)
   they wait while a show is live; the address check resolves names separately from the
   download, so step 12 should pin the resolved address (a custom connect lookup) against DNS
   rebinding; the HTTP routes and an admin-UI page for sources come with steps 13–14.

### Milestone 2: the show runs itself
9. **Shows.** Shared scene for member overlays, triggers, timed scenes returning server-side,
   `show.*` state, REC anchor (01 §1.3, 09 §9.1). Automatic template upgrades (step 8b) wait
   while a show an overlay belongs to is live.
   Done in `src/shows/`. The time rule (09 §9.2, listed under step 10) came forward: published
   lineups need it. Show state is each member's own channel state, never global. REC follows
   v0's rule; a show is live while REC runs (12 h at most). The control routes of 03 for shows
   and overlay scenes and actions exist now, local-only and JSON-only with the platform's own
   names checked (src/http/local.js), and `skp show …` drives the running platform through them
   (until steps 11–14 bring sign-in and the admin UI). Until sign-in, no web page may use them,
   not even one the platform serves: a template's script runs on its origin. Step 11 must keep
   templates out once pages can sign in (sandboxed overlay pages). The demo runs on a show.
10. **Timeline.** Cues, the scheduler rules (durable before visible, grace window), lineup
    recipe, timezone + day boundary + DST, planned shows (09). Clock tests per H19.

### Milestone 3: safe to expose, and an admin UI
11. **Auth.** Setup code, owner, serialized scrypt, sessions, CSRF, login throttling, roles, API
    tokens, TOTP, audit log (07 §7.2–7.5, §7.12).
12. **Exposure.** Overlay keys, AES-256-GCM secrets at rest with the master key, `local`/`lan`/
    `public` modes with TLS or trusted proxy, HTTP hardening, input validation (07 §7.6–7.11).
    The server may bind beyond localhost from here on.
13. **API v1 conventions.** OpenAPI document, problem+json, ETag/`If-Match`, idempotency keys,
    rate limits, pagination (03).
14. **Admin UI.** Live console first, built for a phone; then Overlays (sandboxed lite previews
    loaded on tap, settings form from the schema, Copy URL), Shows/lineup/timeline, Templates,
    Settings (08, H13, H17, H20).
15. **v0 importer.** Reads a v0 `/data` directory: `kit.json` and `shows.json` become a show,
    overlays and plans; `viewers.json` becomes Twitch and Kick connections.

### Milestone 4: connectors
16. **Connector host.** Contract, backoff, health and `system.connection`, encrypted token
    storage, device-code and PKCE flows, setup guides in the UI (06 §6.1–6.4, 08 §8.7).
17. **Twitch and Kick viewers and live status**, ported from v0. **This reaches v0 parity:** run
    a Saturday next to v0, then cut over.
18. **OBS.** obs-websocket v5 handshake, state, actions, OBS→overlay scene mapping, Add to OBS
    (06 §6.9).
19. **Twitch chat and alerts** over EventSub, the server-side alert queue and its controls, and
    chat and alert templates (05 §5.5, 06 §6.5).
20. **Kick chat and alerts** by webhook in `public` mode: signature checks, re-subscribe, the
    degraded state in LAN mode (06 §6.6).
21. **Other apps.** Outbound and inbound webhooks, custom events and state (06 §6.10). CTD hooks:
    `ctd-obs-plugin`'s signal-lost webhook (its SPEC I4) as a custom hook, and miamiorbust's car
    position as `x-mob.*` state.
22. **YouTube and Spotify**, with quota accounting, and a now-playing template (06 §6.7, §6.8).

### Milestone 5: ship
23. **Packaging.** OCI image on GHCR (v0's workflow is the starting point), TrueNAS YAML,
    single executables for Linux and macOS, systemd unit, signed macOS app, backup and restore
    (10).
24. **Release checks.** H1–H20 walked one by one, the eight-source OBS test, the DST clock test,
    a 90-minute soak with real data.

**For Miami or Bust (April 2027):** steps 1–21 and 23 cover it, along with a show template for
it (16:9 + 9:16, route and position from step 21). YouTube and Spotify can follow.
