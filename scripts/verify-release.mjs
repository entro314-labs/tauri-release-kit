/**
 * Pre-publish verification of a draft release, run by release.yml's `verify-release` job.
 *
 * The job checks this file out of the kit at the exact commit the caller pinned
 * (job.workflow_repository @ job.workflow_sha) and calls `run()` from actions/github-script,
 * which supplies the authenticated Octokit client. Everything else here is a pure function
 * with tests in verify-release.test.mjs — the checks used to live inline in the workflow,
 * where nothing could exercise them short of a real release.
 *
 * What it proves before the draft flips public, accumulating every failure instead of
 * stopping at the first:
 *   - the release is still a draft, flagged prerelease exactly when the channel is not stable
 *   - the asset list equals the list this configuration must produce: every bundle format for
 *     every SHIPPED target (not just this run's build set), their updater signatures, and the
 *     channel manifest — both missing and unexpected names are failures
 *   - every asset is non-empty and GitHub has computed its sha256 digest
 *   - the updater manifest has the right version, exactly the shipped platform set, and every
 *     URL points at the serving repo's download path for this tag and at that platform's
 *     updater artifact
 *   - every manifest signature equals the uploaded .sig byte for byte, decodes to a minisign
 *     envelope, and was made by the key whose public half the app ships
 *     (plugins.updater.pubkey) — the tauri CLI only warns about a mismatched key, and a
 *     mismatch breaks every installed copy's next update
 *
 * Expected asset names are computed, never listed per app. They follow tauri-action v1's
 * naming (it uploads only files at the paths it predicts, so its prediction IS the upload
 * set), with the app's productName / rpm release / WiX languages read from tauri.conf.json
 * and the per-OS overlay the way tauri-action merges them, then GitHub's renaming of special
 * characters in asset names.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Per-target architecture tokens tauri-action puts in each format's file name. */
export const TARGETS = {
  'darwin-aarch64': { os: 'darwin', mac: 'aarch64' },
  'darwin-x86_64': { os: 'darwin', mac: 'x64' },
  'windows-x86_64': { os: 'windows', win: 'x64' },
  'windows-aarch64': { os: 'windows', win: 'arm64' },
  'linux-x86_64': { os: 'linux', deb: 'amd64', rpm: 'x86_64', appimage: 'amd64' },
  'linux-aarch64': { os: 'linux', deb: 'arm64', rpm: 'aarch64', appimage: 'aarch64' },
}

/** Overlay file tauri merges on top of tauri.conf.json for each OS. */
const OVERLAY = { darwin: 'tauri.macos.conf.json', windows: 'tauri.windows.conf.json', linux: 'tauri.linux.conf.json' }

/**
 * The name GitHub stores for an uploaded asset: characters outside [A-Za-z0-9_-] become
 * dots (a product name "My App" is served as "My.App_…"). Same rule tauri-action uses to
 * find an asset it uploaded earlier.
 * @param {string} name
 * @returns {string}
 */
export function ghAssetName(name) {
  return name.trim().replace(/[^a-zA-Z0-9_-]/g, '.').replace(/\.\./g, '.')
}

/** Splits a comma-separated input into trimmed, non-empty entries. */
export function csv(value) {
  return String(value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * The [package] name from a Cargo.toml — tauri's fallback when productName is unset.
 * @param {string} text
 * @returns {string | null}
 */
export function cargoPackageName(text) {
  let inPackage = false
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('[')) inPackage = line === '[package]'
    else if (inPackage) {
      const m = /^name\s*=\s*"([^"]+)"/.exec(line)
      if (m) return m[1]
    }
  }
  return null
}

/**
 * Normalises bundle.windows.wix.language (string | string[] | { [lang]: … }) to a list.
 * @param {unknown} value
 * @returns {string[]}
 */
export function wixLanguages(value) {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.map(String)
  if (value && typeof value === 'object') return Object.keys(value)
  return ['en-US']
}

/**
 * What each OS's assets are named after, from the base config and the per-OS overlays.
 * A key set in the overlay replaces the base's (tauri-action's merge for these fields).
 * @param {{ base: any, overlays: { darwin?: any, windows?: any, linux?: any }, cargoName: string | null }} input
 */
export function appNaming({ base, overlays, cargoName }) {
  const pick = (os, read) => {
    const o = overlays[os] ? read(overlays[os]) : undefined
    return o ?? read(base)
  }
  const product = (os) => {
    const name = pick(os, (c) => c?.productName) ?? cargoName
    if (!name) {
      throw new Error('tauri.conf.json has no productName and Cargo.toml has no [package] name to fall back on')
    }
    return ghAssetName(name)
  }
  const release = pick('linux', (c) => c?.bundle?.linux?.rpm?.release)
  return {
    darwin: { product: product('darwin') },
    windows: { product: product('windows'), wixLanguages: wixLanguages(pick('windows', (c) => c?.bundle?.windows?.wix?.language)) },
    linux: { product: product('linux'), rpmRelease: release ? String(release) : '1' },
    // The updater public key every installed copy verifies downloads with.
    pubkey: base?.plugins?.updater?.pubkey ?? null,
  }
}

/**
 * Reads appNaming's inputs from an app's src-tauri directory.
 * @param {string} srcTauri
 */
export function loadAppNaming(srcTauri) {
  const readJson = (file) => {
    const path = join(srcTauri, file)
    if (!existsSync(path)) return undefined
    try {
      return JSON.parse(readFileSync(path, 'utf8'))
    } catch (error) {
      throw new Error(`${path} is not valid JSON: ${error.message}`)
    }
  }
  const base = readJson('tauri.conf.json')
  if (!base) throw new Error(`${join(srcTauri, 'tauri.conf.json')} not found`)
  const cargo = join(srcTauri, 'Cargo.toml')
  return appNaming({
    base,
    overlays: { darwin: readJson(OVERLAY.darwin), windows: readJson(OVERLAY.windows), linux: readJson(OVERLAY.linux) },
    cargoName: existsSync(cargo) ? cargoPackageName(readFileSync(cargo, 'utf8')) : null,
  })
}

/** The update manifest the channel's clients poll. */
export function manifestName(channel) {
  return channel === 'stable' ? 'latest.json' : `latest-${channel}.json`
}

/**
 * The asset the updater manifest must point at for a platform.
 * @param {string} target
 * @param {ReturnType<typeof appNaming>} naming
 * @param {string} version bare version (no leading v)
 */
export function updaterAsset(target, naming, version) {
  const t = TARGETS[target]
  if (!t) throw new Error(`Unknown target '${target}'`)
  if (t.os === 'darwin') return `${naming.darwin.product}_${version}_${t.mac}.app.tar.gz`
  if (t.os === 'windows') return `${naming.windows.product}_${version}_${t.win}-setup.exe`
  return `${naming.linux.product}_${version}_${t.appimage}.AppImage`
}

/**
 * Every asset this configuration must put on the release, and the ones it may.
 *
 * Optional: the .deb/.rpm updater signatures, which tauri-cli emits only from the release
 * that taught its updater to install those formats — an older CLI simply does not write
 * them. Everything else is required, and anything outside both lists is unexpected (the
 * v1Compatible *.nsis.zip / *.msi.zip / *.AppImage.tar.gz archives, a stray tauri-action
 * latest.json, a file from another app).
 *
 * @param {{ version: string, channel: string, targets: string[],
 *   bundles: { macos: string[], windows: string[], linux: string[] },
 *   naming: ReturnType<typeof appNaming>, extra?: string[] }} input
 *   `bundles.windows` is the x86_64 leg's list; the aarch64 leg never builds msi (WiX has
 *   no ARM64 target), exactly as the plan job degrades it. `extra` names assets other jobs
 *   add (checksums, SBOMs).
 * @returns {{ required: string[], optional: string[] }}
 */
export function expectedAssets({ version, channel, targets, bundles, naming, extra = [] }) {
  const required = [manifestName(channel), ...extra]
  const optional = []
  for (const target of targets) {
    const t = TARGETS[target]
    if (!t) throw new Error(`Unknown target '${target}'`)
    if (t.os === 'darwin') {
      const stem = `${naming.darwin.product}_${version}_${t.mac}`
      if (bundles.macos.includes('app')) required.push(`${stem}.app.tar.gz`, `${stem}.app.tar.gz.sig`)
      if (bundles.macos.includes('dmg')) required.push(`${stem}.dmg`)
    } else if (t.os === 'windows') {
      const stem = `${naming.windows.product}_${version}_${t.win}`
      const formats = t.win === 'arm64' ? bundles.windows.filter((f) => f !== 'msi') : bundles.windows
      if (formats.includes('nsis')) required.push(`${stem}-setup.exe`, `${stem}-setup.exe.sig`)
      if (formats.includes('msi')) {
        for (const lang of naming.windows.wixLanguages) required.push(`${stem}_${lang}.msi`, `${stem}_${lang}.msi.sig`)
      }
    } else {
      const p = naming.linux.product
      if (bundles.linux.includes('deb')) {
        required.push(`${p}_${version}_${t.deb}.deb`)
        optional.push(`${p}_${version}_${t.deb}.deb.sig`)
      }
      if (bundles.linux.includes('rpm')) {
        const rpm = `${p}-${version}-${naming.linux.rpmRelease}.${t.rpm}.rpm`
        required.push(rpm)
        optional.push(`${rpm}.sig`)
      }
      if (bundles.linux.includes('appimage')) {
        required.push(`${p}_${version}_${t.appimage}.AppImage`, `${p}_${version}_${t.appimage}.AppImage.sig`)
      }
    }
  }
  return { required: [...new Set(required)], optional: [...new Set(optional)] }
}

/**
 * @param {string[]} present asset names on the release
 * @param {{ required: string[], optional: string[] }} expected
 */
export function compareAssets(present, expected) {
  const have = new Set(present)
  const allowed = new Set([...expected.required, ...expected.optional])
  return {
    missing: expected.required.filter((n) => !have.has(n)),
    unexpected: present.filter((n) => !allowed.has(n)),
  }
}

/**
 * Assets GitHub stored empty, and assets it has not (yet) computed a sha256 digest for.
 * @param {{ name: string, size: number, digest?: string | null }[]} assets
 */
export function assetIntegrity(assets) {
  return {
    empty: assets.filter((a) => !(Number.isSafeInteger(a.size) && a.size > 0)).map((a) => a.name),
    noDigest: assets.filter((a) => !/^sha256:[a-f0-9]{64}$/.test(String(a.digest ?? ''))).map((a) => a.name),
  }
}

/**
 * Decodes a tauri updater signature (base64 of a minisign signature box) and returns the
 * signing key's 8-byte key id as hex, or null when it is not a minisign envelope.
 * @param {string} signature
 * @returns {string | null}
 */
export function signatureKeyId(signature) {
  if (typeof signature !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(signature)) return null
  const text = Buffer.from(signature, 'base64').toString('utf8')
  const lines = text.split('\n')
  if (!lines[0]?.startsWith('untrusted comment:') || !lines[2]?.startsWith('trusted comment: timestamp:')) return null
  const sig = Buffer.from(lines[1] ?? '', 'base64')
  // "Ed" (legacy) or "ED" (prehashed) + 8-byte key id + 64-byte Ed25519 signature
  if (sig.length !== 74 || sig[0] !== 0x45 || (sig[1] !== 0x64 && sig[1] !== 0x44)) return null
  return sig.subarray(2, 10).toString('hex')
}

/**
 * Key id of a tauri updater public key (base64 of a minisign public key box), or null.
 * @param {string | null} pubkey
 */
export function pubkeyKeyId(pubkey) {
  if (typeof pubkey !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(pubkey)) return null
  const lines = Buffer.from(pubkey, 'base64').toString('utf8').split('\n')
  if (!lines[0]?.startsWith('untrusted comment:')) return null
  const key = Buffer.from(lines[1] ?? '', 'base64')
  if (key.length !== 42 || key[0] !== 0x45 || key[1] !== 0x64) return null
  return key.subarray(2, 10).toString('hex')
}

/**
 * Checks the updater manifest against the shipped platform set and the uploaded signatures.
 * @param {{ manifest: any, version: string, targets: string[], downloadBase: string,
 *   naming: ReturnType<typeof appNaming>, sigFiles: Map<string, string> }} input
 *   `downloadBase` is https://github.com/<serving repo>/releases/download/<tag>/;
 *   `sigFiles` maps an uploaded .sig asset's name to its exact content.
 * @returns {{ version: string[], platforms: string[], urls: string[], signatures: string[], envelopes: string[] }}
 *   failures per check (empty = pass)
 */
export function checkManifest({ manifest, version, targets, downloadBase, naming, sigFiles }) {
  const out = { version: [], platforms: [], urls: [], signatures: [], envelopes: [] }
  if (manifest?.version !== version) out.version.push(`manifest says ${JSON.stringify(manifest?.version)}, tag says ${version}`)
  const platforms = manifest?.platforms && typeof manifest.platforms === 'object' ? manifest.platforms : {}
  const have = Object.keys(platforms)
  for (const t of targets) if (!have.includes(t)) out.platforms.push(`${t} missing`)
  for (const p of have) if (!targets.includes(p)) out.platforms.push(`${p} not shipped`)

  const wantKey = pubkeyKeyId(naming.pubkey)
  for (const target of targets) {
    const entry = platforms[target]
    if (!entry) continue
    const asset = updaterAsset(target, naming, version)
    const url = String(entry.url ?? '')
    if (!url.startsWith(downloadBase)) out.urls.push(`${target}: ${url || '(none)'} is not under ${downloadBase}`)
    else if (decodeURIComponent(url.slice(downloadBase.length)) !== asset) out.urls.push(`${target}: points at ${url.slice(downloadBase.length)}, expected ${asset}`)

    const sigFile = sigFiles.get(`${asset}.sig`)
    if (sigFile === undefined) out.signatures.push(`${target}: ${asset}.sig is not on the release`)
    else if (entry.signature !== sigFile) out.signatures.push(`${target}: signature differs from ${asset}.sig`)

    const keyId = signatureKeyId(entry.signature)
    if (!keyId) out.envelopes.push(`${target}: signature is not a minisign envelope`)
    else if (wantKey && keyId !== wantKey) out.envelopes.push(`${target}: signed by key ${keyId.toUpperCase()}, but plugins.updater.pubkey is ${wantKey.toUpperCase()}`)
  }
  return out
}

/**
 * Every verification row, from already-fetched data.
 * @param {{ release: any, channel: string, version: string, expected: { required: string[], optional: string[] },
 *   manifest: any, manifestError?: string, targets: string[], downloadBase: string,
 *   naming: ReturnType<typeof appNaming>, sigFiles: Map<string, string> }} input
 * @returns {{ name: string, ok: boolean, detail: string }[]}
 */
export function buildChecks({ release, channel, version, expected, manifest, manifestError, targets, downloadBase, naming, sigFiles }) {
  const rows = []
  const row = (name, bad, what) => rows.push({ name, ok: bad.length === 0, detail: bad.length ? `${what}: ${list(bad)}` : 'ok' })
  const wantPrerelease = channel !== 'stable'

  row('still a draft', release.draft === true ? [] : ['the release is no longer a draft'], 'state')
  row('prerelease flag matches channel', release.prerelease === wantPrerelease ? [] : [`prerelease=${release.prerelease} on channel ${channel}`], 'state')
  const names = release.assets.map((a) => a.name)
  const { missing, unexpected } = compareAssets(names, expected)
  row('expected assets present', missing, 'missing')
  row('no unexpected assets', unexpected, 'unexpected')
  const { empty, noDigest } = assetIntegrity(release.assets)
  row('no empty assets', empty, 'size 0')
  row('GitHub sha256 digest present', noDigest, 'no digest yet')

  if (manifestError) {
    for (const name of ['manifest version', 'manifest platforms = targets', 'updater URLs', 'signatures match .sig files', 'signatures are minisign, by the app key']) {
      rows.push({ name, ok: false, detail: manifestError })
    }
    return rows
  }
  const m = checkManifest({ manifest, version, targets, downloadBase, naming, sigFiles })
  row('manifest version', m.version, 'mismatch')
  row('manifest platforms = targets', m.platforms, 'mismatch')
  row('updater URLs', m.urls, 'wrong')
  row('signatures match .sig files', m.signatures, 'mismatch')
  row('signatures are minisign, by the app key', m.envelopes, 'bad')
  return rows
}

function list(xs) {
  return xs.slice(0, 10).join(', ') + (xs.length > 10 ? `, … (${xs.length} total)` : '')
}

/**
 * The step summary: a failed run explains itself on its summary page.
 * @param {{ tag: string, releaseUrl: string, assetCount: number | string, platformCount: number | string,
 *   checks: { name: string, ok: boolean, detail: string }[] }} input
 */
export function renderSummary({ tag, releaseUrl, assetCount, platformCount, checks }) {
  const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ')
  const failed = checks.filter((c) => !c.ok).length
  return [
    `## Release verification: ${tag}`,
    '',
    '| | |',
    '| --- | --- |',
    `| Version | \`${tag}\` |`,
    `| Release (draft) | ${releaseUrl} |`,
    `| Assets | ${assetCount} |`,
    `| Updater platforms | ${platformCount} |`,
    `| Result | ${failed ? `**${failed} check(s) failed**` : 'all checks passed'} |`,
    '',
    '| Check | Result | Detail |',
    '| --- | --- | --- |',
    ...checks.map((c) => `| ${cell(c.name)} | ${c.ok ? 'pass' : '**FAIL**'} | ${cell(c.detail)} |`),
    '',
  ].join('\n')
}

/**
 * Entry point for actions/github-script. Reads its inputs from the environment:
 * RELEASE_ID, REL_OWNER, REL_NAME, TAG, CHANNEL, TARGETS, MACOS_BUNDLES, WINDOWS_BUNDLES,
 * LINUX_BUNDLES, SRC_TAURI (the app's src-tauri checkout).
 */
export async function run({ github, core, env, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  const owner = env.REL_OWNER
  const repo = env.REL_NAME
  const releaseId = Number(env.RELEASE_ID)
  const tag = env.TAG
  const version = tag.replace(/^v/, '')
  const channel = env.CHANNEL
  const targets = csv(env.TARGETS)
  const naming = loadAppNaming(env.SRC_TAURI)
  const expected = expectedAssets({
    version,
    channel,
    targets,
    bundles: { macos: csv(env.MACOS_BUNDLES), windows: csv(env.WINDOWS_BUNDLES), linux: csv(env.LINUX_BUNDLES) },
    naming,
  })
  // URLs are built from the tag path, never a draft's browser_download_url (docs/GOTCHAS.md).
  const downloadBase = `https://github.com/${owner}/${repo}/releases/download/${tag}/`

  const download = async (asset) => {
    const { data } = await github.rest.repos.getReleaseAsset({
      owner, repo, asset_id: asset.id, headers: { accept: 'application/octet-stream' },
    })
    return Buffer.from(data).toString('utf8')
  }

  const attempt = async () => {
    const { data: release } = await github.rest.repos.getRelease({ owner, repo, release_id: releaseId })
    const sigFiles = new Map()
    for (const a of release.assets.filter((x) => x.name.endsWith('.sig'))) sigFiles.set(a.name, await download(a))
    let manifest = null
    let manifestError
    const manifestAsset = release.assets.find((a) => a.name === manifestName(channel))
    if (!manifestAsset) manifestError = `${manifestName(channel)} is not on the release`
    else {
      try {
        manifest = JSON.parse(await download(manifestAsset))
      } catch (error) {
        manifestError = `${manifestName(channel)} is not valid JSON: ${error.message}`
      }
    }
    const checks = buildChecks({ release, channel, version, expected, manifest, manifestError, targets, downloadBase, naming, sigFiles })
    return { release, manifest, checks }
  }

  // GitHub fills in `digest` asynchronously after an upload, so a failing result is re-read
  // a few times before it counts; a genuinely broken release fails all eight the same way.
  const ATTEMPTS = 8
  let result
  for (let n = 1; n <= ATTEMPTS; n += 1) {
    result = await attempt()
    const failing = result.checks.filter((c) => !c.ok)
    if (!failing.length) break
    if (n < ATTEMPTS) {
      core.info(`Attempt ${n}/${ATTEMPTS}: ${failing.map((c) => c.name).join('; ')} — re-reading in 5 s`)
      await sleep(5000)
    }
  }

  const { release, manifest, checks } = result
  await core.summary
    .addRaw(renderSummary({
      tag,
      releaseUrl: release.html_url,
      assetCount: release.assets.length,
      platformCount: manifest?.platforms ? Object.keys(manifest.platforms).length : 'unreadable',
      checks,
    }))
    .write()
  core.setOutput('summary_written', 'true')

  const failed = checks.filter((c) => !c.ok)
  if (failed.length) {
    core.setFailed(`Release ${tag} on ${owner}/${repo} failed verification:\n  - ${failed.map((c) => `${c.name}: ${c.detail}`).join('\n  - ')}\nPresent: ${release.assets.map((a) => a.name).join(', ')}`)
    return
  }
  core.info(`Verified ${release.assets.length} assets and ${targets.length} updater platforms on ${owner}/${repo} ${tag}.`)
}
