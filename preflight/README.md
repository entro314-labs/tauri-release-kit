# Preflight — run the release gates locally before tagging

Runs the same `cargo fmt --check` / `cargo clippy -D warnings` gates as the
kit's 6-leg release matrix, on your machine and in docker, so target-only
breaks (feature-gated deps, windows-crate API moves, doc lints inside
`#[cfg]`'d modules) fail here instead of on paid GitHub runners.

| Release leg        | Preflight stage  | How                                        |
| ------------------ | ---------------- | ------------------------------------------ |
| macos aarch64/x64  | `mac`            | native clippy, both apple targets          |
| linux arm64        | `linux-arm64`    | docker ubuntu:24.04, same apt set as CI    |
| linux x64          | `linux-amd64`    | opt-in via `--only` — see note below       |
| windows x64        | `windows-x64`    | docker cargo-xwin (clang-cl + MSVC SDK)    |
| windows arm64      | `windows-arm64`  | opt-in via `--only` — see note below       |
| linux full bundle  | `linux-bundle`   | `--full` only; clean clone of HEAD; deb/rpm/AppImage (`PF_LINUX_BUNDLES`) |

The default set (fmt + mac + linux-arm64 + windows-x64) compiles every
first-party `#[cfg]` path — a doc lint or feature-gate break in your own code
cannot hide from it. The opt-in second-arch twins only add coverage of
arch-specific code in third-party crates, which CI's native legs still gate:

- `linux-amd64` needs working Rosetta-in-Docker on Apple Silicon; under the
  qemu fallback rustc segfaults (observed on macOS 27 beta + Docker 29 even
  with VZ + Rosetta enabled in Docker settings). Fine on x86 hosts.
- `windows-arm64` is blocked upstream in cargo-xwin: clang-cl leaks
  MSVC-style `/imsvc` flags into the GNU-clang call cc-rs uses for ring's
  `.S` assembly, and the GNU driver can't resolve the lowercased xwin SDK's
  `Windows.h` on a case-sensitive filesystem.

Not covered (still CI-only): NSIS/MSI bundling, code signing on any platform
(macOS notarization, Windows Authenticode, Linux GPG), Windows linking (clippy
stops before link), the App Store / Flatpak / AUR channels, and anything
runner-image specific — treat a green preflight as "the compile/lint gates
will pass", not "the release will succeed".

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
