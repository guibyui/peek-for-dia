// Blank Window: a light, tabbed window with no profile sidebar, pinned tabs or
// favorites. Each tab is a frame inside this extension page. Because the
// window's top level is the extension (which has host access), sites inside get
// your normal cookies, so you stay logged in.

(async () => {
  const $ = (id) => document.getElementById(id);
  const FRAME_PREFIX = '__blank_tab_';
  const STORE_KEY = 'blankWindowState';

  // Register with the background so it lifts frame-blocking headers for this window
  let reg;
  try { reg = await chrome.runtime.sendMessage({ type: 'blank:register' }); } catch (_) {}
  if (!reg || !reg.ok) {
    document.body.textContent = 'Blank Window could not start. Try reloading the extension.';
    return;
  }
  const myTabId = reg.tabId;

  /** @type {Array<{id:number,url:string,title:string,loading:boolean,alive:boolean,trail:string[],fwd:string[],expect:boolean,frame:HTMLIFrameElement}>} */
  let tabs = [];
  let active = null;
  let seq = 0;

  // ---------- helpers ----------

  const favicon = (url) => {
    const u = new URL(chrome.runtime.getURL('/_favicon/'));
    u.searchParams.set('pageUrl', url);
    u.searchParams.set('size', '32');
    return u.toString();
  };
  const readable = (url) => { try { return decodeURI(url); } catch (_) { return url; } };
  const hostOf = (url) => {
    try { const u = new URL(url); return u.host.replace(/^www\./, ''); } catch (_) { return url; }
  };
  const isHttp = (url) => /^https?:\/\//i.test(url || '');

  function toUrl(input) {
    const s = input.trim();
    if (!s) return null;
    if (/^https?:\/\//i.test(s)) return s;
    if (/^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?(\/.*)?$/i.test(s)) return 'http://' + s;
    if (!/\s/.test(s) && /^[^\s/]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(s)) return 'https://' + s;
    return 'https://www.google.com/search?q=' + encodeURIComponent(s);
  }

  // ---------- tabs ----------

  function createTab(url, { activate = true, title = '' } = {}) {
    const t = {
      id: ++seq, url, title, loading: true, alive: false,
      trail: [], fwd: [], expect: false, frame: null
    };
    const f = document.createElement('iframe');
    f.name = FRAME_PREFIX + t.id;
    f.allow = 'clipboard-read; clipboard-write; fullscreen; autoplay; encrypted-media; picture-in-picture; camera; microphone; geolocation; display-capture';
    f.hidden = true;
    f.addEventListener('load', () => onFrameLoad(t));
    t.frame = f;
    $('pages').appendChild(f);
    f.src = url;

    // New tabs go to the top of the list, like Arc
    tabs.unshift(t);
    if (activate || !active) select(t);
    render();
    save();
    return t;
  }

  function select(t) {
    active = t;
    for (const x of tabs) x.frame.hidden = x !== t;
    $('hint').hidden = true;
    if (t && !t.loading && !t.alive) $('hint').hidden = false;
    updateBar();
    render();
    if (t) setTimeout(() => t.frame.focus(), 0);
    save();
  }

  function closeTab(t) {
    const i = tabs.indexOf(t);
    if (i < 0) return;
    t.frame.remove();
    tabs.splice(i, 1);
    if (active === t) {
      const next = tabs[i] || tabs[i - 1] || null;
      active = null;
      if (next) select(next);
      else { updateBar(); render(); openPalette('new'); }
    } else {
      render();
    }
    save();
  }

  function navigate(t, url, fromHistory = false) {
    if (!t || !isHttp(url)) return;
    t.loading = true;
    t.alive = false;
    t.expect = fromHistory;
    t.url = url;
    try { t.frame.contentWindow.location.replace(url); } catch (_) { t.frame.src = url; }
    if (t === active) { $('hint').hidden = true; updateBar(); }
    render();
  }

  function onFrameLoad(t) {
    t.loading = false;
    render();
    if (t === active) updateBar();
    // Pages that refuse to be framed never get our content script; offer Dia instead.
    const loadedUrl = t.url;
    setTimeout(() => {
      if (!t.alive && t.url === loadedUrl && t === active && !t.loading) $('hint').hidden = false;
    }, 1500);
  }

  function onNav(t, url, title) {
    t.alive = true;
    if (t.expect) {
      t.expect = false;
      if (t.trail.length) t.trail[t.trail.length - 1] = url; else t.trail.push(url);
    } else if (url !== t.trail[t.trail.length - 1]) {
      t.trail.push(url);
      t.fwd = [];
    }
    t.url = url;
    t.title = title || t.title;
    if (t === active) { $('hint').hidden = true; updateBar(); }
    render();
    save();
  }

  const back = () => {
    const t = active;
    if (!t || t.trail.length < 2) return;
    t.fwd.push(t.trail.pop());
    navigate(t, t.trail[t.trail.length - 1], true);
  };
  const forward = () => {
    const t = active;
    if (!t || !t.fwd.length) return;
    const u = t.fwd.pop();
    t.trail.push(u);
    navigate(t, u, true);
  };
  const reload = () => { if (active) navigate(active, active.url, true); };

  function step(dir) {
    if (!active || tabs.length < 2) return;
    const i = tabs.indexOf(active);
    select(tabs[(i + dir + tabs.length) % tabs.length]);
  }

  // ---------- rendering ----------

  let lastWatched = null;
  function reportWatch() {
    const url = active ? active.url : null;
    const key = url + '\n' + (active ? active.title : '');
    if (key === lastWatched) return;
    lastWatched = key;
    // Lets the background fix Dia's own ⌘⇧C, which would copy chrome-extension://…/blank.html
    chrome.runtime.sendMessage({ type: 'watch:update', kind: 'blank', url, title: active ? active.title : '' }).catch(() => {});
  }

  function updateBar() {
    const t = active;
    $('panel').classList.toggle('has-tab', !!t);
    $('topbar').hidden = !t;
    $('back').disabled = !t || t.trail.length < 2;
    $('forward').disabled = !t || !t.fwd.length;
    $('reload').disabled = !t;
    reportWatch();
    if (!t) { document.title = 'Blank Window'; return; }
    $('url').textContent = readable(t.url);
    $('url').title = readable(t.url);
    $('spinner').hidden = !t.loading;
    $('info').style.display = t.loading ? 'none' : '';
    document.title = t.title || hostOf(t.url);
  }

  function render() {
    const list = $('tabs');
    list.textContent = '';
    for (const t of tabs) {
      const li = document.createElement('li');
      li.className = 'tab' + (t === active ? ' active' : '');
      li.setAttribute('role', 'tab');
      li.setAttribute('aria-selected', String(t === active));
      li.draggable = true;
      li.dataset.id = String(t.id);
      li.title = (t.title ? t.title + '\n' : '') + readable(t.url);

      const img = document.createElement('img');
      img.className = 'fav';
      img.alt = '';
      img.src = favicon(t.url);
      img.addEventListener('error', () => img.classList.add('none'));

      const text = document.createElement('div');
      text.className = 'text';
      const title = document.createElement('div');
      title.className = 'title';
      title.textContent = t.title || hostOf(t.url);
      const host = document.createElement('div');
      host.className = 'host';
      host.textContent = hostOf(t.url);
      text.append(title, host);

      li.append(img, text);
      if (t.loading) {
        const dot = document.createElement('span');
        dot.className = 'loading-dot';
        li.append(dot);
      }

      const x = document.createElement('button');
      x.className = 'ib x';
      x.title = 'Close tab (Ctrl/⌘+W)';
      x.setAttribute('aria-label', 'Close tab');
      x.innerHTML = '<svg viewBox="0 0 16 16"><path d="m4 4 8 8M12 4l-8 8"/></svg>';
      x.addEventListener('click', (e) => { e.stopPropagation(); closeTab(t); });
      li.append(x);

      li.addEventListener('click', () => select(t));
      li.addEventListener('auxclick', (e) => { if (e.button === 1) closeTab(t); });
      wireDrag(li, t);
      list.append(li);
    }
    $('new-tab').classList.toggle('on', !$('palette-wrap').hidden && paletteMode === 'new');
  }

  // Drag to reorder
  let dragged = null;
  function wireDrag(li, t) {
    li.addEventListener('dragstart', (e) => {
      dragged = t;
      li.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/uri-list', t.url);
    });
    li.addEventListener('dragend', () => { dragged = null; render(); });
    li.addEventListener('dragover', (e) => {
      if (!dragged || dragged === t) return;
      e.preventDefault();
      for (const el of document.querySelectorAll('.drop-before')) el.classList.remove('drop-before');
      li.classList.add('drop-before');
    });
    li.addEventListener('drop', (e) => {
      if (!dragged || dragged === t) return;
      e.preventDefault();
      tabs.splice(tabs.indexOf(dragged), 1);
      tabs.splice(tabs.indexOf(t), 0, dragged);
      dragged = null;
      render();
      save();
    });
  }

  // ---------- palette (new tab / address bar) ----------

  let paletteMode = 'new';
  let suggestions = [];
  let sel = 0;
  let queryToken = 0;

  function openPalette(mode) {
    paletteMode = mode === 'edit' && active ? 'edit' : 'new';
    $('palette-wrap').hidden = false;
    const input = $('omni');
    input.value = paletteMode === 'edit' ? active.url : '';
    input.focus();
    input.select();
    refreshSuggestions();
    render();
  }

  function closePalette() {
    if (!active) return; // with no tabs, the palette is the window's empty state
    $('palette-wrap').hidden = true;
    render();
    active.frame.focus();
  }

  async function refreshSuggestions() {
    const token = ++queryToken;
    const q = $('omni').value.trim();
    const items = [];
    if (q && !(paletteMode === 'edit' && q === active?.url)) {
      const url = toUrl(q);
      const isSearch = url.startsWith('https://www.google.com/search?q=') && !/^https?:\/\//i.test(q);
      items.push({ kind: isSearch ? 'search' : 'go', url, title: isSearch ? `Search Google for “${q}”` : q });
    }
    let history = [];
    try {
      history = await chrome.history.search({ text: q, maxResults: 40, startTime: 0 });
    } catch (_) {}
    if (token !== queryToken) return;
    const seen = new Set(items.map((i) => i.url));
    history
      .filter((h) => isHttp(h.url) && !seen.has(h.url))
      .sort((a, b) => q
        ? (b.typedCount * 3 + b.visitCount) - (a.typedCount * 3 + a.visitCount) || b.lastVisitTime - a.lastVisitTime
        : b.lastVisitTime - a.lastVisitTime)
      .slice(0, 6)
      .forEach((h) => { seen.add(h.url); items.push({ kind: 'history', url: h.url, title: h.title || hostOf(h.url) }); });
    suggestions = items;
    sel = 0;
    drawSuggestions();
  }

  function drawSuggestions() {
    const ul = $('suggestions');
    ul.textContent = '';
    suggestions.forEach((s, i) => {
      const li = document.createElement('li');
      li.className = 'sug' + (i === sel ? ' sel' : '');
      if (s.kind === 'history') {
        const img = document.createElement('img');
        img.className = 'fav';
        img.alt = '';
        img.src = favicon(s.url);
        li.append(img);
      } else {
        li.insertAdjacentHTML('beforeend', s.kind === 'search'
          ? '<svg class="glyph" viewBox="0 0 16 16"><circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3 3"/></svg>'
          : '<svg class="glyph" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12"/></svg>');
      }
      const t = document.createElement('span');
      t.className = 't';
      t.textContent = s.title;
      li.append(t);
      if (s.kind === 'history') {
        const u = document.createElement('span');
        u.className = 'u';
        u.textContent = '— ' + readable(s.url).replace(/^https?:\/\/(www\.)?/, '');
        li.append(u);
      }
      li.addEventListener('mousemove', () => { if (sel !== i) { sel = i; drawSuggestions(); } });
      li.addEventListener('mousedown', (e) => { e.preventDefault(); go(s.url); });
      ul.append(li);
    });
  }

  function go(url) {
    if (!url) return;
    $('palette-wrap').hidden = true;
    if (paletteMode === 'edit' && active) navigate(active, url);
    else createTab(url);
    render();
  }

  let inputTimer;
  $('omni').addEventListener('input', () => {
    clearTimeout(inputTimer);
    inputTimer = setTimeout(refreshSuggestions, 60);
  });
  $('omni').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!suggestions.length) return;
      sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length;
      drawSuggestions();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      go(suggestions[sel] ? suggestions[sel].url : toUrl($('omni').value));
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closePalette();
    }
  });
  $('palette-wrap').addEventListener('mousedown', (e) => {
    if (e.target === $('palette-wrap')) closePalette();
  });

  // ---------- actions ----------

  let toastTimer;
  function toast(text) {
    $('toast').textContent = text;
    $('toast').hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { $('toast').hidden = true; }, 1400);
  }

  // Like Dia: the address briefly reads "Copied Current URL"
  let copiedTimer;
  function showCopied(ok, markdown) {
    if (!ok) return toast('Could not copy');
    $('copied-text').textContent = markdown ? 'Copied URL as Markdown' : 'Copied Current URL';
    $('copied').hidden = false;
    $('topbar').classList.add('show-copied');
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => { $('copied').hidden = true; $('topbar').classList.remove('show-copied'); }, 1600);
  }

  // Calling the Clipboard API where the site's Permissions-Policy forbids it
  // logs a violation even inside try/catch, so check first.
  function clipboardApiAllowed() {
    const policy = document.permissionsPolicy || document.featurePolicy;
    try { return !!navigator.clipboard && (!policy || policy.allowsFeature('clipboard-write')); } catch (_) { return false; }
  }

  async function copyActive(markdown) {
    if (!active) return;
    const label = (active.title || active.url).replace(/([[\]\\])/g, '\\$1');
    const text = markdown ? `[${label}](${active.url})` : active.url;
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

  function toDia(t = active) {
    if (!t) return;
    chrome.runtime.sendMessage({ type: 'blank:to-dia', urls: [t.url] });
    closeTab(t);
  }

  function allToDia() {
    if (!tabs.length) return;
    // Keep the sidebar order: top of the list becomes the first tab
    chrome.runtime.sendMessage({ type: 'blank:to-dia', urls: tabs.map((t) => t.url), closeWindow: true });
  }

  function runAction(action) {
    switch (action) {
      case 'new': return openPalette('new');
      case 'edit': return openPalette('edit');
      case 'close': return active ? closeTab(active) : null;
      case 'reload': return reload();
      case 'back': return back();
      case 'forward': return forward();
      case 'next': return step(1);
      case 'prev': return step(-1);
      case 'sidebar': return document.body.classList.toggle('no-sidebar');
      case 'to-dia': return toDia();
      default:
        if (/^tab[1-9]$/.test(action)) {
          const n = Number(action.slice(3));
          const t = n === 9 ? tabs[tabs.length - 1] : tabs[n - 1];
          if (t) select(t);
        }
    }
  }

  // Same mapping as content.js uses inside the tabs
  function keyAction(e) {
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

  // New Blank Window shortcut while this window's own UI has focus
  let blankShortcut = { code: 'KeyN', ctrlKey: true, altKey: true, shiftKey: false, metaKey: false };
  chrome.storage.sync.get({ blankShortcut }).then((r) => { blankShortcut = r.blankShortcut; }).catch(() => {});
  chrome.storage.onChanged.addListener((c, area) => { if (area === 'sync' && c.blankShortcut) blankShortcut = c.blankShortcut.newValue; });
  window.addEventListener('keydown', (e) => {
    const k = blankShortcut;
    if (!k || e.code !== k.code || e.repeat) return;
    if (!!e.ctrlKey !== !!k.ctrlKey || !!e.altKey !== !!k.altKey || !!e.shiftKey !== !!k.shiftKey || !!e.metaKey !== !!k.metaKey) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    chrome.runtime.sendMessage({ type: 'blank:new-window' });
  }, true);

  window.addEventListener('keydown', (e) => {
    if (e.code === 'KeyC' && e.shiftKey && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      copyActive(e.altKey);
      return;
    }
    const action = keyAction(e);
    if (!action) return;
    // Let the address field keep normal text shortcuts
    if (e.target === $('omni') && ['back', 'forward'].includes(action)) return;
    e.preventDefault();
    e.stopPropagation();
    runAction(action);
  }, true);

  $('new-tab').addEventListener('click', () => openPalette('new'));
  $('new-tab-2').addEventListener('click', () => openPalette('new'));
  $('back').addEventListener('click', back);
  $('forward').addEventListener('click', forward);
  $('reload').addEventListener('click', reload);
  $('copy').addEventListener('click', () => copyActive(false));
  $('to-dia').addEventListener('click', () => toDia());
  $('hint-dia').addEventListener('click', () => toDia());
  $('all-to-dia').addEventListener('click', allToDia);
  $('url').addEventListener('click', () => openPalette('edit'));

  // ---------- messages from the pages inside the tabs ----------

  const tabByName = (name) => tabs.find((t) => FRAME_PREFIX + t.id === name);

  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (msg && msg.type === 'copied:notify' && msg.tabId === myTabId) return void showCopied(true, msg.markdown);
    if (!msg || !sender.tab || sender.tab.id !== myTabId) return;
    switch (msg.type) {
      case 'blank:nav': {
        const t = tabByName(msg.name);
        if (t) onNav(t, msg.url, msg.title);
        break;
      }
      case 'blank:key':
        runAction(msg.action);
        break;
      case 'blank:copied':
        showCopied(msg.ok, msg.markdown);
        break;
      case 'blank:open':
        if (isHttp(msg.url)) createTab(msg.url, { activate: msg.active !== false });
        break;
      case 'blank:add':
        // From the background: "open link in blank window" targeting this window
        if (isHttp(msg.url)) createTab(msg.url);
        break;
    }
  });

  // ---------- persistence (survives an accidental reload of this window) ----------

  function save() {
    try {
      sessionStorage.setItem(STORE_KEY, JSON.stringify({
        tabs: tabs.map((t) => ({ url: t.url, title: t.title })),
        active: active ? tabs.indexOf(active) : -1,
        sidebar: !document.body.classList.contains('no-sidebar')
      }));
    } catch (_) {}
  }

  function restore() {
    let state = null;
    try { state = JSON.parse(sessionStorage.getItem(STORE_KEY) || 'null'); } catch (_) {}
    if (!state || !state.tabs || !state.tabs.length) return false;
    // createTab unshifts, so add in reverse to keep the order
    for (let i = state.tabs.length - 1; i >= 0; i--) {
      const s = state.tabs[i];
      if (isHttp(s.url)) createTab(s.url, { activate: false, title: s.title });
    }
    const t = tabs[state.active] || tabs[0];
    if (t) select(t);
    if (state.sidebar === false) document.body.classList.add('no-sidebar');
    return tabs.length > 0;
  }

  // ---------- start ----------

  const startUrl = new URLSearchParams(location.search).get('u');
  history.replaceState(null, '', location.pathname); // so a reload restores from storage
  const restored = restore();
  if (startUrl && isHttp(startUrl) && !restored) createTab(startUrl);
  if (!tabs.length) openPalette('new');
  updateBar();
})();
