# Code Signing & Notarization

This document covers **distribution code signing** — making the OS trust the
installer (macOS Gatekeeper, Windows SmartScreen). It is separate from the
Tauri **updater** minisign key (step 3 of the README's new-app checklist);
both are needed for a fully trusted auto-updating release, but they are
different mechanisms:

| Mechanism            | Purpose                                  | Secrets                                              |
| -------------------- | ---------------------------------------- | --------------------------------------------------- |
| Updater (minisign)   | Updater trusts the downloaded artifact   | `TAURI_SIGNING_PRIVATE_KEY[_PASSWORD]`              |
| macOS code signing   | Gatekeeper trusts the `.app`/`.dmg`      | `APPLE_CERTIFICATE`, `APPLE_SIGNING_IDENTITY`, …    |
| Windows code signing | SmartScreen trusts the `.msi`/`.exe`     | `WINDOWS_CERTIFICATE` / `AZURE_*` / a sign command  |
| Linux artifact signing | Users can verify the `.AppImage`/`.rpm` is yours | `LINUX_GPG_PRIVATE_KEY[_PASSPHRASE]`      |

For submitting to the Mac App Store or the iOS App Store — a different
certificate type and a different pipeline entirely — see
[APP_STORE.md](APP_STORE.md).

**Everything here is optional, and degrades gracefully.** With no secrets the
release workflow builds and uploads **unsigned** artifacts and says so; the
binaries are valid, the OS just warns. What is *not* tolerated is a
half-configured mode — a certificate without its password, Azure credentials
without an endpoint — because that means someone intended to sign, and finding
out from an unsigned artifact after publish costs far more than failing early.

Signing that silently did nothing is caught too: each OS's artifacts are
verified after the build, before anything is published.

---

## 1. macOS (paid Apple Developer account) — CLI-only path

You have a paid Apple Developer account. The whole flow below runs from your
Mac terminal; no Xcode UI is required. The end state is two GitHub secrets for
signing + three for notarization (App Store Connect API key method).

### 1.1 One-time: create the Developer ID Application certificate

You sign distributed `.app`/`.dmg` bundles with a **Developer ID Application**
certificate (NOT "Apple Development" / "Mac App Distribution").

CLI generation of a CSR + certificate is fiddly with `security`/`openssl`; the
reliable CLI path is `fastlane` if installed:

```bash
# Optional, if you use fastlane:
brew install fastlane
fastlane cert            # creates + installs a Developer ID Application cert
```

If you'd rather not add fastlane, create the cert once via the web portal
(developer.apple.com → Certificates → "+" → **Developer ID Application**), which
walks you through a CSR you generate from Keychain Access. The certificate then
lands in your login keychain and everything after is CLI.

### 1.2 Find your signing identity

```bash
security find-identity -v -p codesigning
```

Copy the full quoted string, e.g.:

```
Developer ID Application: Your Name (ABCDE12345)
```

That whole string is `APPLE_SIGNING_IDENTITY`. The trailing `ABCDE12345` is your
**Team ID** (`APPLE_TEAM_ID`).

### 1.3 Export the certificate to `.p12`, then base64

The CI runner has no keychain, so we ship the cert + private key as a base64
`.p12`.

```bash
# Export from the login keychain to a password-protected .p12.
# You'll be prompted to set an EXPORT PASSWORD — remember it; it becomes
# APPLE_CERTIFICATE_PASSWORD.
security find-certificate -c "Developer ID Application: Your Name (ABCDE12345)" \
  -p login.keychain                # sanity check it exists first

# Easiest reliable export is via Keychain Access (right-click the cert →
# Export → .p12). If you prefer pure CLI and the cert+key are exportable:
#   1. Identify the SHA-1 hash from `security find-identity -v -p codesigning`
#   2. Use Keychain Access export, or `security export` on the identity.

# Once you have DeveloperID.p12:
base64 -i DeveloperID.p12 -o DeveloperID.p12.base64
cat DeveloperID.p12.base64 | pbcopy   # now on your clipboard
```

Set:

- `APPLE_CERTIFICATE` = the base64 string (contents of `DeveloperID.p12.base64`)
- `APPLE_CERTIFICATE_PASSWORD` = the export password you chose above
- `APPLE_SIGNING_IDENTITY` = `Developer ID Application: Your Name (ABCDE12345)`

> **Note:** `security export -f pkcs12` works only if the private key was created
> as exportable. If `security export` refuses, use Keychain Access → right-click
> the **Developer ID Application** entry → **Export …** → File Format
> *Personal Information Exchange (.p12)*. That single GUI click is the only
> non-CLI step in the entire pipeline.

### 1.4 Notarization — App Store Connect API key (recommended, CLI-only)

The API-key method needs no app-specific password and no interactive 2FA, which
is why it's the CLI/CI-friendly path.

1. Go to **App Store Connect → Users and Access → Integrations → App Store
   Connect API** (a.k.a. "Keys").
2. Create a key with the **Developer** role (sufficient for `notarytool`).
3. Note the **Issuer ID** (shown above the table) and the **Key ID** (the row).
4. Download `AuthKey_<KeyID>.p8` — **you can only download it once.**

Base64 the `.p8` for the CI secret:

```bash
base64 -i AuthKey_<KeyID>.p8 -o apple_api_key.p8.base64
cat apple_api_key.p8.base64 | pbcopy
```

Set:

- `APPLE_API_ISSUER` = the Issuer ID (UUID)
- `APPLE_API_KEY` = the Key ID
- `APPLE_API_KEY_BASE64` = the base64 of `AuthKey_<KeyID>.p8`

The workflow's **"Materialize Apple API key"** step decodes
`APPLE_API_KEY_BASE64` to `$RUNNER_TEMP/apple_api_key.p8` and exports its path as
`APPLE_API_KEY_PATH`, which Tauri's `notarytool` integration consumes. If the
secret is unset, that step is a no-op and notarization is skipped (or falls back
to the Apple ID method below).

### 1.5 Notarization — Apple ID fallback (optional)

Only needed if you don't use the API key. Requires an app-specific password
(appleid.apple.com → Sign-In and Security → App-Specific Passwords).

- `APPLE_ID` = your Apple account email
- `APPLE_PASSWORD` = the app-specific password (format `abcd-efgh-ijkl-mnop`)
- `APPLE_TEAM_ID` = `ABCDE12345`

If both credential sets are present, the API-key vars take precedence.

### 1.6 Hardened runtime + bundled dylibs

If your app sets `"hardenedRuntime": true` in `tauri.macos.conf.json`, add an
`"entitlements": "entitlements.plist"` file (next to `tauri.conf.json` in
`src-tauri/`) covering what your app actually does:

- **WebKit JIT:** `com.apple.security.cs.allow-jit` +
  `allow-unsigned-executable-memory` — the webview crashes under hardened
  runtime without them.
- **Bundled third-party dylibs:** if you ship a dylib as a resource and
  `dlopen` it via `@rpath`, `com.apple.security.cs.disable-library-validation`
  lets the notarized binary load it. Without it the app aborts with a
  code-signature failure the first time the dylib is loaded.

Tauri re-signs bundled resources/frameworks with your Developer ID during the
bundle step, then notarizes the whole `.app`. No manual `codesign` calls are
needed.

### 1.7 Verify a signed build locally

```bash
# After `pnpm tauri build --config src-tauri/tauri.macos.conf.json`:
codesign --verify --deep --strict --verbose=2 \
  "src-tauri/target/release/bundle/macos/MyApp.app"
spctl -a -vvv -t install "src-tauri/target/release/bundle/macos/MyApp.app"
xcrun stapler validate "src-tauri/target/release/bundle/macos/MyApp.app"
```

---

## 2. Windows

Windows signing is **wired into the release pipeline** — you supply
credentials, the pipeline picks a mode, generates a bundle-config overlay, and
verifies the result. Nothing about signing is committed to your app repo, so
the same config builds unsigned on a contributor's machine.

With no credentials the pipeline ships unsigned installers and says so with a
notice. They run; SmartScreen warns on download.

### Which certificate

| Type | SmartScreen | Availability |
| --- | --- | --- |
| **EV** | Trusted immediately | Organizations; certificate lives on an HSM/token |
| **OV** | Warns until reputation builds | Individuals too; cheaper |
| **Azure Artifact Signing** | Trusted (Microsoft-operated) | Pay-per-use, no hardware |

The important part: get a **code signing** certificate. An SSL/TLS certificate
cannot sign executables, and the two are easy to confuse when buying.

For a *new* project with no existing certificate, Azure Artifact Signing (the
service formerly called Azure Trusted Signing / Azure Code Signing) is usually
the least painful: no hardware, no renewal ritual, and it works from a Linux
runner because signing happens over an API.

### Mode A — Azure Artifact Signing

Set three workflow inputs and three secrets:

```yaml
with:
  windows_azure_endpoint: 'https://wus2.codesigning.azure.net'  # your region
  windows_azure_account: 'MyAccount'
  windows_azure_cert_profile: 'MyProfile'
```

| Secret | Where it comes from |
| --- | --- |
| `AZURE_CLIENT_ID` | App registration → Application (client) ID |
| `AZURE_CLIENT_SECRET` | App registration → Certificates & secrets → New client secret → **Value** |
| `AZURE_TENANT_ID` | App registration → Directory (tenant) ID |

The service principal needs the **Trusted Signing Certificate Profile Signer**
role on the signing account. The pipeline installs `artifact-signing-cli` on
the Windows runner (a few minutes on a cold cargo cache) and sets:

```jsonc
{ "bundle": { "windows": { "signCommand": "artifact-signing-cli -e <endpoint> -a <account> -c <profile> -d \"<app name>\" %1" } } }
```

The `-d` description is what the UAC prompt shows when a user runs an MSI, so
it is filled from `app_display_name` rather than left to a random string.

Setting the credentials without the inputs (or the inputs without the
credentials) is a hard error, not a silent fall-back to unsigned.

### Mode B — a `.pfx` certificate

For an OV certificate you hold as a file. Convert and encode it once:

```bash
# If you have separate .cer + .key files:
openssl pkcs12 -export -in cert.cer -inkey private-key.key -out certificate.pfx
# Then, on Windows:
certutil -encode certificate.pfx base64cert.txt
# ...or anywhere:
openssl base64 -A -in certificate.pfx -out base64cert.txt
```

| Secret | Value |
| --- | --- |
| `WINDOWS_CERTIFICATE` | contents of `base64cert.txt` |
| `WINDOWS_CERTIFICATE_PASSWORD` | the export password |
| `WINDOWS_CERTIFICATE_THUMBPRINT` | *optional* — pins the expected certificate |

The pipeline decodes it, imports it into the runner's `CurrentUser\My` store,
reads the thumbprint back, and injects:

```jsonc
{ "bundle": { "windows": {
  "certificateThumbprint": "<read from the import>",
  "digestAlgorithm": "sha256",
  "timestampUrl": "http://timestamp.digicert.com"
} } }
```

Change the last two with the `windows_digest_algorithm` /
`windows_timestamp_url` inputs. **Keep the timestamp URL**: an untimestamped
signature stops verifying the day the certificate expires, retroactively, for
every copy already downloaded.

Set `WINDOWS_CERTIFICATE_THUMBPRINT` alongside the `.pfx` and the pipeline
fails if the imported certificate is a different one — cheap protection
against a rotated-but-not-updated secret signing with something unexpected.

### Mode C — an EV certificate, HSM, or any other issuer CLI

EV certificates live on hardware and every issuer ships its own tool
(SSL.com eSigner, DigiCert KeyLocker, a YubiKey via `signtool`, `relic`
against Azure Key Vault). Point the pipeline at whatever command signs a file:

```yaml
with:
  windows_sign_command: 'my-issuer-cli sign --credential-id $ID %1'
```

`%1` is where Tauri substitutes the file being signed; the pipeline refuses a
command without it, because such a command signs nothing and reports success.
The tool must be on the runner's PATH — install it in a step before this
workflow, or use a self-bootstrapping command.

`relic` against Azure Key Vault, for reference:

```yml title=src-tauri/relic.conf
tokens:
  azure:
    type: azure
keys:
  azure:
    token: azure
    id: https://<KEY_VAULT_NAME>.vault.azure.net/certificates/<CERTIFICATE_NAME>
```

```yaml
with:
  windows_sign_command: 'relic sign --file %1 --key azure --config relic.conf'
```

### Mode D — certificate already on the runner

A self-hosted Windows runner with the certificate already in its store (or a
token plugged into it) needs only `WINDOWS_CERTIFICATE_THUMBPRINT`.

### Cross-compiling

Tauri's built-in signtool path only runs on Windows. Cross-compiling an NSIS
installer from Linux or macOS therefore **requires** mode A or C — a custom
sign command is the only mechanism that works off-Windows. This kit builds
Windows legs on Windows runners, so it does not hit this; the local preflight
harness does not sign at all.

### What gets verified

After the build, every `.exe` and `.msi` is checked with
`Get-AuthenticodeSignature`:

- `Valid` → logged with the signer subject.
- `NotSigned` / `HashMismatch` → **error**. The signing mode was configured
  and produced nothing; shipping this would be worse than shipping an
  admittedly-unsigned build.
- anything else (`NotTrusted`, `UnknownError`) → **warning**. A signature
  exists but this runner cannot chain it to a trusted root, which is normal
  for internal CAs and for Azure Artifact Signing's short-lived certificates.

---

## 3. Linux

Linux gates nothing on signatures — an unsigned `.deb`, `.rpm` or `.AppImage`
installs and runs. Signing is about letting users who care verify that a
download is yours.

One GPG key covers both signable formats. Generate it once:

```bash
gpg --full-gen-key                     # RSA 4096 or ed25519, no expiry issues
gpg --list-secret-keys --keyid-format=long
gpg --armor --export-secret-keys <KEY_ID> > private.asc   # → LINUX_GPG_PRIVATE_KEY
gpg --armor --export <KEY_ID> > public.asc                # → publish this
```

| Secret | Purpose |
| --- | --- |
| `LINUX_GPG_PRIVATE_KEY` | the armored private key (base64 of it also accepted) |
| `LINUX_GPG_PASSPHRASE` | **required in CI if the key has one** — gpg would otherwise block on a passphrase prompt no runner can answer, until the job times out |
| `LINUX_GPG_KEY_ID` | optional; defaults to the first secret key in the keyring |

Back the private key up outside the repository. Losing it means every future
release is signed by a different key than the one users learned to trust.

### AppImage

The pipeline exports `SIGN=1`, `SIGN_KEY`, `APPIMAGETOOL_SIGN_PASSPHRASE` and
`APPIMAGETOOL_FORCE_SIGN=1`. That last one matters: by default appimagetool
emits a perfectly valid **unsigned** AppImage when signing fails and exits 0,
so without it a broken key ships silently for months.

**AppImage does not verify its own signature.** Nothing checks it at run time.
For the signature to mean anything you must publish your key fingerprint over
an authenticated channel (your HTTPS site), so a user can check it themselves:

```bash
chmod +x validate-x86_64.AppImage         # from AppImageUpdate releases
./validate-x86_64.AppImage MyApp_1.0.0_amd64.AppImage
```

Inspect an embedded signature directly with
`./MyApp_1.0.0_amd64.AppImage --appimage-signature`.

### RPM

The pipeline exports `TAURI_SIGNING_RPM_KEY` (the key material, not a key ID)
and `TAURI_SIGNING_RPM_KEY_PASSPHRASE`; tauri-bundler signs the package as it
writes it, and the pipeline verifies with `rpm -K`.

Unlike AppImage, this signature *is* checked — by `rpm`/`dnf`, once the user
has imported your public key:

```bash
sudo rpm --import public.asc
rpm -K myapp-1.0.0-1.x86_64.rpm     # "digests signatures OK"
```

### deb

Not signed, deliberately. Debian's trust model signs *repositories*
(`Release.gpg`), not individual packages; `dpkg -i` of a standalone download
performs no signature check, so a per-package signature would be decoration.
If you run an apt repository, sign the repository metadata there.

---

## 4. GitHub secrets summary

Set under **Settings → Secrets and variables → Actions**. Every one is
optional; omit a group to skip that signing step. Nothing hard-fails for a
missing group — only for a *half-configured* one.

### Updater (see step 3 of the README's new-app checklist)

| Secret                                | Required for       |
| ------------------------------------- | ------------------ |
| `TAURI_SIGNING_PRIVATE_KEY`           | Auto-update sigs   |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`  | Auto-update sigs (omit for a passwordless key) |

### macOS signing

| Secret                       | Purpose                                            |
| ---------------------------- | -------------------------------------------------- |
| `APPLE_CERTIFICATE`          | base64 of the Developer ID Application `.p12`      |
| `APPLE_CERTIFICATE_PASSWORD` | export password for that `.p12`                    |
| `APPLE_SIGNING_IDENTITY`     | `Developer ID Application: Name (TEAMID)`          |

### macOS notarization — pick ONE method

| Method  | Secrets                                                        |
| ------- | ------------------------------------------------------------- |
| API key | `APPLE_API_ISSUER`, `APPLE_API_KEY`, `APPLE_API_KEY_BASE64`    |
| Apple ID | `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`                 |

### Windows signing — pick ONE mode

| Mode | Inputs | Secrets |
| --- | --- | --- |
| A — Azure Artifact Signing | `windows_azure_endpoint`, `windows_azure_account`, `windows_azure_cert_profile` | `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_TENANT_ID` |
| B — `.pfx` | — | `WINDOWS_CERTIFICATE`, `WINDOWS_CERTIFICATE_PASSWORD`, (`WINDOWS_CERTIFICATE_THUMBPRINT`) |
| C — any issuer CLI | `windows_sign_command` | whatever that tool reads |
| D — cert already on the runner | — | `WINDOWS_CERTIFICATE_THUMBPRINT` |

### Linux signing

| Secret | Purpose |
| --- | --- |
| `LINUX_GPG_PRIVATE_KEY` | signs the AppImage and the RPM |
| `LINUX_GPG_PASSPHRASE` | required if the key has one |
| `LINUX_GPG_KEY_ID` | optional key selection |

### App Store (a separate workflow — see [APP_STORE.md](APP_STORE.md))

`APPLE_API_ISSUER`, `APPLE_API_KEY_ID`, `APPLE_API_KEY_BASE64`,
`APPLE_CERTIFICATE(_PASSWORD)`, `APPLE_INSTALLER_CERTIFICATE(_PASSWORD)`,
`APPLE_PROVISIONING_PROFILE`, and for iOS `IOS_CERTIFICATE(_PASSWORD)` +
`IOS_MOBILE_PROVISION`.

---

## 5. What runs in CI

The kit's `.github/workflows/release.yml`:

- The matrix passes `--config src-tauri/tauri.<os>.conf.json` per row so the
  per-OS bundle overrides actually apply, plus a second `--config` carrying
  the generated Windows signing overlay when one applies. Tauri merges
  `--config` files in order.
- **Materialize Apple API key** decodes `APPLE_API_KEY_BASE64` to a file on
  macOS runners and exposes `APPLE_API_KEY_PATH`.
- **Export Apple signing env (non-empty only)** exports *only* the Apple
  variables that have values. This is not politeness: GitHub renders an unset
  secret as an empty string, and tauri-bundler's `var_os("APPLE_CERTIFICATE")`
  reads `Some("")` as "signing is configured", then fails the whole bundle
  step running `security import` on an empty certificate.
- **Configure Windows code signing** picks a mode and writes the overlay.
- **Import Linux signing key** loads the GPG key and sets the AppImage/RPM
  signing variables.
- Verification steps per OS: `codesign`/`spctl`/`stapler` on macOS,
  `Get-AuthenticodeSignature` on Windows, `--appimage-signature`/`rpm -K` on
  Linux. Signing that silently did nothing is caught before publish.
- `check-changelog` blocks the release unless `CHANGELOG.md` has a heading for
  the tag being released.

### Local verification

```bash
# macOS, after `pnpm tauri build --config src-tauri/tauri.macos.conf.json`
codesign --verify --deep --strict --verbose=2 "…/bundle/macos/MyApp.app"
spctl -a -vvv -t install "…/bundle/dmg/MyApp_1.0.0_aarch64.dmg"
xcrun stapler validate "…/bundle/dmg/MyApp_1.0.0_aarch64.dmg"

# Windows
Get-AuthenticodeSignature "…\bundle\nsis\MyApp_1.0.0_x64-setup.exe" | Format-List

# Linux
"…/bundle/appimage/MyApp_1.0.0_amd64.AppImage" --appimage-signature
rpm -K "…/bundle/rpm/MyApp-1.0.0-1.x86_64.rpm"
```
