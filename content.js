// Peek: content script (runs in every frame)
//  - In normal pages: catches Shift+click (or your chosen trigger) on links.
//  - In the top frame: hosts the full-screen peek overlay frame (and, for
//    same-site links, the peeked page's own frame laid over the card).
//  - Inside a peek card: reports the current URL/title, forwards Esc and
//    handles reload.

(() => {
  if (window.__peekLoaded) return;
  window.__peekLoaded = true;

  const PEEK_FRAME_NAME = '__arc_peek_frame__';
  const isTop = window === window.top;
  const inPeek = !isTop && window.name === PEEK_FRAME_NAME;
  // A tab inside a Blank Window (direct child frame of blank.html)
  const inBlank = !isTop && window.name.startsWith('__blank_tab_') && window.parent === window.top;

  const DEFAULT_BLANK_SHORTCUT = { code: 'KeyN', ctrlKey: true, altKey: true, shiftKey: false, metaKey: false };
  const DEFAULTS = { modifier: 'shift', mode: 'overlay', autoPeekSites: [], blankShortcut: DEFAULT_BLANK_SHORTCUT };
  let settings = { ...DEFAULTS };
  chrome.storage.sync.get(DEFAULTS).then((s) => { settings = s; }).catch(() => {});
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    for (const [k, v] of Object.entries(changes)) settings[k] = v.newValue ?? DEFAULTS[k];
  });

  const send = (msg) => {
    try { return chrome.runtime.sendMessage(msg).catch(() => {}); } catch (_) { return Promise.resolve(); }
  };

  // ---------- Blank Window shortcut (default Ctrl+Option+N, set in Settings) ----------
  // Browsers don't let extensions register Ctrl+Option combos, so the page listens itself.
  window.addEventListener('keydown', (e) => {
    const k = settings.blankShortcut;
    if (!k || !k.code || e.repeat) return;
    if (e.code !== k.code) return;
    if (!!e.ctrlKey !== !!k.ctrlKey || !!e.altKey !== !!k.altKey ||
        !!e.shiftKey !== !!k.shiftKey || !!e.metaKey !== !!k.metaKey) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    send({ type: 'blank:new-window' });
  }, true);

  // ---------- link detection ----------

  function findLink(event) {
    for (const node of event.composedPath()) {
      if (!(node instanceof Element)) continue;
      const tag = node.localName;
      if (tag !== 'a' && tag !== 'area') continue;
      let href = node.href;
      if (href && typeof href === 'object' && 'baseVal' in href) href = href.baseVal; // SVG <a>
      if (!href) return null;
      try {
        const url = new URL(href, document.baseURI);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
        if (node.hasAttribute('download')) return null;
        return { el: node, url };
      } catch (_) {
        return null;
      }
    }
    return null;
  }

  function modifierPressed(e) {
    const only = (key) =>
      ['shiftKey', 'altKey', 'metaKey', 'ctrlKey'].every((k) => (k === key ? e[k] : !e[k]));
    return settings.modifier === 'alt' ? only('altKey') : only('shiftKey');
  }

  function baseDomain(host) {
    return host.replace(/^www\./, '').split('.').slice(-2).join('.');
  }

  function shouldAutoPeek(e, url) {
    if (e.shiftKey || e.altKey || e.metaKey || e.ctrlKey) return false;
    const sites = settings.autoPeekSites || [];
    if (!sites.length) return false;
    const here = location.hostname;
    const onListedSite = sites.some((s) => here === s || here.endsWith('.' + s));
    // Arc only peeks links that leave the pinned site
    return onListedSite && baseDomain(url.hostname) !== baseDomain(here);
  }

  // Stop Shift+mousedown on a link from extending the text selection.
  window.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || !modifierPressed(e)) return;
    if (findLink(e)) e.preventDefault();
  }, true);

  window.addEventListener('click', (e) => {
    if (e.button !== 0) return;
    const link = findLink(e);
    if (!link) return;

    if (inBlank) {
      // Inside a Blank Window tab: links that would open a new tab/window (or
      // escape the frame with target=_top) stay inside the Blank Window instead.
      const target = (link.el.getAttribute('target') || '').toLowerCase();
      const wantsNewTab = e.shiftKey || e.ctrlKey || e.metaKey || (target && !['_self', '_top', '_parent'].includes(target));
      if (!wantsNewTab && target !== '_top' && target !== '_parent') return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      if (!wantsNewTab) { location.href = link.url.href; return; }
      const background = (e.ctrlKey || e.metaKey) && !e.shiftKey;
      send({ type: 'blank:open', url: link.url.href, active: !background });
      return;
    }

    if (!modifierPressed(e) && !shouldAutoPeek(e, link.url)) return;

    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    if (inPeek) {
      // Already inside a peek: just navigate the card.
      location.href = link.url.href;
      return;
    }
    send({
      type: 'peek:open',
      url: link.url.href,
      x: isTop ? e.clientX : null,
      y: isTop ? e.clientY : null
    });
  }, true);

  // ---------- copy-link shortcut (Ctrl/Cmd+Shift+C, add Alt for Markdown) ----------

  function isCopyCombo(e) {
    return e.code === 'KeyC' && e.shiftKey && (e.metaKey || e.ctrlKey);
  }

  // Cmd/Ctrl+R (Shift too) and F5: while a peek is open these reload the peek,
  // not the page behind it
  function isReloadCombo(e) {
    if (e.altKey) return false;
    if (e.key === 'F5') return true;
    return (e.metaKey || e.ctrlKey) && (e.key || '').toLowerCase() === 'r';
  }

  function stopKey(e) {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }

  function markdownLink(title, url) {
    const text = (title || url).replace(/([[\]\\])/g, '\\$1');
    return `[${text}](${url})`;
  }

  // Calling the Clipboard API where the site's Permissions-Policy forbids it
  // logs a violation even inside try/catch, so check first.
  function clipboardApiAllowed() {
    const policy = document.permissionsPolicy || document.featurePolicy;
    try { return !!navigator.clipboard && (!policy || policy.allowsFeature('clipboard-write')); } catch (_) { return false; }
  }

  async function copyText(text) {
    try {
      if (!clipboardApiAllowed()) throw new Error('blocked');
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {
      // Fallback for pages where the async clipboard API is unavailable
      const active = document.activeElement;
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.setProperty('position', 'fixed', 'important');
      ta.style.setProperty('opacity', '0', 'important');
      (document.body || document.documentElement).appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (_) {}
      ta.remove();
      if (active && active.focus) active.focus();
      return ok;
    }
  }

  // Prefer the background's clipboard writer; fall back to copying in the page
  async function copyLink(text) {
    const res = await send({ type: 'copy:text', text });
    if (res && res.ok) return true;
    return copyText(text);
  }

  // ---------- inside a Blank Window tab ----------

  if (inBlank) {
    // Middle-click on a link: background tab in the Blank Window
    window.addEventListener('auxclick', (e) => {
      if (e.button !== 1) return;
      const link = findLink(e);
      if (!link) return;
      stopKey(e);
      send({ type: 'blank:open', url: link.url.href, active: false });
    }, true);

    let last = '';
    const report = () => {
      const payload = location.href + '\n' + document.title;
      if (payload === last) return;
      last = payload;
      send({ type: 'blank:nav', name: window.name, url: location.href, title: document.title });
    };
    report();
    document.addEventListener('DOMContentLoaded', report);
    window.addEventListener('load', report);
    setInterval(report, 700);

    // Window shortcuts work even while you're typing in a page
    window.addEventListener('keydown', (e) => {
      if (isCopyCombo(e)) {
        stopKey(e);
        const md = e.altKey;
        copyLink(md ? markdownLink(document.title, location.href) : location.href)
          .then((ok) => send({ type: 'blank:copied', ok, markdown: md }));
        return;
      }
      const action = blankKeyAction(e);
      if (!action) return;
      // Option/Alt+Arrow moves by word in text fields; leave that alone
      const el = e.composedPath()[0];
      const editable = el && (el.isContentEditable || /^(input|textarea|select)$/i.test(el.localName || ''));
      if (editable && e.altKey && !(e.metaKey || e.ctrlKey)) return;
      stopKey(e);
      send({ type: 'blank:key', action });
    }, true);
    return;
  }

  // Keep in sync with keyAction() in blank.js
  function blankKeyAction(e) {
    const mod = e.metaKey || e.ctrlKey;
    const k = (e.key || '').toLowerCase();
    if (mod && !e.shiftKey && !e.altKey) {
      if (k === 't') return 'new';
      if (k === 'w') return 'close';
      if (k === 'l') return 'edit';
      if (k === 'r') return 'reload';
      if (k === 's') return 'sidebar';
      if (k === '[') return 'back';
      if (k === ']') return 'forward';
      if (/^[1-9]$/.test(k)) return 'tab' + k;
    }
    if (mod && e.shiftKey && !e.altKey && k === 'o') return 'to-dia';
    if (e.key === 'F5') return 'reload';
    if (e.altKey && !mod && !e.shiftKey && e.key === 'ArrowLeft') return 'back';
    if (e.altKey && !mod && !e.shiftKey && e.key === 'ArrowRight') return 'forward';
    if (e.ctrlKey && e.key === 'Tab') return e.shiftKey ? 'prev' : 'next';
    return null;
  }

  // ---------- inside a peek card ----------

  if (inPeek) {
    let last = '';
    const report = () => {
      const payload = location.href + '\n' + document.title;
      if (payload === last) return;
      last = payload;
      send({ type: 'peek:nav', url: location.href, title: document.title });
    };
    report();
    document.addEventListener('DOMContentLoaded', report);
    window.addEventListener('load', report);
    setInterval(report, 700);

    // The card's reload button and shortcut reload this frame, keeping its scroll position
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg && msg.type === 'peek:reload') {
        sendResponse({ ok: true });
        location.reload();
      }
    });

    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') send({ type: 'peek:request-close' });
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        send({ type: 'peek:request-tab' });
      }
      if (isReloadCombo(e)) {
        stopKey(e);
        send({ type: 'peek:loading' });
        location.reload();
        return;
      }
      // Ctrl/Cmd+Shift+C copies the peeked page, not the tab behind it
      if (isCopyCombo(e)) {
        stopKey(e);
        const md = e.altKey;
        copyLink(md ? markdownLink(document.title, location.href) : location.href)
          .then((ok) => send({ type: 'peek:copied', ok, markdown: md }));
      }
    }, true);
    return;
  }

  if (!isTop) return;

  // ---------- top frame: host the overlay ----------

  // Same-site peeks get a frame of their own. The card is an extension page,
  // and a chrome-extension:// frame between this page and the peeked one makes
  // Chrome treat the peeked page as embedded cross-site: its SameSite=Lax/Strict
  // cookies (most login sessions) aren't sent, so a link to your own site opened
  // logged out. For links on this page's site, the peeked page now loads in a
  // frame that is a direct child of this page, laid exactly over the card's
  // viewport, and keeps your session. Links to other sites still load inside
  // the card, where this page's CSP can't block them.

  let host = null;           // the card (peek.html), full-screen
  let content = null;        // same-site peeks: the peeked page's frame, over the card
  let contentShown = false;
  let pendingUrl = null;
  let savedOverflow = null;
  let violation = null;      // last frame-src CSP refusal while a same-site peek is open
  let peekPage = { url: '', title: '' }; // kept current by peek.js

  const FRAME_CSS = {
    all: 'initial',
    position: 'fixed',
    border: '0',
    margin: '0',
    padding: '0',
    'z-index': '2147483647',
    display: 'block',
    visibility: 'visible'
  };
  // Set styles through CSSOM: a style="" attribute would be blocked by strict page CSPs.
  const setStyles = (el, css) => {
    for (const [k, v] of Object.entries(css)) el.style.setProperty(k, v, 'important');
  };

  // Registrable domain, close enough without the public suffix list
  function siteOf(url) {
    const h = url.hostname;
    if (!h.includes('.') || /^[\d.]+$/.test(h) || h.startsWith('[')) return url.protocol + '//' + h;
    const parts = h.split('.');
    const twoLevel = parts.length > 2 && parts[parts.length - 1].length === 2 &&
      /^(co|com|net|org|gov|edu|ac|ne|or|go)$/.test(parts[parts.length - 2]);
    return url.protocol + '//' + parts.slice(twoLevel ? -3 : -2).join('.');
  }
  function sameSite(a, b) {
    try { return siteOf(new URL(a)) === siteOf(new URL(b)); } catch (_) { return false; }
  }

  // The card frame says it's ready; navigate its inner frame from this page so
  // the request counts as page-initiated (see peek.js for why).
  window.addEventListener('message', (e) => {
    if (!host || content || !pendingUrl || e.source !== host.contentWindow) return;
    if (!e.data || e.data.type !== 'peek:ready') return;
    const url = pendingUrl;
    pendingUrl = null;
    try {
      host.contentWindow.frames[0].location.replace(url);
    } catch (_) {}
  });

  // Only delegate features this page itself has; asking for more makes Chrome
  // log permissions-policy warnings on sites that lock them down.
  function allowedFeatures() {
    const wanted = ['clipboard-read', 'clipboard-write', 'fullscreen', 'autoplay', 'encrypted-media', 'picture-in-picture'];
    const policy = document.permissionsPolicy || document.featurePolicy;
    if (!policy) return wanted;
    return wanted.filter((f) => { try { return policy.allowsFeature(f); } catch (_) { return false; } });
  }

  function show({ url, x, y, nonce }) {
    remove(false);
    pendingUrl = url;
    const direct = sameSite(url, location.href);
    const params = new URLSearchParams({ u: url, n: nonce });
    if (typeof x === 'number') params.set('x', String(Math.round(x)));
    if (typeof y === 'number') params.set('y', String(Math.round(y)));
    if (direct) params.set('d', '1');

    host = document.createElement('iframe');
    host.src = chrome.runtime.getURL('peek.html') + '?' + params.toString();
    host.setAttribute('allow', allowedFeatures().join('; '));
    host.setAttribute('aria-label', 'Link preview');
    setStyles(host, {
      ...FRAME_CSS,
      inset: '0',
      width: '100vw',
      height: '100vh',
      background: 'transparent',
      'color-scheme': 'light dark',
      opacity: '1'
    });
    host.addEventListener('load', () => host && host.focus());

    savedOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    document.documentElement.appendChild(host);

    if (direct) {
      // Stays hidden until the card reports where its viewport is (peek:rect),
      // and loads once it has its final size
      content = document.createElement('iframe');
      content.name = PEEK_FRAME_NAME;
      content.setAttribute('allow', allowedFeatures().join('; '));
      content.setAttribute('aria-label', 'Link preview');
      setStyles(content, {
        ...FRAME_CSS,
        left: '0',
        top: '0',
        width: '0',
        height: '0',
        background: '#fff',
        opacity: '0',
        'pointer-events': 'none',
        transition: 'opacity 120ms ease'
      });
      content.addEventListener('load', onContentLoad);
      document.documentElement.appendChild(content); // after the card, so it sits on top
    }
  }

  function placeContent(rect, visible) {
    if (!content || !rect) return;
    const px = (n) => Math.max(0, Math.round(Number(n) || 0)) + 'px';
    setStyles(content, {
      left: px(rect.left),
      top: px(rect.top),
      width: px(rect.width),
      height: px(rect.height),
      'border-radius': `0 0 ${px(rect.radius)} ${px(rect.radius)}`
    });
    if (pendingUrl) {
      const url = pendingUrl;
      pendingUrl = null;
      content.src = url; // set from this content script, so the page's CSP doesn't block it
    }
    if (visible && !contentShown) {
      contentShown = true;
      setStyles(content, { opacity: '1', 'pointer-events': 'auto' });
      content.focus();
    }
  }

  function onContentLoad() {
    if (!content || !content.getAttribute('src')) return; // the initial about:blank
    // A link inside the peek that this page's CSP (frame-src) refuses leaves an
    // error page. Reopen that address inside the card, which the CSP doesn't cover.
    if (violation && Date.now() - violation.time < 2000) {
      const url = /^https?:/i.test(violation.url) ? violation.url : peekPage.url;
      violation = null;
      return toCardFrame(url);
    }
    send({ type: 'peek:frame-load' });
    if (contentShown) content.focus();
  }

  function toCardFrame(url) {
    if (!content) return;
    content.remove();
    content = null;
    contentShown = false;
    send({ type: 'peek:fallback' });
    try { host.contentWindow.frames[0].location.replace(url); } catch (_) {}
  }

  document.addEventListener('securitypolicyviolation', (e) => {
    if (content && e.disposition === 'enforce' && /^(frame|child)-src$/.test(e.effectiveDirective)) {
      violation = { url: e.blockedURI, time: Date.now() };
    }
  }, true);

  function navigateCard(url) {
    try {
      if (content) content.contentWindow.location.replace(url);
      else if (host) host.contentWindow.frames[0].location.replace(url);
    } catch (_) {}
  }

  function remove(notify = true) {
    if (!host) return;
    host.remove();
    host = null;
    if (content) content.remove();
    content = null;
    contentShown = false;
    violation = null;
    pendingUrl = null;
    document.documentElement.style.overflow = savedOverflow || '';
    savedOverflow = null;
    if (notify) send({ type: 'peek:closed' });
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'peek:show') { peekPage = { url: msg.url, title: '' }; show(msg); }
    if (msg && msg.type === 'peek:hide') remove(true);
    if (msg && msg.type === 'peek:page') peekPage = { url: msg.url, title: msg.title || '' };
    if (msg && msg.type === 'page:copied') showPageCopied(msg.markdown);
    if (msg && msg.type === 'peek:navigate' && host && /^https?:/i.test(msg.url)) navigateCard(msg.url);
    if (msg && msg.type === 'peek:rect') placeContent(msg.rect, !!msg.visible);
    if (msg && msg.type === 'peek:closing' && content) setStyles(content, { opacity: '0', 'pointer-events': 'none' });
  });

  // Small Dia-style "Copied Current URL" pill, used by the extension's Copy URL
  // shortcut on normal pages. Constructable stylesheets aren't blocked by page CSPs.
  let copiedHost = null;
  let copiedTimer = null;
  function showPageCopied(markdown) {
    if (!copiedHost) {
      copiedHost = document.createElement('div');
      const root = copiedHost.attachShadow({ mode: 'closed' });
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(`
        :host { all: initial; }
        .pill { position: fixed; top: 14px; left: 50%; transform: translateX(-50%); z-index: 2147483647;
          display: flex; align-items: center; gap: 7px; padding: 8px 14px; border-radius: 999px;
          background: rgba(28, 28, 32, 0.92); color: #fff; box-shadow: 0 8px 28px rgba(0,0,0,.25);
          font: 500 13px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
          animation: in 160ms ease-out; pointer-events: none; }
        svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; }
        @keyframes in { from { opacity: 0; transform: translate(-50%, -4px); } }`);
      root.adoptedStyleSheets = [sheet];
      const pill = document.createElement('div');
      pill.className = 'pill';
      pill.innerHTML = '<svg viewBox="0 0 16 16"><path d="M6.8 9.2l2.4-2.4M7.4 4.6l.9-.9a2.6 2.6 0 0 1 3.7 3.7l-.9.9M8.6 11.4l-.9.9a2.6 2.6 0 0 1-3.7-3.7l.9-.9"/></svg><span></span>';
      root.append(pill);
      copiedHost._label = pill.querySelector('span');
    }
    copiedHost._label.textContent = markdown ? 'Copied URL as Markdown' : 'Copied Current URL';
    document.documentElement.appendChild(copiedHost);
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => copiedHost.remove(), 1600);
  }

  // Leaving the page with a peek open: let the background drop the framing rule
  window.addEventListener('pagehide', () => { if (host) send({ type: 'peek:closed' }); });

  // Keys pressed while focus is still on the page behind the card
  window.addEventListener('keydown', (e) => {
    if (!host) return;
    if (e.key === 'Escape') {
      stopKey(e);
      send({ type: 'peek:request-close' });
    }
    if (isReloadCombo(e)) {
      stopKey(e);
      send({ type: 'peek:request-reload' });
    }
    if (isCopyCombo(e) && peekPage.url) {
      stopKey(e);
      const md = e.altKey;
      copyLink(md ? markdownLink(peekPage.title, peekPage.url) : peekPage.url)
        .then((ok) => send({ type: 'peek:copied', ok, markdown: md }));
    }
  }, true);

  // Window mode: Esc closes the popup, Cmd/Ctrl+Enter promotes it to a tab
  if (window.opener === null) {
    window.addEventListener('load', async () => {
      const res = await send({ type: 'peek:whoami' });
      if (!res || !res.isPeekWindow) return;
      window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') send({ type: 'peek:close-window' });
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send({ type: 'peek:window-to-tab' });
      }, true);
    }, { once: true });
  }
})();
