# tauri-release-kit

Shared CI/CD + versioning for entro314-labs Tauri apps. One reusable release
pipeline — 6-platform build matrix, minisign-signed auto-updater artifacts,
per-channel rolling update manifests (`stable` / `beta` / `alpha`), changelog
guard, cross-repo publishing to a public releases mirror, pre-publish
verification, optional Homebrew cask publishing, post-release version-bump PR
— plus reusable Rust quality gates and a version sync script.

Extracted from anasa's first releases (v0.2.0-alpha.1 2026-07-14, re-extracted
after v0.2.0-alpha.2 shipped end-to-end 2026-07-16). Every odd-looking step
encodes a failure that actually happened; read [docs/GOTCHAS.md](docs/GOTCHAS.md)
before "simplifying" anything.

## What consumers call

| Workflow | Purpose |
| --- | --- |
| `.github/workflows/release.yml` | Tag-triggered release: build → sign → manifest → verify → publish |
| `.github/workflows/rust-checks.yml` | fmt + clippy (+ tests) on ubuntu/macos/windows for branch pushes |

Both are `workflow_call` reusable workflows — fixes land here once and every
app picks them up. Pin `@main` for latest or a tag for stability.

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
   - `scripts/version-manager.ts` → `tooling/scripts/` (or anywhere; run via `tsx`)

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

5. **macOS signing (optional, per-app secrets)**: `APPLE_CERTIFICATE` (base64
   .p12), `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, plus
   notarization via either `APPLE_API_ISSUER`/`APPLE_API_KEY`/`APPLE_API_KEY_BASE64`
   (App Store Connect API key, preferred) or `APPLE_ID`/`APPLE_PASSWORD`/
   `APPLE_TEAM_ID` (app-specific password fallback). See [docs/SIGNING.md](docs/SIGNING.md).
   Unset secrets are handled safely — the pipeline only exports non-empty ones.

6. **Release ritual**:
   ```bash
   tsx tooling/scripts/version-manager.ts set 0.2.0-alpha.1   # or patch/minor/major
   # add the CHANGELOG heading, commit, push
   git tag -a v0.2.0-alpha.1 -m "MyApp v0.2.0-alpha.1" && git push origin v0.2.0-alpha.1
   ```
   Channel is derived from the tag: `-alpha*` → alpha, `-beta*` → beta,
   otherwise stable. Pre-release versions MUST also be set in the version
   files (the `set` command) so the binary's version matches the manifest.

## One-time org setup

This repo is private, so callers need access: **Settings → Actions → General →
Access → "Accessible from repositories in the entro314-labs organization"**.

Cross-repo secrets (per app, or org-level shared to selected repos):

- `RELEASES_TOKEN` — fine-grained PAT, **Contents: Read and write** on the
  releases repo only. Required whenever `releases_repo` is set.
- `HOMEBREW_TAP_TOKEN` — fine-grained PAT, **Contents: Read and write** on the
  tap repo only. The cask job skips with a warning when absent.

Use scoped fine-grained PATs, not a broad classic token — and note that
fine-grained PATs EXPIRE (a vanished `RELEASES_TOKEN` cost anasa a release
attempt); calendar the renewal.

## Cost notes

macOS runners bill at 10× on private repos and dominate release cost. The
gates (fmt/clippy) run before any expensive build so a lint failure costs
minutes, not builds. Verify Linux gates locally before tagging — see the
Docker recipe in [docs/GOTCHAS.md](docs/GOTCHAS.md) — because each failed
release attempt costs a tag-recycle and CI minutes.
