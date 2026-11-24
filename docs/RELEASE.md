# Releasing CTD Overlay

A release is a version in `package.json`, a Git tag `vX.Y.Z` on `main`, and the container image
`ghcr.io/itslimitlezz/ctd-overlay:X.Y.Z` (no `v`) built from that tag. TrueNAS runs the image.
Who does what (hub `TEAM.md`): the SR checks and merges; the Mac Runner tags, builds and deploys
with Juan's OK. Never deploy while a show is on.

## 1. Before the tag

- `main` has the release: version bumped per the hub's CONVENTIONS, and a `CHANGELOG.md` entry.
- CI is green **on `main`**: run it by hand (Actions → CI → Run workflow → `main`), or
  `gh workflow run ci.yml --repo ItsLimitlezz/ctd-overlay --ref main`. Both jobs must pass:
  `test` (the full suite on Ubuntu) and `image` (the media tests inside the image itself, on the
  ffmpeg it ships).

## 2. Tag and build the image

```bash
git tag -a v0.15.10 <merge commit> -m "CTD Overlay 0.15.10"
git push origin v0.15.10
```

The tag push starts **Container image** (`.github/workflows/image.yml`). It checks that the tag
matches `package.json`, builds linux/amd64 + linux/arm64, smoke-tests the image (`/healthz`, then
the media tests inside it) and pushes `:0.15.10`, `:0.15` and `:sha-<short>`.

If no run shows up under Actions within a minute, start it by hand **on the tag**. (Until
2026-11-24 GitHub created runs in this repository only for "Run workflow"; #24 got the first run
from a pull request, and a tag push is still to be seen.)

```bash
gh workflow run image.yml --repo ItsLimitlezz/ctd-overlay --ref v0.15.10
gh run list --repo ItsLimitlezz/ctd-overlay --workflow image.yml --limit 1   # then: gh run watch <id>
```

(or Actions → Container image → Run workflow → "Use workflow from" → Tags → `v0.15.10`). A run on
the tag makes the same tags as a push. Then check both platforms are there:

```bash
docker buildx imagetools inspect ghcr.io/itslimitlezz/ctd-overlay:0.15.10   # linux/amd64 and linux/arm64
```

## 3. Deploy on TrueNAS

1. **Note the image running now** (Apps → Installed → ctd-overlay → Edit → Image), for the
   rollback. Example: `ghcr.io/itslimitlezz/ctd-overlay:sha-925e5ae`.
2. **Snapshot the app's datasets.** Datasets → the app's dataset (the parent of its `data` and
   `config` datasets) → Data Protection → Create Snapshot, **Recursive**, named `pre-0.15.10`.
3. **Change the image line, and only that, on the Apps page.** Apps → Installed → ctd-overlay →
   Edit → Image tag → `0.15.10` → Save. Leave the environment variables, ports and storage as they
   are. Don't install `deploy/truenas.yml` again: that is the first-install template, and a new
   install is a new app.
4. **Check.** Apps → ctd-overlay → Logs has `starting` with `"version":"0.15.10"`, and Settings →
   About says 0.15.10. The overlays in OBS come back by themselves (their URLs don't change).

Keep the snapshot until Juan has streamed on the new version.

## 4. Roll back

1. Apps → Installed → ctd-overlay → Edit → Image tag → the previous one (step 3.1) → Save.
2. Only if it then won't start, or the data looks wrong (a release whose CHANGELOG says the data
   moved to a new format): stop the app, Datasets → the app's dataset → Data Protection → Manage
   Snapshots → `pre-0.15.10` → Rollback (on `data` and `config`), and start it again on the
   previous image. Anything changed since the snapshot is lost.
