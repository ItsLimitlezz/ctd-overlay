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
          repository: ItsLimitlezz/ctd-overlay
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

## Several templates in one repository

One repository can hold several templates, each released on its own: D/PRTMNT's
"Takeover - DPRTMNT" (`com.dprtmnt.show`) and "GTA - DPRTMNT" (`com.dprtmnt.gta`), say. Each
template gets its own folder and its own **tag prefix**, and the operator follows the repository
once per prefix. Each of those sources installs, and auto-updates, only its own template.

### Layout and tags

```
templates/
  dprtmnt-takeover/    template.json (id com.dprtmnt.show), index.html, …
  dprtmnt-gta/         template.json (id com.dprtmnt.gta), …
.github/workflows/release.yml
```

| Template | Folder | Release tag | Attached file |
| --- | --- | --- | --- |
| `com.dprtmnt.show` | `templates/dprtmnt-takeover/` | `takeover-v1.3.0` | `dprtmnt-takeover-1.3.0.skp` |
| `com.dprtmnt.gta` | `templates/dprtmnt-gta/` | `gta-v1.0.0` | `dprtmnt-gta-1.0.0.skp` |

- A release is one template's: its tag is the template's prefix then the version in its
  `template.json` (`takeover-v` + `1.3.0`). Release one template at a time.
- Pick prefixes that end before the version and that aren't the start of each other where you
  can (`takeover-v` and `gta-v`). If one is (`takeover-v` and `takeover-vertical-v`), the longer
  one's source takes the tags that start with it.
- A bare `v1.3.0` tag belongs to no prefix: keep it for a repository with one template.
- GitHub's "latest release" is whichever template was released last. That's fine: a source
  with a prefix reads the repository's newest releases and takes the newest with its prefix.

### Attaching the right package

This `release.yml` packs the folder that matches the release's tag prefix with the platform's
own `skp template pack` and attaches it as `<name>-<version>.skp`. It fails, attaching nothing,
for a tag with no known prefix, a missing folder, or a version that isn't the template's:

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
          path: repo
      - uses: actions/checkout@v4
        with:
          repository: ItsLimitlezz/ctd-overlay
          path: platform
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - name: Pack the template this tag is for
        env:
          TAG: ${{ github.event.release.tag_name }}
        run: |
          # One line per template: tag prefix, then folder name under templates/.
          # A prefix that starts another one goes after it (takeover-vertical-v before takeover-v).
          case "$TAG" in
            takeover-v*) prefix=takeover-v; name=dprtmnt-takeover ;;
            gta-v*)      prefix=gta-v;      name=dprtmnt-gta ;;
            *) echo "::error::$TAG has no known tag prefix (takeover-v, gta-v): nothing attached."; exit 1 ;;
          esac
          version="${TAG#"$prefix"}"
          dir="repo/templates/$name"
          if [ ! -f "$dir/template.json" ]; then echo "::error::$dir/template.json is missing."; exit 1; fi
          own="$(jq -r .version "$dir/template.json")"
          if [ "$own" != "$version" ]; then echo "::error::$TAG is version $version, but $dir/template.json says $own."; exit 1; fi
          node platform/src/main.js template pack "$dir" -o "$name-$version.skp"
          echo "FILE=$name-$version.skp" >> "$GITHUB_ENV"
      - run: gh release upload "$TAG" "$FILE" --clobber --repo "$GITHUB_REPOSITORY"
        env:
          GH_TOKEN: ${{ github.token }}
          TAG: ${{ github.event.release.tag_name }}
```

`template pack` validates as it packs, so a template that wouldn't install fails here too.

### Following each one

The operator follows the repository once per template, each with its prefix:

```bash
npm run skp -- template follow owner/name --tag-prefix takeover-v
npm run skp -- template follow owner/name --tag-prefix gta-v
npm run skp -- template sources     # each with its prefix: github:owner/name#takeover-v, …#gta-v
```

In the admin pages: **Templates → Automatic updates → Follow a repository**, the repository,
**Release tag prefix** `takeover-v`, **Follow**; then again with `gta-v`. Installing a release from
**Install template → From GitHub or a link** with **Install its new releases by themselves**
ticked fills the prefix in from the release picked (`takeover-v1.3.0` → `takeover-v`).

With the repository followed more than once, name a source with its prefix:
`template update owner/name#gta-v`, `template unfollow owner/name#takeover-v` (`owner/name` alone is
ambiguous then, and says so). Following it again with a prefix already followed is refused.

A source of the repository **without** a prefix (one followed before the templates were split,
say) installs only releases whose tags start with none of the others' prefixes. While the
repository is also followed with two or more prefixes, that source shows a warning: unfollow it,
and follow the repository with the prefix of the template it should update.

## Pinning

`skp template follow owner/name@v1.2.0` follows one release only: nothing newer is installed.
Follow `owner/name` again without the tag to get new releases.
