#!/usr/bin/env bash
#
# tauri-release-kit preflight: run the release matrix's fmt/clippy gates
# locally — on this machine and in docker — before burning paid GitHub
# runners. Born from anasa v0.2.0-alpha.3, which took five tag recycles for
# breaks that only surface on the Linux/Windows legs (feature-gated deps,
# moved windows-crate APIs, doc lints inside cfg'd-out modules).
#
# Coverage vs the kit's 6-leg release matrix:
#   mac aarch64/x86_64 — native cargo clippy, both apple targets (darwin hosts)
#   linux x64/arm64    — docker ubuntu:24.04 with the SAME apt set as the CI
#                        legs, cargo clippy per target
#   windows x64/arm64  — docker cargo-xwin (clang-cl + downloaded MSVC SDK),
#                        cargo clippy per target. Compile+lint parity with the
#                        CI gate; NSIS bundling stays CI-only.
#   --full adds a complete Linux bundle build (AppImage/deb) from a clean
#   clone of HEAD — the only stage that requires changes to be COMMITTED.
#
# Clippy stages bind-mount the working tree, so they test UNCOMMITTED changes;
# the only in-tree writes are tauri-build's gitignored gen/schemas.
#
# Consumers call this from a thin wrapper that sets:
#   PF_REPO          repo root (default: git toplevel of $PWD)
#   PF_PROJECT_PATH  path containing src-tauri, e.g. apps/desktop (default: .)
#   PF_NAME          prefix for docker volumes/images (default: repo dirname)
#
# Usage: preflight.sh [--fast|--full] [--only stage1,stage2]
#   stages: fmt mac linux-arm64 linux-amd64 windows-x64 windows-arm64 linux-bundle
#
# First run downloads toolchains/SDKs into named docker volumes (a few GB);
# later runs reuse them and are dominated by compile time.

set -euo pipefail

KIT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PF_REPO="${PF_REPO:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
PF_PROJECT_PATH="${PF_PROJECT_PATH:-.}"
PF_NAME="${PF_NAME:-$(basename "$PF_REPO")}"
TAURI_DIR="${PF_PROJECT_PATH}/src-tauri"
LINUX_IMAGE="${PF_NAME}-preflight-linux"
# Multi-arch image maintained by the cargo-xwin project (clang-cl + xwin).
XWIN_IMAGE="${PF_XWIN_IMAGE:-ghcr.io/rust-cross/cargo-xwin:latest}"

MODE="default"
ONLY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --fast) MODE="fast" ;;
    --full) MODE="full" ;;
    --only) ONLY="$2"; shift ;;
    --only=*) ONLY="${1#--only=}" ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done

stages() {
  if [ -n "$ONLY" ]; then printf '%s' "$ONLY" | tr ',' ' '; return; fi
  local mac=""
  [ "$(uname -s)" = "Darwin" ] && mac="mac"
  case "$MODE" in
    fast) echo "fmt $mac" ;;
    full) echo "fmt $mac linux-arm64 linux-amd64 windows-x64 windows-arm64 linux-bundle" ;;
    *)    echo "fmt $mac linux-arm64 linux-amd64 windows-x64 windows-arm64" ;;
  esac
}

PASS=()
FAIL=()
run_stage() {
  local name="$1"; shift
  echo ""
  echo "━━━ preflight: ${name} ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  local start=$SECONDS
  if "$@"; then
    PASS+=("${name} ($((SECONDS - start))s)")
  else
    FAIL+=("${name} ($((SECONDS - start))s)")
  fi
}

need_docker() {
  docker info >/dev/null 2>&1 || { echo "docker daemon not running" >&2; return 1; }
}

build_linux_image() {
  docker build -q -f "$KIT_DIR/Dockerfile.linux" -t "$LINUX_IMAGE" "$KIT_DIR" >/dev/null
}

# ---- stages -----------------------------------------------------------------

stage_fmt() {
  (cd "$PF_REPO/$TAURI_DIR" && cargo fmt --all -- --check)
}

stage_mac() {
  rustup target add x86_64-apple-darwin >/dev/null 2>&1 || true
  (cd "$PF_REPO/$TAURI_DIR" \
    && cargo clippy --target aarch64-apple-darwin -- -D warnings \
    && cargo clippy --target x86_64-apple-darwin -- -D warnings)
}

# $1 = docker platform (linux/arm64|linux/amd64), $2 = rust triple
stage_linux_clippy() {
  local platform="$1" triple="$2" arch="${1#linux/}"
  need_docker && build_linux_image
  docker run --rm --platform "$platform" \
    -v "$PF_REPO":/src \
    -v "${PF_NAME}-pf-rustup-${arch}":/cache/rustup \
    -v "${PF_NAME}-pf-cargo-${arch}":/cache/cargo \
    -v "${PF_NAME}-pf-target-linux-${arch}":/cache/target \
    -w "/src/$TAURI_DIR" \
    "$LINUX_IMAGE" bash -ceu '
      command -v rustup >/dev/null 2>&1 || curl --proto "=https" --tlsv1.2 -fsSL https://sh.rustup.rs \
        | sh -s -- -y --default-toolchain none --no-modify-path >/dev/null
      cargo clippy --target '"$triple"' -- -D warnings
    '
}

# $1 = rust windows triple. cargo-xwin cross-compiles MSVC targets from Linux;
# compile+lint parity with the CI clippy gate (bundling stays CI-only).
stage_windows_clippy() {
  local triple="$1"
  need_docker
  docker run --rm \
    -v "$PF_REPO":/src \
    -e RUSTUP_HOME=/cache/rustup \
    -v "${PF_NAME}-pf-xwin-rustup":/cache/rustup \
    -v "${PF_NAME}-pf-xwin-registry":/usr/local/cargo/registry \
    -v "${PF_NAME}-pf-xwin-cache":/root/.cache/cargo-xwin \
    -v "${PF_NAME}-pf-target-${triple}":/cache/target \
    -e CARGO_TARGET_DIR=/cache/target \
    -w "/src/$TAURI_DIR" \
    "$XWIN_IMAGE" bash -ceu '
      rustup target add '"$triple"' >/dev/null 2>&1 || true
      if cargo xwin clippy --help >/dev/null 2>&1; then
        cargo xwin clippy --target '"$triple"' -- -D warnings
      else
        echo "cargo-xwin has no clippy subcommand; falling back to check (compile errors only)"
        cargo xwin check --target '"$triple"'
      fi
    '
}

# Full Linux bundle from a clean clone of HEAD. Clone (not bind mount) because
# pnpm install / tauri build write node_modules and dist into the tree, which
# must never leak Linux artifacts onto the host checkout.
stage_linux_bundle() {
  need_docker && build_linux_image
  if ! git -C "$PF_REPO" diff --quiet HEAD 2>/dev/null; then
    echo "note: linux-bundle builds HEAD from a clean clone — uncommitted changes are NOT included"
  fi
  docker run --rm --platform linux/arm64 \
    -v "$PF_REPO":/host-src:ro \
    -v "${PF_NAME}-pf-rustup-arm64":/cache/rustup \
    -v "${PF_NAME}-pf-cargo-arm64":/cache/cargo \
    -v "${PF_NAME}-pf-bundle-target":/cache/target \
    -e NO_STRIP=true \
    -e PF_PROJECT_PATH="$PF_PROJECT_PATH" \
    "$LINUX_IMAGE" bash -ceu '
      command -v rustup >/dev/null 2>&1 || curl --proto "=https" --tlsv1.2 -fsSL https://sh.rustup.rs \
        | sh -s -- -y --default-toolchain none --no-modify-path >/dev/null
      git clone -q file:///host-src /work && cd /work
      corepack prepare --activate >/dev/null 2>&1 || true
      pnpm install --frozen-lockfile
      cd "$PF_PROJECT_PATH"
      pnpm exec tauri build \
        --config src-tauri/tauri.linux.conf.json \
        --config "{\"bundle\":{\"createUpdaterArtifacts\":false}}"
      ls -lh /cache/target/release/bundle/appimage/*.AppImage /cache/target/release/bundle/deb/*.deb 2>/dev/null || true
    '
}

# ---- run --------------------------------------------------------------------

for s in $(stages); do
  case "$s" in
    fmt)           run_stage "$s" stage_fmt ;;
    mac)           run_stage "$s" stage_mac ;;
    linux-arm64)   run_stage "$s" stage_linux_clippy linux/arm64 aarch64-unknown-linux-gnu ;;
    linux-amd64)   run_stage "$s" stage_linux_clippy linux/amd64 x86_64-unknown-linux-gnu ;;
    windows-x64)   run_stage "$s" stage_windows_clippy x86_64-pc-windows-msvc ;;
    windows-arm64) run_stage "$s" stage_windows_clippy aarch64-pc-windows-msvc ;;
    linux-bundle)  run_stage "$s" stage_linux_bundle ;;
    *) echo "unknown stage: $s" >&2; exit 2 ;;
  esac
done

echo ""
echo "━━━ preflight summary ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
for p in "${PASS[@]:-}"; do [ -n "$p" ] && echo "  PASS  $p"; done
for f in "${FAIL[@]:-}"; do [ -n "$f" ] && echo "  FAIL  $f"; done
[ ${#FAIL[@]} -eq 0 ]
