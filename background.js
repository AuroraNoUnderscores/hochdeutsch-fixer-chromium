// Service worker. It cannot hold the model itself — Chromium stops it when idle,
// which would unload ~92 MB of weights every time — so the model lives in an
// offscreen document and this worker only relays messages to it.
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
// reader), so the totals are collected here.
const tabCounts = new Map(); // tabId -> { href, frames: Map(frameId -> {count, meta}) }

function noteCount(sender, msg) {
  const id = sender.tab?.id;
  if (id == null) return;
  let entry = tabCounts.get(id);
  if (!entry || (msg.top && entry.href !== msg.href)) {
    entry = { href: msg.top ? msg.href : entry?.href, frames: new Map() };
    tabCounts.set(id, entry);
  }
  entry.frames.set(sender.frameId ?? 0, { count: msg.count, meta: msg.meta });
}

function tabTotal(id) {
  const entry = tabCounts.get(id);
  if (!entry) return null;
  let count = 0, meta = false, frames = 0;
  for (const [frameId, f] of entry.frames) {
    count += f.count;
    if (f.count) frames++;
    if (frameId === 0) meta = f.meta;
  }
  return { count, frames, meta };
}

chrome.tabs?.onRemoved?.addListener(id => tabCounts.delete(id));

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target === 'offscreen') return false; // meant for the offscreen document

  if (msg?.type === 'count') { noteCount(sender, msg); return false; }
  if (msg?.type === 'tab-count') { sendResponse(tabTotal(msg.tabId)); return false; }

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
