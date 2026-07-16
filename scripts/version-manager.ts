#!/usr/bin/env node
/* oxlint-disable no-console -- this is a CLI tool; console is its output channel */

/**
 * Version Manager for Anasa.
 *
 * Bumps the app version coherently across every file the release `bump-version` CI job touches, so
 * a local `pnpm version:*` produces the same result CI would. It reads the CURRENT version from the
 * root `package.json` (the single source of truth) and increments the requested semver part.
 *
 * It deliberately does NOT generate from a build counter: the previous implementation hardcoded
 * `0.1.<counter>`, so it could only ever emit `0.1.x` and — because the counter drifted from
 * reality (the app is already past 0.1.190) — running it would have RESET the real version. This
 * mirrors `.github/workflows/release-with-updater.yml` → `bump-version` (patch+1 by default,
 * surgical per-file rewrites of the same target set).
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const projectRoot = join(__dirname, '../..')

type VersionFileType = 'json' | 'toml' | 'cargo-lock'
type VersionPart = 'major' | 'minor' | 'patch'

interface VersionFile {
  path: string
  type: VersionFileType
  /** JSON/TOML: the version key. `cargo-lock`: the `[[package]]` name whose version to bump. */
  key: string
}

interface VersionOptions {
  part?: VersionPart
  dryRun?: boolean
}

const ROOT_PACKAGE_JSON = join(projectRoot, 'package.json')
const tauri = (file: string): string => join(projectRoot, 'apps', 'desktop', 'src-tauri', file)

// Every file the release `bump-version` job rewrites — kept in lockstep so a local bump matches CI.
// The per-OS tauri overrides carry no top-level `version`, so they are silently skipped (see the
// match-old-version guard in updateJsonVersion); they are listed only to document the full target set.
const VERSION_FILES: VersionFile[] = [
  { path: ROOT_PACKAGE_JSON, type: 'json', key: 'version' },
  { path: join(projectRoot, 'apps', 'desktop', 'package.json'), type: 'json', key: 'version' },
  { path: tauri('tauri.conf.json'), type: 'json', key: 'version' },
  { path: tauri('tauri.macos.conf.json'), type: 'json', key: 'version' },
  { path: tauri('tauri.windows.conf.json'), type: 'json', key: 'version' },
  { path: tauri('tauri.linux.conf.json'), type: 'json', key: 'version' },
  { path: tauri('Cargo.toml'), type: 'toml', key: 'version' },
  { path: tauri('Cargo.lock'), type: 'cargo-lock', key: 'anasa' },
]

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)$/
// Full semver incl. pre-release — accepted by `set` and when READING the current version
// (channel releases leave e.g. 0.2.0-alpha.1 in the files).
const FULL_SEMVER_RE = /^\d+\.\d+\.\d+(-[A-Za-z0-9.-]+)?$/

/** Read the current version from the root `package.json` — the single source of truth. */
function readCurrentVersion(): string {
  const pkg = JSON.parse(readFileSync(ROOT_PACKAGE_JSON, 'utf8')) as { version?: unknown }
  const version = pkg.version
  if (typeof version !== 'string' || !FULL_SEMVER_RE.test(version)) {
    throw new Error(`Root package.json version is not semver: ${String(version)}`)
  }
  return version
}

/** Increment one semver part, zeroing the lower parts. */
function bumpVersion(current: string, part: VersionPart): string {
  const match = SEMVER_RE.exec(current)
  if (!match) {
    throw new Error(
      `Cannot increment a pre-release version (${current}); use \`set X.Y.Z[-suffix]\` instead`,
    )
  }
  let major = Number(match[1])
  let minor = Number(match[2])
  let patch = Number(match[3])
  if (part === 'major') {
    major += 1
    minor = 0
    patch = 0
  } else if (part === 'minor') {
    minor += 1
    patch = 0
  } else {
    patch += 1
  }
  return `${major}.${minor}.${patch}`
}

type UpdateOutcome = 'updated' | 'skipped' | 'missing'

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Update a top-level JSON `version` key only when it currently equals `oldVersion` (surgical,
 * matches CI). Files without the key — the per-OS tauri overrides — are left untouched rather than
 * gaining a spurious `version` field.
 */
function updateJsonVersion(
  filePath: string,
  key: string,
  oldVersion: string,
  newVersion: string,
): UpdateOutcome {
  if (!existsSync(filePath)) return 'missing'
  const text = readFileSync(filePath, 'utf8')
  const endsWithNewline = text.endsWith('\n')
  const content = JSON.parse(text) as Record<string, unknown>
  if (content[key] !== oldVersion) return 'skipped'
  content[key] = newVersion
  writeFileSync(filePath, JSON.stringify(content, null, 2) + (endsWithNewline ? '\n' : ''))
  return 'updated'
}

/** Update the first `version = "<old>"` line in a TOML file (the Cargo.toml package version). */
function updateTomlVersion(
  filePath: string,
  key: string,
  oldVersion: string,
  newVersion: string,
): UpdateOutcome {
  if (!existsSync(filePath)) return 'missing'
  const text = readFileSync(filePath, 'utf8')
  const re = new RegExp(`^${escapeRegExp(key)}\\s*=\\s*"${escapeRegExp(oldVersion)}"`, 'm')
  if (!re.test(text)) return 'skipped'
  writeFileSync(filePath, text.replace(re, `${key} = "${newVersion}"`))
  return 'updated'
}

/** Bump the version inside the `[[package]] name = "<pkg>"` block of a Cargo.lock. */
function updateCargoLockVersion(
  filePath: string,
  pkgName: string,
  _oldVersion: string,
  newVersion: string,
): UpdateOutcome {
  if (!existsSync(filePath)) return 'missing'
  const text = readFileSync(filePath, 'utf8')
  const re = new RegExp(
    `(\\[\\[package\\]\\]\\nname = "${escapeRegExp(pkgName)}"\\nversion = ")[^"]+(")`,
  )
  if (!re.test(text)) return 'skipped'
  writeFileSync(filePath, text.replace(re, `$1${newVersion}$2`))
  return 'updated'
}

function updateFile(file: VersionFile, oldVersion: string, newVersion: string): UpdateOutcome {
  switch (file.type) {
    case 'json':
      return updateJsonVersion(file.path, file.key, oldVersion, newVersion)
    case 'toml':
      return updateTomlVersion(file.path, file.key, oldVersion, newVersion)
    case 'cargo-lock':
      return updateCargoLockVersion(file.path, file.key, oldVersion, newVersion)
  }
}

/** Current version, read from the root package.json. */
export function getCurrentVersion(): { version: string } {
  return { version: readCurrentVersion() }
}

/**
 * Set an explicit version (pre-release allowed) across every target file. Channel releases REQUIRE
 * this: the tag's version must match the version baked into the binaries or the updater's
 * comparison misbehaves (e.g. `set 0.3.0-alpha.1` before tagging v0.3.0-alpha.1).
 */
export function setVersion(explicit: string, dryRun = false): { from: string; to: string } {
  if (!FULL_SEMVER_RE.test(explicit)) {
    throw new Error(`Not a semver version: ${explicit}`)
  }
  const from = readCurrentVersion()
  if (!dryRun) {
    for (const file of VERSION_FILES) {
      console.log(`${updateFile(file, from, explicit).padEnd(8)} ${file.path}`)
    }
  }
  return { from, to: explicit }
}

/** Bump the version across every target file. Returns the from/to pair. */
export function incrementVersion(options: VersionOptions = {}): {
  from: string
  to: string
  dryRun: boolean
} {
  const { part = 'patch', dryRun = false } = options
  const from = readCurrentVersion()
  const to = bumpVersion(from, part)
  if (!dryRun) {
    for (const file of VERSION_FILES) {
      console.log(`${updateFile(file, from, to).padEnd(8)} ${file.path}`)
    }
  }
  return { from, to, dryRun }
}

// CLI interface
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2)
  const command = args[0] ?? 'increment'
  // `--patch` is the default; `--build` (legacy) maps to a patch bump, since the patch component has
  // always been the de-facto build number.
  const part: VersionPart = args.includes('--major')
    ? 'major'
    : args.includes('--minor')
      ? 'minor'
      : 'patch'
  const dryRun = args.includes('--dry-run')

  switch (command) {
    case 'increment':
    case 'inc': {
      const result = incrementVersion({ part, dryRun })
      console.log(`${dryRun ? '[dry-run] ' : ''}${result.from} -> ${result.to}`)
      break
    }

    case 'set': {
      const explicit = args[1]
      if (!explicit) {
        console.error('Usage: version-manager.ts set X.Y.Z[-suffix]')
        process.exit(1)
      }
      const result = setVersion(explicit, dryRun)
      console.log(`${dryRun ? '[dry-run] ' : ''}${result.from} -> ${result.to}`)
      break
    }

    case 'current':
    case 'info':
      console.log(getCurrentVersion().version)
      break

    case 'help':
      console.log(
        'Usage: version-manager.ts [increment|set X.Y.Z[-suffix]|current] [--major|--minor|--patch] [--dry-run]',
      )
      break

    default:
      console.error(`Unknown command: ${command}`)
      process.exit(1)
  }
}
