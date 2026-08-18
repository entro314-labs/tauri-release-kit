# Contributing

Thanks for your interest in improving tauri-release-kit.

## Before changing the pipeline

Read [docs/GOTCHAS.md](docs/GOTCHAS.md) first. Every odd-looking step in
`release.yml` encodes a CI failure that actually happened on a shipped
release. A "simplification" that removes one of those steps will reintroduce
the failure it guards against — on someone's paid macOS runners.

If your change works around a new failure, add an entry to GOTCHAS.md
describing the failure mode, not just the fix.

## Testing changes

There is no test harness for a reusable workflow other than running it:

1. Push your change to a branch of your fork.
2. Point a consumer app's caller workflow at it:
   `uses: <you>/tauri-release-kit/.github/workflows/release.yml@<branch>`
3. Run the release with a throwaway prerelease tag (e.g. `v0.0.1-alpha.99`)
   against a scratch releases repo, or use `workflow_dispatch` with
   `build_targets` limited to one cheap leg (`linux-x86_64`) to iterate
   without burning macOS minutes.

For shell/script changes, `preflight/preflight.sh` can be exercised locally
against any Tauri app (see [preflight/README.md](preflight/README.md)).

## Pull requests

- Keep changes scoped; one failure mode or feature per PR.
- Conventional commit messages: `feat:`, `fix:`, `docs:`, `chore:`.
- Both workflows are consumed via `@main` — treat `main` as released.
  Breaking changes to workflow inputs need a callout in the PR description
  and a README update in the same PR.
