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

// An rpm fixture whose content is the Requires list the `rpm` stub prints for it.
function rpmBundle(root, requires) {
  const dir = join(root, 'bundle')
  mkdirSync(join(dir, 'rpm'), { recursive: true })
  if (requires !== null) writeFileSync(join(dir, 'rpm', 'App-1.2.3-1.x86_64.rpm'), requires)
  return dir
}

function rpmStubs(bin, dockerBody = 'exit 0') {
  exe(join(bin, 'rpm'), '[ "$1" = -qp ] && [ "$2" = --requires ] && cat "$3"')
  exe(join(bin, 'docker'), dockerBody)
}

const SONAMES = 'libwebkit2gtk-4.1.so.0()(64bit)\nlibgtk-3.so.0()(64bit)\nrpmlib(FileDigests)\n'
const REQUIRED = 'libwebkit2gtk-4.1.so.0()(64bit), libgtk-3.so.0()(64bit)'

test('linux: an rpm declaring every required capability passes', () => {
  const { root, bin } = sandbox()
  rpmStubs(bin)
  const r = run('smoke-linux.sh', [rpmBundle(root, SONAMES), '1.2.3', 'rpm'], { bin, env: { RPM_REQUIRES: REQUIRED } })
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /declares every required capability/)
})

test('linux: a missing Requires and a missing rpm are reported once rpm checks are configured', () => {
  const { root, bin } = sandbox()
  rpmStubs(bin)
  const r = run('smoke-linux.sh', [rpmBundle(root, 'libgtk-3.so.0()(64bit)\n'), '1.2.3', 'rpm'], { bin, env: { RPM_REQUIRES: REQUIRED } })
  assert.equal(r.code, 1)
  assert.match(r.out, /does not declare Requires: libwebkit2gtk-4\.1\.so\.0\(\)\(64bit\)/)
  assert.doesNotMatch(r.out, /Requires: libgtk/)
  const empty = run('smoke-linux.sh', [rpmBundle(mkdtempSync(join(tmpdir(), 'rk-rpm-')), null), '1.2.3', 'rpm'], { bin, env: { RPM_REQUIRES: REQUIRED } })
  assert.equal(empty.code, 1)
  assert.match(empty.out, /no \.rpm/)
})

test('linux: the clean-container install passes or prints what did not resolve', () => {
  const { root, bin } = sandbox()
  // The stub sees the image and the rpm path the script mounts.
  rpmStubs(bin, '[ "$1" = run ] && printf "%s\\n" "$@" | grep -qx "fedora:43" && printf "%s\\n" "$@" | grep -qx "/pkg/App-1.2.3-1.x86_64.rpm"')
  const ok = run('smoke-linux.sh', [rpmBundle(root, SONAMES), '1.2.3', 'rpm'], { bin, env: { RPM_INSTALL_IMAGE: 'fedora:43' } })
  assert.equal(ok.code, 0, ok.out)
  assert.match(ok.out, /installs on a clean fedora:43 and every library resolves/)

  const broken = sandbox()
  rpmStubs(broken.bin, 'echo "/usr/bin/app:"; echo "  libayatana-appindicator3.so.1 => not found"; exit 1')
  const r = run('smoke-linux.sh', [rpmBundle(broken.root, SONAMES), '1.2.3', 'rpm'], { bin: broken.bin, env: { RPM_INSTALL_IMAGE: 'fedora:43' } })
  assert.equal(r.code, 1)
  assert.match(r.out, /failed a clean install on fedora:43/)
  assert.match(r.out, /libayatana-appindicator3\.so\.1 => not found/)
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
