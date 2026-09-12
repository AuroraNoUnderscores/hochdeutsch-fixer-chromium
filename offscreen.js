// Holds the baby LLM for as long as the browser session needs it and answers
// ranking requests relayed by the service worker, one at a time. Decisions are
// cached; context-free ones (a word's ß spelling) by word, so a page full of
// "Strasse" costs one call.
import { load, score, MODEL } from './llm.js';

const state = { status: 'idle', progress: 0, decided: 0, error: null, model: MODEL };
const cache = new Map();
let chain = Promise.resolve();
let started = null;

function ensure() {
  started ??= (async () => {
    state.status = 'loading';
    state.progress = 0;
    try {
      await load(p => {
        if (p.status === 'progress' && /\.onnx/.test(p.file || '')) state.progress = Math.round(p.progress || 0);
      });
      state.status = 'ready';
      state.progress = 100;
    } catch (e) {
      state.status = 'error';
      state.error = String(e?.message || e);
      started = null;
      throw e;
    }
  })();
  return started;
}

async function rank(jobs) {
  await ensure();
  chain = chain.then(async () => {
    const picks = [];
    for (const j of jobs) {
      const key = j.cf && j.key ? j.key : JSON.stringify(j.texts);
      if (cache.has(key)) { picks.push(cache.get(key)); continue; }
      const scores = await score(j.texts);
      const best = scores.indexOf(Math.max(...scores));
      cache.set(key, best);
      if (cache.size > 20000) cache.delete(cache.keys().next().value);
      state.decided++;
      picks.push(best);
    }
    return picks;
  }).catch(e => { console.error('[Hochdeutsch-Fixer]', e); return null; });
  return chain;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return false;
  if (msg.type === 'llm-status') { sendResponse({ ...state }); return false; }
  if (msg.type === 'llm-load') { ensure().catch(() => {}); sendResponse(true); return false; }
  if (msg.type === 'rank') { rank(msg.jobs).then(sendResponse, () => sendResponse(null)); return true; }
  return false;
});
