# Publishing a template as GitHub releases

A platform that follows your repository (`skp template follow owner/name`, 04 §4.13) installs
each new release by itself, and moves overlays to it when the upgrade can't break anything. To
publish one:

1. Change the template, and bump `version` in `template.json` ([SemVer](https://semver.org)):
   - **patch** (1.2.3 → 1.2.4) or **minor** (1.2.3 → 1.3.0) for changes overlays can take
     unattended: new settings with defaults, new scenes, fixes, a new look for the same data;
   - **major** (1.2.3 → 2.0.0) when you remove or rename a setting, scene or action. Overlays then
     wait for the operator to upgrade them, which shows what changes first. (Before 1.0.0, a minor
     bump counts as major.)
2. Make a GitHub release whose tag names that version (`v1.3.0`), with the package attached.

Validation runs on every install: a release that doesn't pass is not installed, and the error
shows on the operator's `skp template sources`.

## Attaching the package automatically

This workflow builds the package when you publish a release and attaches it. It uses the
platform's own `skp template pack`, so the package is exactly what the platform validates.
Save it as `.github/workflows/release.yml` in the template's repository:

```yaml
name: Attach the template package
on:
  release:
    types: [published]
permissions:
  contents: write
jobs:
  pack:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          path: template
      - uses: actions/checkout@v4
        with:
          repository: ItsLimitlezz/CTD---Overlay
          path: platform
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - run: node platform/src/main.js template pack template -o template.skp
      - run: gh release upload "$TAG" template.skp --clobber --repo "$GITHUB_REPOSITORY"
        env:
          GH_TOKEN: ${{ github.token }}
          TAG: ${{ github.event.release.tag_name }}
```

`template pack` leaves out `.git/` and desktop clutter; everything else in the repository goes
into the package, so keep the template's own files at its root (or adjust the path).

Without an attachment, the platform installs the release's source zip, which works when
`template.json` is at the repository's root (every other file in the repository is installed
with it).

## Pinning

`skp template follow owner/name@v1.2.0` follows one release only: nothing newer is installed.
Follow `owner/name` again without the tag to get new releases.
