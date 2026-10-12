# CTD Overlay

A self-hosted live-stream overlay platform: one server that connects to Twitch, Kick, YouTube,
Spotify and OBS, runs the show on its own clock, and serves styled overlays to OBS browser
sources.

It implements the **Stream Kit Platform Standard** (`skp/1`) and replaces the D/PRTMNT Stream Kit
(v0) it was generalized from.

- [docs/standard/](docs/standard/README.md): the standard, with its JSON Schemas.
- [docs/PLAN.md](docs/PLAN.md): the build plan, one PR per step.

**Status:** steps 1–8 of the plan. The server keeps its data in SQLite, routes live data through
the bus, and serves overlays to OBS browser sources over Server-Sent Events with a polling
fallback. Every overlay page gets the runtime SDK (`SK`, [04 §4.4](docs/standard/04-templates.md)):
the server clock, state and events, scenes and transitions, element lifecycle on deadlines,
actions, alerts, chat and music helpers, and a mock show (`?mock=1`). Templates install from
`.skp` packages, with validation, settings and upgrades, and media uploads are converted for
OBS (below). Bundled: the D/PRTMNT TAKEOVER show package, a viewer-count widget and a
diagnostic template. Next is step 9: shows that run themselves.

## Try it in OBS

```bash
npm run demo
```

It starts a throwaway server on port 4950 with the TAKEOVER template in both looks (the cyan
TAKEOVER and the gold headliner event) and a sample night: a lineup, a headliner, go-live in
three minutes, a viewer count. Add the printed URLs to OBS as browser sources, 1920 × 1080 (or
1080 × 1920 for the `?canvas=v` ones). Then type a scene name (`starting`, `program`, `brb`,
`lineup`, `outro`, `bg`, `intro`, `headliner`, `line`, `pov`, `auto`) or an action (`title`,
`np`, `opening`, `onat`) and Enter, as an operator would.

```bash
npm run diag
```

starts eight diagnostic overlays on port 4949, for checking the transport: each shows whether it
is streaming or polling, how many updates arrived, and the server clock. Add `?debug=1` to any
overlay URL for the SDK's status panel.

To watch one overlay react without going live, post a sample event to it (08 §8.5; from this
machine only, until sign-in exists):

```bash
curl -X POST http://127.0.0.1:4950/api/v1/overlays/takeover-h/simulate -H "content-type: application/json" -d "{\"kind\":\"viewers\",\"value\":2500}"
```

Kinds: `chat`, `follow`, `subscription`, `gift`, `raid`, `cheer`, `tip`, `track`, `viewers`,
`viewers-clear`, `media.play` (with a `/media/…` `url`), `media.stop`, `reset`. Simulated state
(a viewer count, a track) shows on that overlay only, and goes back to the real value after a
minute or at `reset`.

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

`install` also takes a `.zip` of the template folder, an https URL to a package, or a GitHub
repository (`owner/name`, or `owner/name@v1.2.0` for one release), whose latest release it
installs.

`template list` and `template uninstall <id>[@<version>]` do what they say, and
`overlay upgrade <slug> --to <version> [--dry-run] [--yes]` moves an overlay to a newer version of
its template; its OBS URL never changes. The plan lists every setting that changes, and an
upgrade that drops anything the overlay uses needs `--yes`. `overlay revert <slug>` goes back to
the version and settings it had before. Each change is recorded in `operations.log` in the data
folder.

### Updating templates remotely

Follow a template's repository, and its new releases install by themselves:

```bash
npm run skp -- template follow your-name/your-template
```

The running platform checks every hour (`SKP_TEMPLATE_CHECK_MINUTES`). A new release is installed
next to the old version, and overlays move to it on their own when that can't break anything:
the same major version, with no setting, scene or action they use removed. A breaking release is
installed too, but its overlays stay where they are until you run the `overlay upgrade` the log
names. `template sources` shows what each source last installed, `template update` checks now,
and `template unfollow` stops (installed versions stay). For a private repository, set
`SKP_GITHUB_TOKEN` to a token that can read it.

To publish a release: bump `version` in `template.json`, then make a GitHub release and attach
the package from `npm run skp -- template pack .`. With `template.json` at the repository's root
you can skip the attachment, and the release's own source zip is used.
[docs/template-releases.md](docs/template-releases.md) has a workflow that attaches the package
for you.

## Media

Clips, images, sounds and fonts for templates (a poster setting, a stinger, a DJ logo):

```bash
npm run skp -- media add path/to/IMG_0042.MOV
```

It prints the file's id (`med_…`) and its URL (`/media/<fileId>/IMG_0042.mp4`, where the
fileId is a long random string) to paste into a setting. With [ffmpeg](https://ffmpeg.org)
installed (or `SKP_FFMPEG` pointing to it), phone video is converted to H.264 MP4, which OBS's
browser plays, and HEIC photos to JPEG (that needs ffmpeg 7.1 or later). Without it, video is
kept as uploaded with a note that OBS may not play it. `media list` shows every file;
`media remove <med_id>` deletes one, and refuses while an overlay's settings use it.

These commands change the data folder, so stop the platform first; until the admin UI (step 14)
they are the way to manage media.
