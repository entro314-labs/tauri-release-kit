# Preflight — run the release gates locally before tagging

Runs the same `cargo fmt --check` / `cargo clippy -D warnings` gates as the
kit's 6-leg release matrix, on your machine and in docker, so target-only
breaks (feature-gated deps, windows-crate API moves, doc lints inside
`#[cfg]`'d modules) fail here instead of on paid GitHub runners.

| Release leg        | Preflight stage  | How                                        |
| ------------------ | ---------------- | ------------------------------------------ |
| macos aarch64/x64  | `mac`            | native clippy, both apple targets          |
| linux x64/arm64    | `linux-*`        | docker ubuntu:24.04, same apt set as CI    |
| windows x64        | `windows-x64`    | docker cargo-xwin (clang-cl + MSVC SDK)    |
| windows arm64      | `windows-arm64`  | opt-in via `--only` — see note below       |
| linux full bundle  | `linux-bundle`   | `--full` only; clean clone of HEAD         |

Not covered (still CI-only): NSIS/MSI bundling, macOS signing/notarization,
Windows linking (clippy stops before link), and anything runner-image
specific — treat a green preflight as "the compile/lint gates will pass",
not "the release will succeed".

`windows-arm64` is excluded from the default set: cargo-xwin currently can't
cross-compile ring for aarch64-msvc either way (clang-cl leaks MSVC-style
`/imsvc` flags into the GNU-clang call cc-rs uses for `.S` assembly; the GNU
driver can't resolve the lowercased xwin SDK's `Windows.h` on a
case-sensitive filesystem). First-party lint coverage is identical to
`windows-x64`; CI's native arm64 leg remains the real gate.

Requirements on Apple Silicon: Docker Desktop with **Rosetta enabled**
(Settings → General → "Use Rosetta for x86/amd64 emulation") — under plain
QEMU, rustc segfaults in the linux-amd64 stage.

## Consuming from an app repo

Add a thin wrapper (e.g. `tooling/preflight/preflight.sh`):

```bash
#!/usr/bin/env bash
set -euo pipefail
KIT="${TAURI_RELEASE_KIT_DIR:-$(dirname "$0")/../../../tauri-release-kit}"
[ -f "$KIT/preflight/preflight.sh" ] || { echo "tauri-release-kit not found — clone it next to this repo or set TAURI_RELEASE_KIT_DIR" >&2; exit 1; }
export PF_PROJECT_PATH=apps/desktop   # path containing src-tauri
export PF_NAME=myapp                  # docker volume/image prefix
exec "$KIT/preflight/preflight.sh" "$@"
```

and a package.json script: `"preflight": "tooling/preflight/preflight.sh"`.

## Usage

```bash
pnpm preflight                 # fmt + mac + all four docker clippy stages
pnpm preflight --fast          # fmt + mac only (no docker)
pnpm preflight --full          # + full Linux AppImage/deb bundle from HEAD
pnpm preflight --only windows-x64,linux-arm64
```

The clippy stages bind-mount the working tree — they test uncommitted
changes. Only `linux-bundle` clones HEAD (pnpm/tauri write into the tree, and
Linux artifacts must never leak into the host checkout). First run downloads
toolchains and the MSVC SDK into named docker volumes (a few GB); later runs
reuse them.

Release flow: run `pnpm preflight` (at minimum `--only
fmt,windows-x64,windows-arm64,linux-arm64,linux-amd64`) before every
`git tag vX.Y.Z` push. Every stage here maps 1:1 to a gate that has recycled
a real release tag.
