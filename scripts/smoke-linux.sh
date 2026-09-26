#!/usr/bin/env bash
# Package smoke test for a Linux build leg (release.yml, `smoke_test: true`).
#
#   smoke-linux.sh <bundle dir> <version> <bundles csv>
#
# Signature checks prove a package is ours; they say nothing about whether it
# starts. This catches what they cannot: a .deb whose control file carries the
# wrong version, and an AppImage that dies at startup (a missing shared
# library, a panic in setup code, a WebKitGTK that cannot initialise).
#
# - deb: `dpkg-deb -f <deb> Version` must equal the release version.
# - appimage: extracted (no FUSE needed) and launched under Xvfb; it must still
#   be running after SMOKE_SECONDS (default 15; overridable for the tests), i.e.
#   `timeout` must be what ends it (exit 124), and its output must not contain
#   a panic or a dynamic-linker error. GDK_BACKEND=x11 because Xvfb is an X
#   server; WEBKIT_DISABLE_DMABUF_RENDERER=1 because WebKitGTK's DMA-BUF
#   renderer fails EGL initialisation on GPU-less runners and exits, which
#   would fail every run for a reason no user machine shares.
#
# Every failure is reported before exiting non-zero.
set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "usage: $0 <bundle dir> <version> <bundles csv>" >&2
  exit 2
fi
BUNDLE_DIR="$1"
VERSION="$2"
BUNDLES=",$3,"
ALIVE="${SMOKE_SECONDS:-15}"
FAIL=0

case "$BUNDLES" in *,deb,*)
  FOUND=0
  while IFS= read -r -d '' DEB; do
    FOUND=1
    GOT="$(dpkg-deb -f "$DEB" Version)"
    if [ "$GOT" = "$VERSION" ]; then
      echo "deb: $(basename "$DEB") declares Version ${GOT}"
    else
      echo "::error::$(basename "$DEB") declares Version '${GOT}', expected '${VERSION}'"
      FAIL=1
    fi
  done < <(find "$BUNDLE_DIR/deb" -maxdepth 1 -name '*.deb' -print0 2>/dev/null)
  if [ "$FOUND" = 0 ]; then
    echo "::error::deb is in this leg's bundle list but there is no .deb under ${BUNDLE_DIR}/deb"
    FAIL=1
  fi
;; esac

case "$BUNDLES" in *,appimage,*)
  APPIMAGE="$(find "$BUNDLE_DIR/appimage" -maxdepth 1 -name '*.AppImage' -print -quit 2>/dev/null || true)"
  if [ -z "$APPIMAGE" ]; then
    echo "::error::appimage is in this leg's bundle list but there is no .AppImage under ${BUNDLE_DIR}/appimage"
    FAIL=1
  else
    APPIMAGE="$(cd "$(dirname "$APPIMAGE")" && pwd)/$(basename "$APPIMAGE")"
    WORK="$(mktemp -d "${RUNNER_TEMP:-/tmp}/appimage-smoke.XXXXXX")"
    (cd "$WORK" && "$APPIMAGE" --appimage-extract >/dev/null)
    set +e
    (cd "$WORK" && GDK_BACKEND=x11 WEBKIT_DISABLE_DMABUF_RENDERER=1 \
      timeout "${ALIVE}s" xvfb-run -a ./squashfs-root/AppRun >startup.log 2>&1)
    STATUS=$?
    set -e
    if [ "$STATUS" -ne 124 ]; then
      echo "::error::$(basename "$APPIMAGE") exited during startup (status ${STATUS}) instead of running for ${ALIVE}s. Its output:"
      cat "$WORK/startup.log"
      FAIL=1
    elif grep -Ei 'panicked at|symbol lookup error|error while loading shared libraries' "$WORK/startup.log"; then
      echo "::error::$(basename "$APPIMAGE") kept running but logged a panic or linker error (above)"
      FAIL=1
    else
      echo "appimage: $(basename "$APPIMAGE") still running after ${ALIVE}s"
    fi
  fi
;; esac

exit "$FAIL"
