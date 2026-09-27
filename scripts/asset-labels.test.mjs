import assert from 'node:assert/strict'
import test from 'node:test'

import { assetLabel } from './asset-labels.mjs'

test('installers are labelled by OS, architecture and kind', () => {
  assert.equal(assetLabel('MyApp_1.2.3_aarch64.dmg'), 'macOS (Apple Silicon) · disk image')
  assert.equal(assetLabel('MyApp_1.2.3_x64.app.tar.gz'), 'macOS (Intel) · app (update archive)')
  assert.equal(assetLabel('MyApp_1.2.3_arm64-setup.exe'), 'Windows (ARM64) · installer')
  assert.equal(assetLabel('myapp_1.2.3_amd64.deb'), 'Linux (x64) · Debian / Ubuntu package')
  assert.equal(assetLabel('myapp-1.2.3-1.x86_64.rpm'), 'Linux (x64) · Fedora / openSUSE package')
  assert.equal(assetLabel('myapp_1.2.3_aarch64.AppImage'), 'Linux (ARM64) · AppImage')
})

test('signatures and bundles read as part of the file they sign', () => {
  assert.equal(assetLabel('MyApp_1.2.3_x64-setup.exe.sig'), 'Windows (x64) · installer · updater signature')
  assert.equal(assetLabel('myapp_1.2.3_amd64.AppImage.sigstore.json'), 'Linux (x64) · AppImage · Sigstore bundle')
})

test('release-wide files get plain names; unknown files keep theirs', () => {
  assert.equal(assetLabel('SHA256SUMS'), 'Checksums (SHA-256)')
  assert.equal(assetLabel('SHA256SUMS.asc'), 'Checksums (SHA-256) · GPG signature')
  assert.equal(assetLabel('ABCDEF.asc'), 'GPG public key')
  assert.equal(assetLabel('latest-beta.json'), 'Update manifest')
  assert.equal(assetLabel('notes.txt'), null)
})
