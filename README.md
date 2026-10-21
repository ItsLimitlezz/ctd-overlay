# CTD Overlay

A self-hosted live-stream overlay platform: one server that connects to Twitch, Kick, YouTube,
Spotify and OBS, runs the show on its own clock, and serves styled overlays to OBS browser
sources.

It implements the **Stream Kit Platform Standard** (`skp/1`) and replaces the D/PRTMNT Stream Kit
(v0) it was generalized from.

- [docs/standard/](docs/standard/README.md): the standard, with its JSON Schemas.
- [docs/PLAN.md](docs/PLAN.md): the build plan, one PR per step.

**Status:** steps 1–13 of the plan, plus 8b (template updates from GitHub releases); step 13 is
in review. The server keeps its data in SQLite, routes live data through the bus, and serves
overlays to OBS browser sources over Server-Sent Events with a polling fallback. Every overlay
page gets the runtime SDK (`SK`, [04 §4.4](docs/standard/04-templates.md)): the server clock,
state and events, scenes and transitions, element lifecycle on deadlines, actions, alerts, chat
and music helpers, and a mock show (`?mock=1`). Templates install from `.skp` or `.zip` packages,
URLs or GitHub releases, with validation, settings and upgrades, and can follow a repository for
updates; media uploads are converted for OBS. Shows put overlays together: one take changes every
member, triggers land on the same frame, timed scenes return on the server, and REC starts by
itself; the show's cues fire on the server's clock from its schedule. Sign-in has roles, API
tokens, two-factor codes and an audit log; overlay URLs carry keys, secrets are encrypted at rest,
and the platform can serve the local network or the internet over HTTPS. Everything goes through
the API v1, described at `/api/v1/openapi.json`. Bundled: the D/PRTMNT TAKEOVER show package, Chat,
Alerts, Text & Clock (text lines with a time of day, countdown, count-up, stream run time or
timecode: [docs/RUNNING.md](docs/RUNNING.md#text--clock)), a viewer-count widget and a diagnostic
template. Next is step 14: the admin UI.

## Try it in OBS

```bash
npm run demo
```

It starts a throwaway server on port 4950 with the TAKEOVER template in both looks (the cyan
TAKEOVER and the gold headliner event) and a sample night: a lineup, a headliner, go-live in
three minutes, a viewer count. Add the printed URLs to OBS as browser sources, 1920 × 1080 (or
1080 × 1920 for the `?canvas=v` ones). Then run the night from the admin UI it prints (signed in
as the demo owner, also printed), or type a scene name (`starting`, `program`, `brb`, `lineup`,
`outro`, `bg`, `intro`, `headliner`, `line`, `pov`, `auto`) or an action (`title`, `np`,
`opening`, `onat`) and Enter.

```bash
npm run diag
```

starts eight diagnostic overlays on port 4949, for checking the transport: each shows whether it
is streaming or polling, how many updates arrived, and the server clock. Add `?debug=1` to any
overlay URL for the SDK's status panel.

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

### The admin UI

Open the platform's address (`http://127.0.0.1:4848/`) in a browser, on the computer or a phone
on the same network (with `SKP_EXPOSURE=lan`). The first visit makes the owner account with the
setup code from the log; after that it opens on **Live**, the show-night console: scenes,
title cards and other actions, who's on, REC, the next cue with Trigger now and Skip, and the
viewer count, all reachable with one thumb. **Overlays** has each overlay's preview, its settings
(a form made from the template), the URL to paste into OBS with the browser-source size, and a
Simulate panel. **Templates** previews a template with sample data before you use it, installs
new ones and follows them for updates. **Shows** holds the night: details, lineup, timeline and
planned dates. **Settings** has your look (theme, accent colour, density), accounts, two-factor,
API tokens and the audit log. Deleting and key changes always sit behind a menu and ask first.

```bash
node scripts/ui-smoke.js /live /overlays --phone --shots shots
```

opens pages in a headless Chrome or Edge on a throwaway platform and reports console errors,
CSP violations and sideways scrolling, with screenshots.

### Overlay URLs and reaching it from elsewhere

Each overlay's URL carries its key: `npm run skp -- overlay url <slug>` prints it for OBS.
`overlay rotate-key <slug>` makes a new one (the old URL stops working). By default the platform
listens on this machine only. `SKP_EXPOSURE=lan` serves the local network (OBS on another PC, a
phone); `SKP_EXPOSURE=public` also serves the internet over HTTPS, with `SKP_PUBLIC_URL` and
either `SKP_TLS_CERT`/`SKP_TLS_KEY` or a reverse proxy in `SKP_TRUST_PROXY`. The master key in the
config folder decrypts the secrets in the data folder: back it up separately.

### The API

Everything the admin UI does goes through `/api/v1`, described at `/api/v1/openapi.json`.
Sign in, or send an API token (`Authorization: Bearer skp_pat_…`, from `skp token create`,
below); a Stream Deck button that must fire once sends `Idempotency-Key`.

To watch one overlay react without going live, post a sample event to it (08 §8.5) with a token
that may control overlays (`npm run skp -- token create --name Simulate --scopes
overlays:control`, shown once):

```bash
curl -X POST http://127.0.0.1:4848/api/v1/overlays/<slug>/simulate -H "authorization: Bearer skp_pat_…" -H "content-type: application/json" -d "{\"kind\":\"viewers\",\"value\":2500}"
```

Kinds: `chat`, `follow`, `subscription`, `gift`, `raid`, `cheer`, `tip`, `track`, `viewers`,
`viewers-clear`, `media.play` (with a `/media/…` `url`), `media.stop`, `reset`. Simulated state
(a viewer count, a track) shows on that overlay only, and goes back to the real value after a
minute or at `reset`.

### Accounts

There is no default password. On first start the platform prints a **setup code** in its log
(valid for an hour; a restart makes a new one). Make the owner account with it:

```bash
npm run skp -- setup --code ABCD-EFGH-IJKL --username juan
```

Make it from the platform's machine or its local network: in public mode, setup from the
internet is refused. It asks for a password (12 characters or more; a few words make a good
one). Then add the people who run the show: `skp user add ana --role operator` (operators run
scenes, cues and the lineup but never see credentials; `admin` also installs templates and reads
the audit log; `viewer` only looks). A Stream Deck or a bot gets an API token: `skp token create
--name "Stream Deck" --scopes overlays:control`, shown once. `skp audit` shows who did what (the
command line's changes as `cli:<your user>`). These commands work on the platform's own machine
without signing in: the platform writes a local token to its config folder for them, which is
also how the owner resets a forgotten password (`skp user password juan`).

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
the version and settings it had before. Each change is recorded in the audit log: `skp audit`
shows it, with the platform running.

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
private repository, connect GitHub in the admin pages (**Settings → Integrations → GitHub**: paste
a token that can read it, or sign in with GitHub; see docs/RUNNING.md), or set
`SKP_GITHUB_TOKEN` on the server.

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

These commands drive the running platform, so start it first (`npm start`; for the demo, add
the `--config-dir` it prints, since its config folder is a temporary one):

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
lineup mid-show (fix a time, a name, add an act) and the cues are rebuilt; nothing that already
happened goes out again, and a cue you edited or deleted stays as you left it. A timed scene
like the Event Intro plays only while the show is on its program scene, so it never pulls you
off a BRB. After switching an overlay to another template, run `show build` again.

`show cues <show>` lists the timeline. Add your own cue with `show cue add <show> --at 23:59
--scene brb` (or `--action titleCard --args '{"name":"Guest"}'`, `--slot VIKKSTAR`, `--play <media
id>`, `--stop`, or `--cue file.json` for a sequence). You can fire a cue now, skip it, re-arm it
or delete it with `show cue fire|skip|rearm|delete <show> <cue>`. A cue more than five minutes
late is marked missed instead of firing, so a restart after downtime never replays a night.

Cues set at a show time (`23:59`) belong to the show's night. When the date changes they move
with it and are armed again (if their time is still to come). To get next week ready without
touching tonight, plan it:
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
`media remove <med_id>` deletes one, and refuses while anything uses it (an overlay's settings,
a show's lineup, a cue or a plan), saying what.

These commands change the data folder, so stop the platform first; until the admin UI (step 14)
they are the way to manage media.

## Connections

The **Connections** page of the admin UI connects the services that feed overlays: chat, alerts,
viewer counts and live status. Each connector's setup screen says what to do on the service's
side (the redirect URI to register, with a Copy button, the permissions asked for and why), its
settings form keeps secrets encrypted and never shows them again, and signing in is a code to
type on any device or a redirect (when the browser that comes back isn't the one that started,
paste the address it landed on under **Finish sign-in**). Each connection shows its status,
what it feeds and the values it sets now; a count that can't be read is held for two minutes,
marked stale, then hidden: never shown as 0.

**CTD Relay** is built in. Copy its LAN URL from Settings → API (`http://<NAS-IP>:30080/api/v1`),
set up a CTD Relay connection with it and press **Connect**: approve the code shown in
CTD Relay → Settings → API and pick the profile, or every profile (a token can be pasted
instead). Approved for every profile, one connection follows them all, each profile a stream of
its own with its live status on Live (new profiles show up by themselves), and each overlay's
**Fed by** picks its profile ("Relay · DPRTMNT") or all of them; approved for one, the
connection is that profile, named "Relay · <profile>". Its merged chat and alerts reach overlays whose template shows them, and the TAKEOVER
viewer count becomes the total across every platform it streams to. It also shares the overlays
it feeds with the CTD OBS plugin through CTD Relay (their URLs at `SKP_HOSTS`'s address;
an overlay's **Role in OBS** keeps equivalent overlays matched across profiles), and the plugin
can ask it for new ones ("Let other apps create overlays"). Twitch and Kick (step 17), OBS,
YouTube and Spotify follow.

Overlays take every connection by default ("all", new ones too); an overlay can be bound to some
only (`PATCH /api/v1/overlays/<slug>` with `{ "connections": ["con_…"] }`, or `"con_…/<profile
id>"` for one CTD Relay profile of a connection that follows every profile). Owners and admins
manage connections; operators see each one's status on the Connections page (from
`GET /api/v1/system/health`).

## Moving from v0

The D/PRTMNT Stream Kit's data folder (its `/data` volume, or `data/` beside its `server.js`)
comes over in one command. Start this platform once first (it makes its master key, which the
import encrypts with), then stop it and import:

```bash
npm run skp -- import v0 path/to/v0/data --timezone America/Toronto --dry-run
```

The dry run says what it would make and changes nothing; drop `--dry-run` to import. The night
in `kit.json` becomes a show (its date, go-live and lineup; the event's headliner flagged on the
lineup, the closer kept as the closer) with one TAKEOVER overlay in it, carrying v0's look, copy,
ticker and event options, and The Line's clip from `uploads/` in the media library. The timeline
is built the way v0 built its rundown (a title card at each set's start, the Event Intro and now
playing at v0's minutes), and the cues v0's operator added by hand for that night come along.
Planned Saturdays in `shows.json` become planned dates. The Twitch and Kick credentials in
`viewers.json` are kept, encrypted, and become connections (turned off until you check them)
once this platform has Twitch and Kick connectors (step 17); they are never printed.

The summary ends with the overlay's two URLs (horizontal and vertical): they replace v0's
`feed=h` and `feed=v` links in OBS. `--name` and `--slug` name the show and the overlay
(`takeover` by default); without `--timezone` the show takes `TZ` or this computer's zone (v0
used its server's). Importing again is refused while a show of that name exists, unless
`--replace`, which replaces that show with its cues and plans and updates the overlay. v0's
roster, its live state (scene, REC, counters), other uploads and `crash.log` stay behind.
