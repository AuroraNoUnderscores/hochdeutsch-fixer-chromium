#!/usr/bin/env bash
# Copy the shared logic from the Firefox repo. Everything listed here is
# byte-identical on both sides; the rest of this folder is the Chromium shell.
set -euo pipefail
src="${1:-../hochdeutsch-fixer}"
files="dictionary.js morph.js engine.js llm.js content.js popup.js test.js test.html"
for f in $files; do
  cp "$src/$f" "./$f"
  echo "synced $f"
done
cp "$src"/dev/{page.html,chch.html,meta.html,e2e.html,debug.html} dev/
echo "synced dev fixtures"
