#!/usr/bin/env bash
# Copy the shared logic from the Firefox repo. Everything listed here is
# byte-identical on both sides; the rest of this folder is the Chromium shell.
set -euo pipefail
src="${1:-../hochdeutsch-fixer}"
files="dictionary.js morph.js coverage.js engine.js llm.js content.js popup.js test.js test.html"
for f in $files; do
  cp "$src/$f" "./$f"
  echo "synced $f"
done
cp "$src"/dev/*.html "$src"/dev/*.js dev/
echo "synced dev fixtures"
rm -rf models && cp -r "$src/models" models
echo "synced models"
