// Drives the smoke-test shell scripts against stub tools on PATH, so their pass/fail
// decisions are exercised without a real package. The Windows script cannot run here;
// lint.yml parse-checks it with pwsh.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const here = new URL('.', import.meta.url).pathname

function exe(path, body) {
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`)
  chmodSync(path, 0o755)
}

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'rk-smoke-'))
  const bin = join(root, 'bin')
  mkdirSync(bin)
  return { root, bin }
}

function run(script, args, { bin, env = {} }) {
  const r = spawnSync('bash', [join(here, script), ...args], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, SMOKE_SECONDS: '1', RUNNER_TEMP: tmpdir(), ...env },
  })
  return { code: r.status, out: r.stdout + r.stderr }
}

// A fake AppImage whose extracted AppRun runs `appRun`.
function linuxBundle(root, { debVersion = '1.2.3', appRun = 'sleep 30' } = {}) {
  const dir = join(root, 'bundle')
  mkdirSync(join(dir, 'deb'), { recursive: true })
  mkdirSync(join(dir, 'appimage'), { recursive: true })
  writeFileSync(join(dir, 'deb', 'App_1.2.3_amd64.deb'), debVersion)
  exe(join(dir, 'appimage', 'App_1.2.3_amd64.AppImage'), `
[ "$1" = --appimage-extract ] || exit 99
mkdir -p squashfs-root
printf '#!/usr/bin/env bash\\n%s\\n' ${JSON.stringify(appRun)} > squashfs-root/AppRun
chmod +x squashfs-root/AppRun`)
  return dir
}

function linuxStubs(bin) {
  exe(join(bin, 'dpkg-deb'), '[ "$1" = -f ] && [ "$3" = Version ] && cat "$2"')
  exe(join(bin, 'xvfb-run'), '[ "$1" = -a ] && shift; exec "$@"')
}

test('linux: a matching deb and a long-running AppImage pass', () => {
  const { root, bin } = sandbox()
  linuxStubs(bin)
  const r = run('smoke-linux.sh', [linuxBundle(root), '1.2.3', 'deb,rpm,appimage'], { bin })
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /still running after 1s/)
})

test('linux: wrong deb version and an AppImage that exits are both reported', () => {
  const { root, bin } = sandbox()
  linuxStubs(bin)
  const dir = linuxBundle(root, { debVersion: '1.2.2', appRun: 'echo "error while loading shared libraries: libfoo.so"; exit 127' })
  const r = run('smoke-linux.sh', [dir, '1.2.3', 'deb,appimage'], { bin })
  assert.equal(r.code, 1)
  assert.match(r.out, /declares Version '1\.2\.2', expected '1\.2\.3'/)
  assert.match(r.out, /exited during startup \(status 127\)/)
  assert.match(r.out, /libfoo\.so/)
})

test('linux: a panic logged by a process that keeps running still fails', () => {
  const { root, bin } = sandbox()
  linuxStubs(bin)
  const dir = linuxBundle(root, { appRun: "echo \"thread 'main' panicked at src/main.rs:1\"; sleep 30" })
  const r = run('smoke-linux.sh', [dir, '1.2.3', 'appimage'], { bin })
  assert.equal(r.code, 1)
  assert.match(r.out, /logged a panic or linker error/)
})

test('linux: a bundle format in the list with no file fails; unlisted formats are ignored', () => {
  const { root, bin } = sandbox()
  linuxStubs(bin)
  const dir = join(root, 'empty')
  mkdirSync(dir)
  assert.equal(run('smoke-linux.sh', [dir, '1.2.3', 'rpm'], { bin }).code, 0)
  const r = run('smoke-linux.sh', [dir, '1.2.3', 'deb'], { bin })
  assert.equal(r.code, 1)
  assert.match(r.out, /no \.deb/)
  assert.equal(run('smoke-linux.sh', [dir], { bin }).code, 2)
})

function macBundle(root, appBody) {
  const dir = join(root, 'bundle')
  const contents = join(dir, 'macos', 'My App.app', 'Contents')
  mkdirSync(join(contents, 'MacOS'), { recursive: true })
  mkdirSync(join(dir, 'dmg'), { recursive: true })
  writeFileSync(join(contents, 'Info.plist'), 'my-app')
  exe(join(contents, 'MacOS', 'my-app'), appBody)
  writeFileSync(join(dir, 'dmg', 'My App_1.2.3_aarch64.dmg'), 'ok')
  return dir
}

function macStubs(bin) {
  // plutil -extract CFBundleExecutable raw -o - <plist>: the fixture plist holds the name.
  exe(join(bin, 'plutil'), 'cat "${@: -1}"')
  exe(join(bin, 'hdiutil'), '[ "$1" = verify ] && [ "$(cat "$2")" = ok ]')
}

test('macos: verified dmg and an app that stays up pass', () => {
  const { root, bin } = sandbox()
  macStubs(bin)
  const r = run('smoke-macos.sh', [macBundle(root, 'sleep 30'), 'app,dmg'], { bin })
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /My App\.app \(my-app\) still running/)
})

test('macos: corrupt dmg and a crashing app are both reported with the app output', () => {
  const { root, bin } = sandbox()
  macStubs(bin)
  const dir = macBundle(root, 'echo "dyld: Library not loaded: /opt/homebrew/lib/libfoo.dylib"; exit 134')
  writeFileSync(join(dir, 'dmg', 'My App_1.2.3_aarch64.dmg'), 'truncated')
  const r = run('smoke-macos.sh', [dir, 'app,dmg'], { bin })
  assert.equal(r.code, 1)
  assert.match(r.out, /hdiutil verify failed/)
  assert.match(r.out, /exited during startup \(status 134\)/)
  assert.match(r.out, /Library not loaded/)
})
