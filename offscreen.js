// Holds the baby LLM for as long as the browser session needs it and answers
// ranking requests relayed by the service worker, one at a time. Decisions are
// cached; context-free ones (a word's ß spelling) by word, so a page full of
// "Strasse" costs one call.
import { load, score, eszett, MODEL } from './llm.js';

const state = { status: 'idle', progress: 0, decided: 0, error: null, model: MODEL };
const cache = new Map();
const log = [];   // what the model recently did, for the popup

function note(entry) {
  log.unshift(entry);
  log.length = Math.min(log.length, 20);
}
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
  if (jobs.some(j => j.type !== 'eszett')) await ensure();
  chain = chain.then(async () => {
    const picks = [];
    for (const j of jobs) {
      if (j.type === 'eszett') {                        // ss/ß for a whole text, one pass
        picks.push(await eszett(j.text, j.offsets, j.spans));
        state.decided += j.offsets.length;
        continue;
      }
      const key = j.cf && j.key ? j.key : JSON.stringify(j.texts);
      if (cache.has(key)) { picks.push(cache.get(key)); continue; }
      const scores = await score(j.texts);
      let best = scores.indexOf(Math.max(...scores));
      // Only overrule the rules when clearly better; a near-tie keeps their
      // default, which is what stops confident-sounding nonsense.
      const def = j.def ?? 0;
      const margin = scores[best] - scores[def];
      const shy = best !== def && margin < (j.conf ?? 0);
      if (shy) best = def;
      if (j.opts && (best !== def || shy)) note({
        from: j.opts[def], to: j.opts[shy ? scores.indexOf(Math.max(...scores)) : best],
        margin: +margin.toFixed(1), kept: shy,
      });
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
  if (msg.type === 'llm-status') { sendResponse({ ...state, log: log.slice(0, 5) }); return false; }
  if (msg.type === 'llm-load') { ensure().catch(() => {}); sendResponse(true); return false; }
  if (msg.type === 'rank') { rank(msg.jobs).then(sendResponse, () => sendResponse(null)); return true; }
  return false;
});
