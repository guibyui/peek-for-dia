# Peek

Two Arc features for Dia, Chrome, Brave, Edge or any Chromium browser:

- **Peek:** Shift+click a link and it opens in a floating card over the page. Esc or a click outside closes it.
- **Blank Window:** a light window with its own tabs and none of the profile sidebar, pinned tabs or favorites. Press Ctrl+Option+N (Ctrl+Alt+N on Windows), or right-click the toolbar icon → New Blank Window.

## Install (Dia)

1. Get the code: `git clone https://github.com/guibyui/peek-for-dia.git`, or click **Code → Download ZIP** on GitHub and unzip it. Put it somewhere permanent (the browser loads the extension from that folder, so don't delete it).
2. Open `chrome://extensions` in Dia.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and pick the `peek-for-dia` folder (the one containing `manifest.json`).
5. Reload any tabs that were already open.

To update, pull the latest code (or download the ZIP again), then click the reload icon on Peek in `chrome://extensions`.

## Using it

| Action | How |
| --- | --- |
| Peek a link | Shift + click (or right-click → **Peek link**) |
| Close | Esc, click outside, or the × button |
| Open the peek as a real tab | ⌘/Ctrl + Enter, or the expand button |
| Move it to a Blank Window | Window button in the card header |
| Back inside the peek | Back arrow in the header |
| Reload the peek (not the page behind) | ⌘/Ctrl + R, F5, or the reload button in the header |
| Copy the peeked page's URL | Ctrl/⌘ + Shift + C, or the copy button in the header |
| Copy it as a Markdown link | Ctrl/⌘ + Shift + Alt + C |

Shift + click inside a peek navigates the card instead of stacking another one. The header shows the peeked page's title and full URL (you can select it).

While a peek is open, ⌘/Ctrl + R and F5 reload the peeked page wherever focus is (in the page, the card header, or the page behind). The browser's own toolbar reload button still reloads the whole tab; extensions can't change that, so use the card's reload button.

## Blank Window

Open one with **Ctrl+Option+N** (Ctrl+Alt+N on Windows), right-click the toolbar icon → **New Blank Window**, right-click a link → **Open link in Blank Window**, or the window button on a peek card.

**Changing the shortcut:** Settings → Blank Window → **Change**, then press the keys you want. This shortcut is handled by the extension, so it works whenever a web page or a Blank Window has focus (not on Dia's new tab page or settings pages). Browsers don't let extensions register Ctrl+Option combos as browser-level shortcuts, which is why it works this way. If you also want one that works everywhere, even when Dia isn't in front, set it on the browser's shortcuts page (link in Settings).

| Action | How |
| --- | --- |
| New tab | Ctrl/⌘ + T, or New Tab in the sidebar |
| Edit the address | Ctrl/⌘ + L, or click the URL bar |
| Close tab | Ctrl/⌘ + W, × on hover, or middle-click the tab |
| Switch tabs | Click, Ctrl + Tab / Ctrl + Shift + Tab, Ctrl/⌘ + 1 to 9 |
| Back / forward | Ctrl/⌘ + [ and ], Alt + ← / →, or the sidebar arrows |
| Reload | Ctrl/⌘ + R or F5 |
| Hide the sidebar | Ctrl/⌘ + S |
| Copy URL / as Markdown | Ctrl/⌘ + Shift + C / Ctrl/⌘ + Shift + Alt + C (the address reads "Copied Current URL", like Dia) |
| Send the tab to your Dia window | Ctrl/⌘ + Shift + O, or the arrow icon in the URL bar |
| Send every tab to Dia and close | Bottom-left icon in the sidebar |

New tabs appear at the top, like Arc. Drag tabs to reorder. Links that would open a new tab (target=_blank, Ctrl/⌘+click, middle-click, Shift+click) open as tabs in the same Blank Window. The address box suggests from your history; anything that isn't a URL goes to Google.

The tabs are frames inside one extension page. Because that page is the top of the window and the extension has access to every site, sites get your normal cookies: you're logged in just like in Dia.

The window's own strip at the very top shows the extension's address (chrome-extension://…/blank.html). Dia draws that strip for every popup window and extensions can't hide it or change it, so the real address is shown in the bar above the page.

Limits: no per-tab DevTools beyond the window's, browser extensions' toolbar buttons act on the window rather than the tab, popups a site opens with JavaScript (sign-in popups, for example) open as normal Dia windows, and a few sites that refuse frames show an "Open in Dia" button. Closing the window discards its tabs, the same as Arc.

## Settings

Click the toolbar icon:

- **Trigger:** Shift + click (Arc default) or Option/Alt + click if you want to keep Shift + click as "new window".
- **Show peeks as:** floating card (default) or a small popup window that closes when you click back to the main window.
- **Always peek on these sites:** Arc's pinned-tab behavior. On listed domains, a plain click on a link that leaves the site opens a peek. Good for mail.google.com, Slack, Linear.

## ⌘⇧C and Dia's own Copy URL

Dia grabs ⌘⇧C before any page sees it and copies the tab's address: the page behind a peek, or `chrome-extension://…/blank.html` in a Blank Window. While a peek or Blank Window is open, the extension watches the clipboard (locally, nothing leaves your machine) and when exactly that address appears, swaps in the URL you're looking at and shows "Copied Current URL". It does the same for Dia's Markdown copy. When no peek or Blank Window is open, the clipboard isn't watched. This is why the extension asks to read the clipboard.

### Getting rid of Dia's own message

Dia's ⌘⇧C also flashes "Copied Current URL" in its toolbar (and copies the wrong address until the extension fixes it). To have only the extension handle it:

1. Dia → Settings → Shortcuts: clear **Copy URL** (and **Copy URL as Markdown**).
2. `chrome://extensions/shortcuts` (link in Settings): set Peek's **Copy current URL** to ⌘⇧C and **Copy current URL as Markdown** to ⌥⇧⌘C.

The extension then copies the peeked page when a peek is open, the current tab in a Blank Window, and the normal tab otherwise, with a single "Copied Current URL" pill.

## How it works

- `content.js` catches the click in the capture phase, before the site or the browser sees it, and asks the background worker to open a peek.
- The card is an extension page (`peek.html`) layered over the site in a full-screen transparent frame. Being an extension page, the site's CSP can't block it and its CSS can't leak in either direction.
- Many sites forbid being framed (`X-Frame-Options`, CSP `frame-ancestors`). While a peek is open, a session rule removes those two headers for sub-frames **in that one tab only**. The rule is deleted when the peek closes, the tab navigates or the tab closes.
- The page itself starts the navigation inside the card, because Chromium doesn't apply header rules to requests an extension starts.
- **Same-site peeks keep your login.** If the card's extension frame sat between the page and the peeked page, Chrome would treat the peeked page as embedded cross-site and hold back its `SameSite=Lax/Strict` cookies, which is how most sites keep you signed in. So for a link on the same site as the page you're on, the peeked page gets its own frame directly in the page, laid exactly over the card's viewport. Links to other sites load inside the card as before, where the page's CSP can't block them.
- If the page's CSP (`frame-src`) refuses a page you open from inside a same-site peek, the peek switches to loading inside the card. That page will then behave like a cross-site peek.

## Known limits

- **Logged-out views when peeking another site.** A peek of a different site is embedded in the page you're on, so that site's `SameSite=Lax/Strict` cookies aren't sent. Peeking a GitHub link from Gmail, for example, may show GitHub logged out. Peeking a link to the same site you're on keeps your session. Use the window button or ⌘/Ctrl+Enter, or switch to popup-window mode, which always has your sessions.
- **Signing in inside a peek** can fail on sites that use single sign-on, especially intranets on a local network: the browser blocks a public sign-in page (Microsoft, Google) from sending you back to a local-network address inside a frame. Sign in in the tab, then peek.
- **A few sites refuse to render in frames** (Google sign-in, some banks). If nothing shows after load, a small "Page not showing?" bar offers window or tab.
- **History:** navigating inside a card adds entries to the tab's back history. After a long browse inside a peek, the main page's Back button may need a few extra presses.
- Doesn't run on browser pages (`chrome://`, the Web Store). Peeks from there fall back to a popup window.

## Files

```
manifest.json   MV3 manifest
background.js   framing rule, nonce check, tab/window actions, context menu
content.js      click capture, overlay host, reporting from inside the card
peek.html/css/js  the card UI
blank.html/css/js the Blank Window
options.html/js   settings page
offscreen.html/js clipboard writer used by the background
icons/          toolbar icons
```
