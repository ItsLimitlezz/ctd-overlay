# CTD Overlay

A self-hosted live-stream overlay platform: one server that connects to Twitch, Kick, YouTube,
Spotify and OBS, runs the show on its own clock, and serves styled overlays to OBS browser
sources.

It implements the **Stream Kit Platform Standard** (`skp/1`) and replaces the D/PRTMNT Stream Kit
(v0) it was generalized from.

- [docs/standard/](docs/standard/README.md): the standard, with its JSON Schemas.
- [docs/PLAN.md](docs/PLAN.md): the build plan, one PR per step.

**Status:** steps 1–4 of the plan. The server keeps its data in SQLite, routes live data through
the bus, and serves overlays to OBS browser sources over Server-Sent Events with a polling
fallback. The only template so far is a built-in diagnostic one; step 5 (the template SDK) is next.

## Try it in OBS

```bash
npm run diag
```

It starts a throwaway server on port 4949 with eight diagnostic overlays and prints their URLs.
Add them to OBS as browser sources (1920 × 1080). Each shows whether it is streaming or polling,
how many updates arrived, and the server clock.

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
