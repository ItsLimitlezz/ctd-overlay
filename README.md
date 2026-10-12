# CTD Overlay

A self-hosted live-stream overlay platform: one server that connects to Twitch, Kick, YouTube,
Spotify and OBS, runs the show on its own clock, and serves styled overlays to OBS browser
sources.

It implements the **Stream Kit Platform Standard** (`skp/1`) and replaces the D/PRTMNT Stream Kit
(v0) it was generalized from.

- [docs/standard/](docs/standard/README.md): the standard, with its JSON Schemas.
- [docs/PLAN.md](docs/PLAN.md): the build plan, one PR per step.

**Status:** steps 1–9 of the plan, plus 8b (template updates from GitHub releases). The server
keeps its data in SQLite, routes live data through the bus, and serves overlays to OBS browser
sources over Server-Sent Events with a polling fallback. Every overlay page gets the runtime SDK
(`SK`, [04 §4.4](docs/standard/04-templates.md)): the server clock, state and events, scenes and
transitions, element lifecycle on deadlines, actions, alerts, chat and music helpers, and a mock
show (`?mock=1`). Templates install from `.skp` or `.zip` packages, URLs or GitHub releases, with
validation, settings and upgrades, and can follow a repository for updates; media uploads are
converted for OBS. Shows put overlays together: one take changes every member, triggers land on
the same frame, timed scenes return on the server, and REC starts by itself. Bundled: the
D/PRTMNT TAKEOVER show package, a viewer-count widget and a diagnostic template. Next is step 10:
the timeline, so a show runs from its schedule.

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
the same major version, with no setting, scene or action they use removed, and no `migrate.js`
to run. A breaking release is installed too, but its overlays stay where they are until you run
the `overlay upgrade` the log names. If you `overlay revert` one, it stays reverted until the
source brings a newer version. `template sources` shows what each source last installed,
`template update` checks now, and `template unfollow` stops (installed versions stay). For a
private repository, set `SKP_GITHUB_TOKEN` to a token that can read it.

A source can't take over a template you installed some other way (from a file, or another
repository): following it says so. To hand such a template over to the repository on purpose,
follow it with `--template <id>`. Downloads only go to public addresses; to fetch from a server
on your own network, set `SKP_ALLOW_PRIVATE_DOWNLOADS=true`.

To publish a release: bump `version` in `template.json`, then make a GitHub release and attach
the package from `npm run skp -- template pack .`. With `template.json` at the repository's root
you can skip the attachment, and the release's own source zip is used.
[docs/template-releases.md](docs/template-releases.md) has a workflow that attaches the package
for you.

## Shows

A show is the overlays you put on air together: a horizontal and a vertical feed, say. One take
changes every member's scene at once, and a trigger lands on all of them on the same frame. The
show carries the night: its date, timezone, go-live time and lineup. Times are written as on the
poster (`01:00` after midnight belongs to the same night, until the show's day boundary,
`12:00` by default), and the server turns them into instants, clock changes included.

These commands drive the running platform, so start it first (`npm start`, or `npm run demo`,
which already has a show; add `--port 4950` for the demo's port):

```bash
npm run skp -- show create --name "Saturday TAKEOVER" --overlays main-h,main-v --date 2026-10-17 --timezone America/Toronto --go-live 22:30 --lineup lineup.json
```

`lineup.json` is a list of slots: `[{ "time": "22:30", "name": "Manzone" }, { "time": "01:00",
"name": "VIKKSTAR", "headliner": true, "logo": "/media/…/vik.png" }]`. Then, during the show:

```bash
npm run skp -- show take "Saturday TAKEOVER" brb
```

`show fire <show> titleCard` triggers an action, `show slot <show> VIKKSTAR` says who's on, and
`show list` shows each show's scene and whether it's live. REC starts by itself at the first
take of the live scene (or at go-live while `auto` is on air) and resets when you take
`starting`; `show rec <show> start|reset` does it by hand. While a show is live, automatic
template updates wait for it to end. An overlay that isn't in a show has its own scene:
`overlay take <slug> <scene>`.

### The show runs itself

The platform fires a show's cues on its own clock, with every browser closed and through a
restart. To have it make the night's cues from the lineup:

```bash
npm run skp -- show build "Saturday TAKEOVER"
```

That gives each act, at its start, the "who's on" change and a title card (the headliner gets
their own intro instead, where the template has one), the Event Intro five minutes in, and now
playing every ten minutes until the next act. `--recipe recipe.json` changes that, for example
`{ "introOffsetMin": null, "nowPlayingEveryMin": 15 }`, and `--recipe none` stops it. Edit the
lineup mid-show and the cues are rebuilt; anything that already fired stays fired. A timed scene
like the Event Intro plays only while the show is on its program scene, so it never pulls you
off a BRB.

`show cues <show>` lists the timeline. Add your own cue with `show cue add <show> --at 23:59
--scene brb` (or `--action titleCard --args '{"name":"Guest"}'`, `--slot 2`, `--play <media
id>`, `--stop`, or `--cue file.json` for a sequence). You can fire a cue now, skip it, re-arm it
or delete it with `show cue fire|skip|rearm|delete <show> <cue>`. A cue more than five minutes
late is marked missed instead of firing, so a restart after downtime never replays a night.

Cues set at a show time (`23:59`) belong to the show's night. When the date changes they move
with it and are armed again. To get next week ready without touching tonight, plan it:
`show plan add <show> --date 2026-10-24 --lineup next.json [--settings settings.json]`. At that
day's boundary the plan becomes the show, unless the show is still live, in which case it waits.

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
