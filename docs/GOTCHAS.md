# Gotchas — why the pipeline looks the way it does

Every entry below is a failure that actually happened during the first
releases of the production app this kit was extracted from (six workflow
runs to green on the first release alone). If you change the pipeline,
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

- **A failed release attempt is RESUMED, not recycled** (since 2026-08-18):
  the pipeline reuses an existing draft for the tag, so fix on main and
  re-dispatch with `build_targets=<failed legs>` — successful legs' assets
  stay, only the failed legs' minutes are spent again. Full recycling
  (delete the draft release AND the tag, remote + local, fix, re-tag) is
  only needed when you want the app-repo tag to point at the fixed commit.
  A tag whose release already went PUBLIC is never reused — bump instead.

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

## Private repos cannot serve releases (discovered publishing a first public alpha)

- **Release assets on a private repo 404 for unauthenticated clients** — both
  user downloads AND the tauri updater's manifest polls. A "public alpha from
  a private repo" requires a separate PUBLIC releases repo (e.g.
  `<app>-releases`) hosting binaries + manifests; the updater endpoints in
  tauri.conf.json / the channel code must point there. Cross-repo publishing
  from CI needs a fine-grained PAT (Contents: R/W on the releases repo) — the
  default GITHUB_TOKEN cannot write other repos.
- **`browser_download_url` on a DRAFT release is a trap**: it contains an
  `untagged-<hash>` path that 404s publicly and breaks after publish. Build
  manifest URLs deterministically as `releases/download/<tag>/<asset-name>`.
- **Pre-publish verification must use the API** (draft assets are not
  HTTP-fetchable); do the unauthenticated HEAD smoke test AFTER the draft
  flips public.
- **A brand-new releases repo needs an initial commit** before any release can
  be created ("Repository is empty" — tags need a commit to point at).

## Lessons from the second shipped release — all baked into release.yml

- **`awalsh128/cache-apt-pkgs-action` silently installs NOTHING sometimes**:
  on the ubuntu-24.04-arm leg it logged "Clean installing 12 packages... done"
  while the installed-package list was empty ("Caching 0 installed packages"),
  and the build died at glib-sys/pkg-config ten minutes later. A release must
  fail loudly at the install step. Use plain `apt-get install`; the caching
  saved ~40 seconds per run.
- **linuxdeploy needs FUSE2 AND a working strip**: the 24.04 runner images
  (20260714+) dropped `libfuse2` (install `libfuse2t64`), and linuxdeploy's
  bundled strip pass breaks against the image's binutils even with FUSE
  present ("failed to run linuxdeploy" with no stderr). Set `NO_STRIP=true` —
  cargo's release profile already strips the shipped binary.
- **"failed to run linuxdeploy" can also mean DISK FULL**: a job that builds a
  cargo debug tree (tests) plus a release tree plus node_modules can exhaust
  the ~14 GB free on stock runners; the only clue is a buried "You are running
  out of disk space" warning. Free the preinstalled bloat
  (`sudo rm -rf /usr/share/dotnet /usr/local/lib/android /opt/ghc`) and drop
  `target/debug` before bundling.
- **pnpm 11 forwards a literal `--` into run-scripts**: `pnpm run tauri:build
  -- --config X` now executes `tauri build -- --config X`, and tauri passes
  everything after `--` to CARGO, whose own `--config` parser then fails with
  a baffling "dotted key expression" error. Invoke `pnpm exec tauri build`
  directly.
- **tauri-action v1 renamed `includeUpdaterJson` → `uploadUpdaterJson`**: the
  old name is silently ignored, so tauri-action uploads its own latest.json
  next to the one this pipeline assembles.
- **WiX/MSI rejects non-numeric prerelease identifiers** (`0.2.0-alpha.2`) at
  bundle time and cannot target ARM64 — prerelease Windows builds must pass
  `--bundles nsis` anywhere they build, including smoke gates.
- **Zero-step job failures with BlobNotFound logs = GitHub Actions BILLING**
  (spending limit hit / payment failed), not a workflow bug. The only place
  the real reason appears is the check-run ANNOTATION, not the logs.
- **Reruns use the original workflow snapshot**: fixing the workflow file does
  nothing for `gh run rerun`. Dispatch a fresh run instead (it reuses the
  draft — see the resume bullet above); the new run picks up both workflow
  and code fixes from the branch HEAD.
- **Windows default step shell is pwsh**: multi-line `\` continuations in
  cross-platform `run:` blocks die with "Missing expression after unary
  operator '--'". Set `shell: bash` explicitly.
- **oxfmt ≥0.59 exits non-zero when every matched file is ignore-listed** —
  gates that "format then diff" a deliberately formatter-ignored file now fail
  before the diff runs.
- **Target-only Rust code first compiles at release time** (four tag
  recycles on a real release): `#[cfg(target_os = "…")]` modules are
  invisible to every dev-machine check on another OS, so a feature-gated dep
  (`ashpd` without its `settings` feature) and a moved API
  (`windows::Foundation::IAsyncOperation` → `windows-future`, `.get()` →
  `.join()`) only surfaced in the per-leg clippy gates. Cheap local preflight:
  `rustup target add <triple>` + a scratch crate with just the target-gated
  dep + module compiles the exact CI errors on any host (full `cargo check
  --target` dies on C build scripts like ring). And once the target code
  *compiles*, let a doomed run reach that leg's clippy step — it reports the
  complete lint list in one shot.
- **Doc lints only fire when the cfg'd module actually compiles**:
  `clippy::doc_markdown` errors (`-D warnings` + pedantic) in Windows-only
  files passed silently everywhere until the Windows leg first compiled them.
  Compile errors abort clippy before its lint phase, so a leg can fail twice
  in a row with *different* error classes: first rustc errors, then, once
  those are fixed, lint errors the same run never got to report.
