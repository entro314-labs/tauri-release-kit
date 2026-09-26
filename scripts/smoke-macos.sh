#!/usr/bin/env bash
# Package smoke test for a macOS build leg (release.yml, `smoke_test: true`).
#
#   smoke-macos.sh <bundle dir> <bundles csv>
#
# - dmg: `hdiutil verify` checks the image's internal checksum — a truncated or
#   corrupt DMG fails here instead of on a user's "image not recognized".
# - app: the .app's main executable (CFBundleExecutable) is launched directly
#   and must still be running after SMOKE_SECONDS (default 10; overridable for
#   the tests). A dyld error ("Library not loaded"), a panic in setup code or
#   a crash on launch ends it early; its output is printed.
#
# Every failure is reported before exiting non-zero.
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: $0 <bundle dir> <bundles csv>" >&2
  exit 2
fi
BUNDLE_DIR="$1"
BUNDLES=",$2,"
ALIVE="${SMOKE_SECONDS:-10}"
FAIL=0

case "$BUNDLES" in *,dmg,*)
  FOUND=0
  while IFS= read -r -d '' DMG; do
    FOUND=1
    if hdiutil verify "$DMG"; then
      echo "dmg: $(basename "$DMG") verified"
    else
      echo "::error::hdiutil verify failed for $(basename "$DMG")"
      FAIL=1
    fi
  done < <(find "$BUNDLE_DIR/dmg" -maxdepth 1 -name '*.dmg' -print0 2>/dev/null)
  if [ "$FOUND" = 0 ]; then
    echo "::error::dmg is in this leg's bundle list but there is no .dmg under ${BUNDLE_DIR}/dmg"
    FAIL=1
  fi
;; esac

case "$BUNDLES" in *,app,*)
  APP="$(find "$BUNDLE_DIR/macos" -maxdepth 1 -name '*.app' -print -quit 2>/dev/null || true)"
  if [ -z "$APP" ]; then
    echo "::error::app is in this leg's bundle list but there is no .app under ${BUNDLE_DIR}/macos"
    FAIL=1
  else
    EXE="$(plutil -extract CFBundleExecutable raw -o - "$APP/Contents/Info.plist")"
    LOG="$(mktemp "${RUNNER_TEMP:-/tmp}/app-smoke.XXXXXX")"
    "$APP/Contents/MacOS/$EXE" >"$LOG" 2>&1 &
    PID=$!
    sleep "$ALIVE"
    if kill -0 "$PID" 2>/dev/null; then
      echo "app: $(basename "$APP") ($EXE) still running after ${ALIVE}s"
      kill "$PID" 2>/dev/null || true
      wait "$PID" 2>/dev/null || true
    else
      set +e
      wait "$PID"
      STATUS=$?
      set -e
      echo "::error::$(basename "$APP") exited during startup (status ${STATUS}) instead of running for ${ALIVE}s. Its output:"
      cat "$LOG"
      FAIL=1
    fi
  fi
;; esac

exit "$FAIL"
