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

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target === 'offscreen') return false; // meant for the offscreen document

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
