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
| `.github/workflows/rust-checks.yml` | fmt + clippy (+ tests) on ubuntu/macos/windows for branch pushes, plus a blocking `cargo audit` |
| `.github/workflows/commit-lint.yml` | Checks pull request titles are Conventional Commits, so the changelog stays complete |
| `.github/workflows/flatpak.yml` | Repacks the released `.deb` into a Flatpak bundle + Flathub manifest |
| `.github/workflows/aur.yml` | Renders, validates and publishes a `-bin` PKGBUILD to the AUR |
| `.github/workflows/app-store.yml` | Builds and uploads a Mac App Store `.pkg` / iOS `.ipa` |
| `.github/workflows/credentials.yml` | Credential preflight: proves the signing/publishing secrets still work, without building |

All seven are `workflow_call` reusable workflows — fixes land here once and
every app picks them up. Pin `@main` for latest or a tag for stability. The
last three chain off `release.yml` with `needs:` in one caller file; see
[`templates/release.yml`](templates/release.yml).

### Distribution channels

| Channel | Built from | Wired by |
| --- | --- | --- |
| Direct download (dmg / setup.exe / AppImage / deb / rpm) | source | `release.yml` |
| Auto-updater (per channel) | the above | `release.yml` |
| Homebrew cask | the released `.dmg` | `release.yml` (`homebrew_tap`) |
| winget (stable only) | the released MSI / NSIS installer | `release.yml` (`winget_identifier`) |
| Scoop bucket (stable only) | the released NSIS installer | `release.yml` (`scoop_bucket`) |
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
     repos also `releases_repo` + a GitHub App (`app_client_id` +
     `APP_PRIVATE_KEY`) or the `RELEASES_TOKEN` secret; for Homebrew,
     `product_name`, `homebrew_tap`, `cask_desc`, `cask_homepage`,
     `bundle_identifier` — see "Cross-repo credentials")
   - `templates/tests.yml` → `.github/workflows/tests.yml` (calls the Rust
     gates and the commit gate; set `lint_branch_commits: true` if you merge
     without squashing). The Rust gates include a blocking `cargo audit` of
     the workspace's `Cargo.lock` that fails on any RustSec vulnerability:
     `cargo_audit: false` turns it off, and `audit_ignore` takes a
     comma-separated list of advisory IDs you have accepted
     (`'RUSTSEC-2024-0370,RUSTSEC-2025-0012'` — write down why next to it).
     An unrecognised ID fails the job rather than ignoring nothing.
   - `templates/guard-latest-release.yml` → `.github/workflows/` of the repo
     that SERVES the stable updater endpoint — the releases mirror when
     `releases_repo` is set, else the app repo (see "Guarding the stable
     update channel")
   - `templates/credentials.yml` → `.github/workflows/credentials.yml`
     (dispatch it before a release to prove the secrets still work — see
     "Credential preflight")
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
   npx --yes @tauri-apps/cli@2.11.5 signer generate -w updater.key --password "" --ci
   ```
   - Generate with a pinned, known-good CLI as above, not whatever version
     the app has: `signer generate` in @tauri-apps/cli **2.9.4 – 2.10.0**
     writes a passwordless key that NO tauri version can decrypt with an empty
     password ("incorrect updater private key password: Wrong password for
     that key", [tauri#14829](https://github.com/tauri-apps/tauri/issues/14829),
     fixed in 2.10.1). A key made that way cannot be repaired — generate a new
     one (and ship the new pubkey before the old key is retired). Keys from
     2.10.1+ or ≤ 2.9.3 work with every 2.x CLI; checked with 2.5.0-, 2.9.6-
     and 2.11.5-generated keys signed by 2.9.6 and 2.11.5.
   - Public key → `plugins.updater.pubkey` in `tauri.conf.json`
   - Private key → repo secret: `gh secret set TAURI_SIGNING_PRIVATE_KEY < updater.key`
   - Do NOT set `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` for a passwordless key.
     (Unset and empty behave the same in the build: under `CI` the tauri CLI
     treats a missing password as empty.)
   - Or give the key a password (`--password '<pw>'`) and set
     `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` to it — that works on every CLI
     version, including 2.9.4 – 2.10.0.
   - Dispatch the credential preflight (`templates/credentials.yml`) once the
     secret is set: it signs with the key and checks it against the pubkey.
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
     AppImage and the RPM with one key; `LINUX_GPG_KEY_ID` picks the key when
     the keyring holds more than one.
   - **Build-time extras (optional)**: `SENTRY_DSN` is exported to the build as
     `SENTRY_DSN` and `VITE_SENTRY_DSN`, and `SENTRY_AUTH_TOKEN` for sourcemap
     upload tooling — both only when non-empty. Neither is read by the kit
     itself; they exist for the app's own build to pick up.

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
       "apps/desktop/src-tauri/tauri.*conf.json",
       "apps/desktop/src-tauri/Cargo.toml",
       "apps/desktop/src-tauri/Cargo.lock"
     ],
     "publish": null,
     "steps": ["commit", "version", "changelog", "tag", "push"]
   }
   ```

   It stops at `push` on purpose: the tag is what triggers this pipeline, and the pipeline
   owns building, signing and the GitHub release. Do NOT add `release` to `steps` — both
   would try to create it and the second fails. `Cargo.lock` is scoped to the crate named
   in the sibling `Cargo.toml`, so the 500-odd dependency versions in it are left alone.
   The glob covers `tauri.conf.json` and every per-OS overlay beside it; an overlay that
   carries no `version` of its own is skipped. Do not list the overlays by name — a file
   named on purpose that has no version to write fails release-kit's preflight.
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

## winget and Scoop

Both run after publish, for **stable** releases only, and skip with a warning
when their credential is missing.

**winget** (`winget_identifier: 'MyOrg.MyApp'` + the `WINGET_TOKEN` secret):
[winget-releaser](https://github.com/vedantmgoyal9/winget-releaser) (komac)
opens the version PR on microsoft/winget-pkgs from a fork.

- One-time: the package must already exist in winget-pkgs — submit the first
  version by hand (`wingetcreate new <installer URL>` or `komac new`) and wait
  for that PR to merge. Until then the job fails.
- `WINGET_TOKEN` is a classic PAT with `public_repo` from the account that
  owns a fork of microsoft/winget-pkgs; that account defaults to the app
  repo's owner, `winget_fork_user` overrides it. The job checks it can push to
  the fork before calling the action.
- Installers: the x64 MSI when `windows_bundles` includes `msi` (komac reads
  MSIs from their tables; its emulation of tauri's NSIS script has aborted in
  the WebView2 bootstrapper branch for another tauri app), otherwise the x64
  `-setup.exe`; arm64 always ships its `-setup.exe`. Ship one WiX language, or
  every language's MSI is submitted.
- The releases repo must belong to the same owner as the app repo (the action
  looks the release up under the app repo's owner); otherwise the job skips
  with a warning.
- The action installs `cargo-binstall` from its `main` branch and the latest
  komac at run time — neither is pinned by it.

**Scoop** (`scoop_bucket: 'my-org/scoop-bucket'` + `product_name` + the
`SCOOP_TAP_TOKEN` secret or the GitHub App): updates
`bucket/<product_name lowercased>.json` in the bucket — `version`, and
`architecture.64bit` / `arm64` `url` + `hash` from the published NSIS
installers (GitHub's sha256 digest). Create the manifest once by hand; how the
app installs is yours to define, the job only moves it forward. A URL
fragment you add (e.g. `#/dl.7z`) is kept. One possible starting point (the
executable is your main binary's name, usually the Cargo package name):

```json
{
  "version": "0.0.0",
  "description": "My App",
  "homepage": "https://example.com",
  "license": "MIT",
  "architecture": { "64bit": { "url": "", "hash": "" } },
  "installer": { "args": ["/S", "/D=$dir"] },
  "uninstaller": { "file": "uninstall.exe", "args": ["/S"] },
  "bin": "myapp.exe",
  "shortcuts": [["myapp.exe", "My App"]]
}
```

The secret names match go-release-kit (`WINGET_TOKEN`, `SCOOP_TAP_TOKEN`).

## Guarding the stable update channel

Stable clients poll `releases/latest/download/latest.json`, and GitHub gives
the `latest` slot to whatever was published or edited last unless told
otherwise. Any other release on the serving repo — a CLI with its own tags, a
re-published old version, a manual "Set as latest" click — silently takes
over the stable channel, after `verify-release` has run.
`templates/guard-latest-release.yml` re-points `latest` at the highest
`vX.Y.Z` release that is neither draft nor prerelease (`TAG_PREFIX` in the
file when the app's tags use another prefix). Install it on the repo that
serves the endpoint: the releases mirror when `releases_repo` is set,
otherwise the app repo. It runs on `release: published/edited`, on dispatch,
and daily — the daily run is what catches same-repo releases, because
releases published with `GITHUB_TOKEN` trigger no workflows. alpha/beta need
no guard: they poll the fixed `latest-<channel>` releases.

## Credential preflight

`templates/credentials.yml` → `.github/workflows/credentials.yml` gives you a
dispatch-only workflow (optionally scheduled) that checks the credentials,
not the code, in a few minutes:

| Credential | Check |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` (+ password) | signs a scratch file with the tauri CLI exactly as the build decrypts it (names the 2.9.4–2.10.0 passwordless-key bug when that is the cause), and the signature's key id must equal `plugins.updater.pubkey`'s |
| `APPLE_CERTIFICATE` / `_PASSWORD` / `APPLE_SIGNING_IDENTITY` | imported into a throwaway keychain; the identity must be listed by `security find-identity -v -p codesigning` |
| notarization (API key or Apple ID) | one authenticated `xcrun notarytool history` call |
| `WINDOWS_CERTIFICATE` / `_PASSWORD` (/ `_THUMBPRINT`) | `Import-PfxCertificate` must land a certificate with its private key, matching the pinned thumbprint, not expired (warning inside 30 days) |
| `AZURE_*` + `windows_azure_*` | a client-credentials token request for the service principal (the signing role itself is not checked) |
| `LINUX_GPG_PRIVATE_KEY` (+ passphrase, key id) | imported into a scratch keyring and used to sign |
| GitHub App (`app_client_id` + `APP_PRIVATE_KEY`) | a token is minted for the releases repo and the tap, as release.yml does — that fails unless the App is installed there with Contents: write |
| `RELEASES_TOKEN`, `HOMEBREW_TAP_TOKEN`, `SCOOP_TAP_TOKEN` (when no App) | `gh api repos/<repo> --jq .permissions.push` must be `true` |
| `WINGET_TOKEN` | can push to `<winget_fork_user>/winget-pkgs`; warns while the package is not in winget-pkgs yet |

An optional credential that is not configured is a notice; one that is set but
broken, or half-configured, fails — every check runs, so one run lists all
problems. The macOS and Windows jobs start only when their secrets exist.
Pass the same `project_path`, `releases_repo`, `homebrew_tap`,
`winget_identifier`, `winget_fork_user`, `scoop_bucket`, `windows_azure_*`,
`app_client_id` and `environment` values as your release
caller.

## Cross-repo credentials

Needed only for the optional cross-repo features: writing releases to
`releases_repo`, and pushing the cask to `homebrew_tap`. Two ways to provide
them; the GitHub App is the recommended default.

### GitHub App (recommended)

1. Create a GitHub App (org or user settings → Developer settings → GitHub
   Apps) with **Repository permissions → Contents: Read and write** and
   nothing else; no webhook.
2. Install it on the releases repo and the tap repo (only those).
3. In the app repo: `app_client_id: '<the App's Client ID>'` in the caller
   (it is not secret), and the App's private key (`.pem` contents) as the
   `APP_PRIVATE_KEY` secret. Pass `app_client_id` to `flatpak.yml` /
   `aur.yml` / `credentials.yml` too.

Every job that writes cross-repo then mints its own installation token with
`actions/create-github-app-token`, scoped to exactly the one repo it writes
(`owner` + `repositories`) with `contents: write` — tokens cannot be handed
between jobs, so each job mints. With `app_client_id` set the App is used for
every cross-repo target, so it must be installed on all of them;
`check-changelog` mints once up front, so a missing installation fails in
seconds. Cask commits are authored as the App's bot account.

Why it is the default: an App's key does not expire on a calendar, while a
fine-grained PAT does (a vanished `RELEASES_TOKEN` has cost a real release at
the publish step, after all legs had built), and its tokens are narrower —
one repo, one permission, one hour. Two things to know:

- **One-hour tokens.** tauri-action uploads each leg's assets when that leg's
  build finishes, with a token minted right before the build. A leg whose
  build takes longer than about 50 minutes (typically a slow self-hosted
  cross-build) would upload with an expired token; such an app should stay on
  `RELEASES_TOKEN`.
- **Releases written by the App trigger workflows** (`on: release`) in the
  releases repo, unlike `GITHUB_TOKEN`; same-repo mode still uses
  `GITHUB_TOKEN` (see docs/GOTCHAS.md).

### Fine-grained PATs (fallback)

- `RELEASES_TOKEN` — **Contents: Read and write** on the releases repo only.
  Required whenever `releases_repo` is set and `app_client_id` is not.
- `HOMEBREW_TAP_TOKEN` — **Contents: Read and write** on the tap repo only. The
  cask job skips with a warning when neither it nor the App is configured.

Use scoped fine-grained PATs, not a broad classic token, and calendar their
expiry — `credentials.yml` checks they can still push.

### Scoping secrets to an environment

`release.yml` takes an optional `environment` input. When set, every job that
reads a signing or publishing secret (`check-changelog`, `create-release`,
`build-and-release`, `create-updater-json`, `checksums`, `attest`,
`verify-release`, `publish-release`, `publish-homebrew-cask`,
`publish-winget`, `publish-scoop`) runs in that
GitHub environment,
so `TAURI_SIGNING_PRIVATE_KEY`, the Apple/Windows/Linux signing secrets,
`APP_PRIVATE_KEY`, `RELEASES_TOKEN`, `HOMEBREW_TAP_TOKEN`, `WINGET_TOKEN` and
`SCOOP_TAP_TOKEN` can be moved out of repo-level
secrets and behind the environment's protection rules. Things to know:

- The environment is resolved in the **calling** (app) repo, like everything
  else in a reusable workflow — create it there, not in this kit.
- GitHub documents that a job with `environment:` in a reusable workflow gets
  the environment's secret, not the one the caller passed; that is the
  mechanism this relies on.
- Protection rules apply per job: GitHub's docs say they must pass "before a
  job referencing the environment is sent to a runner". Expect a
  required-reviewer rule to hold the pipeline at each of those jobs
  rather than once per release (unverified here — no live run). Deployment
  branch/tag rules must admit the release tags (`v*`) and the branch you
  dispatch retries from.
- Each environment-bearing job records a deployment on the app repo.
- `TAURI_SIGNING_PRIVATE_KEY` is declared `required: true` by `release.yml`.
  Whether GitHub's required-secret check at call time accepts it when it
  exists only as an environment secret is unverified, so keep a repo-level
  copy of that one until a live run shows it is not needed.
- Empty (the default) means no environment, as before. GitHub does not
  document the empty-name case; GitHub Desktop's CI runs the same
  `environment: ${{ inputs.environment }}` pattern with an empty input on
  every pull request, with no deployment created, which is the evidence for
  it.

If you fork this kit into a **private** repo, callers additionally need
workflow access: **Settings → Actions → General → Access → "Accessible from
repositories in the … organization"**. That setting covers the workflow files
only. `release.yml` also checks out the kit's own `scripts/` at the commit you
pinned (`job.workflow_repository` @ `job.workflow_sha`) with the caller's
`GITHUB_TOKEN`, which cannot read another private repository — so a private
fork's verify step fails at that checkout. Keep the kit repo public.

## macOS linkage check

Every darwin leg runs `otool -L` over the built `.app`'s main binary,
sidecars and bundled dylibs/frameworks, and fails when one loads a library
from `/opt/homebrew/` or `/usr/local/{opt,Cellar,lib}/`. Such a path exists
on the build runner — so the leg builds, notarizes and even launches — and
the app crashes at launch ("dyld: Library not loaded") on every machine
without that Homebrew formula. Fix it by vendoring/static-linking the
dependency (e.g. the `vendored` feature of `openssl-sys`), or by bundling the
dylib and linking it via `@rpath`. `macos_linkage_check: false` turns it off;
the only legitimate reason is an app that is distributed exclusively in a way
that guarantees the formula is installed (a Homebrew cask with
`depends_on formula:`).

## Package smoke tests (opt-in)

`smoke_test: true` installs and launches what each leg built, on every leg
whose runner can execute it:

| OS | Check |
| --- | --- |
| Linux | `dpkg-deb -f <deb> Version` equals the release version; the AppImage is extracted and started under Xvfb and must still be running after 15 s, with no panic or dynamic-linker error in its output |
| Windows | each MSI's `ProductVersion` (read, not installed) equals the version; the NSIS installer runs silently into a scratch directory and the installed app must still be running after 10 s (install dir, app output and Application event-log errors are printed on failure) |
| macOS | `hdiutil verify` on the dmg; the `.app`'s main executable must still be running after 10 s |

A leg whose runner has a different CPU architecture than its target — the
`darwin-x86_64` leg pointed at an Apple Silicon `macos_intel_runner` — is
skipped with a notice. It is off by default because an app that exits
without a display, needs first-run setup, or single-instances itself fails
it for reasons that are not bugs; turn it on once your app starts cleanly on
a bare runner. The logic lives in [`scripts/smoke-*`](scripts/).

## Checksums, SBOM and build provenance

> **Existing callers must add two permissions.** The `attest` job needs
> `id-token: write` and `attestations: write`, and a reusable workflow can
> never exceed its caller's grant: without them GitHub rejects the whole
> release run at start-up ("The nested job 'attest' is requesting
> 'id-token: write', but is only allowed 'id-token: none'"), before any job
> runs. Add both to the `release` job's `permissions:` in your caller, as
> `templates/release.yml` now does.

After the last leg uploads and before verification, the `checksums` job
downloads every asset on the draft and publishes, alongside them:

- `SHA256SUMS` — `sha256sum` output over every asset (installers, updater
  archives, `.sig` files, the update manifest, the SBOMs);
- `SHA256SUMS.asc` and `<KEY_ID>.asc` (the public key) — only when
  `LINUX_GPG_PRIVATE_KEY` is set, signed with that same key;
- `<productName>_<version>.spdx.json` and `.cdx.json` — a Syft SBOM of the
  tagged source (every lockfile Syft recognises).

Names and format match linux-release-kit. The `attest` job then records
GitHub build provenance for every file in `SHA256SUMS`. It is stored on the
**app** repository even when releases live on `releases_repo`, and is only
available for public repositories unless the org is on GitHub Enterprise
Cloud — on a private Free/Pro/Team repo it fails with a warning and the
release continues. How to verify each of these: [docs/SIGNING.md
§ 5](docs/SIGNING.md#5-checksums-sbom-and-build-provenance). The `.flatpak`
bundle `flatpak.yml` attaches after publish is not in `SHA256SUMS`.

## What verify-release proves

Before the draft is published, `verify-release` runs
[`scripts/verify-release.mjs`](scripts/verify-release.mjs) (unit-tested with
`node --test`) against the draft through the API and fails the release, listing
every problem at once, unless:

- the release is still a draft, marked prerelease exactly when the channel is
  alpha/beta;
- the asset names are exactly what `targets` × `macos_bundles` /
  `windows_bundles` / `linux_bundles` produce — a missing format *and* an
  unexpected file both fail. Names are computed from `tauri.conf.json` and the
  per-OS overlay (productName, rpm release, WiX languages), the way
  tauri-action names its uploads. `.deb.sig`/`.rpm.sig` are allowed but not
  required (older tauri CLIs do not write them);
- every asset is non-empty and GitHub has computed its sha256 digest, and
  that digest equals the asset's line in `SHA256SUMS`;
- the update manifest has the tag's version, exactly the shipped platforms
  (plus `linux-<arch>-deb` / `linux-<arch>-rpm` for every package whose
  `.deb.sig`/`.rpm.sig` is on the release, so .deb and .rpm installs can
  self-update), URLs under `https://github.com/<releases repo>/releases/download/<tag>/`
  pointing at each platform's updater artifact, and signatures byte-identical
  to the uploaded `.sig` files, made by the key in `plugins.updater.pubkey`
  (the tauri CLI only warns when the signing key does not match it).

The job's summary page shows a pass/fail table either way. `publish-release`
re-reads the release immediately before flipping it and refuses if it is no
longer a draft, then summarises the publish and the anonymous URL checks.

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

Those layers make failures cheap; when the *successful* runs still cost too
much, the macOS legs — the whole 10× multiplier — can move to your own
hardware. See "Self-hosted macOS legs" below.

### Self-hosted macOS legs

Since the macOS legs are the entire 10× multiplier, every workflow with a
mac leg accepts a runner override so those minutes can move to your own
Apple Silicon machine while the pipeline itself stays on GitHub Actions:

| Workflow | Input | Covers |
| --- | --- | --- |
| `release.yml` | `macos_arm_runner` / `macos_intel_runner` | the two darwin build legs |
| `rust-checks.yml` | `macos_runner` | the per-push macOS gate |
| `app-store.yml` | `macos_runner` / `ios_runner` | App Store builds |

Each input takes a **single self-hosted runner label** (e.g. `macbook`) and
defaults to the GitHub-hosted image. Linux and Windows legs stay hosted —
their minutes are cheap and `windows-11-arm` has no self-hosted equivalent
anyway (Windows-on-ARM cannot be cross-compiled: cargo-xwin leaks MSVC
`/imsvc` flags into the GNU-clang driver `cc-rs` uses for `ring`).

Rules learned running the kit's consumers this way:

- **Private repos only.** `rust-checks.yml` runs on `pull_request`; a
  self-hosted runner on a public repo executes fork-PR code on your machine.
  Public repos keep every leg on hosted runners.
- **Signing without shipping secrets to the laptop**: install the Developer
  ID certificate in the runner mac's login keychain once and set only
  `APPLE_SIGNING_IDENTITY` (plus the notarization API key) — the workflow
  only exports non-empty Apple secrets, so leaving `APPLE_CERTIFICATE`
  unset skips the import path entirely, exactly like the Windows
  `WINDOWS_CERTIFICATE_THUMBPRINT` mode. For a headless runner the signing
  key must be usable without a UI prompt, or codesign hangs until the 6h
  job timeout: `security set-key-partition-list -S
  apple-tool:,apple:,codesign: -k <login-pw> login.keychain-db`, and keep
  the keychain unlocked.
- **Both darwin legs can name the same arm64 machine** — the intel leg
  already builds `--target x86_64-apple-darwin` and preflight compiles that
  target natively on arm64 macs. The full bundle+notarize path is less
  proven cross-arch, so smoke-test with a cheap
  `build_targets: darwin-x86_64` dispatch before a real tag.
- **An offline runner queues, it doesn't fail** — a tag pushed while the mac
  is asleep leaves the darwin legs pending (GitHub fails them after 24h).
  The `build_targets` retry lever recovers exactly as for any failed leg:
  wake the machine, re-dispatch the same tag with just the darwin legs.
- **Accept the reproducibility trade-off**: a hosted image is pristine on
  every run; your mac is not. Toolchain drift on the runner machine becomes
  release-environment drift.
- **Prepare the machine's toolchain for CROSS builds** (lessons that each
  cost a failed leg): keep version-manager shims (mise/asdf) OUT of the
  runner's `.path` — they refuse to resolve in the runner's untrusted work
  dirs and the Rust setup action then flip-flops; `rustup target add
  x86_64-apple-darwin` for the pinned toolchain (hosted intel images never
  needed it; the cross leg does — `can't find crate for core` otherwise);
  vendor native deps that would need a target-arch system library (e.g.
  `openssl-sys` `vendored`, scoped under
  `[target.x86_64-apple-darwin.dependencies]`); and cap parallelism with
  `CARGO_BUILD_JOBS` in the runner's `.env` — a vendored-OpenSSL `make -j`
  on top of cargo's full parallelism can exhaust process limits on a
  machine that is also a desktop (`cc`/`ar` spawn failures, EAGAIN).
  `.path`/`.env` edits apply on service restart, never mid-job.
- In your own workflows, select legs by **runner label**, so
  GitHub-image-specific steps (`apt-get`, the `sudo rm -rf` disk-freeing
  step) stay keyed to `ubuntu-latest` and correctly no-op on self-hosted
  hardware. Key anything meant to run *once* to the leg
  (`matrix.platform.name == 'Linux'`) rather than to `ubuntu-latest`, or it
  silently stops running altogether.

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
