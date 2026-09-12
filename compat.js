// Lets the Firefox-style `browser.*` code run unchanged on Chromium.
// Chrome's promise-returning APIs match Firefox closely enough; the one real
// difference is onMessage, where Chrome ignores a returned promise and wants
// sendResponse plus `return true` instead.
globalThis.browser ??= (() => {
  const R = chrome.runtime;
  return {
    storage: chrome.storage,
    tabs: chrome.tabs,
    runtime: {
      getURL: path => R.getURL(path),
      sendMessage: msg => R.sendMessage(msg),
      onMessage: {
        addListener(fn) {
          R.onMessage.addListener((msg, sender, sendResponse) => {
            const out = fn(msg, sender);
            if (out && typeof out.then === 'function') {
              out.then(sendResponse, () => sendResponse(undefined));
              return true; // respond asynchronously
            }
            if (out !== undefined) sendResponse(out);
            return false;
          });
        },
      },
    },
  };
})();
