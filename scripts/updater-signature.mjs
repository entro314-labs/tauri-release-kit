/**
 * Verifies a tauri updater signature over a file, the way the installed app's updater will.
 *
 *   node updater-signature.mjs <file> <file.sig> <src-tauri dir> [<version>]
 *
 * The public key is the app's own `plugins.updater.pubkey` (tauri.conf.json, read like
 * verify-release.mjs does). verify-release.mjs only proves a signature was made by that key; it
 * cannot tell whether it covers the bytes that ship. That matters as soon as a file is rewritten
 * after `tauri build` signed it (the `appimage_repack` input): a signature of the pre-repack file
 * still has the right key id, and every installed copy would reject the update.
 *
 * Formats (minisign, which tauri's signer writes): the .sig file and the pubkey are base64 of a
 * minisign signature box / public key box.
 *   signature box: "untrusted comment: …" / base64(alg(2) keyid(8) sig(64)) /
 *                  "trusted comment: <text>" / base64(global sig(64) over sig ‖ <text>)
 *   public key box: "untrusted comment: …" / base64("Ed"(2) keyid(8) ed25519 key(32))
 * alg "ED" signs the BLAKE2b-512 digest of the file (what tauri writes), "Ed" the file itself.
 *
 * With a version, the trusted comment must also name it (`version:<v>`, what `tauri build` and
 * `tauri signer sign --app-version` write): an app with `requireSignedVersion` rejects a
 * signature bound to no version or to another one.
 */
import { createHash, createPublicKey, verify } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

import { loadAppNaming } from './verify-release.mjs'

// DER prefix of an Ed25519 SubjectPublicKeyInfo; the raw 32-byte key follows it.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

/**
 * @param {{ data: Buffer, signature: string, pubkey: string, version?: string }} input
 *   `signature` and `pubkey` as tauri stores them (base64 of the minisign boxes).
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function verifyUpdaterSignature({ data, signature, pubkey, version }) {
  const sigLines = Buffer.from(signature.trim(), 'base64').toString('utf8').split('\n')
  const keyLines = Buffer.from(pubkey.trim(), 'base64').toString('utf8').split('\n')
  const sig = Buffer.from(sigLines[1] ?? '', 'base64')
  const key = Buffer.from(keyLines[1] ?? '', 'base64')
  const trusted = sigLines[2] ?? ''
  const globalSig = Buffer.from(sigLines[3] ?? '', 'base64')
  if (!sigLines[0]?.startsWith('untrusted comment:') || sig.length !== 74 || !trusted.startsWith('trusted comment: ') || globalSig.length !== 64) {
    return { ok: false, reason: 'the signature is not a minisign signature box' }
  }
  if (!keyLines[0]?.startsWith('untrusted comment:') || key.length !== 42 || key.toString('latin1', 0, 2) !== 'Ed') {
    return { ok: false, reason: 'the public key is not a minisign Ed25519 key' }
  }
  if (!sig.subarray(2, 10).equals(key.subarray(2, 10))) {
    return { ok: false, reason: 'the signature was made by a different key than the app trusts' }
  }
  const alg = sig.toString('latin1', 0, 2)
  if (alg !== 'ED' && alg !== 'Ed') return { ok: false, reason: `unknown signature algorithm ${alg}` }
  const publicKey = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, key.subarray(10)]), format: 'der', type: 'spki' })
  const signed = sig.subarray(10)
  const message = alg === 'ED' ? createHash('blake2b512').update(data).digest() : data
  if (!verify(null, message, publicKey, signed)) {
    return { ok: false, reason: 'the signature does not cover this file (it was signed before the file changed, or is for another file)' }
  }
  const comment = Buffer.from(trusted.slice('trusted comment: '.length), 'utf8')
  if (!verify(null, Buffer.concat([signed, comment]), publicKey, globalSig)) {
    return { ok: false, reason: 'the trusted comment was altered after signing' }
  }
  if (version !== undefined) {
    const bound = /(?:^|\t)version:([^\t]*)/.exec(trusted.slice('trusted comment: '.length))?.[1]
    if (bound !== version) {
      return { ok: false, reason: bound === undefined ? `the signature is bound to no version (expected ${version}; sign with --app-version)` : `the signature is bound to version ${bound}, not ${version}` }
    }
  }
  return { ok: true }
}

function main() {
  const [file, sigFile, srcTauri, version] = process.argv.slice(2)
  if (!file || !sigFile || !srcTauri) {
    console.error('usage: updater-signature.mjs <file> <file.sig> <src-tauri dir> [<version>]')
    return 2
  }
  const { pubkey } = loadAppNaming(srcTauri)
  if (!pubkey) {
    console.error(`::error::No plugins.updater.pubkey in ${srcTauri}/tauri.conf.json to verify ${sigFile} against`)
    return 1
  }
  const result = verifyUpdaterSignature({ data: readFileSync(file), signature: readFileSync(sigFile, 'utf8'), pubkey, version })
  if (!result.ok) {
    console.error(`::error::${sigFile}: ${result.reason}`)
    return 1
  }
  console.log(`${sigFile} verifies against the app's updater key${version ? ` for version ${version}` : ''}`)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = main()
}
