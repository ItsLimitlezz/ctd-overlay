# CTD Overlay

A self-hosted live-stream overlay platform: one server that connects to Twitch, Kick, YouTube,
Spotify and OBS, runs the show on its own clock, and serves styled overlays to OBS browser
sources.

It implements the **Stream Kit Platform Standard** (`skp/1`) and replaces the D/PRTMNT Stream Kit
(v0) it was generalized from.

- [docs/standard/](docs/standard/README.md): the standard, with its JSON Schemas.
- [docs/PLAN.md](docs/PLAN.md): the build plan, one PR per step.

**Status:** steps 1–7 of the plan. The server keeps its data in SQLite, routes live data through
the bus, and serves overlays to OBS browser sources over Server-Sent Events with a polling
fallback. Every overlay page gets the runtime SDK (`SK`, [04 §4.4](docs/standard/04-templates.md)):
the server clock, state and events, scenes and transitions, element lifecycle on deadlines,
actions, alerts, chat and music helpers, and a mock show (`?mock=1`). Templates install from
`.skp` packages, with validation, settings and upgrades, and media uploads are converted for
OBS (below). The only bundled template so far is a diagnostic one; step 8 (the TAKEOVER
template) is next.

## Try it in OBS

```bash
npm run diag
```

It starts a throwaway server on port 4949 with eight diagnostic overlays and prints their URLs.
Add them to OBS as browser sources (1920 × 1080). Each shows whether it is streaming or polling,
how many updates arrived, and the server clock. Add `?debug=1` to a URL for the SDK's status
panel.

## Run it

Node.js 24 or later, no `npm install` needed.

```bash
npm start
```

It listens on `http://127.0.0.1:4848` and keeps its data in your user data folder
(`%LOCALAPPDATA%\SKP` on Windows, `~/Library/Application Support/SKP` on macOS,
`~/.local/share/skp` and `~/.config/skp` on Linux). Settings are environment variables
(`SKP_PORT`, `SKP_DATA_DIR`, `SKP_LOG_LEVEL`…, see [10 §10.5](docs/standard/10-packaging.md)),
the same names as flags (`--port 5000`), or `config.json` in the config folder.

```bash
npm test
```

## Templates

A template is a folder with a `template.json` ([04](docs/standard/04-templates.md)); a package is
that folder zipped as `.skp`. Until the admin UI arrives, the command line handles them (with the
platform stopped, for the commands that change its data):

```bash
npm run skp -- template validate path/to/template-folder
```

```bash
npm run skp -- template pack path/to/template-folder -o my-template.skp
```

```bash
npm run skp -- template install my-template.skp
```

`template list` and `template uninstall <id>[@<version>]` do what they say, and
`overlay upgrade <slug> --to <version> [--dry-run] [--yes]` moves an overlay to a newer version of
its template; its OBS URL never changes. The plan lists every setting that changes, and an
upgrade that drops anything the overlay uses needs `--yes`. `overlay revert <slug>` goes back to
the version and settings it had before. Each change is recorded in `operations.log` in the data
folder.

## Media

Clips, images, sounds and fonts for templates (a poster setting, a stinger, a DJ logo):

```bash
npm run skp -- media add path/to/IMG_0042.MOV
```

It prints the file's URL (`/media/<id>/IMG_0042.mp4`) to paste into a setting. With
[ffmpeg](https://ffmpeg.org) installed (or `SKP_FFMPEG` pointing to it), phone video is converted
to H.264 MP4, which OBS's browser plays, and HEIC photos to JPEG. `media list` and
`media remove <id>` do what they say.
