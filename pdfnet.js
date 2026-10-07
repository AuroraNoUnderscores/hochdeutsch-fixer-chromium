// Chrome shows PDFs in its own viewer, which no extension can reach. So a rule
// (declarativeNetRequest) has a PDF response arrive as inert plain text: the
// tab stays at the PDF's address, with an ordinary page there, and pdfview.js
// puts Chrome's own viewer interface on it (pdfviewer/, copied from Chrome),
// drawing the pages with pdf.js and the converted text (pdfplugin.mjs).
//
// Plain text, not HTML: a PDF's bytes must never be parsed as a page of the
// site that serves it. PDFs Chrome would download (Content-Disposition:
// attachment) are left alone, as are PDFs on switched-off sites.
const RULE = 4207;
const PDF = ['application/pdf*', 'application/x-pdf*'];
let on = true;

async function updateRule() {
  const s = await chrome.storage.local.get(['enabled', 'disabledSites', 'pdf']);
  on = s.enabled !== false && s.pdf !== false;
  const sites = (s.disabledSites || []).filter(Boolean);
  const rule = {
    id: RULE, priority: 1,
    condition: {
      resourceTypes: ['main_frame', 'sub_frame', 'object'],
      responseHeaders: [{ header: 'content-type', values: PDF }],
      excludedResponseHeaders: [{ header: 'content-disposition', values: ['attachment*'] }],
      ...(sites.length ? { excludedRequestDomains: sites } : {}),
    },
    action: {
      type: 'modifyHeaders',
      responseHeaders: [
        { header: 'content-type', operation: 'set', value: 'text/plain; charset=x-user-defined' },
        { header: 'x-content-type-options', operation: 'set', value: 'nosniff' },
        // the viewer's scripts come from this extension
        { header: 'content-security-policy', operation: 'remove' },
        { header: 'content-security-policy-report-only', operation: 'remove' },
      ],
    },
  };
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [RULE], addRules: on ? [rule] : [] });
}
updateRule();
chrome.storage.onChanged.addListener((ch, area) => {
  if (area === 'local' && ['enabled', 'disabledSites', 'pdf'].some(k => k in ch)) updateRule();
});

// Which documents arrived as PDFs, so that pdfview.js only ever takes over
// those (a page cannot pose as one). Kept in session storage: Chrome stops this
// worker when it is idle.
const header = (d, name) => d.responseHeaders?.find(h => h.name.toLowerCase() === name)?.value || '';
const recent = [];      // this worker's own, before session storage has them
const isPdf = v => /^\s*application\/(x-)?pdf\s*(;|$)/i.test(v) || /charset=x-user-defined/i.test(v);

chrome.webRequest.onHeadersReceived.addListener(d => {
  if (!on || d.statusCode < 200 || d.statusCode >= 300 || d.statusCode === 206) return;
  if (!isPdf(header(d, 'content-type')) || /^\s*attachment/i.test(header(d, 'content-disposition'))) return;
  const length = +header(d, 'content-length') || -1;
  const entry = { url: d.url, tabId: d.tabId, frameId: d.frameId, length, at: Date.now() };
  recent.push(entry);
  if (recent.length > 50) recent.shift();
  chrome.storage.session.get('pdfLoads').then(({ pdfLoads = [] }) => {
    pdfLoads.push(entry);
    chrome.storage.session.set({ pdfLoads: pdfLoads.filter(l => Date.now() - l.at < 600000).slice(-50) });
  });
}, { urls: ['<all_urls>'], types: ['main_frame', 'sub_frame', 'object'] }, ['responseHeaders']);

// Is this document a PDF that arrived here as text? Then: what the viewer needs.
export async function pdfLoad(sender) {
  const { pdfLoads = [] } = await chrome.storage.session.get('pdfLoads');
  pdfLoads.push(...recent);
  const tab = sender.tab?.id, frame = sender.frameId ?? 0;
  const load = [...pdfLoads].reverse().find(l => l.url === sender.url && (l.tabId < 0 || (l.tabId === tab && l.frameId === frame)));
  if (!load) return null;
  return { url: load.url, length: load.length, tabId: tab ?? -1, tabUrl: sender.tab?.url || load.url, embedded: frame !== 0 };
}
