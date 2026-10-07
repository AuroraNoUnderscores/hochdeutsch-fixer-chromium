"""End-to-end checks of the PDF viewer, in a headless Chrome for Testing with
the extension loaded (tools/cdp.py), against Chrome's own viewer where they
can be compared. Serves this folder itself; needs nothing but Python.

    CHROME=path/to/chrome.exe py tools/pdf_check.py

The test PDFs are in dev/pdf/ (made by dev/pdf/make.py in the Firefox repo).
"""
import functools, glob, http.server, json, os, struct, sys, tempfile, threading, time, urllib.parse, urllib.request, zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).parent))
import cdp

VIEWER_EXT = 'mhjfbmdgcfjbbpaeojofohoefgiehjai'     # Chrome's own PDF viewer
DEEP = ("const DEEP = (sel, root = document) => { const out = []; const walk = r => { out.push(...r.querySelectorAll(sel));"
        " r.querySelectorAll('*').forEach(e => e.shadowRoot && walk(e.shadowRoot)); }; walk(root); return out; };")
READY = "DEEP('.page').length > 0 && DEEP('.textLayer').length === DEEP('.page').length && DEEP('.page canvas:not(.ink)').length > 0"
TEXT = "DEEP('.textLayer').map(t => t.textContent).join(' ')"
LABELS = "DEEP('cr-icon-button').filter(b => b.getBoundingClientRect().width).map(b => b.getAttribute('aria-label'))"
GEOMETRY = "JSON.stringify({ d: v.documentDimensions, z: v.viewport.getZoom(), pos: v.viewport.position })"
STEPS = [('as opened', ''), ('two pages side by side', 'v.onTwoUpViewChanged_({ detail: true })'),
         ('back to one page', 'v.onTwoUpViewChanged_({ detail: false })'), ('rotated', 'v.rotateClockwise()'),
         ('zoomed to 150%', 'v.viewport.setZoom(1.5)')]

failures = []
def check(name, ok, detail=''):
    print(('ok    ' if ok else 'FAIL  ') + name + (f'  ({detail})' if detail and not ok else ''), flush=True)
    if not ok: failures.append(name)


class Quiet(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store'); super().end_headers()
    def log_message(self, *a): pass


class Server(http.server.ThreadingHTTPServer):
    def handle_error(self, request, client_address): pass     # Chrome closing connections it no longer needs


def pixels(path):
    """A screenshot's rows of RGB(A) bytes (8-bit PNG, not interlaced)."""
    data = open(path, 'rb').read()
    pos, idat, w = 8, b'', 0
    while pos < len(data):
        n, kind = struct.unpack('>I4s', data[pos:pos + 8])
        body = data[pos + 8:pos + 8 + n]
        if kind == b'IHDR': w, h, depth, color = struct.unpack('>IIBB', body[:10])
        elif kind == b'IDAT': idat += body
        pos += 12 + n
    bpp = {2: 3, 6: 4}[color]
    raw, rows, prev = zlib.decompress(idat), [], bytearray(w * bpp)
    for y in range(h):
        f, line = raw[y * (w * bpp + 1)], bytearray(raw[y * (w * bpp + 1) + 1:(y + 1) * (w * bpp + 1)])
        for i in range(len(line)):
            a = line[i - bpp] if i >= bpp else 0
            b, c = prev[i], prev[i - bpp] if i >= bpp else 0
            if f == 1: line[i] = (line[i] + a) & 255
            elif f == 2: line[i] = (line[i] + b) & 255
            elif f == 3: line[i] = (line[i] + (a + b) // 2) & 255
            elif f == 4:
                p = a + b - c; pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                line[i] = (line[i] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
        rows.append(bytes(line)); prev = line
    return rows


class Browser:
    """One Chrome; js() runs in the PDF viewer, ours or Chrome's own."""
    def __init__(self, ours=True, port=9350, args=()):
        self.port = port
        self.c = cdp.Chrome(extension=str(ROOT) if ours else None, port=port, args=args)
        self.ours, self.viewer = ours, None
        time.sleep(1.5)

    def open(self, url, wait=8):
        self.viewer = None
        self.c.nav(url)
        if self.ours:
            return self.wait(READY, wait * 3)
        time.sleep(wait)
        for t in json.load(urllib.request.urlopen(f'http://127.0.0.1:{self.port}/json')):
            if VIEWER_EXT in t['url'] and t['type'] != 'background_page':
                self.viewer = cdp.Socket(t['webSocketDebuggerUrl'])
        return self.viewer is not None

    def js(self, expr):
        r = self.c.cmd('Runtime.evaluate', {'expression': f'(async () => {{ {DEEP} const v = document.querySelector("pdf-viewer"); return ({expr}); }})()',
                                            'returnByValue': True, 'awaitPromise': True}, sock=self.viewer)
        if 'exceptionDetails' in r: raise RuntimeError(r['exceptionDetails'].get('exception', {}).get('description', r['exceptionDetails']['text']))
        return r['result'].get('value')

    def wait(self, expr, timeout=20):
        end = time.time() + timeout
        while time.time() < end:
            try:
                if self.js(expr): return True
            except RuntimeError: pass
            time.sleep(0.3)
        return False

    def errors(self):
        return [l for l in self.c.logs() if ('rror' in l or l.startswith('EXC')) and 'favicon.ico' not in l]

    def close(self): self.c.close()


def click(b, x, y):
    for kind in ('mousePressed', 'mouseReleased'):
        b.c.cmd('Input.dispatchMouseEvent', {'type': kind, 'x': x, 'y': y, 'button': 'left', 'clickCount': 1, 'buttons': int(kind == 'mousePressed')})


def drag(b, x0, y0, x1, y1, steps=12):
    """The mouse pressed at one point and let go at another."""
    send = lambda kind, x, y, **k: b.c.cmd('Input.dispatchMouseEvent', {'type': kind, 'x': x, 'y': y, 'button': 'left', **k})
    send('mouseMoved', x0, y0)
    send('mousePressed', x0, y0, clickCount=1, buttons=1)
    for k in range(1, steps + 1):
        send('mouseMoved', x0 + (x1 - x0) * k / steps, y0 + (y1 - y0) * k / steps, buttons=1)
    send('mouseReleased', x1, y1, clickCount=1)
    time.sleep(0.5)


def main():
    if not cdp.CHROME or not Path(cdp.CHROME).exists():
        sys.exit('Set CHROME to a chrome.exe (Chrome for Testing works).')
    server = Server(('127.0.0.1', 0), functools.partial(Quiet, directory=str(ROOT)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f'http://127.0.0.1:{server.server_port}/dev/pdf/'
    tmp = tempfile.mkdtemp(prefix='hdfx-pdf-')
    try:
        run(base, tmp)
        drawing(base, tmp)
        forms(base, tmp)
    finally:
        server.shutdown()
    print(f'\n{len(failures)} failed' if failures else '\nall passed')
    return 1 if failures else 0


def run(base, tmp):
    # 1. With nothing to convert, the extension's viewer is Chrome's: same toolbar
    #    to the pixel, same page layout in every view, same labels in German.
    #    (Saving to Google Drive needs the browser's account, so the extension's
    #    viewer has no button for it; Chrome's is compared without it too.)
    shots, geo, labels = {}, {}, {}
    for label, ours in [('chrome', False), ('extension', True)]:
        b = Browser(ours, args=['--disable-features=PdfSaveToDrive'])
        try:
            b.open(base + 'english.pdf'); time.sleep(3)
            shots[label] = pixels(b.c.shot(os.path.join(tmp, label + '.png')))
            if ours:
                check('viewer replaces the PDF at its own address', b.js('location.href') == base + 'english.pdf' and b.js("!!document.querySelector('pdf-viewer')"))
                check('title as Chrome sets it', b.js('document.title') == 'english.pdf', b.js('document.title'))
            b.open(base + 'sizes.pdf')
            geo[label] = []
            for step, code in STEPS:
                if code: b.js(f'({code}, 1)'); time.sleep(1.5)
                geo[label].append(json.loads(b.js(GEOMETRY)))
        finally: b.close()
        b = Browser(ours, args=['--lang=de'])
        try:
            b.open(base + 'english.pdf'); time.sleep(1)
            labels[label] = [l for l in b.js(LABELS) if 'Google Drive' not in l]
        finally: b.close()
    a, o = shots['chrome'], shots['extension']
    check('toolbar identical to Chrome\'s', a[:56] == o[:56], f"{sum(x != y for x, y in zip(a[:56], o[:56]))} rows differ")
    diff = sum(sum(abs(p - q) for p, q in zip(x, y)) for x, y in zip(a, o)) / (len(a) * len(a[0]))
    check('pages look like Chrome\'s', len(a) == len(o) and diff < 2.5, f'mean difference {diff:.2f} of 255')
    for (step, _), x, y in zip(STEPS, geo['chrome'], geo['extension']):
        check(f'pages laid out as Chrome lays them out: {step}', x == y, f'\n  chrome    {x}\n  extension {y}')
    check('labels in the user\'s language (German)', labels['chrome'] == labels['extension'] and 'Drucken' in labels['extension'],
          f"\n  chrome    {labels['chrome']}\n  extension {labels['extension']}")

    b = Browser(True)
    try:
        # 2. Converted, on screen and in the text layer.
        check('converted PDF opens', b.open(base + 'swiss-arial.pdf'))
        time.sleep(3)
        text = b.js(TEXT)
        for word in ['Fahranfänger', 'Führerschein', 'verbindliches Angebot', 'Bürgersteig', 'Straßenverkehrsamts', 'Sie kann innerhalb', 'Buße von 40 Franken', 'Große Teile']:
            check(f'text layer reads "{word}"', word in text)
        check('no Swiss words left in the text layer', not any(w in text for w in ['Neulenker', 'Trottoir', 'Offerte', 'Velo ']))
        errs = b.errors()
        check('no errors in the viewer', not errs, str(errs[:3]))

        # 3. Find: every page's text is there for Ctrl+F, converted.
        b.open(base + 'long.pdf'); time.sleep(4)
        pages = b.js("DEEP('.textLayer').filter(t => /Fahrrad\\d/.test(t.textContent)).length")
        check('all 30 pages searchable, converted', pages == 30, str(pages))
        check('finds converted words on a page not yet drawn', b.js("window.find('Fahrrad25', false, false, true)") is True)
        check('the Swiss original is not found', b.js("window.find('Velo25', false, false, true)") is False)

        # 4. Saving gives the original file.
        dl = os.path.join(tmp, 'downloads'); os.makedirs(dl)
        b.c.cmd('Browser.setDownloadBehavior', {'behavior': 'allow', 'downloadPath': dl}, sock=b.c.browser)
        b.open(base + 'swiss-arial.pdf')
        b.js("(delete window.showSaveFilePicker, DEEP('cr-icon-button#save').find(e => e.getAttribute('iron-icon') === 'cr:download').click(), 1)")
        for _ in range(40):
            files = glob.glob(dl + '/*')
            if files and not any(f.endswith('.crdownload') for f in files): break
            time.sleep(0.5)
        saved = glob.glob(dl + '/*')
        check('save gives the original PDF', len(saved) == 1 and open(saved[0], 'rb').read() == (ROOT / 'dev/pdf/swiss-arial.pdf').read_bytes(), str(saved))

        # 5. Print: every page goes to the printer, drawn with the converted text.
        b.js("(window.print = () => { window.__printed = DEEP('#hdfx-print img').length; }, 1)")
        b.js("(DEEP('cr-icon-button#print')[0].click(), 1)")
        check('print sends every page', b.wait('window.__printed === 2', 20), str(b.js('window.__printed')))

        # 6. Links: to a website, and to another page.
        b.open(base + 'links.pdf'); time.sleep(1)
        hrefs = b.js("DEEP('.links a').map(a => a.getAttribute('href'))")
        check('link to a website', 'https://example.com/' in hrefs, str(hrefs))
        b.js("(DEEP('.links a').find(a => a.getAttribute('href') === '#').click(), 1)")
        check('link to page 2 goes there', b.wait('v.viewport.getMostVisiblePage() === 1', 5))

        # 7. Ctrl and + zooms the document, as in Chrome.
        b.open(base + 'swiss-arial.pdf')
        z0 = b.js('v.viewport.getZoom()')
        for kind in ('rawKeyDown', 'keyUp'):
            b.c.cmd('Input.dispatchKeyEvent', {'type': kind, 'modifiers': 2, 'key': '=', 'code': 'Equal', 'windowsVirtualKeyCode': 187})
        check('Ctrl + zooms in', b.wait(f'v.viewport.getZoom() > {z0} + 0.01', 5), f'{z0} -> {b.js("v.viewport.getZoom()")}')

        # 8. A password-protected PDF asks for its password, then opens converted.
        b.c.nav(base + 'password.pdf')
        check('asks for the password', b.wait("DEEP('viewer-password-dialog').length > 0", 15))
        time.sleep(1)                       # the dialog puts the cursor in its field
        b.c.cmd('Input.insertText', {'text': 'hdfx'})
        for kind in ('rawKeyDown', 'char', 'keyUp'):
            b.c.cmd('Input.dispatchKeyEvent', {'type': kind, 'key': 'Enter', 'code': 'Enter', 'windowsVirtualKeyCode': 13, **({'text': '\r'} if kind == 'char' else {})})
        check('opens with the password, converted', b.wait(f"{READY} && /Fahrrad/.test({TEXT})", 20), (b.js(TEXT) or '')[:80])

        # 9. PDFs inside pages: iframe, embed, object (the same PDF twice).
        b.c.nav(base + 'embed.html'); time.sleep(8)
        tree = b.c.cmd('Page.getFrameTree')['frameTree']
        frames = {f['frame']['id'] for f in tree.get('childFrames', [])}
        got = []
        for e in b.c.events:
            ctx = e.get('params', {}).get('context', {}) if e.get('method') == 'Runtime.executionContextCreated' else {}
            if ctx.get('auxData', {}).get('frameId') in frames and ctx['auxData'].get('isDefault'):
                try:
                    r = b.c.cmd('Runtime.evaluate', {'expression': f'(() => {{ {DEEP} return {TEXT}; }})()', 'contextId': ctx['id'], 'returnByValue': True})
                    got.append(r['result'].get('value') or '')
                except RuntimeError: pass
        got = [g for g in got if g]
        check('iframe, embed and object PDFs converted', len(got) == 3 and all('Fahranfänger' in g or 'Krankenhaus' in g for g in got),
              str([g[:40] for g in got]))

        # 9b. A site's own pdf.js viewer (viewer.html?file=…, as Nextcloud and
        #     polybox show PDFs) is replaced before pdf.js starts, though the
        #     page's CSP allows it no worker; the drawn text is converted.
        b.c.nav(base + 'hosted.html?file=swiss-arial.pdf'); time.sleep(3)
        check('a site\'s pdf.js viewer is replaced', b.c.wait("!!document.querySelector('pdf-viewer')", 15))
        check('…before pdf.js ran', b.c.js("document.documentElement.dataset.pdfjsRan") is None)
        ok = b.c.wait(f"(() => {{ {DEEP} return /Fahranfänger/.test({TEXT}) && DEEP('.page canvas:not(.ink)').length > 0; }})()", 30)
        check('…and its PDF opens converted', ok)
        b.c.nav(base + 'hosted.html?file=plain.txt'); time.sleep(4)
        check('a file that is not a PDF is left to the site\'s viewer', b.c.wait("document.documentElement.dataset.pdfjsRan === 'yes' && !document.querySelector('pdf-viewer')", 10))
        b.c.nav(base + 'hosted.html?file=' + urllib.parse.quote('https://example.com/a.pdf', safe='')); time.sleep(2)
        check('a file from another site is left to the site\'s viewer', b.c.js("document.documentElement.dataset.pdfjsRan === 'yes' && !document.querySelector('pdf-viewer')"))

        # 10. Text that is not a PDF stays text: a page cannot pass itself off as one.
        b.c.nav(base + 'plain.txt'); time.sleep(2)
        check('plain text stays plain text', b.js("!document.querySelector('pdf-viewer') && document.body.innerText.trim() === 'hello'"))

        # 11. Switched off in the popup: Chrome's own viewer again.
        # this extension's worker: Vivaldi has service workers of its own
        sw = [t for t in json.load(urllib.request.urlopen(f'http://127.0.0.1:{b.port}/json'))
              if t['type'] == 'service_worker' and t['url'].startswith(f'chrome-extension://{b.c.ext}/')]
        s = cdp.Socket(sw[0]['webSocketDebuggerUrl'])
        b.c.cmd('Runtime.evaluate', {'expression': "chrome.storage.local.set({ pdf: false })", 'awaitPromise': True}, sock=s)
        time.sleep(1)
        b.c.nav(base + 'swiss-arial.pdf'); time.sleep(3)
        check('switched off: Chrome\'s own viewer', b.js("document.contentType") == 'application/pdf')
        b.c.cmd('Runtime.evaluate', {'expression': "chrome.storage.local.set({ pdf: true })", 'awaitPromise': True}, sock=s)
    finally:
        b.close()


def drawing(base, tmp):
    # 12. Drawing and text: a pen line on the page, undo and redo, a text box,
    #     then saved "with my changes" as Ink and FreeText annotations. (A browser of its own:
    #     Chrome holds back a tab's second download made without a save dialog.)
    dl = os.path.join(tmp, 'drawn'); os.makedirs(dl)
    b = Browser(True)
    try:
        b.c.cmd('Browser.setDownloadBehavior', {'behavior': 'allow', 'downloadPath': dl}, sock=b.c.browser)
        b.open(base + 'swiss-arial.pdf'); b.js("(delete window.showSaveFilePicker, 1)")
        b.js("(DEEP('cr-icon-button#annotate')[0].click(), 1)"); time.sleep(1.5)
        r = b.js("(() => { const r = DEEP('.page')[0].getBoundingClientRect(); return [r.left, r.top, r.width]; })()")
        x0, y0 = r[0] + r[2] * 0.2, r[1] + 400
        drag(b, x0, y0, x0 + 200, y0)
        dark = "(() => { const c = DEEP('.page canvas.ink')[0]; const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let k = 3; k < d.length; k += 4) n += d[k] > 128; return n; })()"
        check('pen draws on the page', b.js(dark) > 300, str(b.js(dark)))
        b.js("(DEEP('cr-icon-button#undo')[0].click(), 1)"); time.sleep(0.5)
        check('undo takes the line away', b.js(dark) == 0, str(b.js(dark)))
        b.js("(DEEP('cr-icon-button#redo')[0].click(), 1)"); time.sleep(0.5)
        check('redo brings it back', b.js(dark) > 300, str(b.js(dark)))
        # a text annotation: the text tool, a click on the page, typing, a click elsewhere
        b.js("(DEEP('cr-icon-button#text-annotate')[0].click(), 1)"); time.sleep(1)
        click(b, x0, y0 + 60); time.sleep(1)
        b.c.cmd('Input.insertText', {'text': 'Eine Notiz'}); time.sleep(0.3)
        click(b, x0, y0 + 250); time.sleep(1)
        check('text annotation stays on the page', b.wait("DEEP('.notes div').some(d => d.textContent === 'Eine Notiz')", 5))
        before = set(glob.glob(dl + '/*'))
        b.js("(DEEP('cr-icon-button#save').find(e => e.getAttribute('iron-icon') === 'cr:download').click(), 1)")
        check('download asks: with or without the changes', b.wait("DEEP('#save-edited').some(e => e.getBoundingClientRect().width)", 5))
        b.js("(DEEP('#save-edited').find(e => e.getBoundingClientRect().width).click(), 1)")
        new = []
        for _ in range(40):
            new = [f for f in set(glob.glob(dl + '/*')) - before if not f.endswith('.crdownload')]
            if new: break
            time.sleep(0.5)
        data = open(new[0], 'rb').read() if new else b''
        check('saved with the drawing and the text as annotations', data.startswith(b'%PDF') and b'/Ink' in data and b'/FreeText' in data
              and b'Eine Notiz' in data and data.rstrip().endswith(b'%%EOF')
              and data.startswith((ROOT / 'dev/pdf/swiss-arial.pdf').read_bytes()), str(new))
    finally:
        b.close()


def forms(base, tmp):
    # 13. A form: its fields shaded as Chrome shades them, filled in, and saved
    #     "with my changes" with what was filled in.
    dl = os.path.join(tmp, 'filled'); os.makedirs(dl)
    b = Browser(True)
    try:
        b.c.cmd('Browser.setDownloadBehavior', {'behavior': 'allow', 'downloadPath': dl}, sock=b.c.browser)
        b.open(base + 'form.pdf'); b.js("(delete window.showSaveFilePicker, 1)")
        check('form fields are there to fill in', b.wait("DEEP('.annotationLayer input, .annotationLayer select').length === 3", 10))
        rows = pixels(b.c.shot(os.path.join(tmp, 'form.png')))
        bpp = len(rows[0]) // 1280
        r = b.js("(() => { const r = DEEP('.annotationLayer input[type=checkbox]')[0].getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()")
        shade = tuple(rows[int(r[1])][int(r[0]) * bpp:int(r[0]) * bpp + 3])
        check('fields shaded as in Chrome', max(abs(a - b_) for a, b_ in zip(shade, (242, 244, 255))) <= 2, str(shade))
        f = b.js("(() => { const r = DEEP('.annotationLayer input[type=text]')[0].getBoundingClientRect(); return [r.left + 20, r.top + r.height / 2]; })()")
        click(b, *f); time.sleep(0.3)
        b.c.cmd('Input.insertText', {'text': 'Muster'}); time.sleep(0.3)
        click(b, *r); time.sleep(0.5)
        check('checkbox ticks', b.js("DEEP('.annotationLayer input[type=checkbox]')[0].checked") is True)
        b.js("(DEEP('cr-icon-button#save').find(e => e.getAttribute('iron-icon') === 'cr:download').click(), 1)")
        check('download asks: with or without the changes (form)', b.wait("DEEP('#save-edited').some(e => e.getBoundingClientRect().width)", 5))
        b.js("(DEEP('#save-edited').find(e => e.getBoundingClientRect().width).click(), 1)")
        new = []
        for _ in range(40):
            new = [f for f in glob.glob(dl + '/*') if not f.endswith('.crdownload')]
            if new: break
            time.sleep(0.5)
        data = open(new[0], 'rb').read() if new else b''
        check('saved with what was filled in', b'Muster' in data and b'/V /Yes' in data.replace(b'/V/Yes', b'/V /Yes'), str(new))
    finally:
        b.close()


if __name__ == '__main__':
    sys.exit(main())
