// Content script for PDFs. pdfnet.js has a PDF arrive as plain text at its own
// address; here that text page becomes Chrome's PDF viewer (pdfviewer/, with
// pdfplugin.mjs as its plugin): before anything is shown, the text is
// stopped, the page is replaced by the viewer, and the PDF's bytes are handed
// to it. The text it shows is converted here (pdftext.js).
//
// A PDF on this computer (file://) arrives in Chrome's viewer, not as text: no
// network rule reaches file:// addresses. Content scripts run there only with
// "Allow access to file URLs"; then that viewer is replaced the same way, and
// its bytes are read by the extension (offscreen.js), which may read files.
//
// A site's own copy of pdf.js's viewer (viewer.html?file=…, as Nextcloud and
// polybox show PDFs) draws the pages itself, where no content script can change
// them: only the invisible text layer could be, so what is shown, selected and
// found would disagree. That viewer is stopped before its scripts run and
// replaced the same way, with the PDF named in its file parameter.
(() => {
  const local = location.protocol === 'file:' && /^application\/(x-)?pdf$/i.test(document.contentType);
  const hosted = document.contentType === 'text/html' && hostedFile();
  if (document.contentType !== 'text/plain' && !local && !hosted) return;
  // nothing of the PDF's bytes is shown as text while the background answers
  const hide = document.createElement('style');
  hide.textContent = 'html { visibility: hidden !important; background: rgb(40, 40, 40) !important; }';
  const put = () => (document.head || document.documentElement)?.append(hide);

  if (hosted) { takeOver(hosted); return; }

  if (document.documentElement) put();
  else new MutationObserver((_, o) => { if (document.documentElement) { o.disconnect(); put(); } }).observe(document, { childList: true });

  chrome.runtime.sendMessage({ type: 'pdf-load', local }).then(info => {
    if (!info) { hide.remove(); return; }
    window.stop();
    start(info).catch(err => { console.error('[Hochdeutsch-Fixer]', err); });
  }, () => hide.remove());

  // The PDF a pdf.js viewer page is asked to show, as pdf.js reads it: the
  // file parameter of its address. Only a file on the page's own origin, the
  // one a hosted pdf.js viewer accepts. A page given back (below) is let be.
  function hostedFile() {
    if (!/^https?:$/.test(location.protocol)) return null;
    const file = new URLSearchParams(location.search).get('file');
    if (!file) return null;
    let url;
    try { url = new URL(file, location.href); } catch { return null; }
    if (url.origin !== location.origin) return null;
    try { if (sessionStorage.getItem('hdfx-pdf-returned') === location.href) return null; } catch {}
    return url.href;
  }

  // Is this pdf.js's viewer? Its page says so as it is parsed: the scripts
  // wait for the end of the page, and its outer and viewer containers come
  // before that. Then it is stopped there, before pdf.js starts, and replaced.
  function takeOver(file) {
    let answer;            // the background's, which may come before the page or after
    const asked = chrome.runtime.sendMessage({ type: 'pdf-load', hosted: file }).then(info => (answer = info || null), () => (answer = null));
    const isViewer = () => document.getElementById('outerContainer')?.querySelector('#viewerContainer > #viewer.pdfViewer');
    const watch = new MutationObserver(() => { if (isViewer()) seen(); });
    watch.observe(document, { childList: true, subtree: true });
    document.addEventListener('DOMContentLoaded', () => watch.disconnect(), { once: true });

    async function seen() {
      watch.disconnect();
      if (answer === null) return;            // off here: pdf.js shows it as it is
      // pdf.js must not start; the text engine leaves this page to the viewer
      window.stop();
      document.documentElement.setAttribute('data-hdfx-pdf', '');
      put();
      const info = answer === undefined ? await asked : answer;
      // a viewer that wasn't to be replaced after all, or a file that is not a
      // PDF: the page is given back to pdf.js, once
      const back = () => {
        try { sessionStorage.setItem('hdfx-pdf-returned', location.href); } catch {}
        location.reload();
      };
      if (!info) return back();
      let response;
      try {
        response = await fetch(info.url, { credentials: 'include' });
        if (!response.ok || !/^application\/(x-)?pdf|^application\/octet-stream|^binary\//i.test(response.headers.get('content-type') || '')) throw new Error(`${response.status} ${response.headers.get('content-type')}`);
      } catch (err) {
        console.warn('[Hochdeutsch-Fixer] left to pdf.js:', info.url, err.message);
        return back();
      }
      const name = fileName(response.headers.get('content-disposition'));
      start({ ...info, ...(name ? { fileName: name } : {}) }, response).catch(err => { console.error('[Hochdeutsch-Fixer]', err); });
    }
  }

  // The name a server gives its file (Content-Disposition), as Chrome reads it:
  // filename* (RFC 5987) before filename.
  function fileName(cd) {
    if (!cd) return '';
    const star = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(cd);
    if (star) { try { return decodeURIComponent(star[2].trim()); } catch {} }
    const plain = /filename\s*=\s*("((?:[^"\\]|\\.)*)"|[^;]+)/i.exec(cd);
    return plain ? (plain[2] ?? plain[1]).replace(/\\(.)/g, '$1').trim() : '';
  }

  async function strings() {
    const ui = chrome.i18n.getUILanguage();
    for (const lang of [ui, ui.split('-')[0], 'en-US']) {
      const r = await fetch(chrome.runtime.getURL(`pdfviewer/strings/${lang}.json`)).catch(() => null);
      if (r?.ok) return r.json();
    }
    return { attrs: {}, strings: {} };
  }

  async function start(info, response) {
    const { attrs, strings: s } = await strings();
    const ext = chrome.runtime.getURL('');
    const streamUrl = `${local ? 'file://' : location.origin}/hdfx-pdf-${crypto.randomUUID()}`;   // the viewer's name for this document
    const root = document.documentElement;
    root.innerHTML = '<head><meta charset="utf-8"></head><body></body>';
    for (const a of [...root.attributes]) root.removeAttribute(a.name);
    for (const [k, v] of Object.entries(attrs)) if (k !== 'class') root.setAttribute(k, v);
    root.setAttribute('data-hdfx-pdf', '');
    // the UI font Chrome picks per language (res_css_text_defaults_md.css)
    root.style.setProperty('--hdfx-i18n-fontfamilyMd', s.fontfamilyMd || 'system-ui, sans-serif');
    const head = document.head;
    const add = (tag, props) => head.appendChild(Object.assign(document.createElement(tag), props));
    add('link', { rel: 'stylesheet', href: ext + 'pdfviewer/res_css_text_defaults_md.css' });
    add('link', { rel: 'stylesheet', href: ext + 'pdfviewer/index.css' });
    add('style', { textContent: 'html, body { height: 100%; } body { width: 100%; }' });
    add('script', { id: 'hdfx-config', type: 'application/json', textContent: JSON.stringify({ ...info, streamUrl, strings: s }) });
    document.body.append(Object.assign(document.createElement('pdf-viewer'), { id: 'viewer' }));
    // module scripts run in order: the plugin and chrome.* first, then Chrome's viewer
    for (const src of ['pdfplugin.mjs', 'pdfviewer/main.js']) {
      const el = document.createElement('script');
      el.type = 'module'; el.src = ext + src;
      el.async = false;          // inserted scripts are async unless told not to be
      head.append(el);
    }
    serveText();
    sendBytes(streamUrl, info.length, local, response);
    // the text engine comes with the page scripts, once the page is idle;
    // where Chrome leaves them out, they are asked for
    setTimeout(() => { if (!globalThis.HD_ENGINE) chrome.runtime.sendMessage({ type: 'pdf-engine', local, hosted: info.hosted ? info.url : undefined }).catch(() => {}); }, 500);
  }

  // The PDF's bytes: the page's own request was stopped, so they are fetched
  // again (from the cache where it can), and passed on as they arrive. A
  // replaced pdf.js viewer's file is already being fetched (response).
  async function sendBytes(streamUrl, length, local, response) {
    const channel = new MessageChannel();
    const port = channel.port1;
    // the viewer asks once its plugin is there; the download starts now
    addEventListener('message', function asked(e) {
      if (e.source !== window || e.data?.hdfxWantBytes !== streamUrl) return;
      removeEventListener('message', asked);
      window.postMessage({ hdfxBytes: streamUrl }, '*', [channel.port2]);
    });
    try {
      if (local) {
        const data = await readFile(location.href.split('#')[0], p => port.postMessage({ progress: p }));
        port.postMessage({ done: true, data: data.buffer }, [data.buffer]);
        return;
      }
      const r = response || await fetch(location.href, { credentials: 'include', cache: 'force-cache' });
      const total = +r.headers.get('content-length') || (length > 0 ? length : 0);
      const reader = r.body.getReader();
      const parts = [];
      let got = 0;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        parts.push(value); got += value.byteLength;
        if (total) port.postMessage({ progress: Math.round(got / total * 100) });
      }
      const data = new Uint8Array(got);
      let at = 0;
      for (const p of parts) { data.set(p, at); at += p.byteLength; }
      port.postMessage({ done: true, data: data.buffer }, [data.buffer]);
    } catch (err) {
      console.error('[Hochdeutsch-Fixer]', err);
      port.postMessage({ done: true, data: null });
    }
  }

  // A file's bytes, from the extension's offscreen document (a page can't read
  // files), in pieces: messages between them carry text, not bytes.
  function readFile(url, progress) {
    return new Promise((resolve, reject) => {
      const port = chrome.runtime.connect({ name: 'hdfx-file' });
      const parts = [];
      let got = 0;
      port.onMessage.addListener(msg => {
        if (msg.error) { port.disconnect(); reject(new Error(msg.error)); return; }
        if (msg.chunk != null) {
          const bin = atob(msg.chunk), part = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) part[i] = bin.charCodeAt(i);
          parts.push(part); got += part.byteLength;
          if (msg.total) progress(Math.round(got / msg.total * 100));
        }
        if (msg.done) {
          port.disconnect();
          const data = new Uint8Array(got);
          let at = 0;
          for (const part of parts) { data.set(part, at); at += part.byteLength; }
          resolve(data);
        }
      });
      port.onDisconnect.addListener(() => reject(new Error('file reader gone')));
      port.postMessage({ url });
    });
  }

  function serveText() {
    document.addEventListener('hdfx-pdf-req', e => {
      const { id, type, payload } = JSON.parse(e.detail);
      const reply = data => document.dispatchEvent(new CustomEvent('hdfx-pdf-res', { detail: JSON.stringify({ id, data }) }));
      const redraw = data => document.dispatchEvent(new CustomEvent('hdfx-pdf-redraw', { detail: JSON.stringify(data) }));
      if (type === 'page') HD_PDFTEXT.convertPage(payload, reply, redraw).catch(err => { console.error('[Hochdeutsch-Fixer]', err); reply({ edits: [], version: 0 }); });
    });
    browser.runtime.onMessage.addListener(msg => {
      if (msg === 'hd-status' && window.top === window)
        return Promise.resolve({ host: location.hostname, ...HD_PDFTEXT.status(), active: true, meta: false, pending: 0 });
    });
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area === 'local' && ['enabled', 'disabledSites', 'mode', 'llm', 'pdf'].some(k => k in ch)) location.reload();
    });
  }
})();
