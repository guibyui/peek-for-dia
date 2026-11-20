# Privacy Policy for Peek

_Last updated: 2026-11-20_

Peek does not collect, store, sell or share personal data. It has no servers, no analytics and no telemetry, and it makes no network requests of its own. This page explains what the extension touches on your device and why.

## What stays on your device

- **Settings.** Your choices (the peek trigger, whether peeks show as a card or a popup window, your "always peek on these sites" list, and your Blank Window shortcut) are saved with the browser's `storage` API. If you are signed in to your browser's sync, the browser may sync these settings between your own devices. The extension author never receives them.
- **Temporary state.** While a peek or Blank Window is open, Peek keeps short-lived state (which tab has a peek open, and the address and title of the peeked page) in browser session storage. It is cleared when the browser session ends.
- **Browsing history.** In a Blank Window, the address box suggests pages from your browser history using the `history` API. The history is read locally to show suggestions. It is not stored, copied or sent anywhere.
- **Clipboard.** Peek writes to the clipboard when you use its copy actions (Copy URL, Copy as Markdown). While a peek or Blank Window is open, it also reads the clipboard to notice when the browser's own "Copy URL" shortcut has copied the wrong address, and replaces it with the address you are looking at. Clipboard contents are compared locally and are never stored or sent anywhere. When no peek or Blank Window is open, the clipboard is not read.
- **Site icons.** Tab icons in a Blank Window come from the browser's local favicon cache.

## What leaves your device

- **Pages you open.** Peek and Blank Window load the pages you choose to open, the same as any browser tab, so those sites receive the normal requests a browser makes. To let a peeked page display inside the card, Peek removes the `X-Frame-Options` and `Content-Security-Policy: frame-ancestors` response headers for sub-frames in that one tab while the peek is open. The rule is removed when the peek closes, the tab navigates or the tab closes.
- **Searches.** If you type something in the Blank Window address box that is not a web address, it is sent to Google Search (`https://www.google.com/search?q=...`) to show results. Google's privacy policy applies to those searches.

Nothing else is transmitted. The extension does not load or run remote code.

## Permissions

| Permission | Why Peek needs it |
| --- | --- |
| Access to all sites (`<all_urls>`) | Catch Shift+click on links on any site and show the preview card. |
| `declarativeNetRequestWithHostAccess` | Temporarily allow the peeked page to be framed, in the one tab that has a peek open. |
| `storage` | Save your settings. |
| `contextMenus` | The "Peek link" and "Open link in Blank Window" menu items. |
| `favicon` | Show site icons on Blank Window tabs. |
| `history` | Address-bar suggestions in a Blank Window. |
| `clipboardRead`, `clipboardWrite`, `offscreen` | Copy URL / Copy as Markdown, and fixing the address the browser's own shortcut copies. |

## Open source

The complete source code is at https://github.com/guibyui/peek-for-dia, so you can verify everything above.

## Contact

Questions or concerns: open an issue or start a discussion at https://github.com/guibyui/peek-for-dia.

## Changes

If this policy changes, the update will be committed to the repository with a new date at the top.
