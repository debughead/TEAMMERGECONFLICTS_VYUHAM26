# Decision log

One entry per decision with lasting effect. Claude Code adds an entry only after a human approves. Newest at the bottom.

Template:

```
## D-NNN: <title>  (YYYY-MM-DD, approved by <name>)
Context: why this came up
Options: A) ... B) ...
Decision: ...
Consequences: what this commits us to; is it reversible?
```

## D-001: Fully in-browser, no server (2026-10-30, team)
Context: a privacy tool that uploads documents defeats itself.
Options: A) local Python engine B) TypeScript core in the browser.
Decision: B. One TypeScript core in a Web Worker, used by the Web Lab and the extension.
Consequences: heavier WebAssembly libraries; MuPDF.js is AGPL (fine for open source).

## D-002: Claude optional, off by default, placeholders only (2026-10-30, team)
Decision: AI uses the user's own key, receives masked text only, and can never lower a severity or verdict.

## D-003: Word/Excel are scan-and-clean only (2026-10-30, team)
Decision: report hidden content and strip metadata/comments; body redaction via "export to PDF and re-scan".

## D-004: Drag-and-drop is block-only in the extension (2026-10-30, team)
Decision: the cleaned file can't be reliably handed back to a site's drop handler, so drops are blocked with guidance to use the file picker.

## D-005: OCR scope (2026-10-30, team)
Context: ID photos and scanned PDFs have no text layer, and sending images to Claude would break the privacy model.
Decision: Tesseract.js runs locally on images and screenshots and on scanned PDF pages. The extension OCRs the first 3 pages; the Web Lab OCRs all pages with progress. English only.
Consequences: worker, core and `eng` language data are bundled (no CDN). Hindi/Malayalam can be added later. Reversible.

## D-006: Extension modes, Ask me (default) and Auto-clean (2026-10-30, team)
Context: blind auto-redaction can remove data a site legitimately needs (e.g. Aadhaar on a KYC page).
Decision: Ask me opens the card/panel on every warn/block. Auto-clean silently handles only findings that are never legitimate to share: EXIF/GPS, document metadata, text under black boxes, unapplied annotations, old revisions, comments. Anything else falls back to Ask me. Failed verification, Office files and drops become a block. The original is never uploaded silently.
Consequences: `Finding.autoCleanable` is part of the contract. Reversible.

## D-007: In-page card is the primary verdict UI (2026-10-30, team)
Context: `chrome.sidePanel.open()` needs a user gesture, and a message after a file pick may not count as one.
Decision: a closed shadow-DOM card on the page shows the verdict and actions. Its "Review details" click opens the side panel. Spike S1 confirms this.
Consequences: actions must work from both the card and the panel. Reversible.

## D-008: Local name/address detection is rule-based plus compromise.js (2026-10-30, team)
Context: transformer NER models are a 60–100 MB download and slow.
Decision: Indian address rules (PIN plus cues), labelled-name rules, compromise.js person tags, and a name lexicon. Claude (opt-in) fills the gaps.
Consequences: lower recall on unlabelled names when AI is off. Reversible.

## D-009: Web Lab is a static site, also bundled as the extension's lab.html (2026-10-30, team)
Decision: no backend. A strict CSP (`connect-src 'self'`, plus api.anthropic.com only for the AI option), self-hosted WASM, and a service worker for offline use. The same app ships inside the extension.
Consequences: each origin keeps its own audit log; both can export. Reversible.

## D-010: Audit log in IndexedDB with a hash chain and a non-extractable HMAC key (2026-10-30, team)
Context: plain or salted SHA-256 of a 12-digit Aadhaar number can be brute-forced.
Decision: values are stored only as HMAC-SHA256 under a WebCrypto key generated with `extractable=false`. Rows are hash-chained, and `verifyChain()` detects edits.
Consequences: clearing site data loses the log and the key, so export it if it needs to be kept. Reversible.

## D-011: Spike S2 passed; MuPDF.js is the PDF engine (2026-10-30, verified by test)
Context: fake-redaction detection needs filled-shape geometry, and secure redaction needs true text removal.
Result: `test/spikes/mupdf.spike.test.ts` (6 tests) passes on mupdf 1.28.1 in Node. A custom `Device.fillPath` reports a black box with its colour, and its bounds line up with the char quads from `toStructuredText().walk` in the same top-left page space (±1pt). `applyRedactions` plus a full rewrite removes the text, and `countVersions()` drops to 1. `countVersions()` also detects incremental saves natively.
Decision: no PDF.js fallback is needed for fill detection. Old-version detection uses `countVersions()` first; slicing the bytes at each revision is still needed to read the older revision's text.
Consequences: the PDF.js fallback is dropped from S2. Reversible.

## D-012: redact() works on the scan session, not on bytes passed again (2026-10-30, approved by user)
Context: `rules/core.md` said entry points take an ArrayBuffer. HLD §3.2 keeps the file and its findings together in the worker.
Options: A) `redact(scanId, options)` B) `redact(bytes, options)` with a re-scan.
Decision: A. Sessions expire after 10 minutes and are dropped after redact. Raw values never travel back in from the UI.
Consequences: an expired session means scanning again. `rules/core.md` is updated to match. Reversible.

## D-013: Redaction strips bookmarks and accessibility tags (2026-10-30, approved by user)
Context: Outlines and StructTreeRoot can hold text (e.g. names) that the scanner doesn't read.
Decision: redaction deletes Outlines, StructTreeRoot, MarkInfo, PieceInfo, Threads, Names, OpenAction/AA, AcroForm, XMP and Info.
Consequences: output PDFs lose bookmarks and screen-reader structure. Scanning these later would allow keeping them. Reversible.

## D-014: Pre-existing unapplied Redact annotations are always applied (2026-10-30, approved by user)
Decision: any Redact annotation already in the file is applied during redact(), selected or not.
Consequences: text the author marked for removal is always removed. Reversible.

## D-015: Verify rules for partial selection and black regions (2026-10-30, Claude, within the approved plan)
Context: two cases made verify fail on correct output. (1) A name kept in Office body text (which can't be removed) also appeared in metadata that was removed. (2) OCR read "a"/"ay" off solid black redaction boxes.
Decision: (1) A removed value must be gone only if no unselected or unredactable finding still contains it. (2) For image and scanned output, verify proves each redacted region is solid black and ignores OCR words inside proven-black regions.
Consequences: (2) makes the check stronger, because it now proves the pixels are gone. (1) keeps the user's choices from blocking release. Reversible.

## D-016: OCR is injected; tests use local Homebrew language data (2026-10-30, Claude, within the approved plan)
Context: the core must not make network calls, and tesseract.js downloads language data from a CDN by default.
Decision: the core defines `OcrEngine` and a `tesseractEngine(worker)` adapter and never creates a worker itself. Node tests create the worker with `langPath` set to the local `/opt/homebrew/share/tessdata` (override with `RG_TESSDATA`), `gzip:false` and `cacheMethod:"none"`. OCR tests skip when no data is present.
Consequences: Phase 3b must bundle `eng.traineddata` with the extension and Web Lab. Where that file comes from (a package or a vendored file) needs a decision then.

## D-017: Office XML is read with a tag scanner, not DOMParser (2026-10-30, Claude, within the approved plan)
Context: DOMParser isn't available in Web Workers or Node, and the core must run in all three.
Decision: a regex-based scanner reads the specific elements needed. Any DOCTYPE is rejected and no custom entities are expanded. Each part's inflation is capped through JSZip's untyped `internalStream`, confirmed in `lib/zipObject.js`.
Consequences: deeply nested or unusual XML may be read imperfectly, which can only cause missed findings, never crashes or entity attacks. Reversible.

## D-018: Spike S5 (EXIF orientation) solved in the core (2026-10-30, verified by test)
Result: MuPDF decodes stored pixels and ignores EXIF orientation. The core rotates once at decode time, so OCR, painting and output share one upright space. Output is written upright with no EXIF. The golden test confirms that a 400x300 photo with Orientation=6 comes out as 300x400.

## D-019: AI uses Claude Opus 5.5 for both calls (2026-10-30, requested by user)
Context: the HLD planned Sonnet for findings and Haiku for page fit. The user asked for Claude Opus 5.5.
Decision: both requests use `claude-opus-5-5`. Thinking is always on for this model, so effort is set explicitly: `medium` for findings, `low` for page fit. Forced `tool_choice` returns a 400 on Opus 5.5, so replies use structured outputs, `output_config: { format: { type: "json_schema", schema } }`. The core builds the request and validates the reply with zod. The host makes the call with the official SDK and the user's own key.
Consequences: higher cost per scan than Sonnet/Haiku ($4/$20 per MTok), limited by sending only selected, masked lines. For Phase 3b, the reference recommends `fallbacks: "default"` (server-side refusal fallback) on Opus 5.5 requests. Reversible: the model ID is one constant (`AI_MODEL`).

## D-020: Watermark is stamped before redaction; unneeded critical data blocks on any page (2026-10-30, Claude, within the approved plan)
Context: (1) Diagonal watermark text crossing a redacted area would be real text inside it, which verify would rightly fail. (2) The first policy draft let a job portal "expect" documents and so only warned on a bank account number.
Decision: (1) The watermark goes on first and redactions are applied afterwards, so crossing glyphs are removed. It is still before verify. (2) Any critical finding the page doesn't need blocks, whatever the page expects in general. Trusted sites relax only warnings, and hidden data never drops below warn.
Consequences: watermark text may have gaps where it crosses redactions. The spec scenario (bank statement on a job portal → block) holds. Reversible.

## D-021: The Anthropic SDK is the host AI transport (2026-10-30, approved by user)
Decision: `@anthropic-ai/sdk` (1.3.0, Apache-2.0) is added to the browser apps only, never to the core. It is the only code that makes a network request, and only to api.anthropic.com when the user turns AI on with their own key. It needs the SDK's browser opt-in because the key lives in the browser.
Consequences: the Web Lab CSP allows `connect-src https://api.anthropic.com`, and the extension requests the optional host permission at runtime. Reversible.

## D-022: Tesseract English data comes from @tesseract.js-data/eng (2026-10-30, approved by user)
Decision: use the npm package (1.0.0, MIT), pinned in the lockfile. Only the needed `eng.traineddata` file is copied into each app's build and served locally.
Consequences: no CDN downloads at runtime; Node tests can keep using Homebrew data (D-016). Reversible.

## D-023: Web Lab is built before the extension (2026-10-30, approved by user)
Decision: prove the core in a browser Web Worker (MuPDF + Tesseract WASM) in the Web Lab first; the extension then reuses the worker and UI.

## D-024: Engine worker ready handshake (2026-10-30, verified in headless Brave/Chromium 155)
Context: the Web Lab worker never answered. A staged diagnostic showed every stage works in a browser worker (MuPDF load and open, core scan, IndexedDB audit, Tesseract and SDK imports, all in under 0.4 s). Even a bare Comlink `ping()` hung. Cause: the worker's static imports include MuPDF, whose loader uses top-level `await`. Messages that arrive during that `await` have no listener and are silently dropped.
Decision: the worker posts `rg-engine-ready` after `Comlink.expose`, and the client sends nothing until it sees it.
Consequences: the extension's offscreen worker must use the same handshake. Reversible.

## D-025: Offscreen document ready handshake (2026-10-30, verified in headless Brave)
Context: the first scan failed with "Could not establish connection. Receiving end does not exist." `chrome.offscreen.createDocument()` can resolve before the document's script has registered its message listener.
Decision: the offscreen document sends `offscreen-ready` once it is listening. The service worker treats creation as complete only after that arrives (10 s timeout). The engine worker inside keeps its own D-024 handshake.
Consequences: no lost first request; this is the same pattern at both layers. Reversible.

## D-026: Lightweight schemas entry point and an e2e-only trace build (2026-10-30, Claude, within the approved plan)
Context: (1) the content script imported zod schemas from the core's main entry, which pulled MuPDF and its WASM into every web page and couldn't build as an IIFE. (2) The verdict card is a closed shadow root by design, so automated tests can't see the extension's state.
Decision: (1) `@redactguard/core/schemas` exports only `schemas.ts`, and the content script imports only from it (content.js is 100 KB, no WASM). (2) `vite build --mode e2e` adds a trace that posts state names and counts (never values) to the local demo server, only on http://localhost:8080. Production builds contain none of it (checked: 0 occurrences in dist).
Consequences: the extension can be tested end to end without weakening the shipped build. Reversible.

## Spike results: S3, S4 and S6 passed; S1 needs a manual click (2026-10-30)
- S3: Tesseract runs inside the offscreen document from bundled files. The Aadhaar card image was OCR'd in the extension (about 1.8 s) with no remote fetch.
- S4: re-attaching our own file does not trigger interception again. Each run logs exactly one `intercepted` event, and the site received the cleaned file once.
- S6: a 13.9 MB PDF crosses content script → service worker → offscreen as base64 and scans in about 1.5 s.
- S1: `sidePanel.open()` is called from the card's click relayed through the service worker. Chrome's docs don't say whether the gesture survives the relay. The toolbar icon always opens the panel (`setPanelBehavior({ openPanelOnActionClick: true })`). This needs a manual click test.

## D-027: Extension CSP restricts network to the Anthropic API (2026-10-30, approved by user)
Context: Chrome's minimum MV3 policy limits scripts but not network requests, and Tesseract's bundle contains unused CDN fallback URLs.
Decision: `extension_pages` adds `connect-src 'self' https://api.anthropic.com`. Nothing in the extension can contact any other server, even by accident.
Consequences: verified by rerunning the three e2e scenarios with the new policy (GPS clean, bank statement block, Aadhaar on KYC allow), which all passed with OCR running locally. Reversible.

## Spike S1 passed (2026-10-30, confirmed by user in Brave)
The card's "Review details" click, relayed through the service worker, opened the side panel in Brave. All six spikes have now passed.

## D-028: Detection and redaction fixes from the first real-world PDF (2026-10-30, approved by user)
Context: scanning a real 14-page PDF (Chromium/Skia, the project spec) gave false medical and name findings, and verify refused the output.
Decision:
- Weak signals (a "Condition:" or "Findings:" label with no medical term; a capitalised pair with no known name token) become AI-only candidates, not findings.
- Redacting a value removes every copy of it in the PDF text layer (MuPDF `page.search`, values of 6+ characters), unless the user left some copy unselected.
- Metadata findings are proven removed by the metadata checks, not by searching body text (a Title often equals the visible heading).
Consequences: the spec PDF now scans with only true findings, and redaction passes all six checks. Regression tests are in `test/everyCopy.test.ts`. Recall for unlabelled names and weak medical text now depends on the optional AI.

## D-029: Extension UI redesign and selectable redaction (2026-10-30, approved by user)
Decision: "clean security product" look for the card and side panel. Verdict band, 10-segment exposure meter, findings grouped by why they're risky, working checkboxes in both places, and a live "the site will get…" line. The side panel's "Redact selected and upload" redacts in the offscreen engine and hands the verified file to the page (`panel-redact` → `attach-safe`). Only the side panel page may send `panel-redact`; e2e builds also accept it opened as a tab, so tests can drive it.
Consequences: verified in headless Brave via the DevTools protocol (screenshots, plus the panel path removing only the ticked items). The production bundle contains no e2e relaxation.
