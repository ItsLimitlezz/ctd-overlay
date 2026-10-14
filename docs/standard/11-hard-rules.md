# 11 · Hard rules & migration from v0

Each rule below was learned by something breaking during a live show or its rehearsal. They are
normative: an implementation that violates one is not conformant, however well it does
everything else.

## Hard rules

**H1 · Templates never connect.** A template has no credentials and no route to a third party.
*Why:* integration code spread across designs is unmaintainable and leaks tokens into a
browser anyone can inspect. *(04 §4.8)*

**H2 · Overlay URLs are permanent.** Nothing configurable goes in an OBS URL — not the theme,
the viewer-count mode, settings or the template version. *Why:* v0 put an event theme and a
viewer flag in the URL; every toggle minted new links and sent the operator back into OBS to
re-paste sources minutes before doors. *(01 §1.4)*

**H3 · The server owns the show.** Cues fire on the server. *Why:* v0 first ran its rundown in
the browser; closing the laptop stopped the show. *(09)*

**H4 · Durable before visible.** Persist a cue's fired state before publishing its effect.
*Why:* otherwise a crash between the two fires it again on restart. *(09 §9.4)*

**H5 · No retroactive mass-fire.** Cues more than 5 minutes late are marked missed, not fired.
*Why:* a wrong date or a restart replayed an entire night of title cards at once. *(09 §9.4)*

**H6 · Never show a wrong number.** Unknown is hidden; errors hold the last good value briefly,
then hide; only an authoritative report renders `0`. *Why:* a failed API that renders "0
viewers" on stream is worse than showing nothing. *(02 §2.8)*

**H7 · Times before the day boundary belong to the next day.** *Why:* a Friday show with a 1:00
AM headliner must schedule him for Saturday 1:00 AM; every naive implementation puts him on
Friday at 1 AM, before doors. *(09 §9.2)*

**H8 · Headliner and closer are different.** *Why:* v0 used "the CLOSER slot" as the headliner;
on a bill where the closer wasn't the billed act, the event's Starting Soon card showed the wrong
DJ. *(09 §9.1)*

**H9 · Never gate correctness on `requestAnimationFrame` or `animationend`.** Use timers and
deadlines. *Why:* OBS stops frames to sources that aren't painting, background tabs throttle
timers to about once a second, and `animationend` never fires on a hidden element — each of these
froze v0 overlays at some point. *(05 §5.2, §5.7)*

**H10 · Respect what a browser source can't see.** `backdrop-filter` can't blur the camera;
`mix-blend-mode: multiply` on a transparent page composites to black. *Why:* both shipped in v0
and blacked out or did nothing on air. *(05 §5.8)*

**H11 · Nothing a client sends may crash the process.** *Why:* v0 crashed about weekly because a
scanner's malformed URL threw in `decodeURIComponent` outside any handler. *(01 §1.7, 07 §7.11)*

**H12 · Transcode phone video.** *Why:* iPhone `.MOV` is usually HEVC, which OBS's browser can't
decode; the clip silently didn't play. Convert to H.264 MP4 and bake in rotation. *(10 §10.2)*

**H13 · Phones get lite previews, loaded on tap.** *Why:* two live overlay iframes with blur and
grain exhausted iOS Safari's GPU memory and crash-looped the control page. *(05 §5.8, 08 §8.3)*

**H14 · Beat OBS's cache.** App files are `no-store`; template files and media live at paths
that change with their content, and are immutable.
*Why:* OBS kept serving stale overlay code after updates. *(03 §3.4)*

**H15 · Setup lives on the server.** *Why:* v0 kept the setup in browser storage; switching from
the LAN address to the public one, or to a phone, showed an empty kit and the night's lineup had
to be re-entered. *(01 §1.2)*

**H16 · Concurrent edits are detected, not lost.** Every mutable resource has an ETag, and the
admin UI sends `If-Match` on every edit. *Why:* an initial page load pushed its stale copy over a newer server copy and erased
an operator's work. *(03 §3.1)*

**H17 · UI tolerates missing optional elements.** Pages initialize defensively — a field moved to
another page, or hidden by a template, never throws during startup. *Why:* moving one setting to
the Settings page made the main page crash on load and render no links at all. *(08)*

**H18 · Respect platform quotas as hard stops.** On quota exhaustion, stop until reset. *Why:*
retrying a YouTube `quotaExceeded` as if it were a rate limit has consumed whole days of quota in
other streaming tools. *(06 §6.7)*

**H19 · Test against the clock.** Every scheduled behaviour is tested by setting it a few minutes
ahead and watching it fire on a running server, not only by unit tests. The time rules are also
tested across a daylight-saving change (09 §9.2). *Why:* v0's time bugs
(after-midnight, grace window, timezone) all passed reasoning and failed reality until tested this
way.

**H20 · Destructive actions are never one tap away.** Reset, delete and key rotation sit behind a
menu and a confirmation that names the consequence. *Why:* the v0 reset button sat in the phone
toolbar next to navigation.

---

## Migrating from v0 (D/PRTMNT Stream Kit)

v0 is the working prototype this standard generalizes. Mapping:

| v0 | SKP |
|---|---|
| `/overlay?feed=h&scene=bus` | `/o/<slug>?canvas=h` on an overlay that belongs to a show |
| "Live Bus · H / V" | a **Show** with two member overlays |
| Standalone scene links | overlays outside a show, or `?scene=` preview overrides |
| `scene=main` / `auto` | core scene `auto` |
| Event packs (`shared/events.js`) | **Templates** (`template.json`) |
| `THEME_BUILDERS.vikstarr` | the VIKKSTAR template's scenes |
| Base TAKEOVER look | the TAKEOVER template; The Line and POV become its extra scenes |
| `CORE_SCENES` / `BASE_EXTRAS` | `scenes[].core` vs extras in each manifest |
| `evOpts` toggles, star treatment | template settings schema |
| Base64 `cfg` on the live channel | Show and Overlay resources; no config in URLs |
| `GET /api/live` | `/o/<slug>/snapshot` + `/stream` |
| `np` / `title` counters `{n, dur}` | `show.trigger` with `startAt` + `durationMs` |
| `sched` chips (opening / on-at) | template actions `chipOpening` / `chipOnAt` |
| `clubintro` | `overlay.action: intro` (Event Intro) |
| `headliner` scene | template extra scene `headliner` + `overlay.action: headliner` |
| `rundown.json` | timeline cues |
| `kit.json` | show + overlay settings |
| `shows.json` (planned shows) | show plans (09 §9.6) |
| `viewers.json` | Twitch and Kick **connections**, encrypted |
| `live.viewers` | `viewers.total`, `viewers.<platform>`, `viewers.stale` |
| REC anchor `recStartedAt` | `show.recStartedAt` |
| Line clip upload | media + `media.play` |
| DJ logos (`shared/djs.js`) | per-performer media referenced from the show lineup |
| `/settings` page | Settings + Connections sections |
| No login | users, roles, sessions, overlay keys |

Importing a v0 data directory (informative: how this platform's `skp import v0` reads the table
above):
- **The setup** is `kit.json`, else the base64 `cfg` in `live.json` (an install from before
  `kit.json`), whose event may still be the legacy `evParams` query string. A setup v0 never
  cleaned (`_cmig` missing) is cleaned as v0 would have. A field of the wrong type is skipped with
  a warning, and v0's own default stands for it.
- **Times** keep v0's rule as the show's day boundary, `12:00` (H7), in the zone the operator
  names: v0 had only its server's.
- **The headliner** (H8) is the event options' name, else the event's billed artist, matched to
  the lineup as v0's overlay did (lowercase, letters only, doubled letters collapsed; exact, then
  prefix). With no match, no slot is flagged; the event look shows the name as a setting.
- **One overlay with both canvases** replaces v0's `feed=h` and `feed=v` links; only the settings
  that differ from the template's defaults are saved. In the event look, v0's own scanline switch
  (`evOpts.scan`) is the one that applies, and its now-playing and chip switches (`np`, `sched`),
  which the template doesn't have, turn those cues off instead. A typed viewer number is not
  imported (H6).
- **Generated cues** use v0's recipe: a title card at every start, the headliner's included (v0
  had no headliner intro of its own), the Event Intro `clubIntroMin` in, now playing every
  `npIntervalMin`. Two differences remain, the platform's: the last set's now playing runs two
  hours (v0: one), and a generated Event Intro plays only from program (09 §9.5). **Hand-made
  cues** for that night that haven't happened map as `djtitle`/`title` → `titleCard`,
  `djnp`/`djon`/`np` → `nowPlaying` (a DJ cue that named an act is a `sequence`: who's on, then
  the action), `clubintro` and `headliner` → those scenes, `sched:*` → `chipOpening`/`chipOnAt`,
  `clip:play`/`clip:stop` → `media.play` of the imported clip/`media.stop`, `scene:<x>` → `x`.
- **Plans** are the dates from today on, except the show's own and any v0 had already loaded. A
  plan's settings replace the overlay's when it activates, so a plan whose look differs carries
  the overlay's whole settings.
- **Credentials** wait, encrypted with the record id as associated data, until connections exist
  (06 §6.1); `skp key rotate` re-encrypts them with the rest.
- Never imported: the roster, live state (scene, REC, counters), other uploads, `crash.log`. Paths
  in v0's files are never followed: the clip is looked up by its base name in `uploads/` only.

Suggested order for the new build: storage and auth → overlays and the runtime SDK with mock
data → port the TAKEOVER design as the first template (VIKKSTAR was removed from v0 after its
event; recover it from commit `7c41201` if wanted as a second) → shows and timeline → Twitch and
OBS connectors → Kick, YouTube, Spotify → packaging.
