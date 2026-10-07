"""Drive a headless Chrome for Testing over the DevTools protocol, with nothing
but the standard library: load the unpacked extension, open pages, evaluate
script, take screenshots.

    c = Chrome(extension=path); c.nav(url); c.js(expr); c.shot(path); c.close()

CHROME may point at the chrome.exe to use.
"""
import base64, json, os, shutil, socket, struct, subprocess, tempfile, time, urllib.request

CHROME = os.environ.get('CHROME', '')


class Socket:
    def __init__(self, url):
        host, rest = url[len('ws://'):].split('/', 1)
        h, p = host.split(':')
        self.s = socket.create_connection((h, int(p)))
        key = base64.b64encode(os.urandom(16)).decode()
        self.s.sendall(f"GET /{rest} HTTP/1.1\r\nHost: {host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                       f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n".encode())
        buf = b''
        while b'\r\n\r\n' not in buf: buf += self.s.recv(4096)
        assert b' 101 ' in buf.split(b'\r\n')[0], buf[:200]
        self.rest = buf.split(b'\r\n\r\n', 1)[1]

    def _exact(self, n):
        while len(self.rest) < n: self.rest += self.s.recv(1 << 20)
        out, self.rest = self.rest[:n], self.rest[n:]
        return out

    def send(self, obj):
        data = json.dumps(obj).encode(); mask = os.urandom(4); n = len(data)
        hdr = bytes([0x81]) + (bytes([0x80 | n]) if n < 126 else bytes([0x80 | 126]) + struct.pack('>H', n) if n < 65536 else bytes([0x80 | 127]) + struct.pack('>Q', n))
        self.s.sendall(hdr + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))

    def recv(self):
        msg = b''
        while True:
            b1, b2 = self._exact(2); n = b2 & 0x7f
            if n == 126: n = struct.unpack('>H', self._exact(2))[0]
            elif n == 127: n = struct.unpack('>Q', self._exact(8))[0]
            msg += self._exact(n)
            if b1 & 0x80: return json.loads(msg)


class Chrome:
    def __init__(self, extension=None, port=9334, width=1280, height=900, args=()):
        self.prof = tempfile.mkdtemp(prefix='cdp')
        cmd = [CHROME, '--headless=new', f'--remote-debugging-port={port}', f'--user-data-dir={self.prof}',
               f'--window-size={width},{height}', '--no-first-run', '--no-default-browser-check',
               '--enable-unsafe-extension-debugging', '--remote-allow-origins=*', *args, 'about:blank']
        self.proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(80):
            try:
                targets = json.load(urllib.request.urlopen(f'http://127.0.0.1:{port}/json/version'))
                break
            except OSError: time.sleep(0.25)
        self.browser = Socket(targets['webSocketDebuggerUrl'])
        self.id = 0
        self.events = []
        self.ext = None
        if extension:
            self.ext = self.cmd('Extensions.loadUnpacked', {'path': extension}, sock=self.browser)['id']
        # a tab of its own: the first page listed is not always a tab (Vivaldi's
        # own interface is made of pages, and they never answer Page.enable)
        tab = self.cmd('Target.createTarget', {'url': 'about:blank'}, sock=self.browser)['targetId']
        page = [t for t in json.load(urllib.request.urlopen(f'http://127.0.0.1:{port}/json')) if t['id'] == tab][0]
        self.page = Socket(page['webSocketDebuggerUrl'])
        self.cmd('Page.enable'); self.cmd('Runtime.enable'); self.cmd('Log.enable')
        self.cmd('Emulation.setDeviceMetricsOverride', {'width': width, 'height': height, 'deviceScaleFactor': 1, 'mobile': False})

    def cmd(self, method, params=None, sock=None, session=None):
        sock = sock or self.page
        self.id += 1
        msg = {'id': self.id, 'method': method, 'params': params or {}}
        if session: msg['sessionId'] = session
        sock.send(msg)
        while True:
            m = sock.recv()
            if m.get('id') == self.id:
                if 'error' in m: raise RuntimeError(f"{method}: {m['error']}")
                return m.get('result', {})
            self.events.append(m)

    def nav(self, url, wait=True):
        r = self.cmd('Page.navigate', {'url': url})
        if wait:
            end = time.time() + 30
            while time.time() < end:
                try:
                    if self.js('document.readyState') == 'complete': break
                except RuntimeError: pass
                time.sleep(0.2)
        return r

    def js(self, expr, await_promise=True):
        r = self.cmd('Runtime.evaluate', {'expression': expr, 'awaitPromise': await_promise, 'returnByValue': True})
        if 'exceptionDetails' in r: raise RuntimeError(r['exceptionDetails'].get('exception', {}).get('description') or r['exceptionDetails']['text'])
        return r['result'].get('value')

    def wait(self, expr, timeout=30, every=0.3):
        end = time.time() + timeout
        while time.time() < end:
            try:
                v = self.js(expr)
                if v: return v
            except RuntimeError: pass
            time.sleep(every)
        return None

    def shot(self, path):
        d = self.cmd('Page.captureScreenshot', {'format': 'png'})['data']
        open(path, 'wb').write(base64.b64decode(d))
        return path

    def logs(self):
        out = []
        for e in self.events:
            if e.get('method') == 'Runtime.consoleAPICalled':
                out.append(' '.join(str(a.get('value', a.get('description', ''))) for a in e['params']['args']))
            elif e.get('method') == 'Log.entryAdded':
                out.append('LOG ' + e['params']['entry'].get('text', '') + ' ' + e['params']['entry'].get('url', ''))
            elif e.get('method') == 'Runtime.exceptionThrown':
                out.append('EXC ' + str(e['params']['exceptionDetails'].get('exception', {}).get('description', '')))
        self.events.clear()
        return out

    def close(self):
        try:
            if os.name == 'nt':      # Chrome's other processes too, or they keep the port
                subprocess.run(['taskkill', '/PID', str(self.proc.pid), '/T', '/F'], capture_output=True)
            self.proc.kill()
        except Exception: pass
        time.sleep(0.5)
        shutil.rmtree(self.prof, ignore_errors=True)
