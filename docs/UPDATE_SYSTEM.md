# The End-to-End Update System

The canonical update-system design for kit-consuming apps, synthesized from
two corpus studies (~36 Tauri apps: the email-related corpus and the
tauri-based fleet) plus anasa's shipped implementation. UI/UX carries the same
weight as engineering: an update engine users don't discover, can't defer, or
that restarts over their work is a failed update engine.

Reference implementation: anasa (`apps/desktop/src-tauri/src/commands/update.rs`,
`packages/services/src/update-service.ts`,
`apps/desktop/src/components/settings/updates-settings.tsx`). A portable,
framework-light port ships in the `tauri-scaf` template.

## Mechanism (Rust)

- **Download-now / install-on-exit — never install in place.** Replacing a
  live bundle invalidates the running process's macOS code signature (XPC/
  NSOpenPanel breakage, Tauri #13047). Download + signature-verify into
  managed state (`PendingUpdate`); `Update::install` runs from the
  `RunEvent::ExitRequested` handler. Restart is a *separate, user-chosen*
  action (`relaunch()`).
- **Runtime per-channel endpoints** (`updater_builder().endpoints(...)`) —
  stable / beta / alpha resolve to the kit's rolling manifests:
  stable → `releases/latest/download/latest.json`,
  prerelease → `releases/download/latest-<channel>/latest.json`. The JS
  `check()` API can't switch URLs per call; Rust owns the loop.
- **Typed, throttled progress events** (~100 ms) with `total_bytes:
  Option<u64>` so the UI can render indeterminate when Content-Length is
  absent.
- **Distribution-policy gate**: on Linux only AppImage self-updates
  (`APPIMAGE` env set, `FLATPAK_ID` absent); deb/rpm/Flatpak installs get a
  "update via your package manager" UI state instead of a checker that can
  never work. Homebrew casks must set `auto_updates true` (the kit's cask
  job does) so brew never fights the in-app updater.
- **Pre-commit size**: the kit manifest carries a per-platform `size`
  (bytes) extension; the check command reads it so the UI can say
  "Download Update (42.3 MB)" *before* the user commits.
- **Staged-state query** (`update_staged`) so UI remounts and ambient
  indicators can restore "restart to update" state.

## Flow

- **One gated background cycle** (`maybeBackgroundCheck`) shared by startup,
  the interval timer, and focus/online catch-up listeners: wall-clock gate on
  persisted `lastChecked` (a fresh boot doesn't re-poll if yesterday's tick
  did), re-entrancy guard, silent on all expected non-results. Never advance
  the gate on failure semantics: failures don't notify, the next tick retries.
- **Silent-on-auto, loud-on-manual**: background checks never say "you're up
  to date"; manual checks (Settings button, native menu item) always answer,
  and bypass all suppression.
- **Tiered deferral, persisted**: "Skip this version" (per-version; a newer
  release clears stale skips automatically) and "Remind me later" (time
  window). "Later" never means "never", and the app never nags about a
  version the user declined.
- **Auto-download stages only.** A background path must never `relaunch()` —
  that discards the user's working state. The staged bundle installs on the
  next natural quit.
- **Unsaved-work safety before restart**: the explicit restart button relies
  on (and the copy promises) the app's save-on-unload path. If the app has no
  autosave, gate the restart on a save-all.

## UI/UX — three coordinated surfaces

1. **Ambient indicator** (status-bar pill): "Update available" / "Update
   ready", persists after toasts are dismissed, never blocks, opens the
   settings panel. Discovery must not depend on catching one notification.
2. **Non-blocking notification** on background detection, with a deep-link
   action into the settings panel. Persistent duration, dismissible.
3. **Settings panel** — the full surface: current version + channel, channel
   picker, auto-check/interval/auto-download preferences, last-checked time,
   Check Now, and the update card:
   - available → rendered release notes (the kit publishes the tag's
     CHANGELOG section as the release body → `update.body`; render it like
     the in-app changelog, never as a raw text blob) + **Download (size)** +
     **Skip this version**
   - downloading → percent + `MB / MB` progress, indeterminate fallback
   - staged → "installs when you quit — or restart now" + **Restart to
     Update** (the two-phase pattern: download when convenient, restart when
     *the user* chooses)
   - error → friendly taxonomy (network / not-found / signature / disk) with
     **Retry** where retrying makes sense; a signature failure is
     deliberately not retryable-styled and says the download was discarded
   - managed install → package-manager notice instead of the checker
   - `aria-live="polite"` on state regions; no live region on the raw
     percent ticker (announcing every tick is hostile).
4. **Post-update What's New**: on first launch after an update, show the
   release notes once (version-stamped gate).

## CI / release (the kit side)

- Release body = the tag's CHANGELOG section (extracted by create-release) —
  it feeds the release page AND `update.body`.
- Manifest `size` per platform; deterministic tag-path URLs (never draft
  asset URLs); verify-release fails before publish on missing
  signatures/platforms.
- Anti-patterns the pipeline structurally prevents: placeholder pubkeys
  (scaffold CI guard), GitHub-API-endpoint polling (rate limits), unsigned
  hand-rolled downloaders, mandatory startup update modals.

## Deliberate non-goals

Delta/differential updates, rollback/downgrade UI, and a custom update
server (staged rollouts) — revisit when scale demands; the design keeps the
manifest layer swappable for a server that does server-side semver diff.
