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

  // The page cache's and the find's state (below), declared before anything
  // returns: a replaced pdf.js viewer returns here, and its pages use them later.
  const CACHE = 'pdfpage:', INDEX = 'pdfpage-index', KEEP = 4000, ADD_MAX = 1000;
  let prefs = null, index = null, flushTimer = null, added = 0;
  const pending = new Map();        // written together, so the pages' content scripts hear one change, not hundreds
  const fold = s => s.normalize('NFKC').toLowerCase().replace(/ß/g, 'ss').replace(/\u00ad/g, '');
  let pairs = null;
  const FIND_MAX_PAGES = 10000, FIND_MAX_CHARS = 8e6;

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
  // one a hosted pdf.js viewer accepts. A page just given back (below) is let
  // be, this once: the next visit tries again, as the switches may have changed.
  function hostedFile() {
    if (!/^https?:$/.test(location.protocol)) return null;
    const file = new URLSearchParams(location.search).get('file');
    if (!file) return null;
    let url;
    try { url = new URL(file, location.href); } catch { return null; }
    if (url.origin !== location.origin) return null;
    try {
      if (sessionStorage.getItem('hdfx-pdf-returned') === location.href) {
        sessionStorage.removeItem('hdfx-pdf-returned');
        return null;
      }
    } catch {}
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

    // The background's answer is mostly in by now (one storage read); where it
    // is not, the page is stopped first and given back if the answer is no.
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

  // ---------- a page converted once is kept ----------
  // Converting a page costs the rules and, where they leave a choice, the
  // model, and a lecture script is opened again and again. So a page's final
  // answer is kept in the extension's own storage (never the site's), under a
  // hash of exactly what it was made from: the page's text items with their
  // positions and widths, the page box, the flavour, the model switch and the
  // extension's version. Change any of these and it is another key. A page
  // answered before the model had spoken is shown from the cache at once and
  // converted again behind it.
  // Any script on the page can send the viewer's requests, so what one page
  // may do with the cache is limited: its keys include the site (no site
  // learns which pages another one showed), and one viewer adds at most
  // ADD_MAX pages, so no page can push everything else out.

  // cyrb53: a fast 53-bit string hash with good avalanche (two 32-bit lanes)
  function cyrb53(str, seed = 0) {
    let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return 4294967296 * (2097151 & h2) + (h1 >>> 0);
  }

  async function pageKey({ items, view }) {
    prefs ||= await chrome.storage.local.get(['mode', 'llm']);
    const what = JSON.stringify([chrome.runtime.getManifest().version, location.origin, prefs.mode || 'hamburg', prefs.llm !== false, view, items]);
    // two seeds and the length: 106 bits and more, no two pages share a key in practice
    return CACHE + cyrb53(what).toString(36) + cyrb53(what, 0x9e3779b9).toString(36) + what.length.toString(36);
  }

  function keep(key, entry) {
    if (!(key in index) && !pending.has(key) && ++added > ADD_MAX) return;
    pending.set(key, entry);
    index[key] = Date.now();
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, 1000);
  }

  // Pages written, and the oldest let go past KEEP. The index is merged with
  // what other tabs wrote meanwhile, so none of their pages is lost track of.
  async function flush() {
    const stored = (await chrome.storage.local.get(INDEX))[INDEX] || {};
    for (const [k, t] of Object.entries(stored)) if (!(index[k] >= t)) index[k] = t;
    const keys = Object.keys(index);
    const out = keys.length > KEEP ? keys.sort((a, b) => index[a] - index[b]).slice(0, keys.length - KEEP) : [];
    for (const k of out) { delete index[k]; pending.delete(k); }
    const write = Object.fromEntries(pending);
    pending.clear();
    await chrome.storage.local.set({ ...write, [INDEX]: index });
    if (out.length) await chrome.storage.local.remove(out);
  }

  async function cachedPage(payload, reply, redraw) {
    const key = await pageKey(payload);
    index ||= (await chrome.storage.local.get(INDEX))[INDEX] || {};
    const hit = pending.get(key) || (await chrome.storage.local.get(key))[key];
    if (hit) {
      index[key] = Date.now();
      reply({ edits: hit.edits, version: hit.version });
      if (hit.changes) HD_PDFTEXT.remember(payload.page, hit.changes, payload.items);
      if (hit.final) return;
    }
    // converted now: a final answer is kept as it is; one given before the
    // model had spoken is kept too, marked to be converted again next time
    let shown = hit?.version ?? -1;
    const store = d => keep(key, d.changes ? { edits: d.edits, version: d.version, changes: d.changes, final: true }
                                           : { edits: d.edits, version: d.version, final: false });
    const answer = d => {
      if (!hit || d.changes) store(d);
      if (shown < 0) { shown = d.version; reply(d); }
      else if (d.version > shown || d.changes) { shown = Math.max(shown, d.version); redraw({ page: payload.page, edits: d.edits, version: Math.max(d.version, hit ? hit.version + 1 : 0) }); }
    };
    await HD_PDFTEXT.convertPage(payload, answer, d => { store(d); redraw(d); });
  }

  // ---------- find in a long PDF ----------
  // A long PDF's pages are converted only around the reader, so the browser's
  // find cannot see the rest. The viewer's own find bar (pdfplugin.mjs) reads
  // every page's text as the PDF has it, unconverted, and looks there for the
  // query in all its Swiss forms: the dictionary read backwards. "Fahrrad"
  // is looked for as "fahrrad" and "velo", "Fahrradweg" also as "veloweg",
  // "parkt" also as "parkiert", "groß" as "gross" (ß and ss are one letter
  // here). Every pair is a German form and the Swiss one it replaces.
  function swissPairs() {
    const D = globalThis.HD_DICT;
    if (!D) return [];
    if (pairs) return pairs;
    const out = new Map();
    const add = (sw, de) => {
      sw = fold(sw.replace(/[*+]/g, '').trim()); de = fold(de.replace(/[*+]/g, '').trim());
      if (sw && de.length >= 3 && sw !== de) (out.get(de) || out.set(de, new Set()).get(de)).add(sw);
    };
    const forms = side => { const [w, , pl] = side.split('/'); return [w, ...(pl && pl !== '-' ? pl.split(',') : [])]; };
    for (const list of [D.nouns, D.hamburg?.nouns]) for (const e of list || []) {
      const [l, r] = e.split('|')[0].split('=').map(x => x.trim());
      if (!r) continue;
      const sw = forms(l), de = forms(r);
      de.forEach((d, i) => { add(sw[Math.min(i, sw.length - 1)], d); add(sw[0], d); });
    }
    for (const list of [D.words, D.phrases, D.ambiguous, D.hamburg?.words, D.hamburg?.phrases]) for (const e of list || []) {
      const [l, r] = e.split('>');
      if (!r) continue;
      const de = r.split(',');
      l.split(',').forEach((s, i) => add(s, de[Math.min(i, de.length - 1)]));
    }
    for (const list of [D.verbs, D.hamburg?.verbs]) for (const [s, d] of list || []) add(s, d);
    for (const list of [D.compounds, D.hamburg?.compounds]) for (const [s, d] of list || []) add(s, d);
    // the longest German form first: "fahrräder" before "fahrrad"
    return (pairs = [...out].sort((a, b) => b[0].length - a[0].length));
  }

  // The query and its Swiss forms, folded; none that only contains another
  // (finding "velo" finds "velos" too).
  function swissForms(query) {
    const all = new Set([fold(query.trim())]);
    for (let round = 0; round < 2; round++)
      for (const v of [...all]) for (const [de, sws] of swissPairs()) {
        const at = v.indexOf(de);
        if (at < 0) continue;
        for (const sw of sws) {
          const f = v.slice(0, at) + sw + v.slice(at + de.length);
          all.add(f);
          if (f.startsWith('ge') && sws.size && /ier/.test(sw)) all.add(f.slice(2));   // geparkt -> parkiert
        }
        if (all.size > 32) break;
      }
    const list = [...all].filter(Boolean);
    return list.filter(v => !list.some(u => u !== v && v.includes(u)));
  }

  // A document's pages' text for its find bar, kept by the PDF's fingerprint
  // and the site it is opened on, the 12 most recent documents. The request
  // may come from any script on the page: only a real fingerprint (pdf.js
  // gives 32 hex digits) and text of a sensible size are taken, and a site
  // reads only what was kept on that site, so it cannot ask whether a PDF was
  // opened elsewhere.
  async function findCache(fp, pages) {
    if (typeof fp !== 'string' || !/^[0-9a-f]{32}$/i.test(fp)) return null;
    if (pages && !(Array.isArray(pages) && pages.length <= FIND_MAX_PAGES && pages.every(t => typeof t === 'string')
                   && pages.reduce((n, t) => n + t.length, 0) <= FIND_MAX_CHARS)) return null;
    const key = 'pdffind:' + cyrb53(location.origin).toString(36) + ':' + fp.toLowerCase(), INDEX_KEY = 'pdffind-index';
    const { [INDEX_KEY]: idx = {} } = await chrome.storage.local.get(INDEX_KEY);
    if (!pages) {
      const got = (await chrome.storage.local.get(key))[key];
      if (got) { idx[key] = Date.now(); await chrome.storage.local.set({ [INDEX_KEY]: idx }); }
      return got || null;
    }
    idx[key] = Date.now();
    const old = Object.keys(idx).sort((a, b) => idx[a] - idx[b]).slice(0, Math.max(0, Object.keys(idx).length - 12));
    for (const k of old) delete idx[k];
    await chrome.storage.local.set({ [key]: pages, [INDEX_KEY]: idx });
    if (old.length) await chrome.storage.local.remove(old);
  }

  function serveText() {
    document.addEventListener('hdfx-pdf-req', e => {
      const { id, type, payload } = JSON.parse(e.detail);
      const reply = data => document.dispatchEvent(new CustomEvent('hdfx-pdf-res', { detail: JSON.stringify({ id, data }) }));
      const redraw = data => document.dispatchEvent(new CustomEvent('hdfx-pdf-redraw', { detail: JSON.stringify(data) }));
      if (type === 'swiss-forms') return reply(swissForms(payload.query || ''));
      if (type === 'find-cache-get') return findCache(payload.fp).then(reply, () => reply(null));
      if (type === 'find-cache-set') return findCache(payload.fp, payload.pages).then(() => reply(true), () => reply(false));
      if (type === 'page') cachedPage(payload, reply, redraw).catch(err => { console.error('[Hochdeutsch-Fixer]', err); reply({ edits: [], version: 0 }); });
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
