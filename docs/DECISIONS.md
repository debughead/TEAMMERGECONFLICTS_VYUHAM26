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

## D-030: Photo forensics for images and image-only PDF pages (2026-10-30, approved by user; QR decoder declined)
Context: a real PAN-card photo with black bars painted over the details scanned as "0 findings, allow". The image pipeline only looked at OCR text and EXIF. A PDF made from the same photo (macOS Preview, rotated 90° on A4) behaved the same.
Decision: `detect/imageForensics.ts` + `detect/idCards.ts`, run on photos and on image-only PDF pages (analysing the embedded image at its native pixels, mapped to the page with the full placement transform):
- Redaction bars are found row by row (straight-edged near-black runs), then checked for (a) translucency and (b) partial coverage, i.e. a spike of letter ink right at the bar edge versus the background half a line away.
- QR codes are located from their finder squares (no decoding; jsQR was declined).
- ID cards are recognised from printed wording. The Aadhaar rule requires the issuer or a "Government of India" line, because forms merely mention Aadhaar.
- verify() now also fails if a QR code or leaking bar is still visible where removal was requested. A QR code the user chose to keep doesn't block release.
Consequences: on the user's photo and PDF, block / bar too thin / QR code / PAN card are all found, and redaction places the boxes correctly and passes verify (checked by eye on both outputs). Bar checks are covered by synthetic tests. The QR locator works on the real photo but fails 3 synthetic tests (see PROGRESS blockers), so it isn't yet trustworthy.

## D-031: OCR any image-only page whose largest image covers ≥ 15% (2026-10-30, bug fix; deviates from HLD §3.4's 80%; awaiting user confirmation)
Context: an unredacted PAN-card photo saved as PDF by macOS Preview (landscape photo, unrotated, on portrait A4) covers ~40% of the page. With the 80% rule the page wasn't "scanned", OCR never ran, and the scan returned metadata only (allow, score 10). The rotated-card QR tests also failed for this reason (~51% cover).
Decision: `SCANNED_MIN_IMAGE_COVER = 0.15` (still requires < 20 text characters). Only adds detection. Revert = one constant.
Consequences: OCR now runs on such pages; core tests went from 180 to 182 passing out of 183.

## D-032: Local-threshold OCR pass (2026-10-30; partial fix, see PROGRESS blocker)
Context: Tesseract reads almost nothing from phone photos of ID cards with patterned, unevenly lit backgrounds (0 words at 1000–2688 px, CLI and tesseract.js alike).
Decision: `ocr/preprocess.ts` builds a Bradley local-threshold copy (≤ 1600 px, window = short side / 12, 15% darker than the neighbourhood mean). `recognizeBest` OCRs the original and the copy and keeps the reading with more confidently read characters (confidence ≥ 0.5). Used by scanPdf, scanImage and both OCR checks in verify. Cost: about twice the OCR time.
Consequences: the photo now yields "PAN card" (high, warn) instead of only metadata. The PAN number, name and date of birth are still not read reliably. Settings sweeps didn't fix it; Tesseract's sparse-text mode (`--psm 11`) read a PAN-shaped token in one CLI run. Stopped after two attempts and asked the user.

## D-033: Dark-highlight rule looks at the backdrop directly under the text (2026-10-30, bug fix)
Context: a dark logo letter on a yellow badge on a navy header band was flagged as critical "blacked out by highlighting".
Decision: a black_highlight needs the topmost opaque shape painted before the text (under ≥ 60% of the character) to be dark. Two new tests: logo-on-badge (negative), black bar over a light panel (positive).

## D-034: Phase 0, hidden PDF structures and photo metadata (2026-10-31, approved by user: "Implement the phase 0")
Context: a probe found two cases where `verify()` passed while the secret was still in the file (text placed off the page; text in a switched-off layer), GPS in photos inside PDFs that was neither reported nor removed, and form values and comments that weren't reported (removed only because annotations are stripped).
Decision (no schema change; new kinds report as source `hidden_office`):
- Extraction reads text unclipped (`mediabox-clip=no`): off-page text goes to its own layer. Switched-off layers are turned on temporarily, diffed against the visible text, then restored. Form values (`getWidgets`/`getValue`) and comment text and authors (`getContents`/`getAuthor`) are extracted per page.
- New forensic reasons: `same_colour` (text and backdrop both ≥ 0.95 luminance, fills or the bare page only, never over images) and `tiny_text` (< 1 pt tall).
- Embedded JPEGs (DCTDecode only) are read raw and checked with exifr; GPS goes to the map.
- Redaction bakes form fields into page content (selected values are removed, the rest stay visible), always removes text outside the page box, drops OCProperties (unselected hidden-layer text becomes visible rather than staying hidden), deletes /Metadata and /PieceInfo from every object, and strips EXIF/XMP/IPTC/COM and trailers from embedded JPEGs losslessly (`redact/jpegMeta.ts`).
- verify() counts off-page and hidden-layer characters, layers still switched off, form values, and embedded image metadata (the `no_image_metadata` check now applies to PDFs).
- The pattern matcher accepts a standalone "AC" account label ("LOAN AC 7781200045" was being read as a phone number).
Consequences: 22 new tests in `test/hiddenStructures.test.ts`, each also checked independently on the decompressed output bytes. Disabling the off-page removal or the JPEG scrub turns the matching tests red. New samples `bank-statement-exposed.pdf` and `photo-with-gps.pdf` have golden tests, including `pdfimages` + `exiftool` on the output. A `notExpected` guard was added to the golden test.

## D-035: One row per value in the card and side panel; panel redesign (2026-10-31, user request)
Context: on a real-looking statement the panel listed the UPI ID, card, phone and email twice and the salary three times, repeated "X is visible in the document" on every row, wrapped tags onto their own lines, and named the main action differently in the card and the panel.
Decision: the core keeps one finding per occurrence, because `test/everyCopy.test.ts` guards keeping one copy while removing another. The UI groups findings with the same type, source and masked value into one row ("appears 2 times"); ticking it selects every copy. A row's second line appears only when it adds information. Each action has one name everywhere ("Remove N and upload"). A ticked value is drawn as a black redaction bar, the panel's only motion and only in response to a click; reduced motion is respected. Settings fold away. E2E builds accept `sidepanel.html?tab=<id>` so screenshots can show a real review; production builds contain no e2e code (checked).
Consequences: verified in headless Brave (screenshots, plus ticking a row and uploading through the panel). The site received a file without the ticked values and with the unticked account number.

## D-036: Click-to-load region map in the extension side panel (2026-10-31, approved by user: option "A")
Context: GPS findings had no map in the extension (the Web Lab has a Leaflet map). Map tiles are network requests that tell the tile server which area is being viewed.
Decision: the side panel shows "Show approximate area on a map" under location details and requests nothing until it's clicked. It then draws 4–6 OpenStreetMap tiles at zoom 9 around the coarse point (already rounded to ~11 km by the engine), using standard Web Mercator tile maths, so the extension needs no new dependency. An ~8 km circle marks the area, images carry no referrer, and OpenStreetMap is credited. The extension CSP gains an explicit `img-src 'self' data: https://tile.openstreetmap.org`; before this, images were unrestricted, so the policy is now tighter.
Consequences: in headless Brave the panel made 0 requests to OpenStreetMap before the click and 6 after it (6 of 6 tiles loaded under the new CSP). Still open: the Web Lab map loads its tiles as soon as a GPS result is shown; aligning it with click-to-load is a candidate follow-up.

## D-037: Text hidden by anything painted over it, clipped away, or invisible; pixels confirm (2026-10-31, approved by user)
Context: a second probe found three more leaks where verify() passed with the text still in the file: a white box drawn over text (whiteout), text clipped out of view, and a light picture placed over text. The detector only treated dark boxes as covering.
Decision:
- `pdfFills.ts` records the clip area for every draw, transparency-group alpha (zero for non-Normal blend modes, e.g. a multiply highlighter), soft-masked content (never counts as covering), and invisible-mode text. Shapes that only define masks or pattern cells are skipped.
- New hidden reasons: `covered` (any opaque shape or picture painted after the text: white, grey or light), `clipped` (under 40% of the glyph inside its clip), and `invisible_text` (invisible render mode, unless it sits over a picture, i.e. a searchable scan's OCR layer).
- Pixels have the final say on every paint-based reason: `pageInk.ts` renders the page, a text-free copy (made by MuPDF redaction with text removal only) and the text alone. A glyph with at least half its ink visible is not hidden. This removed the false alarms seen on browser-printed PDFs (a rounded badge's bounding box, a white letter on a gradient). Pages render only when a rule flags something.
- A user-approved test change: an opaque mid-grey box over text now counts as hiding it ("covered"); a see-through grey box (alpha 0.5) is the new negative control.
- MuPDF.js 1.28.1 bug found: device callbacks receive a `Shade` that was never retained, so its finalizer frees it twice (WASM "memory access out of bounds" under GC). Custom devices register no `fillShade` callback, and devices and pixmaps are destroyed explicitly.
Consequences: 11 new tests (whiteout, clip, picture over text, invisible text; negative controls for a white panel underneath, an OCR layer over a scan, a multiply highlighter, and in-clip text). 0 hidden-text false alarms on 5 real-world PDFs (3 browser-printed pages, 2 macOS system PDFs). A forced-GC stress test (`--expose-gc`, 3 rounds over all sample and real PDFs, scan + redact) shows no runtime errors.

## Spike S7: PP-OCR in onnxruntime-web (2026-10-31, passed)
Setup: PP-OCRv4 mobile detector (4.7 MB, Hugging Face SWHL/RapidOCR) + PP-OCRv5 English recogniser (7.8 MB, monkt/paddleocr-onnx), both Apache-2.0, run with onnxruntime-web 1.31.1 (MIT, WASM, one thread) in Node. Detection uses DB post-processing (threshold 0.3, box score 0.6, unclip 1.6); recognition uses greedy CTC decoding.
Result on the user's unredacted PAN photo: the PAN number (confidence 1.00), name, father's name and date of birth were all read, where Tesseract (even with the D-032 threshold pass) read none of them. The fake Aadhaar sample and scanned KYC page: Aadhaar read. The user's PAN photo with black bars: nothing read under the bars. About 1–2.3 s per image after a ~0.6 s model load. Runtime WASM file ~14 MB.

## D-038: PP-OCR as the main OCR engine, Tesseract as fallback (2026-10-31, approved by user: "Approve, fetch script")
Context: Tesseract couldn't read the PAN number, name or date of birth on the user's real PAN-card photo (patterned background, uneven light), even with the D-032 threshold pass. Spike S7 showed PP-OCR reads all of them.
Decision:
- `core/src/ocr/paddle.ts` contains the PP-OCR pipeline: detection on images scaled to at most 1536 px, recognition at 48 px height, greedy decoding, lines grouped and split into words, words under 0.5 confidence dropped. The ONNX sessions come from the host through a structural interface, so the core neither imports the runtime nor loads files. `withFallback` uses Tesseract if PP-OCR can't load or fails on an image. Engines can opt out of the D-032 threshold pass (`binarize: false`).
- Models: PP-OCRv4 mobile detection (4.7 MB) + PP-OCRv5 English recognition (7.8 MB) + dictionary, Apache-2.0. `pnpm models` downloads them from pinned Hugging Face revisions and refuses any file whose SHA-256 doesn't match; they go to the gitignored `vendor-models/`. `copy-vendor` bundles them into each app's `public/vendor/paddle/`.
- Runtime: `onnxruntime-web` 1.31.1 (MIT), WASM backend, one thread, imported from `onnxruntime-web/wasm`. Vite emits its 14.8 MB `.wasm` as an asset next to the worker. Added to the Web Lab (whose worker the extension reuses) and as a core devDependency for the Node tests.
- ID-card rules for OCR text: PAN numbers misread by OCR are repaired using the fixed letter/digit positions (accepted only if the result is a valid PAN); names on the line under a label (bilingual labels whose Hindi half is misread are tolerated); dates of birth next to a birth label, or any full date on a recognised PAN/Aadhaar card, since those print only the date of birth (reported as type `other`, "Date of birth: XX/XX/XXXX").
- `.gitignore` gains `vendor-models/` and `apps/*/public/vendor/`, so the 12.5 MB of models are never committed. Previously committed Tesseract files stay tracked.
- The golden test now requires that what wasn't removed is exactly the findings marked not removable, for every file type (Office used to be special-cased; image samples had none until the ID-card summary).
Consequences:
- The user's real PAN photo (as PDF and as JPEG): PAN number, name, father's name and date of birth are all found and removed, verify passes, and PP-OCR re-reading the output finds no PAN-shaped number or date.
- New sample `pan-card-photo.jpg` (fake, patterned, noisy). Tesseract finds only the PAN on it; PP-OCR finds the PAN, both names and the date. Its golden test is cross-checked with the Tesseract command-line tool.
- In the e2e extension in headless Brave, the KYC demo page scanned the card in ~3.6 s including the first model load, and the panel lists the PAN, both names and the date of birth.
- Size: extension `dist` 55 MB, Web Lab 56 MB (fine unpacked; worth reviewing before a Chrome Web Store release).
- Limits: no angle classifier, so a card photographed sideways without EXIF orientation reads poorly. The synthetic card is cleaner than real photos, so the real-photo result is the stronger evidence.
