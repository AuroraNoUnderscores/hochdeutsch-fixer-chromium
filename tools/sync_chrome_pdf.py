"""Copy Chrome's own PDF viewer interface into pdfviewer/, so that PDFs shown by
this extension look and behave like Chrome's.

Chrome's viewer is a component extension (its toolbar, sidebar, zoom and page
indicator) drawing on top of the PDF plugin. Its files are taken from a running
Chrome, so they are that Chrome's version: Chrome opens a small PDF headless,
and the viewer's frame hands over every file it loaded and the strings it was
given, once per UI language Chrome has. Rerun after a Chrome update:

    CHROME=path/to/chrome.exe py tools/sync_chrome_pdf.py [--files-only]

(Chrome for Testing works: https://googlechromelabs.github.io/chrome-for-testing/)

Chrome writes the user's language into some files as it serves them (labels,
menus, dialogs, the UI font). Those files are taken instead from Chrome's
resources.pak as they are before that, and each such place reads the string at
run time (__hdfxI18n in pdfplugin.mjs; the font as a CSS variable), so the
viewer speaks every language Chrome has, not only the one it was copied in.

Then a few checked patches (each must match exactly once):
- chrome://resources/ imports point to the copied files (pdfviewer/res_*);
- icons in the styles become data: URLs;
- the plugin the viewer creates is pdfplugin.mjs's (createPlugin_), which
  draws the pages with pdf.js and the converted text.
- the viewer focuses that plugin element where it would focus its <embed>.
Chrome's viewer is BSD-licensed (the Chromium Authors).
"""
import base64, functools, gzip, html, http.server, json, os, re, shutil, struct, sys, threading, time, urllib.parse, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'pdfviewer'
sys.path.insert(0, str(Path(__file__).parent))
import cdp

EXT = 'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/'
# a one-page PDF to open, made by hand
PDF = (b"%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n"
       b"3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n")


def serve():
    class H(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200); self.send_header('Content-Type', 'application/pdf'); self.end_headers(); self.wfile.write(PDF)
        def log_message(self, *a): pass
    s = http.server.ThreadingHTTPServer(('127.0.0.1', 0), H)
    threading.Thread(target=s.serve_forever, daemon=True).start()
    return s


def viewer_socket(port):
    for _ in range(40):
        for t in json.load(urllib.request.urlopen(f'http://127.0.0.1:{port}/json')):
            if t['url'].startswith(EXT):
                return cdp.Socket(t['webSocketDebuggerUrl'])
        time.sleep(0.25)
    raise RuntimeError('the PDF viewer did not open')


def capture(url, lang, files=False):
    c = cdp.Chrome(port=9336, args=[f'--lang={lang}'])
    try:
        c.nav(url)
        s = viewer_socket(9336)
        ev = lambda e: c.cmd('Runtime.evaluate', {'expression': e, 'returnByValue': True, 'awaitPromise': True}, sock=s)['result'].get('value')
        for _ in range(40):
            if ev("!!document.querySelector('pdf-viewer')?.strings"): break
            time.sleep(0.25)
        out = {'version': json.load(urllib.request.urlopen('http://127.0.0.1:9336/json/version'))['Browser'],
               'strings': ev("document.querySelector('pdf-viewer').strings"),
               'attrs': ev("Object.fromEntries([...document.documentElement.attributes].map(a => [a.name, a.value]))")}
        if files:
            c.cmd('Page.enable', sock=s)
            tree = c.cmd('Page.getResourceTree', sock=s)['frameTree']
            fid = tree['frame']['id']
            out['files'] = {}
            for u in [tree['frame']['url']] + [r['url'] for r in tree['resources']]:
                r = c.cmd('Page.getResourceContent', {'frameId': fid, 'url': u}, sock=s)
                out['files'][u] = base64.b64decode(r['content']).decode() if r['base64Encoded'] else r['content']
            # images the styles name, fetched by the viewer itself
            names = sorted(set(re.findall(r'chrome://resources/images/[\w./-]+\.svg', ''.join(out['files'].values()))))
            out['images'] = {}
            for n in names:      # opened as pages of their own: the viewer may not fetch them
                c.nav(n)
                out['images'][n] = c.js("new XMLSerializer().serializeToString(document.documentElement)")
        return out
    finally:
        c.close()


def local(u):
    """chrome://resources/js/assert.js -> res_js_assert.js; viewer files keep their names."""
    if u.startswith(EXT): return u[len(EXT):] or 'index.html'
    return 'res_' + u[len('chrome://resources/'):].replace('/', '_')


def join(base, spec):
    """A relative import resolved against a chrome:// URL (urljoin does not know the scheme)."""
    if '://' in spec: return spec
    parts = base.split('/')[:-1]
    for p in spec.split('/'):
        if p == '..': parts.pop()
        elif p != '.': parts.append(p)
    return '/'.join(parts)


PLACE = re.compile(r'\$i18n(Raw)?\{(\w+)\}')


def pak_texts(path):
    """The gzip-compressed text entries of a Chromium .pak file."""
    data = Path(path).read_bytes()
    if struct.unpack_from('<I', data)[0] == 5:
        count, pos = struct.unpack_from('<IIHH', data)[2], 12
    else:
        count, pos = struct.unpack_from('<IIB', data)[1], 9
    offs = [struct.unpack_from('<HI', data, pos + 6 * i)[1] for i in range(count + 1)]
    for a, b in zip(offs, offs[1:]):
        if data[a:a + 2] == b'\x1f\x8b':
            try: yield gzip.decompress(data[a:b]).decode()
            except (OSError, UnicodeDecodeError): pass


def unlocalized(files, strings):
    """{url: the file as it is before Chrome writes the strings into it}, for the
    files it does that to."""
    esc = lambda s: html.escape(s, quote=True).replace('&#x27;', '&#39;')
    fill = lambda raw: PLACE.sub(lambda m: strings[m.group(2)] if m.group(1) else esc(strings[m.group(2)]), raw)
    raws = [r for r in pak_texts(Path(cdp.CHROME).parent / 'resources.pak') if '$i18n' in r]
    out = {}
    for u, text in files.items():
        if local(u).endswith('.html'):      # not used: pdfview.js builds the page
            continue
        for r in raws:
            if abs(len(r) - len(text)) < 20000 and all(m.group(2) in strings for m in PLACE.finditer(r)) and fill(r) == text:
                out[u] = r
                break
    return out


def runtime_strings(name, raw):
    """Each $i18n{key} as a lookup when the viewer runs. In the scripts they all
    stand in lit html`` templates (checked), where ${...} is a binding."""
    def js(m):
        before = raw[:m.start()]
        assert before.rfind('<!--_html_template_start_-->') > before.rfind('<!--_html_template_end_-->'), \
            f'{name}: {m.group(0)} outside an html template'
        return '${globalThis.__hdfxI18n(' + json.dumps(m.group(2)) + ')}'
    if name.endswith('.js'):
        return PLACE.sub(js, raw)
    if name.endswith('.css'):
        return PLACE.sub(lambda m: f'var(--hdfx-i18n-{m.group(2)})', raw)
    raise AssertionError(f'{name}: strings in a file of this kind')


def patch(text, old, new, name):
    n = text.count(old)
    assert n == 1, f'{name}: expected one {old[:60]!r}, found {n}'
    return text.replace(old, new)


def main():
    if not cdp.CHROME or not Path(cdp.CHROME).exists():
        sys.exit('Set CHROME to a chrome.exe (Chrome for Testing works).')
    server = serve()
    url = f'http://127.0.0.1:{server.server_port}/doc.pdf'
    first = capture(url, 'en-US', files=True)
    files_only = '--files-only' in sys.argv      # keep the strings already copied
    keep = {p.name: p.read_bytes() for p in (OUT / 'strings').glob('*.json')} if files_only else {}
    if OUT.exists(): shutil.rmtree(OUT)
    (OUT / 'strings').mkdir(parents=True)
    for n, b in keep.items(): (OUT / 'strings' / n).write_bytes(b)

    files = first['files']
    raw = unlocalized(files, first['strings'])
    print('per-language at run time:', ', '.join(local(u) for u in raw))
    for u, text in files.items():
        name = local(u)
        if u in raw:
            text = runtime_strings(name, raw[u])
        if name.endswith('.js'):
            # every import, absolute or relative to where the file was, to the copied file
            def to_local(m):
                spec = m.group(2)
                if spec.startswith('chrome://resources/') or (spec.startswith('.') and u.startswith('chrome://resources/')):
                    return m.group(1) + './' + local(join(u, spec)) + m.group(3)
                return m.group(0)
            text = re.sub(r'''((?:from|import)\s*\(?\s*["'])([^"']+\.js)(["'])''', to_local, text)
            for dep in set(re.findall(r'chrome://resources/[\w./-]+\.js', text)):
                text = text.replace(dep, './' + local(dep))
        for img, svg in first['images'].items():
            if svg: text = text.replace(img, 'data:image/svg+xml;base64,' + base64.b64encode(svg.encode()).decode())
        if name == 'pdf_viewer_wrapper.js':     # the plugin is pdfplugin.mjs's element, not an <embed>
            text = patch(text, 'this.shadowRoot.querySelector("embed").focus()', 'this.shadowRoot.querySelector("embed,#plugin").focus()', name)
        if name == 'shared.rollup.js':
            text = patch(text, 'createPlugin_(){const plugin=document.createElement("embed");',
                         'createPlugin_(){if(globalThis.__hdfxPlugin)return globalThis.__hdfxPlugin(this);const plugin=document.createElement("embed");', name)
        (OUT / name).write_text(text, encoding='utf-8')
    code = lambda t: re.sub(r'/\*.*?\*/', '', t, flags=re.S)       # comments may name them
    left = [n for n in os.listdir(OUT) if n.endswith(('.js', '.css')) and 'chrome://resources/' in code((OUT / n).read_text(encoding='utf-8'))]
    assert not left, f'still importing chrome://resources: {left}'
    # the copies hold no language of their own (index.html is not used: pdfview.js builds the page)
    english = [n for n in ('pdf_viewer_wrapper.js', 'shared.rollup.js') if 'Rotate counterclockwise' in (OUT / n).read_text(encoding='utf-8')]
    assert not english, f'English written in: {english}'

    langs = sorted(p.stem for p in (Path(cdp.CHROME).parent / 'locales').glob('*.pak') if '_' not in p.stem)
    for lang in ([] if files_only else langs):
        got = first if lang == 'en-US' else capture(url, lang)
        (OUT / 'strings' / f'{lang}.json').write_text(json.dumps({'attrs': got['attrs'], 'strings': got['strings']}, ensure_ascii=False, indent=0), encoding='utf-8')
        print(lang, len(got['strings']), flush=True)
    (OUT / 'VERSION').write_text(f"Chrome's PDF viewer from {first['version']}\n")
    server.shutdown()
    print(len(files), 'files,', len(langs), 'languages')


if __name__ == '__main__':
    main()
