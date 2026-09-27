import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  appNaming,
  assetIntegrity,
  buildChecks,
  cargoPackageName,
  checkManifest,
  checkSums,
  checksumAssets,
  repairPlan,
  compareAssets,
  expectedAssets,
  installerEntries,
  loadAppNaming,
  manifestName,
  pubkeyKeyId,
  renderSummary,
  run,
  safeName,
  uploadName,
  signatureKeyId,
  updaterAsset,
  wixLanguages,
} from './verify-release.mjs'

// Real output of `tauri signer generate` / `tauri signer sign` (@tauri-apps/cli 2.9.6):
// PUBKEY is key 1F96F7D3AB3DD801, SIG was made with it, OTHER_PUBKEY is an unrelated key.
const PUBKEY = 'dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDFGOTZGN0QzQUIzREQ4MDEKUldRQjJEMnIwL2VXSHpPMytCemFZK3JRcktLc1UrOFB3RzFTVCtLTVIwRHpPcGpyL3Fjb25MMGkK'
const OTHER_PUBKEY = 'dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEI3QzExODU3MUFDRjY0MEEKUldRS1pNOGFWeGpCdCttaG5GcitOcUtqejBhVG5aa21PMkNrY0dRejBpYVdBUDA5bGJKeFRJL1oK'
const SIG = 'dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVRQjJEMnIwL2VXSHpYNzlFNHV0MTUyS3JWUSthYmU4dTdpMTVuTTA4MkxnSFZRcXVLSDliVTJDbE1uWS9JNHV5bjlneFN0T1dJSHZ6OEprYXhEdU9jc0lrNGF4a2dPT0FrPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkwNDM2NjIxCWZpbGU6Zi50eHQKaElad1pvbFRNNXJSRno5VTBvS0c2cDJHcmZCTCs1b3A3QzVjWGczUm9BSCtPZytQdXRqSnIrbmxKeTNoZ1ZjNzQzbmcrandjRjhZdEtlYktCRHdhQkE9PQo='

const ALL = ['darwin-aarch64', 'darwin-x86_64', 'windows-x86_64', 'windows-aarch64', 'linux-x86_64', 'linux-aarch64']
const naming = appNaming({ base: { productName: 'MyApp', plugins: { updater: { pubkey: PUBKEY } } }, overlays: {}, cargoName: 'myapp' })
const DEFAULT_BUNDLES = { macos: ['app', 'dmg'], windows: ['nsis'], linux: ['deb', 'rpm', 'appimage'] }
const BASE = 'https://github.com/org/myapp-releases/releases/download/v1.2.3/'

test('safeName keeps only characters GitHub stores unchanged', () => {
  assert.equal(safeName('My App'), 'My.App')
  assert.equal(safeName('A (beta)'), 'A.beta.')
  assert.equal(safeName('my-app_2'), 'my-app_2')
})

test('uploadName prefers the label tauri-action records', () => {
  assert.equal(uploadName({ name: 'My.App_1.0.0_x64.dmg', label: 'My App_1.0.0_x64.dmg' }), 'My App_1.0.0_x64.dmg')
  assert.equal(uploadName({ name: 'latest.json', label: '' }), 'latest.json')
  assert.equal(uploadName({ name: 'SHA256SUMS', label: null }), 'SHA256SUMS')
})

test('cargoPackageName reads only the [package] table', () => {
  assert.equal(cargoPackageName('[workspace]\nname = "nope"\n[package]\nname = "app"\nversion = "1"\n'), 'app')
  assert.equal(cargoPackageName('[dependencies]\nname = "x"\n'), null)
})

test('wixLanguages accepts every tauri shape', () => {
  assert.deepEqual(wixLanguages(undefined), ['en-US'])
  assert.deepEqual(wixLanguages('de-DE'), ['de-DE'])
  assert.deepEqual(wixLanguages(['en-US', 'fr-FR']), ['en-US', 'fr-FR'])
  assert.deepEqual(wixLanguages({ 'en-US': null, 'pt-BR': { localePath: 'x' } }), ['en-US', 'pt-BR'])
})

test('appNaming: overlay wins, cargo name is the fallback, the SBOM name is file-safe', () => {
  const n = appNaming({
    base: { bundle: { linux: { rpm: { release: '3' } } } },
    overlays: { windows: { productName: 'My App', bundle: { windows: { wix: { language: ['de-DE'] } } } } },
    cargoName: 'my-app',
  })
  assert.equal(n.darwin.product, 'my-app')
  assert.equal(n.windows.product, 'My App')
  assert.equal(n.product, 'my-app')
  assert.deepEqual(n.windows.wixLanguages, ['de-DE'])
  assert.equal(n.linux.rpmRelease, '3')
  assert.equal(n.pubkey, null)
  assert.throws(() => appNaming({ base: {}, overlays: {}, cargoName: null }), /productName/)
})

test('loadAppNaming reads src-tauri from disk and tolerates missing overlays', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rk-naming-'))
  writeFileSync(join(dir, 'tauri.conf.json'), JSON.stringify({ productName: 'Base', plugins: { updater: { pubkey: PUBKEY } } }))
  writeFileSync(join(dir, 'tauri.linux.conf.json'), JSON.stringify({ productName: 'base-linux' }))
  writeFileSync(join(dir, 'Cargo.toml'), '[package]\nname = "base"\n')
  const n = loadAppNaming(dir)
  assert.equal(n.darwin.product, 'Base')
  assert.equal(n.linux.product, 'base-linux')
  assert.equal(n.pubkey, PUBKEY)
  writeFileSync(join(dir, 'tauri.windows.conf.json'), '{ nope')
  assert.throws(() => loadAppNaming(dir), /not valid JSON/)
})

test('manifestName and updaterAsset', () => {
  assert.equal(manifestName('stable'), 'latest.json')
  assert.equal(manifestName('beta'), 'latest-beta.json')
  assert.equal(updaterAsset('darwin-x86_64', naming, '1.2.3'), 'MyApp_1.2.3_x64.app.tar.gz')
  assert.equal(updaterAsset('windows-aarch64', naming, '1.2.3'), 'MyApp_1.2.3_arm64-setup.exe')
  assert.equal(updaterAsset('linux-aarch64', naming, '1.2.3'), 'MyApp_1.2.3_aarch64.AppImage')
})

test('expectedAssets: default bundles, all six targets', () => {
  const { required, optional } = expectedAssets({ version: '1.2.3', channel: 'stable', targets: ALL, bundles: DEFAULT_BUNDLES, naming })
  assert.deepEqual(required.sort(), [
    'MyApp-1.2.3-1.aarch64.rpm',
    'MyApp-1.2.3-1.x86_64.rpm',
    'MyApp_1.2.3_aarch64.AppImage',
    'MyApp_1.2.3_aarch64.AppImage.sig',
    'MyApp_1.2.3_aarch64.app.tar.gz',
    'MyApp_1.2.3_aarch64.app.tar.gz.sig',
    'MyApp_1.2.3_aarch64.dmg',
    'MyApp_1.2.3_amd64.AppImage',
    'MyApp_1.2.3_amd64.AppImage.sig',
    'MyApp_1.2.3_amd64.deb',
    'MyApp_1.2.3_arm64-setup.exe',
    'MyApp_1.2.3_arm64-setup.exe.sig',
    'MyApp_1.2.3_arm64.deb',
    'MyApp_1.2.3_x64-setup.exe',
    'MyApp_1.2.3_x64-setup.exe.sig',
    'MyApp_1.2.3_x64.app.tar.gz',
    'MyApp_1.2.3_x64.app.tar.gz.sig',
    'MyApp_1.2.3_x64.dmg',
    'latest.json',
  ])
  assert.deepEqual(optional.sort(), [
    'MyApp-1.2.3-1.aarch64.rpm.sig',
    'MyApp-1.2.3-1.x86_64.rpm.sig',
    'MyApp_1.2.3_amd64.deb.sig',
    'MyApp_1.2.3_arm64.deb.sig',
  ])
})

test('expectedAssets: msi per WiX language on x64 only, prerelease manifest, extras', () => {
  const n = { ...naming, windows: { product: 'MyApp', wixLanguages: ['en-US', 'de-DE'] } }
  const { required } = expectedAssets({
    version: '1.2.3-beta.1',
    channel: 'beta',
    targets: ['windows-x86_64', 'windows-aarch64'],
    bundles: { macos: [], windows: ['nsis', 'msi'], linux: [] },
    naming: n,
    extra: ['SHA256SUMS'],
  })
  assert.ok(required.includes('latest-beta.json'))
  assert.ok(required.includes('SHA256SUMS'))
  assert.ok(required.includes('MyApp_1.2.3-beta.1_x64_en-US.msi'))
  assert.ok(required.includes('MyApp_1.2.3-beta.1_x64_de-DE.msi.sig'))
  assert.ok(!required.some((r) => r.includes('arm64_') && r.includes('.msi')))
  assert.throws(() => expectedAssets({ version: '1', channel: 'stable', targets: ['plan9-x86'], bundles: DEFAULT_BUNDLES, naming }), /Unknown target/)
})

test('compareAssets reports missing and unexpected, not optional', () => {
  const expected = { required: ['a', 'b'], optional: ['a.sig'] }
  assert.deepEqual(compareAssets(['a', 'a.sig', 'MyApp_1.2.3_x64-setup.nsis.zip'], expected), {
    missing: ['b'],
    unexpected: ['MyApp_1.2.3_x64-setup.nsis.zip'],
  })
})

test('assetIntegrity flags empty assets and missing digests', () => {
  const good = { name: 'ok', size: 5, digest: `sha256:${'a'.repeat(64)}` }
  const r = assetIntegrity([good, { name: 'empty', size: 0, digest: good.digest }, { name: 'pending', size: 5, digest: null }, { name: 'upper', size: 5, digest: `sha256:${'A'.repeat(64)}` }])
  assert.deepEqual(r, { empty: ['empty'], noDigest: ['pending', 'upper'] })
})

test('minisign key ids from real tauri output', () => {
  assert.equal(pubkeyKeyId(PUBKEY), '1F96F7D3AB3DD801') // as in the pubkey's own comment line
  assert.equal(signatureKeyId(SIG), pubkeyKeyId(PUBKEY))
  assert.notEqual(pubkeyKeyId(OTHER_PUBKEY), pubkeyKeyId(PUBKEY))
  assert.equal(signatureKeyId('not base64!'), null)
  assert.equal(signatureKeyId(Buffer.from('untrusted comment: x\nAAAA\n').toString('base64')), null)
  assert.equal(signatureKeyId(PUBKEY), null)
  assert.equal(pubkeyKeyId('/path/to/key.pub'), null)
})

function goodManifest(targets = ALL) {
  return {
    version: '1.2.3',
    platforms: Object.fromEntries(targets.map((t) => [t, { url: BASE + updaterAsset(t, naming, '1.2.3'), signature: SIG }])),
  }
}
function goodSigs(targets = ALL) {
  return new Map(targets.map((t) => [`${updaterAsset(t, naming, '1.2.3')}.sig`, SIG]))
}

test('checkManifest passes a correct manifest', () => {
  const r = checkManifest({ manifest: goodManifest(), version: '1.2.3', targets: ALL, downloadBase: BASE, naming, sigFiles: goodSigs(), stored: new Map() })
  assert.deepEqual(r, { version: [], platforms: [], urls: [], signatures: [], envelopes: [] })
})

test('checkManifest catches wrong repo, wrong asset, stale sig, foreign key, platform drift', () => {
  const manifest = goodManifest(['darwin-aarch64', 'windows-x86_64', 'linux-x86_64'])
  manifest.version = '1.2.2'
  manifest.platforms['darwin-aarch64'].url = 'https://github.com/org/private-app/releases/download/v1.2.3/MyApp_1.2.3_aarch64.app.tar.gz'
  manifest.platforms['windows-x86_64'].url = `${BASE}MyApp_1.2.3_x64_en-US.msi`
  const sigs = goodSigs()
  sigs.set('MyApp_1.2.3_amd64.AppImage.sig', `${SIG}\n`)
  const foreign = appNaming({ base: { productName: 'MyApp', plugins: { updater: { pubkey: OTHER_PUBKEY } } }, overlays: {}, cargoName: null })
  const r = checkManifest({ manifest, version: '1.2.3', targets: ['darwin-aarch64', 'windows-x86_64', 'linux-x86_64', 'linux-aarch64'], downloadBase: BASE, naming: foreign, sigFiles: sigs, stored: new Map() })
  assert.equal(r.version.length, 1)
  assert.deepEqual(r.platforms, ['linux-aarch64 missing'])
  assert.equal(r.urls.length, 2)
  assert.match(r.urls[0], /private-app/)
  assert.match(r.urls[1], /expected MyApp_1.2.3_x64-setup.exe/)
  assert.deepEqual(r.signatures, ['linux-x86_64: signature differs from MyApp_1.2.3_amd64.AppImage.sig'])
  assert.equal(r.envelopes.length, 3)
  assert.match(r.envelopes[0], /signed by key 1F96F7D3AB3DD801, but plugins.updater.pubkey is B7C118571ACF640A/)
})

test('checkManifest: missing .sig asset, non-minisign signature, extra platform', () => {
  const manifest = goodManifest(['linux-x86_64', 'darwin-aarch64'])
  manifest.platforms['linux-x86_64'].signature = Buffer.from('hello').toString('base64')
  const r = checkManifest({ manifest, version: '1.2.3', targets: ['linux-x86_64'], downloadBase: BASE, naming, sigFiles: new Map(), stored: new Map() })
  assert.deepEqual(r.platforms, ['darwin-aarch64 not shipped'])
  assert.deepEqual(r.signatures, ['linux-x86_64: MyApp_1.2.3_amd64.AppImage.sig is not on the release'])
  assert.deepEqual(r.envelopes, ['linux-x86_64: signature is not a minisign envelope'])
})

test('installerEntries names the .deb and .rpm a Linux target updates from', () => {
  assert.deepEqual(installerEntries('linux-x86_64', naming, '1.2.3'), [
    { key: 'linux-x86_64-deb', asset: 'MyApp_1.2.3_amd64.deb' },
    { key: 'linux-x86_64-rpm', asset: 'MyApp-1.2.3-1.x86_64.rpm' },
  ])
  assert.deepEqual(installerEntries('linux-aarch64', naming, '1.2.3').map((e) => e.asset), ['MyApp_1.2.3_arm64.deb', 'MyApp-1.2.3-1.aarch64.rpm'])
  assert.deepEqual(installerEntries('darwin-aarch64', naming, '1.2.3'), [])
})

test('checkManifest requires an installer entry for every signed package, and only those', () => {
  const targets = ['linux-x86_64']
  const manifest = goodManifest(targets)
  const sigs = goodSigs(targets)
  sigs.set('MyApp_1.2.3_amd64.deb.sig', SIG)
  sigs.set('MyApp-1.2.3-1.x86_64.rpm.sig', SIG)
  manifest.platforms['linux-x86_64-deb'] = { url: `${BASE}MyApp_1.2.3_amd64.deb`, signature: SIG }
  manifest.platforms['linux-x86_64-rpm'] = { url: `${BASE}MyApp-1.2.3-1.x86_64.rpm`, signature: SIG }
  const ok = checkManifest({ manifest, version: '1.2.3', targets, downloadBase: BASE, naming, sigFiles: sigs, stored: new Map() })
  assert.deepEqual(ok, { version: [], platforms: [], urls: [], signatures: [], envelopes: [] })

  // A signed .deb the manifest forgot, and an .rpm entry pointing at the AppImage.
  delete manifest.platforms['linux-x86_64-deb']
  manifest.platforms['linux-x86_64-rpm'].url = `${BASE}MyApp_1.2.3_amd64.AppImage`
  const bad = checkManifest({ manifest, version: '1.2.3', targets, downloadBase: BASE, naming, sigFiles: sigs, stored: new Map() })
  assert.deepEqual(bad.platforms, ['linux-x86_64-deb missing'])
  assert.deepEqual(bad.urls, ['linux-x86_64-rpm: points at MyApp_1.2.3_amd64.AppImage, expected MyApp-1.2.3-1.x86_64.rpm'])

  // An installer entry for a package without an updater signature on the release.
  const unsigned = checkManifest({ manifest: goodManifest(targets), version: '1.2.3', targets, downloadBase: BASE, naming, sigFiles: goodSigs(targets), stored: new Map() })
  assert.deepEqual(unsigned.platforms, [])
  const extra = goodManifest(targets)
  extra.platforms['linux-x86_64-rpm'] = { url: `${BASE}MyApp-1.2.3-1.x86_64.rpm`, signature: SIG }
  const r = checkManifest({ manifest: extra, version: '1.2.3', targets, downloadBase: BASE, naming, sigFiles: goodSigs(targets), stored: new Map() })
  assert.deepEqual(r.platforms, ['linux-x86_64-rpm not shipped'])
})

const ZERO = '0'.repeat(64)
function sumsFor(names) {
  return names.filter((n) => n !== 'SHA256SUMS' && !n.endsWith('.asc')).map((n) => `${ZERO}  ${n}`).join('\n') + '\n'
}

function releaseFor(names, extra = {}) {
  return {
    draft: true,
    prerelease: false,
    html_url: 'https://github.com/org/myapp-releases/releases/tag/untagged-1',
    assets: names.map((name, i) => ({ id: i, name, size: 10, digest: `sha256:${'0'.repeat(64)}` })),
    ...extra,
  }
}

test('buildChecks: a complete release passes every row', () => {
  const targets = ['linux-x86_64']
  const bundles = { macos: [], windows: [], linux: ['appimage'] }
  const expected = expectedAssets({ version: '1.2.3', channel: 'stable', targets, bundles, naming })
  const rows = buildChecks({
    release: releaseFor(expected.required), channel: 'stable', version: '1.2.3', expected,
    manifest: goodManifest(targets), targets, downloadBase: BASE, naming, sigFiles: goodSigs(targets),
    sums: sumsFor(expected.required),
  })
  assert.ok(rows.every((r) => r.ok), JSON.stringify(rows.filter((r) => !r.ok)))
  assert.equal(rows.length, 12)
})

test('buildChecks: published, wrong prerelease flag, unreadable manifest', () => {
  const targets = ['linux-x86_64']
  const expected = expectedAssets({ version: '1.2.3', channel: 'beta', targets, bundles: DEFAULT_BUNDLES, naming })
  const rows = buildChecks({
    release: releaseFor(expected.required, { draft: false }), channel: 'beta', version: '1.2.3', expected,
    manifest: null, manifestError: 'latest-beta.json is not valid JSON', targets, downloadBase: BASE, naming, sigFiles: new Map(), sums: null,
  })
  const failed = rows.filter((r) => !r.ok).map((r) => r.name)
  assert.deepEqual(failed, [
    'still a draft',
    'prerelease flag matches channel',
    'digests match SHA256SUMS',
    'manifest version',
    'manifest platforms = targets',
    'updater URLs',
    'signatures match .sig files',
    'signatures are minisign, by the app key',
  ])
})

test('renderSummary escapes table cells and counts failures', () => {
  const md = renderSummary({
    tag: 'v1.2.3', releaseUrl: 'https://x', assetCount: 3, platformCount: 1,
    checks: [{ name: 'a', ok: true, detail: 'ok' }, { name: 'b', ok: false, detail: 'x | y\nz' }],
  })
  assert.match(md, /\*\*1 check\(s\) failed\*\*/)
  assert.match(md, /\| b \| \*\*FAIL\*\* \| x \\\| y z \|/)
})

function fakeCore() {
  const out = { outputs: {}, failed: null, summary: '', info: [] }
  const summary = { addRaw: (s) => { out.summary += s; return summary }, write: async () => summary }
  return { out, core: { info: (m) => out.info.push(m), setOutput: (k, v) => { out.outputs[k] = v }, setFailed: (m) => { out.failed = m }, summary } }
}

function fakeGithub(release, contents) {
  const calls = []
  return {
    calls,
    rest: {
      repos: {
        getRelease: async (args) => { calls.push(['getRelease', args]); return { data: release() } },
        getReleaseAsset: async (args) => {
          calls.push(['getReleaseAsset', args])
          assert.equal(args.headers.accept, 'application/octet-stream')
          return { data: new TextEncoder().encode(contents.get(args.asset_id)).buffer }
        },
      },
    },
  }
}

function runFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'rk-run-'))
  writeFileSync(join(dir, 'tauri.conf.json'), JSON.stringify({ productName: 'MyApp', plugins: { updater: { pubkey: PUBKEY } } }))
  const targets = ['linux-x86_64']
  const names = ['latest.json', 'MyApp_1.2.3_amd64.AppImage', 'MyApp_1.2.3_amd64.AppImage.sig', 'MyApp_1.2.3.spdx.json', 'MyApp_1.2.3.cdx.json', 'SHA256SUMS', 'provenance.json']
  const contents = new Map([[0, JSON.stringify(goodManifest(targets))], [2, SIG], [5, sumsFor(names)]])
  const env = {
    RELEASE_ID: '7', REL_OWNER: 'org', REL_NAME: 'myapp-releases', TAG: 'v1.2.3', CHANNEL: 'stable',
    TARGETS: 'linux-x86_64', MACOS_BUNDLES: '', WINDOWS_BUNDLES: '', LINUX_BUNDLES: 'appimage', SRC_TAURI: dir, SUMS_SIGNED: 'false',
  }
  return { names, contents, env }
}

test('run: verifies through the Octokit client and writes the summary', async () => {
  const { names, contents, env } = runFixture()
  const github = fakeGithub(() => releaseFor(names), contents)
  const { core, out } = fakeCore()
  await run({ github, core, env, sleep: async () => {} })
  assert.equal(out.failed, null)
  assert.equal(out.outputs.summary_written, 'true')
  assert.match(out.summary, /all checks passed/)
  assert.deepEqual(github.calls[0], ['getRelease', { owner: 'org', repo: 'myapp-releases', release_id: 7 }])
})

test('run: re-reads eight times, then fails with every broken check in the summary', async () => {
  const { names, contents, env } = runFixture()
  let reads = 0
  const github = fakeGithub(() => { reads += 1; return releaseFor(names.filter((n) => !n.endsWith('.sig'))) }, contents)
  const { core, out } = fakeCore()
  await run({ github, core, env, sleep: async () => {} })
  assert.equal(reads, 8)
  assert.match(out.failed, /expected assets present: missing: MyApp_1.2.3_amd64.AppImage.sig/)
  assert.match(out.failed, /signatures match .sig files/)
  assert.match(out.summary, /\*\*FAIL\*\*/)
})

test('checksumAssets adds the signature and public key only when signed', () => {
  assert.deepEqual(checksumAssets({ product: 'MyApp', version: '1.2.3' }), ['SHA256SUMS', 'provenance.json', 'MyApp_1.2.3.spdx.json', 'MyApp_1.2.3.cdx.json'])
  const present = ['SHA256SUMS', 'SHA256SUMS.asc', 'ABCD.asc', 'MyApp_1.2.3_amd64.AppImage']
  assert.deepEqual(checksumAssets({ product: 'MyApp', version: '1.2.3', signed: true, present }).slice(4), ['SHA256SUMS.asc', 'ABCD.asc'])
})

test('checksumAssets: a signed release needs exactly one public key beside SHA256SUMS.asc', () => {
  for (const present of [['SHA256SUMS.asc'], ['SHA256SUMS.asc', 'A.asc', 'B.asc']]) {
    assert.deepEqual(checksumAssets({ product: 'MyApp', version: '1.2.3', signed: true, present }).slice(4), ['SHA256SUMS.asc', '<KEY_ID>.asc'])
  }
})

test('run: a signed release verifies without being told the key id', async () => {
  // LINUX_GPG_KEY_ID as a secret makes the runner drop a key_id job output, so verify must
  // not depend on one: an empty id used to leave both .asc files unexpected.
  const { names, contents, env } = runFixture()
  const signed = [...names, 'SHA256SUMS.asc', '0123456789ABCDEF.asc']
  const github = fakeGithub(() => releaseFor(signed), contents)
  const { core, out } = fakeCore()
  await run({ github, core, env: { ...env, SUMS_SIGNED: 'true' }, sleep: async () => {} })
  assert.equal(out.failed, null, out.failed)
})

test('checkSums: unlisted asset, listed-but-absent file, digest drift; .asc and SUMS exempt', () => {
  const d = (c) => `sha256:${c.repeat(64)}`
  const assets = [
    { name: 'a.dmg', digest: d('1') },
    { name: 'b.exe', digest: d('2') },
    { name: 'c.deb', digest: d('3') },
    { name: 'SHA256SUMS', digest: d('4') },
    { name: 'SHA256SUMS.asc', digest: d('5') },
    { name: 'KEY.asc', digest: d('6') },
  ]
  const text = `${'1'.repeat(64)}  a.dmg\n${'9'.repeat(64)} *b.exe\n${'7'.repeat(64)}  gone.rpm\n`
  assert.deepEqual(checkSums(text, assets), [
    `b.exe (${d('2')} ≠ sha256:${'9'.repeat(64)})`,
    'gone.rpm (listed, not on the release)',
    'c.deb (not in SHA256SUMS)',
  ])
})

test('CLI prints the SBOM product name', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rk-cli-'))
  writeFileSync(join(dir, 'tauri.conf.json'), JSON.stringify({ productName: 'My App' }))
  writeFileSync(join(dir, 'tauri.macos.conf.json'), JSON.stringify({ productName: 'Mac Only' }))
  const script = new URL('./verify-release.mjs', import.meta.url).pathname
  assert.equal(execFileSync(process.execPath, [script, 'product', dir], { encoding: 'utf8' }), 'My.App\n') // file-safe
  assert.throws(() => execFileSync(process.execPath, [script], { stdio: 'pipe' }))
})

test('CLI updater-key: match, mismatch, no inline pubkey, not a signature', () => {
  const script = new URL('./verify-release.mjs', import.meta.url).pathname
  const dir = mkdtempSync(join(tmpdir(), 'rk-key-'))
  const sig = join(dir, 'f.sig')
  writeFileSync(sig, SIG)
  const call = (pubkey, file = sig) => {
    writeFileSync(join(dir, 'tauri.conf.json'), JSON.stringify({ productName: 'A', plugins: { updater: { pubkey } } }))
    const r = spawnSync(process.execPath, [script, 'updater-key', file, dir], { encoding: 'utf8' })
    return { code: r.status, out: r.stdout }
  }
  assert.equal(call(PUBKEY).code, 0)
  const bad = call(OTHER_PUBKEY)
  assert.equal(bad.code, 1)
  assert.match(bad.out, /signed with key 1F96F7D3AB3DD801; plugins.updater.pubkey is key/)
  assert.equal(call('./keys/updater.pub').code, 3)
  writeFileSync(join(dir, 'junk.sig'), 'nope')
  assert.equal(call(PUBKEY, join(dir, 'junk.sig')).code, 1)
})

test('buildChecks: a product name with a space, stored renamed by GitHub, labelled by tauri-action', () => {
  const spaced = appNaming({ base: { productName: 'My App', plugins: { updater: { pubkey: PUBKEY } } }, overlays: {}, cargoName: null })
  const targets = ['linux-x86_64']
  const expected = expectedAssets({ version: '1.2.3', channel: 'stable', targets, bundles: { macos: [], windows: [], linux: ['appimage'] }, naming: spaced })
  assert.deepEqual(expected.required, ['latest.json', 'My App_1.2.3_amd64.AppImage', 'My App_1.2.3_amd64.AppImage.sig'])
  const digest = `sha256:${ZERO}`
  const release = {
    draft: true, prerelease: false,
    assets: [
      { id: 0, name: 'latest.json', label: '', size: 1, digest },
      { id: 1, name: 'My.App_1.2.3_amd64.AppImage', label: 'My App_1.2.3_amd64.AppImage', size: 1, digest },
      { id: 2, name: 'My.App_1.2.3_amd64.AppImage.sig', label: 'My App_1.2.3_amd64.AppImage.sig', size: 1, digest },
    ],
  }
  const manifest = { version: '1.2.3', platforms: { 'linux-x86_64': { url: `${BASE}My.App_1.2.3_amd64.AppImage`, signature: SIG } } }
  const sums = `${ZERO}  My.App_1.2.3_amd64.AppImage\n${ZERO}  My.App_1.2.3_amd64.AppImage.sig\n${ZERO}  latest.json\n`
  const rows = buildChecks({
    release, channel: 'stable', version: '1.2.3', expected, manifest, targets, downloadBase: BASE, naming: spaced,
    sigFiles: new Map([['My.App_1.2.3_amd64.AppImage.sig', SIG]]), sums,
  })
  assert.ok(rows.every((r) => r.ok), JSON.stringify(rows.filter((r) => !r.ok)))
  // Pointing the manifest at the un-renamed name (a 404) is caught.
  manifest.platforms['linux-x86_64'].url = `${BASE}My%20App_1.2.3_amd64.AppImage`
  const bad = buildChecks({
    release, channel: 'stable', version: '1.2.3', expected, manifest, targets, downloadBase: BASE, naming: spaced,
    sigFiles: new Map([['My.App_1.2.3_amd64.AppImage.sig', SIG]]), sums,
  })
  assert.deepEqual(bad.filter((r) => !r.ok).map((r) => r.name), ['updater URLs'])
})

test('cosign: a Sigstore bundle is expected beside each AppImage and SHA256SUMS, and is exempt from the sums', () => {
  assert.deepEqual(
    checksumAssets({ product: 'MyApp', version: '1.2.3', cosign: true }),
    ['SHA256SUMS', 'provenance.json', 'MyApp_1.2.3.spdx.json', 'MyApp_1.2.3.cdx.json', 'SHA256SUMS.sigstore.json'],
  )
  const { required } = expectedAssets({
    version: '1.2.3', channel: 'stable', targets: ['linux-x86_64'],
    bundles: { macos: [], windows: [], linux: ['appimage'] }, naming, cosign: true,
  })
  assert.ok(required.includes('MyApp_1.2.3_amd64.AppImage.sigstore.json'))
  const text = `${'a'.repeat(64)}  MyApp_1.2.3_amd64.AppImage\n`
  const assets = [
    { name: 'MyApp_1.2.3_amd64.AppImage', digest: `sha256:${'a'.repeat(64)}` },
    { name: 'MyApp_1.2.3_amd64.AppImage.sigstore.json', digest: `sha256:${'b'.repeat(64)}` },
  ]
  assert.deepEqual(checkSums(text, assets), [])
})

test('repairPlan: the legs whose own assets are missing, never for release-wide files', () => {
  const bundles = { macos: ['app', 'dmg'], windows: ['nsis'], linux: ['appimage'] }
  const targets = ['darwin-aarch64', 'windows-x86_64', 'linux-x86_64']
  const missing = ['MyApp_1.2.3_aarch64.dmg', 'MyApp_1.2.3_amd64.AppImage.sig', 'SHA256SUMS', 'latest.json']
  assert.deepEqual(
    repairPlan({ missing, version: '1.2.3', channel: 'stable', targets, bundles, naming }),
    ['darwin-aarch64', 'linux-x86_64'],
  )
  assert.deepEqual(repairPlan({ missing: ['SHA256SUMS'], version: '1.2.3', channel: 'stable', targets, bundles, naming }), [])
})
