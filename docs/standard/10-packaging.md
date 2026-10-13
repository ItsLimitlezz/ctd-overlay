# 10 · Packaging & deployment

One codebase, three ways to install, the same behaviour everywhere.

## 10.1 Targets

| Target | Artifact | Default exposure |
|---|---|---|
| **TrueNAS SCALE** (24.10+, Docker-based apps) | OCI image, `linux/amd64` + `linux/arm64` | `lan` |
| **Linux** — Docker / Podman | same image | `lan` |
| **Linux** — native | single executable (x64, arm64) + systemd unit | `lan` |
| **macOS** — native | signed, notarized universal app (arm64 + x64) as `.dmg` | `local` |

Windows is out of scope for v1 but **MUST NOT** be precluded: use OS APIs for paths, never
hardcode `/`, and keep native dependencies out of the core (README decision 8).

## 10.2 Runtime baseline

- Server: a current Node.js LTS release (22 or later), or an equivalent runtime producing a
  single self-contained executable (Node.js Single Executable Applications or similar).
- Storage: SQLite. Node's built-in `node:sqlite` keeps the core dependency-free — confirm its
  stability level for the Node version you ship. A JSON-file store is acceptable for very small
  installs if every write is atomic (§10.6).
- Overlays: the browser engine embedded in **OBS Studio 30+** (Chromium 103 or later at the
  time of writing). The runtime SDK and bundled templates **MUST** work there; templates declare
  their own minimum in `engines.obs`.
- Media: ffmpeg is optional. Found on `PATH` or via `SKP_FFMPEG`; bundled in the container
  image. Without it, `GET /system/info` reports `ffmpeg: false` and uploads are stored as-is
  with a warning that HEVC clips will not play in OBS.
- Footprint target: under 150 MB RAM idle with 10 overlays and 4 connections; runs on a
  Raspberry Pi 4–class device or a low-end NAS. A password hash adds up to 128 MiB while it runs,
  which is why hashing is serialized (07 §7.3).

## 10.3 Container image

- Non-root by default: UID/GID **568** (the TrueNAS `apps` user), overridable with `PUID`/`PGID`.
- Volumes: `/data` (database, media, templates) and `/config` (master key, config file) —
  **separate on purpose**, so a data backup never contains the key that decrypts its secrets.
- Port **4848**.
- `HEALTHCHECK` against `GET /healthz`, which returns `200 ok` with no version or detail and
  needs no authentication.
- `TZ` set from the environment; `tzdata` included.
- Read-only root filesystem supported; writes only to `/data`, `/config` and `/tmp`.

### TrueNAS SCALE (Install via YAML)

```yaml
services:
  skp:
    image: ghcr.io/<owner>/skp:1
    restart: unless-stopped
    ports: ["4848:4848"]
    environment:
      TZ: America/Toronto
      SKP_EXPOSURE: lan
      SKP_PUBLIC_URL: ""            # set when exposed publicly (OAuth redirects, Kick webhooks)
    volumes:
      - /mnt/tank/apps/skp/data:/data
      - /mnt/tank/apps/skp/config:/config
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://127.0.0.1:4848/healthz"]
      interval: 30s
      timeout: 5s
      retries: 3
```

## 10.4 Native installs

### macOS
- Code-signed with a Developer ID and **notarized** — without it Gatekeeper blocks the app and
  most users give up.
- Runs as a per-user LaunchAgent; an optional menu-bar companion shows status, the setup code,
  and "Open dashboard".
- Data: `~/Library/Application Support/SKP/data/`. Config and master key:
  `~/Library/Application Support/SKP/config/`, beside the data directory and never inside it
  (07 §7.7). Logs: `~/Library/Logs/SKP/`.
- Default exposure `local`; switching to `lan` lets OBS on another machine reach it.

### Linux
- Tarball with the executable, plus optional `.deb` / `.rpm`.
- systemd unit with a dedicated `skp` user, `StateDirectory=skp`, `ConfigurationDirectory=skp`,
  `NoNewPrivileges=yes`, `ProtectSystem=strict`, `ProtectHome=yes`, `PrivateTmp=yes`.
- Data `/var/lib/skp`, config `/etc/skp`; or `$XDG_DATA_HOME/skp` and `$XDG_CONFIG_HOME/skp`
  when run per-user.

## 10.5 Configuration

Precedence: **command-line flags > environment variables > `config.json` > defaults.**

| Variable | Default | Purpose |
|---|---|---|
| `SKP_PORT` | `4848` | HTTP(S) port |
| `SKP_HOST` | by exposure | Bind address override |
| `SKP_DATA_DIR` | per OS (§10.4) / `/data` | Database, media, templates |
| `SKP_CONFIG_DIR` | per OS / `/config` | Config file, master key |
| `SKP_EXPOSURE` | `lan` (server) · `local` (desktop) | 07 §7.8 |
| `SKP_PUBLIC_URL` | — | External HTTPS origin; required in `public` mode |
| `SKP_TLS_CERT` / `SKP_TLS_KEY` | — | Built-in TLS |
| `SKP_TRUST_PROXY` | — | Address(es) of a trusted reverse proxy |
| `SKP_MASTER_KEY` / `SKP_MASTER_KEY_FILE` | generated | 07 §7.7 |
| `SKP_FFMPEG` | `ffmpeg` on PATH | Media transcoding |
| `SKP_LOG_LEVEL` | `info` | `debug`·`info`·`warn`·`error` |
| `TZ` | system | Default timezone for new shows |

The platform **MUST** validate configuration at startup and exit with a specific message on
any error ("SKP_EXPOSURE=public requires TLS: set SKP_TLS_CERT/KEY or SKP_TRUST_PROXY").

## 10.6 Storage rules

- Schema migrations are versioned and forward-only. Before migrating, the platform writes a
  backup of the database next to it.
- Every non-database file write is atomic: write to a temp file in the same directory, `fsync`,
  then rename over the target. A crash mid-write never leaves a corrupt file.
- Corrupt or unreadable state at startup is moved aside (`*.corrupt-<timestamp>`) and reported,
  never silently replaced with defaults.
- Installed templates live in `<data>/templates/<id>/<build>/`: the package's files, never
  changed after install, and a receipt (`install.json`: version, build, every file's size and
  SHA-256, where it came from). An install is unpacked beside them and renamed into place in one
  step; an uninstall renames the version aside before deleting it. Startup removes what an
  interrupted install or uninstall left.
- One process uses a data directory at a time (`<data>/skp.lock`). Offline tools that change it
  (installing templates, upgrading overlays) refuse while the platform runs; a lock left by a
  process that is gone (or from before a reboot, where the OS can tell) is taken over, by
  exactly one process when several start at once. Each change they make is appended to
  `<data>/operations.log`. Run them as the user that owns the data directory: as root on
  another user's directory they refuse, since the files they wrote would be root's.

## 10.7 Updates and backups

- Versions follow SemVer. The container publishes `:1`, `:1.4`, `:1.4.2` and `:latest`.
- Updating is pulling a newer image or installing a newer build; migrations run on start.
- Downgrading across a schema migration is not supported — restore the pre-migration backup.
- The desktop app **MAY** check for updates; it is opt-in and sends nothing but the version.
- No telemetry by default.

## 10.8 Logging and observability

- Structured JSON lines: `ts`, `level`, `msg`, `component`, and context. Stdout in containers;
  rotating files (10 × 10 MB) on native installs.
- Secrets, tokens, overlay keys, cookies and `Authorization` headers are redacted at the logger,
  not at call sites.
- Unexpected errors also go to `crash.log` in the data directory with stack traces, kept for 30
  days, and surface on the dashboard.
- `GET /metrics` (Prometheus format) **MAY** be enabled for admins: connector health, events
  per second, connected overlays, scheduler lag.
