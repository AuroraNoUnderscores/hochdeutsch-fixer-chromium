// Service worker. It cannot hold the model itself — Chromium stops it when idle,
// which would unload ~92 MB of weights every time — so the model lives in an
// offscreen document and this worker only relays messages to it.
import { pdfLoad } from './pdfnet.js';

const OFFSCREEN = 'offscreen.html';
let creating = null;

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  creating ??= chrome.offscreen.createDocument({
    url: OFFSCREEN,
    reasons: ['WORKERS'],
    justification: 'Runs a small local language model that ranks candidate rewrites.',
  });
  try { await creating; } finally { creating = null; }
}

async function relay(msg) {
  await ensureOffscreen();
  return chrome.runtime.sendMessage({ ...msg, target: 'offscreen' });
}

// What each frame of each tab has changed. The popup talks only to the top
// frame, but the work often happens in an iframe (an artifact, an embedded
// reader), so the totals are collected here. Chromium stops this worker when
// it is idle, so they live in session storage, not in memory.
const tabKey = id => 'tab:' + id;

async function noteCount(sender, msg) {
  const id = sender.tab?.id;
  if (id == null) return;
  const key = tabKey(id);
  let entry = (await chrome.storage.session.get(key))[key];
  if (!entry || (msg.top && entry.href !== msg.href)) entry = { href: msg.top ? msg.href : entry?.href, frames: {} };
  entry.frames[sender.frameId ?? 0] = { count: msg.count, meta: msg.meta, changes: msg.changes || [], names: msg.names || [] };
  await chrome.storage.session.set({ [key]: entry });
}

async function tabTotal(id) {
  const key = tabKey(id);
  const entry = (await chrome.storage.session.get(key))[key];
  if (!entry) return null;
  let count = 0, meta = false, frames = 0;
  const changes = new Map(), names = new Map();
  for (const [frameId, f] of Object.entries(entry.frames)) {
    count += f.count;
    if (f.count) frames++;
    if (frameId === '0') meta = f.meta;
    for (const [from, to, n] of f.changes) changes.set(from + '\0' + to, (changes.get(from + '\0' + to) || 0) + n);
    for (const [word, n] of f.names) names.set(word, (names.get(word) || 0) + n);
  }
  const sorted = m => [...m].sort((p, q) => q[1] - p[1]);
  return {
    count, frames, meta,
    changes: sorted(changes).map(([k, n]) => [...k.split('\0'), n]),
    names: sorted(names),
  };
}

// Frames report one after another; each update reads and writes the tab's
// entry, so they are done in order.
let counting = Promise.resolve();
chrome.tabs?.onRemoved?.addListener(id => { counting = counting.then(() => chrome.storage.session.remove(tabKey(id))); });

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target === 'offscreen') return false; // meant for the offscreen document

  if (msg?.type === 'count') { counting = counting.then(() => noteCount(sender, msg)).catch(() => {}); return false; }
  if (msg?.type === 'tab-count') { counting.then(() => tabTotal(msg.tabId)).then(sendResponse, () => sendResponse(null)); return true; }

  if (msg?.type === 'pdf-load') { pdfLoad(sender).then(sendResponse, () => sendResponse(null)); return true; }
  // A PDF frame the text engine was not injected into: the page scripts wait
  // for the frame to be idle, which a frame stopped early (pdfview.js) may never
  // be. It is put there at once, for PDF frames only.
  if (msg?.type === 'pdf-engine') {
    pdfLoad(sender).then(load => {
      if (!load || !sender.tab) return sendResponse(false);
      const files = chrome.runtime.getManifest().content_scripts[0].js.filter(f => f !== 'content.js');
      return chrome.scripting.executeScript({ target: { tabId: sender.tab.id, frameIds: [sender.frameId] }, files, injectImmediately: true })
        .then(() => sendResponse(true));
    }).catch(() => sendResponse(false));
    return true;
  }

  if (msg?.type === 'top-host') {
    let host = null;
    try { host = new URL(sender.tab?.url || '').hostname || null; } catch {}
    sendResponse(host);
    return false;
  }

  if (msg?.type === 'rank' || msg?.type === 'llm-status' || msg?.type === 'llm-load') {
    (async () => {
      const { llm = true } = await chrome.storage.local.get('llm');
      if (!llm && msg.type === 'rank') return null;
      return relay(msg);
    })().then(sendResponse, e => { console.error('[Hochdeutsch-Fixer]', e); sendResponse(null); });
    return true;
  }
});
