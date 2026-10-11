# Stream Kit Platform Standard (SKP) — v1.0 draft

**Status:** Draft · **Date:** 2026-10-09 · **Identifier:** `skp/1`

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
8. **No native dependencies in the core.** So it ships as a single executable on macOS and
   Linux and a small multi-arch image for TrueNAS. Media transcoding uses an external ffmpeg
   when present and is reported as unavailable when not. *(10)*

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
