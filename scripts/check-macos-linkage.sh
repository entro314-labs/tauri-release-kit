#!/usr/bin/env bash
# Fails when a Mach-O file inside a built .app links a library by a path that
# exists only on the build machine (release.yml, `macos_linkage_check`).
#
#   check-macos-linkage.sh <path to .app>
#
# A binary or sidecar that picked up a Homebrew library at link time records
# its absolute path (/opt/homebrew/opt/openssl@3/lib/libssl.3.dylib). The
# runner has that file, so the leg builds, signs, notarizes and even launches;
# every user machine without the same Homebrew formula crashes at launch with
# "dyld: Library not loaded". Notarization does not look at load paths.
#
# Checked: every file in Contents/MacOS (the app and its sidecars), everything
# under Contents/Frameworks, and any .dylib/.so elsewhere in the bundle — the
# non-Mach-O ones are skipped. Flagged: load paths under /opt/homebrew/ (Apple
# Silicon Homebrew) and /usr/local/{opt,Cellar,lib}/ (Intel Homebrew — its
# /usr/local/lib entries are symlinks into the Cellar, so the same bug).
# @rpath/@executable_path/@loader_path and /usr/lib, /System are legitimate.
#
# Every offending file is reported before exiting non-zero.
set -euo pipefail

if [ "$#" -ne 1 ] || [ ! -d "$1/Contents" ]; then
  echo "usage: $0 <path to .app>" >&2
  exit 2
fi
APP="$1"
BAD_PATHS='^(/opt/homebrew/|/usr/local/(opt|Cellar|lib)/)'
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
done < <(
  {
    find "$APP/Contents/MacOS" -type f -print0 2>/dev/null
    find "$APP/Contents/Frameworks" -type f -print0 2>/dev/null
    find "$APP/Contents" -type f \( -name '*.dylib' -o -name '*.so' \) -not -path "$APP/Contents/MacOS/*" -not -path "$APP/Contents/Frameworks/*" -print0 2>/dev/null
  }
)

if [ "$CHECKED" = 0 ]; then
  echo "::error::No Mach-O files found in $(basename "$APP") — nothing was checked"
  exit 1
fi
if [ "$FAIL" = 0 ]; then
  echo "Linkage OK: ${CHECKED} Mach-O file(s) in $(basename "$APP") link no Homebrew/runner-local paths."
fi
exit "$FAIL"
