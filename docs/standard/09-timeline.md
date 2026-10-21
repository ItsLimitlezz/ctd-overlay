# 09 · Timeline

A show runs itself. The server builds a schedule of cues and fires them on its own clock, so a
broadcast advances with every browser closed and survives a restart mid-show.

## 9.1 Show

```json
{
  "id": "show_sat",
  "name": "Saturday TAKEOVER",
  "overlays": ["ovl_main_h", "ovl_main_v"],
  "date": "2026-08-28",
  "timezone": "America/Toronto",
  "dayBoundary": "12:00",
  "goLive": "22:30",
  "lineup": [
    { "time": "22:30", "name": "Manzone & strong" },
    { "time": "01:00", "name": "VIKKSTAR", "headliner": true },
    { "time": "03:00", "name": "Deecee", "b2b": "quim", "closer": true }
  ],
  "scene": "starting"
}
```

- `headliner` and `closer` are different things: the headliner is the billed act; the closer
  plays last. A template that needs "the headliner" reads the flag, never "the last slot".
- A slot **MAY** carry `logo`: the performer's logo, as uploaded media (`/media/…`) or an
  `https` URL. Templates show it where they would show the name, and fall back to the name.
- `lineup` is published as `show.lineup` state to member overlays, each slot with `startAt`: the
  instant its `time` resolves to (§9.2), in epoch ms. `time` stays as a display label. The show
  also publishes `show.date` (its `date`) and `show.goLiveAt` (the instant `goLive` resolves to),
  so a countdown never re-interprets wall-clock strings. This is each member overlay's own state:
  two shows never see each other's.
- A slot as the show resource returns it also carries `startAt` (and `clockGap` /
  `clockOverlap`); a write takes and ignores them, so a lineup read and sent back whole goes
  through. Any other slot field is refused (`unknown-field`). An overlay deleted since, still in
  the show's `overlays` as read, is dropped when the list is sent back.
- **REC.** `show.recStartedAt` is set by the server when the show first goes on air (it takes a
  scene whose core is `program`, or a scene whose core is `auto` is on air at `goLiveAt`, which
  anchors it at `goLiveAt`) and cleared when it takes a scene whose core is `starting`; the
  operator can also start or reset it. Go-live counts while it is less than 12 hours ago: a
  platform that was down at go-live, or a go-live moved into the past, anchors REC at `goLiveAt`
  as soon as it can, and a go-live from an earlier date anchors nothing.
- A show is **live** while REC runs, for **12 hours** at most: a show "on air" longer than that
  was left so. What must not happen on air waits for a live show to end, such as an automatic
  template upgrade (04 §4.13), which reloads its pages.
- **Scenes by core.** A take, a timed scene's `then` and a button name a scene by its id or by
  its core (04 §4.2). Each member gets the name its own template knows: the same id, else the
  core, so a horizontal and a vertical feed from different templates change together.
- **Who's on** (`show.currentSlot`) is a lineup position the server keeps on the same act through
  a lineup edit, and clears if the act is removed.
- What a show publishes must fit an envelope (02 §2.9): a lineup over 24 KiB as published is
  refused when saved, and a slot's `logo` is at most 500 characters.

## 9.2 The time rule

**Times before the day boundary belong to the next calendar day.** With `date: 2026-08-28` and
`dayBoundary: "12:00"`, a slot at `01:00` is **2026-08-29 01:00** in the show's timezone —
which is what a club night means. The boundary is configurable (an afternoon show sets it to
`"06:00"`).

All schedule times are converted once, server-side, to absolute instants using the show's
`timezone` (IANA name). Clients receive instants; they never re-interpret wall-clock strings, so
an operator's phone in another timezone shows correct countdowns.

**Clock changes.** A wall-clock time that doesn't exist in the show's timezone (skipped when the
clocks go forward) moves forward by the length of the gap: `02:30` on a spring-forward night
becomes `03:30`. A time that happens twice (when the clocks go back) means the first occurrence.
This is the `compatible` disambiguation of ECMAScript Temporal. The admin UI **MUST** flag any
lineup time or cue that falls in a gap or an overlap and show the instant it resolved to.

## 9.3 Cues

```json
{
  "id": "cue_01J9…",
  "at": "2026-08-29T05:00:00Z",
  "label": "Headliner takeover",
  "action": { "type": "overlay.action", "name": "headliner" },
  "status": "armed"
}
```

Action types:

| Type | Effect |
|---|---|
| `show.scene` | `{ "scene": "brb", "transition": "fade" }` on all member overlays |
| `overlay.action` | fire a template action (`titleCard`, `nowPlaying`, `headliner`…) |
| `show.slot` | set the current lineup slot: an act's name (which follows the act through lineup edits) or a position |
| `connector.action` | e.g. `{ "connector": "obs", "name": "setScene", "args": { "scene": "Live" } }`: a connection's action, named by `connection` (its id) or `connector` (when one connection of it is on); its failure (not connected, refused) is the cue's `error` |
| `media.play` / `media.stop` | play an uploaded clip |
| `webhook` | call an outbound webhook (06 §6.10) |
| `sequence` | an ordered list of the above with offsets in ms |

`status` ∈ `armed`, `fired`, `skipped`, `missed`. A fired cue whose action did nothing (no
member has the action, the clip isn't ready) says why in `error`.

A cue is set at an instant (an ISO date-time with its offset, a real calendar date) or at a time
of the show (`"01:00"`, resolved by §9.2, and flagged `clockGap` / `clockOverlap` like a lineup
time). A cue at a time of the show belongs to the show's night: it moves when the show's date,
zone or day boundary changes. When the date changes (another night) it is armed again if its
time on that night is still to come, and `missed` if it has passed; going back to a night gives
back what happened on it. A `missed` cue that a fix of the zone or boundary moves into the future
is armed again.

A `sequence`'s steps run at their offsets from the cue's firing. Each step is recorded as done
before it is applied, so a restart in the middle goes on from the next step (a step more than 5
minutes late is skipped), and a step that fails doesn't stop the others; `error` says which.
Skipping a sequence that is playing, or deleting it, stops its remaining steps.

## 9.4 Scheduler rules

- The scheduler ticks at least once per second and fires every armed cue whose `at` has
  passed.
- **Grace window:** a cue more than **5 minutes** late is marked `missed` without firing. A
  wrong date or a restart after downtime never replays a night's worth of graphics at once.
- **Durable before visible:** a cue's `fired` status is written to storage *before* its effect
  is published, so a crash can't fire it twice.
- **Timed scenes return server-side:** a scene with `durationMs` + `then` (04 §4.2) schedules
  its return as part of the take, independent of any client. The return is stored with the
  show, so a restart mid-scene still returns (at once, if it fell due while the platform was
  down), and any other take cancels it.
- **After a restart:** what fell due while the platform was down waits a few seconds (5 here)
  for overlay pages to reconnect, so the one-shot effects reach them; its lateness is judged as
  of startup.
- Operator overrides — fire now, skip, re-arm — are always available and audited. A cue
  re-armed after its time is subject to the grace window like any other.
- **Nothing that happened fires again by itself.** Editing the lineup regenerates generated cues
  (§9.5) while preserving the `fired` / `skipped` status of cues that still exist, so an edit
  mid-show doesn't re-fire what already happened. A generated cue is known by its slot's time and
  act (a now-playing also by its minutes into the set), not its position, so inserting a slot
  changes no other slot's cues. A regeneration never makes a cue whose time has passed (only a
  night's first build catches up the last 5 minutes); a generated cue that no longer exists goes
  if it was still to come and stays, as history, if it happened. A generated cue the operator
  edited is left as they left it, and one they deleted stays deleted.

## 9.5 Generated cues

A show **MAY** generate cues from its lineup with a recipe. The default recipe, per slot:
- at slot start: `show.slot` + `overlay.action: titleCard`;
- `introOffsetMin` after start (default 5): `overlay.action: intro` (the Event Intro);
- every `nowPlayingEveryMin` (default 10) until the next slot: `overlay.action: nowPlaying`;
- for the slot flagged `headliner`, at its start: `overlay.action: headliner` when the
  template provides it (in place of the title card, which would cover it).

Only what a member's template offers is generated: an action of that name, or a scene of that
name with `durationMs` + `then` (04 §4.2), which the cue plays by taking it. A timed scene played
by a cue takes the show off its program, so it plays only while the show is on a scene whose
core is `program` or `auto` (or none yet); otherwise the cue fires with an `error` saying so,
and the operator's BRB stands. Fired by hand, it plays.

The recipe is kept with the show: `{ "titleCard": true, "introOffsetMin": 5,
"nowPlayingEveryMin": 10, "headliner": true }`, either minute value `null` for none. Building
with `null` stops generating: generated cues still armed are removed (except ones the operator
edited), and those that fired stay. What the members' templates offer is read when the show
changes or is built, so after changing a member's template, build again.

Recipes are data, not code, so a different kind of show (a talk show, a tournament) ships its
own.

## 9.6 Planned shows

A show configuration **MAY** be saved against a future date. At the day boundary on that date
the server activates it — lineup, settings, regenerated timeline — with no browser open. Plans
more than 14 days past are pruned.

A plan carries the date (within three years) and any of `lineup`, `goLive`, `dayBoundary`, and
`overlaySettings` (member slug → that overlay's settings, kept by overlay: a rename before the
day keeps them, and a new overlay that takes the old slug doesn't get them; shown under each
overlay's current slug, or, for one deleted since, the slug it had when the plan was saved (its id
if another overlay has taken that slug); validated against its template when saved and again when applied, and
applied only to overlays still in the show then; what wasn't applied is listed in the plan's
`warnings`). It is refused as the show itself would refuse the change. Its day starts at the day boundary in the show's zone as they are when it comes, not when
the plan was saved. A plan never changes a show that is live: it waits until REC ends. A platform
that was down at the boundary activates it at startup, if that show day (23 or 25 hours on a
clock-change night) isn't over; of several plans whose days have begun, only the latest is the
show. Activation resets REC and who's on to before the show.

## 9.7 Follow OBS

A show **MAY** follow the OBS program scene: the operator switches once, in OBS, and the
graphics follow (06 §6.9). It reads what OBS shows from the state its connections report per feed
(`obs.scene.landscape`, `obs.scene.vertical`, 02 §2.5; CTD Relay's OBS events, 06 §6.11). An
overlay outside a show **MAY** do the same with its own scenes.

```json
"followObs": {
  "enabled": true,
  "canvas": "landscape",
  "source": "con_01J…/p-dprtmnt",
  "map": [
    { "obsScene": "Live", "obsSceneUuid": "9b1c…", "scene": "program" },
    { "obsScene": "BRB", "scene": "brb" }
  ],
  "otherwise": "program"
}
```

- **One canvas drives a show.** A show's members share one scene: its landscape and vertical
  overlays take every scene together. So one OBS canvas drives it, `landscape` (the main canvas)
  by default; a vertical-only show, or a vertical overlay outside a show, follows `vertical`.
  The vertical canvas of Aitum Vertical changes scene on its own: following it is a choice.
- **Whose OBS.** `source` is a feed as bindings name it (`"<connection>"`, or
  `"<connection>/<profile>"` for one CTD Relay profile). Absent, it is the one feed of the show's
  members' connections (the overlay's) that reports OBS scenes; with none, or several, nothing
  is followed. Turning it on without a `source` while several feeds report OBS is refused
  (`422 pick-obs`).
- **Mapping.** An OBS scene is matched by its `sceneUuid` first, then by its name (a scene
  renamed in OBS keeps its uuid; one made again keeps its name). `scene` is one of the members'
  scenes, by id or core (§9.1); an OBS scene in no row takes `otherwise`, or, without it, changes
  nothing. At most 50 rows; an OBS scene's name is at most 200 characters; each OBS scene once.
- **Only a real change acts:** the scene the followed feed shows for the canvas became another
  one. The first scene seen after a start, CTD Relay's resend of an unchanged scene every 60 s
  and a scene the show is on already (a timed scene isn't restarted) take nothing.
- **The operator stays in charge.** A scene taken by hand (or by a cue) stays until OBS changes
  scene again, which then applies. Turning `enabled` off keeps the mapping and takes nothing.
- Each take OBS makes is logged and recorded in the audit log (`obs.follow`, actor `obs`, with
  the OBS scene, canvas and feed), and the show (the overlay) carries `sceneByObs: { at,
  obsScene, canvas, source }` until another take, so Live can say "Set by OBS".
- `followObs` is part of the show's edit (its ETag moves; `If-Match`); `null` removes it.

