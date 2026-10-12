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
# - rpm (only when RPM_REQUIRES or RPM_INSTALL_IMAGE is set - otherwise the rpm
#   is not looked at): every capability in the comma-separated RPM_REQUIRES must
#   be listed by `rpm -qp --requires` (the bundler derives soname Requires such
#   as `libwebkit2gtk-4.1.so.0()(64bit)`; an rpm without them installs on a
#   machine that cannot run it). With RPM_INSTALL_IMAGE (e.g. fedora:43) each
#   .rpm is also `dnf install`ed in a fresh container of that image - no dev
#   packages - and every installed executable or shared object must resolve all
#   its libraries: no "not found" from `ldd -r`.
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

RPM_REQUIRES="${RPM_REQUIRES:-}"
RPM_INSTALL_IMAGE="${RPM_INSTALL_IMAGE:-}"
# Runs inside the container as `sh -c "$RPM_INSTALL_SCRIPT" sh <rpm>`.
# shellcheck disable=SC2016 # expanded by the container's sh, not here
RPM_INSTALL_SCRIPT='set -eu
if ! dnf -y -q install "$1" >/tmp/dnf.log 2>&1; then
  cat /tmp/dnf.log
  echo "dnf could not install $1"
  exit 1
fi
rpm -qlp "$1" >/tmp/files
missing=0
while IFS= read -r f; do
  [ -f "$f" ] || continue
  case "$f" in *.so|*.so.*) ;; *) [ -x "$f" ] || continue ;; esac
  unresolved="$(ldd -r "$f" 2>&1 | grep "not found" || true)"
  if [ -n "$unresolved" ]; then
    printf "%s:\n%s\n" "$f" "$unresolved"
    missing=1
  fi
done </tmp/files
exit "$missing"'

case "$BUNDLES" in *,rpm,*)
  if [ -n "$RPM_REQUIRES" ] || [ -n "$RPM_INSTALL_IMAGE" ]; then
    FOUND=0
    while IFS= read -r -d '' RPM; do
      FOUND=1
      NAME="$(basename "$RPM")"
      if [ -n "$RPM_REQUIRES" ]; then
        DECLARED="$(rpm -qp --requires "$RPM")"
        MISSING=0
        IFS=',' read -r -a CAPS <<<"$RPM_REQUIRES"
        for CAP in "${CAPS[@]}"; do
          CAP="${CAP#"${CAP%%[![:space:]]*}"}"
          CAP="${CAP%"${CAP##*[![:space:]]}"}"
          [ -n "$CAP" ] || continue
          if ! grep -qxF -- "$CAP" <<<"$DECLARED"; then
            echo "::error::${NAME} does not declare Requires: ${CAP}"
            MISSING=1
            FAIL=1
          fi
        done
        if [ "$MISSING" = 0 ]; then
          echo "rpm: ${NAME} declares every required capability"
        fi
      fi
      if [ -n "$RPM_INSTALL_IMAGE" ]; then
        RPM_DIR="$(cd "$(dirname "$RPM")" && pwd)"
        set +e
        OUT="$(docker run --rm -v "${RPM_DIR}:/pkg:ro" "$RPM_INSTALL_IMAGE" sh -c "$RPM_INSTALL_SCRIPT" sh "/pkg/${NAME}" 2>&1)"
        STATUS=$?
        set -e
        if [ "$STATUS" -ne 0 ]; then
          echo "::error::${NAME} failed a clean install on ${RPM_INSTALL_IMAGE} (status ${STATUS}):"
          echo "$OUT"
          FAIL=1
        else
          echo "rpm: ${NAME} installs on a clean ${RPM_INSTALL_IMAGE} and every library resolves"
        fi
      fi
    done < <(find "$BUNDLE_DIR/rpm" -maxdepth 1 -name '*.rpm' -print0 2>/dev/null)
    if [ "$FOUND" = 0 ]; then
      echo "::error::rpm checks are configured but there is no .rpm under ${BUNDLE_DIR}/rpm"
      FAIL=1
    fi
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
