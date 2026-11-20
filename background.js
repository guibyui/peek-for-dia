// Peek: background service worker
// Owns everything that needs privileged APIs: the per-tab header rule that lets
// a page be framed, the nonce that proves a peek card was opened by us, the
// "open in tab / window" actions and the popup-window fallback.

const DEFAULTS = { modifier: 'shift', mode: 'overlay', autoPeekSites: [] };

const getSettings = () => chrome.storage.sync.get(DEFAULTS);
const isPeekPage = (sender) => (sender.url || '').startsWith('chrome-extension://');

// ---------- session state (service workers can be killed at any time) ----------

async function getState() {
  const { peekState } = await chrome.storage.session.get('peekState');
  return peekState || { nonces: {}, peekWindowId: null };
}
async function setState(patch) {
  const state = await getState();
  await chrome.storage.session.set({ peekState: { ...state, ...patch } });
}

// ---------- framing rule ----------
// Many sites send X-Frame-Options or CSP frame-ancestors, which would leave the
// card blank. While a peek is open we drop those two headers for sub-frames in
// that one tab only, and remove the rule as soon as the peek closes.

async function allowFraming(tabId) {
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [tabId],
    addRules: [{
      id: tabId,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        responseHeaders: [
          { header: 'x-frame-options', operation: 'remove' },
          { header: 'content-security-policy', operation: 'remove' }
        ]
      },
      condition: { tabIds: [tabId], resourceTypes: ['sub_frame'] }
    }]
  });
}

async function revokeFraming(tabId) {
  try {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [tabId] });
  } catch (_) { /* rule may already be gone */ }
  const state = await getState();
  if (state.nonces[tabId]) {
    delete state.nonces[tabId];
    await setState({ nonces: state.nonces });
  }
  await setWatch(tabId, null);
}

// ---------- opening ----------

async function openPeek(tab, url, x, y) {
  if (!/^https?:/i.test(url)) return;
  const { mode } = await getSettings();
  if (mode === 'window') return openPeekWindow(tab.windowId, url);

  const nonce = crypto.randomUUID();
  const state = await getState();
  state.nonces[tab.id] = nonce;
  await setState({ nonces: state.nonces });
  await allowFraming(tab.id);

  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'peek:show', url, x, y, nonce }, { frameId: 0 });
  } catch (_) {
    // No content script in this tab (browser pages, web store, etc.)
    await revokeFraming(tab.id);
    await openPeekWindow(tab.windowId, url);
  }
}

async function openPeekWindow(windowId, url) {
  const state = await getState();
  if (state.peekWindowId) {
    try { await chrome.windows.remove(state.peekWindowId); } catch (_) {}
  }
  let bounds = {};
  try {
    const win = await chrome.windows.get(windowId);
    const width = Math.round(win.width * 0.78);
    const height = Math.round(win.height * 0.86);
    bounds = {
      width,
      height,
      left: Math.round(win.left + (win.width - width) / 2),
      top: Math.round(win.top + (win.height - height) / 2)
    };
  } catch (_) {}
  const created = await chrome.windows.create({ url, type: 'popup', focused: true, ...bounds })
    .catch(() => chrome.windows.create({ url, type: 'popup', focused: true }));
  await setState({ peekWindowId: created.id });
}

// ---------- clipboard ----------
// Copies go through an offscreen document so they work regardless of focus or
// the site's Permissions-Policy. A second write a moment later wins over the
// browser's own "copy URL" command, which in a Blank Window would copy the
// extension page's address instead of the site's.

let offscreenReady = null;
async function ensureOffscreen() {
  if (chrome.offscreen.hasDocument && await chrome.offscreen.hasDocument()) return;
  if (!offscreenReady) {
    offscreenReady = chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['CLIPBOARD'],
      justification: 'Copy the URL of the page shown in a peek or Blank Window'
    }).catch((e) => { if (!/single offscreen/i.test(String(e))) throw e; })
      .finally(() => { offscreenReady = null; });
  }
  await offscreenReady;
}

async function writeClipboard(text) {
  try {
    await ensureOffscreen();
    const res = await chrome.runtime.sendMessage({ type: 'offscreen:copy', text });
    return !!(res && res.ok);
  } catch (_) {
    return false;
  }
}

async function copyText(text) {
  const ok = await writeClipboard(text);
  if (ok) setTimeout(() => writeClipboard(text), 250);
  return ok;
}

// ---------- fixing the browser's own ⌘⇧C ----------
// Dia handles ⌘⇧C before the page sees it and copies the tab's address: the
// page behind a peek, or chrome-extension://…/blank.html in a Blank Window.
// While one of those is open, the offscreen page watches the clipboard and, when
// that exact address shows up, the background replaces it with the URL you're
// actually looking at.

async function setWatch(tabId, watch) {
  const state = await getState();
  const watches = state.watches || {};
  const had = !!watches[tabId];
  if (watch) watches[tabId] = watch; else delete watches[tabId];
  if (!watch && !had) return;
  await setState({ watches });
  await syncClipboardWatch(watches);
}

async function syncClipboardWatch(watches) {
  const on = Object.values(watches).some((w) => w && w.url);
  try {
    if (on) await ensureOffscreen();
    else if (chrome.offscreen.hasDocument && !(await chrome.offscreen.hasDocument())) return;
    await chrome.runtime.sendMessage({ type: 'offscreen:watch', on });
  } catch (_) {}
}

const mdEscape = (s) => s.replace(/([[\]\\])/g, '\\$1');

async function onClipboardChanged(text) {
  text = (text || '').trim();
  if (!text) return;
  const state = await getState();
  const watches = state.watches || {};
  const blankPrefix = chrome.runtime.getURL('blank.html');
  let best = null;
  for (const [id, w] of Object.entries(watches)) {
    if (!w || !w.url) continue;
    let tab;
    try { tab = await chrome.tabs.get(Number(id)); } catch (_) { continue; }
    const host = w.kind === 'blank' ? blankPrefix : (tab.url || '');
    if (!host) continue;
    const plain = w.kind === 'blank' ? text.startsWith(host) : text === host;
    const markdown = !plain && text.startsWith('[') && text.includes('](' + host);
    if (!plain && !markdown) continue;
    const score = tab.active ? 1 : 0;
    if (!best || score > best.score) best = { tabId: Number(id), w, markdown, score };
  }
  if (!best) return;
  const replacement = best.markdown
    ? `[${mdEscape(best.w.title || best.w.url)}](${best.w.url})`
    : best.w.url;
  if (await writeClipboard(replacement)) {
    chrome.runtime.sendMessage({ type: 'copied:notify', tabId: best.tabId, markdown: best.markdown }).catch(() => {});
  }
}

// ---------- Blank Window ----------

async function openBlankWindow(url, sourceWindowId) {
  let bounds = { width: 1280, height: 820 };
  try {
    const win = sourceWindowId
      ? await chrome.windows.get(sourceWindowId)
      : await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
    const width = Math.min(1440, Math.round(win.width * 0.85));
    const height = Math.round(win.height * 0.88);
    bounds = {
      width,
      height,
      left: Math.round(win.left + (win.width - width) / 2),
      top: Math.round(win.top + (win.height - height) / 2)
    };
  } catch (_) {}
  const page = chrome.runtime.getURL('blank.html') + (url ? '?u=' + encodeURIComponent(url) : '');
  try {
    await chrome.windows.create({ url: page, type: 'popup', focused: true, ...bounds });
  } catch (_) {
    // Bounds can be rejected on odd multi-monitor layouts; let the browser place it
    await chrome.windows.create({ url: page, type: 'popup', focused: true });
  }
}

async function openInMainWindow(urls) {
  if (!urls.length) return;
  let win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => null);
  if (!win) {
    win = await chrome.windows.create({ url: urls[0], focused: true });
    urls = urls.slice(1);
  }
  for (let i = 0; i < urls.length; i++) {
    await chrome.tabs.create({ windowId: win.id, url: urls[i], active: i === 0 });
  }
  await chrome.windows.update(win.id, { focused: true });
}

async function hideOverlay(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'peek:hide' }, { frameId: 0 });
  } catch (_) {}
  await revokeFraming(tabId);
}

// ---------- messages ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tab = sender.tab;
  (async () => {
    switch (msg && msg.type) {
      case 'peek:open':
        if (tab) await openPeek(tab, msg.url, msg.x, msg.y);
        return {};

      case 'peek:validate': {
        // The peek page proves it was opened by us for this tab.
        const state = await getState();
        const ok = !!tab && isPeekPage(sender) && !!msg.nonce && state.nonces[tab.id] === msg.nonce;
        return { ok, tabId: ok ? tab.id : null };
      }

      case 'peek:closed':
        if (tab) await revokeFraming(tab.id);
        return {};

      case 'peek:to-tab':
        if (tab && isPeekPage(sender) && /^https?:/i.test(msg.url)) {
          await chrome.tabs.create({
            url: msg.url,
            windowId: tab.windowId,
            index: tab.index + 1,
            openerTabId: tab.id,
            active: true
          });
          await hideOverlay(tab.id);
        }
        return {};

      case 'peek:to-window':
        if (tab && isPeekPage(sender) && /^https?:/i.test(msg.url)) {
          await hideOverlay(tab.id);
          await openBlankWindow(msg.url, tab.windowId);
        }
        return {};

      case 'watch:update':
        // A peek card or Blank Window reports the URL it's showing
        if (tab && isPeekPage(sender)) {
          await setWatch(tab.id, msg.url ? { kind: msg.kind === 'blank' ? 'blank' : 'peek', url: msg.url, title: msg.title || '' } : null);
        }
        return {};

      case 'clip:changed':
        if ((sender.url || '').startsWith(chrome.runtime.getURL('offscreen.html'))) await onClipboardChanged(msg.text);
        return {};

      case 'copy:text':
        if (typeof msg.text === 'string' && msg.text.length < 100000) return { ok: await copyText(msg.text) };
        return { ok: false };

      case 'blank:new-window':
        await openBlankWindow(null, tab && tab.windowId);
        return {};

      case 'blank:register':
        // A Blank Window page asks for frame-blocking headers to be lifted in its tab
        if (tab && isPeekPage(sender)) {
          await allowFraming(tab.id);
          return { ok: true, tabId: tab.id, windowId: tab.windowId };
        }
        return { ok: false };

      case 'blank:to-dia':
        if (tab && isPeekPage(sender) && Array.isArray(msg.urls)) {
          await openInMainWindow(msg.urls.filter((u) => /^https?:/i.test(u)));
          if (msg.closeWindow) {
            try { await chrome.windows.remove(tab.windowId); } catch (_) {}
          }
        }
        return {};

      case 'peek:whoami': {
        const state = await getState();
        return { isPeekWindow: !!tab && tab.windowId === state.peekWindowId };
      }

      case 'peek:close-window': {
        const state = await getState();
        if (tab && tab.windowId === state.peekWindowId) {
          try { await chrome.windows.remove(state.peekWindowId); } catch (_) {}
          await setState({ peekWindowId: null });
        }
        return {};
      }

      case 'peek:window-to-tab': {
        // Promote the popup window's page into a regular tab.
        const state = await getState();
        if (tab && tab.windowId === state.peekWindowId) {
          const normal = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => null);
          if (normal) {
            await chrome.tabs.move(tab.id, { windowId: normal.id, index: -1 });
            await chrome.tabs.update(tab.id, { active: true });
            await chrome.windows.update(normal.id, { focused: true });
          }
          await setState({ peekWindowId: null });
        }
        return {};
      }
    }
    return {};
  })().then(sendResponse, (err) => sendResponse({ error: String(err) }));
  return true;
});

// ---------- window-mode dismissal (click away closes it, like Arc) ----------

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return; // switched to another app
  const state = await getState();
  if (state.peekWindowId && windowId !== state.peekWindowId) {
    try { await chrome.windows.remove(state.peekWindowId); } catch (_) {}
    await setState({ peekWindowId: null });
  }
});

chrome.windows.onRemoved.addListener(async (windowId) => {
  const state = await getState();
  if (state.peekWindowId === windowId) await setState({ peekWindowId: null });
});

// ---------- cleanup ----------

// The content script reports 'peek:closed' on close and on pagehide. Watching
// tabs.onUpdated for URL changes isn't safe here: single-page apps change the
// URL constantly, and a late event would pull the rule out from under an open peek.
chrome.tabs.onRemoved.addListener((tabId) => revokeFraming(tabId));

// ---------- context menu + toolbar button ----------

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'peek-link', title: 'Peek link', contexts: ['link'] });
    chrome.contextMenus.create({ id: 'blank-link', title: 'Open link in Blank Window', contexts: ['link'] });
    chrome.contextMenus.create({ id: 'blank-new', title: 'New Blank Window', contexts: ['action'] });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'peek-link' && tab && info.linkUrl) openPeek(tab, info.linkUrl, null, null);
  if (info.menuItemId === 'blank-link' && info.linkUrl) openBlankWindow(info.linkUrl, tab && tab.windowId);
  if (info.menuItemId === 'blank-new') openBlankWindow(null, tab && tab.windowId);
});

// Toolbar button opens settings; the keyboard shortcut opens a Blank Window
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'open-blank-window') openBlankWindow(null, tab && tab.windowId);
  if (command === 'copy-url') copyCurrentUrl(tab, false);
  if (command === 'copy-url-markdown') copyCurrentUrl(tab, true);
});

// Our own "Copy URL": if you hand ⌘⇧C to the extension (and turn off Dia's), only
// our "Copied Current URL" shows, and it's the peeked page when a peek is open.
async function copyCurrentUrl(tab, markdown) {
  if (!tab) [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) return;
  const state = await getState();
  const w = (state.watches || {})[tab.id];
  const url = w ? w.url : (tab.url || '');
  const title = w ? w.title : (tab.title || '');
  if (!/^https?:/i.test(url)) return;
  const text = markdown ? `[${mdEscape(title || url)}](${url})` : url;
  if (!(await writeClipboard(text))) return;
  if (w) {
    chrome.runtime.sendMessage({ type: 'copied:notify', tabId: tab.id, markdown }).catch(() => {});
  } else {
    chrome.tabs.sendMessage(tab.id, { type: 'page:copied', markdown }, { frameId: 0 }).catch(() => {});
  }
}
