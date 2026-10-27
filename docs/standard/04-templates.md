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
├── previews/            screenshots shown in the gallery (REQUIRED: at least one; PNG, JPEG,
│                        WebP, GIF, SVG or AVIF, subfolders allowed)
└── LICENSE
```

- The archive and its files uncompressed **MUST NOT** each exceed 100 MiB; a single file 50 MiB
  uncompressed. Files use store or deflate; encrypted entries, ZIP64 and multi-part archives are
  refused, as are files that expand more than 100 times (above 1 MiB: zip bombs).
- Paths are relative, lowercase recommended, no `..`, no absolute paths, no symlinks. They
  **MUST** be portable: no Windows-reserved names (`con`, `nul`, `com1`…) or characters
  (`< > : " | ? *`), no name ending in a dot or space, and no two paths that differ only in case
  or Unicode normalization. The platform **MUST** reject archives violating this (zip-slip
  protection).
- `template.json` sits at the archive's root, or inside one top-level folder (as drawn above),
  which is not part of the package's paths. Desktop clutter (`__MACOSX/`, `.DS_Store`, `._*`,
  `Thumbs.db`, `desktop.ini`) and version-control directories (`.git/`, `.svn/`, `.hg/`) are
  ignored.
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

  "alerts": { "mode": "serial", "durationMs": 6000, "gapMs": 600 },

  "fonts": ["https://fonts.googleapis.com/css2?family=Archivo:wght@700;900"]
}
```

### Field rules
- `id` — reverse-DNS, globally unique, immutable for the life of the template; at most 100
  characters. The ids of templates that ship with the platform are reserved.
- `version` — strict SemVer 2.0.0 (no leading zeros, no build metadata, at most 64 characters).
  A **major** bump means existing overlays' settings may not migrate automatically (§4.10).
- `category` — one of `show` (multi-scene package), `chat`, `alerts`, `now-playing`,
  `lower-third`, `background`, `ticker`, `goal`, `scoreboard`, `widget`.
- `scenes[].core` — maps the scene to a **core scene** so shows, timelines and buttons work
  across templates: `auto`, `starting`, `program`, `brb`, `lineup`, `outro`, `bg`, `intro`. A
  scene without `core` is a template **extra** (e.g. `headliner`). A core is mapped by at most
  one scene. A `show`-category template **MUST** provide `starting`, `program`, `brb` and
  `outro`; it **SHOULD** provide all eight.
- `scenes[].then` + `durationMs` — a timed scene that returns automatically, to a scene id or a
  core of the same template (not itself, and not around a loop of zero-length scenes). The
  **server** performs the return (09 §9.3), so it happens even if no browser is watching.
- Scene, action, canvas and transition ids are unique; the transition ids `cut` and `fade` are
  the runtime's own.
- `alerts.durationSetting` names a number or integer setting; if it names none, the runtime uses
  `alerts.durationMs` (a validation warning).
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
`object` (rendered as a group), `default`, `minimum`/`maximum`, `minLength`/`maxLength`,
`pattern`, `minItems`/`maxItems`/`uniqueItems`, `additionalProperties: false`, `title`,
`description`, `examples`, `$ref` to the manifest's own `definitions`, and
`format: color | uri | date | time`. Anything else (combinators, conditionals, `const`,
`required`, `multipleOf`…) is refused, because the generated form couldn't show it. Further:

- Every field declares exactly one `type`. Names are like identifiers (`^[A-Za-z][A-Za-z0-9_]*$`).
- Groups nest at most 3 deep and carry no `default` of their own; their fields do. Neither does
  the settings object itself, and `x-skp-bind` goes on fields, not groups.
- Keyword values make sense: lengths and item counts are whole numbers, `minimum`/`maximum`
  are numbers, and no lower bound exceeds its upper bound (a field no value can satisfy is an
  error).
- Formats mean what a form writes: `color` is `#rgb`, `#rgba`, `#rrggbb` or `#rrggbbaa`;
  `date` is `YYYY-MM-DD`; `time` is `HH:MM` or `HH:MM:SS` local time (the show's time zone, no
  offset); `uri` is an absolute `https` URL (an overlay's CSP loads nothing else, §4.8). A
  `media` field holds an uploaded file (`/media/<fileId>/<name>`) or an `https` URL.
- No setting value is longer than 4096 characters, whatever `maxLength` says. A `pattern` is at
  most 200 characters; it is checked with a deadline in CPU time (a busy machine waiting doesn't
  count), and a value it can't be checked against in time is refused. Shapes known to backtrack badly (a repeated group that itself repeats or
  alternates, backreferences, lookarounds) are flagged at install.
- Sizes, as UTF-8 JSON: the values an operator saves are at most 24 KiB, and the defaults
  alone at most 6 KiB, so an overlay's resolved settings fit one envelope beside their previous
  value (02 §2.9). A bound state value that would push them past that is left out.
- A template with no settings schema has no settings.
- The platform stores the values the operator set; what the template receives is the
  resolution: per field, the saved value if it is valid, else the `x-skp-bind` state value if
  present and valid, else the `default`.

Extensions (`x-skp-*`):

| Key | Effect |
|---|---|
| `x-skp-widget` | `color`, `font`, `media`, `position`, `size`, `slider`, `textarea`, `code` |
| `x-skp-labels` | Display labels for `enum` values |
| `x-skp-group` | Groups fields into a collapsible section |
| `x-skp-bind` | Default the value from a state key (still overridable). The key **MUST** be one `consumes.state` declares, or `show.scene`, which the runtime delivers to every overlay without it being declared |
| `x-skp-showIf` | `{ "field": "showPoster", "equals": true }` conditional display |
| `x-skp-preview` | `"live"` — update the preview on every keystroke instead of on blur |
| `x-skp-axis` | `"x"` or `"y"`, for a `position` widget |
| `x-skp-accept` | Accepted media types for a `media` widget, e.g. `"image/*"` |

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

// alerts: the server queues and times them; the template fills in each one (05 §5.5)
SK.alerts.render((alert, el) => { … })

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
- **Relative URLs.** The runtime serves the entry document at `/o/<slug>` and inserts, as the
  first children of `<head>`, `<base href="/o/<slug>/t/<build>/">` and the SDK `<script>`.
  Relative references in the entry document and its stylesheets therefore resolve to the pinned
  template's files. `<build>` is the first 16 hex digits (lowercase) of the SHA-256 of one line
  per file, `<path>` NUL `<lowercase hex SHA-256 of its content>` LF, with paths in UTF-8,
  `/`-separated, relative to the package root, and the lines in the byte order of those paths.
  The same content therefore has the same build whether it ships with the platform or was
  installed, on every OS and in every implementation. An upgrade changes every file URL, so
  immutable caching never serves stale files (H14). A build is not a secret (07 §7.6). Only the
  package's own files are served there, matched exactly (case included). Templates **MUST**
  use relative URLs for their own files and **MUST NOT** add a `<base>` of their own.
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

An action declares `durationMs` when it shows for a set time. One without it is instant (a hide,
a clip started or stopped) or open-ended (a card held until another action hides it), as its
template does it; its trigger still carries the platform's default `durationMs`, which such a
template ignores. The admin UI says which it is when one is fired (08 §8.4).

A template **MAY** let a setting stand for an action's declared `durationMs` (a hold time): a
trigger carrying the declared value shows for the setting; one asking for another duration shows
for that. TAKEOVER's title card does so with its `cardSec` setting, and Now playing with `npSec`,
so a button and a cue hold them as long as the overlay says.

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
  sandbox allow-scripts;
  default-src 'none';
  script-src 'self';
  style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;
  font-src 'self' https://fonts.gstatic.com data:;
  img-src 'self' data: https:;
  media-src 'self' blob:;
  connect-src 'self';
  frame-ancestors 'self';
  base-uri 'self';
  form-action 'none'
```

`sandbox allow-scripts` gives the page an origin of its own (`null`), never the platform's, in
OBS as in the admin UI's preview: a template's script can't use the operator's session or the
API, even in a browser signed in to the admin UI, and the API refuses its requests (their
`Origin` is not the platform's). Its requests to the overlay's own endpoints are cross-origin,
which those allow (`Access-Control-Allow-Origin: *`). A sandboxed page has no storage
(`localStorage` throws): a template keeps what it needs in state.

`connect-src 'self'` is what makes "templates never connect" enforceable: a template cannot
fetch from a third party even if it tries. `base-uri 'self'` allows the `<base>` the runtime
inserts (§4.5). `img-src https:` exists because avatars, emotes and
album art legitimately come from platform CDNs. Additional font hosts **MAY** be allowed only
if listed in `fonts`.

In the admin UI, previews **MUST** load in `<iframe sandbox="allow-scripts">` — *without*
`allow-same-origin` — so a template can never read the operator's session or the admin DOM.
Overlay endpoints authorize by key, not cookie, and answer `GET` with
`Access-Control-Allow-Origin: *`, which is what lets the opaque-origin preview still stream
data.

A template's files (`/o/<slug>/t/<build>/*`) are served with a sandboxing CSP
(`sandbox; default-src 'none'; …`): loaded by the overlay page they are subresources and it
changes nothing, but a package's own `.html` or `.svg` opened directly runs with no script and no
origin on the platform's host.

A template **MUST NOT** receive tokens, credentials, other overlays' data, or any state key it
did not declare.

## 4.9 Preview overrides

For development and the admin UI only, the overlay URL accepts:
`?scene=<id>` (force a scene), `?bg=dark` (opaque backdrop), `?lite=1` (drop GPU-heavy layers —
mobile previews), `?mock=1` (sample data, 08 §8.5), `?debug=1` (diagnostic HUD),
`?settings=<base64>` (unsaved settings being edited). URLs generated for OBS **MUST NOT**
include them.

## 4.10 Versioning and migration

- Overlays pin `id@version`. Installing a newer version never changes running overlays, and an
  installed `id@version` never changes: installing the same bytes again does nothing, other
  bytes with the same version are refused. A version that ships with the platform and is pinned
  by an overlay is kept even after a platform release drops it.
- `POST /overlays/{id}/upgrade` moves an overlay to a **newer** installed version of the same
  template and migrates settings: unchanged keys copy over, removed keys drop, values the new
  version no longer accepts drop, and new keys take defaults. A dry run returns the plan first:
  every change, including what `migrate.js` did, and settings the real run would refuse (too
  large, invalid) refuse the dry run too.
- A template **MAY** ship `migrate.js` for renames: a classic script defining
  `migrate(fromVersion, settings) → settings` (a line beginning `export function migrate(` or
  `export default function [name](` is accepted too), with no imports, synchronous, receiving
  the stored values and returning an object of at most 64 KiB of JSON. It runs server-side in
  an isolated context with no I/O. It runs on its own only for templates that ship with the
  platform; for an installed package it runs only when the operator allows it for that upgrade.
- Across a **major** version the UI **MUST** show what will change before upgrading. Under
  1.0.0 a minor version counts as major, and so does any move involving a prerelease. The same
  holds for any version that drops something the operator set (a value removed or no longer
  valid) or something a show or button may name (a scene, action or canvas).
- An upgrade keeps the overlay's previous version and settings. `POST /overlays/{id}/revert`
  puts them back exactly, as long as that version is still installed.

## 4.11 Validation

`POST /templates/validate` (and the same check on install) **MUST** verify: manifest against
the schema; `standard` is supported; every referenced file exists; previews exist and are images
(PNG, JPEG, WebP, GIF, SVG or AVIF) in `previews/` (error `preview-invalid`); no path
escapes; scene and action IDs unique; `show` templates provide the required core scenes; the
entry renders without throwing under `?mock=1` in a headless check when available. Errors
block install; warnings (e.g. a missing `bg` scene) are shown.

The result is a list of findings `{ level, code, path, message }`: `level` is `error` or
`warning`, `path` a file in the package or a JSON pointer into `template.json`, and `message`
says what is wrong and what to do. When no headless browser is available the result says the
check was skipped. Beyond the list above, the platform also checks: strict SemVer; core scenes
mapped once, and no scene id that is another scene's core; `then` targets and zero-length
loops; `consumes` patterns; `https` fonts and an `http(s)` `author.url`; the settings schema
(§4.3); that `migrate.js` compiles; and that the entry has no `<base>` and loads no script from
elsewhere. `template.schema.json` caps the manifest's lists (100 scenes and actions, 64
`consumes` patterns of each kind, 32 transitions, 20 previews, 8 canvases and fonts).

An installed version is checked once, at install. If its files change on disk afterwards, the
platform checks it again at the next start and doesn't serve it if it no longer passes; a
template that can't be used takes only its own overlays off air (503), never the platform.

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

## 4.13 Template sources

A template can be updated remotely: the operator follows a **source**, and the platform installs
each new release by itself.

- A source is a GitHub repository (`owner/name`, optionally pinned to one release tag) or an
  `https` URL that always serves the current package. Anything but `https` is refused, on every
  redirect hop too, and so is any hop to a private, loopback or link-local address unless the
  owner allows them (07 §7.11; `SKP_ALLOW_PRIVATE_DOWNLOADS`, 10 §10.5).
- From a GitHub release the platform takes the attached file the operator chose (a release
  file's download link, `github.com/<owner>/<name>/releases/download/<tag>/<file>`, names one),
  else the file named like the one this source installed before with its version taken out
  (`miami-or-bust-1.0.0.zip`, then `miami-or-bust-1.1.0.zip`), else the attached `.skp`, else an
  attached `.zip`, else the release's source zip (which works when `template.json` is at the
  repository's root).
- A source **MAY** follow only the releases whose tag starts with a prefix (`overlay-v`), for a
  repository that releases other things too: the operator gives it when following, or it comes
  from the tag of the newest version already installed from that repository, else from the
  first release the source installs (a bare `v` is no prefix). It then reads the repository's
  newest releases and takes the newest published one (no draft, no pre-release) with the prefix.
- A private repository needs a GitHub token with read access. The owner saves one in the admin
  UI (Settings → Integrations → GitHub, by pasting a token or signing in with GitHub's device
  flow; 07 §7.7), else the server's `SKP_GITHUB_TOKEN` (10 §10.5) is used; with neither, only
  public repositories can be read. The token is used for every GitHub request a source, an
  install or a release list makes, and it **MUST** be sent to the GitHub API only, never to the
  hosts downloads are redirected to: a private release file is downloaded through the API (its
  asset URL, `Accept: application/octet-stream`), which redirects to a signed link that gets no
  `Authorization`.
- When GitHub answers 404 (or a 403 that isn't its rate limit) for a repository or a release the
  platform says so plainly, with `fix: "connect-github"` on the problem (03 §3.2) so a client can
  link to where a token is given: "This repository is private or the GitHub token can't read it",
  then why: no token (public repositories only), the saved token's account can't read it, or
  the server's token can't. A repository that can be read but has no such release is "no
  release". The rate limit says until when it lasts.
- Before installing, a client **MAY** test a repository: whether the platform can read it, with
  which token and as whom, and its newest releases with their `.skp` and `.zip` files
  (`GET /api/v1/integrations/github/repos/<owner>/<name>/releases`), so the operator picks a
  release and its file rather than typing a tag.
- The platform checks each source on an interval (default hourly), using `ETag`s (or a URL's
  `Last-Modified`) so an unchanged release costs one small request. Downloads have the package
  limits of §4.1 and a time limit. A release that fails validation is not installed: the error
  is shown on the source, with the validation warnings of any release that does install, and a
  release that failed for good is not downloaded again until the source publishes another.
- A source installs one template id, and a template has one source: the first release fixes
  the id, a later release with another id is refused, and a first release is refused when its
  id ships with the platform, comes from another source, or is already installed from elsewhere
  (a file, a URL), unless the operator names that id when following the source. So a repository
  can't take over another template's overlays.
- A new version is installed beside the others (§4.10). Overlays on an older version of it
  that this source installed **MAY** be moved to it automatically, but only when the upgrade
  needs no confirmation under §4.10: the same major version, nothing the operator set or a show
  may name dropped, and no `migrate.js` to run for an installed package (which runs only when
  the operator allows it). The others wait for the operator, who is told. Only a version that is
  new to the source moves overlays, so the same package again never undoes a `revert`, and a
  release older than the newest installed version never moves an overlay back. An upgrade
  reloads the overlay's pages, so it **MUST NOT** happen while the overlay's show is live
  (09 §9.1): it happens at the first check after. Automatic upgrades are recorded like the
  operator's, and `revert` undoes them.
- Following a source is trusting it: its releases are code that runs in OBS and in the admin UI's
  previews (§4.8).
