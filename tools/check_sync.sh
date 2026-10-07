#!/usr/bin/env bash
# Is this folder in step with the Firefox repo? The files sync.sh copies must
# be byte-identical, and both manifests must carry the same version.
set -uo pipefail
src="${1:-../hochdeutsch-fixer}"
files="dictionary.js morph.js coverage.js german_too.js engine.js llm.js content.js popup.js test.js test.html pdftext.js pdfhooks.mjs"
bad=0
for f in $files "$src"/dev/pdf/*.mjs; do
  f="${f#"$src"/}"
  cmp -s "$src/$f" "./$f" || { echo "differs: $f"; bad=1; }
done
version() { sed -n 's/^ *"version": *"\(.*\)".*/\1/p' "$1/manifest.json"; }
ours=$(version .) theirs=$(version "$src")
[ "$ours" = "$theirs" ] || { echo "version: $ours here, $theirs in $src"; bad=1; }
[ $bad = 0 ] && echo "in step with $src (v$ours)"
exit $bad
