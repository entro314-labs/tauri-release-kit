#!/usr/bin/env bash
# Runs a bundled sidecar with --version and checks it reports the release
# version (smoke-linux.sh / smoke-macos.sh, `sidecar_binaries`).
#
#   check-sidecar-version.sh <path to sidecar> <version> <label>
#
# A sidecar that other programs are pointed at (an MCP server, a CLI) can go
# missing from a bundle, fail to start, or be a stale build, and nothing in the
# app's own launch would notice. The last line of its --version output must
# equal the version, or end in it after a space (`my-tool 1.2.3`). <label>
# names the bundle in messages.
set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "usage: $0 <path to sidecar> <version> <label>" >&2
  exit 2
fi
SIDECAR="$1"
VERSION="$2"
LABEL="$3"
NAME="$(basename "$SIDECAR")"

if [ ! -x "$SIDECAR" ]; then
  echo "::error::${LABEL}: sidecar ${NAME} is missing or not executable"
  exit 1
fi
set +e
OUT="$("$SIDECAR" --version 2>&1)"
STATUS=$?
set -e
LAST="$(printf '%s\n' "$OUT" | tr -d '\r' | sed -e 's/[[:space:]]*$//' | sed -e '/^$/d' | tail -n 1)"
if [ "$STATUS" -ne 0 ]; then
  echo "::error::${LABEL}: ${NAME} --version exited with status ${STATUS}. Its output:"
  printf '%s\n' "$OUT"
  exit 1
fi
if [ "$LAST" = "$VERSION" ] || [ "${LAST##* }" = "$VERSION" ]; then
  echo "${LABEL}: sidecar ${NAME} reports ${VERSION}"
else
  echo "::error::${LABEL}: ${NAME} --version printed '${LAST}', expected ${VERSION}"
  exit 1
fi
