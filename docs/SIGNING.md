# Code Signing & Notarization

This document covers **distribution code signing** — making the OS trust the
installer (macOS Gatekeeper, Windows SmartScreen). It is separate from the
Tauri **updater** minisign key documented in
[`SIGNING_KEY.md`](./SIGNING_KEY.md); both are needed for a fully trusted
auto-updating release, but they are different mechanisms:

| Mechanism            | Purpose                                  | Secrets                                              |
| -------------------- | ---------------------------------------- | --------------------------------------------------- |
| Updater (minisign)   | Updater trusts the downloaded artifact   | `TAURI_SIGNING_PRIVATE_KEY[_PASSWORD]`              |
| macOS code signing   | Gatekeeper trusts the `.app`/`.dmg`      | `APPLE_CERTIFICATE`, `APPLE_SIGNING_IDENTITY`, …    |
| Windows code signing | SmartScreen trusts the `.msi`/`.exe`     | `WINDOWS_CERTIFICATE_THUMBPRINT` (or Azure)         |

**Everything here is optional.** When the secrets are absent the release
workflow still builds and uploads **unsigned** artifacts (Gatekeeper /
SmartScreen will warn users, but the binaries are valid). Nothing hard-requires
the signing secrets.

The release job reads these via `env:` in
`.github/workflows/release-with-updater.yml`; `tauri-action` forwards them to
the Tauri bundler, which only signs/notarizes when a credential set is present.

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

### 1.6 Hardened runtime + the bundled dylib

`tauri.conf.json`/`tauri.macos.conf.json` set `"hardenedRuntime": true` and
`"entitlements": "entitlements.plist"`. The entitlements file
(`apps/desktop/src-tauri/entitlements.plist`) is required because:

- **WebKit JIT:** `com.apple.security.cs.allow-jit` +
  `allow-unsigned-executable-memory` — the webview crashes under hardened
  runtime without them.
- **Bundled third-party dylib:**
  `com.apple.security.cs.disable-library-validation` lets the notarized binary
  load `resources/libappleai.dylib` (the `tauri-apple-intelligence` bridge,
  added as a resource in `tauri.macos.conf.json` and `dlopen`ed via `@rpath`).
  Without it the app aborts with a code-signature failure the first time Apple
  Intelligence is used.

Tauri re-signs bundled resources/frameworks with your Developer ID during the
bundle step, then notarizes the whole `.app`. No manual `codesign` calls are
needed.

### 1.7 Verify a signed build locally

```bash
# After `pnpm tauri build --config src-tauri/tauri.macos.conf.json`:
codesign --verify --deep --strict --verbose=2 \
  "src-tauri/target/release/bundle/macos/anasa.app"
spctl -a -vvv -t install "src-tauri/target/release/bundle/macos/anasa.app"
xcrun stapler validate "src-tauri/target/release/bundle/macos/anasa.app"
```

---

## 2. Windows

The Windows bundle config (`tauri.windows.conf.json`) reads the certificate from
config, not from raw env. There are two supported paths; both leave the
committed config as a safe no-op (`certificateThumbprint: null` → unsigned) until
a thumbprint is injected at release time.

> The user is on macOS, so Windows signing is documentation-only here. The
> committed config builds **unsigned** Windows artifacts. Wire one of the
> options below when a Windows code-signing certificate is acquired.

### Option A — OV/EV certificate by thumbprint (SignTool)

For a standard Authenticode certificate already installed in the Windows
certificate store of a Windows runner:

1. Import the `.pfx` into the runner's store and read its SHA-1 thumbprint:

   ```powershell
   $cert = Import-PfxCertificate -FilePath cert.pfx -CertStoreLocation Cert:\CurrentUser\My `
     -Password (ConvertTo-SecureString -String $env:WINDOWS_CERTIFICATE_PASSWORD -AsPlainText -Force)
   $cert.Thumbprint   # 40 hex chars, no spaces
   ```

2. Surface it to the bundler. Tauri reads `certificateThumbprint` from the
   config; inject it at build time **without committing it** by overriding the
   config on the command line, e.g. add a per-release config override or pass
   `--config` with a tiny generated JSON that sets:

   ```jsonc
   { "bundle": { "windows": { "certificateThumbprint": "<THUMBPRINT>" } } }
   ```

   The committed `timestampUrl` is already `http://timestamp.digicert.com`, so
   signatures are timestamped (they remain valid after the cert expires). EV
   certificates additionally require the token/HSM the cert lives on to be
   accessible to SignTool on the runner.

GitHub secrets for this path:

- `WINDOWS_CERTIFICATE` = base64 of the `.pfx`
- `WINDOWS_CERTIFICATE_PASSWORD` = the `.pfx` password
- `WINDOWS_CERTIFICATE_THUMBPRINT` = the SHA-1 thumbprint

### Option B — Azure Trusted Signing (recommended, no physical cert)

[Azure Trusted Signing](https://learn.microsoft.com/azure/trusted-signing/) is a
managed service — no HSM/token, certificates rotate automatically, and it's the
modern path for new projects.

1. Provision a Trusted Signing account + certificate profile in Azure and grant
   a service principal the **Trusted Signing Certificate Profile Signer** role.
2. Use a `customSignCommand` in the Windows bundle config that invokes the
   Trusted Signing dlib via `dotnet sign` / `Invoke-TrustedSigning`, reading the
   Azure credentials from env (do **not** hardcode them):

   ```jsonc
   {
     "bundle": {
       "windows": {
         "signCommand": "trusted-signing-cli -e %AZURE_ENDPOINT% -a %AZURE_CODE_SIGNING_NAME% -c %AZURE_CERT_PROFILE_NAME% %1"
       }
     }
   }
   ```

GitHub secrets for this path (consumed by the sign command, never committed):

- `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` — service principal
- `AZURE_ENDPOINT`, `AZURE_CODE_SIGNING_NAME`, `AZURE_CERT_PROFILE_NAME`

---

## 3. GitHub secrets summary

Set under **Settings → Secrets and variables → Actions**. Every one is optional;
omit a group to skip that signing/notarization step.

### Updater (already configured — see SIGNING_KEY.md)

| Secret                                | Required for       |
| ------------------------------------- | ------------------ |
| `TAURI_SIGNING_PRIVATE_KEY`           | Auto-update sigs   |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`  | Auto-update sigs   |

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

### Windows signing — pick ONE method

| Method            | Secrets                                                                                            |
| ----------------- | -------------------------------------------------------------------------------------------------- |
| OV/EV thumbprint  | `WINDOWS_CERTIFICATE`, `WINDOWS_CERTIFICATE_PASSWORD`, `WINDOWS_CERTIFICATE_THUMBPRINT`             |
| Azure Trusted Signing | `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_ENDPOINT`, `AZURE_CODE_SIGNING_NAME`, `AZURE_CERT_PROFILE_NAME` |

---

## 4. What runs in CI

`.github/workflows/release-with-updater.yml`:

- The matrix passes `--config src-tauri/tauri.<os>.conf.json` per row so the
  per-OS bundle overrides (macOS entitlements + dylib resource, Windows signing
  block, Linux deb deps) actually apply.
- The **Materialize Apple API key** step decodes `APPLE_API_KEY_BASE64` to a file
  on macOS runners and exposes `APPLE_API_KEY_PATH`.
- `tauri-action` receives all `APPLE_*` env and signs/notarizes only when a full
  credential set is present; otherwise it ships unsigned artifacts.
- `check-changelog` blocks the release unless `CHANGELOG.md` has a heading for
  the tag being released. Add a `## [X.Y.Z]` entry before tagging.
