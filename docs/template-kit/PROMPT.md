# Prompt for generating a CTD Overlay template

Give an AI assistant this file, `TEMPLATE-GUIDE.md` and the `mega/` folder, then describe the
template you want under "The brief" below.

---

You are writing an overlay template for **CTD Overlay** (the Stream Kit Platform, standard
`skp/1`). `TEMPLATE-GUIDE.md` is the complete specification: follow it exactly. `mega/` is a
working reference template that uses every feature; copy its patterns.

**Deliver** a complete template folder, every file in full:

- `template.json`: a valid manifest. A new reverse-DNS `id` (never one from the guide's reserved
  list), version `1.0.0`, the right `category`, `canvases` (16:9 `h` 1920×1080, and 9:16 `v`
  1080×1920 when it makes sense), `scenes`, `consumes` declaring every state key, event type and
  chat the code uses, `actions` and `alerts` when used, and a `settings` schema using only the
  supported keywords and `x-skp-*` extensions.
- `index.html`: relative links to its CSS and JS, one `<template data-skp-scene="…">` per scene
  (or `SK.defineScene` in the JS), `[data-skp-chat]` / `[data-skp-alerts]` containers where chat or
  alerts go.
- `template.css`: laid out in canvas pixels; `[data-skp-canvas="v"]` rules for the vertical
  canvas; all motion on `[data-skp-state="enter|idle|exit"]`; nothing OBS 30's Chromium 103 lacks
  (`color-mix()`, `:has()`, nesting, container queries).
- `template.js`: data only through `SK`; settings applied on `SK.ready` and `SK.onSettings`; absent
  values hide their element (never `0`/`undefined`); server time through `SK.clock`; no
  `innerHTML` with data, no `fetch`, no storage, no `requestAnimationFrame` for state.
- `previews/preview.svg` (or PNG): a picture of the design for the gallery.
- Any images or fonts it needs, in `assets/`, referenced relatively or through `SK.asset()`.

**Check your work** against the guide's checklist (§15) before answering. Then tell the operator:
how to install it (`skp template install <folder>` or Templates → Install with the folder zipped),
what each setting does, the browser-source size per canvas, and how to preview it with sample data
(`?mock=1`).

## The brief

<!-- Describe the template here. For example:
A "Now playing" lower third for a DJ stream: album art, title and artist, a progress bar, the
accent colour as a setting, slides in from the left when a track changes and hides when nothing is
playing. 16:9 and 9:16. -->
