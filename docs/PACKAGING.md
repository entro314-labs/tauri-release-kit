# Packaging — every bundle format, and what the kit does with it

Tauri can emit nine bundle formats. This is what each one is for, what the kit
builds by default, and the configuration surface you actually need. Signing is
covered separately in [SIGNING.md](SIGNING.md); the Flatpak and AUR channels
in [LINUX_STORES.md](LINUX_STORES.md); the App Store in
[APP_STORE.md](APP_STORE.md).

## What the pipeline builds

| Platform | Default (`*_bundles` input) | Updater consumes | Also available |
| --- | --- | --- | --- |
| macOS | `app,dmg` | `.app.tar.gz` (from `app`) | — |
| Windows | `nsis` | `*-setup.exe` (from `nsis`) | `msi` |
| Linux | `deb,rpm,appimage` | `.AppImage` | — |

The format the updater consumes cannot be removed while that platform ships —
the `plan` job hard-errors, because the alternative is a manifest with a null
URL that only fails after the whole matrix has been paid for.

Everything else is your choice. Each format costs bundling time and release
storage, not compile time — the binary is compiled once per leg regardless.

## macOS

### `app` — the application bundle

The `.app` is a directory: `Contents/MacOS/<binary>`, `Contents/Resources/`,
`Contents/Info.plist`, `Contents/Frameworks/`, `_CodeSignature/`. Everything
else on macOS wraps it.

```jsonc
{
  "bundle": {
    "macOS": {
      // Default is 10.13. Raise it if you use a newer API — and note that
      // an Apple-Silicon-only App Store build requires 12.0.
      "minimumSystemVersion": "12.0",
      // System frameworks by name; local frameworks and dylibs by full path
      // relative to src-tauri.
      "frameworks": ["CoreAudio", "./libs/libfoo.dylib"],
      // Copied into <product>.app/Contents/<destination>.
      "files": { "SharedSupport/docs.md": "./docs/index.md" },
      "entitlements": "./Entitlements.plist"
    }
  }
}
```

**Info.plist.** Create `src-tauri/Info.plist` to add keys; it is *merged* with
the one Tauri generates. Do not set keys Tauri owns — `CFBundleVersion`,
`CFBundleShortVersionString`, `CFBundleIdentifier`. A conflicting version here
wins silently and desynchronizes the app from the updater manifest, which is
exactly the failure the pipeline's version-file discipline exists to prevent.

**Localizing Info.plist.** `Info.plist` holds one language. For more, ship
`<lang>.lproj/InfoPlist.strings` files through the resources feature:

```
src-tauri/infoplist/de.lproj/InfoPlist.strings
src-tauri/infoplist/fr.lproj/InfoPlist.strings
```

```jsonc
{ "bundle": { "resources": { "infoplist/**": "./" } } }
```

The `lproj` directory names and the `InfoPlist.strings` filename (capital I,
capital P) are fixed; the containing folder name is yours.

### `dmg` — the disk image

The installer window with the drag-to-Applications arrow. It is also what
carries the stapled notarization ticket, and what the Homebrew cask downloads.

```jsonc
{
  "bundle": {
    "macOS": {
      "dmg": {
        "background": "./images/dmg-background.png",
        "windowSize": { "width": 800, "height": 600 },
        "windowPosition": { "x": 400, "y": 400 },
        "appPosition": { "x": 180, "y": 220 },
        "applicationFolderPosition": { "x": 480, "y": 220 }
      }
    }
  }
}
```

> **Icon sizes and positions are not applied when a DMG is built on CI**
> ([tauri#1731](https://github.com/tauri-apps/tauri/issues/1731)). The
> background image still applies. Design a background that reads correctly
> with default icon placement, or accept that your local builds look different
> from your released ones.

DMG creation requires a real macOS host. Both are true of this kit's macOS
legs, so nothing extra is needed.

## Windows

### `nsis` — `*-setup.exe` (default)

NSIS is the default here for three reasons: it is the only Windows format that
can be cross-compiled, it handles non-numeric semver pre-release identifiers,
and it targets ARM64. All three matter to a release pipeline that ships alphas
on four Windows-capable configurations.

```jsonc
{
  "bundle": {
    "windows": {
      "nsis": {
        // perUser (default): installs to %LOCALAPPDATA%, no admin prompt.
        // perMachine: C:\Program Files, requires admin.
        // both: the user chooses — and the installer always asks for admin.
        "installMode": "perUser",
        "languages": ["English", "German"],
        "displayLanguageSelector": false,
        "installerIcon": "./icons/installer.ico",
        "headerImage": "./icons/nsis-header.bmp",
        "sidebarImage": "./icons/nsis-sidebar.bmp",
        "installerHooks": "./windows/hooks.nsh",
        "startMenuFolder": "MyCompany"
      }
    }
  }
}
```

**Installer hooks** extend the installer without replacing its template:
`NSIS_HOOK_PREINSTALL`, `NSIS_HOOK_POSTINSTALL`, `NSIS_HOOK_PREUNINSTALL`,
`NSIS_HOOK_POSTUNINSTALL`, defined as macros in a `.nsh` file. The usual
reason is installing a runtime dependency (Visual C++ Redistributable,
DirectX):

```nsh
!macro NSIS_HOOK_POSTINSTALL
  ReadRegDWord $0 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Installed"
  ${If} $0 == 1
    DetailPrint "Visual C++ Redistributable already installed"
    Goto vcredist_done
  ${EndIf}
  ${If} ${FileExists} "$INSTDIR\resources\vc_redist.x64.msi"
    CopyFiles "$INSTDIR\resources\vc_redist.x64.msi" "$TEMP\vc_redist.x64.msi"
    ExecWait 'msiexec /i "$TEMP\vc_redist.x64.msi" /passive /norestart' $0
    ${If} $0 != 0
      MessageBox MB_ICONEXCLAMATION "Visual C++ installation failed. Some features may not work."
    ${EndIf}
    Delete "$TEMP\vc_redist.x64.msi"
    Delete "$INSTDIR\resources\vc_redist.x64.msi"
  ${EndIf}
  vcredist_done:
!macroend
```

Always check whether the dependency is present first, always use
`/passive` + `/norestart` so the installer does not reboot the machine
mid-install, and always clean up the bundled installer afterwards — otherwise
every user permanently carries a 25 MB redistributable inside your app
directory.

### `msi` — WiX (opt-in)

Set `windows_bundles: 'nsis,msi'`. MSI is what corporate deployment tooling
(Group Policy, Intune, SCCM) expects, which is the main reason to ship it.

The pipeline **drops MSI automatically, with a warning rather than an error**,
in the two cases where WiX cannot work:

- **Prerelease versions.** WiX rejects non-numeric semver pre-release
  identifiers, so `0.2.0-alpha.1` fails at bundle time — after that leg has
  already compiled.
- **ARM64.** WiX has no ARM64 target at all.

NSIS still ships in both cases, so an alpha loses nothing.

Two more MSI-only constraints: building one requires a Windows host (WiX runs
nowhere else), and it requires the VBSCRIPT optional Windows feature — its
absence surfaces as `failed to run light.exe`, which says nothing about
VBScript.

WiX is extended with fragments rather than hooks:

```jsonc
{
  "bundle": {
    "windows": {
      "wix": {
        "fragmentPaths": ["./windows/fragments/registry.wxs"],
        "componentRefs": ["MyFragmentRegistryEntries"],
        "language": { "en-US": null, "pt-BR": { "localePath": "./wix/locales/pt-BR.wxl" } }
      }
    }
  }
}
```

Note the asymmetry in internationalization: NSIS produces **one** installer
containing every selected language; WiX produces **one installer per
language**, each suffixed with its language key. An app shipping five WiX
languages ships five MSIs.

### WebView2 installation mode

This is the highest-impact Windows setting most apps never revisit.

| Mode | Internet needed | Added size | Use when |
| --- | --- | --- | --- |
| `downloadBootstrapper` | yes | 0 MB | Default. Fine for Windows 10 (April 2018+) and 11, where WebView2 ships with the OS. |
| `embedBootstrapper` | yes | ~1.8 MB | Better Windows 7 behaviour via MSI. |
| `offlineInstaller` | no | ~127 MB | Air-gapped or restricted-network deployments. |
| `fixedVersion` | no | ~180 MB | You must control the exact WebView2 build (regression pinning, validated environments). |
| `skip` | no | 0 MB | Almost never. The app simply fails to start without the runtime. |

```jsonc
{ "bundle": { "windows": { "webviewInstallMode": { "type": "downloadBootstrapper" } } } }
```

If your app needs an API only newer WebView2 versions have (custom URI
schemes, for instance), make the installer check:

```jsonc
{ "bundle": { "windows": { "minimumWebview2Version": "110.0.1531.0" } } }
```

`fixedVersion` takes a `path` to an extracted fixed-version runtime folder,
which you download from Microsoft and expand into `src-tauri`.

## Linux

### The glibc rule, which outranks everything else here

Build on the **oldest** base system you intend to support that still provides
WebKitGTK 4.1 — Ubuntu 22.04 or Debian 12. Compiling on something newer raises
your binary's minimum glibc, and the failure lands on *users*, at startup,
as:

```
/usr/lib/libc.so.6: version 'GLIBC_2.33' not found
```

This kit builds Linux legs on `ubuntu-24.04` images, which means a glibc 2.39
floor. If you need to support older distributions, that is the number to
change — and a Docker-based build on 22.04 is the way to change it, not a
config option.

Related: GUI apps on Linux and macOS do not inherit `$PATH` from your shell
dotfiles. If your app shells out to anything, use Tauri's
[`fix-path-env-rs`](https://github.com/tauri-apps/fix-path-env-rs).

### `deb`

Tauri's stock `.deb` already declares `libwebkit2gtk-4.1-0`, `libgtk-3-0`, and
`libappindicator3-1` when the app uses a tray icon, generates the desktop
entry, and installs the icons. It is also the package the Flatpak and AUR
channels repack, so keep it in `linux_bundles` if you ship either.

```jsonc
{
  "bundle": {
    "linux": {
      "deb": {
        "depends": ["libsomething2"],
        "files": {
          "/usr/share/metainfo/com.example.MyApp.metainfo.xml": "../flatpak.metainfo.xml",
          "/usr/share/assets": "../assets/"
        }
      }
    }
  }
}
```

Shipping the AppStream MetaInfo through the `.deb` is worth doing: desktop
software centres read it from a `.deb` install too, so the app gets a proper
name, description and screenshots instead of a bare desktop entry.

### `rpm`

More configurable than the deb bundler, and the only Linux format Tauri can
sign itself:

```jsonc
{
  "bundle": {
    "linux": {
      "rpm": {
        "release": "1",
        "epoch": 0,
        "depends": ["newLib"],
        "provides": ["coolLib"],
        "conflicts": ["oldLib"],
        "obsoletes": ["veryoldLib"],
        "desktopTemplate": "./desktop-template.desktop",
        "preInstallScript": "./scripts/preinstall.sh",
        "postInstallScript": "./scripts/postinstall.sh",
        "preRemoveScript": "./scripts/preremove.sh",
        "postRemoveScript": "./scripts/postremove.sh"
      }
    }
  }
}
```

`obsoletes` **removes** the listed packages on install — useful when renaming
a package, dangerous otherwise. Leave `epoch` at 0 unless you have broken your
own version ordering and must force an upgrade path; it permanently changes
how every future version of the package compares.

Inspecting what you actually built:

```bash
rpm -qip pkg.rpm          # name, version, release, arch, size
rpm -qlp pkg.rpm          # file list
rpm -qp --scripts pkg.rpm # the install/remove scriptlets
rpm -qp --requires pkg.rpm
rpm -ivvh pkg.rpm         # very verbose install, for debugging failures
```

### `appimage`

One self-contained ~70 MB file (versus 2–6 MB for a `.deb`) that runs on any
distribution without installation. Required by the updater, so it is always
built.

```jsonc
{
  "bundle": {
    "linux": {
      "appimage": {
        // Bundles GStreamer so <video>/<audio> work. Large, and the "ugly"
        // plugin set carries licensing terms that complicate redistribution.
        "bundleMediaFramework": true,
        // Destination paths MUST start with /usr/.
        "files": { "/usr/share/README.md": "../README.md" }
      }
    }
  }
}
```

AppImage tooling **cannot cross-compile**: an ARM64 AppImage must be built on
ARM64 hardware. This kit uses the native `ubuntu-24.04-arm` runner for that,
which takes about ten minutes. The QEMU-emulated alternative
(`pguyot/arm-runner-action`) takes about an hour for an uncached build and is
only worth it in a public repository where minutes are free.

Two runner-environment facts baked into the pipeline: linuxdeploy is itself an
AppImage and needs FUSE2 (`libfuse2t64` on 24.04 images), and its bundled
strip pass breaks against those images' binutils — hence `NO_STRIP=true`,
which costs nothing because cargo's release profile already stripped the
binary.

## Cross-compiling for ARM Linux, manually

The kit uses native ARM runners, so it never does this. If you need to build
ARM packages on an x86 Debian/Ubuntu machine:

```bash
rustup target add aarch64-unknown-linux-gnu
sudo apt install gcc-aarch64-linux-gnu
```

```toml title=".cargo/config.toml"
[target.aarch64-unknown-linux-gnu]
linker = "aarch64-linux-gnu-gcc"
```

```bash
sudo dpkg --add-architecture arm64
# Add ports.ubuntu.com sources for arm64 AND pin [arch=amd64] on every
# existing line, or apt breaks for the host architecture.
sudo apt-get update
sudo apt install libwebkit2gtk-4.1-dev:arm64
export PKG_CONFIG_SYSROOT_DIR=/usr/aarch64-linux-gnu/
cargo tauri build --target aarch64-unknown-linux-gnu
```

If you hit `Failed to find OpenSSL development headers`, either install
`libssl-dev:arm64` or vendor it — `openssl-sys = { version = "0.9", features = ["vendored"] }`,
which affects every dependency using the same minor version.

This produces `.deb` and `.rpm` only. AppImage still needs ARM hardware.

## The per-OS overlay configs

The pipeline passes `--config src-tauri/tauri.<os>.conf.json` on every leg, so
those three files must exist even when nearly empty. Without the flag the
per-OS overrides are silently dropped — the app builds, and the platform
settings you wrote simply do nothing.

Tauri merges `--config` files in the order given, so the pipeline appends a
second one for generated content (Windows signing). Keys are merged deeply;
later files win on conflict.

Generated overlays are written next to them as `src-tauri/.release-kit.*.conf.json`.
They exist only for the duration of a run, but add this to your `.gitignore`
so a local reproduction never commits one:

```gitignore
src-tauri/.release-kit.*.conf.json
src-tauri/embedded.provisionprofile
```
