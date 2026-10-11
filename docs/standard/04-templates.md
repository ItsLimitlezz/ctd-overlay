# 04 · Templates

A template is a design. It decides how things look, where they sit and how they move. It does
not decide where data comes from — that is the platform's job (README, "The one principle").

A template can be as large as a whole show package (countdown, BRB, timetable, intros) or as
small as a single chat box. Users compose several in OBS by stacking overlay sources.

## 4.1 Package format

A template is a ZIP archive with the extension `.skp`:

```
vikkstar-event/
├── template.json        manifest (REQUIRED)
├── index.html           entry document (REQUIRED, path configurable)
├── template.css
├── template.js
├── assets/              images, fonts, video, Lottie JSON
├── previews/            screenshots shown in the gallery (REQUIRED: at least one)
└── LICENSE
```

- Total size **MUST NOT** exceed 100 MiB; a single file 50 MiB.
- Paths are relative, lowercase recommended, no `..`, no absolute paths, no symlinks. The
  platform **MUST** reject archives violating this (zip-slip protection).
- Everything the template loads at runtime **MUST** be inside the package, except the images
  the data itself points to (avatars, emotes, album art) and fonts from allowed hosts (§4.8).

## 4.2 Manifest

`template.json`. Schema: [schemas/template.schema.json](schemas/template.schema.json).

```json
{
  "standard": "skp/1",
  "id": "com.dprtmnt.vikkstar-event",
  "name": "VIKKSTAR × D/PRTMNT",
  "version": "1.2.0",
  "description": "Gold poster-led event package with headliner takeover intro.",
  "author": { "name": "D/PRTMNT", "url": "https://dprtmnt.com" },
  "license": "proprietary",
  "category": "show",
  "tags": ["event", "dj", "gold"],
  "entry": "index.html",
  "previews": ["previews/starting.jpg", "previews/program.jpg"],

  "engines": { "obs": ">=30" },

  "canvases": [
    { "id": "h", "width": 1920, "height": 1080, "default": true },
    { "id": "v", "width": 1080, "height": 1920 }
  ],

  "scenes": [
    { "id": "starting",  "label": "Starting Soon", "core": "starting" },
    { "id": "program",   "label": "Live · In-set", "core": "program", "transparent": true },
    { "id": "brb",       "label": "Be Right Back", "core": "brb" },
    { "id": "lineup",    "label": "Timetable",     "core": "lineup" },
    { "id": "outro",     "label": "Thanks For Watching", "core": "outro" },
    { "id": "bg",        "label": "Animated Background", "core": "bg" },
    { "id": "intro",     "label": "Event Intro",   "core": "intro", "durationMs": 8000, "then": "program" },
    { "id": "headliner", "label": "Headliner Intro", "durationMs": 8000, "then": "program" }
  ],

  "consumes": {
    "state":  ["show.*", "viewers.total", "viewers.stale", "music.nowPlaying"],
    "events": ["show.trigger", "alert.*"],
    "chat":   { "recent": 0 }
  },

  "settings": { "$ref": "#/definitions/settings" },

  "actions": [
    { "id": "titleCard",  "label": "DJ title card",  "durationMs": 7000 },
    { "id": "nowPlaying", "label": "Now playing",    "durationMs": 22000 },
    { "id": "chipOpening","label": "Opening DJ chip","durationMs": 10000 }
  ],

  "alerts": { "mode": "serial", "maxConcurrent": 1, "minDisplayMs": 4000, "gapMs": 600 },

  "fonts": ["https://fonts.googleapis.com/css2?family=Archivo:wght@700;900"]
}
```

### Field rules
- `id` — reverse-DNS, globally unique, immutable for the life of the template.
- `version` — SemVer. A **major** bump means existing overlays' settings may not migrate
  automatically (§4.10).
- `category` — one of `show` (multi-scene package), `chat`, `alerts`, `now-playing`,
  `lower-third`, `background`, `ticker`, `goal`, `scoreboard`, `widget`.
- `scenes[].core` — maps the scene to a **core scene** so shows, timelines and buttons work
  across templates: `auto`, `starting`, `program`, `brb`, `lineup`, `outro`, `bg`, `intro`. A
  scene without `core` is a template **extra** (e.g. `headliner`). A `show`-category template
  **MUST** provide `starting`, `program`, `brb` and `outro`; it **SHOULD** provide all eight.
- `scenes[].then` + `durationMs` — a timed scene that returns automatically. The **server**
  performs the return (09 §9.3), so it happens even if no browser is watching.
- `consumes` — least privilege. The runtime delivers only matching state keys and event types;
  everything else never leaves the server. Wildcards: `alert.*`, `show.*`.
- `chat.recent` — how many buffered messages the snapshot includes (0–200). `chat.max` — the
  most messages the template keeps on screen; the runtime unmounts older ones (05 §5.6).

## 4.3 Settings schema

Templates declare user-editable settings with a JSON Schema (draft 2020-12) subset. The admin
UI generates the form from it — templates never ship their own settings UI.

```json
"definitions": {
  "settings": {
    "type": "object",
    "properties": {
      "headliner":  { "type": "string", "title": "Headliner", "x-skp-bind": "show.headliner" },
      "accent":     { "type": "string", "format": "color", "title": "Accent", "default": "#EFC33F" },
      "starStyle":  { "type": "string", "title": "Logo treatment", "enum": ["rake","rise","ghost","stamp"],
                      "x-skp-labels": ["Gold rake","Rise reveal","Ghost trail","Stamp + ring"], "default": "rake" },
      "showPoster": { "type": "boolean", "title": "Poster art", "default": true },
      "scanlines":  { "type": "boolean", "title": "Scanlines", "default": true },
      "chatX":      { "type": "integer", "title": "Chat position X", "minimum": 0, "maximum": 1920,
                      "x-skp-widget": "position", "x-skp-axis": "x" },
      "poster":     { "type": "string", "title": "Poster image", "x-skp-widget": "media", "x-skp-accept": "image/*" }
    }
  }
}
```

Supported: `string`, `number`, `integer`, `boolean`, `enum`, `array` of primitives, nested
`object` (rendered as a group), `default`, `minimum`/`maximum`, `maxLength`, `pattern`,
`format: color | uri | date | time`.

Extensions (`x-skp-*`):

| Key | Effect |
|---|---|
| `x-skp-widget` | `color`, `font`, `media`, `position`, `size`, `slider`, `textarea`, `code` |
| `x-skp-labels` | Display labels for `enum` values |
| `x-skp-group` | Groups fields into a collapsible section |
| `x-skp-bind` | Default the value from a state key (still overridable) |
| `x-skp-showIf` | `{ "field": "showPoster", "equals": true }` conditional display |
| `x-skp-preview` | `"live"` — update the preview on every keystroke instead of on blur |

Design tokens are just settings: a template that exposes `accent`, `fontDisplay` and `radius`
lets a user restyle it without code.

## 4.4 Runtime SDK

The runtime injects `/sdk/v1/sk.js` before the template's scripts and exposes a frozen global
`SK`. Templates **MUST** obtain all live data through it.

```js
SK.ready(() => { /* snapshot loaded, settings resolved, safe to render */ });

// settings
SK.settings                       // resolved values (defaults applied)
SK.onSettings(s => restyle(s))    // live edits from the admin UI

// state
SK.state('viewers.total')         // current value or undefined
SK.onState('viewers.total', (v, prev) => …)   // also fires once on ready
SK.onState('show.*', (key, v) => …)

// events
SK.on('alert.*', e => …)          // only types declared in consumes
SK.on('show.trigger', e => …)

// scenes
SK.scene                          // current scene id
SK.onScene((scene, prev, transition) => …)

// actions this template declared
SK.action('titleCard', ({ args, startAt, durationMs }) => showCard(args))

// chat helper (merged, moderated, buffered)
SK.chat.recent()                  // array, oldest first
SK.chat.onAdd(m => …); SK.chat.onRemove(id => …); SK.chat.onClear(() => …)

// music helper
SK.music.track()                  // Track or undefined
SK.music.progress()               // interpolated ms

// alerts: the runtime queues; the template renders one at a time
SK.alerts.render(async (alert, el) => { … resolves when exit animation is done … })

// animation lifecycle (see 05)
SK.mount(el, { enter: 'rise', durationMs: 600 })
SK.unmount(el)                    // resolves after the exit animation

// time & environment
SK.clock.now()                    // server time
SK.clock.at(ts, fn)               // run fn at a server time
SK.canvas                         // { id, width, height }
SK.env                            // { preview, lite, reducedMotion, obs }
SK.asset('assets/poster-h.jpg')   // versioned, cacheable URL
SK.log.warn('…')                  // forwarded to the platform's template log
```

The SDK **MUST** be dependency-free, under 25 KB gzipped, and run in the browser engine of the
oldest OBS version the platform supports (10 §10.2).

## 4.5 Rendering contract

- The runtime sets `<html data-skp-canvas="h" data-skp-scene="program">` and scales a fixed
  stage of the canvas size to the viewport. Templates lay out in canvas pixels and never
  compute scaling themselves.
- The page background **MUST** be transparent unless the active scene declares otherwise. OBS
  composites the overlay over the camera.
- A template **MUST** render something sensible with empty data: before the snapshot, with no
  connections bound, and with every optional key absent.
- A template **MUST NOT** depend on `requestAnimationFrame` for correctness. Use timers, CSS
  animations or `SK.clock.at` (05 §5.7).

## 4.6 Actions

Actions are named moments a template can perform: a title card, a now-playing lower third, a
schedule chip, a goal celebration. Declaring them in the manifest makes them appear as buttons
in the admin UI, as cue actions on the timeline, and as `POST /overlays/{id}/actions/{name}` —
with no extra work.

The runtime calls the registered handler with `{ args, startAt, durationMs }`. The template
shows the element from `startAt` for `durationMs` on server time, then hides it. A trigger that
arrives after its window has passed **MUST NOT** be shown.

## 4.7 Scenes and transitions

The runtime owns scene switching: it mounts the incoming scene container
(`<section data-skp-scene-root="brb">`), runs the outgoing scene's exit and the incoming
scene's enter (05 §5.4), then removes the old container. A template provides each scene's
markup by either:

- **declarative** — `<template data-skp-scene="brb">…</template>` blocks in `index.html`; or
- **imperative** — `SK.defineScene('brb', ctx => element)`.

## 4.8 Sandbox and Content Security Policy

Templates are third-party code running inside OBS and inside the admin UI's preview. The
platform **MUST** serve overlay pages with:

```
Content-Security-Policy:
  default-src 'none';
  script-src 'self';
  style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;
  font-src 'self' https://fonts.gstatic.com data:;
  img-src 'self' data: https:;
  media-src 'self' blob:;
  connect-src 'self';
  frame-ancestors 'self';
  base-uri 'none';
  form-action 'none'
```

`connect-src 'self'` is what makes "templates never connect" enforceable: a template cannot
fetch from a third party even if it tries. `img-src https:` exists because avatars, emotes and
album art legitimately come from platform CDNs. Additional font hosts **MAY** be allowed only
if listed in `fonts`.

In the admin UI, previews **MUST** load in `<iframe sandbox="allow-scripts">` — *without*
`allow-same-origin` — so a template can never read the operator's session or the admin DOM.
Overlay endpoints authorize by key, not cookie, and answer `GET` with
`Access-Control-Allow-Origin: *`, which is what lets the opaque-origin preview still stream
data.

A template **MUST NOT** receive tokens, credentials, other overlays' data, or any state key it
did not declare.

## 4.9 Preview overrides

For development and the admin UI only, the overlay URL accepts:
`?scene=<id>` (force a scene), `?bg=dark` (opaque backdrop), `?lite=1` (drop GPU-heavy layers —
mobile previews), `?mock=1` (sample data, 08 §8.5), `?debug=1` (diagnostic HUD),
`?settings=<base64>` (unsaved settings being edited). URLs generated for OBS **MUST NOT**
include them.

## 4.10 Versioning and migration

- Overlays pin `id@version`. Installing a newer version never changes running overlays.
- `POST /overlays/{id}/upgrade` migrates settings: unchanged keys copy over, removed keys drop,
  new keys take defaults. A template **MAY** ship `migrate.js` exporting
  `migrate(fromVersion, settings) → settings` for renames; it runs server-side in an isolated
  context with no I/O.
- Across a **major** version the UI **MUST** show what will change before upgrading.

## 4.11 Validation

`POST /templates/validate` (and the same check on install) **MUST** verify: manifest against
the schema; `standard` is supported; every referenced file exists; previews exist; no path
escapes; scene and action IDs unique; `show` templates provide the required core scenes; the
entry renders without throwing under `?mock=1` in a headless check when available. Errors
block install; warnings (e.g. a missing `bg` scene) are shown.

## 4.12 A minimal template

```html
<!-- index.html -->
<link rel="stylesheet" href="template.css">
<template data-skp-scene="program">
  <div class="viewers" hidden><span class="dot"></span><b></b></div>
</template>
<script src="template.js"></script>
```
```js
// template.js
SK.ready(() => {
  SK.onState('viewers.total', v => {
    const el = document.querySelector('.viewers');
    el.hidden = v === undefined;                       // absent → hidden, never "0"
    if (v !== undefined) el.querySelector('b').textContent = v.toLocaleString();
  });
});
```
That is the entire integration with Twitch, Kick and YouTube viewer counts.
