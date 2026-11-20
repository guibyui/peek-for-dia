// Peek card. Runs inside the full-screen extension frame the content script
// drops on top of the page. Being an extension page means the host site's CSP
// can't block it, and its styles can't leak into (or be broken by) the site.
//
// Two ways the peeked page is shown:
//  - Other sites: inside this card's own frame (#frame).
//  - Same site as the page behind (?d=1): in a frame the content script puts
//    directly in that page and lays over this card's viewport, so the peeked
//    page keeps your login cookies. This card then only reports where its
//    viewport is (peek:rect). See content.js for why.

(async () => {
  const params = new URLSearchParams(location.search);
  const startUrl = params.get('u');
  const nonce = params.get('n');
  const clickX = params.has('x') ? Number(params.get('x')) : null;
  const clickY = params.has('y') ? Number(params.get('y')) : null;
  let direct = params.get('d') === '1';

  const $ = (id) => document.getElementById(id);
  const card = $('card');
  const frame = $('frame');

  // Only render if the background confirms it opened this peek for this tab.
  let check;
  try {
    check = await chrome.runtime.sendMessage({ type: 'peek:validate', nonce });
  } catch (_) {}
  if (!check || !check.ok || !startUrl || !/^https?:/i.test(startUrl)) return;
  const tabId = check.tabId;

  let currentUrl = startUrl;
  const trail = [startUrl]; // URLs visited inside the card, for the Back button
  let alive = false; // set once the content script inside the card reports in
  let peekFrameId = null; // that content script's frame, for reloads
  let closing = false;
  let revealed = false; // the open animation has finished

  const toTop = (msg) => chrome.tabs.sendMessage(tabId, msg, { frameId: 0 }).catch(() => {});

  // ---------- header ----------

  let currentTitle = '';

  function readableUrl(url) {
    try { return decodeURI(url); } catch (_) { return url; }
  }

  function setPage(url, title) {
    currentUrl = url;
    currentTitle = title || '';
    const full = readableUrl(url);
    $('title').textContent = currentTitle;
    $('title').hidden = !currentTitle;
    $('url').textContent = full;
    $('url').title = full;
    document.title = currentTitle || full;
    // Let the page behind know what's peeked, for its own keyboard shortcuts
    toTop({ type: 'peek:page', url, title: currentTitle });
    // So the background can fix Dia's own ⌘⇧C, which copies the page behind the card
    chrome.runtime.sendMessage({ type: 'watch:update', kind: 'peek', url, title: currentTitle }).catch(() => {});
    const fav = new URL(chrome.runtime.getURL('/_favicon/'));
    fav.searchParams.set('pageUrl', url);
    fav.searchParams.set('size', '32');
    $('favicon').src = fav.toString();
    $('back').disabled = trail.length < 2;
  }
  $('favicon').addEventListener('error', () => $('favicon').removeAttribute('src'));

  // ---------- same-site frame placement ----------

  // Where the viewport sits once the card is full size. offsetLeft/Top/Width/
  // Height ignore the opening scale, so this is right even mid-animation.
  function viewportRect() {
    const v = $('viewport');
    const hint = $('hint');
    let height = v.offsetHeight;
    // Leave room below the page for the "Page not showing?" bar
    if (!hint.hidden) height -= hint.offsetHeight + 36;
    return {
      left: card.offsetLeft + v.offsetLeft,
      top: card.offsetTop + v.offsetTop,
      width: v.offsetWidth,
      height: Math.max(0, height),
      radius: hint.hidden ? parseFloat(getComputedStyle(card).borderBottomLeftRadius) || 0 : 0
    };
  }

  function placeContent() {
    if (!direct || closing) return;
    toTop({ type: 'peek:rect', rect: viewportRect(), visible: revealed });
  }
  window.addEventListener('resize', placeContent);

  function setHint(show) {
    if ($('hint').hidden === !show) return;
    $('hint').hidden = !show;
    placeContent();
  }

  // ---------- open animation (grows from the clicked link, like Arc) ----------

  card.hidden = false;
  if (clickX !== null && clickY !== null) {
    card.style.transformOrigin = `${clickX - card.offsetLeft}px ${clickY - card.offsetTop}px`;
  }
  setPage(startUrl, '');
  placeContent(); // the same-site frame starts loading now, still hidden
  requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.add('open')));

  // Show the same-site frame once the card has finished growing
  const reveal = () => {
    if (revealed) return;
    revealed = true;
    placeContent();
  };
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  card.addEventListener('transitionend', (e) => {
    if (e.target === card && (e.propertyName === 'transform' || reducedMotion)) reveal();
  });
  setTimeout(reveal, 400);

  // The page itself (not this extension frame) must start the navigation:
  // Chromium skips header rules for requests an extension initiates, so a
  // frame loaded from here would still be blocked by X-Frame-Options.
  {
    // Pass on only what this frame was given, to avoid permissions-policy warnings
    const wanted = ['clipboard-read', 'clipboard-write', 'fullscreen', 'autoplay', 'encrypted-media', 'picture-in-picture'];
    const policy = document.permissionsPolicy || document.featurePolicy;
    frame.allow = (policy ? wanted.filter((f) => { try { return policy.allowsFeature(f); } catch (_) { return false; } }) : wanted).join('; ');
  }
  window.parent.postMessage({ type: 'peek:ready' }, '*');

  function frameLoaded() {
    $('progress').classList.add('done');
    // Blocked frames (and some PDFs) never get our content script, so offer a way out.
    setTimeout(() => { if (!alive) setHint(true); }, 1500);
  }

  frame.addEventListener('load', () => {
    try {
      if (frame.contentWindow.location.href === 'about:blank') return; // initial empty frame
    } catch (_) { /* cross-origin means the real page loaded */ }
    frameLoaded();
    frame.focus();
  });

  // ---------- messages from the page inside the card ----------

  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (msg && msg.type === 'copied:notify' && msg.tabId === tabId) return void showCopied(true, msg.markdown);
    if (!sender.tab || sender.tab.id !== tabId) return;
    if (msg.type === 'peek:nav' && sender.frameId !== 0) {
      alive = true;
      peekFrameId = sender.frameId;
      setHint(false);
      if (msg.url !== trail[trail.length - 1]) {
        if (msg.url === trail[trail.length - 2]) trail.pop();
        else trail.push(msg.url);
      }
      setPage(msg.url, msg.title);
    }
    // From the page behind: the same-site frame finished loading
    if (msg.type === 'peek:frame-load' && sender.frameId === 0) frameLoaded();
    // From the page behind: its CSP refused a page in the same-site frame, so
    // that page now loads in this card's own frame instead
    if (msg.type === 'peek:fallback' && sender.frameId === 0) {
      direct = false;
      alive = false;
      peekFrameId = null;
      $('progress').classList.remove('done');
    }
    if (msg.type === 'peek:loading') $('progress').classList.remove('done');
    if (msg.type === 'peek:request-reload') reload();
    if (msg.type === 'peek:request-close') close();
    if (msg.type === 'peek:request-tab') toTab();
    if (msg.type === 'peek:copied') showCopied(msg.ok, msg.markdown);
  });

  // ---------- actions ----------

  function close() {
    if (closing) return;
    if (direct) toTop({ type: 'peek:closing' });
    closing = true;
    document.body.classList.remove('open');
    document.body.classList.add('closing');
    setTimeout(() => toTop({ type: 'peek:hide' }), 150);
  }

  // Reload the peeked page, never the page behind it. The page's own content
  // script does a real reload; if it isn't there (error pages, PDFs), load the
  // current address again.
  function reload() {
    if (closing) return;
    $('progress').classList.remove('done');
    const again = () => toTop({ type: 'peek:navigate', url: currentUrl });
    if (alive && peekFrameId !== null) {
      chrome.tabs.sendMessage(tabId, { type: 'peek:reload' }, { frameId: peekFrameId })
        .then((res) => { if (!res || !res.ok) again(); }, again);
    } else {
      again();
    }
  }

  const toTab = () => chrome.runtime.sendMessage({ type: 'peek:to-tab', url: currentUrl });
  const toWindow = () => chrome.runtime.sendMessage({ type: 'peek:to-window', url: currentUrl });

  $('close').addEventListener('click', close);
  $('backdrop').addEventListener('click', close);
  $('reload').addEventListener('click', reload);
  $('expand').addEventListener('click', toTab);
  $('window').addEventListener('click', toWindow);
  $('hint-tab').addEventListener('click', toTab);
  $('hint-window').addEventListener('click', toWindow);

  $('back').addEventListener('click', () => {
    if (trail.length < 2) return;
    // Don't use history.back(): the card shares the tab's history, and a back
    // step can land on the page behind it and navigate it away. Instead the
    // page loads the previous URL into the card directly.
    trail.pop();
    const prev = trail[trail.length - 1];
    $('back').disabled = trail.length < 2;
    $('progress').classList.remove('done');
    toTop({ type: 'peek:navigate', url: prev });
  });

  // Like Dia: the header briefly reads "Copied Current URL" (or the failure,
  // shown here rather than over the page so a same-site frame can't cover it)
  let copiedTimer;
  function showCopied(ok, markdown) {
    $('copied-text').textContent = !ok ? 'Could not copy' : markdown ? 'Copied URL as Markdown' : 'Copied Current URL';
    const meta = document.querySelector('.meta');
    $('copied').hidden = false;
    meta.classList.add('show-copied');
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => { $('copied').hidden = true; meta.classList.remove('show-copied'); }, 1600);
  }

  // Calling the Clipboard API where the site's Permissions-Policy forbids it
  // logs a violation even inside try/catch, so check first.
  function clipboardApiAllowed() {
    const policy = document.permissionsPolicy || document.featurePolicy;
    try { return !!navigator.clipboard && (!policy || policy.allowsFeature('clipboard-write')); } catch (_) { return false; }
  }

  async function copy(markdown) {
    const label = (currentTitle || currentUrl).replace(/([[\]\\])/g, '\\$1');
    const text = markdown ? `[${label}](${currentUrl})` : currentUrl;
    let ok = false;
    try {
      const res = await chrome.runtime.sendMessage({ type: 'copy:text', text });
      ok = !!(res && res.ok);
    } catch (_) {}
    if (!ok) try {
      if (!clipboardApiAllowed()) throw new Error('blocked');
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch (_) {
      // Clipboard API can be refused inside embedded frames; the classic route still works
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { ok = document.execCommand('copy'); } catch (_) {}
      ta.remove();
    }
    showCopied(ok, markdown);
  }

  $('copy').addEventListener('click', () => copy(false));

  // Keep in sync with isReloadCombo() in content.js
  const isReloadCombo = (e) => !e.altKey &&
    (e.key === 'F5' || ((e.metaKey || e.ctrlKey) && (e.key || '').toLowerCase() === 'r'));

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); toTab(); }
    if (isReloadCombo(e)) {
      e.preventDefault();
      e.stopPropagation();
      reload();
    }
    if (e.code === 'KeyC' && e.shiftKey && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      e.stopPropagation();
      copy(e.altKey);
    }
  }, true);
})();
