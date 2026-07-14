#!/usr/bin/env node
/* oxlint-disable no-console -- CLI tool; console is its output channel */

/**
 * Version manager for Tauri apps using tauri-release-kit.
 *
 * Bumps the app version coherently across every file the release workflow's
 * `bump-version` job touches, so a local bump produces the same result CI
 * would. Reads the CURRENT version from the root `package.json` (single
 * source of truth) and increments the requested semver part.
 *
 * Usage:
 *   tsx scripts/version-manager.ts patch [--project-path apps/desktop] [--dry-run]
 *   tsx scripts/version-manager.ts minor
 *   tsx scripts/version-manager.ts set 1.2.0-alpha.1   # explicit (pre-release OK)
 *
 * `set` accepts pre-release semver (the bump parts do not) — needed for
 * alpha/beta tags, which MUST match the version baked into the binaries or
 * the updater's version comparison misbehaves.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

type Part = 'major' | 'minor' | 'patch'

const args = process.argv.slice(2)
const command = args[0]
const dryRun = args.includes('--dry-run')
const projIdx = args.indexOf('--project-path')
const projectPath = projIdx >= 0 ? args[projIdx + 1] : '.'

const PLAIN_SEMVER = /^(\d+)\.(\d+)\.(\d+)$/
const FULL_SEMVER = /^\d+\.\d+\.\d+(-[A-Za-z0-9.-]+)?$/

function fail(message: string): never {
  console.error(`error: ${message}`)
  process.exit(1)
}

function readRootVersion(): string {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { version?: unknown }
  if (typeof pkg.version !== 'string' || !FULL_SEMVER.test(pkg.version)) {
    fail(`root package.json version is not semver: ${String(pkg.version)}`)
  }
  return pkg.version
}

function bump(current: string, part: Part): string {
  const m = PLAIN_SEMVER.exec(current)
  if (!m) fail(`cannot ${part}-bump a pre-release version (${current}); use "set X.Y.Z" first`)
  let [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (part === 'major') { major += 1; minor = 0; patch = 0 }
  else if (part === 'minor') { minor += 1; patch = 0 }
  else patch += 1
  return `${major}.${minor}.${patch}`
}

function cargoPackageName(cargoTomlPath: string): string {
  const text = readFileSync(cargoTomlPath, 'utf8')
  const m = /(?:^|\n)name\s*=\s*"([^"]+)"/.exec(text)
  if (!m) fail(`could not read package name from ${cargoTomlPath}`)
  return m[1]
}

function updateJson(path: string, from: string, to: string): boolean {
  if (!existsSync(path)) return false
  const text = readFileSync(path, 'utf8')
  const needle = `"version": "${from}"`
  if (!text.includes(needle)) return false
  if (!dryRun) writeFileSync(path, text.replace(needle, `"version": "${to}"`))
  return true
}

const current = readRootVersion()
let next: string
if (command === 'set') {
  const explicit = args[1]
  if (!explicit || !FULL_SEMVER.test(explicit)) fail('usage: set X.Y.Z[-suffix]')
  next = explicit
} else if (command === 'major' || command === 'minor' || command === 'patch') {
  next = bump(current, command)
} else {
  fail('usage: version-manager.ts <major|minor|patch|set X.Y.Z[-suffix]> [--project-path <dir>] [--dry-run]')
}

const tauriDir = join(projectPath, 'src-tauri')
const cargoToml = join(tauriDir, 'Cargo.toml')
const cargoLock = join(tauriDir, 'Cargo.lock')

const jsonTargets = new Set([
  'package.json',
  join(projectPath, 'package.json'),
  join(tauriDir, 'tauri.conf.json'),
  join(tauriDir, 'tauri.macos.conf.json'),
  join(tauriDir, 'tauri.windows.conf.json'),
  join(tauriDir, 'tauri.linux.conf.json'),
])

for (const target of jsonTargets) {
  const updated = updateJson(target, current, next)
  console.log(`${updated ? 'updated' : 'skipped'} ${target}`)
}

if (existsSync(cargoToml)) {
  const text = readFileSync(cargoToml, 'utf8')
  const pattern = new RegExp(`(?<=^|\\n)version = "${current.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`)
  if (pattern.test(text)) {
    if (!dryRun) writeFileSync(cargoToml, text.replace(pattern, `version = "${next}"`))
    console.log(`updated ${cargoToml}`)
  }

  if (existsSync(cargoLock)) {
    const pkg = cargoPackageName(cargoToml)
    const lockText = readFileSync(cargoLock, 'utf8')
    const blockPattern = new RegExp(`(\\[\\[package\\]\\]\\nname = "${pkg}"\\nversion = ")[^"]+(")`)
    if (blockPattern.test(lockText)) {
      if (!dryRun) writeFileSync(cargoLock, lockText.replace(blockPattern, `$1${next}$2`))
      console.log(`updated ${cargoLock} ([[package]] ${pkg})`)
    }
  }
}

console.log(`\n${current} -> ${next}${dryRun ? ' (dry run)' : ''}`)
console.log(`Next: update CHANGELOG.md with a "## [${next}]" heading, commit, then tag v${next}.`)
