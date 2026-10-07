// Content script for PDFs. pdfnet.js has a PDF arrive as plain text at its own
// address; here that text page becomes Chrome's PDF viewer (pdfviewer/, with
// pdfplugin.mjs as its plugin): before anything is shown, the text is
// stopped, the page is replaced by the viewer, and the PDF's bytes are handed
// to it. The text it shows is converted here (pdftext.js).
(() => {
  if (document.contentType !== 'text/plain') return;
  // nothing of the PDF's bytes is shown as text while the background answers
  const hide = document.createElement('style');
  hide.textContent = 'html { visibility: hidden !important; background: rgb(40, 40, 40) !important; }';
  const put = () => (document.head || document.documentElement)?.append(hide);
  if (document.documentElement) put();
  else new MutationObserver((_, o) => { if (document.documentElement) { o.disconnect(); put(); } }).observe(document, { childList: true });

  chrome.runtime.sendMessage({ type: 'pdf-load' }).then(info => {
    if (!info) { hide.remove(); return; }
    window.stop();
    start(info).catch(err => { console.error('[Hochdeutsch-Fixer]', err); });
  }, () => hide.remove());

  async function strings() {
    const ui = chrome.i18n.getUILanguage();
    for (const lang of [ui, ui.split('-')[0], 'en-US']) {
      const r = await fetch(chrome.runtime.getURL(`pdfviewer/strings/${lang}.json`)).catch(() => null);
      if (r?.ok) return r.json();
    }
    return { attrs: {}, strings: {} };
  }

  async function start(info) {
    const { attrs, strings: s } = await strings();
    const ext = chrome.runtime.getURL('');
    const streamUrl = `${location.origin}/hdfx-pdf-${crypto.randomUUID()}`;   // the viewer's name for this document
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
    sendBytes(streamUrl, info.length);
    // the text engine comes with the page scripts, once the page is idle;
    // where Chrome leaves them out, they are asked for
    setTimeout(() => { if (!globalThis.HD_ENGINE) chrome.runtime.sendMessage({ type: 'pdf-engine' }).catch(() => {}); }, 500);
  }

  // The PDF's bytes: the page's own request was stopped, so they are fetched
  // again (from the cache where it can), and passed on as they arrive.
  async function sendBytes(streamUrl, length) {
    const channel = new MessageChannel();
    const port = channel.port1;
    // the viewer asks once its plugin is there; the download starts now
    addEventListener('message', function asked(e) {
      if (e.source !== window || e.data?.hdfxWantBytes !== streamUrl) return;
      removeEventListener('message', asked);
      window.postMessage({ hdfxBytes: streamUrl }, '*', [channel.port2]);
    });
    try {
      const r = await fetch(location.href, { credentials: 'include', cache: 'force-cache' });
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
