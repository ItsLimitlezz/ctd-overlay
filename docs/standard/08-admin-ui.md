# 08 · Admin UI

The admin UI is for a person running a stream, often from a phone, often under pressure. It
uses only the public API (03).

## 8.1 Navigation

| Section | Job |
|---|---|
| **Live** | The show-night console: every stream running and whether it is on air, then one show's or overlay's previews, scenes, actions, cues, alerts and connection health. The default landing page once set up. |
| **Overlays** | Every overlay: preview, settings form, bindings, URL with "Copy" and "Add to OBS". |
| **Templates** | The gallery: installed templates, install new, versions. |
| **Shows** | Shows, member overlays, lineup, timeline, planned dates (§8.9). |
| **Connections** | Twitch, Kick, YouTube, Spotify, OBS, custom hooks — status and setup. |
| **Media** | Uploaded clips and images. |
| **Settings** | Appearance, users, tokens, webhooks, security, exposure, backups, about. |

On screens narrower than 760 px the navigation collapses into a menu, and destructive actions
(reset, delete, rotate key) **MUST** live behind a menu and a confirmation — never as a
top-level button that can be hit by a thumb mid-show.

Edits not saved yet are never dropped without a word. Leaving a page that has some (a link, the
navigation, the browser's Back, or another tab of the same page) **MUST** ask first, *"Leave
without saving?"*, naming what is lost (*"Your changes to the lineup are lost; it stays as it was
saved."*); **Cancel** keeps the page as it is, its edits, its address and the browser's history
(a Back is undone with a Forward, a page's own move with a Back, so no entry is lost or doubled),
and **Leave** makes the move as it was made. Reloading or closing the tab asks too, where the
browser lets a page ask (Safari on iOS doesn't). One question at a time: a move made while one is
open is undone, not asked about again. Once a change is saved, nothing asks. A session that ends
mid-show signs in again to the page it was on, its query too (a show's console, a show's tab).

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
- Bindings: which connections feed this overlay: *All connections, including new ones* (the
  default), or *Only these*, from the connections' names and status (`bound`, 03 §3.4). A show's
  page sets the same for every member at once (one change per overlay, each with its If-Match).
- The URL, with **Copy**, **Add to OBS** (when OBS is connected, creates the browser source at
  the right size), and the exact browser-source size to set.
- A clear note that the URL never changes when settings, theme or template version change.
- A template that reads who's on from a show (`show.lineup`, `show.currentSlot` or
  `show.headliner` in its `consumes`, a pattern such as `show.*` included: set times, the
  countdown, REC, title cards, 02 §2.5) gets none of it on an overlay outside a show. The page
  **MUST** say so first, in plain words (*"Set times, the countdown, REC and title cards come from
  a show. This overlay isn't in one yet."*), with **Make a show from this overlay** and, when
  there are shows, **Add it to a show**:
  - *Make a show* asks for a name (the template's), the date (the show's night now in the zone
    chosen, as New show has it: before noon, the default day boundary, it is still the night
    before; said in words, with the same quick picks), the time zone (this device's), an
    optional go-live time, and which of the template's other overlays in no show come along (its
    vertical twin), ticked; it lands on the new show's Lineup. A twin put in another show
    meanwhile is left out and said in plain words; pressing again makes the show with the rest.
  - *Add it to a show* picks a show, the one an overlay of the same template is in first (they
    change scenes together only in the same show), with the same twins ticked, and changes the
    show's overlays with the show's If-Match: a show changed meanwhile is said, shown as it is
    now, and nothing is added until it is done again. A show whose night has passed is marked so
    in the list (*"· passed"*), and said in words under it.
  - A show that is plainly the overlay's (the one its twin is in, else one with no overlays yet,
    made before with its lineup typed in) comes first, named and said why (*"DPRTMNT Saturday
    has 2 acts in its lineup and no overlays yet."*): **Add it to DPRTMNT Saturday** is the
    primary button, *Make a show* the other. The Shows list offers the same.
  - Neither changes what feeds the overlays: a show is fed by what feeds its members (§8.4).
- An overlay in a show whose night has passed says so on its page (*"Its night, Saturday,
  October 24, 2026, has passed: the countdown and set times are still that night's."*), with one
  tap to move the show to its next night on the same weekday (with the show's If-Match).
- A template that reads only a show's times (`show.goLiveAt`, `show.recStartedAt`: a clock's
  countdown to the go-live and count-up since) may have a time of its own, so outside a show its
  page says so quietly (*"With no time of its own, the countdown runs to a show's go-live…"*),
  with the same two actions, and Live says nothing of it.
- With sample data on (§8.5), the preview of an overlay outside a show says what of a show it
  makes up, from what its template reads (*"Sample data makes up set times, the countdown, REC
  and title cards here."*). An overlay in a show says where they are edited: the show's Lineup
  and Details.
- Settings are each overlay's own, the copy too (a tagline is set on the landscape and on the
  vertical overlay). After a save, the other overlays of the same template in the show it is in
  now (read again: it may have moved since the page was read) that hold something else in what
  changed are offered the same change (*"Also change: takeover-v"*): only the settings that
  changed and that their own version of the template has (one on an older version is told what
  it lacks, and that upgrading it gives it), one change per overlay, each with its own If-Match.
  One refused is named with the reason in plain words, and offered again as it is now; not one
  whose version can't take the value, which would be refused the same way again.

## 8.4 Live console

Several streams can run at once: a stream is a show, or an overlay outside a show, and each is fed
by the connections its overlays are bound to (§8.3), so two shows bound to two connections (two
CTD Relay servers, say) are two streams.

- Live opens on **every stream**: a card per show and per overlay outside a show, with its
  on-air state in words (**On air**, **Offline**, or **Unknown** when no connection says), each
  platform ("Twitch · live · 214"), the viewers when a count is known, the connections that feed
  it with their status, REC when it runs, and **Open**. Running streams (on air, or REC) come
  first. It follows changes by polling and `system.connection` events. From the API: `stream` on
  each show and overlay (03 §3.4).
- A show's console starts with the same status; an overlay selector chooses the **whole show**
  (below) or **one member**: its preview, its URLs for OBS with their sizes, its actions,
  **Simulate**, what feeds it, and a link to its settings. Scenes stay the show's. The choice is
  kept in the address. An overlay outside a show opens the same panel on its own, with its scenes.
- An overlay outside a show whose template reads who's on from one (§8.3) says so on its card
  and first in its console, with the same **Make a show from this overlay** and, once there is a
  show (one made while the console is open too), **Add it to a show** (first, and named, for a
  show plainly its, §8.3); added from its console,
  Live opens the show's console with it chosen. Its actions fire with no act named, so its
  Actions name the title cards that show nothing until it is in a show (*"This overlay isn't in
  a show, so DJ title card, Now playing and Now playing (hold) have no act to name: they show
  nothing."*); one of them fired is said to be sent with no act to name, and any other action to
  be sent, never to be on air.
- An overlay on an older version of its template than the newest installed (an overlay stays on
  its version until it is upgraded, 04 §4.10: a platform update that brings a template's new
  version moves none) is said quietly, to whoever can upgrade it, on its stream's card and in the
  console, each overlay's name a link to its Version tab. A show's overlays of one template are
  upgraded together, before going live: half upgraded, an action reaches only some of them, and
  their settings differ. While the stream runs (on air, or REC), after it: an upgrade reloads the
  overlay in OBS. The upgrade dialog says what the version brings beside its settings: its new
  scenes and actions (new buttons on Live), each with what it needs of the settings (*"it plays
  the clip chosen in the overlay's settings"*).
- Previews of the show's overlays (H and V).
- Scene buttons for the show's scenes, labelled with the template's names for them, with the
  active one highlighted. Template extras (e.g. Headliner Intro) appear only when the active
  template provides them.
- Action buttons for every declared template action. One pressed says what it did, with the
  action's label: on air for an action with a `durationMs` (*"DJ title card on air"*), on air
  until hidden for a card without one (*"Now playing (hold) on air until hidden"*), done for an
  untimed one labelled *Hide …* or *Stop …* (*"Title card and now playing hidden"*), sent for any
  other (*"Play The Line's clip sent"*: what it does is its template's, 04 §4.6). An action that
  plays the media a setting names (TAKEOVER's The Line's clip) says, as an error, where none is
  chosen and where to choose it, the overlays read as they are now; one the overlays' settings
  draw nothing for (TAKEOVER's chips outside its Headliner event look) is said under the buttons
  and, pressed, *"sent, but it shows nothing"*, with why; in a show, an overlay of the same
  template the action didn't reach (its version doesn't have it) is named. A cue's Graphic says
  the same of such an action.
- Who's on: the act on, **Next act** (naming it) and **Put on** for each act, and **Nobody on**.
  With nobody picked, it says which act's set the lineup's times are in, and Next act is that
  act. An act put on early skips what was still to come for the acts before it (09 §9.3), said
  with it (*"Headliner DJ is on. 6 cues still to come for Opener were skipped"*).
- On `auto` past its go-live with no REC (a show made after it, or REC reset), the status says
  that its overlays show it live with no REC, and what starts REC: **Start REC** (from now) or
  taking Auto again (from go-live).
- Timeline: next cue with a countdown in server time, "Trigger now" and "Skip", and the full
  cue list with done/upcoming state.
- Alert queue controls: pause, skip, replay last.
- Connection strip: one chip per connection with status colour and the viewer total, from
  `GET /system/health` (operators can read it) and live `system.connection` events.
- Everything works one-handed on a phone; tap targets at least 44 × 44 px.

## 8.5 Sample data and simulation

Templates are designed and checked without going live.

- `?mock=1` makes the runtime feed an overlay realistic sample data: a lineup, a chat stream
  with every role, emotes, a long name, a deleted message; one alert of every kind including a
  gift burst; a track with progress; viewer counts that change. Sample data never passes for the
  real thing: on an overlay outside a show, what it makes up of a show (set times, the countdown,
  REC, title cards, or a clock's show times) is said to be so (§8.3).
- The overlay page has a **Simulate** panel that injects individual events into that overlay
  only (`POST /overlays/{id}/simulate`): "Send chat message", "Follow", "Gift 25 subs", "Raid",
  "Change track", "Drop viewers to absent" — so a template author can watch each state.
- Simulated envelopes are tagged `src.connector = "simulator"` and **MUST NOT** reach overlays
  other than the one targeted, or outbound webhooks.
- Simulated state (a track, a viewer count, a count gone absent) applies to that overlay only
  and never changes the platform's state, nor settings bound to the key (04 §4.3). It **MUST** end by itself (the platform's choice; this
  one holds it 60 s) or when the panel's "Reset" is pressed, and the overlay then gets the real
  values back: a simulation left running on a live overlay must not hide the real count for the
  rest of the show. While it holds, real changes to that key don't reach that overlay.
- The answer says, per item, whether the overlay takes it (its template consumes it), so the
  panel can say "this template doesn't show chat" rather than nothing happening.

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

- Warnings come first, before the steps; the redirect URI has a Copy button, and a note when
  the page was opened at another address than the one the service sends back to.
- The settings form is generated from the connector's fields; a secret is a password field that
  is never filled in (leaving it empty keeps what is saved).
- Signing in: a device code is shown large, with the address to open and a countdown; a redirect
  goes to the service and back, and the connection's page always has **Finish sign-in**, to paste
  the address landed on when that was another device (06 §6.4).
- Each connection shows its status in words and colour, what it feeds (chat, alerts, viewer
  count…), the values it sets now (a held one says so), its last event, quota and warnings, Test
  and Turn on/off; Delete is in a menu, behind a confirmation that names the consequence
  (*"Overlays showing its chat and viewer count stop showing them."*). Changes arrive live
  (`system.connection`).
- Operators (no `connections:read`) see each connection's status, from `GET /system/health`.

## 8.8 Accessibility and copy

- WCAG 2.2 AA: contrast, visible focus, full keyboard operation, labelled controls,
  `prefers-reduced-motion` honoured in the UI.
- Copy names things by what users recognize ("Viewer count", "Chat"), not internals
  ("state key", "envelope").
- Errors say what happened and what to do; success says what changed ("Scene changed to BRB").
- Every destructive confirmation names its consequence ("OBS sources using this URL will stop
  working").
- A time of day is typed as text, the same in every browser: *9:30 PM*, *21:30*, *9pm*, *2130*.
  On a 12-hour clock a time without AM or PM is asked about (*"Add AM or PM: 10:30 PM, or 10:30
  AM."*), never guessed. A time that can't be read is said right under its box once it is left,
  and is never saved or turned into another time when the form is drawn again. Sending its form
  says the same words, naming the box (*"Act 2, Headliner DJ: add AM or PM: 10:30 PM, or 10:30
  AM."*), and puts the focus on it; an example of a time is written in the device's clock. A
  browser's own time box isn't used: Safari's shows an AM/PM that looks set before it is.

## 8.9 Shows

A show is a night (09): its page has **Details**, **Lineup**, **Timeline** and **Plans**, each
edited with the show's If-Match, and each asking before its unsaved edits are dropped (§8.1).

- A date has quick picks, and says the date in words with its weekday (*"Saturday, October 24,
  2026: tonight"*): **Tonight** (the show's day now in its zone, with its day boundary: at 1 AM it
  is still the night before), the next night on its weekday, and **Next week** after that night;
  a new show also gets the coming Friday and Saturday. Every pick counts from tonight, not from
  the date in the field: the one picked shows as pressed, and pressing it again changes nothing.
  A plan is for a night still to come, so it has no Tonight, and on a show's own weekday its
  picks are **Next Monday** and **In two weeks**. A new show's date follows the time zone chosen
  until it is picked; New show and *Make a show from this overlay* (§8.3) pick the same night.
- Details' hints say what the form has now (the date, zone, day boundary and go-live being
  edited): *"When the countdown ends: Sat, Oct 31, 11:00 PM."* An act set before the go-live is
  said, in Details and on its Lineup row (*"Before the show goes live at 10:15 PM: on Auto the
  countdown covers this set."*), never refused.
- A lineup's act and B2B fields offer the names of every lineup and plan (`GET /acts`, v0's
  roster) as they are typed, and a known act's latest logo comes with its name to a row without
  one. Headliner and closer are flagged apart (H8).
- The list says which overlays that read who's on are in no show, with *Make a show from …* for
  each template's: the overlay page's dialog (§8.3), and first *Add … to <show>* for a show
  plainly theirs. **New show** takes any overlays, those picked when they are of one template.
- A show whose night has passed says so on its page, with one tap to move it to its next night
  on the same weekday; the tab open keeps its unsaved edits, on the new night.
- A plan is edited in the tab, like the lineup: its date, its go-live (empty: the show's), and a
  lineup of its own (or the show's as it is that day), saved whole with its If-Match. It can
  become the show now, never while the show is live (09 §9.6).
- The timeline builds from the lineup (09 §9.5), takes a card cue that puts its act on as it
  shows (09 §9.3), and re-arms every cue still to come from its menu, behind a confirmation that
  says how many (09 §9.4).
