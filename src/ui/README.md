# Admin UI conventions

The admin UI (standard 08) is plain ES modules, no build step and no dependencies, served from this
directory by `src/http/ui.js` (`GET /` is `index.html`, `GET /ui/<file>` everything else, all
`no-store`). It talks to the platform **only** through the public API (03), signed in with the
session cookie like any other client.

## Files

| File | What it is |
|---|---|
| `index.html` | The shell: header, navigation, `<main data-view>`, the toast region. |
| `styles.css` | Design tokens (`:root` custom properties) and every class the pages use. |
| `app.js` | Session, preferences, the hash router, the error boundary. |
| `api.js` | The API client: CSRF, If-Match, problems, paging, server time, live events. |
| `dom.js` | Building blocks: `h()`, dialogs, menus, toasts, previews, time, polling. |
| `schema-form.js` | The settings form generated from a template's schema (04 §4.3). |
| `streams.js` | A stream's status in words (On air / Offline / Unknown, CTD Relay profiles, platforms, viewers, what OBS shows, connections) and the "Fed by" form. |
| `obs.js` | Follow OBS (09 §9.7): what OBS shows in words (`obsStrip(stream)`, `byObsWords(sceneByObs)`) and the "Follow OBS" card (`followObsCard`) of a show's Details and of an overlay outside a show (its Scenes tab). |
| `time-field.js` | A time of day typed as text (`timeInput()`), the same in every browser: reads "9pm", "9:30 PM", "21:30", "2130"; on a 12-hour clock "10:30" asks for AM or PM. Its value is "HH:MM" (or "HH:MM:SS" with `seconds`), "" when empty, or "?" and the text as typed when it can't be read: never time-shaped, so a page's own check refuses it, and setting it back keeps it as typed. What's wrong shows under the box once it's left (`inline: false` when the page says it; `timeError(value)` gives the words). Use it instead of `<input type="time">`, whose AM/PM in Safari looks set before it is; the lineup, Details, cues, plans and a template's time settings do. |
| `github.js` | GitHub for templates: which token is used (`usingText`), **Test** for a repository with its releases to pick from (`repoTest`), and `problemNotice(err)`, which links a problem whose `fix` is `"connect-github"` to Settings → Integrations. |
| `pages/<section>.js` | One file per section; one exported function per route. `pages/live-overlay.js` is Live's overlay panel. |

## A page

```js
// pages/example.js — route { path: '/example/:id', page: 'example', fn: 'detail' } in app.js
import * as api from '../api.js';
import { h, mount, pageHead, every, run, toast } from '../dom.js';

export async function detail(view, ctx) {
  ctx.setTitle('Example');
  const item = await api.get(`/api/v1/examples/${api.seg(ctx.params.id)}`);
  mount(view, pageHead(item.name, { crumbs: [{ label: 'Examples', href: '#/examples' }] }), …);
  const stop = every(2000, refresh);   // polling pauses while the tab is hidden
  return () => stop();                  // cleanup: runs when the user leaves the page
}
```

`ctx` is `{ params, query, session, system, can(scope), alive(), navigate(path, { replace }),
setTitle(t), refreshSession(), signedOut(), applyPreferences(prefs), applySystem(settings) }`
(`signedOut()` after a deliberate sign-out: back to sign-in without the "session ended" error).
`ctx.session` is `GET /api/v1/auth/session`: `{ user: { id, username, role, preferences, totp… },
role, scopes, csrf, expiresAt }`.

Each render gets a `view` (`<main>`) of its own. A page the user leaves while it still loads keeps
drawing into its view, which is out of the document by then, and its `ctx.navigate` and
`ctx.setTitle` do nothing; `ctx.alive()` is false. Anything else that reaches outside the view
(`history.replaceState`, for instance) checks `ctx.alive()` first.

A page that throws while rendering gets the error boundary ("This page could not load", with Try
again); a page should still catch what it expects (a 404 → "There is no overlay "x"", with a
link back) and show it in the page.

## Rules

- **CSP.** The admin pages run under `default-src 'self'`: no inline scripts, no `style="…"`
  attributes, no `innerHTML` with anything that isn't a constant. Build DOM with `h()` (text is
  always text). Set a computed size or colour through the CSSOM (`el.style.width = …`), never an
  attribute. Images and frames load from this origin only.
- **Only the public API.** Every request goes through `api.js`. Paths take
  `api.seg(value)` for each dynamic segment.
- **H16 · If-Match on every edit.** PATCH and PUT of a resource pass the resource as last read:
  `api.patch(path, body, { ifMatch: overlay })`. On a 412 (`err.status === 412`), say "It changed
  since you opened it", reload it and let the user redo the change; never retry blindly. A DELETE
  of a resource sends it too. A 404 on a change means it was deleted meanwhile: show the page's
  "missing" view, not the server's words about an id. Commands (take a scene, fire an action, REC,
  the slot) carry no If-Match.
- **H17 · Defensive pages.** A missing optional field, a template without scenes, an empty list,
  a show without overlays — none of these may throw. Use `?.` and defaults; render an empty state
  (`empty(title, text, …actions)`).
- **H20 · Destructive actions.** Delete, reset, rotate key, revoke, remove: inside a `menu()`
  (never a top-level button), then `confirm({ title, consequence, confirmLabel })` whose
  consequence names what breaks ("OBS sources using this URL will stop working.").
- **H13 · Previews.** Use `preview(url, { width, height, label })`: on a phone it loads lite, on
  tap. Never put more than two live previews on one screen at once without `eager: false`.
- **Phones first.** Everything works one-handed at 390 px wide: tap targets ≥ 44 px (the `.btn`
  classes do this), no sideways scrolling, forms in one column. The navigation collapses under
  760 px by itself.
- **Permissions.** Hide or disable what the user's role can't do: `ctx.can('overlays:write')`.
  Scopes: `overlays:read|write|control`, `templates:read|write`, `connections:read|write`,
  `timeline:read|write`, `events:read|publish`, `state:write`, `media:write`, `audit:read`,
  `users:admin`, `system:admin`. Roles: viewer < operator < admin < owner (src/auth/roles.js).
- **Copy (08 §8.8).** Name things as users know them ("Viewer count", "Title card"), never
  internals ("state key", "envelope", "rev"). Success says what changed ("Scene changed to BRB").
  Errors are the problem's `detail` (`toast(err)` does this), which says what to do. A problem
  with `fix: "connect-github"` (a private repository, a token that can't read it) also links to
  `#/settings/integrations`: show it with `problemNotice(err)` from `github.js`.
- **Secrets typed in.** A token or password field is `type="password"`, emptied after it is sent,
  and what the server saved is never shown again (Settings → Integrations shows whose it is).
- **Accessibility (WCAG 2.2 AA).** Every control has a label (`field(label, input)`, or text, or
  `aria-label`); state is not colour alone (a dot has a label); headings in order (one `h1` per
  page, from `pageHead`); dialogs from `dialog()`/`confirm()`/`prompt()` (focus handled).
- **Busy buttons.** Wrap a request a button starts in `run(button, fn, { done })`: no double fire
  from a double tap, the outcome toasted.
- **Cleanup.** Return a function that stops polling, closes event streams and unloads previews.
- **Times.** Instants from the API are ISO 8601. Show them in the show's time zone with
  `clock(iso, show.timezone)`; countdowns use `serverNow()` from `api.js`.

## Building blocks (dom.js)

- `h(spec, attrs?, ...children)` — `h('button.btn.primary', { type: 'button', onclick }, 'Save')`.
- `mount(el, ...children)`, `q(selector, root)`.
- `toast(messageOrError, { kind, ms })`.
- `dialog({ title, body, actions, describe })`, `confirm({ title, consequence, confirmLabel, danger })`,
  `prompt({ title, intro, fields: [{ name, label, type, value, hint, required, options }], submitLabel })`.
  Closing one gives the focus back to what opened it (once `run()` enables it again); a page's own
  `<dialog>` does the same with `const back = focusBack()` when it opens and `back()` when it closes.
- `menu(label, [{ label, onSelect, danger, disabled }], { buttonClass, ariaLabel })` (ariaLabel
  tells a list of "More" buttons apart: "More for clip.mp4"). It opens on the side with room,
  focuses its first item; arrows, Home and End move, Escape closes.
- `run(button, asyncFn, { done, onError })`.
- `copy(text, message)`, `copyField(value, { label, copied })`.
- `preview(url, { width, height, label, eager, title })` → element with `.unload()`, `.reload(url?)`;
  `settingsParam(values)` for `?settings=` (a preview of unsaved settings); `isPhone()`.
- `countdown(ms)`, `clock(iso, timeZone)`, `ago(iso)`, `bytes(n)`.
- `every(ms, fn)` → stop.
- `empty(title, text, ...actions)`, `notice(text, kind)`, `badge(text, kind)`,
  `statusDot(kind, label)`, `pageHead(title, { crumbs, actions })`,
  `tabs([{ id, label, render(panel) → cleanup? }], { selected, onChange })`,
  `field(label, input, { hint, error })`.

Classes (styles.css): `.card .card-head .grid .grid.wide .stack .row .spread .muted .small
.btn(.primary|.danger|.ghost|.small|.block|.active) .pad (big console buttons) .list .table-wrap
.badge(.ok|.warn|.danger|.accent) .dot(.ok|.warn|.danger) .chips .chip .notice(.warn|.danger|.ok)
.countdown .kv .copy-field .preview .thumb(.contain|.icon) .tabs .inline-form .form-actions .field
.empty .row.center .main.dropping`. A `.card` inside a `.grid` has no top margin.

## The API client (api.js)

- `get/post/put/patch/del(path, body?, { ifMatch, query, raw, contentType, headers, signal })` → JSON;
  throws `ApiProblem { status, code, message (the detail), body }`. A change refused for a CSRF
  token another tab replaced (it signed in, changed the password, turned two-factor on or off) is
  sent once more with the session's new token; if someone else is signed in now, it isn't, and
  `onSessionChanged(fn)` tells the app.
- `onSessionEnded(fn)`: the session is over (signed out, a 401, someone else's session): drop
  what belongs to it (Media's upload queue). `endSession()` after a deliberate sign-out.
- `all(path, { query })` — every item of a paged list.
- `etagOf(resource)`, `seg(value)`, `serverNow()`.
- `events(types, onEvent, { onStatus })` → stop; exact event types, e.g.
  `['show.scene', 'system.connection']`.

## Settings form (schema-form.js)

```js
import { schemaForm } from '../schema-form.js';
const form = schemaForm({
  schema,          // the template's settings schema (an object schema; $ref into definitions resolved)
  definitions,     // the manifest's definitions, for $ref
  values,          // the overlay's saved settings ({} when none)
  resolved,        // what the overlay sees now (defaults and bound values applied), shown as placeholders
  onChange,        // (values, { live }) — live is true for x-skp-preview: "live" fields while typing
  mediaList,       // async () => [{ url, name, type }] for media fields (may be undefined)
  saved,           // names of writeOnly (secret) fields that hold a value: "Saved" as their placeholder
});
form.el;           // the form's element, a <div> (no submit button: the page adds Save/Reset;
                   // put it in a <form> if Enter should save)
form.values();     // the current values, only fields the user set (empty → left out); may hold
                   // invalid ones: validate() first
form.validate();   // [] or [{ path, message }] (JSON pointers, '/' for the 24 KiB limit); marks
                   // the fields and opens their sections
form.reset(values, resolved) // show these values (and, given resolved, update the placeholders)
```

The same form edits a connection's settings (a connector's `fields`). A `writeOnly` field is a
secret: a password input that is never filled in (the API never sends a secret back), and left
empty keeps what is saved. The Connections page splits `values()` into `config` and `secrets` by
`writeOnly`.

## Live (pages/live.js, pages/live-overlay.js)

Several streams at once: a stream is a show, or an overlay outside a show, fed by the connections
its overlays are bound to. `#/live` lists every stream (`stream` on `GET /api/v1/shows` and
`/overlays`: `onAir` true, false, or absent for "Unknown", never shown as "Offline"; viewers absent,
never 0), polled every 3 s and on `system.connection`. `#/live?show=<id>&overlay=<slug>` is a
show's console, the whole show or one member's panel (`overlayPanel(ctx, { ref, show,
onWholeShow, onOverlay })`: preview, URLs, actions, Simulate, what feeds it); the choice is kept
with `history.replaceState` after `ctx.alive()`. `#/live?overlay=<slug>` is an overlay outside a
show (a member opens in its show's console). What feeds an overlay is edited on its settings tab
("Fed by", `fedByForm()` from `streams.js`, If-Match) or for every member on the show's Details.
A CTD Relay connection that follows every profile (`everyProfile` and `profiles` in `GET
/api/v1/system/health`) is offered whole ("All its profiles, including new ones") and profile by
profile ("Relay · DPRTMNT (Live)"), saved as `"<connection id>/<profile id>"`; while the
whole connection is ticked its profiles show ticked and "included", not changeable; a profile
saved that it doesn't follow any more is kept and says so. `bindingName()` names an entry.

A stream whose connections report OBS (`stream.obs`, CTD Relay's OBS events) shows a line per
feed: "OBS · landscape: Live · vertical: BRB V · Streaming · Recording". A show's console (and an
overlay's panel outside a show) says "Set by OBS (BRB, landscape) at 9:41 PM" while the scene on
now is one OBS took (`sceneByObs`). **Follow OBS** (`followObsCard()` from `obs.js`, on the show's
Details and an overlay's Scenes tab): on or off, whose OBS (the one that feeds it, or one picked
when several do), the canvas that drives it, and per OBS scene a select of the templates' scenes
("Leave the scene as it is" for none). The OBS scenes listed are those OBS has shown
(`stream.obs[].seen`), the one on now marked, plus the mapped ones and any typed in with **Add**;
"Any other OBS scene" is `otherwise`. Saved with If-Match; a 412 says so and shows it as it is now.

## Integrations: GitHub (pages/settings.js, github.js)

`#/settings/integrations` (whoever has `templates:write`): the GitHub card says which token template
installs and update checks use ("Connected as @login · saved <date>", "Using SKP_GITHUB_TOKEN from
the server's environment", "Not connected: public repositories only"). The owner (`system:admin`)
saves a token (a password field, checked by the server with GitHub, never shown again), replaces
it, or disconnects (in a menu, behind a confirmation); with an OAuth app's client ID saved (or
SKP_GITHUB_CLIENT_ID) also **Sign in with GitHub**: the code, the link to github.com/login/device,
a countdown, polled every 2 s. **Test a repository** reads a repository's releases without
installing. The Templates page's install dialog has the same **Test** beside its GitHub field: a
release (newest published one chosen) and its file (chosen when there is one) install by its
download link, and "Install its new releases by themselves" follows the repository after.

## Connections (pages/connections.js)

`#/connections` (list, live from `system.connection`), `#/connections/new/:connector` (the setup
guide: warnings first, steps, the redirect URI with Copy, scopes and why; then the form) and
`#/connections/:id` (status, sign-in: a device code with its countdown, or a redirect with the
always-visible **Finish sign-in** paste box; what it feeds; actions; settings with If-Match).
A connector that pairs (`auth: 'pairing'`, CTD Relay) is set up with its address and
**Connect** (the whole form under **Paste a token instead**); its page shows the code, the link
to approve it and the countdown, then **Connect again**. A connection's `info` shows the profile
it follows, or every profile with each one's status (`profileChip()` from `streams.js`: its
colour, never alone), the values each profile sets (`feeds`), and what it shares with the OBS
plugin; a setting marked `x-skp-choices` is a select of `info.choices[field]`, hidden
(its value kept) while the connection offers none. The settings form is drawn again when the
connection's version changes and nobody is editing it.
Owners and admins only (`connections:read`/`write`); operators get each connection's status
from `GET /api/v1/system/health`. Delete and Sign out are in a menu, behind a confirmation that
names the consequence.

## An overlay that reads a show (show-from-overlay.js)

Set times, who's on, the countdown, REC and title cards live on a show; its members read them as
`show.*` state. A template that reads who's on (`readsLineup(manifest)`: `consumes.state` matching
`show.lineup`, `show.currentSlot` or `show.headliner`) gets none of it on an overlay outside a
show, so the UI says so: `showParts(manifest)` / `showWords(manifest)` name what it reads ("Set
times, the countdown, REC and title cards come from a show."), `needsShow(overlay, manifest)` is
true outside a show, and `showNotice(ctx, { overlay, manifest, canAdd, compact, times, onAdded })`
is the notice with **Make a show from this overlay** and (`canAdd`: there are shows) **Add it to
a show**. It is first on the overlay's page (above the previews), on its Live card (`compact`),
and first in its Live console (`overlayPanel(…).needs`, which reads the shows again while it is
on, so a show made meanwhile brings **Add it to a show**), whose Actions add why a title card
shows nothing (actions outside a show fire with no act named, and say "sent", not "on air").

A template that reads only a show's times (`show.goLiveAt`, `show.recStartedAt`: a clock) may have
a time of its own: `wantsShowTimes(overlay, manifest)`, and `showNotice(…, { times: true })` is a
quiet line instead (`.show-times`: "With no time of its own, the countdown runs to a show's
go-live…", the same two buttons, not primary), on the overlay's page only. `sampleWords(manifest)`
is what Sample data makes up of a show, for the preview's note.

`makeShow(ctx, overlay, { manifest })` is a form dialog like Shows' New show (name: the template's,
free among the shows; date: the show's night now in the zone chosen, as New show has it, from
`show-day.js`: before the 12:00 day boundary, the night before; in words with the quick picks;
following the zone until picked; time zone: this device's; go-live: optional) with the template's
other overlays in no show ticked; `POST /api/v1/shows`, then `#/shows/<id>?tab=lineup`.
`addToShow(ctx, overlay, { manifest })` picks a show (the one an overlay of the same template is
in first; the same twins ticked) and `PATCH`es its `overlays` with the show as listed for
If-Match; a 412 or 404 keeps the dialog open, says so, and lists the shows again. In both, a 409
`in-other-show` (a twin put in another show meanwhile) reads the overlays again, unticks and greys
that twin ("in "Sneaky" now") and says so in plain words. Both open at their top (the focus on
the first field without scrolling), never touch `connections` (a show is fed by what feeds its
members), and say what feeds them.

`show-day.js` is Shows' show-day rules for a dialog outside Shows: `browserZone()`,
`showDayNow(zone, boundary)`, `dateLabel(ymd, long)`, `dateField(label, input, { hint, zone,
boundary, weekdays })` (the date in words and its quick picks, `.refresh()` after the zone changes)
and `zoneInput(value)`. shows.js still has its own copy of them.

On the overlay page, sample data on such an overlay says what it makes up; an overlay in a show
links its show's Lineup and Details. Settings are each overlay's own: after a save, the settings
that changed (compared key by key) are offered to the other overlays of the same template in the
show it is in now (`overlay.show` from the save's answer, not the page's first read) that hold
something else (`.also-change`: "Also change: takeover-v"), read fresh for the offer, and only
the keys each one's own version has (its pinned manifest; one on an older version is told what it
lacks and that upgrading gives it); taking it PATCHes each with its own If-Match and only those
keys, says what was refused and why in plain words, and offers the refused ones again as they are
now, but not one refused with a 422 (its version can't take the value).
