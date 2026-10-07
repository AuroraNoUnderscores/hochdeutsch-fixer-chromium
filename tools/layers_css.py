"""pdf.js's text and link layers need its CSS; take those rules from the Firefox
viewer's stylesheet (sync.sh), balanced braces and all. Writes pdfjs/layers.css."""
import sys
from pathlib import Path

src = Path(sys.argv[1]).read_text(encoding='utf-8')
out = []
for sel in ('.textLayer{', '.annotationLayer{'):
    i = src.index(sel)
    depth, j = 0, i
    while True:
        c = src[j]
        if c == '{': depth += 1
        elif c == '}':
            depth -= 1
            if depth == 0: break
        j += 1
    out.append(src[i:j + 1])
Path(sys.argv[2]).write_text('/* From pdf.js (Apache-2.0), via the Firefox build: its text and link layers. */\n' + '\n\n'.join(out) + '\n', encoding='utf-8')
