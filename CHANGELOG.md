# Changelog

CTD Overlay's versions, newest first (numbering: the hub's CONVENTIONS). How a release is made and
deployed: [`docs/RELEASE.md`](docs/RELEASE.md). Versions before 0.15.10 are described in their pull
requests (0.10.0: #21 and #22; 0.15.0: #23).

## 0.15.10 (2026-11-24): fixes

- **Phone video is tagged BT.709 again on ffmpeg 8.** Since ffmpeg 7.1, ffmpeg takes a clip's
  colour tags from its pictures, over `-color_primaries` and `-color_trc`. On ffmpeg 8 (the image
  ships 8.1.3) a converted clip came out with its matrix tagged and its primaries and transfer not,
  so a player had to guess them. The tags now go on the pictures as well, with the range, so every
  converted clip says BT.709, limited range, on ffmpeg 6, 7 and 8.
- **Clips in other colours are converted to BT.709, not only tagged.** An SDR clip whose file names
  other colours (BT.601 from an older Android phone, P3, BT.2020) is converted with zscale; full
  range and RGB clips are converted by the scaler. iPhone HDR is tone-mapped as before. Without
  zscale (or if zscale refuses the clip's colours) it is converted without, and tagged all the same.
- **Admin UI: a button pressed before its page finished loading keeps the focus.** Shows' "New
  show", pressed by keyboard while the list was still loading, gave the focus to the page when its
  dialog closed. Seen as a flaky browser test under load.
- **The image's ffmpeg is the one CI tests.** The Dockerfile pins Alpine 3.24 (ffmpeg 8.1.x), and CI
  and the image build run the media tests inside the built image.
- **Image builds:** a `vX.Y.Z` tag (pushed, or chosen when the workflow is run by hand) builds and
  pushes `:X.Y.Z` and `:sha-<short>`; the tag must match `package.json`. Pushes to `main` no longer
  build (prod builds only, per the hub's build policy); run the workflow by hand on `main` for
  `:latest`.
