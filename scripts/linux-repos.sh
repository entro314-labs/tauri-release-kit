#!/usr/bin/env bash
# Build signed APT and DNF/YUM repositories from a release's .deb and .rpm files, into a static
# tree that GitHub Pages (or any web server) serves as-is. Used by .github/workflows/linux-repos.yml.
#
# Usage: linux-repos.sh <site dir> <package dir> <product> <base url> <gpg key id> [keep versions]
#
#   <site dir>     the repository tree (a checkout of the pages branch); updated in place
#   <package dir>  the new release's .deb and .rpm files
#   <product>      package name, used for file names and the .repo / keyring names
#   <base url>     where <site dir> is served, e.g. https://my-org.github.io/myapp-packages
#   <gpg key id>   an imported secret key (the one the release signs RPMs and SHA256SUMS with)
#   keep versions  newest versions kept per package file kind (default 3)
#
# Layout:
#   apt/pool/main/*.deb, apt/dists/stable/{Release,InRelease,Release.gpg,main/binary-<arch>/Packages(.gz)}
#   rpm/packages/*.rpm, rpm/repodata/* (+ repomd.xml.asc), rpm/<product>.repo
#   key.asc (the public key), index.html (install instructions)
set -euo pipefail
site="$1"; packages="$2"; product="$3"; base="${4%/}"; key="$5"; keep="${6:-3}"

mkdir -p "$site/apt/pool/main" "$site/rpm/packages"
shopt -s nullglob
debs=("$packages"/*.deb)
rpms=("$packages"/*.rpm)
[ "${#debs[@]}" -gt 0 ] || [ "${#rpms[@]}" -gt 0 ] || { echo "linux-repos: no .deb or .rpm in $packages" >&2; exit 1; }
cp -f "${debs[@]}" "$site/apt/pool/main/" 2>/dev/null || true
cp -f "${rpms[@]}" "$site/rpm/packages/" 2>/dev/null || true

# Keep the newest $keep versions of each kind (per architecture), dropping older ones.
prune() { # <dir> <glob> - files grouped by their suffix after the version (arch + extension)
  local dir="$1" pattern="$2"
  local -A groups=()
  local file name suffix
  for file in "$dir"/$pattern; do
    name="$(basename "$file")"
    suffix="$(printf '%s' "$name" | sed -E 's/^.*[0-9]([._-])/\1/')"
    groups["$suffix"]+="$file"$'\n'
  done
  for suffix in "${!groups[@]}"; do
    printf '%s' "${groups[$suffix]}" | sed '/^$/d' | sort -V | head -n -"$keep" | while IFS= read -r old; do
      rm -f -- "$old"
    done
  done
}
prune "$site/apt/pool/main" '*.deb'
prune "$site/rpm/packages" '*.rpm'

sign() { gpg --batch --yes ${LINUX_GPG_PASSPHRASE:+--passphrase "$LINUX_GPG_PASSPHRASE"} -u "$key" "$@"; }

# APT
if compgen -G "$site/apt/pool/main/*.deb" > /dev/null; then
  (
    cd "$site/apt"
    rm -rf dists
    archs="$(for deb in pool/main/*.deb; do dpkg-deb -f "$deb" Architecture; done | sort -u | tr '\n' ' ')"
    archs="${archs% }"
    for arch in $archs; do # word-split on purpose: one architecture per word
      mkdir -p "dists/stable/main/binary-$arch"
      apt-ftparchive --arch "$arch" packages pool/main > "dists/stable/main/binary-$arch/Packages"
      gzip -9kf "dists/stable/main/binary-$arch/Packages"
    done
    apt-ftparchive \
      -o APT::FTPArchive::Release::Origin="$product" \
      -o APT::FTPArchive::Release::Label="$product" \
      -o APT::FTPArchive::Release::Suite=stable \
      -o APT::FTPArchive::Release::Codename=stable \
      -o APT::FTPArchive::Release::Components=main \
      -o APT::FTPArchive::Release::Architectures="$archs" \
      release dists/stable > "${RUNNER_TEMP:-/tmp}/Release"
    mv "${RUNNER_TEMP:-/tmp}/Release" dists/stable/Release
    sign --clearsign -o dists/stable/InRelease dists/stable/Release
    sign --armor --detach-sign -o dists/stable/Release.gpg dists/stable/Release
  )
fi

# DNF / YUM
if compgen -G "$site/rpm/packages/*.rpm" > /dev/null; then
  createrepo_c --quiet --update "$site/rpm"
  sign --armor --detach-sign -o "$site/rpm/repodata/repomd.xml.asc" "$site/rpm/repodata/repomd.xml"
  cat > "$site/rpm/$product.repo" <<REPO
[$product]
name=$product
baseurl=$base/rpm
enabled=1
gpgcheck=1
repo_gpgcheck=1
gpgkey=$base/key.asc
REPO
fi

gpg --armor --export "$key" > "$site/key.asc"
cat > "$site/index.html" <<HTML
<!doctype html>
<meta charset="utf-8">
<title>$product packages</title>
<h1>$product packages</h1>
<h2>Debian / Ubuntu</h2>
<pre>curl -fsSL $base/key.asc | sudo gpg --dearmor -o /usr/share/keyrings/$product.gpg
echo "deb [signed-by=/usr/share/keyrings/$product.gpg] $base/apt stable main" | sudo tee /etc/apt/sources.list.d/$product.list
sudo apt update &amp;&amp; sudo apt install $product</pre>
<h2>Fedora / RHEL / openSUSE</h2>
<pre>sudo curl -fsSL -o /etc/yum.repos.d/$product.repo $base/rpm/$product.repo
sudo dnf install $product</pre>
HTML
touch "$site/.nojekyll"
echo "linux-repos: $(find "$site/apt/pool" -name '*.deb' | wc -l) .deb, $(find "$site/rpm/packages" -name '*.rpm' | wc -l) .rpm"
