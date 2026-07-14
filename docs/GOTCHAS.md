# Gotchas — why the pipeline looks the way it does

Every entry below is a failure that actually happened during anasa's first
release (2026-07-14, six workflow runs to green). If you change the pipeline,
re-read this first.

## Toolchain & gates

- **`rust-toolchain.toml` must declare `components = ["rustfmt", "clippy"]`.**
  `dtolnay/rust-toolchain` sets the rustup profile to *minimal*; when cargo
  hits the repo's pinned toolchain it auto-installs it with that profile — no
  rustfmt, no clippy — and the gate steps fail on every platform. Adding
  `components:` to the ACTION only fixes the stable toolchain it installs,
  not the pinned one cargo actually uses.

- **A Mac cannot pre-verify Linux/Windows gates.** Four classes of diagnostics
  only appear off-macOS: (1) Apple-only crates compiled for non-Apple targets,
  (2) `build.rs` unused-imports when the *host* isn't macOS (build scripts
  compile for the host), (3) `dead_code` on items only consumed by
  `#[cfg(target_os = "macos")]` code, (4) doc/style lints inside
  `#[cfg(target_os = "linux")]` modules. Run the rust-checks workflow on
  branches, or use the local Docker probe below, BEFORE tagging.

- **Local Linux-gate probe (free, ~15 min cold / ~2 min warm):**
  ```bash
  docker run --rm -v "$PWD":/work:ro -v kit-ctarget:/ctarget -v kit-cargo:/root/.cargo \
    ubuntu:24.04 bash -c '
      set -euo pipefail
      apt-get update -qq
      DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl build-essential pkg-config rsync \
        libwebkit2gtk-4.1-dev libjavascriptcoregtk-4.1-dev libsoup-3.0-dev libgtk-3-dev \
        libayatana-appindicator3-dev librsvg2-dev libssl-dev >/dev/null
      curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain 1.96.1 --component clippy --profile minimal >/dev/null 2>&1
      . "$HOME/.cargo/env"
      rsync -a --exclude node_modules --exclude target --exclude .git /work/ /src/
      cd /src/apps/desktop/src-tauri     # adjust project path
      export CARGO_TARGET_DIR=/ctarget
      rm -rf /ctarget/debug/build/<pkg>-* /ctarget/debug/.fingerprint/<pkg>-*
      cargo clippy -- -D warnings'
  ```
  Probe gotchas baked into that recipe:
  - `libssl-dev`: GitHub runner images preinstall it; a bare ubuntu image doesn't.
  - COPY the tree in-container (`rsync`): tauri-build writes schema files into
    the source dir, so a `:ro` mount fails with "Read-only file system (os error 30)".
  - Purge the app's fingerprints when reusing the target volume: cargo can
    replay a stale build-script result recorded against a different source path.
  - Docker Desktop (macOS) can serve STALE content for a mounted script file
    you rewrite between runs — pass scripts inline (`bash -c "$(cat ...)"`).

## Platform packaging

- **Windows is NSIS-only in CI.** WiX/MSI hard-errors on non-numeric semver
  pre-release identifiers (`0.2.0-alpha.1`), and WiX can't target ARM64 at
  all. The updater manifest matchers consume `*_x64-setup.exe` /
  `*_arm64-setup.exe` (+ `.sig`). If you re-enable MSI for stable releases,
  update the matchers too — a manifest with a null platform fails
  verify-release on purpose.

- **Apple-only crates must live in `[target.'cfg(target_os = "macos")'.dependencies]`.**
  `objc2` emits a hard `compile_error!` on non-Apple targets, so having it in
  plain `[dependencies]` breaks Linux/Windows at the dependency graph, before
  your code even compiles. Check this the FIRST time you add any
  objc2/AppKit/LocalAuthentication crate.

- **Never pass unset Apple secrets as env to tauri-action.** GitHub exports
  unset secrets as EMPTY STRINGS; tauri-bundler's `var_os("APPLE_CERTIFICATE")`
  matches `Some("")` and runs `security import` with an empty certificate,
  failing the whole bundle step. The pipeline's "Export Apple signing env
  (non-empty only)" step exists precisely for this. (Conversely, an empty-set
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` is CORRECT for passwordless keys.)

## Release mechanics

- **Channel = tag substring** (`-alpha` / `-beta` / else stable). The
  alpha/beta updater endpoints poll a rolling release (`latest-<channel>`)
  whose `latest.json` is replaced on every publish — the mirror step runs
  AFTER the draft flips public so the manifest never points at 404 draft URLs.

- **Pre-release versions must be baked into the version files too** (not just
  the tag) or the installed binary reports a different version than the
  manifest and the updater comparison misbehaves. Use `version-manager.ts set`.

- **Recycling a failed release attempt** = delete the draft release AND the
  tag (remote + local), fix, re-tag. The changelog guard makes a stale-tag
  redispatch fail fast.

- **GitHub billing kills runs with a misleading annotation** ("job was not
  started ... spending limit") on the first job. macOS runners bill 10× on
  private repos; six release attempts ≈ $15. Keep gate failures cheap by
  probing locally first.

## Meta

- `git tag` may require `-m` (config-dependent: annotated/signed tags).
- zsh reserves `status` as a read-only variable — don't name shell variables
  `status` in monitor/CI scripts.
- Change-detection filters in test workflows can classify `build.rs` or
  workflow edits as "not code" and skip the Rust gates — know your filters
  before trusting a green run as a release probe.
