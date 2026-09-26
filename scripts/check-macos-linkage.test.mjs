// Runs check-macos-linkage.sh against a fake bundle with `file` and `otool` stubbed, so
// the path classification is tested on Linux CI too. (It was also run against real
// bundles on macOS: a system app passes; a copied Homebrew gpg sidecar fails.)
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const script = new URL('./check-macos-linkage.sh', import.meta.url).pathname

function exe(path, body) {
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`)
  chmodSync(path, 0o755)
}

// Each fake Mach-O file's content is its `otool -L` load list, one path per line;
// a file starting with "#!" is reported as a script by the `file` stub.
function bundle(files) {
  const root = mkdtempSync(join(tmpdir(), 'rk-link-'))
  const bin = join(root, 'bin')
  mkdirSync(bin)
  exe(join(bin, 'file'), 'if head -c2 "$2" | grep -q "#!"; then echo "Bourne-Again shell script"; else echo "Mach-O 64-bit executable arm64"; fi')
  exe(join(bin, 'otool'), 'echo "$2:"; while IFS= read -r l; do printf "\\t%s (compatibility version 1.0.0, current version 1.0.0)\\n" "$l"; done < "$2"')
  const app = join(root, 'My App.app')
  for (const [rel, content] of Object.entries(files)) {
    const path = join(app, rel)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, content)
  }
  return { app, bin }
}

function check({ app, bin }) {
  const r = spawnSync('bash', [script, app], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } })
  return { code: r.status, out: r.stdout + r.stderr }
}

const SYSTEM = '/usr/lib/libSystem.B.dylib\n/System/Library/Frameworks/WebKit.framework/Versions/A/WebKit\n@rpath/libbundled.dylib\n'

test('system, framework and @rpath load paths pass', () => {
  const r = check(bundle({
    'Contents/MacOS/my-app': SYSTEM,
    'Contents/MacOS/launcher.sh': '#!/bin/sh\n',
    'Contents/Frameworks/libbundled.dylib': '@loader_path/libother.dylib\n',
  }))
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /2 Mach-O file\(s\)/)
})

test('Homebrew paths in a sidecar, a framework and a resource dylib are all reported', () => {
  const r = check(bundle({
    'Contents/MacOS/my-app': SYSTEM,
    'Contents/MacOS/sidecar': '/opt/homebrew/opt/openssl@3/lib/libssl.3.dylib\n',
    'Contents/Frameworks/libx.dylib': '/usr/local/opt/libx/lib/libx.dylib\n',
    'Contents/Resources/plugins/liby.dylib': '/usr/local/Cellar/y/1.0/lib/liby.dylib\n/usr/local/lib/libz.1.dylib\n',
  }))
  assert.equal(r.code, 1)
  assert.match(r.out, /Contents\/MacOS\/sidecar links \/opt\/homebrew\/opt\/openssl@3\/lib\/libssl\.3\.dylib/)
  assert.match(r.out, /Contents\/Frameworks\/libx\.dylib links \/usr\/local\/opt\//)
  assert.match(r.out, /liby\.dylib links \/usr\/local\/Cellar\//)
  assert.match(r.out, /liby\.dylib links \/usr\/local\/lib\/libz/)
})

test('a bundle with no Mach-O files, or no bundle, is an error', () => {
  assert.equal(check(bundle({ 'Contents/MacOS/run.sh': '#!/bin/sh\n' })).code, 1)
  const r = spawnSync('bash', [script, '/nonexistent.app'], { encoding: 'utf8' })
  assert.equal(r.status, 2)
})
