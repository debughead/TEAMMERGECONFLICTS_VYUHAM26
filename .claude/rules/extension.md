---
paths:
  - "apps/extension/**"
  - "demo-sites/**"
---

# Rules for the Chrome extension

- Manifest V3 only. Permissions are exactly `storage`, `sidePanel`, `offscreen`; the Anthropic host permission is optional and requested at runtime when the user enables AI. Any change here: stop and ask.
- No remote code. MuPDF, Tesseract worker/core/language data are bundled and loaded via `chrome.runtime.getURL`.
- The service worker only routes messages. Heavy work runs in the offscreen document's Web Worker, because Chrome stops idle service workers.
- Validate `sender.id` and `sender.tab` on every message. Validate every message payload with zod.
- Content script: capture-phase listeners on `document`; never use `window.postMessage`; never read form fields other than the upload input's label/context; the verdict card lives in a closed shadow root.
- Files the extension attaches itself go into the `approved` WeakSet so they are not intercepted again.
- `chrome.sidePanel.open()` is only called from a real user click (the card's "Review details" button).
- The original file is never uploaded silently. "Upload anyway" always requires a reason and writes an audit row.
- Test on the local demo sites, never on real third-party sites with real documents.
