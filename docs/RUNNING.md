# Running CTD Overlay

How to start the platform, connect CTD Multi-Stream, and put chat and alerts on stream in OBS.
There are two ways to run it: on the PC that runs OBS (quickest), or on the NAS as a container.

## A. On the PC that runs OBS (Windows, macOS, Linux)

Needs Node.js 24 or newer (nodejs.org). No `npm install` is needed: the platform has no
dependencies.

```bash
git clone https://github.com/ItsLimitlezz/CTD---Overlay.git
```

```bash
cd CTD---Overlay
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

The image is built by GitHub Actions: `ghcr.io/itslimitlezz/ctd---overlay`. Pushes to `main` make
`:latest`, and a `release/<name>` branch makes `:release-<name>`. The build for the 17 October
test is `ghcr.io/itslimitlezz/ctd---overlay:release-2026-10-17`: put that tag in the YAML's
`image:` line until this work is merged into `main`.

1. **Create two datasets**, owned by the `apps` user (568): one for data and one for config. The
   config dataset holds the master key, and keeping it separate means a backup of the data never
   contains the key.
2. **Allow TrueNAS to pull the image.** The repository is private, so its image is private too.
   On GitHub, make a classic token with `read:packages`. In TrueNAS, open **Apps → Configuration →
   Manage Container Images (or Docker Registries) → Add**, with registry `ghcr.io`, your GitHub
   user name, and that token. Alternatively, make the package public on GitHub (Packages →
   ctd---overlay → Package settings).
3. **Install the app.** In **Apps → Discover Apps → ⋮ → Install via YAML**, paste
   [`deploy/truenas.yml`](../deploy/truenas.yml). Change the two dataset paths and `SKP_HOSTS`
   (the NAS's LAN address, `192.168.1.50`). If the outside port isn't `4848`, write it in
   `SKP_HOSTS` too, as `192.168.1.50:30848`. The platform only answers requests addressed to its
   own names.

Plain Docker on any host:

```bash
docker run -d --name ctd-overlay -p 4848:4848 -e SKP_HOSTS=192.168.1.50 -v ctd-data:/data -v ctd-config:/config ghcr.io/itslimitlezz/ctd---overlay:latest
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

## Connect CTD Multi-Stream

CTD Multi-Stream merges chat from every platform it streams to, and sends alerts, viewer counts
and live status.

1. In **CTD Multi-Stream → Settings → API**:
   - Copy the **LAN URL**, which ends in `/api/v1` (for example `http://192.168.1.50:30080/api/v1`).
   - Make a **token** with `chat:read` and `status:read`. It starts with `ctd_pat_` and is shown
     only once.
2. In CTD Overlay, open **Connections**. Under **Add a connection**, find **CTD Multi-Stream** and
   press **Set up**. Paste the address and the token, and leave Chat and Alerts on. Press **Save**,
   then **Test** on the connection's page.
3. The connection shows **Connected**. While a destination is down, it shows **Degraded** with the
   reason (for example, Instagram ended the live). That message is for you; viewers never see it.

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

In the browser source's options:

- leave **Shutdown source when not visible** off;
- leave **Refresh browser when scene becomes active** off;
- leave **Custom CSS** empty.

Each overlay's page has its settings: accent colour, font size, how long lines stay, which
platform tags to show, the alert sound and its volume.

## Test before going live

- **Without a stream:** on an overlay's page, **Simulate** sends a sample chat message, sub, gift,
  raid or cheer to that overlay, and the overlay in OBS shows it. **Reset** clears the result.
- **With a test stream:** start a private stream through CTD Multi-Stream. Chat from each platform
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
| A page says "This platform serves its local network only" | The device isn't on the LAN (a phone on mobile data, a VPN). Join the LAN. |
| Signing in fails with "This can only be requested from the platform's own pages… at the platform's own address" | The address in the browser isn't one the platform knows (common in a container). Add it, with its port if that isn't 4848, to `SKP_HOSTS` and restart. |
| The connection says the token was refused | Make a new token in CTD Multi-Stream and paste it into the connection. |
| The connection is "Reconnecting" | CTD Multi-Stream isn't reachable at that address. Open `<address>/status` in a browser on the same machine. |
| Chat shows in the admin page but not in OBS | Check the browser source's URL (copy it again) and size. Then in OBS: right-click the source → Refresh. |
| Phone video won't play in OBS | Install ffmpeg (on the PC); the image already has it. |
| "Port 4848 is already in use" | The old Stream Kit (v0) uses 4848 too. Stop it, or start with `--port 4849`. |
