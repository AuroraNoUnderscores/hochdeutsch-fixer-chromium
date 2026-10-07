#!/usr/bin/env bash
# Copy the shared logic from the Firefox repo. Everything listed here is
# byte-identical on both sides; the rest of this folder is the Chromium shell.
set -euo pipefail
src="${1:-../hochdeutsch-fixer}"
files="dictionary.js morph.js coverage.js german_too.js engine.js llm.js content.js popup.js test.js test.html pdftext.js pdfhooks.mjs"
for f in $files; do
  cp "$src/$f" "./$f"
  echo "synced $f"
done
cp "$src"/dev/*.html "$src"/dev/*.js dev/
echo "synced dev fixtures"
rm -rf models && cp -r "$src/models" models
echo "synced models"
# pdf.js itself (with the text hooks, see tools/sync_pdfjs.py there), not the
# Firefox viewer around it: here Chrome's viewer is used (tools/sync_chrome_pdf.py)
rm -rf pdfjs && mkdir -p pdfjs/web
cp -r "$src/pdfjs/build" pdfjs/build
for d in cmaps standard_fonts iccs wasm; do cp -r "$src/pdfjs/web/$d" "pdfjs/web/$d"; done
cp "$src/pdfjs/VERSION" pdfjs/VERSION
py tools/layers_css.py "$src/pdfjs/web/viewer.windows.css" pdfjs/layers.css
mkdir -p dev/pdf && cp "$src"/dev/pdf/*.pdf "$src"/dev/pdf/*.html "$src"/dev/pdf/*.mjs "$src"/dev/pdf/make.py dev/pdf/
echo "synced pdf.js and the test PDFs"
