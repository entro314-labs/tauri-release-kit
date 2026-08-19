# Flatpak templates

The `flatpak.yml` reusable workflow generates a working manifest from its
inputs, so the only file you normally need from here is the MetaInfo XML —
which Flathub requires and cannot be generated meaningfully.

| File | Purpose |
| --- | --- |
| `flatpak.metainfo.xml` | AppStream metadata: name, description, screenshots, releases |
| `manifest.template.yml` | Escape hatch for apps whose Flatpak needs more than the generated manifest |

## Shipping the MetaInfo inside the .deb too

Desktop software centres pick up AppStream metadata from `.deb` installs as
well. Add it to your Tauri config so both packages carry it:

```json
{
  "bundle": {
    "linux": {
      "deb": {
        "files": {
          "/usr/share/metainfo/com.example.MyApp.metainfo.xml": "../flatpak.metainfo.xml"
        }
      }
    }
  }
}
```

## When to use `manifest.template.yml`

Use it when the app needs something the generated manifest cannot express:
extra modules (a library built from source inside the Flatpak), non-trivial
`build-options`, or a different runtime entirely. The workflow substitutes
`@APP_ID@`, `@VERSION@`, `@DEB_URL@`, `@DEB_SHA256@`, `@ARCH@` and
`@RUNTIME_VERSION@` before building, so it stays release-driven.

Bundling a library from your host system into the Flatpak "just to test it"
is the trap here: the `.so` was linked against your distro's libc and
runtime, not the Flatpak one, and the resulting crashes are very hard to
trace. Build the dependency from source as a module instead.

## Submitting to Flathub

1. Fork <https://github.com/flathub/flathub> and clone the `new-pr` branch.
2. Create a branch named after your app.
3. Add the manifest (download it from the workflow's artifacts) and the
   MetaInfo file.
4. Open a pull request against `new-pr` and expect review comments —
   permissions in `finish-args` get the most scrutiny.

Once accepted you get commit access to your app's own Flathub repository and
subsequent releases are a manifest bump.
