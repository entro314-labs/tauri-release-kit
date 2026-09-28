#!/usr/bin/env bash
# WebDriver boot gate for a Linux build leg (release.yml, `webdriver_smoke`).
#
#   webdriver-smoke.sh <app binary> <command...>
#
# The package smoke test proves the app starts; this proves its UI renders: the app's own check
# (the command, which gets the binary path as its last argument) drives the built binary through
# tauri-driver + WebKitWebDriver under Xvfb, with a fresh profile (XDG dirs in a temp folder) so no
# earlier state can hide a first-run failure. The command's exit status is the result.
set -euo pipefail

if [ "$#" -lt 2 ]; then
  echo "usage: $0 <app binary> <command...>" >&2
  exit 2
fi
BINARY="$1"
shift
if [ ! -x "$BINARY" ]; then
  echo "::error::webdriver_binary '${BINARY}' is not an executable file in this leg's build output"
  exit 1
fi

if ! command -v WebKitWebDriver >/dev/null; then
  sudo apt-get install -y webkit2gtk-driver xvfb xauth
fi
if ! command -v tauri-driver >/dev/null; then
  cargo install tauri-driver --locked
fi
# Without a portal service WebKitGTK waits ~30 s for org.freedesktop.portal.Desktop on each launch.
sudo rm -f /usr/share/dbus-1/services/org.freedesktop.portal.Desktop.service

PROFILE="$(mktemp -d "${RUNNER_TEMP:-/tmp}/webdriver-profile.XXXXXX")"
export XDG_DATA_HOME="$PROFILE/data" XDG_CONFIG_HOME="$PROFILE/config" XDG_CACHE_HOME="$PROFILE/cache"
# Xvfb is an X server; WebKitGTK's DMA-BUF renderer fails EGL on GPU-less runners.
export GDK_BACKEND=x11 WEBKIT_DISABLE_DMABUF_RENDERER=1

# shellcheck disable=SC2016 # expanded by the inner shell
xvfb-run -a bash -c '
  tauri-driver --port 4444 &
  DRIVER=$!
  for _ in $(seq 1 30); do
    curl -sf http://127.0.0.1:4444/status >/dev/null && break
    sleep 1
  done
  set +e
  "$@"
  STATUS=$?
  kill "$DRIVER" 2>/dev/null
  exit "$STATUS"
' webdriver-smoke "$@" "$BINARY"
