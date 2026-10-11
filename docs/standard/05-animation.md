# 05 · Animation

Animation is where templates spend their effort, so the platform gives them a small, strict
contract: a lifecycle for every element, a scheduler that is synchronized to server time, and
queues for things that arrive in bursts. Templates write the motion; the runtime decides when.

## 5.1 Engines

Templates **MAY** animate with any of:

| Engine | Use | Notes |
|---|---|---|
| CSS transitions & keyframes | Default for everything | Cheapest; survive tab throttling |
| Web Animations API | Sequenced, seekable motion | `element.animate()`; seekable in previews |
| Lottie | Designer-made vector animation | Bundle the player in the package; no CDN |
| Video (WebM VP9 with alpha) | Stingers, complex intros | Plays muted; audio belongs in OBS |
| Canvas 2D / WebGL | Particles, generative backgrounds | Budget carefully (§5.8) |

All animation **MUST** be self-contained in the package.

## 5.2 Element lifecycle

Every element the runtime shows or hides moves through four states, exposed as an attribute
so CSS can target them:

```
  (absent) ──mount──► enter ──► idle ──unmount──► exit ──► (removed)
```

```css
.card[data-skp-state="enter"] { animation: rise .6s cubic-bezier(.2,.7,.2,1) both; }
.card[data-skp-state="idle"]  { animation: breathe 4s ease-in-out infinite; }
.card[data-skp-state="exit"]  { animation: drop .45s ease-in both; }
```

- `SK.mount(el, opts)` inserts the element with `data-skp-state="enter"`, then switches to
  `idle` after the enter duration.
- `SK.unmount(el)` sets `exit` and removes the element after the exit duration. It returns a
  promise.
- Duration is resolved in order: `opts.durationMs` → CSS custom property `--skp-enter-ms` /
  `--skp-exit-ms` → the computed animation duration → 0.
- The runtime **MUST NOT** wait on `animationend` alone. It uses the resolved duration plus
  50 ms as a deadline, because `animationend` does not fire on elements that are hidden or in
  a throttled source. (Hard rule 11 §H9.)

## 5.3 Synchronized timing

Two sources on two machines — a horizontal and a vertical feed — must hit the same beat.

- Every trigger carries `startAt` in server time (02 §2.6). The runtime begins the element's
  enter at `startAt` on `SK.clock.now()`, not on receipt.
- If a trigger arrives late but inside its window, the runtime **SHOULD** start it
  immediately and offset WAAPI/CSS animations by the lateness (`animation-delay: -Xms`) so it
  lands on the same final frame as on-time clients.
- If the window has passed, it is dropped.
- `SK.clock.at(ts, fn)` schedules a callback against server time; it re-checks on a 250 ms
  timer, so it stays correct across clock corrections and throttled tabs.

## 5.4 Scene transitions

On a scene change the runtime:
1. mounts the incoming scene root in `enter`;
2. sets the outgoing root to `exit`;
3. removes the outgoing root after its exit duration.

Both overlap by default (crossfade). A template controls the look entirely in CSS:

```css
[data-skp-scene-root][data-skp-state="enter"] { animation: sceneIn .5s ease both; }
[data-skp-scene-root][data-skp-state="exit"]  { animation: sceneOut .5s ease both; }
```

The transition name requested by the operator (`cut`, `fade`, `stinger`, or a template-defined
name) is exposed as `data-skp-transition` on both roots. `cut` **MUST** skip animations
entirely. A template **MAY** declare a stinger:

```json
"transitions": [ { "id": "stinger", "media": "assets/stinger.webm", "cutAtMs": 420 } ]
```

The runtime plays the video over both scenes and swaps them at `cutAtMs`.

## 5.5 Alert queue

Alerts arrive in bursts (a gift of 50 subs is 51 events). The **server** queues them: one queue
per show, so every member overlay shows the same alert at the same moment, or one per overlay
outside a show. Neither the template nor the browser queues alerts. A queue in the browser can't
be paused from the admin UI, and two of them on two machines drift apart.

The queue follows each template's `alerts` manifest settings. For a show, it paces to the
longest `durationMs` among the members that consume the alert.

| `alerts` field | Meaning | Default |
|---|---|---|
| `mode` | `serial` (one at a time) or `stack` (several visible) | `serial` |
| `maxConcurrent` | for `stack` | 3 |
| `durationMs` | time one alert is on screen, from the start of its enter to the end of its exit | 6000 |
| `durationSetting` | name of a numeric setting (ms) that overrides `durationMs`, so users can tune the hold; clamped to 1000–60000 | — |
| `gapMs` | pause between alerts | 500 |
| `maxQueue` | alerts held before the oldest low-priority ones are dropped | 50 |
| `coalesce` | merge a gift burst into one `alert.gift` with the total | `true` |

Priority, highest first: `raid`, `superchat`/`tip`, `gift`, `subscription`, `membership`,
`cheer`/`kicks`, `follow`.

When an alert's turn comes, the queue gives it a `display` window (`startAt`, `durationMs`) in
server time and delivers it to the overlays (02 §2.4). The runtime then:
1. at `startAt`, creates the alert element, calls the template's renderer to fill it, and mounts
   it in `enter`. If the renderer returns a promise (to decode an avatar, say), the runtime
   mounts when it resolves or after 250 ms, whichever comes first;
2. at `startAt + durationMs` minus the element's exit duration, unmounts it, whether or not the
   renderer has finished;
3. handles lateness like any trigger (§5.3): a late arrival starts at an offset, and one whose
   window has passed is dropped.

The operator can pause and resume the queue, skip the alert on screen, and replay the last one,
from the admin UI or the API (03 §3.4). A skip publishes `alerts.cut`, and the runtime unmounts
that alert at once.

The template supplies only the renderer:

```js
SK.alerts.render((alert, el) => {
  el.className = 'alert alert--' + alert.kind;
  el.textContent = alert.user.name + ' ' + verb(alert);
});
```
```css
.alert[data-skp-state="enter"] { animation: rise .6s cubic-bezier(.2,.7,.2,1) both; }
.alert[data-skp-state="exit"]  { animation: drop .45s ease-in both; }
```

## 5.6 Chat animation

The chat helper handles pacing: when messages arrive faster than a template can animate, the
runtime batches them into frames of at most 4 messages per 250 ms and caps on-screen messages
at the template's `chat.max` (default 30), unmounting the oldest with their exit animation.
Deleted messages unmount immediately with their exit animation; a `chat.cleared` exits
everything at once.

## 5.7 Timers versus animation frames

`requestAnimationFrame` **MUST NOT** gate correctness. OBS can stop delivering frames to a
source that isn't currently painting, and a browser preview tab in the background is throttled
to roughly one timer per second. Use CSS or WAAPI for motion (the compositor keeps running) and
timers or `SK.clock.at` for state. `requestAnimationFrame` is fine for canvas drawing loops
whose pause is harmless.

## 5.8 Performance budget

One OBS scene often holds four or more overlay sources, each its own browser.

- Animate `transform` and `opacity` only. Never animate `width`, `height`, `top`, `left`,
  `box-shadow` or `filter: blur()` in loops.
- **Do not use `backdrop-filter`** to blur the camera: a browser source only sees its own page,
  so it blurs nothing useful and costs GPU. Darken with a translucent fill; blur the camera
  with an OBS filter.
- **Do not use `mix-blend-mode` on transparent overlays.** With nothing beneath it inside the
  page, `multiply` composites to black and covers the camera.
- At most two infinite animations per scene in `idle`; prefer `steps()` for texture loops.
- Canvas/WebGL: cap at 30 fps unless the effect needs 60; stop the loop when its scene exits.
- Large images: decode ahead (`img.decode()`) before the first animated reveal, or the first
  showing stutters.
- Lite mode (`SK.env.lite`): the runtime adds `data-skp-lite` to `<html>`; templates **SHOULD**
  drop blurs, grain, particles and video under it. Mobile previews use it so several overlay
  iframes don't exhaust a phone's GPU memory.

## 5.9 Reduced motion and previews

- In the admin UI only, the runtime honours `prefers-reduced-motion` by setting
  `data-skp-reduced-motion`; templates **SHOULD** shorten or skip motion under it. On air, OBS
  sources always animate.
- Preview scrubbing: the admin UI **MAY** pause and seek a template by setting `currentTime`
  on every animation from `document.getAnimations()`. Templates that use CSS or WAAPI get this
  for free; canvas loops should read `SK.clock.now()` rather than wall time to stay scrubbable.
