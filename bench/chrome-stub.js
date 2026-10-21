// XFL bench — chrome.* stub for running the real content.js in a real page DOM.
// Rationale: content.js normally runs in an isolated world where `chrome.*`
// exists. In a plain page we emulate only the APIs it touches. The 150 ms scan
// debounce (setTimeout(scan, 150) in onMut) is intercepted to run
// synchronously, so a MutationObserver-triggered scan completes within one
// microtask checkpoint — that makes per-tick costs measurable deterministically.
// All other timers stay real (initial triple scan 0/400/1200, flashes, hints).
(function () {
  'use strict';

  const origSetTimeout = window.setTimeout.bind(window);
  window.__origSetTimeout = origSetTimeout;
  window.__xflBgCalls = [];

  window.chrome = {
    runtime: {
      onMessage: {
        addListener(fn) { window.__xflListener = fn; }
      },
      // Must look promise-like for `.catch(() => {})` in sendStats
      sendMessage(msg) {
        window.__xflBgCalls.push(msg);
        return { catch() {} };
      },
      lastError: null
    },
    storage: {
      local: {
        get(defs, cb) { cb && cb({ mode: 'nf' }); },
        set() {}
      }
    }
  };

  // Intercept ONLY delay===150 (exclusive to the scanner debounce in content.js;
  // other delays in the file: 0/400/1200 initial scans, 1900 flash reset,
  // 300/400/700/1400 unfollow flow, 2000/2400/2600/4000 hints, UNF_PAUSE 2200+).
  window.setTimeout = function (fn, delay) {
    if (delay === 150 && typeof fn === 'function') { fn(); return 0; }
    return origSetTimeout(fn, delay);
  };
})();
