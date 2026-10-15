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
| `pages/<section>.js` | One file per section; one exported function per route. |

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

`ctx` is `{ params, query, session, system, can(scope), navigate(path, { replace }), setTitle(t),
refreshSession(), signedOut(), applyPreferences(prefs), applySystem(settings) }` (`signedOut()`
after a deliberate sign-out: back to sign-in without the "session ended" error). `ctx.session` is
`GET /api/v1/auth/session`: `{ user: { id, username, role, preferences, totp… }, role, scopes,
csrf, expiresAt }`.

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
  since you opened it", reload it and let the user redo the change; never retry blindly. Commands
  (take a scene, fire an action, REC, the slot) carry no If-Match.
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
  Errors are the problem's `detail` (`toast(err)` does this), which says what to do.
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
- `dialog({ title, body, actions })`, `confirm({ title, consequence, confirmLabel, danger })`,
  `prompt({ title, intro, fields: [{ name, label, type, value, hint, required, options }], submitLabel })`.
- `menu(label, [{ label, onSelect, danger, disabled }], { buttonClass, ariaLabel })` (ariaLabel
  tells a list of "More" buttons apart: "More for clip.mp4").
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
  throws `ApiProblem { status, code, message (the detail), body }`.
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

## Connections (pages/connections.js)

`#/connections` (list, live from `system.connection`), `#/connections/new/:connector` (the setup
guide: warnings first, steps, the redirect URI with Copy, scopes and why; then the form) and
`#/connections/:id` (status, sign-in: a device code with its countdown, or a redirect with the
always-visible **Finish sign-in** paste box; what it feeds; actions; settings with If-Match).
Owners and admins only (`connections:read`/`write`); operators get each connection's status
from `GET /api/v1/system/health`. Delete and Sign out are in a menu, behind a confirmation that
names the consequence.
