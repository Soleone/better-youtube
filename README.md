# YouTube Quick Playlist Add (Chrome/Brave extension)

Adds a **Quick add** button under videos on:
- YouTube Home (`/`)
- Subscriptions (`/feed/subscriptions`)

Clicking Quick add opens your configured favorite playlists (with one pinned at top). Clicking a playlist immediately adds that video to the real YouTube playlist.

## Install (unpacked)

1. Open `chrome://extensions` (or `brave://extensions`).
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this folder.

## Configure playlists

1. Open the extension details page.
2. Click **Extension options**.
3. Paste playlist URL or playlist ID.
4. Optionally set a custom label and mark one as pinned.

## Notes

- This extension stores only your selected favorites in `chrome.storage.sync`.
- It does **not** create extension-only playlists.
- It calls YouTube internal endpoints from the page context; if YouTube changes internals, updates may be needed.
