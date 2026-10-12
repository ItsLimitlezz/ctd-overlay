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
- **REC.** `show.recStartedAt` is set by the server when the show first goes on air (it takes a
  scene whose core is `program`, or `auto` reaches `goLiveAt` while on air, which anchors it at
  `goLiveAt`) and cleared when it takes a scene whose core is `starting`; the operator can also
  start or reset it. A show is **live** while REC runs. What must not happen on air waits for a
  live show to end, such as an automatic template upgrade (04 §4.13), which reloads its pages.

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
| `show.slot` | set the current lineup slot |
| `connector.action` | e.g. `{ "connector": "obs", "name": "setScene", "args": { "scene": "Live" } }` |
| `media.play` / `media.stop` | play an uploaded clip |
| `webhook` | call an outbound webhook (06 §6.10) |
| `sequence` | an ordered list of the above with offsets in ms |

`status` ∈ `armed`, `fired`, `skipped`, `missed`.

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
- Operator overrides — fire now, skip, re-arm — are always available and audited.
- Editing the lineup regenerates generated cues (§9.5) while preserving the `fired` / `skipped`
  status of cues that still exist, so an edit mid-show doesn't re-fire what already happened.

## 9.5 Generated cues

A show **MAY** generate cues from its lineup with a recipe. The default recipe, per slot:
- at slot start: `show.slot` + `overlay.action: titleCard`;
- `introOffsetMin` after start (default 5): `overlay.action: intro` (the Event Intro);
- every `nowPlayingEveryMin` (default 10) until the next slot: `overlay.action: nowPlaying`;
- for the slot flagged `headliner`, at its start: `overlay.action: headliner` when the
  template provides it.

Recipes are data, not code, so a different kind of show (a talk show, a tournament) ships its
own.

## 9.6 Planned shows

A show configuration **MAY** be saved against a future date. At the day boundary on that date
the server activates it — lineup, settings, regenerated timeline — with no browser open. Plans
more than 14 days past are pruned.
