#!/usr/bin/env bash
# Fails when a Mach-O file inside a built .app links a library by a path that
# exists only on the build machine (release.yml, `macos_linkage_check`), and -
# when EXPECTED_ARCH is set (`macos_arch_check`) - when one lacks the leg's
# architecture.
#
#   [EXPECTED_ARCH=x86_64|arm64] [ARCH_ALLOWLIST=<paths>] check-macos-linkage.sh <path to .app>
#
# A binary or sidecar that picked up a Homebrew library at link time records
# its absolute path (/opt/homebrew/opt/openssl@3/lib/libssl.3.dylib). The
# runner has that file, so the leg builds, signs, notarizes and even launches;
# every user machine without the same Homebrew formula crashes at launch with
# "dyld: Library not loaded". Notarization does not look at load paths.
#
# Checked: every file in Contents/MacOS (the app and its sidecars) and
# everything under Contents/Frameworks; with SCAN_RESOURCES=true
# (`macos_linkage_scan_resources`) or EXPECTED_ARCH set also any .dylib/.so
# elsewhere in the bundle, e.g. Contents/Resources. The non-Mach-O ones are
# skipped. Flagged: load paths under /opt/homebrew/ (Apple
# Silicon Homebrew) and /usr/local/{opt,Cellar,lib}/ (Intel Homebrew — its
# /usr/local/lib entries are symlinks into the Cellar, so the same bug).
# @rpath/@executable_path/@loader_path and /usr/lib, /System are legitimate.
#
# Architecture (opt-in): with EXPECTED_ARCH set, `lipo -archs` of every checked
# file must include it. The Intel leg cross-builds on an Apple Silicon runner
# and its smoke launch, if any, runs under Rosetta - neither notices a thin
# arm64 dylib or sidecar inside the x86_64 bundle, which then fails to load on
# an Intel Mac. ARCH_ALLOWLIST (comma- or newline-separated paths relative to
# the .app, e.g. Contents/Resources/libfoo.dylib) exempts files that are never
# loaded on that architecture.
#
# Every offending file is reported before exiting non-zero.
set -euo pipefail

if [ "$#" -ne 1 ] || [ ! -d "$1/Contents" ]; then
  echo "usage: $0 <path to .app>" >&2
  exit 2
fi
APP="$1"
BAD_PATHS='^(/opt/homebrew/|/usr/local/(opt|Cellar|lib)/)'
EXPECTED_ARCH="${EXPECTED_ARCH:-}"
SCAN_RESOURCES="${SCAN_RESOURCES:-false}"
# Entries trimmed of surrounding whitespace; spaces inside a path are kept.
ALLOWED=",$(printf '%s' "${ARCH_ALLOWLIST:-}" | tr '\n' ',' | sed -E 's/[[:space:]]*,[[:space:]]*/,/g; s/^[[:space:]]+//; s/[[:space:]]+$//'),"
FAIL=0
CHECKED=0

while IFS= read -r -d '' FILE; do
  file -b "$FILE" | grep -q 'Mach-O' || continue
  CHECKED=$((CHECKED + 1))
  # Line one (per architecture slice) names the file itself and ends in ':';
  # every load command after it is "<tab><path> (compatibility version …)".
  BAD="$(otool -L "$FILE" | grep -v ':$' | sed -E 's/^[[:space:]]+//; s/ \(.*$//' | grep -E "$BAD_PATHS" | sort -u || true)"
  if [ -n "$BAD" ]; then
    REL="${FILE#"$APP"/}"
    while IFS= read -r LIB; do
      echo "::error::${REL} links ${LIB} — a build-machine-only path; users without that Homebrew formula crash at launch. Vendor/static-link it, or bundle it and link via @rpath."
    done <<<"$BAD"
    FAIL=1
  fi
  if [ -n "$EXPECTED_ARCH" ]; then
    REL="${FILE#"$APP"/}"
    case "$ALLOWED" in
      *",${REL},"*) echo "arch: ${REL} is allowlisted" ;;
      *)
        ARCHS="$(lipo -archs "$FILE")"
        case " ${ARCHS} " in
          *" ${EXPECTED_ARCH} "*) ;;
          *)
            echo "::error::${REL} is built for '${ARCHS}', not ${EXPECTED_ARCH} — it cannot load on this leg's machines. Build it for ${EXPECTED_ARCH}, ship it only in the matching bundle, or allowlist it if it is never loaded there."
            FAIL=1
            ;;
        esac
        ;;
    esac
  fi
done < <(
  {
    # `|| true` on each: under `set -e` a missing directory (most bundles have
    # no Contents/Frameworks) would otherwise end the list before the next find.
    find "$APP/Contents/MacOS" -type f -print0 2>/dev/null || true
    find "$APP/Contents/Frameworks" -type f -print0 2>/dev/null || true
    # Resources are also needed when the architecture check is on: a thin dylib
    # shipped as a resource is exactly what it exists to catch.
    if [ "$SCAN_RESOURCES" = "true" ] || [ -n "$EXPECTED_ARCH" ]; then
      find "$APP/Contents" -type f \( -name '*.dylib' -o -name '*.so' \) -not -path "$APP/Contents/MacOS/*" -not -path "$APP/Contents/Frameworks/*" -print0 2>/dev/null || true
    fi
  }
)

if [ "$CHECKED" = 0 ]; then
  echo "::error::No Mach-O files found in $(basename "$APP") — nothing was checked"
  exit 1
fi
if [ "$FAIL" = 0 ]; then
  echo "Linkage OK: ${CHECKED} Mach-O file(s) in $(basename "$APP") link no Homebrew/runner-local paths."
  if [ -n "$EXPECTED_ARCH" ]; then
    echo "Architecture OK: every checked file includes ${EXPECTED_ARCH}."
  fi
fi
exit "$FAIL"
