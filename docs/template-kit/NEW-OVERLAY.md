# New overlay: the handoff for a new chat

Use this file to have an AI assistant (a new chat) build a new overlay template for CTD Overlay.

**How to use it**

1. Fill in **Part 1: Your overlay** below. Rough notes are fine; a sketch or a screenshot of a
   look you like helps more than words.
2. Start a new chat and give it:
   - this file;
   - the [`starter/`](starter/) folder (zip it, or attach its five files): the template to start
     from;
   - [`TEMPLATE-GUIDE.md`](TEMPLATE-GUIDE.md): the full rules. Attach it if you can. Part 3 below
     is a summary for when you can't.
   - For a whole show package (Starting Soon, Live, BRB, timetable, chat, alerts…), also the
     [`mega/`](mega/) folder: a complete example of every feature.

   If the new chat runs in this repository (Claude Code), it can read all of these itself: just
   point it at `docs/template-kit/NEW-OVERLAY.md`. They're also public on GitHub:
   <https://github.com/ItsLimitlezz/ctd-overlay/tree/main/docs/template-kit>.
3. Say: "Build this overlay. Follow Part 2."

---

## Part 1: Your overlay

<!-- Replace each line. Leave out what you don't know: the assistant will pick something sensible
     and say what it picked. -->

- **Name:** (e.g. "Miami Or Bust lower third")
- **What it's for:** (e.g. a lower third for a road-trip stream; a DJ set's corner bug; a
  countdown screen)
- **Kind:** a single widget (sits over the camera) / a whole show package (full-screen scenes)
- **Canvases:** 16:9 (1920×1080), 9:16 (1080×1920), or both
- **Scenes:** (a widget usually has just "Live". A show package: Starting Soon, Live, Be Right
  Back, Timetable, Thanks For Watching, and any extras)
- **What it shows:** (the title, who's on from the lineup, the viewer count, chat, alerts (follows,
  subs, raids, tips), now playing, a countdown to go-live, REC time, a ticker, a logo…)
- **Buttons:** (moments the operator fires on Live, e.g. "DJ title card for 7 s", "Announcement")
- **Settings the operator changes:** (colours, text, logo, which corner, sizes, what's turned
  on…)
- **The look:** (colours, fonts (Google Fonts), shapes, references or screenshots)
- **Motion:** (how things come in and leave: slide, fade, wipe; how fast)
- **Anything else:**

---

## Part 2: For the assistant

You are building an overlay template for **CTD Overlay** (the Stream Kit Platform, standard
`skp/1`), a self-hosted platform that serves overlays to OBS browser sources. The operator runs it
on a NAS and installs templates through its admin UI.

**Start from `starter/`.** Copy it and change it into the overlay in Part 1. It already validates
and follows every rule; keep its patterns. For anything it doesn't show (more scenes, `auto`, chat,
alerts, music, a ticker, media), copy the pattern from `mega/`. `TEMPLATE-GUIDE.md` is the
specification: where it and this file differ, the guide wins.

**Deliver** the complete template folder, every file in full:

- `template.json`: a new reverse-DNS `id` (for example `com.<operator>.<overlay-name>`; never
  `com.example.*`, `com.dprtmnt.*`, `com.ctd.*` or `dev.skp.*`), `version` `1.0.0`, the right
  `category`, `canvases`, `scenes`, `consumes` listing every state key and event the code uses,
  `actions` for the buttons, and a `settings` schema.
- `index.html`, `template.css`, `template.js`.
- `previews/preview.svg` (or a PNG): a picture of the design for the gallery.
- `assets/` for any images or fonts it ships.

**Then tell the operator:** each setting in a line, the browser source size for each canvas, and
how to install and preview it (Part 4).

**Don't:**

- connect to anything or `fetch`: the platform hands the template all its data through `SK`;
- use `localStorage`, `sessionStorage` or cookies (the page is sandboxed);
- set `innerHTML` with data in it: use `textContent`;
- use `Date.now()` for anything shown: use `SK.clock.now()` (server time, the same on every
  source);
- depend on `requestAnimationFrame` or `animationend` for state (OBS throttles hidden sources):
  use timers and `SK.clock.at`;
- print `0`, `undefined` or `NaN` for a value you don't have: an absent value hides its element;
- use CSS that OBS 30's browser (Chromium 103) lacks: `color-mix()`, `:has()`, nesting,
  container queries; nor `backdrop-filter` or `mix-blend-mode` on a transparent scene;
- load scripts from elsewhere (fonts from Google Fonts are fine, listed in `fonts`), or add a
  `<base>`.

**Check before answering:**

- [ ] Every scene in `scenes` has a `<template data-skp-scene="…">` or `SK.defineScene`.
- [ ] Every action has an `SK.action` handler; everything read is declared in `consumes`.
- [ ] It looks right with no data at all, with sample data (`?mock=1`), at every canvas, with
      long names (they wrap or truncate, nothing runs off the frame).
- [ ] Motion only in CSS on `[data-skp-state="enter|idle|exit"]`; `transform` and `opacity` only.
- [ ] Settings applied on `SK.ready` and again on `SK.onSettings`.
- [ ] If you can run the platform, `npm run skp -- template validate <folder>` says valid.

---

## Part 3: Quick reference

The full version of all this is `TEMPLATE-GUIDE.md`.

### The package

```
my-overlay/
├── template.json   the manifest
├── index.html      one <template data-skp-scene="id"> per scene; relative links to the CSS and JS
├── template.css    laid out in canvas pixels; [data-skp-canvas="v"] rules for 9:16
├── template.js     reads everything through SK
├── previews/       at least one picture
└── assets/         optional: images, fonts, video
```

The runtime scales the stage to the browser source: lay out at 1920×1080 (or 1080×1920), never
compute scaling. The page background is transparent; full-screen scenes paint their own.

### `template.json`

| Field | What |
|---|---|
| `standard` | `"skp/1"` |
| `id` | reverse-DNS, lowercase, never changes |
| `version` | `MAJOR.MINOR.PATCH`; **bump it for every change** (a version can't be reinstalled with different files) |
| `category` | `show`, `chat`, `alerts`, `now-playing`, `lower-third`, `background`, `ticker`, `goal`, `scoreboard` or `widget` |
| `canvases` | `[{ "id": "h", "width": 1920, "height": 1080, "default": true }, { "id": "v", "width": 1080, "height": 1920 }]` |
| `scenes` | `[{ "id", "label", "core"?, "transparent"?, "durationMs"?, "then"? }]` |
| `consumes` | `{ "state": [...], "events": [...], "chat": { "recent", "max" } }`: **nothing undeclared arrives** |
| `actions` | `[{ "id", "label", "durationMs"? }]`: each becomes a button on Live and a cue type |
| `alerts` | `{ "mode": "serial", "durationMs": 6000, "gapMs": 500 }`, if it shows alerts |
| `fonts` | up to 8 Google Fonts stylesheet URLs |
| `settings` | JSON Schema for the settings form (below) |

**Core scenes** (so shows and buttons work across templates): `auto`, `starting`, `program` (Live,
usually `"transparent": true`), `brb`, `lineup`, `outro`, `bg`, `intro`. A `show` template needs at
least `starting`, `program`, `brb` and `outro`. `auto` is yours to build: Starting Soon until
`show.goLiveAt`, then Live (see `mega/template.js`). A timed scene has `durationMs` and `then`.

### Settings

Types: `string`, `number`, `integer`, `boolean`, `enum`, `array` of simple values, `object` (a
group, at most 3 deep). Keywords: `title`, `description`, `default`, `minimum`/`maximum`,
`minLength`/`maxLength`, `pattern`, `maxItems`, `format` (`color`, `uri`, `date`, `time`). Not
allowed: `oneOf`/`anyOf`/`allOf`, `if`/`then`, `const`, `required`.

Extensions: `x-skp-widget` (`color`, `font`, `media`, `position`, `size`, `slider`, `textarea`),
`x-skp-labels` (labels for an `enum`), `x-skp-group` (a section), `x-skp-showIf`
(`{ "field": "x", "equals": true }`), `x-skp-bind` (default from a state key, e.g.
`show.headliner`), `x-skp-accept` (`image/*` for a `media` widget).

### Data (declare it in `consumes`)

| State key | Value |
|---|---|
| `show.scene` | the current scene (always delivered) |
| `show.lineup` | `[{ time "HH:MM", name, b2b?, headliner?, closer?, logo?, startAt }]` |
| `show.currentSlot` | index into `show.lineup` of who's on, or absent |
| `show.nobodyOn` | `true` while the operator says nobody is on |
| `show.headliner`, `show.date`, `show.timezone` | text |
| `show.goLiveAt`, `show.recStartedAt` | epoch ms, for a countdown and a REC timer |
| `viewers.total`, `viewers.twitch` … , `viewers.stale` | numbers; `stale` = show it quieter |
| `music.nowPlaying` | the track (use `SK.music`) |
| `stream.clock` | `{ startedAt?, fps }` from CTD Relay: run time and timecode |

Events: `alert.*` (use `SK.alerts.render`), `chat.*` (use `SK.chat`), `show.trigger` (use
`SK.action`), `media.play` / `media.stop`.

The `show.*` keys arrive only when the overlay is in a show (Shows in the admin UI). An overlay
in no show gets none of them.

### The SDK: `SK`

```js
SK.ready(fn)                       // start here: data and settings are in
SK.settings; SK.onSettings(fn)     // resolved settings, and their changes while the operator edits
SK.state(key); SK.onState(key, fn) // a value (undefined = absent) and its changes; 'show.*' patterns too
SK.on('alert.*', fn)               // events you declared
SK.onScene((id, prev, transition, root) => …)   // fill the new scene's root
SK.defineScene(id, (ctx) => element)            // build a scene in code
SK.action('card', ({ args, startAt, durationMs, lateMs }) => …)   // a button, on time on every source
SK.chat.onAdd((message) => element)             // return an element; the runtime manages it
SK.alerts.render((alert, element) => …)         // fill the element; the server queues alerts
SK.music.track(); SK.music.progress()
SK.mount(el); SK.unmount(el)       // data-skp-state enter → idle → exit; CSS animates
SK.clock.now(); SK.clock.at(ts, fn)             // server time; run fn at a server time
SK.canvas; SK.env                  // { id, width, height }; { preview, lite, reducedMotion, obs }
SK.asset('assets/logo.png'); SK.preload(urls); SK.log.warn(msg)
```

---

## Part 4: Installing and trying it

1. **Validate** (with the repository): `npm run skp -- template validate path/to/my-overlay`.
2. **Install**: zip the folder (with `template.json` at the top of the zip, or in one folder
   inside it), then in the admin UI go to **Templates → Install** and pick the zip. It shows any
   problems before installing.
3. **Preview**: the template's page in **Templates** shows it live with sample data at each canvas.
4. **Make an overlay**: **Overlays → New overlay**, pick the template, fill in the settings. For
   `show.*` data (lineup, go-live, who's on), put it in a show: **Shows → New show**.
5. **In OBS**: add a Browser source with the overlay's URL at the canvas size (**Copy URL** in
   Overlays gives both).
6. **Changing it later**: bump `version` in `template.json`, install again, then upgrade the
   overlay (overlay page → **Version → Upgrade…**). Overlays stay on the version they were made
   with until upgraded. Never upgrade while live.

Overrides for testing any overlay URL: `?mock=1` (sample data), `?canvas=v`, `?bg=dark`,
`?lite=1`, `?debug=1`. `?scene=brb` pins one scene, in OBS too (the overlay page's *A URL for one
scene*), so every scene must work on its own with live data.
