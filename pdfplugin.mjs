// Runs in the PDF's page, before Chrome's viewer (pdfviewer/). Chrome's viewer
// is its toolbar, sidebar and zoom on top of the PDF plugin, which draws the
// pages, scrolls, selects text, makes thumbnails and saves. Here:
// - chrome.*: the private extension APIs Chrome gives its viewer;
// - the plugin: the same messages the PDF plugin exchanges with the viewer,
//   with pages laid out as the plugin lays them out, drawn by pdf.js with the
//   converted text (pdfhooks.mjs).
import { onRedraw } from './pdfhooks.mjs';
import { Find } from './pdffind.mjs';
import './pdfjs/build/pdf.mjs';

const lib = globalThis.pdfjsLib;
const BASE = new URL('./', import.meta.url).href;
const cfgEl = document.getElementById('hdfx-config');
const cfg = JSON.parse(cfgEl.textContent);
cfgEl.remove();

// ---------- what Chrome gives its viewer ----------

const event = () => {
  const fns = new Set();
  return { addListener: f => fns.add(f), removeListener: f => fns.delete(f), hasListener: f => fns.has(f), dispatch: (...a) => fns.forEach(f => f(...a)) };
};
const streamInfo = {
  mimeType: 'application/pdf', originalUrl: cfg.url, streamUrl: cfg.streamUrl, tabId: cfg.tabId,
  tabUrl: cfg.tabUrl, embedded: cfg.embedded, responseHeaders: {}, javascript: 'block',
};
const C = (globalThis.chrome ||= {});
C.runtime ||= {};
const saveTypes = { ORIGINAL: 'ORIGINAL', EDITED: 'EDITED', ANNOTATION: 'ANNOTATION', SEARCHIFIED: 'SEARCHIFIED' };
C.pdfViewerPrivate = {
  getStreamInfo: cb => cb(streamInfo),
  setPdfPluginAttributes() {},
  setPdfDocumentTitle: title => { document.title = title; },
  isAllowedLocalFileAccess: (url, cb) => cb(false),
  // what PDFium needs to set a text annotation in the text box's fonts; here the
  // text is shown as the box shows it, so nothing
  getTextInfo: (...a) => {
    const info = { mojoTextInfo: new ArrayBuffer(0), typefaces: [] };
    return typeof a.at(-1) === 'function' ? a.at(-1)(info) : Promise.resolve(info);
  },
  saveToDrive: (...a) => a.at(-1)?.(),
  glicSummarize() {},
  onSave: event(), onShouldUpdateViewport: event(), onSaveToDriveProgress: event(),
  SaveRequestType: saveTypes,
  SaveToDriveStatus: {}, SaveToDriveErrorType: {},
};
C.mimeHandlerPrivate = { getStreamInfo: cb => cb(streamInfo), setPdfPluginAttributes() {}, setShowBeforeUnloadDialog() {}, onSave: event() };
// Saving to Google Drive needs the browser's Google account: no button for it
cfg.strings.pdfSaveToDrive = false;
C.resourcesPrivate = { getStrings: (component, cb) => cb(cfg.strings), Component: { PDF: 'pdf' } };
// the viewer's labels and menus, which Chrome writes in as it serves the files
// (tools/sync_chrome_pdf.py), in the user's language
globalThis.__hdfxI18n = key => cfg.strings[key] ?? '';
const noop = () => {};
C.metricsPrivate = new Proxy({ MetricTypeType: { HISTOGRAM_LOG: 'histogram-log', HISTOGRAM_LINEAR: 'histogram-linear' } },
  { get: (t, k) => (k in t ? t[k] : noop) });

// The viewer manages the tab's zoom as Chrome's does: Ctrl and the wheel, or
// Ctrl +/-/0, zoom the document, not the page around it.
const LEVELS = [0.25, 1 / 3, 0.5, 2 / 3, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];
const zoom = { factor: 1, changed: event() };
const setTabZoom = f => {
  const old = zoom.factor;
  zoom.factor = f;
  if (old !== f) zoom.changed.dispatch({ tabId: cfg.tabId, oldZoomFactor: old, newZoomFactor: f, zoomSettings: { mode: 'manual', scope: 'per-tab' } });
};
C.tabs = {
  TAB_ID_NONE: -1,
  ZoomSettingsMode: { AUTOMATIC: 'automatic', MANUAL: 'manual', DISABLED: 'disabled' },
  ZoomSettingsScope: { PER_ORIGIN: 'per-origin', PER_TAB: 'per-tab' },
  get: (id, cb) => cb({ id, url: cfg.tabUrl }),
  getCurrent: cb => cb({ id: cfg.tabId, url: cfg.tabUrl }),
  getZoom: (id, cb) => cb(zoom.factor),
  setZoom: (id, f, cb) => { zoom.factor = f; cb?.(); },
  getZoomSettings: (id, cb) => cb({ mode: 'manual', scope: 'per-tab', defaultZoomFactor: 1 }),
  setZoomSettings: (id, s, cb) => cb?.(),
  onZoomChange: zoom.changed,
  update: (id, props, cb) => { if (props.url) location.href = props.url; cb?.(); },
  create: (props, cb) => { window.open(props.url, '_blank', 'noopener'); cb?.(); },
  reload: () => location.reload(),
};
C.windows = { create: (props, cb) => { window.open(props.url, '_blank', 'noopener'); cb?.(); } };

// Mojo: the viewer's feature tips (help bubbles) talk to the browser through it.
// Here its pipes lead nowhere, so the tips simply never show, as when Chrome
// has none to show.
const handle = () => ({ watch: () => ({ cancel() {} }), writeMessage: () => 0, readMessage: () => ({ result: 17 }), close() {} });
globalThis.Mojo ||= {
  RESULT_OK: 0, RESULT_FAILED_PRECONDITION: 9, RESULT_SHOULD_WAIT: 17,
  createMessagePipe: () => ({ result: 0, handle0: handle(), handle1: handle() }),
  bindInterface() {},
};
if (!cfg.embedded) {
  const step = dir => {
    const i = LEVELS.findIndex(l => l >= zoom.factor - 1e-6);
    const at = i < 0 ? LEVELS.length - 1 : i;
    return LEVELS[Math.max(0, Math.min(LEVELS.length - 1, LEVELS[at] > zoom.factor + 1e-6 && dir > 0 ? at : at + dir))];
  };
  addEventListener('keydown', e => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    const k = e.key;
    if (k === '+' || k === '=' || k === '-' || k === '0') {
      e.preventDefault();
      setTabZoom(k === '0' ? 1 : step(k === '-' ? -1 : 1));
    }
  }, true);
  addEventListener('wheel', e => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    setTabZoom(step(e.deltaY < 0 ? 1 : -1));
  }, { passive: false, capture: true });
}

// "Save" asks where, as Chrome's viewer does (a save dialog where the page may
// open one, else the browser's download).
C.fileSystem = {
  chooseEntry(options, cb) {
    const name = options?.suggestedName || 'document.pdf';
    const writer = handle => ({
      write: async blob => {
        if (handle) { const w = await handle.createWritable(); await w.write(blob); await w.close(); writer.onwriteend?.(); return; }
        const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name });
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 60000);
      },
    });
    const entry = handle => ({ name, createWriter: (ok) => ok(writer(handle)) });
    if (window.showSaveFilePicker) {
      window.showSaveFilePicker({ suggestedName: name, types: [{ description: 'PDF', accept: { 'application/pdf': ['.pdf'] } }] })
        .then(h => cb(entry(h)), () => cb(undefined));
    } else cb(entry(null));
  },
};

// ---------- the plugin ----------

// Page boxes as the plugin computes them: CSS pixels at zoom 1 (a point is 4/3
// of one, rounded down), with room around each page for its shadow, pages 4
// pixels apart and centred on the widest.
const INSET = { left: 5, top: 3, right: 5, bottom: 7 };
// the fonts of the viewer's text box (getStyleForTypeface in pdfviewer/)
const TYPEFACES = { 'sans-serif': 'Arial, sans-serif', serif: 'Times, serif', monospace: '"Courier New", monospace' };
const GAP = 4;
// Text converted ahead of drawing (textAround): all of a document up to this
// many pages, else this many pages behind and ahead of the ones on screen.
const TEXT_ALL = 60, TEXT_BEHIND = 2, TEXT_AHEAD = 6;
// how long after the last zoom step the pages are drawn at their new size (ms);
// until then they are stretched, as a native viewer does mid-pinch
const ZOOM_SETTLE = 180;
const BG = 'rgb(40, 40, 40)';

// Chrome starts no workers for a page from this computer (file://): there
// pdf.js reads the PDF on the page itself (its worker code, loaded before the
// first document is opened; not awaited here, the viewer must find the plugin).
// So too in place of a site's pdf.js viewer: the site's own rules (CSP) still
// hold there, and they may allow it no worker (polybox allows none).
let workerReady = Promise.resolve();
if (location.protocol === 'file:' || cfg.hosted) workerReady = import(BASE + 'pdfjs/build/pdf.worker.mjs');
else {
  const worker = new Worker(URL.createObjectURL(new Blob([`import ${JSON.stringify(BASE + 'pdfjs/build/pdf.worker.mjs')};`], { type: 'text/javascript' })), { type: 'module' });
  lib.GlobalWorkerOptions.workerPort = worker;
}

class Plugin {
  constructor(viewer) {
    this.viewer = viewer;
    this.el = document.createElement('div');
    this.el.id = 'plugin';
    const shadow = this.el.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<link rel="stylesheet" href="${BASE}pdfjs/layers.css"><style>
      :host { display: block; position: relative; height: 100%; width: 100%; }
      #scroller { position: absolute; inset: 0; overflow: auto; background: ${BG}; color-scheme: light; outline: none; }
      #sizer { position: relative; }
      .page { position: absolute; background: white; }
      .shadow { position: absolute; pointer-events: none; }
      .shadow canvas { width: 100%; height: 100%; display: block; }
      .page canvas { position: absolute; inset: 0; width: 100%; height: 100%; }
      .page .textLayer ::selection { background: rgba(70, 120, 255, 0.4); color: transparent; }
      .links a { position: absolute; display: block; }
      .page canvas.ink { z-index: 4; pointer-events: none; touch-action: none; }
      :host(.drawing) .page canvas.ink { pointer-events: auto; cursor: crosshair; }
      :host(.texting) #scroller { cursor: text; }
      :host(.presenting) #scroller { scrollbar-width: none; }
      :host(.texting) .page .links { pointer-events: none; }
      .annotationLayer { z-index: 3; --annotation-unfocused-field-background: none; --annotation-unfocused-field-filter: none; --input-focus-border-color: transparent;
                         --input-hover-border-color: transparent; --input-unfocused-border-color: transparent; --input-focus-outline: none; }
      .annotationLayer :is(input, textarea, select) { background: rgb(0 51 255 / 0.05) !important; border: none !important; outline: none !important; box-shadow: none !important; }
      .annotationLayer .choiceWidgetAnnotation select:not([multiple]) { appearance: none; padding: 0 0 0 1px; color: rgb(87, 87, 87) !important; }
      .notes { position: absolute; left: 0; top: 0; transform-origin: 0 0; z-index: 5; pointer-events: none; }
      .notes div { position: absolute; margin: 0; white-space: pre-wrap; overflow-wrap: break-word; line-height: normal; }
      #print { display: none; }
    </style><div id="scroller" tabindex="0"><div id="sizer"></div></div>`;
    this.shadow = shadow;
    this.scroller = shadow.getElementById('scroller');
    this.sizer = shadow.getElementById('sizer');
    this.pages = [];          // { page, view: [w, h] in points, el, canvas, scale, text }
    this.zoom = 1; this.rotation = 0; this.twoUp = false;
    // drawing: Chrome's brushes as they start, the strokes, and undo
    this.mode = 'off';
    this.brushes = { pen: { type: 'pen', color: { r: 0, g: 0, b: 0 }, size: 3 },
                     highlighter: { type: 'highlighter', color: { r: 242, g: 139, b: 130 }, size: 8 },
                     eraser: { type: 'eraser', size: 3 } };
    this.brush = this.brushes.pen;
    this.strokes = []; this.history = []; this.done = 0;
    this.saving = new Map();     // save type -> bytes, while the viewer fetches them in blocks
    this.notes = new Map();      // text annotations: id -> as the viewer gave it
    this.editingNote = null;     // the one the viewer is editing (not shown here meanwhile)
    this.notesVersion = 0;
    // in text mode a click on the document goes to the viewer, which opens a text box there
    this.scroller.addEventListener('pointerdown', e => {
      if (this.mode !== 'text' || e.button !== 0) return;
      e.preventDefault();
      const r = this.el.getBoundingClientRect();
      this.post({ type: 'sendClickEvent', x: e.clientX - r.left, y: e.clientY - r.top });
    }, true);
    this.size = { width: 0, height: 0 };
    this.data = null;
    this.ready = null;
    this.scroller.addEventListener('scroll', () => this.onScroll());
    new ResizeObserver(() => this.paintSoon()).observe(this.scroller);
    const channel = new MessageChannel();
    this.port = channel.port1;
    this.port.onmessage = e => this.onMessage(e.data);
    // the viewer listens once it is set up
    setTimeout(() => window.postMessage({ type: 'connect', token: cfg.streamUrl }, '*', [channel.port2]), 0);
    this.load();
  }

  post(msg, transfer) { this.port.postMessage(msg, transfer || []); }

  // ---- loading ----
  async load() {
    this.post({ type: 'loadProgress', progress: 0 });
    const data = await bytes(p => this.post({ type: 'loadProgress', progress: Math.min(99, p) }));
    if (!data) { this.post({ type: 'loadProgress', progress: -1 }); return; }
    this.data = data;
    await this.open();
  }

  async open(password) {
    await workerReady;
    const task = lib.getDocument({
      data: this.data.slice(), password,
      cMapUrl: BASE + 'pdfjs/web/cmaps/', cMapPacked: true, standardFontDataUrl: BASE + 'pdfjs/web/standard_fonts/',
      iccUrl: BASE + 'pdfjs/web/iccs/', wasmUrl: BASE + 'pdfjs/web/wasm/', isEvalSupported: false,
    });
    try {
      this.doc = await task.promise;
    } catch (err) {
      if (err?.name === 'PasswordException') { this.post({ type: 'getPassword' }); return; }
      console.error('[Hochdeutsch-Fixer]', err);
      this.post({ type: 'loadProgress', progress: -1 });
      return;
    }
    const n = this.doc.numPages;
    for (let i = 0; i < n; i++) {
      const page = await this.doc.getPage(i + 1);
      this.pages.push({ page, el: null, canvas: null, scale: 0, text: null, links: false });
    }
    // a long document has its own find (pdffind.mjs): the browser's sees only converted pages
    if (n > TEXT_ALL) this.find ||= new Find(this);
    this.layout();
    this.post({ type: 'documentDimensions', ...this.dims });
    this.post({ type: 'rendererPreferencesUpdated', caretBrowsingEnabled: false });
    this.post({ type: 'formFocusChange', focused: 'none' });
    this.post({ type: 'metadata', metadataData: await this.metadata() });
    this.post({ type: 'bookmarks', bookmarksData: await this.bookmarks() });
    // Chrome lists no files inside PDFs (its attachments tab is behind a flag that is off)
    this.post({ type: 'attachments', attachmentsData: [] });
    this.post({ type: 'loadProgress', progress: 100 });
    this.paintSoon();
    this.textAround();
  }

  async metadata() {
    const { info = {} } = await this.doc.getMetadata().catch(() => ({}));
    const date = s => {
      const d = lib.PDFDateString?.toDateObject?.(s);
      return d ? d.toLocaleString(cfg.strings.language || undefined, { dateStyle: 'short', timeStyle: 'short' }) : '';
    };
    const [w, h] = this.pageSize(0);
    return {
      title: info.Title || '', author: info.Author || '', subject: info.Subject || '', keywords: info.Keywords || '',
      creator: info.Creator || '', producer: info.Producer || '', creationDate: date(info.CreationDate), modDate: date(info.ModDate),
      version: info.PDFFormatVersion ? info.PDFFormatVersion : '', fileSize: formatSize(this.data.byteLength),
      linearized: !!info.IsLinearized, pageSize: `${(w / 72 * 25.4).toFixed(0)} × ${(h / 72 * 25.4).toFixed(0)} mm`,
      canSerializeDocument: true,
    };
  }

  async bookmarks() {
    const outline = await this.doc.getOutline().catch(() => null);
    const conv = async items => Promise.all((items || []).map(async it => {
      const b = { title: it.title, children: await conv(it.items) };
      if (it.url) b.uri = it.url;
      else if (it.dest) {
        const dest = typeof it.dest === 'string' ? await this.doc.getDestination(it.dest) : it.dest;
        if (dest) {
          b.page = await this.doc.getPageIndex(dest[0]).catch(() => 0);
          if (dest[1]?.name === 'XYZ') { if (dest[2] != null) b.x = dest[2]; if (dest[3] != null) b.y = dest[3]; if (dest[4]) b.zoom = dest[4]; }
        }
      }
      return b;
    }));
    return conv(outline);
  }

  // ---- layout ----
  pageSize(i) {
    const p = this.pages[i].page;
    const [x0, y0, x1, y1] = p.view;
    let w = x1 - x0, h = y1 - y0;
    if (((p.rotate / 90) + this.rotation) % 2) [w, h] = [h, w];
    return [w, h];
  }

  layout() {
    // facing pages meet with 1 pixel of shadow room each, and rows touch
    const inset = i => (!this.twoUp ? INSET : i % 2 ? { ...INSET, left: 1 } : { ...INSET, right: 1 });
    const boxes = this.pages.map((_, i) => {
      const [w, h] = this.pageSize(i), ins = inset(i);
      return { width: Math.floor(w * 4 / 3) + ins.left + ins.right, height: Math.floor(h * 4 / 3) + ins.top + ins.bottom, ins };
    });
    let width, height;
    if (!this.twoUp) {
      width = Math.max(...boxes.map(b => b.width));
      let y = 0;
      boxes.forEach((b, i) => { b.x = Math.floor((width - b.width) / 2); b.y = y; y += b.height + (i < boxes.length - 1 ? GAP : 0); });
      height = y;
    } else {
      const half = Math.max(...boxes.map(b => b.width));
      width = half * 2;
      let y = 0;
      for (let i = 0; i < boxes.length; i += 2) {
        const a = boxes[i], b = boxes[i + 1];
        a.x = half - a.width; a.y = y;
        if (b) { b.x = half; b.y = y; }
        y += Math.max(a.height, b?.height || 0);
      }
      height = y;
    }
    this.boxes = boxes;
    this.dims = {
      width, height,
      layoutOptions: { direction: 2, defaultPageOrientation: this.rotation, twoUpViewEnabled: this.twoUp },
      pageDimensions: boxes.map(b => ({ height: b.height, width: b.width, x: b.x, y: b.y })),
    };
    this.place();
  }

  zooming() { return this.zoomedAt && performance.now() - this.zoomedAt < ZOOM_SETTLE; }

  // where the document sits in the scroller: centred while narrower than it
  offsetX() { return Math.max(0, Math.floor((this.scroller.clientWidth - this.dims.width * this.zoom) / 2)); }

  place() {
    if (!this.boxes) return;
    const z = this.zoom, ox = this.offsetX();
    this.sizer.style.width = `${Math.max(this.size.width, Math.ceil(this.dims.width * z))}px`;
    this.sizer.style.height = `${Math.max(this.size.height, Math.ceil(this.dims.height * z))}px`;
    this.boxes.forEach((b, i) => {
      const p = this.pages[i];
      if (!p.el) {
        p.el = document.createElement('div');
        p.el.className = 'page';
        p.el.dataset.page = i;
        p.shadowEl = document.createElement('div');
        p.shadowEl.className = 'shadow';
        p.ink = document.createElement('canvas');
        p.ink.className = 'ink';
        this.inkInput(i, p.ink);
        p.el.append(p.ink);
        this.sizer.append(p.shadowEl, p.el);
      }
      const x = ox + (b.x + b.ins.left) * z, y = (b.y + b.ins.top) * z;
      const w = (b.width - b.ins.left - b.ins.right) * z, h = (b.height - b.ins.top - b.ins.bottom) * z;
      Object.assign(p.el.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
      Object.assign(p.shadowEl.style, { left: `${ox + b.x * z}px`, top: `${b.y * z}px`, width: `${b.width * z}px`, height: `${b.height * z}px` });
      if (!this.zooming() || !p.shadowEl.dataset.key) shadowFor(p.shadowEl, z, b.width, b.height, b.ins);
      const notesKey = `${z}:${this.rotation}:${this.notesVersion}`;
      if ((p.notes || this.notes.size) && p.notesKey !== notesKey) { p.notesKey = notesKey; this.renderNotes(i); }
      // the text layer's scale follows (pdf.js positions it in these units)
      const s = w / this.pageSize(i)[0];
      p.el.style.setProperty('--scale-factor', s);
      p.el.style.setProperty('--user-unit', 1);
      p.el.style.setProperty('--total-scale-factor', s);
      p.el.style.setProperty('--scale-round-x', '1px');     // pdf.js sizes its layers to whole pixels
      p.el.style.setProperty('--scale-round-y', '1px');
    });
  }

  // ---- drawing ----
  paintSoon() {
    if (this.paintQueued) return;
    this.paintQueued = true;
    requestAnimationFrame(() => { this.paintQueued = false; this.place(); this.paint(); });
  }

  visible() {
    const top = this.scroller.scrollTop, bottom = top + this.scroller.clientHeight;
    return this.boxes.map((b, i) => [i, b]).filter(([, b]) => (b.y + b.height) * this.zoom > top - 400 && b.y * this.zoom < bottom + 400).map(([i]) => i);
  }

  async paint() {
    if (!this.boxes) return;
    if (this.pages.length > TEXT_ALL) this.textAround();     // the window follows the reader
    const want = new Set(this.visible());
    const dpr = devicePixelRatio || 1;
    for (const [i, p] of this.pages.entries()) {
      if (!want.has(i)) {
        if (p.canvas && Math.abs(i - [...want][0]) > 6) { p.canvas.remove(); p.canvas = null; p.scale = 0; }
        continue;
      }
      const cssW = parseFloat(p.el.style.width);
      const scale = cssW / this.pageSize(i)[0];
      if (p.scale === scale && p.canvas) continue;
      if (p.canvas && this.zooming()) continue;           // stretched for now, drawn when the zoom settles
      this.draw(i, scale, dpr);
    }
  }

  async draw(i, scale, dpr) {
    const p = this.pages[i];
    p.scale = scale;
    const token = (p.token = Symbol());
    p.task?.cancel();
    const viewport = p.page.getViewport({ scale: scale * dpr, rotation: (p.page.rotate + this.rotation * 90) % 360 });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(viewport.width); canvas.height = Math.round(viewport.height);
    // checkboxes and radio buttons are drawn checked and unchecked, each on a
    // canvas of its own that the form layer shows as the field is set
    p.canvasMap ||= new Map();
    p.task = p.page.render({ canvasContext: canvas.getContext('2d'), viewport, annotationCanvasMap: p.canvasMap,
                             annotationMode: this.annotations === false ? lib.AnnotationMode.DISABLE : lib.AnnotationMode.ENABLE_FORMS });
    try { await p.task.promise; } catch { return; }
    if (p.token !== token) return;
    p.canvas?.remove();
    p.el.prepend(canvas);
    p.canvas = canvas;
    this.drawInk(i);
    if (!p.links) this.links(i);
    if (!p.forms) this.forms(i);
    else p.formLayer?.update({ viewport: this.viewportFor(i, 1).clone({ dontFlip: true }) });
    if (!p.text) this.text(i);
  }

  async text(i) {
    const p = this.pages[i];
    if (p.text) return;
    const div = document.createElement('div');
    div.className = 'textLayer';
    p.text = div;
    const viewport = p.page.getViewport({ scale: 1, rotation: (p.page.rotate + this.rotation * 90) % 360 });
    lib.setLayerDimensions(div, viewport);
    const layer = new lib.TextLayer({ textContentSource: p.page.streamTextContent({ includeMarkedContent: true, disableNormalization: true }), container: div, viewport });
    await layer.render().catch(() => {});
    p.el.append(div);
  }

  // Pages' text ahead of drawing, so the find bar finds words on pages not
  // drawn yet: nearest to the reader first. A short document gets all of it; a
  // long one only the pages around the reader, following as they scroll.
  // Converting all 829 pages of a lecture script in order kept the page being
  // read waiting behind every page before it, model calls included.
  textAround() {
    clearTimeout(this.textTimer);
    this.textTimer = setTimeout(() => this.textRun(), 120);
  }

  async textRun() {
    const run = (this.textGen = (this.textGen || 0) + 1);
    const n = this.pages.length, seen = this.visible();
    const first = seen.length ? Math.min(...seen) : 0, last = seen.length ? Math.max(...seen) : 0;
    const from = n <= TEXT_ALL ? 0 : Math.max(0, first - TEXT_BEHIND);
    const to = n <= TEXT_ALL ? n - 1 : Math.min(n - 1, last + TEXT_AHEAD);
    const away = i => i < first ? first - i : i > last ? i - last : 0;
    const order = [];
    for (let i = from; i <= to; i++) order.push(i);
    order.sort((a, b) => away(a) - away(b) || a - b);
    for (const i of order) {
      if (this.textGen !== run) return;          // the reader moved on: a new plan is coming
      if (this.pages[i].text) continue;
      await this.text(i);
      await new Promise(r => setTimeout(r, 0));
    }
  }

  async links(i) {
    const p = this.pages[i];
    p.links = true;
    const notes = await p.page.getAnnotations({ intent: 'display' }).catch(() => []);
    const layer = document.createElement('div');
    layer.className = 'links';
    Object.assign(layer.style, { position: 'absolute', inset: '0', zIndex: 3 });
    const [px0, py0] = p.page.view;
    const [w, h] = this.pageSize(i);
    for (const a of notes) {
      if (a.subtype !== 'Link' || !a.rect) continue;
      const [x0, y0, x1, y1] = a.rect;
      const link = document.createElement('a');
      Object.assign(link.style, { left: `${(x0 - px0) / w * 100}%`, top: `${(h - (y1 - py0)) / h * 100}%`, width: `${(x1 - x0) / w * 100}%`, height: `${(y1 - y0) / h * 100}%` });
      if (a.url) {
        link.href = a.url;
        link.addEventListener('click', e => { e.preventDefault(); this.post({ type: 'navigate', url: a.url, disposition: e.ctrlKey || e.metaKey ? 4 : e.shiftKey ? 6 : 1 }); });
      } else if (a.dest) {
        link.href = '#';
        link.addEventListener('click', async e => {
          e.preventDefault();
          const dest = typeof a.dest === 'string' ? await this.doc.getDestination(a.dest) : a.dest;
          if (!dest) return;
          const page = await this.doc.getPageIndex(dest[0]).catch(() => null);
          if (page == null) return;
          if (dest[1]?.name === 'XYZ' && dest[3] != null) this.post({ type: 'navigateToDestination', page, x: dest[2] ?? 0, y: dest[3], zoom: dest[4] || 0 });
          else this.post({ type: 'goToPage', page });
        });
      } else continue;
      layer.append(link);
    }
    p.el.append(layer);
  }

  // Form fields to fill in, as pdf.js makes them (its annotation layer; links
  // are links() above). A first change tells the viewer there are edits, so
  // that saving asks with or without them, as with PDFium.
  async forms(i) {
    const p = this.pages[i];
    p.forms = true;
    const all = await p.page.getAnnotations({ intent: 'display' }).catch(() => []);
    const fields = all.filter(a => a.annotationType === lib.AnnotationType.WIDGET);
    if (!fields.length) return;
    this.fieldObjects ||= this.doc.getFieldObjects().catch(() => null);
    const div = document.createElement('div');
    div.className = 'annotationLayer';
    const viewport = this.viewportFor(i, 1).clone({ dontFlip: true });
    const noLinks = { addLinkAttributes() {}, getDestinationHash: () => '#', getAnchorUrl: () => '#', goToDestination() {},
                      executeNamedAction() {}, executeSetOCGState() {}, externalLinkEnabled: false };
    const layer = new lib.AnnotationLayer({ div, page: p.page, viewport, annotationStorage: this.doc.annotationStorage,
                                            accessibilityManager: null, annotationCanvasMap: p.canvasMap, annotationEditorUIManager: null,
                                            structTreeLayer: null, commentManager: null, linkService: noLinks });
    await layer.render({ annotations: fields, viewport, linkService: noLinks, imageResourcesPath: '', renderForms: true,
                         enableScripting: false, hasJSActions: false, fieldObjects: await this.fieldObjects }).catch(err => console.error('[Hochdeutsch-Fixer]', err));
    const edited = () => {
      if (this.formsEdited) return;
      this.formsEdited = true;
      this.post({ type: 'setIsEditing' });
    };
    div.addEventListener('input', edited);
    div.addEventListener('change', edited);
    p.formLayer = layer;
    p.el.append(div);
  }

  redraw(i) {
    const p = this.pages[i];
    if (!p) return;
    p.scale = 0;
    p.text?.remove(); p.text = null;
    this.text(i);
    this.paintSoon();
  }

  onScroll() {
    if (this.applyingScroll) return;
    if (!this.scrollQueued) {
      this.scrollQueued = true;
      requestAnimationFrame(() => {
        this.scrollQueued = false;
        this.post({ type: 'syncScrollFromRemote', x: this.scroller.scrollLeft, y: this.scroller.scrollTop });
      });
    }
    this.paintSoon();
  }

  // ack: the viewer asked for this scroll and counts on an answer
  scrollTo(x, y, smooth, ack) {
    this.applyingScroll = true;
    this.scroller.scrollTo({ left: x, top: y, behavior: smooth ? 'smooth' : 'instant' });
    this.applyingScroll = false;
    if (ack) this.post({ type: 'ackScrollToRemote', x: this.scroller.scrollLeft, y: this.scroller.scrollTop });
    this.paintSoon();
  }

  // ---- drawing (Chrome's "Draw": pen, highlighter, eraser) ----
  // Strokes are kept in PDF points on the unrotated page, drawn over the page,
  // and saved as Ink annotations (pdf.js writes them). As in Chrome: a brush is
  // its size in pixels at 100%, the highlighter is 40% opaque with square ends,
  // the eraser takes away whole strokes, and each change is one undo step.
  viewportFor(i, scale) {
    const p = this.pages[i];
    return p.page.getViewport({ scale, rotation: (p.page.rotate + this.rotation * 90) % 360 });
  }

  inkInput(i, canvas) {
    let stroke = null, erased = null;
    const at = e => {
      const r = canvas.getBoundingClientRect();
      return this.viewportFor(i, r.width / this.pageSize(i)[0]).convertToPdfPoint(e.clientX - r.left, e.clientY - r.top);
    };
    canvas.addEventListener('pointerdown', e => {
      if (this.mode !== 'draw' || e.button !== 0) return;
      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      this.post({ type: 'startInkStroke' });
      const b = this.brush;
      if (b.type === 'eraser') { erased = []; this.erase(i, at(e), erased); return; }
      stroke = { page: i, type: b.type, color: { ...b.color }, width: b.size * 0.75, points: [at(e)] };
      this.strokes.push(stroke);
      this.drawInk(i);
    });
    canvas.addEventListener('pointermove', e => {
      if (stroke) { stroke.points.push(at(e)); this.drawInk(i); }
      else if (erased) this.erase(i, at(e), erased);
    });
    const end = () => {
      if (!stroke && !erased) return;
      let modified = true;
      if (stroke) this.did({ add: stroke });
      else if (erased.length) this.did({ erase: erased });
      else modified = false;
      stroke = erased = null;
      this.post({ type: 'finishInkStroke', modified });
      if (modified) this.thumbnailChanged(i);
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
  }

  // a change, for undo: what came after an undone change is gone
  did(change) {
    this.history.length = this.done;
    this.history.push(change);
    this.done = this.history.length;
  }

  undoRedo(undo) {
    if (undo ? this.done === 0 : this.done === this.history.length) return;
    const change = this.history[undo ? --this.done : this.done++];
    if (change.text) return;                // the viewer sends the text as it was
    const strokes = change.add ? [change.add] : change.erase;
    for (const s of strokes) s.removed = change.add ? undo : !undo;
    for (const page of new Set(strokes.map(s => s.page))) { this.drawInk(page); this.thumbnailChanged(page); }
  }

  erase(i, [x, y], erased) {
    const z = this.zoom * 4 / 3;                  // pixels per point
    let hit = false;
    for (const s of this.strokes) {
      if (s.page !== i || s.removed) continue;
      const reach = s.width / 2 + 2 / z;
      const near = s.points.some(([ax, ay], k) => {
        const [bx, by] = s.points[k + 1] || [ax, ay];
        const dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy;
        const t = len ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len)) : 0;
        return Math.hypot(x - ax - t * dx, y - ay - t * dy) <= reach;
      });
      if (near) { s.removed = true; erased.push(s); hit = true; }
    }
    if (hit) this.drawInk(i);
  }

  // the page's strokes onto a context whose units are the viewport's pixels;
  // at least `least` of them wide (thumbnails show thin lines, as Chrome's do)
  paintInk(ctx, i, viewport, least = 0) {
    const strokes = this.strokes.filter(s => s.page === i && !s.removed);
    if (!strokes.length) return;
    ctx.save();
    ctx.transform(...viewport.transform);
    for (const s of strokes) {
      const hl = s.type === 'highlighter';
      ctx.globalAlpha = hl ? 0.4 : 1;
      ctx.strokeStyle = `rgb(${s.color.r}, ${s.color.g}, ${s.color.b})`;
      ctx.fillStyle = ctx.strokeStyle;
      ctx.lineWidth = Math.max(s.width, least / viewport.scale);
      ctx.lineCap = hl ? 'square' : 'round';
      ctx.lineJoin = hl ? 'miter' : 'round';
      ctx.beginPath();
      ctx.moveTo(...s.points[0]);
      for (const pt of s.points.slice(1)) ctx.lineTo(...pt);
      if (s.points.length === 1) ctx.lineTo(s.points[0][0] + 0.01, s.points[0][1]);    // a dot
      ctx.stroke();
    }
    ctx.restore();
  }

  drawInk(i) {
    const p = this.pages[i];
    if (!p?.ink) return;
    const w = parseFloat(p.el.style.width), h = parseFloat(p.el.style.height);
    const dpr = devicePixelRatio || 1;
    const cw = Math.round(w * dpr), ch = Math.round(h * dpr);
    if (p.ink.width !== cw || p.ink.height !== ch) { p.ink.width = cw; p.ink.height = ch; }
    const ctx = p.ink.getContext('2d');
    ctx.clearRect(0, 0, cw, ch);
    this.paintInk(ctx, i, this.viewportFor(i, w / this.pageSize(i)[0] * dpr));
  }

  async thumbnailChanged(i) {
    const t = await this.thumbnail(i);
    this.post({ type: 'updateThumbnail', pageNumber: i + 1, imageData: t.imageData, width: t.width, height: t.height }, [t.imageData]);
  }

  // the document as saved: with the strokes as Ink annotations and the texts as
  // FreeText ones, or as it came
  async savedBytes(type) {
    const strokes = this.strokes.filter(s => !s.removed);
    if (!(type === 'ANNOTATION' || type === 'EDITED') || !(strokes.length || this.notes.size || this.formsEdited)) return this.data.slice();
    const storage = this.doc.annotationStorage;
    const keys = strokes.map((s, k) => {
      const flat = s.points.length > 1 ? s.points : [s.points[0], [s.points[0][0] + 0.01, s.points[0][1]]];
      const xs = flat.map(q => q[0]), ys = flat.map(q => q[1]), m = s.width;
      const key = `pdfjs_internal_editor_hdfx${k}`;
      storage.setValue(key, {
        annotationType: lib.AnnotationEditorType.INK, pageIndex: s.page, rotation: 0,
        color: [s.color.r, s.color.g, s.color.b], thickness: s.width, opacity: s.type === 'highlighter' ? 0.4 : 1,
        paths: { lines: [flat.flatMap(q => [NaN, NaN, NaN, NaN, q[0], q[1]])], points: [flat.flat()] },
        rect: [Math.min(...xs) - m, Math.min(...ys) - m, Math.max(...xs) + m, Math.max(...ys) + m],
      });
      return key;
    });
    for (const a of this.notes.values()) {
      // page pixels at 100% of the page as shown unturned -> PDF points
      const page = this.pages[a.pageIndex].page, box = a.textBoxRect, t = a.textAttributes;
      const v = page.getViewport({ scale: 4 / 3, rotation: page.rotate });
      const [x0, y0] = v.convertToPdfPoint(box.locationX, box.locationY);
      const [x1, y1] = v.convertToPdfPoint(box.locationX + box.width, box.locationY + box.height);
      const key = `pdfjs_internal_editor_hdfxt${a.id}`;
      storage.setValue(key, {
        annotationType: lib.AnnotationEditorType.FREETEXT, pageIndex: a.pageIndex, rotation: page.rotate,
        color: [t.color.r, t.color.g, t.color.b], fontSize: t.size * 0.75, value: a.text,
        rect: [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)],
      });
      keys.push(key);
    }
    try {
      return await this.doc.saveDocument();
    } finally {
      for (const key of keys) storage.remove(key);
    }
  }

  // ---- text annotations (Chrome's "Add text annotations") ----
  // The viewer edits a text in its own box; once done it hands it here
  // (finishTextAnnotation), in page pixels at 100% of the unrotated page, and
  // here it is shown as the box showed it, kept, printed and saved.
  notesLayer(i) {
    const p = this.pages[i];
    if (!p.notes) {
      p.notes = document.createElement('div');
      p.notes.className = 'notes';
      p.el.append(p.notes);
    }
    return p.notes;
  }

  renderNotes(i) {
    const p = this.pages[i];
    if (!p?.el) return;
    const layer = this.notesLayer(i);
    layer.replaceChildren();
    const z = this.zoom;
    // the unrotated page, turned as the pages are
    const [w, h] = this.pageSize(i), r = this.rotation;
    const [uw, uh] = r % 2 ? [h * 4 / 3, w * 4 / 3] : [w * 4 / 3, h * 4 / 3];
    const shift = [[0, 0], [uh, 0], [uw, uh], [0, uw]][r];
    Object.assign(layer.style, { width: `${uw * z}px`, height: `${uh * z}px`,
                                 transform: `translate(${shift[0] * z}px, ${shift[1] * z}px) rotate(${r * 90}deg)` });
    for (const a of this.notes.values()) {
      if (a.pageIndex !== i || a.id === this.editingNote) continue;
      const t = a.textAttributes, s = t.styles || {}, box = a.textBoxRect;
      const div = document.createElement('div');
      div.textContent = a.text;
      Object.assign(div.style, {
        left: `${box.locationX * z}px`, top: `${box.locationY * z}px`, width: `${box.width * z}px`, minHeight: `${box.height * z}px`,
        fontFamily: TYPEFACES[t.typeface] || TYPEFACES['sans-serif'], fontSize: `${t.size * z}px`,
        color: `rgb(${t.color.r}, ${t.color.g}, ${t.color.b})`, textAlign: t.alignment,
        fontWeight: s.bold ? 'bold' : 'normal', fontStyle: s.italic ? 'italic' : 'normal',
        textDecoration: [s.underline && 'underline', s.strikethrough && 'line-through'].filter(Boolean).join(' ') || 'none',
      });
      layer.append(div);
    }
  }

  // a note onto a canvas whose units are the viewport's pixels (print, thumbnails)
  paintNotes(ctx, i, viewport) {
    const notes = [...this.notes.values()].filter(a => a.pageIndex === i);
    if (!notes.length) return;
    const k = viewport.scale * 3 / 4;     // canvas pixels per page pixel
    const r = this.rotation, [w, h] = this.pageSize(i);
    const [uw, uh] = r % 2 ? [h * 4 / 3, w * 4 / 3] : [w * 4 / 3, h * 4 / 3];
    const shift = [[0, 0], [uh, 0], [uw, uh], [0, uw]][r];
    ctx.save();
    ctx.translate(shift[0] * k, shift[1] * k);
    ctx.rotate(r * Math.PI / 2);
    for (const a of notes) {
      const t = a.textAttributes, s = t.styles || {}, box = a.textBoxRect, size = t.size * k;
      ctx.font = `${s.italic ? 'italic ' : ''}${s.bold ? 'bold ' : ''}${size}px ${TYPEFACES[t.typeface] || TYPEFACES['sans-serif']}`;
      ctx.fillStyle = `rgb(${t.color.r}, ${t.color.g}, ${t.color.b})`;
      ctx.textBaseline = 'top';
      const width = box.width * k, lines = [];
      for (const para of a.text.split('\n')) {
        let line = '';
        for (const word of para.split(/(?<=\s)/)) {
          if (line && ctx.measureText(line + word).width > width) { lines.push(line); line = ''; }
          line += word;
        }
        lines.push(line);
      }
      lines.forEach((line, n) => {
        const lw = ctx.measureText(line.trimEnd()).width;
        const x = box.locationX * k + (t.alignment === 'center' ? (width - lw) / 2 : t.alignment === 'right' ? width - lw : 0);
        ctx.fillText(line.trimEnd(), x, box.locationY * k + n * size * 1.15);
      });
    }
    ctx.restore();
  }

  // ---- thumbnails, saving, printing ----
  async thumbnail(i) {
    const p = this.pages[i];
    const [w, h] = this.pageSize(i);
    const dpr = devicePixelRatio || 1;
    // the plugin's thumbnails: 108 pixels wide for a portrait page, 140 high for a landscape one,
    // drawn larger and scaled down, which is how lightly their text comes out
    const scale = (w <= h ? 108 / (w * 4 / 3) : 140 / (h * 4 / 3)) * dpr * 4 / 3;
    const SS = 3;
    const viewport = p.page.getViewport({ scale: scale * SS, rotation: (p.page.rotate + this.rotation * 90) % 360 });
    // a canvas of the page's document: an OffscreenCanvas would not have the
    // fonts the converted words are drawn in
    const big = Object.assign(document.createElement('canvas'), { width: Math.round(viewport.width), height: Math.round(viewport.height) });
    const bctx = big.getContext('2d');
    bctx.fillStyle = 'white'; bctx.fillRect(0, 0, big.width, big.height);
    await p.page.render({ canvasContext: bctx, viewport, intent: 'display', annotationMode: lib.AnnotationMode.ENABLE_STORAGE }).promise;
    this.paintInk(bctx, i, viewport, SS);
    this.paintNotes(bctx, i, viewport);
    // each pixel the average of its SS x SS block (a canvas scaled down by
    // drawImage skips samples, and thin strokes come and go)
    const width = Math.floor(viewport.width / SS + 1e-6), height = Math.floor(viewport.height / SS + 1e-6);   // rounded down, as PDFium does
    const src = bctx.getImageData(0, 0, big.width, big.height).data;
    const out = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const sum = [0, 0, 0, 0];
      for (let dy = 0; dy < SS; dy++) for (let dx = 0; dx < SS; dx++) {
        const k = ((y * SS + dy) * big.width + x * SS + dx) * 4;
        sum[0] += src[k]; sum[1] += src[k + 1]; sum[2] += src[k + 2]; sum[3] += src[k + 3];
      }
      const o = (y * width + x) * 4;
      for (let c = 0; c < 4; c++) out[o + c] = sum[c] / (SS * SS);
    }
    return { imageData: out.buffer, width, height };
  }

  fileName() {
    if (cfg.fileName) return cfg.fileName;       // the server's name for it (a replaced pdf.js viewer)
    let name = '';
    try { name = decodeURIComponent(new URL(cfg.url).pathname.split('/').pop() || ''); } catch {}
    return name || 'document.pdf';
  }

  async print() {
    const host = document.createElement('div');
    host.id = 'hdfx-print';
    const style = document.createElement('style');
    const [w0, h0] = this.pageSize(0);
    style.textContent = `@media print { body > :not(#hdfx-print) { display: none !important; } #hdfx-print { display: block !important; }
      #hdfx-print img { display: block; width: 100%; break-after: page; } }
      @media screen { #hdfx-print { display: none; } }
      @page { size: ${w0}pt ${h0}pt; margin: 0; }`;
    host.append(style);
    for (const [i, p] of this.pages.entries()) {
      const viewport = p.page.getViewport({ scale: 150 / 72, rotation: (p.page.rotate + this.rotation * 90) % 360 });
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(viewport.width); canvas.height = Math.round(viewport.height);
      await p.page.render({ canvasContext: canvas.getContext('2d'), viewport, intent: 'print', annotationMode: lib.AnnotationMode.ENABLE_STORAGE }).promise;
      this.paintInk(canvas.getContext('2d'), i, viewport);
      this.paintNotes(canvas.getContext('2d'), i, viewport);
      const img = new Image();
      img.src = canvas.toDataURL();
      await img.decode().catch(() => {});
      host.append(img);
    }
    document.body.append(host);
    window.print();
    host.remove();
  }

  selectAll() {
    const layers = this.pages.map(p => p.text).filter(Boolean);
    if (!layers.length) return;
    const sel = getSelection();
    const r = document.createRange();
    r.setStartBefore(layers[0]); r.setEndAfter(layers[layers.length - 1]);
    sel.removeAllRanges(); sel.addRange(r);
  }

  selectedText() {
    const sel = this.shadow.getSelection?.() || getSelection();
    return sel ? sel.toString() : '';
  }

  // ---- the viewer's messages ----
  async onMessage(m) {
    const reply = data => this.post({ messageId: m.messageId, ...data });
    switch (m.type) {
      case 'updateSize': this.size = { width: m.width, height: m.height }; this.paintSoon(); break;
      case 'syncScrollToRemote': this.scrollTo(m.x, m.y, m.isSmooth, true); break;
      case 'viewport':
        if (m.zoom && m.zoom !== this.zoom) {
          // while zooming, the pages drawn are stretched; they are drawn again
          // at the new size once the zoom has settled
          this.zoomedAt = performance.now();
          clearTimeout(this.settle);
          this.settle = setTimeout(() => { this.zoomedAt = 0; this.paintSoon(); }, ZOOM_SETTLE);
          this.zoom = m.zoom; this.place();
        }
        if (m.xOffset != null) this.scrollTo(m.xOffset, m.yOffset, false);
        this.paintSoon();
        break;
      case 'rotateClockwise': case 'rotateCounterclockwise':
        this.rotation = (this.rotation + (m.type === 'rotateClockwise' ? 1 : 3)) % 4;
        this.relayout();
        break;
      case 'setTwoUpView': this.twoUp = !!m.enableTwoUpView; this.relayout(); break;
      // presenting: no scrollbar, the pages centred on the whole screen
      case 'setPresentationMode': this.el.classList.toggle('presenting', !!m.enablePresentationMode); this.paintSoon(); break;
      case 'displayAnnotations': this.annotations = !!m.display; this.pages.forEach(p => { p.scale = 0; }); this.paintSoon(); break;
      case 'print': this.print(); break;
      case 'selectAll': this.selectAll(); break;
      case 'getSelectedText': reply({ type: 'getSelectedTextReply', selectedText: this.selectedText() }); break;
      case 'getThumbnail': reply({ type: 'getThumbnailReply', ...(await this.thumbnail(m.pageIndex)) }); break;
      case 'setBackgroundColor': break;
      case 'getPageBoundingBox': {
        const b = this.boxes?.[m.page];
        reply({ type: 'getPageBoundingBoxReply', x: 0, y: 0, width: b ? b.width - 10 : 0, height: b ? b.height - 10 : 0 });
        break;
      }
      case 'getPasswordComplete': this.open(m.password); break;
      case 'getNamedDestination': {
        const dest = await this.doc?.getDestination(m.namedDestination).catch(() => null);
        const pageNumber = dest ? await this.doc.getPageIndex(dest[0]).catch(() => -1) : -1;
        reply({ type: 'getNamedDestinationReply', pageNumber });
        break;
      }
      case 'focus': this.scroller.focus({ preventScroll: true }); break;
      case 'save': {
        const bytes = await this.savedBytes(m.saveRequestType);
        this.post({ type: 'saveData', token: m.token, dataToSave: bytes.buffer, fileName: this.fileName(), editModeForTesting: false });
        break;
      }
      case 'getSuggestedFileName': reply({ type: 'getSuggestedFileNameReply', fileName: this.fileName() }); break;
      case 'getSaveDataBlock': {
        const type = m.saveRequestType || 'ORIGINAL';
        if (!this.saving.has(type)) this.saving.set(type, this.savedBytes(type));
        const all = await this.saving.get(type);
        const chunk = all.slice(m.offset, m.offset + (m.blockSize || all.byteLength));
        this.post({ type: 'saveDataBlock', token: m.token, dataToSave: chunk.buffer, totalFileSize: all.byteLength });
        break;
      }
      case 'releaseSaveInBlockBuffers': this.saving.clear(); break;
      case 'saveAttachment': reply({ type: 'saveAttachmentReply', dataToSave: new ArrayBuffer(0) }); break;
      case 'setAnnotationMode':
        this.mode = m.mode;
        this.el.classList.toggle('drawing', m.mode === 'draw');
        this.el.classList.toggle('texting', m.mode === 'text');
        break;
      case 'getAnnotationBrush': {
        const b = this.brushes[m.brushType] || this.brush;
        reply({ type: 'getAnnotationBrushReply', data: structuredClone(b) });
        break;
      }
      case 'setAnnotationBrush': {
        const b = m.data;
        this.brush = this.brushes[b.type] = { ...this.brushes[b.type], ...structuredClone(b) };
        break;
      }
      case 'annotationUndo': this.undoRedo(true); break;
      case 'annotationRedo': this.undoRedo(false); break;
      case 'getAllTextAnnotations': reply({ type: 'getAllTextAnnotationsReply', annotations: [...this.notes.values()].map(a => structuredClone(a)) }); break;
      case 'finishTextAnnotation': {
        const a = structuredClone(m.data);
        // one undo step where the viewer counts one (it undoes texts itself)
        if (a.source === 'user' && a.isEdited && (this.notes.has(a.id) || a.text !== '')) this.did({ text: a.id });
        if (a.text === '') this.notes.delete(a.id);
        else this.notes.set(a.id, { id: a.id, pageIndex: a.pageIndex, text: a.text, textAttributes: a.textAttributes,
                                    textBoxRect: a.textBoxRect, textOrientation: a.textOrientation });
        if (this.editingNote === a.id) this.editingNote = null;
        this.notesVersion++;
        this.renderNotes(a.pageIndex);
        if (a.isEdited) this.thumbnailChanged(a.pageIndex);
        break;
      }
      case 'editTextAnnotation': {
        this.editingNote = m.data;
        const a = this.notes.get(m.data);
        if (a) this.renderNotes(a.pageIndex);
        break;
      }
      default:
        if (m.messageId) reply({ type: m.type + 'Reply' });   // anything else that waits for an answer
    }
  }

  // the page that is at the top of the window
  currentPage() {
    const y = this.scroller.scrollTop / this.zoom;
    const i = this.boxes.findIndex(b => b.y + b.height > y);
    return i < 0 ? 0 : i;
  }

  relayout() {
    const page = this.boxes ? this.currentPage() : 0;
    this.layout();
    // the page stays in view, its left edge at the window's when the document is wider
    const b = this.boxes[page];
    const x = this.dims.width * this.zoom > this.scroller.clientWidth ? b.x * this.zoom : 0;
    this.scroller.scrollTo({ left: x, top: b.y * this.zoom, behavior: 'instant' });
    this.pages.forEach(p => { p.scale = 0; p.text?.remove(); p.text = null; p.links = false; p.el?.querySelector('.links')?.remove();
                              p.forms = false; p.formLayer = null; p.el?.querySelector('.annotationLayer')?.remove(); });
    this.post({ type: 'documentDimensions', ...this.dims });
    // the viewer owns the scroll position: it is told, as PDFium tells it
    this.post({ type: 'setScrollPosition', x, y: b.y * this.zoom });
    this.paintSoon();
    this.textAround();
  }
}

function formatSize(n) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let u = 0, v = n;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
  return `${u ? v.toFixed(1) : v} ${units[u]}`;
}

// The page shadow as the plugin draws it, in the room left around each page:
// the page shifted down by 2 pixels, darkening the background by an amount
// that falls off with the distance from it (measured off Chrome, to within a
// third of a shade on average), all of it scaled with the zoom.
const FALLOFF = [14, 11, 8, 6, 4, 2, 0];     // at distance 0, 1, ... 6 (and 16 inside)
const darken = t => (t <= -1 ? 16 : t < 0 ? 14 + 2 * -t : t >= 6 ? 0 : FALLOFF[Math.floor(t)] * (1 - (t % 1)) + FALLOFF[Math.min(6, Math.floor(t) + 1)] * (t % 1));
const shadows = new Map();
function shadowFor(el, z, boxW, boxH, ins) {
  const dpr = devicePixelRatio || 1;
  const W = Math.round(boxW * z * dpr), H = Math.round(boxH * z * dpr);
  const key = `${W}x${H}@${z * dpr}/${ins.left},${ins.right}`;
  if (el.dataset.key === key) return;
  el.dataset.key = key;
  let url = shadows.get(key);
  if (!url) {
    const k = z * dpr;
    const canvas = new OffscreenCanvas(W, H);
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(W, H);
    // the page, in this box's pixels, shifted down
    const px0 = ins.left * k, px1 = W - ins.right * k - 1, py0 = (ins.top + 2) * k, py1 = H - ins.bottom * k - 1 + 2 * k;
    const inside = (x, y) => x >= ins.left * k && x <= W - ins.right * k - 1 && y >= ins.top * k && y <= H - ins.bottom * k - 1;
    // only the band around the page: a row across it skips straight over its
    // inside (the pixels inside() is true for), which is all but a few pixels
    // of the bitmap, at every zoom step
    const in0 = Math.ceil(ins.left * k), in1 = Math.floor(W - ins.right * k - 1);
    const shade = (x, y) => {
      const dx = Math.max(px0 - x, 0, x - px1), dy = Math.max(py0 - y, 0, y - py1);
      const t = dx || dy ? Math.hypot(dx, dy) / k : -Math.min(x - px0, px1 - x, y - py0, py1 - y) / k;
      const a = darken(t) / 40;
      img.data[(y * W + x) * 4 + 3] = Math.round(a * 255);
    };
    for (let y = 0; y < H; y++) {
      const across = in0 <= in1 && inside(in0, y);
      for (let x = 0; x < W; x++) {
        if (across && x === in0) { x = in1; continue; }
        if (!inside(x, y)) shade(x, y);
      }
    }
    ctx.putImageData(img, 0, 0);
    url = canvas.convertToBlob().then(b => URL.createObjectURL(b));
    shadows.set(key, url);
  }
  url.then(u => { if (el.dataset.key === key) el.style.background = `url(${u}) 0 0 / 100% 100% no-repeat`; });
}

// The PDF's bytes, from pdfview.js.
function bytes(progress) {
  return new Promise(resolve => {
    addEventListener('message', function take(e) {
      if (e.source !== window || e.data?.hdfxBytes !== cfg.streamUrl || !e.ports[0]) return;
      removeEventListener('message', take);
      const port = e.ports[0];
      port.onmessage = ({ data }) => {
        if (data.progress != null) progress(data.progress);
        if (data.done) resolve(data.data ? new Uint8Array(data.data) : null);
      };
    });
    window.postMessage({ hdfxWantBytes: cfg.streamUrl }, '*');
  });
}

let plugin = null;
globalThis.__hdfxPlugin = viewer => (plugin = new Plugin(viewer)).el;
onRedraw(i => plugin?.redraw(i));
