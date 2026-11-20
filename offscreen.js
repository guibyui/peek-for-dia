// Hidden document the background uses for the clipboard.
//  - offscreen:copy  writes text (works no matter which page has focus).
//  - offscreen:watch while a peek or Blank Window is open, notices when the
//    browser's own "Copy URL" (⌘⇧C) puts the wrong address on the clipboard,
//    so the background can swap in the URL of the page you're looking at.

const ta = document.getElementById('ta');
let last = null;
let timer = null;

function read() {
  ta.value = '';
  ta.focus();
  ta.select();
  try { document.execCommand('paste'); } catch (_) {}
  return ta.value;
}

function tick() {
  const text = read();
  if (last === null) { last = text; return; }
  if (text !== last) {
    last = text;
    chrome.runtime.sendMessage({ type: 'clip:changed', text }).catch(() => {});
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg) return false;
  if (msg.type === 'offscreen:copy') {
    ta.value = msg.text;
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (_) {}
    if (ok) last = msg.text; // don't report our own write
    sendResponse({ ok });
  } else if (msg.type === 'offscreen:watch') {
    if (msg.on && !timer) {
      last = read();
      timer = setInterval(tick, 250);
    } else if (!msg.on && timer) {
      clearInterval(timer);
      timer = null;
    }
    sendResponse({ ok: true });
  }
  return false;
});
