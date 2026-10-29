# Template authoring guide (CTD Overlay · Stream Kit Platform `skp/1`)

Everything needed to write an overlay template for CTD Overlay, in one file. It is written so that
a designer, a developer or an AI assistant can produce a template that installs and runs first
time. The normative source is [docs/standard/04-templates.md](../standard/04-templates.md) (and 02,
05); where this guide and the standard disagree, the standard wins.

A complete, working example that uses every feature sits beside this file: [`mega/`](mega/). For a
small overlay, start from [`starter/`](starter/) instead; [NEW-OVERLAY.md](NEW-OVERLAY.md) is a
brief to fill in and hand to an AI assistant.

---

## 1. What a template is (and is not)

A template is **a design**: HTML, CSS and JavaScript that draw an overlay in an OBS browser source.
It decides how things look, where they sit and how they move.

It is **not** an integration. A template never connects to Twitch, Kick, YouTube, Spotify, OBS or
anything else, never holds a token, and never fetches data. The platform does all of that and
hands the template normalized data through the runtime SDK, a global object `SK`. The page's
Content-Security-Policy enforces it: a template's `fetch` to another host fails.

One template can be a whole show package (countdown, live, BRB, timetable, intros) or a single
widget (a chat box, an alert, a viewer count). Users stack several overlays in OBS.

## 2. The package

```
my-template/
├── template.json      the manifest (required)
├── index.html         the entry document (required; name set by "entry")
├── template.css
├── template.js
├── assets/            images, fonts, video, sounds the template ships
├── previews/          at least one picture for the gallery (required): PNG, JPEG, WebP, GIF, SVG or AVIF
└── migrate.js         optional: settings migration between versions (§13)
```

- Install it as a folder (`skp template install ./my-template`), a `.zip` or `.skp` (a zip; `skp
  template pack ./my-template` makes one), an https URL, or a GitHub repository's releases.
- `template.json` sits at the zip's root, or inside one top-level folder.
- Paths: relative, lowercase recommended, no `..`, no absolute paths, no symlinks, no
  Windows-reserved names (`con`, `nul`, `com1` …) or characters (`< > : " | ? *`), no two paths that
  differ only in case.
- Limits: archive and total uncompressed size 100 MiB; one file 50 MiB.
- **Everything the template loads at runtime must be inside the package**, except images the data
  points to (avatars, emotes, album art) and fonts from Google Fonts (or hosts listed in `fonts`).

## 3. The manifest: `template.json`

```json
{
  "standard": "skp/1",
  "id": "com.yourname.my-template",
  "name": "My Template",
  "version": "1.0.0",
  "description": "One or two sentences for the gallery.",
  "author": { "name": "Your Name", "url": "https://example.com" },
  "license": "MIT",
  "category": "show",
  "tags": ["event", "dj"],
  "entry": "index.html",
  "previews": ["previews/main.png"],
  "engines": { "obs": ">=30" },
  "canvases": [ { "id": "h", "width": 1920, "height": 1080, "default": true }, { "id": "v", "width": 1080, "height": 1920 } ],
  "scenes": [ { "id": "program", "label": "Live", "core": "program", "transparent": true } ],
  "consumes": { "state": ["viewers.total"], "events": ["show.trigger"], "chat": { "recent": 20, "max": 12 } },
  "actions": [ { "id": "titleCard", "label": "DJ title card", "durationMs": 7000 } ],
  "alerts": { "mode": "serial", "durationMs": 6000, "gapMs": 500 },
  "fonts": ["https://fonts.googleapis.com/css2?family=Archivo:wght@500;800&display=swap"],
  "settings": { "type": "object", "additionalProperties": false, "properties": { } }
}
```

| Field | Rules |
|---|---|
| `standard` | Always `"skp/1"`. |
| `id` | Reverse-DNS (`com.yourname.thing`), lowercase, at most 100 characters, never changes for the life of the template. Don't use the bundled ids (`com.dprtmnt.takeover`, `com.dprtmnt.chat`, `com.dprtmnt.alerts`, `com.ctd.text-clock`, `dev.skp.*`). |
| `version` | Strict SemVer `MAJOR.MINOR.PATCH` (no leading zeros, no `+build`). A given id@version can never be installed with different bytes: bump the version for every change. |
| `name`, `description` | Shown in the gallery. |
| `author` | `{ "name", "url"? }`; `url` must be http(s). |
| `category` | One of `show`, `chat`, `alerts`, `now-playing`, `lower-third`, `background`, `ticker`, `goal`, `scoreboard`, `widget`. |
| `tags` | Short words for search. |
| `entry` | The HTML file (usually `index.html`). |
| `previews` | 1 to 20 images under `previews/`. |
| `engines` | `{ "obs": ">=30" }`. OBS 30's browser is **Chromium 103**: no `color-mix()`, `:has()`, CSS nesting, container queries or `structuredClone`. |
| `canvases` | 1 to 8 sizes `{ id, width, height, default? }`; exactly one default. The OBS source is set to that size; `?canvas=<id>` picks another (`h` and `v` by convention). |
| `scenes` | See §7. At least one. |
| `consumes` | What data the template receives (§5). **Anything not declared never arrives.** |
| `actions` | Named moments with buttons and cues (§8). Optional. |
| `alerts` | How the server queues alerts for it (§10). Optional; needed only if it shows alerts. |
| `transitions` | Optional stingers: `[{ "id": "stinger", "media": "assets/stinger.webm", "cutAtMs": 420 }]`. `cut` and `fade` exist already. |
| `fonts` | Up to 8 https font stylesheet URLs (Google Fonts). |
| `settings` | The settings form, as JSON Schema (§4). Or `{ "$ref": "#/definitions/settings" }` with the schema under `"definitions"`. |

Validation also checks: ids of scenes, actions and canvases are unique; core scenes are mapped
once; `show` templates have `starting`, `program`, `brb` and `outro`; timed scenes' `then` targets
exist and don't loop; every file referenced exists; the entry has no `<base>` and loads no script
from elsewhere; `migrate.js` compiles.

## 4. Settings: the form the operator fills in

The admin UI builds the settings form from this schema; templates never ship their own settings UI.
The template reads the values with `SK.settings` and hears changes with `SK.onSettings`.

```json
"settings": {
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "accent":     { "type": "string", "format": "color", "title": "Accent", "default": "#16E0FF" },
    "title":      { "type": "string", "title": "Show title", "maxLength": 60, "default": "SATURDAY NIGHT" },
    "headliner":  { "type": "string", "title": "Headliner", "x-skp-bind": "show.headliner" },
    "style":      { "type": "string", "title": "Style", "enum": ["a", "b"], "x-skp-labels": ["Bold", "Calm"], "default": "a" },
    "grain":      { "type": "boolean", "title": "Film grain", "default": true },
    "size":       { "type": "integer", "title": "Text size", "minimum": 16, "maximum": 48, "default": 26, "x-skp-widget": "slider" },
    "logo":       { "type": "string", "title": "Logo", "x-skp-widget": "media", "x-skp-accept": "image/*" },
    "lines":      { "type": "array", "title": "Ticker lines", "items": { "type": "string", "maxLength": 60 }, "maxItems": 12, "default": [] },
    "box":        { "type": "object", "title": "Chat box", "additionalProperties": false, "properties": {
                      "x": { "type": "integer", "title": "Left", "minimum": 0, "maximum": 1920, "default": 40, "x-skp-widget": "position", "x-skp-axis": "x" } } }
  }
}
```

**Supported:** `string`, `number`, `integer`, `boolean`, `enum`, `array` of primitives, nested
`object` (a group, at most 3 deep, no default of its own), `default`, `minimum`/`maximum`,
`minLength`/`maxLength`, `pattern` (≤ 200 characters, no backtracking-prone shapes),
`minItems`/`maxItems`/`uniqueItems`, `additionalProperties: false`, `title`, `description`,
`examples`, `$ref` to the manifest's own `definitions`, and `format`: `color` (`#rgb`, `#rgba`,
`#rrggbb`, `#rrggbbaa`), `uri` (absolute https), `date` (`YYYY-MM-DD`), `time` (`HH:MM` or
`HH:MM:SS`).

**Refused** (install fails): `oneOf`/`anyOf`/`allOf`/`not`, `if`/`then`, `const`, `required`,
`multipleOf`, anything not listed above. Every field has exactly one `type`; names look like
identifiers (`^[A-Za-z][A-Za-z0-9_]*$`).

**Extensions:**

| Key | Effect |
|---|---|
| `x-skp-widget` | `color`, `font`, `media` (an uploaded file `/media/<id>/<name>` or an https URL), `position`, `size`, `slider`, `textarea`, `code` |
| `x-skp-labels` | Display labels for `enum` values, same order |
| `x-skp-group` | Puts the field in a collapsible section with that name |
| `x-skp-bind` | Defaults the value from a state key (e.g. `show.headliner`); the operator can still override. The key must be one `consumes.state` declares (or `show.scene`). |
| `x-skp-showIf` | `{ "field": "ticker", "equals": true }`: show this field only then |
| `x-skp-preview` | `"live"`: the preview updates on every keystroke |
| `x-skp-axis` | `"x"` or `"y"` for a `position` widget |
| `x-skp-accept` | Media types for a `media` widget: `"image/*"`, `"video/*"`, `"audio/*"` |

**What the template receives** is the resolution, per field: the operator's saved value if valid,
else the bound state value, else the `default`. Write code that tolerates a missing value anyway.
Limits: each value ≤ 4096 characters; saved values ≤ 24 KiB of JSON; defaults ≤ 6 KiB.

Design tip: expose the tokens a user would restyle (`accent`, a font choice, sizes, positions,
copy) as settings: then the same template serves many events without code.

## 5. The data a template can use

Declare it in `consumes`; read it through `SK`. Patterns: an exact name, or a prefix ending in
`.*` (`show.*`, `alert.*`).

### State (current values: `SK.state(key)`, `SK.onState(key, fn)`)

| Key | Value |
|---|---|
| `viewers.total` | integer: viewers summed over the connected platforms |
| `viewers.<platform>` | integer for one platform (`viewers.twitch`, `viewers.kick`, `viewers.youtube` …) |
| `viewers.stale` | `true` while a count is held through an error (show it quieter) |
| `stream.<platform>.live` / `.title` / `.startedAt` | boolean / string / epoch ms |
| `stream.clock` | `{ startedAt?, fps, offsetMs, at }`: the stream's start on server time (absent while off air) and its frame rate, from CTD Relay. Run time is `SK.clock.now() − startedAt`; a timecode's frames `floor((ms mod 1000) × fps / 1000)`. Compute them yourself as you paint |
| `music.nowPlaying` | a Track: `{ title, artists[], album, art, url, durationMs, progressMs, progressAt, playing, source }` (use `SK.music`) |
| `show.scene` | the overlay's current scene id (always delivered) |
| `show.lineup` | `[{ time "HH:MM", name, b2b?, headliner?, closer?, logo?, startAt (epoch ms) }]`, in night order |
| `show.currentSlot` | integer index into `show.lineup` of who is on, or absent |
| `show.nobodyOn` | `true` while the operator said nobody is on: show no act, even if you go by the lineup's times when nobody is picked |
| `show.headliner` | the name of the act flagged headliner (the headliner and the closer are different) |
| `show.date` | `YYYY-MM-DD` |
| `show.timezone` | the show's IANA time zone (`America/Toronto`) |
| `show.goLiveAt` | epoch ms of go-live (for a countdown) |
| `show.recStartedAt` | epoch ms since when the show is live (for a REC timer) |
| `custom.*`, `x-<vendor>.*` | values other apps set through the API |

**The absence rule (hard rule H6).** Unknown is *absent*, not `0`. When a key is absent, hide the
element. Never print `0`, `undefined`, `NaN` or an empty number in place of a value you don't
have. Only an authoritative report is `0`.

### Events (`SK.on(type, fn)`)

| Type | Data |
|---|---|
| `show.trigger` | `{ name, args, startAt, durationMs }`: prefer `SK.action` (§8), which handles timing |
| `alert.<kind>` | an alert (§10); prefer `SK.alerts.render` |
| `chat.*` | chat (§9); prefer `SK.chat` |
| `media.play` / `media.stop` | `{ mediaId, url }`: play an uploaded clip |
| `custom.*`, `x-<vendor>.*` | anything other apps publish |

## 6. The runtime SDK: `SK`

The runtime injects `/sdk/v1/sk.js` before your scripts; `SK` is a frozen global. Every
`on…`/`onState`/`chat.on…` call returns a function that unsubscribes.

```js
SK.ready(fn)                      // run fn once the snapshot is in and settings are resolved
SK.settings                       // resolved settings (object)
SK.onSettings(fn)                 // fn(settings) on every change (the operator editing)

SK.state(key)                     // current value, or undefined (absent)
SK.onState('viewers.total', (value, prev) => …)   // also fires once at ready
SK.onState('show.*', (key, value, prev) => …)      // a prefix: gets the key too

SK.on('alert.*', (envelope) => …) // events you declared; envelope = { id, type, ts, src, data }

SK.scene                          // current scene id
SK.onScene((id, prev, transition, root) => …)      // root: the new scene's root element
SK.defineScene(id, (ctx) => elementOrFragment)     // build a scene in code; ctx = { scene, root, settings, canvas, onExit(fn) }

SK.action('titleCard', ({ args, startAt, durationMs, lateMs }) => …)

SK.chat.recent()                  // messages still visible, oldest first
SK.chat.onAdd((message, { initial }) => element)   // return an element: the runtime mounts and manages it
SK.chat.onRemove((messageId) => …)                 // a moderation removal (already taken off screen)
SK.chat.onClear(() => …)

SK.alerts.render((alert, element) => …)            // fill the element; may return a promise (≤ 250 ms)

SK.music.track()                  // the Track, or undefined
SK.music.progress()               // its progress in ms, interpolated locally (never poll)

SK.mount(el, { enter?, durationMs?, offsetMs?, cut? })   // insert with data-skp-state="enter" → "idle"
SK.unmount(el, { exit? })         // data-skp-state="exit", removed after the exit; returns a promise
SK.preload(urls)                  // decode images ahead of a reveal (resolves; never rejects)

SK.clock.now()                    // server time, epoch ms (use it, not Date.now())
SK.clock.at(ts, fn)               // run fn at server time ts; returns cancel()

SK.canvas                         // { id, width, height }
SK.env                            // { preview, lite, reducedMotion, obs }
SK.asset('assets/poster.jpg')     // the versioned URL of a file in the package
SK.log.info|warn|error(msg, ctx)  // to the platform's template log (rate-limited)
SK.meta                           // the manifest's data the runtime got (id, version, scenes, actions …)
```

Never `localStorage`/`sessionStorage`/cookies (the page is sandboxed: they throw), never `fetch`
(blocked), never `requestAnimationFrame` for correctness.

## 7. Scenes

Scenes are full-frame states of the overlay: Starting Soon, Live, BRB … The operator (or the
timeline) takes a scene; every overlay of a show changes together.

```json
"scenes": [
  { "id": "auto",     "label": "Auto",           "core": "auto" },
  { "id": "starting", "label": "Starting Soon",  "core": "starting" },
  { "id": "program",  "label": "Live",           "core": "program", "transparent": true },
  { "id": "brb",      "label": "Be Right Back",  "core": "brb" },
  { "id": "lineup",   "label": "Timetable",      "core": "lineup" },
  { "id": "outro",    "label": "Thanks For Watching", "core": "outro" },
  { "id": "bg",       "label": "Background",     "core": "bg" },
  { "id": "intro",    "label": "Event Intro",    "core": "intro", "durationMs": 8000, "then": "program" },
  { "id": "shoutout", "label": "Headliner Intro", "durationMs": 6000, "then": "program" }
]
```

- **Core scenes** (`core`): `auto`, `starting`, `program`, `brb`, `lineup`, `outro`, `bg`,
  `intro`. They let shows, timelines and buttons work across templates. A `show` template must
  provide `starting`, `program`, `brb` and `outro`, and should provide all eight. Each core is
  mapped by at most one scene.
- **Extras**: scenes without `core` (`shoutout` above). They appear as extra buttons only for
  templates that have them.
- **Timed scenes**: `durationMs` + `then` (a scene id or core of this template). The server
  returns to `then` by itself.
- **`transparent: true`**: the scene shows the camera underneath (the live scene). Otherwise the
  scene draws its own background. The page background is always transparent.
- **`auto`** is yours to implement: show Starting Soon until `show.goLiveAt`, then Live (see
  `mega/template.js`: `SK.defineScene('auto', …)` with `SK.clock.at(goLiveAt, …)`).

**Provide each scene's markup** declaratively:

```html
<template data-skp-scene="brb">
  <div class="scene"><h1>BE RIGHT BACK</h1></div>
</template>
```

or in code: `SK.defineScene('brb', (ctx) => element)`. The runtime mounts the new scene root
(`<section data-skp-scene-root="brb">`), runs the outgoing exit and the incoming enter together
(crossfade by default), then removes the old one. Style transitions in CSS:

```css
[data-skp-scene-root][data-skp-state="enter"] { animation: sceneIn .5s ease both; }
[data-skp-scene-root][data-skp-state="exit"]  { animation: sceneOut .5s ease both; }
```

A `cut` skips them. Fill dynamic content in `SK.onScene((id, prev, transition, root) => …)` and
again when state changes.

## 8. Actions

Named moments: a title card, a now-playing lower third, an announcement. Declaring one gives it a
button in the admin UI, a cue type on the timeline, and an API endpoint, with no extra work.

```json
"actions": [ { "id": "titleCard", "label": "DJ title card", "durationMs": 7000 } ]
```
```js
SK.action('titleCard', ({ args, startAt, durationMs, lateMs }) => {
  const card = makeCard(args.name);                // args from the button, cue or API (may be {})
  document.querySelector('[data-actions]').append(card);
  SK.mount(card);
  SK.clock.at(startAt + durationMs - 450, () => SK.unmount(card)); // exit ends with the window
});
```

The runtime calls the handler at `startAt` on server time, on every source at once, so the 16:9
and 9:16 feeds land on the same frame. A trigger that arrives late but inside its window runs at
once with `lateMs`; one whose window has passed is dropped.

## 9. Chat

```json
"consumes": { "chat": { "recent": 30, "max": 30 } }
```
`recent`: how many past messages a freshly loaded overlay gets (0–200). `max`: the most kept on
screen (the oldest leave first).

```html
<div class="chat" data-skp-chat></div>   <!-- the runtime appends messages here -->
```
```js
SK.chat.onAdd((m, { initial }) => {
  const el = document.createElement('div');
  el.className = 'msg';
  // build from m.user.name, m.user.color, m.user.roles and m.fragments (below); return it
  return el;                       // return nothing to skip a message
});
```

The runtime paces messages (at most 4 per 250 ms), mounts what you return, keeps `max` on screen,
and **takes deleted messages and banned users' messages off by itself**. Animate with
`.msg[data-skp-state="enter"]` / `="exit"`.

A message (`chat.message`):

```json
{
  "id": "twitch:9d0a…", "platform": "twitch", "platformMessageId": "9d0a…", "channel": "dprtmnt",
  "user": { "id": "twitch:144552210", "login": "djfan", "name": "DJFan", "color": "#1E90FF",
            "avatar": null, "roles": ["subscriber", "vip"], "badges": [ { "id": "subscriber/12", "label": "subscriber" } ] },
  "text": "this set is fire Kappa",
  "fragments": [ { "type": "text", "text": "this set is fire " }, { "type": "emote", "text": "Kappa", "image": "https://…/2.0" } ],
  "reply": null, "highlighted": false, "action": false, "kind": "message", "ts": 1791830000123
}
```

- Render from `fragments` (emotes are https images); fall back to `text`. Treat an unknown fragment
  type as text. Fragment types: `text`, `emote`, `mention`, `link`, `cheermote`.
- `roles` ⊆ `broadcaster`, `moderator`, `vip`, `subscriber`, `member`, `verified`, `founder`,
  `artist`, `bot`. Style roles, not platform badges.
- `color` may be null (YouTube): use your accent.
- `kind: "event"` is a platform notice line (sub, raid…): style it apart, or hide it if an alerts
  overlay shows the same thing.
- `platform` may be missing; the prefix of `user.id` (`twitch:…`) tells it too.
- Set text with `textContent` / text nodes. Never `innerHTML` with chat in it.

## 10. Alerts

```json
"consumes": { "events": ["alert.*"] },
"alerts": { "mode": "serial", "durationMs": 6000, "durationSetting": "alertMs", "gapMs": 500 }
```
```html
<div class="alerts" data-skp-alerts></div>   <!-- where alert elements go -->
```
```js
SK.alerts.render((alert, el) => {
  el.className = 'alert alert--' + alert.kind;
  el.append(line(alert.user.name), line(amountText(alert)));
});
```
```css
.alert[data-skp-state="enter"] { animation: rise .6s cubic-bezier(.2,.7,.2,1) both; }
.alert[data-skp-state="exit"]  { animation: drop .45s ease-in both; }
```

The **server** queues alerts (one at a time with `serial`, several with `stack` and
`maxConcurrent`), gives each a display window in server time, and the runtime creates, mounts and
unmounts the element: the template only fills it. Priority: raid, superchat/tip, gift,
subscription, membership, cheer/kicks, follow. `durationSetting` names a numeric setting (ms) the
operator can tune (clamped 1000–60000).

An alert:

```json
{ "kind": "subscription", "user": { "id": "twitch:1445", "name": "DJFan", "avatar": "https://…" },
  "amount": { "unit": "months", "value": 12 }, "tier": "1000",
  "message": { "text": "a year of DPRTMNT!" }, "gift": null, "platform": "twitch" }
```

| `kind` | `amount.unit` |
|---|---|
| `follow` | — |
| `subscription` | `months` (`tier`: `1000`/`2000`/`3000`/`Prime` on Twitch, `1`/`2`/`3` elsewhere) |
| `gift` | `count` (`gift`: `{ total, recipients? }`) |
| `cheer` | `bits` |
| `kicks` | `kicks` |
| `raid` | `viewers` |
| `membership` | `months` |
| `superchat`, `tip` | `currency`: `value` is a **decimal string** (`"5.00"`) with an ISO 4217 `currency`; format with `Intl.NumberFormat`, never as a float |

Fields that don't apply are left out. `user.anonymous: true` means show "Anonymous".

## 11. Motion, timing and performance

- **Lifecycle**: anything the runtime mounts moves through `data-skp-state="enter"` → `"idle"`
  → `"exit"` → removed. Put all motion in CSS on those states. Duration comes from
  `--skp-enter-ms` / `--skp-exit-ms`, else the CSS animation's duration.
- **Never gate correctness on `requestAnimationFrame` or `animationend`** (hard rule H9): OBS stops
  painting hidden sources and throttles timers. Use CSS animations for motion, and timers or
  `SK.clock.at` for state.
- **Server time**: `SK.clock.now()` and `SK.clock.at()`, never `Date.now()` for anything shown on
  two sources (countdowns, REC, actions).
- **Performance**: animate `transform` and `opacity` only; at most two infinite animations per
  scene; decode large images ahead with `SK.preload`; cap canvas/WebGL at 30 fps.
- **Don't** use `backdrop-filter` (a browser source can't see the camera: it blurs nothing) or
  `mix-blend-mode` on transparent scenes (it composites to black) (hard rule H10).
- **Lite mode** (`SK.env.lite`, `<html data-skp-lite>`): phone previews. Drop blur, grain,
  particles and video there.
- **Reduced motion** (`<html data-skp-reduced-motion>`, admin previews only): shorten motion.

## 12. Layout and the page

- The runtime sets `<html data-skp-canvas="h" data-skp-scene="program">` and scales a stage of the
  canvas size to the browser source. **Lay out in canvas pixels**; never compute scaling.
- Style per canvas with `[data-skp-canvas="v"] .thing { … }`.
- Relative URLs only for your own files (the runtime adds `<base>`); don't add a `<base>`.
- **Allowed to load**: your package's files; images from any https URL (avatars, emotes, art);
  fonts from Google Fonts or hosts listed in `fonts`; uploaded media (`/media/…`) as images, video
  and audio. **Blocked**: scripts from elsewhere, `fetch`/XHR/WebSocket anywhere but the platform,
  iframes, forms, storage.
- The page background is transparent; scenes paint their own.
- Render something sensible with no data at all (no connections, empty lineup, absent values).
- Don't put the operator's choices in the URL: OBS URLs never change; everything configurable is
  a setting.

## 13. Versions and migration

- Overlays pin `id@version`; installing a newer version doesn't touch running overlays until the
  operator upgrades (the admin UI shows what changes).
- On upgrade, settings with the same key copy over; removed keys drop; new keys take defaults.
- For renames, ship `migrate.js`:
  ```js
  function migrate(fromVersion, settings) {
    if (settings.colour !== undefined) { settings.accent = settings.colour; delete settings.colour; }
    return settings;
  }
  ```
  Synchronous, no imports, at most 64 KiB of JSON returned.
- A major version (or anything under 1.0.0 at a minor) asks the operator first.

## 14. Testing it

1. **Validate**: `npm run skp -- template validate ./my-template` (or Templates → Install in the
   admin UI, which shows the findings before installing).
2. **Install**: `npm run skp -- template install ./my-template` (platform stopped), or upload the
   `.zip` in Templates → Install.
3. **Preview with sample data**: Templates → your template shows a live preview at each canvas
   with sample data (a lineup, a chat with every role and a long name and a deleted message, every
   alert kind including a gift burst, a track, changing viewer counts). The URL works directly
   too: `/o/~p.<id>@<version>?mock=1&canvas=v&scene=brb` (signed in).
4. **Overrides** on any overlay URL, for development only: `?scene=<id>`, `?mock=1`, `?bg=dark`,
   `?lite=1`, `?debug=1` (a status panel), `?canvas=<id>`.
5. **Simulate** on a real overlay: the overlay page's Simulate panel sends a chat message, a
   follow, gifted subs, a raid, a track change, viewers going absent.
6. In OBS: add a Browser source with the overlay's URL and the canvas size (Overlays → Copy URL
   shows both).

## 15. Checklist before you ship

- [ ] `template.json` validates; version bumped since the last install.
- [ ] Every scene id in `scenes` has a `<template data-skp-scene>` or `SK.defineScene`.
- [ ] Every action in `actions` has an `SK.action` handler; every state/event/chat use is declared
      in `consumes`.
- [ ] Absent values hide their element (no `0`, `undefined`, `NaN`).
- [ ] No `innerHTML` with data; text via `textContent`.
- [ ] No `requestAnimationFrame`/`animationend` for state; server time via `SK.clock`.
- [ ] Works at every canvas; nothing off-frame; long names wrap or truncate.
- [ ] Looks right with no data, with sample data (`?mock=1`), and in `?lite=1`.
- [ ] No modern CSS OBS 30 lacks (`color-mix`, `:has`, nesting, container queries).
- [ ] Previews in `previews/`.

## 16. The reference template

[`mega/`](mega/) is a complete show package that uses every feature above: all eight core scenes
plus a timed extra; declarative scenes and an imperative `auto`; actions with arguments; settings
of every type, widget, group, binding and condition; the lineup with headliner and closer; a
go-live countdown and REC timer on server time; viewers with the absence and stale rules; now
playing with interpolated progress; chat; alerts from the server queue; a ticker; a packaged asset
through `SK.asset`; lite mode and reduced motion; 16:9 and 9:16. Copy it, rename the id, and change
the design.
