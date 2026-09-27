#!/usr/bin/env bash
# Give every asset of a release its readable label (asset-labels.mjs). Idempotent: assets already
# labelled that way are left alone. Needs GH_TOKEN, REPO (owner/name) and RELEASE_ID.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
retry() { local n=1; until "$@"; do [ "$n" -ge 3 ] && return 1; sleep $((n * 15)); n=$((n + 1)); done; }

assets="$(mktemp)"
gh api --paginate "repos/${REPO}/releases/${RELEASE_ID}/assets?per_page=100" \
  --jq '.[] | [.id, .name, (.label // "")] | @tsv' > "$assets"
mapfile -t names < <(cut -f2 "$assets")
[ "${#names[@]}" -gt 0 ] || exit 0
labels="$(node "$here/asset-labels.mjs" "${names[@]}")"

changed=0
while IFS=$'\t' read -r id name current; do
  wanted="$(printf '%s\n' "$labels" | awk -F'\t' -v n="$name" '$1 == n { print $2; exit }')"
  if [ -n "$wanted" ] && [ "$wanted" != "$current" ]; then
    retry gh api -X PATCH "repos/${REPO}/releases/assets/${id}" -f name="$name" -f label="$wanted" > /dev/null
    changed=$((changed + 1))
  fi
done < "$assets"
echo "Labelled ${changed} release assets."
