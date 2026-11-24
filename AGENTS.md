# AGENTS.md — ctd-overlay
> Team rules live in the hub: github.com/ItsLimitlezz/CTD-Software-Suite → AGENTS.md (read it first). This file is repo-specific.

## What this is
**CTD Overlay** (package `ctd-overlay` v0.15.10): self-hosted stream-overlay platform for OBS browser sources: merged chat, alerts, scenes, timed shows and templates, fed by CTD Relay. Implements the Stream Kit Platform Standard (`skp/1`); successor to the D/PRTMNT Stream Kit (v0).
Plain Node.js 24 server (no runtime npm dependencies, `node:sqlite`); runs on the PC that runs OBS or as a Linux container (TrueNAS). Public repo licensed **AGPL-3.0-only** (see `LICENSE`; same as CTD Relay, which Overlay will merge into later), so it is open-source under the hub's rule.

## Layout
| Path | What |
| --- | --- |
| `src/` | Server: `main.js`/`app.js`, `http/`, `store/`, `bus/`, `connectors/` (Relay etc.), `overlays/`, `shows/`, `alerts/`, `templates/`, `sdk/` (overlay runtime `SK`), `ui/` (admin UI), `auth/`, `secrets.js`, `obs/` |
| `templates/` | Built-in templates: alerts, chat, takeover, text-clock, viewers, diagnostic |
| `test/` | `node --test` suites (`*.test.js`), fixtures, helpers |
| `scripts/` | `diag.js`, `takeover-demo.js`, `ui-smoke.js` |
| `docs/standard/` | The `skp/1` standard (01-11, schemas) |
| `docs/template-kit/` | Template authoring kit and guide |
| `docs/` | `GUIDE.md`, `RUNNING.md`, `PLAN.md` (build plan), `template-releases.md` |
| `Dockerfile`, `deploy/truenas.yml` | Container image and TrueNAS YAML |

## Build & test
No build step and no `npm install`. Non-Apple, so run on the **PC** (Node >= 24).
- Run: `npm start` (http://127.0.0.1:4848; setup code is in the log)
- Test: `npm test` (`node --test --test-timeout=180000 "test/**/*.test.js"`; CI also installs ffmpeg for the media tests)
- Demo: `npm run demo` (port 4950); diagnostics: `npm run diag` (port 4949)
- UI check: `node scripts/ui-smoke.js /live /overlays --phone --shots shots` (needs headless Chrome or Edge)
- Image: `docker build` from `Dockerfile` (whether the PC has Docker: TBD (owner to confirm)).
- Cloud sessions can run `npm test` if Node 24 and ffmpeg are present; otherwise tag the PR `needs-build:pc`.

## Release
[`docs/RELEASE.md`](./docs/RELEASE.md): CI green on `main`, tag `vX.Y.Z`, image `ghcr.io/itslimitlezz/ctd-overlay:X.Y.Z` (no `v`; also `:X.Y` and `:sha-...`) from `.github/workflows/image.yml` (on a `v*` tag, or run by hand: on a tag, on `main` for `:latest`, on `release/**` for `:release-...`), then the TrueNAS deploy (snapshot, image line on the Apps page, rollback). Notes per version in `CHANGELOG.md`. The repo is AGPL-3.0-only (open-source), so prod builds use GitHub Actions (hub TEAM.md build policy). Templates are released separately as GitHub releases: `docs/template-releases.md`. Do not run or edit these workflows without a Senior.

## Conventions & gotchas
- Plain JavaScript ES modules, **no runtime npm packages** (docs/PLAN.md decision 8); dev-only tools are fine.
- Bundled templates and the SDK must run in OBS 30's browser (Chromium 103): no CSS nesting, `:has()` or container queries.
- The hard rules in `docs/standard/11-hard-rules.md` are normative (e.g. overlay URLs are permanent, server owns the show, durable before visible, never show a wrong number). Don't break them.
- Data (`/data`) and master key (`/config`) are separate on purpose; container runs as UID/GID 568.
- Binds to 127.0.0.1 unless `SKP_EXPOSURE=lan|public`. Settings are `SKP_*` env vars.
- `.github/workflows/ci.yml`: `npm test` on Ubuntu (Linux only), plus the media tests inside the built image (its own ffmpeg). It is set to run on PRs and pushes to `main`, but GitHub has only ever created runs here for "Run workflow" (as of 2026-11-24), so a Senior runs it by hand.
- The image pins Alpine (`node:24-alpine3.24`), which fixes the ffmpeg it ships (8.1.x). ffmpeg 7.1+ takes colour tags from the frames over the `-color_*` options: keep the `setparams` tags in `videoArgs`.
- Depends on CTD Relay's API and is configured from the CTD OBS plugin: cross-repo changes go through the hub's AGENT-REQUESTS.md.

## Required reading
- `README.md`, then `docs/RUNNING.md` for set-up/run
- `docs/standard/README.md` and `docs/standard/11-hard-rules.md` before touching core behavior
- `docs/PLAN.md` (ground rules); `docs/template-kit/TEMPLATE-GUIDE.md` for template work
- Lessons file: none yet.
