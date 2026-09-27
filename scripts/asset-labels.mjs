/**
 * Human-readable labels for release assets (chiri's asset labelling). GitHub shows an asset's
 * label instead of its file name on the release page, so users pick "macOS (Apple Silicon) · disk
 * image" instead of decoding `MyApp_1.2.3_aarch64.dmg`; the file names - which the updater
 * manifest and verify-release depend on - stay as they are. Every signature and bundle is labelled
 * after the file it signs, so they read as a group.
 *
 * CLI (the checksums job): `node asset-labels.mjs <name>...` prints `name<TAB>label` lines.
 */

/** @param {string} name */
function arch(name, os) {
  if (/(aarch64|arm64)/.test(name)) return os === 'macOS' ? 'Apple Silicon' : 'ARM64'
  if (/(x86_64|x64|amd64)/.test(name)) return os === 'macOS' ? 'Intel' : 'x64'
  return ''
}

/**
 * The label for one asset name, or null when it has no better name than its own.
 * @param {string} name
 * @returns {string | null}
 */
export function assetLabel(name) {
  if (name.endsWith('.sig')) {
    const base = assetLabel(name.slice(0, -'.sig'.length))
    return base ? `${base} · updater signature` : null
  }
  if (name.endsWith('.sigstore.json')) {
    const base = assetLabel(name.slice(0, -'.sigstore.json'.length))
    return base ? `${base} · Sigstore bundle` : null
  }
  if (name === 'SHA256SUMS') return 'Checksums (SHA-256)'
  if (name === 'SHA256SUMS.asc') return 'Checksums (SHA-256) · GPG signature'
  if (name.endsWith('.asc')) return 'GPG public key'
  if (name.endsWith('.spdx.json')) return 'Software bill of materials (SPDX)'
  if (name.endsWith('.cdx.json')) return 'Software bill of materials (CycloneDX)'
  if (name === 'provenance.json') return 'Build provenance'
  if (/^latest(-[a-z]+)?\.json$/.test(name)) return 'Update manifest'
  const kinds = [
    [/\.dmg$/, 'macOS', 'disk image'],
    [/\.app\.tar\.gz$/, 'macOS', 'app (update archive)'],
    [/-setup\.exe$/, 'Windows', 'installer'],
    [/\.msi$/, 'Windows', 'MSI installer'],
    [/\.deb$/, 'Linux', 'Debian / Ubuntu package'],
    [/\.rpm$/, 'Linux', 'Fedora / openSUSE package'],
    [/\.AppImage$/, 'Linux', 'AppImage'],
  ]
  for (const [pattern, os, kind] of kinds) {
    if (pattern.test(name)) {
      const a = arch(name, os)
      return a ? `${os} (${a}) · ${kind}` : `${os} · ${kind}`
    }
  }
  return null
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const name of process.argv.slice(2)) {
    const label = assetLabel(name)
    if (label) process.stdout.write(`${name}\t${label}\n`)
  }
}
