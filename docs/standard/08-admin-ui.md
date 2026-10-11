# 08 · Admin UI

The admin UI is for a person running a stream, often from a phone, often under pressure. It
uses only the public API (03).

## 8.1 Navigation

| Section | Job |
|---|---|
| **Live** | The show-night console: previews, take scenes, fire actions and cues, pause alerts, connection health. The default landing page once set up. |
| **Overlays** | Every overlay: preview, settings form, bindings, URL with "Copy" and "Add to OBS". |
| **Templates** | The gallery: installed templates, install new, versions. |
| **Shows** | Shows, member overlays, lineup, timeline, planned dates. |
| **Connections** | Twitch, Kick, YouTube, Spotify, OBS, custom hooks — status and setup. |
| **Media** | Uploaded clips and images. |
| **Settings** | Appearance, users, tokens, webhooks, security, exposure, backups, about. |

On screens narrower than 760 px the navigation collapses into a menu, and destructive actions
(reset, delete, rotate key) **MUST** live behind a menu and a confirmation — never as a
top-level button that can be hit by a thumb mid-show.

## 8.2 Template gallery

The path a non-technical user takes: **browse → preview → use → copy into OBS.**

- Cards show the template's preview image, name, author, category and canvases.
- Filters by category (show package, chat, alerts, now playing, lower thirds, backgrounds…) and
  search by name or tag.
- A detail view renders the template **live with sample data** (§8.5) at each canvas, lists
  its scenes and actions, and shows which connections it can use.
- **Use template** creates an overlay: pick a name/slug, bind connections (pre-selected from
  what's connected and what the template consumes), and land on the overlay page with its URL
  ready to copy.
- Installing from a file or URL shows the validation result (04 §4.11) and, for templates from
  outside the bundled set, a plain-language note that templates are code and run in OBS.

## 8.3 Overlay page

- Live preview at each canvas, scaled, with a scene picker; on mobile, previews load on tap and
  in lite mode.
- Settings form generated from the template's schema (04 §4.3), grouped, with live preview.
- Bindings: which connections feed this overlay.
- The URL, with **Copy**, **Add to OBS** (when OBS is connected, creates the browser source at
  the right size), and the exact browser-source size to set.
- A clear note that the URL never changes when settings, theme or template version change.

## 8.4 Live console

- Previews of the show's overlays (H and V).
- Scene buttons for the show's scenes, labelled with the template's names for them, with the
  active one highlighted. Template extras (e.g. Headliner Intro) appear only when the active
  template provides them.
- Action buttons for every declared template action.
- Timeline: next cue with a countdown in server time, "Trigger now" and "Skip", and the full
  cue list with done/upcoming state.
- Alert queue controls: pause, skip, replay last.
- Connection strip: one chip per connection with status colour and the viewer total.
- Everything works one-handed on a phone; tap targets at least 44 × 44 px.

## 8.5 Sample data and simulation

Templates are designed and checked without going live.

- `?mock=1` makes the runtime feed an overlay realistic sample data: a lineup, a chat stream
  with every role, emotes, a long name, a deleted message; one alert of every kind including a
  gift burst; a track with progress; viewer counts that change.
- The overlay page has a **Simulate** panel that injects individual events into that overlay
  only (`POST /overlays/{id}/simulate`): "Send chat message", "Follow", "Gift 25 subs", "Raid",
  "Change track", "Drop viewers to absent" — so a template author can watch each state.
- Simulated envelopes are tagged `src.connector = "simulator"` and **MUST NOT** reach overlays
  other than the one targeted, or outbound webhooks.

## 8.6 Appearance

The admin UI is themable without code:
- light, dark, or follow system;
- an accent colour;
- density (comfortable / compact);
- an optional logo and display name for the installation.

Preferences are stored per user. The UI is built on design tokens (CSS custom properties) so an
installation **MAY** ship a custom admin theme as a token file. Changing the admin theme never
affects overlays.

## 8.7 Connections setup

Each connector's setup screen walks through registering the developer app: the exact redirect
URI to paste (copied from this installation's configuration), the scopes being requested and
why, and service-specific warnings written in plain language — for example *"Kick only sends
chat to servers reachable from the internet. In LAN mode you'll get the viewer count but not
chat."* or *"Spotify requires the app owner to have Premium."*

## 8.8 Accessibility and copy

- WCAG 2.2 AA: contrast, visible focus, full keyboard operation, labelled controls,
  `prefers-reduced-motion` honoured in the UI.
- Copy names things by what users recognize ("Viewer count", "Chat"), not internals
  ("state key", "envelope").
- Errors say what happened and what to do; success says what changed ("Scene changed to BRB").
- Every destructive confirmation names its consequence ("OBS sources using this URL will stop
  working").
