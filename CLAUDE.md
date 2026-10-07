# Hochdeutsch-Fixer (Chromium)

This is the Chromium port of `AuroraNoUnderscores/hochdeutsch-fixer` (Firefox).
The two repos ship together:

- **The same version, always.** Every change, here or there, is released in both
  repos with the same version in both `manifest.json` files, even when only one
  side's files changed.
- **Bug fixes and small features bump the patch** (3.6.1 → 3.6.2). The minor
  version goes up only for a really large update, and only when the owner asks
  for it.
- **Shared files are changed in the Firefox repo first.** `sync.sh` lists them
  and copies them here; a change made only here is undone by the next sync.
- **One branch, one PR per repo,** with the same branch name, opened together,
  each linking to the other, and merged together.
- **Before pushing, run `tools/check_sync.sh`** (with the Firefox repo at
  `../hochdeutsch-fixer`). It must say "in step".
