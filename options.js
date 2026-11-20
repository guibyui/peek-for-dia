const DEFAULTS = { modifier: 'shift', mode: 'overlay', autoPeekSites: [] };

const flash = (text) => {
  const el = document.getElementById('saved');
  el.textContent = text;
  clearTimeout(flash.t);
  flash.t = setTimeout(() => { el.textContent = ''; }, 1500);
};

const cleanSites = (text) =>
  text.split(/[\s,]+/)
    .map((s) => s.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, ''))
    .filter(Boolean);

chrome.storage.sync.get(DEFAULTS).then((s) => {
  document.querySelector(`input[name=modifier][value=${s.modifier}]`).checked = true;
  document.querySelector(`input[name=mode][value=${s.mode}]`).checked = true;
  document.getElementById('sites').value = (s.autoPeekSites || []).join('\n');
});

for (const input of document.querySelectorAll('input[type=radio]')) {
  input.addEventListener('change', () => {
    chrome.storage.sync.set({ [input.name]: input.value }).then(() => flash('Saved'));
  });
}

let timer;
document.getElementById('sites').addEventListener('input', (e) => {
  clearTimeout(timer);
  timer = setTimeout(() => {
    chrome.storage.sync.set({ autoPeekSites: cleanSites(e.target.value) }).then(() => flash('Saved'));
  }, 400);
});

// ---------- Blank Window shortcut ----------

const DEFAULT_BLANK_SHORTCUT = { code: 'KeyN', ctrlKey: true, altKey: true, shiftKey: false, metaKey: false };
const isMac = /Mac/i.test(navigator.platform || navigator.userAgent);

function keyName(code) {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  const map = { Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']',
    Backslash: '\\', Minus: '-', Equal: '=', Backquote: '`', Space: 'Space', Enter: 'Enter',
    ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓' };
  return map[code] || code;
}

function format(k) {
  if (!k || !k.code) return 'Not set';
  if (isMac) {
    return (k.ctrlKey ? '⌃' : '') + (k.altKey ? '⌥' : '') + (k.shiftKey ? '⇧' : '') + (k.metaKey ? '⌘' : '') + keyName(k.code);
  }
  return [k.ctrlKey && 'Ctrl', k.altKey && 'Alt', k.shiftKey && 'Shift', k.metaKey && 'Win', keyName(k.code)].filter(Boolean).join('+');
}

const shortcutEl = document.getElementById('shortcut');
const recordBtn = document.getElementById('record');

async function showShortcut() {
  const { blankShortcut } = await chrome.storage.sync.get({ blankShortcut: DEFAULT_BLANK_SHORTCUT });
  shortcutEl.textContent = format(blankShortcut);
  try {
    const cmd = (await chrome.commands.getAll()).find((c) => c.name === 'open-blank-window');
    document.getElementById('browser-shortcut').textContent = cmd && cmd.shortcut ? `(currently ${cmd.shortcut})` : '(none set)';
  } catch (_) {}
}
showShortcut();
document.addEventListener('visibilitychange', () => { if (!document.hidden) showShortcut(); });

let recording = false;
function stopRecording() {
  recording = false;
  shortcutEl.classList.remove('recording');
  recordBtn.textContent = 'Change';
  window.removeEventListener('keydown', onRecordKey, true);
  showShortcut();
}

function onRecordKey(e) {
  e.preventDefault();
  e.stopPropagation();
  if (e.key === 'Escape') return stopRecording();
  if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Fn'].includes(e.key)) return; // wait for the real key
  if (!e.ctrlKey && !e.altKey && !e.metaKey) {
    shortcutEl.textContent = 'Add Ctrl, Option or ⌘';
    return;
  }
  const blankShortcut = { code: e.code, ctrlKey: e.ctrlKey, altKey: e.altKey, shiftKey: e.shiftKey, metaKey: e.metaKey };
  chrome.storage.sync.set({ blankShortcut }).then(() => { flash('Saved'); stopRecording(); });
}

recordBtn.addEventListener('click', () => {
  if (recording) return stopRecording();
  recording = true;
  shortcutEl.textContent = 'Press keys…';
  shortcutEl.classList.add('recording');
  recordBtn.textContent = 'Cancel';
  window.addEventListener('keydown', onRecordKey, true);
});

document.getElementById('reset').addEventListener('click', () => {
  chrome.storage.sync.set({ blankShortcut: DEFAULT_BLANK_SHORTCUT }).then(() => { flash('Saved'); showShortcut(); });
});

async function openShortcutsPage(e) {
  e.preventDefault();
  try {
    await chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  } catch (_) {
    // Dia uses its own scheme for internal pages
    try { await chrome.tabs.create({ url: 'dia://extensions/shortcuts' }); } catch (_) {}
  }
}
document.getElementById('browser-shortcuts').addEventListener('click', openShortcutsPage);
document.getElementById('copy-shortcuts').addEventListener('click', openShortcutsPage);
