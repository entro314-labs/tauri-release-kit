# App Store overlay templates

Copy these into `src-tauri/` of your app and adjust. They are merged over
`tauri.conf.json` by the `--config` flag, so nothing here leaks into the
Developer ID build you ship to direct downloaders.

| File | Goes to | Purpose |
| --- | --- | --- |
| `tauri.appstore.conf.json` | `src-tauri/tauri.appstore.conf.json` | App Store bundle overlay |
| `Entitlements.appstore.plist` | `src-tauri/Entitlements.appstore.plist` | App Sandbox + team identifiers |
| `Entitlements.plist` | `src-tauri/Entitlements.plist` | Hardened-runtime entitlements for the Developer ID build |
| `Info.plist` | `src-tauri/Info.plist` | Encryption-export declaration + usage strings |

Things you MUST edit before submitting:

- `bundle.category` — an [Apple app category] your app actually belongs to.
- `$TEAM_ID` and `$IDENTIFIER` in `Entitlements.appstore.plist`.
- `ITSAppUsesNonExemptEncryption` in `Info.plist` — `false` only if your app
  uses no encryption beyond what Apple exempts (HTTPS counts as exempt).
- Every `NS*UsageDescription` your app does not need: delete it. An unused
  usage string is a review question you do not want to answer.

The App Store overlay deliberately does NOT disable the updater plugin in
config — Tauri has no config switch for that. Gate the update check in your
app instead (a `cfg!` feature, or an env/`tauri.conf.json` flag your code
reads), because a self-updating app is rejected under App Store review
guideline 2.4.5(iv), and the sandbox blocks the install anyway.

[Apple app category]: https://developer.apple.com/documentation/bundleresources/information-property-list/lsapplicationcategorytype
