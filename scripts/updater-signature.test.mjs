import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import test from 'node:test'

import { verifyUpdaterSignature } from './updater-signature.mjs'

const b64 = (bytes) => Buffer.from(bytes).toString('base64')

/** A minisign key pair in tauri's storage format (base64 of the boxes), signing like `tauri signer sign`. */
function keyPair(keyId = Buffer.from('0123456789abcdef', 'hex')) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)
  const pubkey = b64(`untrusted comment: minisign public key\n${b64(Buffer.concat([Buffer.from('Ed'), keyId, raw]))}\n`)
  /** @param {Buffer} data @param {{ alg?: string, comment?: string }} [options] */
  const signFile = (data, { alg = 'ED', comment = 'timestamp:1760000000\tfile:app.AppImage\tversion:1.2.3' } = {}) => {
    const message = alg === 'ED' ? createHash('blake2b512').update(data).digest() : data
    const sig = sign(null, message, privateKey)
    const globalSig = sign(null, Buffer.concat([sig, Buffer.from(comment)]), privateKey)
    const box = Buffer.concat([Buffer.from(alg), keyId, sig])
    return b64(`untrusted comment: signature from tauri secret key\n${b64(box)}\ntrusted comment: ${comment}\n${b64(globalSig)}\n`)
  }
  return { pubkey, signFile }
}

const data = Buffer.from('the repacked AppImage')

test('a signature over the shipped bytes verifies (prehashed and legacy)', () => {
  const { pubkey, signFile } = keyPair()
  assert.deepEqual(verifyUpdaterSignature({ data, signature: signFile(data), pubkey }), { ok: true })
  assert.deepEqual(verifyUpdaterSignature({ data, signature: signFile(data, { alg: 'Ed' }), pubkey }), { ok: true })
})

test('a signature of the file before it was rewritten fails', () => {
  const { pubkey, signFile } = keyPair()
  const result = verifyUpdaterSignature({ data, signature: signFile(Buffer.from('the tauri-built AppImage')), pubkey })
  assert.equal(result.ok, false)
  assert.match(result.reason, /does not cover this file/)
})

test('a signature by another key fails, even with a forged key id', () => {
  const app = keyPair()
  const other = keyPair(Buffer.from('fedcba9876543210', 'hex'))
  assert.match(verifyUpdaterSignature({ data, signature: other.signFile(data), pubkey: app.pubkey }).reason, /different key/)
  const sameId = keyPair()
  assert.match(verifyUpdaterSignature({ data, signature: sameId.signFile(data), pubkey: app.pubkey }).reason, /does not cover/)
})

test('an altered trusted comment fails', () => {
  const { pubkey, signFile } = keyPair()
  const lines = Buffer.from(signFile(data), 'base64').toString('utf8').split('\n')
  lines[2] = 'trusted comment: timestamp:1\tfile:other.AppImage'
  const result = verifyUpdaterSignature({ data, signature: b64(lines.join('\n')), pubkey })
  assert.match(result.reason, /trusted comment was altered/)
})

test('malformed inputs are reported, not thrown', () => {
  const { pubkey, signFile } = keyPair()
  assert.match(verifyUpdaterSignature({ data, signature: 'not a signature', pubkey }).reason, /not a minisign signature box/)
  assert.match(verifyUpdaterSignature({ data, signature: signFile(data), pubkey: b64('nope') }).reason, /not a minisign Ed25519 key/)
})

test('a version binds: the trusted comment must name exactly that version', () => {
  const { pubkey, signFile } = keyPair()
  assert.deepEqual(verifyUpdaterSignature({ data, signature: signFile(data), pubkey, version: '1.2.3' }), { ok: true })
  assert.match(verifyUpdaterSignature({ data, signature: signFile(data), pubkey, version: '1.2.4' }).reason, /bound to version 1\.2\.3, not 1\.2\.4/)
  const unbound = signFile(data, { comment: 'timestamp:1760000000\tfile:app.AppImage' })
  assert.match(verifyUpdaterSignature({ data, signature: unbound, pubkey, version: '1.2.3' }).reason, /bound to no version/)
})
