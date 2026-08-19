# Flatpak and the AUR

Two reusable workflows publish the Linux release onward. Both run **after**
`release.yml` has published, both build from the `.deb` it produced, and both
degrade to "render and validate, don't publish" when their credentials are
absent.

Building from the released `.deb` is the deliberate choice in each case. The
alternative — building from source inside the packaging system — means
vendoring cargo and node dependencies offline, regenerating that lockfile
mirror on every dependency change, and compiling the app a second time. The
`.deb` already contains the exact binary everyone else downloaded.

## Flatpak

```yaml
  flatpak:
    needs: release
    uses: entro314-labs/tauri-release-kit/.github/workflows/flatpak.yml@main
    permissions:
      contents: write
    with:
      tag: ${{ inputs.tag || '' }}
      releases_repo: 'my-org/myapp-releases'
      app_id: 'com.example.myapp'      # MUST equal tauri.conf.json identifier
      product_name: 'myapp'
      arches: 'x86_64'
      metainfo: 'apps/desktop/flatpak.metainfo.xml'
    secrets: inherit
```

The job downloads the `.deb`, generates a manifest, builds the Flatpak,
installs it to prove the layout is usable, attaches the `.flatpak` bundle to
the release, and uploads the manifest as a workflow artifact — that manifest
is what you submit to Flathub.

### What the generated manifest does

It repacks the `.deb` with a shell script rather than a list of hardcoded
`install` lines. Names inside a Tauri `.deb` follow `productName` and
`mainBinaryName`, which differ per app and can drift; a hardcoded path that
misses fails the build with a bare "No such file" after the download. The
script discovers the binary, the desktop file and the icons, and renames the
desktop file and icons to the app ID — which the desktop requires, or the app
shows up with a blank tile.

The `command:` key is read out of the `.deb` with `dpkg-deb -c` for the same
reason.

### Permissions

The four defaults are what a Tauri window minimally needs:

```yaml
- --socket=wayland          # show a window
- --socket=fallback-x11     # ...on legacy sessions
- --share=ipc               # required for the X11 fallback to work
- --device=dri              # webview GPU acceleration
```

Add more with `extra_finish_args` (one per line). Every addition is a question
on Flathub, so add only what the app uses.

**Tray icons** need `--talk-name=org.kde.StatusNotifierWatcher` and
`--filesystem=xdg-run/tray-icon:create`; set `tray_icon: true`. The
alternative is to avoid the filesystem permission entirely by writing the
tray image into the app's own cache directory, which is already writable:

```rust
TrayIconBuilder::new()
  .icon(app.default_window_icon().unwrap().clone())
  .temp_dir_path(app.path().app_cache_dir().unwrap())
  .build()
  .unwrap();
```

**A black webview under Wayland** is usually fixed by
`--env=WEBKIT_DISABLE_COMPOSITING_MODE=1`, at the cost of compositing.

### MetaInfo

Flathub requires AppStream metadata: name, summary, description, screenshots
over HTTPS, license, content rating, releases. Start from
[`templates/flatpak/flatpak.metainfo.xml`](../templates/flatpak/flatpak.metainfo.xml)
and point the `metainfo` input at your copy.

Without the input the workflow generates a minimal placeholder so the build
still completes — it will not pass Flathub review, and the workflow says so.
Ship the same file inside your `.deb` too, so `.deb` users get the metadata in
their software centre:

```jsonc
{ "bundle": { "linux": { "deb": { "files": {
  "/usr/share/metainfo/com.example.myapp.metainfo.xml": "../flatpak.metainfo.xml"
} } } } }
```

### Runtime version

`runtime_version` pins the `org.gnome.Platform` / `org.gnome.Sdk` branch,
which supplies WebKitGTK, GTK and libsoup. Flathub keeps several branches
alive at once; pin one and bump it deliberately. A retired branch fails at the
install step with a message telling you to pick a live one.

### ARM

`arches: 'x86_64,aarch64'` builds both — on separate runners, because Flatpak
cannot cross-build. Each needs a matching `.deb` on the release; a missing one
is a warning and that architecture is skipped.

### Submitting to Flathub

1. Fork [flathub/flathub](https://github.com/flathub/flathub) and clone the
   `new-pr` branch.
2. Branch, add the manifest (from the workflow artifact) and the MetaInfo.
3. Open a PR against `new-pr`.

Review focuses on permissions and metadata. Once accepted you get commit
access to your app's own Flathub repository, and later releases are a manifest
bump.

### Adding libraries

If the app needs a library the GNOME runtime does not carry, build it from
source as an extra module. Copying a `.so` from your host "just for testing"
is the trap: it was linked against your distribution's libc and runtime, not
the Flatpak one, and the resulting crashes are very hard to trace back. Use
`manifest_template` for this — see
[`templates/flatpak/manifest.template.yml`](../templates/flatpak/manifest.template.yml).

## AUR

```yaml
  aur:
    needs: release
    uses: entro314-labs/tauri-release-kit/.github/workflows/aur.yml@main
    with:
      tag: ${{ inputs.tag || '' }}
      releases_repo: 'my-org/myapp-releases'
      pkgname: 'myapp-bin'
      pkgdesc: 'One-line app description'
      url: 'https://example.com'
      license: 'MIT'
      maintainer: 'Your Name <you@example.com>'
      provides: 'myapp'
      conflicts: 'myapp'
    secrets: inherit
```

### The `-bin` suffix is not a style choice

Arch requires prebuilt binary packages to carry it. `myapp-bin` is the
repacked release; `myapp` would be a from-source package and `myapp-git` a
VCS one. Setting `provides: 'myapp'` lets anything depending on `myapp` be
satisfied by the `-bin` package.

### Setup

1. Create an account at [aur.archlinux.org](https://aur.archlinux.org) and add
   an SSH **public** key under Account → SSH Public Key.
2. Put the matching private key in the `AUR_SSH_PRIVATE_KEY` secret.

You do not need to create the AUR repository — the first push creates it.

Run it with `dry_run: true` for the first release or two. The PKGBUILD is
still rendered, validated and uploaded as an artifact; it just is not
published, and you get to read what would have gone out.

### What gets validated before anything is pushed

Inside a real `archlinux:base-devel` container, as an unprivileged user
(makepkg refuses to run as root — the same constraint every AUR contributor
hits locally):

- `makepkg --printsrcinfo` generates `.SRCINFO`, which the AUR requires and
  which must stay in sync with the PKGBUILD.
- `makepkg --verifysource` re-downloads every source URL and checks it against
  the recorded `sha256sums`. This catches a wrong URL or a stale checksum
  here, rather than in the inbox of every Arch user whose update just broke.
- `namcap` lints the PKGBUILD, advisory only — its rules change between
  versions and none of them are release blockers.

Source URLs must be publicly downloadable: the AUR builds on every user's
machine, so a private releases repository cannot back an AUR package. The
workflow says exactly that when verification fails.

### Version mapping

Arch forbids `-` in `pkgver` (it separates version from release), so
`v1.0.0-beta.1` becomes `1.0.0_beta.1`. That still orders correctly under
`vercmp`, so upgrades work.

### The generated PKGBUILD

```ini
options=('!strip' '!debug')
```

`!strip` because the binary is already stripped and re-stripping a release
build only costs time; `!debug` because there is no source to attach debug
symbols to in a `-bin` package — without it makepkg builds an empty `-debug`
package and fails.

`package()` is a single `tar -xf data.tar.* -C "${pkgdir}"`: the `.deb` layout
maps one-to-one onto the Arch package root, so nothing needs rewriting.

The `.install` scriptlet refreshes the icon and desktop-entry caches, without
which the app installs but does not show up in the launcher until something
else happens to refresh them.

### Maintenance

The workflow overwrites the PKGBUILD on every release, so hand edits in the
AUR repository are lost. Change the inputs instead. If packaging changes but
the app version does not, bump `pkgrel`.

## What this kit does not do

**Snap.** Snapcraft's build service and confinement model do not map onto the
"repack the release" approach these two use, and its store requires an
interactive login this pipeline has nowhere to put.

**Debian/Ubuntu repositories (apt).** Signing a repository means running one:
`Release`/`Release.gpg`/`InRelease` metadata, a stable hosting location, and a
key users add to their trust store. The `.deb` this kit produces installs
fine with `dpkg -i`; a repository is a separate ongoing service, not a release
step.

**Homebrew** is covered — see the cask job in `release.yml` and the README.
