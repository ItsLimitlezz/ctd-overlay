# Running CTD Overlay

How to start the platform, connect CTD Relay, and put chat and alerts on stream in OBS.
There are two ways to run it: on the PC that runs OBS (quickest), or on the NAS as a container.

## A. On the PC that runs OBS (Windows, macOS, Linux)

Needs Node.js 24 or newer (nodejs.org). No `npm install` is needed: the platform has no
dependencies.

```bash
git clone https://github.com/ItsLimitlezz/ctd-overlay.git
```

```bash
cd ctd-overlay
```

```bash
npm start
```

This listens on `http://127.0.0.1:4848`, on this PC only. That is enough when OBS runs on the
same PC. To use the admin pages from a phone, or OBS on another machine, start it for the local
network instead (Windows asks whether to allow it through the firewall: allow **Private
networks**):

```bash
npm start -- --exposure lan
```

Data goes to `%LOCALAPPDATA%\SKP\data` and the master key to `%LOCALAPPDATA%\SKP\config` (on
macOS, `~/Library/Application Support/SKP`; on Linux, `~/.local/share/skp` and `~/.config/skp`).
Keep the master key: it decrypts the saved tokens.

Optional: install ffmpeg (`winget install ffmpeg`). Uploaded phone video is then converted into
something OBS can play.

## B. On the NAS (TrueNAS SCALE, or any Docker host)

The image is built by GitHub Actions from this public repository: `ghcr.io/itslimitlezz/ctd-overlay`.
Pushes to `main` make `:latest`, and a `release/<name>` branch makes `:release-<name>`. The image is
public: TrueNAS pulls it with no credentials.

1. **Create two datasets**, owned by the `apps` user (568): one for data and one for config. The
   config dataset holds the master key, and keeping it separate means a backup of the data never
   contains the key.
2. **Install the app.** In **Apps → Discover Apps → ⋮ → Install via YAML**, paste
   [`deploy/truenas.yml`](../deploy/truenas.yml). Change the two dataset paths and `SKP_HOSTS`
   (the NAS's LAN address, `192.168.1.50`). If the outside port isn't `4848`, write it in
   `SKP_HOSTS` too, as `192.168.1.50:30848`. The platform only answers requests addressed to its
   own names.

Plain Docker on any host:

```bash
docker run -d --name ctd-overlay -p 4848:4848 -e SKP_HOSTS=192.168.1.50 -v ctd-data:/data -v ctd-config:/config ghcr.io/itslimitlezz/ctd-overlay:latest
```

## First start: create the owner

On first start, the log prints a **setup code** that is valid for an hour:

```
No owner account yet. Create it within an hour with this setup code: ABCD-EFGH-JKLM
```

- On the PC, it appears in the terminal.
- On TrueNAS, open **Apps → ctd-overlay → Logs**.

Open the platform (`http://127.0.0.1:4848` on the PC, `http://192.168.1.50:4848` on the NAS),
enter the code, and choose the owner's user name and password. If the hour passes, restart the
platform to get a new code.

## Connect CTD Relay

CTD Relay merges chat from every platform it streams to, and sends alerts, viewer counts
and live status. Its **profiles** are separate streams that can be live at the same time (for
example DPRTMNT and Miami or Bust). **One connection follows every profile** (approve it for
every profile): each profile is a stream of its own in CTD Overlay, new ones show up by
themselves, and each overlay's **Fed by** picks which profile it shows. (Approved for one profile,
the connection follows only that one.)

1. In **CTD Relay → Settings → API**, copy the **LAN URL**, which ends in `/api/v1` (for
   example `http://192.168.1.50:30080/api/v1`).
2. In CTD Overlay, open **Connections**. Under **Add a connection**, find **CTD Relay** and
   press **Set up**. Paste the address into **API address** and press **Connect**. A code appears,
   like `KQ7-2MX`, with a countdown (10 minutes).
3. In **CTD Relay → Settings → API** (the link under the code opens it), a banner says CTD
   Overlay wants to connect. Check that the code matches, pick **every profile** (or the one
   profile this connection follows), and approve.
4. Back in CTD Overlay, the connection connects by itself within a few seconds. Its card lists
   every profile with its status (**Miami or Bust · Offline**, **DPRTMNT · Live**), and
   **Connected**. While a destination is down, it shows **Partly working** with the reason (for
   example, Instagram (DPRTMNT) ended the live). That message is for you; viewers never see it.
5. On each overlay's page (Settings → **Fed by**), choose **Only these** and tick the profile it
   shows (**Relay · DPRTMNT**), or **All its profiles, including new ones**. An overlay fed
   by every connection shows every profile. Each show's stream on Live is then its profile's.

**Paste a token instead:** on the setup page, open **Paste a token instead**, and paste a token
made in **Settings → API → New token** (`chat:read` and `status:read`; add `apps:read` and
`apps:write` to share overlays with the OBS plugin). A token that reads every profile follows
every profile; to follow only one, pick it under **Profile** in the connection's settings.

**Upgrading from the version that followed one profile:** nothing to do. A connection approved
for every profile follows every profile after the update (one whose **Profile** setting names
another profile than the default one keeps following only that one), and an overlay fed by every
connection keeps working; choose per overlay which profile feeds it when you are ready.

If CTD Relay says the token was revoked, press **Connect again** on the connection's page.

### The CTD OBS plugin

A connection made with Connect also shares the overlays it feeds with the **CTD OBS plugin**,
through CTD Relay: the plugin lists them for its profile (an overlay fed by one profile is
listed for that profile; one fed by every profile, for every profile) and adds them as browser sources at
the right size and canvas (main or vertical), and can ask for a new one ("Let other apps create
overlays", on by default in the connection's settings). The connection's card says **Shared with
the OBS plugin: 4 overlays**. For this, CTD Overlay must know the address OBS reaches it at:
`SKP_HOSTS` on the NAS (the YAML sets it), or start it on the PC with
`npm start -- --exposure lan --hosts 192.168.1.20:4848` (that PC's address). Give equivalent
overlays of different profiles the same **Role in OBS** (overlay page → Settings) when one profile
has two overlays from the same template; the plugin uses it to switch its sources between
profiles.

### Follow OBS scenes

The show's graphics can follow OBS: switch to **BRB** in OBS and the overlays take Be Right Back.
It needs **CTD Relay v1.5** or newer and the **CTD OBS plugin with scene publishing** on the OBS
machine, sending for the show's profile. Then:

1. Check Live: the show's card says **OBS · landscape: Live · vertical: …**. A newer CTD OBS
   plugin (with CTD Relay v1.6) sends every scene it has, so they're all listed on the show's
   page right away. With an older one, switch scenes in OBS once or twice: the scenes OBS has
   shown are listed.
2. **Shows → the show → Details → Follow OBS**: tick **Follow OBS scenes**, pick the canvas that
   drives the show (Landscape, the main one, unless the show is vertical only), and for each OBS
   scene the show's scene to take ("Leave the scene as it is" ignores it). A scene OBS hasn't
   shown yet can be added by its name. **Save**.
3. If several CTD Relay profiles with OBS feed the show, pick the one under **Whose OBS**.

Your own scene buttons still work: a scene you take stays until OBS changes scene again. The
show's console says **Set by OBS (BRB, landscape)** when OBS took the scene. An overlay outside a
show has the same card on its **Scenes** tab.

## Put chat and alerts in OBS

Make an overlay from each template (**Templates → the template → Make an overlay**). The
overlay's page shows its URL, ready to copy. In OBS, add a **Browser** source with that URL and
**the size the page gives**:

| Overlay | Template | Canvas | Width × Height |
|---|---|---|---|
| Chat | Chat (`com.dprtmnt.chat`) | side | 560 × 1000 |
| Chat (vertical) | Chat | v | 1080 × 720 |
| Alerts | Alerts (`com.dprtmnt.alerts`) | h | 1920 × 1080 |
| Alerts (vertical) | Alerts | v | 1080 × 1920 |
| Show | TAKEOVER | h / v | 1920 × 1080 / 1080 × 1920 |
| Text & Clock | Text & Clock (`com.ctd.text-clock`) | h / v | 1920 × 1080 / 1080 × 1920 |

In the browser source's options:

- leave **Shutdown source when not visible** off;
- leave **Refresh browser when scene becomes active** off;
- leave **Custom CSS** empty.

Each overlay's page has its settings: accent colour, font size, how long lines stay, which
platform tags to show, the alert sound and its volume.

## Text & Clock

Up to three lines of text ("MIAMI OR BUST", "Road to Miami · Day 3") and a clock, over the whole
frame. **Templates → Text & Clock → Make an overlay**, then on the overlay's **Settings**: type the
lines (an empty one is hidden), pick the clock, and under **Look** where it sits (nine places), the
fonts (system fonts: nothing to download), sizes, colours, the background panel and its opacity,
and the drop shadow. Add it to OBS at 1920 × 1080 (or 1080 × 1920 with `?canvas=v`). Every copy
ticks on the server's clock, so the horizontal and vertical feeds show the same second, and a
timecode the same frame.

| Clock | Shows |
|---|---|
| Time of day | The time in the **Time zone** (an IANA name such as `America/New_York`; empty: the show's zone, else the OBS computer's), 12- or 24-hour, with or without seconds. |
| Countdown to a time | Time left until the **Date** and **Time** (in that zone), then the "reaches zero" words (`LIVE` unless you change them). A time with no date counts to its nearest occurrence; neither: to the show's go-live. |
| Count up since a time | Time since the date and time (neither: since the show went live). |
| Stream run time | Time since the stream started, from CTD Relay (if CTD Relay doesn't know, from the date and time set, else `—`). |
| Timecode | `HH:MM:SS:FF`, frame-accurate: the stream's run time (CTD Relay), UTC on CTD Relay's clock, or the time of day in the zone. |

The **Label** goes above or below the clock ("STARTING IN", "ON AIR FOR"). Stream run time and the
run-time timecode need **CTD Relay v1.3 or newer** and a connection whose token has `status:read`
(Connect gives one): the connection syncs to CTD Relay's clock every 5 minutes, and an overlay fed
by one profile counts that profile's stream. An older CTD Relay works as before; its connection
says it has no stream clock.

## Templates from a private GitHub repository

A template shipped as a release of a private repository (say `ItsLimitlezz/miamiorbust-live`,
release `overlay-v1.0.0` with `miami-or-bust-1.0.0.zip` attached) installs and updates from the
admin pages, with nothing to set on the server:

1. **Make a token** on GitHub: **Settings → Developer settings → Personal access tokens →
   Fine-grained tokens → Generate new token** (github.com/settings/personal-access-tokens/new).
   Resource owner: the account or organisation that owns the repository; **Repository access:
   Only select repositories** → the repository; **Repository permissions → Contents:
   Read-only** (Metadata: Read-only comes with it). Generate it and copy it.
2. In CTD Overlay, as the owner: **Settings → Integrations → GitHub**, paste it in **GitHub
   token**, **Save**. The card then says **Connected as @you**; the token is never shown again.
   **Replace token** and **More → Disconnect** are there too.
3. **Templates → Install template → From GitHub or a link**: type `ItsLimitlezz/miamiorbust-live`,
   press **Test**. It says **Can read ItsLimitlezz/miamiorbust-live (private) as @you** and lists
   the releases; pick `overlay-v1.0.0` (its `.zip` is chosen when it is the only one), tick
   **Install its new releases by themselves** to keep it updated, and **Install**.
4. Following it, a new release (`overlay-v1.1.0` with `miami-or-bust-1.1.0.zip`) installs by itself
   within the hour (or **Automatic updates → Check now**). Only releases whose tag starts like the
   installed one (`overlay-v`) are taken, and the file named like the installed one.

If a repository can't be read, the message says why (not connected, or the token can't read that
repository) with a link to **Settings → Integrations**. **Sign in with GitHub** (no token to
copy) is there too once an OAuth app's client ID is saved under **Set up Sign in with GitHub**:
on GitHub, **Settings → Developer settings → OAuth Apps → New OAuth App**, any name and URLs,
tick **Enable Device Flow**, register, copy the **Client ID**. It asks for the `repo` scope, so it
can read every repository the account can; a fine-grained token is narrower. On the server,
`SKP_GITHUB_TOKEN` (and `SKP_GITHUB_CLIENT_ID`) still work, used when nothing is saved here.

## Test before going live

- **Without a stream:** on an overlay's page, **Simulate** sends a sample chat message, sub, gift,
  raid or cheer to that overlay, and the overlay in OBS shows it. **Reset** clears the result.
- **With a test stream:** start a private stream through CTD Relay. Chat from each platform
  appears with its platform tag, and alerts appear one at a time.

## During the show: alerts

Alerts wait their turn on the server, so a burst never piles up on screen:
- They play in priority order: raids first, then Super Chats and tips, then gifts, subs,
  memberships, cheers, and finally follows.
- A gift of 25 subs (with the 25 single gifts Twitch sends after it) plays as one alert.

The **Alerts** card on **Live** shows what is on screen and what is waiting:
- **Skip** ends the alert on screen.
- **Replay last** plays the last alert again.
- **Pause alerts** holds new ones (they keep queueing) until you press **Resume alerts**.

## When something's wrong

| What you see | What to do |
|---|---|
| A page says "This platform serves its local network only" | The device isn't on the LAN (a phone on mobile data, a VPN). Join the LAN or use Tailscale. For a router port forward, set `SKP_ALLOW_PLAIN_INTERNET: "true"` and add the public address with its port to `SKP_HOSTS` (e.g. `192.168.1.50:4850,203.0.113.10:4850`, with your router's public address in place of `203.0.113.10`). It's plain HTTP, so turn on two-factor; HTTPS through a tunnel (`SKP_EXPOSURE=public`) is the safer way. |
| Signing in fails with "This can only be requested from the platform's own pages… at the platform's own address" | The address in the browser isn't one the platform knows (common in a container). Add it, with its port if that isn't 4848, to `SKP_HOSTS` and restart. |
| The connection says the token was refused | Press **Connect again** on the connection's page and approve the code in CTD Relay (or paste a new token). |
| "Another CTD Relay token already registered the app…" | An older connection (or token) registered it. In CTD Relay → Settings → API, delete that old **CTD Overlay** app; it registers again within 30 s. |
| "The OBS plugin sees no overlay URLs" | Set `SKP_HOSTS` to the address OBS reaches CTD Overlay at (on the PC, start with `--exposure lan --hosts <PC address>:4848`). |
| The connection is "Reconnecting" | CTD Relay isn't reachable at that address. Open `<address>/status` in a browser on the same machine. |
| Chat shows in the admin page but not in OBS | Check the browser source's URL (copy it again) and size. Then in OBS: right-click the source → Refresh. |
| Phone video won't play in OBS | Install ffmpeg (on the PC); the image already has it. |
| "Port 4848 is already in use" | The old Stream Kit (v0) uses 4848 too. Stop it, or start with `--port 4849`. |
