# tauri-release-kit

Shared CI/CD + versioning for Tauri apps. One reusable release pipeline —
6-platform build matrix, every bundle format Tauri emits, distribution code
signing on all three OSes, minisign-signed auto-updater artifacts, per-channel
rolling update manifests (`stable` / `beta` / `alpha`), changelog guard,
cross-repo publishing to a public releases mirror, pre-publish verification,
post-release version-bump PR — plus companion workflows that push the same
release onward to Homebrew, Flathub, the AUR, and the App Store, reusable Rust
quality gates, a local preflight harness, and a version sync script.

Every optional piece degrades gracefully: no credentials means that channel
skips itself with a warning, never a failed release. A *half*-configured one
fails immediately, because that is someone's intent going silently unmet.

Extracted from a production app's first releases. Every odd-looking step
encodes a CI failure that actually happened; read
[docs/GOTCHAS.md](docs/GOTCHAS.md) before "simplifying" anything.

## What consumers call

| Workflow | Purpose |
| --- | --- |
| `.github/workflows/release.yml` | Tag-triggered release: build → sign → manifest → verify → publish |
| `.github/workflows/rust-checks.yml` | fmt + clippy (+ tests) on ubuntu/macos/windows for branch pushes |
| `.github/workflows/flatpak.yml` | Repacks the released `.deb` into a Flatpak bundle + Flathub manifest |
| `.github/workflows/aur.yml` | Renders, validates and publishes a `-bin` PKGBUILD to the AUR |
| `.github/workflows/app-store.yml` | Builds and uploads a Mac App Store `.pkg` / iOS `.ipa` |

All five are `workflow_call` reusable workflows — fixes land here once and
every app picks them up. Pin `@main` for latest or a tag for stability. The
last three chain off `release.yml` with `needs:` in one caller file; see
[`templates/release.yml`](templates/release.yml).

### Distribution channels

| Channel | Built from | Wired by |
| --- | --- | --- |
| Direct download (dmg / setup.exe / AppImage / deb / rpm) | source | `release.yml` |
| Auto-updater (per channel) | the above | `release.yml` |
| Homebrew cask | the released `.dmg` | `release.yml` (`homebrew_tap`) |
| Flathub / Flatpak bundle | the released `.deb` | `flatpak.yml` |
| Arch User Repository | the released `.deb` | `aur.yml` |
| Mac App Store / iOS App Store | source (separate, sandboxed build) | `app-store.yml` |

Assumptions about the calling repo: pnpm frontend (built via
`beforeBuildCommand`), Tauri project at `<project_path>/src-tauri` with
per-OS overlay configs, a pinned `rust-toolchain.toml` at the repo root, and
a keep-a-changelog-style `CHANGELOG.md`. Details below.

## New app checklist

1. **Copy the callers** from `templates/`:
   - `templates/release.yml` → `.github/workflows/release.yml` (fill in
     `app_display_name`, `project_path`, `cargo_package`; for private app
     repos also `releases_repo` + the `RELEASES_TOKEN` secret; for Homebrew,
     `product_name`, `homebrew_tap`, `cask_desc`, `cask_homepage`,
     `bundle_identifier` + the `HOMEBREW_TAP_TOKEN` secret)
   - `templates/tests.yml` → `.github/workflows/tests.yml`
   - `templates/rust-toolchain.toml` → repo root (adjust the channel; KEEP the
     `components` line)
   - version bumping: either `scripts/version-manager.ts` → `tooling/scripts/`
     (adjust the paths + Cargo.lock key; run via `tsx`), or
     [`@entro314labs/release-kit`](https://www.npmjs.com/package/@entro314labs/release-kit)
     with the config in step 6 — it writes the same files, rolls the
     CHANGELOG, tags and pushes in one command
   - the preflight wrapper from [`preflight/README.md`](preflight/README.md)
     → `tooling/preflight/preflight.sh` + a `"preflight"` package.json script
     (runs the matrix's fmt/clippy gates locally before a tag push)

2. **Tauri config requirements** (`src-tauri/tauri.conf.json`):
   - `bundle.createUpdaterArtifacts: true`
   - Per-OS overlay configs exist: `tauri.macos.conf.json`,
     `tauri.windows.conf.json`, `tauri.linux.conf.json` (even if minimal —
     the workflow passes `--config` per platform)
   - `plugins.updater.endpoints` (point at the RELEASES repo when
     `releases_repo` is set — a PRIVATE app repo can never serve updates):
     - stable: `https://github.com/<org>/<releases-repo>/releases/latest/download/latest.json`
     - alpha/beta channels poll `releases/download/latest-<channel>/latest.json`
       (the pipeline maintains those rolling releases automatically)

3. **Generate the updater keypair** (passwordless is fine — and simplest):
   ```bash
   pnpm tauri signer generate -w updater.key --password "" --ci
   ```
   - Public key → `plugins.updater.pubkey` in `tauri.conf.json`
   - Private key → repo secret: `gh secret set TAURI_SIGNING_PRIVATE_KEY < updater.key`
   - Do NOT set `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` for a passwordless key
   - **Back the key up outside the repo** (password manager). Losing it after
     a release permanently breaks auto-update for installed users.

4. **CHANGELOG.md** at the repo root. The pipeline refuses to release a tag
   `vX.Y.Z` without a `## [X.Y.Z]` heading.

5. **Distribution signing (all optional, per-app secrets)** — see
   [docs/SIGNING.md](docs/SIGNING.md) for the full setup of each:
   - **macOS**: `APPLE_CERTIFICATE` (base64 .p12),
     `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, plus notarization
     via either `APPLE_API_ISSUER`/`APPLE_API_KEY`/`APPLE_API_KEY_BASE64`
     (App Store Connect API key, preferred) or
     `APPLE_ID`/`APPLE_PASSWORD`/`APPLE_TEAM_ID` (app-specific password).
   - **Windows**: one of — Azure Artifact Signing (`AZURE_CLIENT_ID` /
     `AZURE_CLIENT_SECRET` / `AZURE_TENANT_ID` + the `windows_azure_*`
     inputs), a `.pfx` (`WINDOWS_CERTIFICATE` +
     `WINDOWS_CERTIFICATE_PASSWORD`), or any issuer CLI via the
     `windows_sign_command` input.
   - **Linux**: `LINUX_GPG_PRIVATE_KEY` (+ `LINUX_GPG_PASSPHRASE`) signs the
     AppImage and the RPM with one key.

   Unset secrets are handled safely — the pipeline only exports non-empty
   ones, and each OS's artifacts are verified after the build so signing that
   silently did nothing cannot reach users.

   **Bundle formats** default to `app,dmg` / `nsis` / `deb,rpm,appimage` and
   are set per OS with the `macos_bundles` / `windows_bundles` /
   `linux_bundles` inputs. See [docs/PACKAGING.md](docs/PACKAGING.md) for what
   each format is for and its configuration surface.

6. **Release ritual**:
   ```bash
   tsx tooling/scripts/version-manager.ts set 0.2.0-alpha.1   # or patch/minor/major
   # add the CHANGELOG heading, commit, push
   git tag -a v0.2.0-alpha.1 -m "MyApp v0.2.0-alpha.1" && git push origin v0.2.0-alpha.1
   ```

   Or the same thing with release-kit, which also writes the CHANGELOG heading this
   pipeline requires:

   ```bash
   release-kit 0.2.0-alpha.1
   ```

   with `release.config.json` at the repo root:

   ```json
   {
     "versionFiles": [
       "apps/desktop/package.json",
       "apps/desktop/src-tauri/tauri.conf.json",
       "apps/desktop/src-tauri/tauri.macos.conf.json",
       "apps/desktop/src-tauri/tauri.windows.conf.json",
       "apps/desktop/src-tauri/tauri.linux.conf.json",
       "apps/desktop/src-tauri/Cargo.toml",
       "apps/desktop/src-tauri/Cargo.lock"
     ],
     "publish": null,
     "steps": ["version", "changelog", "tag", "push"]
   }
   ```

   It stops at `push` on purpose: the tag is what triggers this pipeline, and the pipeline
   owns building, signing and the GitHub release. Do NOT add `release` to `steps` — both
   would try to create it and the second fails. `Cargo.lock` is scoped to the crate named
   in the sibling `Cargo.toml`, so the 500-odd dependency versions in it are left alone.
   What it adds over the script: `## [Unreleased]` is rolled into the version heading the
   changelog guard checks for, the annotated tag carries the release notes, and a
   half-finished run is resumed by re-running it. What it does not do is anything after the
   tag — that is all still this kit.

   Channel is derived from the tag: `-alpha*` → alpha, `-beta*` → beta,
   otherwise stable. Pre-release versions MUST also be set in the version
   files (the `set` command) so the binary's version matches the manifest.

7. **If a leg fails** — resume, don't recycle. The pipeline reuses an
   existing draft release for the tag, so retry via dispatch with only the
   failed legs (assets from successful legs are already on the draft):
   ```bash
   # fix on main, push, then:
   gh workflow run release.yml -f tag=v0.2.0-alpha.1 -f build_targets=windows-aarch64
   ```
   The dispatch run builds from the branch HEAD (which has your fix) while
   the manifest + verification still cover the full platform set. Caveats:
   - The app-repo tag keeps pointing at the pre-fix commit. Usually fine
     (release provenance lives on the releases repo, whose tag is created at
     publish); recycle the tag the old way if you want exact provenance.
   - A release already PUBLISHED for the tag is never reused — the run fails
     loudly; bump the version instead.
   - Retrying a leg that failed AFTER uploading its assets is safe:
     tauri-action deletes same-named assets before re-uploading, and the
     updater manifest is rebuilt and replaced on every attempt.

## Cross-repo tokens

Needed only for the optional cross-repo features (per app, or org-level
shared to selected repos):

- `RELEASES_TOKEN` — fine-grained PAT, **Contents: Read and write** on the
  releases repo only. Required whenever `releases_repo` is set.
- `HOMEBREW_TAP_TOKEN` — fine-grained PAT, **Contents: Read and write** on the
  tap repo only. The cask job skips with a warning when absent.

Use scoped fine-grained PATs, not a broad classic token — and note that
fine-grained PATs EXPIRE (a vanished `RELEASES_TOKEN` has cost a real release
attempt at the publish step, after all legs had built); calendar the renewal.

If you fork this kit into a **private** repo, callers additionally need
workflow access: **Settings → Actions → General → Access → "Accessible from
repositories in the … organization"**.

## Cost notes

macOS runners bill at 10× on private repos and dominate release cost. Four
layers keep failures cheap, in the order they bite:

1. **Gates before builds** — fmt/clippy run before any expensive build so a
   lint failure costs minutes, not builds; the standalone `rust-fmt` job
   settles formatting on one ubuntu runner before the matrix spins at all.
2. **Preflight before tags** — run [`preflight/`](preflight/README.md)
   before every tag push. It runs the same fmt/clippy gates locally: native
   for both mac targets, docker ubuntu:24.04 for both Linux targets, and
   docker cargo-xwin for both Windows MSVC targets — the exact three
   environments whose target-only breaks have recycled real release tags.
3. **Ship only what you sell** — the `targets` input shrinks the matrix,
   manifest, verification, and cask to the platforms the app actually ships.
   Dropping an unused macOS leg saves 10×-billed minutes on every release.
4. **Resume instead of recycling** — what preflight cannot cover (bundling,
   signing/notarization, linking, runner-image drift) fails *after* the
   expensive compile. When a leg fails, re-dispatch with `build_targets` set
   to just that leg (see the release ritual): the run reuses the draft and
   its already-uploaded assets, so a failed leg costs one leg's minutes —
   not a fresh 6-leg matrix with both macOS legs rebuilt.

### Self-hosted runners (consumer test workflows)

Per-push test matrices are a good fit for self-hosted runners; two lessons
from running the kit's consumers that way:

- Select legs by **runner label**, so GitHub-image-specific steps (`apt-get`,
  the `sudo rm -rf` disk-freeing step) stay keyed to `ubuntu-latest` and
  correctly no-op on self-hosted hardware. Key anything meant to run *once*
  to the leg (`matrix.platform.name == 'Linux'`) rather than to
  `ubuntu-latest`, or it silently stops running altogether.
- This kit's own `release.yml` deliberately stays on GitHub-hosted runners
  for all six legs: tag-time releases are rare and want pristine,
  reproducible environments — and the `windows-11-arm` leg has no self-hosted
  equivalent, since Windows-on-ARM cannot be cross-compiled (cargo-xwin leaks
  MSVC `/imsvc` flags into the GNU-clang driver `cc-rs` uses for `ring`).
  Point release builds at self-hosted runners only if you accept a less
  reproducible release environment.

## Docs

- [docs/GOTCHAS.md](docs/GOTCHAS.md) — why the pipeline looks the way it
  does; every entry is a failure that actually happened
- [docs/SIGNING.md](docs/SIGNING.md) — macOS, Windows and Linux distribution
  signing, end to end
- [docs/PACKAGING.md](docs/PACKAGING.md) — every bundle format, what it is
  for, and its configuration surface (WebView2 modes, NSIS hooks, WiX
  fragments, rpm scriptlets, AppImage limits, the glibc rule)
- [docs/APP_STORE.md](docs/APP_STORE.md) — Mac App Store and iOS submission
- [docs/LINUX_STORES.md](docs/LINUX_STORES.md) — Flathub and the AUR
- [docs/UPDATE_SYSTEM.md](docs/UPDATE_SYSTEM.md) — the end-to-end update
  system design (Rust mechanism, flow, UI/UX) the kit's manifests feed
- [preflight/README.md](preflight/README.md) — local release-gate parity
  before you burn paid runners
- [templates/appstore/](templates/appstore/) — App Store config overlay,
  entitlements and Info.plist to copy into `src-tauri/`
- [templates/flatpak/](templates/flatpak/) — AppStream MetaInfo and an
  escape-hatch flatpak manifest

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) — in short: read GOTCHAS.md before
simplifying, and document new failure modes when you work around them.

## License

[MIT](LICENSE)
