// Find in a long PDF. Its text is converted only around the reader
// (textAround in pdfplugin.mjs), so the browser's find cannot see the rest.
// This find bar reads every page's text as the PDF has it (cheap: no rules,
// no model) and looks there for the query in all its Swiss forms, which
// pdfview.js makes by reading the dictionary backwards ("Fahrrad" is also
// "velo", "groß" is "gross"). A hit takes the reader to its page, which is
// then converted like any page, and the word is marked where it now reads.
// The pages' text is kept per document (pdfview.js), so a second search, or
// the same PDF opened again, need not read it again.

const fold = s => s.normalize('NFKC').toLowerCase().replace(/ß/g, 'ss').replace(/­/g, '');

let seq = 0;
const waiting = new Map();
document.addEventListener('hdfx-pdf-res', e => {
  const { id, data } = JSON.parse(e.detail);
  if (typeof id === 'string' && waiting.has(id)) { waiting.get(id)(data); waiting.delete(id); }
});
const ask = (type, payload) => new Promise(resolve => {
  const id = 'find' + ++seq;
  waiting.set(id, resolve);
  document.dispatchEvent(new CustomEvent('hdfx-pdf-req', { detail: JSON.stringify({ id, type, payload }) }));
});

// How often each form occurs in a page's folded text (forms do not overlap:
// none contains another).
function occurrences(text, forms) {
  let n = 0;
  for (const f of forms) for (let at = text.indexOf(f); at >= 0; at = text.indexOf(f, at + f.length)) n++;
  return n;
}

const CHEVRON = d => `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="${d}" fill="currentColor"/></svg>`;

export class Find {
  constructor(plugin) {
    this.plugin = plugin;
    this.raw = [];            // page -> its text, folded, as the PDF has it
    this.counts = [];         // page -> hits on it for the current query (undefined: not read yet)
    this.at = null;           // the current hit: { page, k }
    this.gen = 0;
    const s = plugin.shadow;
    const style = document.createElement('style');
    style.textContent = `
      #find { position: absolute; top: 8px; right: 22px; z-index: 20; display: flex; align-items: center; gap: 2px;
        padding: 3px 4px 3px 12px; background: #fff; color: #202124; border-radius: 8px; overflow: hidden;
        box-shadow: 0 1px 3px rgba(0,0,0,.3), 0 4px 8px 3px rgba(0,0,0,.15); font: 13px system-ui, sans-serif;
        animation: find-in 160ms cubic-bezier(.2,.8,.2,1); }
      #find[hidden] { display: none; }
      @keyframes find-in { from { opacity: 0; transform: translateY(-8px); } }
      #find input { width: 210px; border: 0; outline: 0; padding: 6px 0; font: inherit; background: none; color: inherit; }
      #find .n { min-width: 64px; padding: 0 8px; text-align: right; color: #5f6368; font-variant-numeric: tabular-nums;
        border-right: 1px solid #dadce0; margin-right: 2px; white-space: nowrap; }
      #find button { all: unset; width: 30px; height: 30px; display: grid; place-items: center; border-radius: 50%; color: #5f6368; cursor: pointer; }
      #find button:hover { background: rgba(60,64,67,.08); }
      #find button:focus-visible { outline: 2px solid #1a73e8; }
      #find .scan { position: absolute; left: 0; right: 0; bottom: 0; height: 2px; background: #1a73e8;
        transform-origin: left; transform: scaleX(var(--p, 0)); transition: transform 120ms linear, opacity 300ms; }
      #find .scan.done { opacity: 0; }
      #find.none input { color: #c5221f; }
      @media (prefers-color-scheme: dark) {
        #find { background: #35363a; color: #e8eaed; }
        #find .n, #find button { color: #9aa0a6; } #find .n { border-color: #5f6368; }
        #find button:hover { background: rgba(232,234,237,.08); }
        #find.none input { color: #f28b82; }
      }
      @media (prefers-reduced-motion: reduce) { #find { animation: none; } }
      .textLayer ::highlight(hdfx-find) { background-color: rgba(255, 213, 0, .55); color: transparent; }
      .textLayer ::highlight(hdfx-find-now) { background-color: rgba(255, 138, 0, .8); color: transparent; }`;
    const bar = document.createElement('div');
    bar.id = 'find';
    bar.hidden = true;
    bar.setAttribute('role', 'search');
    bar.innerHTML = `<input type="text" spellcheck="false" aria-label="Find in document"><span class="n" aria-live="polite"></span>`
      + `<button class="prev" aria-label="Previous">${CHEVRON('M7.4 15.4 12 10.8l4.6 4.6L18 14l-6-6-6 6z')}</button>`
      + `<button class="next" aria-label="Next">${CHEVRON('M7.4 8.6 12 13.2l4.6-4.6L18 10l-6 6-6-6z')}</button>`
      + `<button class="close" aria-label="Close">${CHEVRON('M18.3 5.7 16.9 4.3 12 9.2 7.1 4.3 5.7 5.7 10.6 10.6 5.7 15.5l1.4 1.4 4.9-4.9 4.9 4.9 1.4-1.4-4.9-4.9z')}</button>`
      + `<div class="scan"></div>`;
    s.append(style, bar);
    this.bar = bar;
    this.input = bar.querySelector('input');
    this.n = bar.querySelector('.n');
    this.scanBar = bar.querySelector('.scan');
    // typing: the old count and marks go at once, the search starts when the typing pauses
    this.input.addEventListener('input', () => {
      clearTimeout(this.typing);
      this.gen++;
      this.n.textContent = this.input.value.trim() ? '…' : '';
      this.bar.classList.remove('none');
      CSS.highlights?.delete('hdfx-find'); CSS.highlights?.delete('hdfx-find-now');
      this.typing = setTimeout(() => this.search(), 140);
    });
    this.input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); this.step(e.shiftKey ? -1 : 1); }
      else if (e.key === 'Escape') { e.preventDefault(); this.close(); }
    });
    bar.querySelector('.prev').onclick = () => this.step(-1);
    bar.querySelector('.next').onclick = () => this.step(1);
    bar.querySelector('.close').onclick = () => this.close();
    addEventListener('keydown', e => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && !e.altKey && e.key.toLowerCase() === 'f') { e.preventDefault(); e.stopPropagation(); this.open(); }
      else if ((e.key === 'F3' || (mod && e.key.toLowerCase() === 'g')) && !bar.hidden) { e.preventDefault(); this.step(e.shiftKey ? -1 : 1); }
    }, true);
  }

  open() {
    this.bar.hidden = false;
    this.input.focus();
    this.input.select();
    this.loadCache();
  }

  close() {
    this.bar.hidden = true;
    this.gen++;
    CSS.highlights?.delete('hdfx-find'); CSS.highlights?.delete('hdfx-find-now');
    this.plugin.scroller.focus({ preventScroll: true });
  }

  // the pages' text as kept for this document, read once per document
  async loadCache() {
    if (this.cacheTried) return;
    this.cacheTried = true;
    const fp = this.plugin.doc?.fingerprints?.[0];
    if (!fp) return;
    const pages = await ask('find-cache-get', { fp });
    if (Array.isArray(pages) && pages.length === this.plugin.pages.length)
      pages.forEach((t, i) => { if (typeof t === 'string' && this.raw[i] == null) this.raw[i] = t; });
  }

  async rawText(i) {
    if (this.raw[i] != null) return this.raw[i];
    // __hdfxRaw: the page's own text, without asking for it to be converted (pdfhooks.mjs)
    const tc = await this.plugin.pages[i].page.getTextContent({ __hdfxRaw: true, disableNormalization: true });
    let s = '';
    for (const it of tc.items) {
      if (typeof it.str !== 'string') continue;
      s += it.str;
      if (it.hasEOL) s = /\p{L}-$/u.test(s) ? s.slice(0, -1) : s + ' ';   // a word broken over two lines is one
    }
    return (this.raw[i] = fold(s).replace(/\s+/g, ' '));
  }

  current() {
    const seen = this.plugin.visible();
    return seen.length ? Math.min(...seen) : 0;
  }

  // Every page is read for the query, from the reader's page on and round;
  // the first hit is shown as soon as it is found, the count fills in.
  async search() {
    const gen = ++this.gen;
    const q = this.input.value;
    this.counts = [];
    this.at = null;
    this.bar.classList.remove('none');
    CSS.highlights?.delete('hdfx-find'); CSS.highlights?.delete('hdfx-find-now');
    if (!q.trim()) { this.n.textContent = ''; this.scanBar.classList.add('done'); return; }
    this.forms = await ask('swiss-forms', { query: q });
    if (gen !== this.gen) return;
    await this.loadCache();
    const n = this.plugin.pages.length, from = this.current();
    this.scanBar.classList.remove('done');
    let read = 0, last = performance.now();
    for (let d = 0; d < n; d++) {
      const i = (from + d) % n;
      const text = await this.rawText(i);
      if (gen !== this.gen) return;
      this.counts[i] = occurrences(text, this.forms);
      read++;
      if (this.counts[i] && !this.at) { this.at = { page: i, k: 0 }; this.show(); }
      // yield to the page now and then, and tell how far it got
      if (performance.now() - last > 12) {
        this.status(read < n);
        this.scanBar.style.setProperty('--p', read / n);
        await new Promise(r => setTimeout(r, 0));
        if (gen !== this.gen) return;
        last = performance.now();
      }
    }
    this.scanBar.style.setProperty('--p', 1);
    this.scanBar.classList.add('done');
    this.status(false);
    this.saveCache();
  }

  saveCache() {
    const fp = this.plugin.doc?.fingerprints?.[0];
    if (!fp || this.saved || this.raw.filter(t => t != null).length !== this.plugin.pages.length) return;
    this.saved = true;
    ask('find-cache-set', { fp, pages: this.raw });
  }

  // "3/17", while reading "3/17…"; the place of the current hit in the document
  status(reading) {
    const total = this.counts.reduce((a, c) => a + (c || 0), 0);
    let pos = 0;
    if (this.at) for (let i = 0; i < this.at.page; i++) pos += this.counts[i] || 0;
    this.n.textContent = total ? `${this.at ? pos + this.at.k + 1 : 0}/${total}${reading ? '…' : ''}` : reading ? '…' : '0/0';
    this.bar.classList.toggle('none', !reading && !total);
  }

  step(dir) {
    if (!this.at) return;
    const n = this.plugin.pages.length;
    let { page, k } = this.at;
    k += dir;
    if (k < 0 || k >= (this.counts[page] || 0)) {
      for (let d = 1; d <= n; d++) {
        const i = (page + dir * d + n * 2) % n;
        if (this.counts[i]) { page = i; k = dir > 0 ? 0 : this.counts[i] - 1; break; }
      }
    }
    this.at = { page, k };
    this.show();
  }

  // To the hit's page; once its text is there (converted), the hit is marked
  // where it now reads: the query itself, or a Swiss form the page kept.
  async show() {
    const { page, k } = this.at, gen = this.gen;
    this.status(this.counts.length < this.plugin.pages.length || this.counts.includes(undefined));
    const p = this.plugin.pages[page];
    if (!this.plugin.visible().includes(page) || !p.text?.isConnected) this.plugin.post({ type: 'goToPage', page });
    for (let t = 0; t < 200 && !(p.text?.isConnected && p.text.textContent.length); t++) {
      await new Promise(r => setTimeout(r, 50));
      if (gen !== this.gen || this.at?.page !== page) return;
    }
    if (!p.text?.isConnected) return;
    await new Promise(r => setTimeout(r, 30));
    const ranges = this.rangesIn(p.text);
    if (!ranges.length || !globalThis.Highlight) return;
    const now = ranges[Math.min(k, ranges.length - 1)];
    CSS.highlights.set('hdfx-find', new Highlight(...ranges));
    const hl = new Highlight(now);
    hl.priority = 1;
    CSS.highlights.set('hdfx-find-now', hl);
    const r = now.getBoundingClientRect(), box = this.plugin.scroller.getBoundingClientRect();
    if (r.top < box.top + 40 || r.bottom > box.bottom - 40)
      this.plugin.scroller.scrollBy({ top: r.top - box.top - box.height / 3, behavior: 'instant' });
  }

  // Ranges of the forms in a text layer, folded letter by letter (ß is "ss").
  rangesIn(layer) {
    const at = [];
    let text = '';
    const walk = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
    for (let node; (node = walk.nextNode());) {
      const v = node.nodeValue;
      for (let o = 0; o < v.length; o++) { const f = fold(v[o]); for (let c = 0; c < f.length; c++) at.push([node, o]); text += f; }
      text += ' '; at.push(null);
    }
    const out = [];
    const forms = [...new Set([...this.forms, fold(this.input.value.trim())])].filter(Boolean)
      .sort((a, b) => b.length - a.length);
    const taken = new Uint8Array(text.length);
    for (const f of forms) for (let i = text.indexOf(f); i >= 0; i = text.indexOf(f, i + 1)) {
      const a = at[i], z = at[i + f.length - 1];
      if (!a || !z || taken[i]) continue;
      taken.fill(1, i, i + f.length);
      const range = document.createRange();
      range.setStart(a[0], a[1]);
      range.setEnd(z[0], z[1] + 1);
      out.push([i, range]);
    }
    return out.sort((x, y) => x[0] - y[0]).map(([, r]) => r);
  }
}
