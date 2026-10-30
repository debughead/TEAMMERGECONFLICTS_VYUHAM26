# RedactGuard: High- and Low-Level Design

## Context
Source spec: "RedactGuard Project Spec (AF-13)" (Oct 30, 2026). This document supersedes the spec where they differ; see `docs/DECISIONS.md`.
RedactGuard finds sensitive data in documents, removes it for real, and proves it is gone.

Decisions agreed with the user (they replace the spec's localhost-Python design):
- **Fully in-browser.** One shared TypeScript core runs in two front ends:
  - **Web Lab:** a static website with no backend.
  - **Browser Guard:** a Chrome MV3 extension. The same Lab is also bundled inside it as a full tab.
- **No server and no Python.** Files never leave the device. The only possible network call is Claude.
- **Local stack:**
  - MuPDF.js: PDF parsing, forensics, true redaction
  - PDF.js: preview and X-Ray
  - Tesseract.js: OCR
  - regex with Verhoeff/Luhn and format checks
  - rule-based name/address detection plus compromise.js
  - exifr: image metadata
  - JSZip: Office files
  - IndexedDB: audit log
- **Claude is optional.** It is off by default and uses the user's own API key. Only placeholder text is sent, and the UI shows the exact payload.
- **OCR scope:** ID photos and screenshots, plus scanned PDFs. The extension OCRs the first 3 pages; the Web Lab OCRs all pages with a progress bar. English only.
- **Web Lab modes:**
  - **Scan:** findings, X-Ray, metadata.
  - **Redact:** review, redact, verify, download.
  - "Quick redact" pre-selects critical and high findings. It never skips the review.
- **Extension modes:**
  - **Ask me (default):** the panel opens and the user picks which findings to redact.
  - **Auto-clean:** silently cleans only items that are never legitimate, then shows a notice. The original file is never uploaded silently.
- **Budget:** 24–36h with 4 people. "Production grade" means the core path plus security.

**Pitch:** *"Your document never leaves your browser. Open DevTools and watch: zero network requests. Turn on AI and only placeholder text goes out, and we show you exactly what was sent."*

---

## 1. Feature triage

### Build
| Feature | Where | Notes |
|---|---|---|
| Upload interception (file picker) | Ext | Capture-phase `change` listener on `document` |
| Drop interception | Ext | **Block only.** We can't reliably hand the cleaned file back to the site's drop handler, so the user is told to use the file picker |
| Verdict UI + side panel | Ext | Actions: Upload safe version / Upload anyway (with reason) / Trust site / Open in Lab |
| Ask me / Auto-clean | Ext | §3.10 |
| Fake-redaction detector (PDF) | Both | Words under dark fills, dark highlights, unapplied Redact/Square annotations |
| Indian ID detection | Both | Aadhaar (Verhoeff), PAN, card (Luhn), IFSC, UPI, phone, email, vehicle |
| OCR (Tesseract.js) | Both | Images and scanned PDF pages. OCR text goes through the same regex checks |
| Local name/address detection | Both | Indian address rules + compromise.js |
| Optional Claude + "What was sent" viewer | Both | User's own key; medical/salary/account context; page-fit tie-breaker |
| Secure redaction | Both | PDF: MuPDF `applyRedactions` plus full rewrite. Images: paint over pixels, then re-encode with no metadata |
| Verification re-scan | Both | The output file is released only if verification passes |
| Safe-version swap | Ext | DataTransfer + dispatch `input`/`change` |
| Context policy + trusted sites | Ext | Rules first; Claude only as a tie-breaker |
| EXIF/GPS + map | Both | Map starts zoomed out; exact location only on click (map tile requests reveal the area) |
| Document metadata | Both | PDF Info/XMP; DOCX/XLSX `docProps/*.xml` |
| Old-version leak | Both | Follows the PDF trailer's `/Prev` chain |
| Severity, exposure score, combination rule | Both | Rule-based |
| Tamper-evident audit log | Both | IndexedDB, hash chain, values HMAC'd with a non-extractable key |
| Leak X-Ray | Both | PDF.js render with red boxes drawn over hidden words |
| Purpose watermark | Both | Optional; applied before verify |

### Scan-only
- **DOCX/XLSX:** report tracked changes, comments, hidden text, hidden sheets/rows/columns, and metadata.
- **The only clean action** strips metadata and comments from the zip.
- **The UI advises** "Export to PDF and re-scan to redact."

### Cut / defer
- **Server or hosted mode, Python engine:** dropped.
- **Hindi/Malayalam OCR and explanations:** language data is large and needs testing.
- **Transformer NER models:** 60–100 MB download.
- **PaddleOCR:** heavy.
- **Paste Guard, leak footprint, minimum-necessary version:** cut.
- **PDF report download:** use "Print to PDF" instead.
- **Freehand box drawing in the side panel:** use the Lab later.
- **Firefox/Safari:** Chrome and Edge only for now.

### Fragile areas, each with a spike in hours 0–2
1. **Opening the side panel.** `chrome.sidePanel.open()` needs a user gesture, and a message from the content script after a file pick may not count as one.
   - **Design:** a shadow-DOM **in-page verdict card** is the primary UI, so it always works. Its "Review details" button click (a real gesture) opens the side panel.
2. **Finding filled rectangles with MuPDF.js.** Use a custom `mupdf.Device` with a `fillPath` callback. If that's blocked, fall back to PDF.js `getOperatorList()`, which lists the drawing operations (path, fill, colour).
3. **Loading Tesseract in the extension.** Remote code is forbidden in extensions. Bundle `worker.min.js`, the core `.wasm` and `eng.traineddata.gz`, and set `workerPath`/`corePath`/`langPath` with `chrome.runtime.getURL`. The manifest CSP needs `'wasm-unsafe-eval'`.
4. **Re-dispatch loop.** When we re-attach a file, our own listener would catch it again. Keep files we put in ourselves in a `WeakSet` and skip them.
5. **EXIF orientation.** Decode images with `createImageBitmap(blob, {imageOrientation:'from-image'})` so OCR boxes and painted regions use the same coordinates.
6. **Message size.** Extension messages can't carry a `File`, so the content script base64-encodes it. Cap at 15 MB.

---

## 2. HLD

```
                 packages/core  (TypeScript, runs in a Web Worker, no DOM, no network)
   extract (MuPDF.js, exifr, JSZip, Tesseract.js) → detect (forensic, regex+checksum, rules NER)
   → [optional ai/claude via host callback] → score → policy → redact → watermark → verify → audit

 ┌─────────────── Chrome extension (MV3) ───────────────┐   ┌──── Web Lab (static site) ────┐
 │ content script (isolated world)                       │   │ React app + Web Worker(core)  │
 │   intercept → in-page verdict card (shadow DOM)       │   │ Scan / Redact / Verify /      │
 │        │ runtime msg (base64)                         │   │ Audit / Settings              │
 │ service worker (router only, short-lived)             │   │ CSP connect-src 'self'        │
 │        │                                              │   │  (+ api.anthropic.com if AI)  │
 │ offscreen document → Web Worker(core)                 │   │ IndexedDB audit               │
 │ side panel (React): details, X-Ray, actions           │   └───────────────────────────────┘
 │ lab.html (same Lab app, bundled)                      │
 │ IndexedDB audit, chrome.storage.local settings        │
 └───────────────────────────────────────────────────────┘
        only outbound call (opt-in): https://api.anthropic.com  (user's own key)
```

- **Core never calls the network itself.** It receives an `aiClient` callback from the host app. Without a callback, there is no AI. This keeps "no network" checkable in code review.
- **Heavy work never runs in the service worker.** Chrome stops service workers after about 30s idle. Scanning runs in an **offscreen document** (`chrome.offscreen`, reasons `WORKERS`, `BLOBS`) inside a Web Worker. Calls into the worker go through Comlink, a small library for calling worker functions.
- **Each origin keeps its own audit log.** The website and the extension have separate IndexedDB storage. Both can export their log as signed JSON.

**Stack:**
- pnpm workspaces, TypeScript, Vite (+ `@crxjs/vite-plugin` for the extension), React, Tailwind
- `mupdf` (MuPDF.js), `pdfjs-dist`, `tesseract.js`, `exifr`, `jszip`, `compromise`, `comlink`, `idb`, `zod`, Leaflet
- Tests: Vitest (core runs in Node, since `mupdf` and `tesseract.js` both support Node), Playwright for E2E

**Claude model (opt-in, D-019):** `claude-opus-5-5` for both contextual findings (effort `medium`) and page fit (effort `low`), with structured outputs (`output_config.format` json_schema). Forced tool use isn't available on this model. The host calls the API with the official SDK and the user's own key. The core only builds requests and validates replies.

---

## 3. LLD

### 3.1 Repo layout
```
packages/core/src/
  index.ts                 scan(), redact(), verify() — pure functions over ArrayBuffer
  schemas.ts               zod: Finding, ScanResult, RedactOptions, VerifyReport (shared contract)
  filetype.ts              magic-byte sniff + limits
  extract/{pdf.ts,pdfRevisions.ts,pdfFills.ts,image.ts,ocr.ts,office.ts}
  detect/{validators.ts,patterns.ts,forensic.ts,localNer.ts,masking.ts,lexicons/*.json}
  ai/{prompt.ts,schema.ts,minimise.ts}      builds payloads; host supplies the transport
  score.ts policy.ts watermark.ts verify.ts
  redact/{pdf.ts,image.ts,officeMeta.ts}
  audit/{chain.ts,hmac.ts}  storage-agnostic; host provides an IndexedDB adapter
  worker.ts                 Comlink-exposed entry
packages/ui/                shared React components: FindingList, XRay, GpsMap, VerifyReport, AiPayloadViewer
apps/weblab/                static site (Scan, Redact, Verify, Audit, Settings)
apps/extension/             manifest.ts, content/, background/, offscreen/, sidepanel/, lab/ (reuses weblab pages)
demo-sites/{job-portal,bank-kyc}/
samples/                    generator scripts + fake-data files (+ expected-findings JSON)
```

### 3.2 Contract
```ts
Finding { id; type; source: 'text'|'ocr'|'under_black_box'|'black_highlight'|'unapplied_annot'|'old_version'|'metadata'|'hidden_office'|'claude';
          page; rects: Rect[]; masked; severity; reason; confidence; redactable; autoCleanable; detector }
ScanResult { scanId; fileSha256; fileType; verdict; exposureScore; findings; metadata; ocr:{pagesDone,pagesTotal};
             context?:{domain,fieldLabel,expected,neededTypes,decidedBy}; combinationRisks; ai:{enabled,used,payloadId?} }
RedactOptions { selectedIds; watermark?:{domain,purpose,date} }
RedactResult  { bytes: ArrayBuffer; mime; filename; verify: VerifyReport; unredacted: string[] }
```
- **Raw values stay in the worker.** While a scan session is open, they live in the worker's memory only. The UI receives `masked` strings and `rects`.
- **"Reveal" asks the worker for the value directly.** It is never sent anywhere or logged.
- **No signed redaction plan.** The file and the findings sit in the same process. The session is dropped when the user acts, the tab closes, or 10 minutes pass.

### 3.3 Limits (`filetype.ts`)
- File types are decided by sniffing the first bytes, never by name. Supported: PDF, JPEG, PNG, WebP, DOCX, XLSX.
- **Size:** files over 15 MB in the extension or 50 MB in the Lab are rejected.
- **PDFs:** at most 200 pages. Encrypted PDFs are rejected with a clear message.
- **Images:** at most 40 megapixels.
- **Office zips:** at most 2000 entries, 100 MB uncompressed, and a compression ratio of 100. This stops zip bombs.
- **Timeout:** each scan is cancelled after 60s by terminating the Web Worker.

### 3.4 Extraction
- **PDF text:** `doc = mupdf.Document.openDocument(buf,'application/pdf')`. Per page, `page.toStructuredText('preserve-whitespace').asJSON()` gives words with bounding boxes and span colours.
- **PDF fills (`pdfFills.ts`):** run the page through a custom `mupdf.Device`. Its `fillPath(path, evenOdd, ctm, cs, color, alpha)` callback records the path bounds after the CTM transform. Full-page image draws (`fillImage`) are recorded too, so dark images placed over text are caught.
- **Annotations:** `page.getAnnotations()` gives each annotation's type, colour and rect.
- **Metadata:** `doc.getMetaData('info:Author'|…)`, plus the XMP stream at `Root/Metadata`.
- **Revisions (`pdfRevisions.ts`):**
  - Parse the last `startxref` and follow trailer `/Prev` offsets.
  - Each earlier revision becomes `buf.slice(0, endOfThatRevision)`, which MuPDF opens to extract text.
  - **Linearized PDFs are not flagged** unless the text actually differs.
- **Scanned-page detection:** a page with fewer than 20 text characters and one image covering at least 80% of it.
- **OCR (`ocr.ts`):**
  - Render the page with MuPDF at 300 dpi (greyscale), or decode the image upright with MuPDF (EXIF orientation applied in the core, spike S5).
  - OCR is injected by the host as an `OcrEngine` (D-016): the host creates the tesseract.js worker with bundled paths. Word boxes come from `data.blocks → paragraphs → lines → words` (requires `{ blocks: true }` in tesseract.js 7) and are mapped back to PDF points.
  - **Page cap:** the extension OCRs at most 3 pages and reports `ocr.pagesDone < pagesTotal` in the UI. The Lab OCRs all pages with progress events.
- **Images:** `exifr.parse(buf, {gps:true, xmp:true, iptc:true})`.
- **Office:**
  - Load with JSZip and read parts with a small tag scanner (DOMParser doesn't exist in Web Workers). Any DOCTYPE is rejected, only built-in and numeric entities are decoded, and each part's inflation is capped at 25 MB (D-017).
  - **DOCX:** `w:del`/`w:ins` (tracked changes), `comments.xml`, `w:vanish` (hidden text), dark `w:highlight`/`w:shd`.
  - **XLSX:** `workbook.xml` sheet `state`, `hidden` rows and columns, comments.
  - **Both:** `docProps/core.xml` and `app.xml`.

### 3.5 Detection
1. **Forensic:**
   - A fill counts as dark when luminance < 0.25 and alpha ≥ 0.9.
   - A word is "under a black box" when at least 60% of its area overlaps a dark fill.
   - Also flagged: a dark highlight, a span whose text colour is close to its background, Redact annotations (never applied), and dark-filled Square annotations.
   - **Old versions:** compare the text of each earlier revision with the current one; any removed tokens become findings.
2. **Regex and checksums:**
   - A match counts only if it also passes its check: Verhoeff, Luhn, the PAN 4th-letter set, `^[A-Z]{4}0[A-Z0-9]{6}$` for IFSC, a UPI handle list, phone `(\+91[\s-]?)?[6-9]\d{9}`, and vehicle state codes.
   - **OCR slack:** OCR text gets a looser medium-confidence pattern. Example: 12 digits within 40 characters of "Aadhaar" or "आधार", even when Verhoeff fails.
3. **Local NER (`localNer.ts`):**
   - Address blocks:
     - a 6-digit PIN (`[1-9]\d{5}`) plus a cue (S/O, D/O, W/O, House/Flat/Door No, Nagar, Road, Street, Dist, a state name), or
     - 2–4 consecutive lines ending in a PIN.
   - **Names:**
     - The value after a label ("Name:", "Account Holder", "Patient Name", "Employee Name").
     - compromise.js `#Person` matches, plus an Indian first-name and surname lexicon of about 2k entries.
   - **Medical and salary:** keyword lexicons set `needsContext=true` and give low confidence.
4. **Masking (`masking.ts`):** everything found by checks 2 and 3 becomes a typed placeholder (`[AADHAAR_1]`, `[NAME_1]`, `[ADDR_1]`, …). The mapping is kept in memory only.
5. **AI (opt-in):**
   - **Payload:** `minimise.ts` picks only lines with `needsContext` or unresolved low-confidence hits, in chunks of at most 2k tokens.
   - **Prompt:** wraps the text in `<document>` tags and states that document text is data, never instructions. A strict JSON-schema tool forces the output shape.
   - **Validation:** the host calls the API, then the core validates the reply with zod.
   - **Acceptance:** a finding is kept only if its text appears in the original line and contains no placeholder.
   - **"What was sent" viewer:** the last 20 payloads are kept in memory.
   - **Failures:** 15s timeout and one retry. On failure, `ai.used=false` and the local results stand.
6. **Score:**
   - Severity by type:
     - **critical:** Aadhaar, card numbers, anything hidden under a black box, old versions
     - **high:** PAN, account numbers, medical, GPS
     - **medium:** name with address, phone, email
     - **low:** other metadata
   - **Exposure score:** each finding adds 40/20/8/2 points by severity (×1.5 if hidden), capped at 100.
   - **Combination rule:** a name, plus Aadhaar or PAN, plus an address, phone, email or date of birth adds a critical "identity kit" finding (D-041).
7. **Policy (extension):**
   - **Keyword rules:** the field label and page title map to expected document types. For example, "aadhaar|kyc" expects Aadhaar and PAN; "resume|cv" expects name, phone and email. The domain is not matched: anyone can register a domain containing "aadhaar" (D-042).
   - **AI tie-breaker:** only when AI is on and no rule matched. It receives only the domain, label, title and finding types.
   - **Block rule (D-020):** any critical finding the page doesn't need blocks, even on pages that expect some upload.
   - **Hard rules:**
     - Hidden-data findings are always at least `warn`.
     - A trusted site moves `warn` to `allow` but never `block` to `allow`.
     - Text from the page can never lower a verdict.

### 3.6 Redaction
- **PDF:**
  - For each selected rect, `page.createAnnotation('Redact').setRect(r)`, then `page.applyRedactions(true, PDF_REDACT_IMAGE_PIXELS)`. This also removes pixels in scanned images.
  - Delete all remaining annotations, `Names/EmbeddedFiles`, `OpenAction`/JavaScript, `AcroForm/XFA`, `Root/Metadata` and every Info entry.
  - Save with `doc.saveToBuffer('garbage=4,compress,clean,sanitize')`. This is a full rewrite with no incremental save.
- **Image:**
  - Decode upright with MuPDF and paint the regions with solid black in the pixmap.
  - Re-encode from raw pixels with MuPDF (JPEG stays JPEG; PNG and WebP become PNG). The re-encode carries no EXIF, XMP, ICC or thumbnail. Running in MuPDF instead of a canvas keeps it testable in Node.
- **Office:** strip `docProps` personal fields and comments, and delete the `comments*.xml` parts and their relationships.
- **Watermark:** a diagonal line at 15% opacity, "Shared with {domain} for {purpose}, {date}", stamped on every page *before* redactions are applied, so glyphs crossing a redacted area are removed too (D-020). PDFs only.

### 3.7 Verification (`verify.ts`)
The output is re-opened as a fresh document and re-scanned (extraction, forensic checks, regex). The checks:
- **(a)** No text and no OCR'd text (for scanned or image output) overlaps a redacted rect. For scanned and image output, every redacted region's pixels must be solid black; OCR words are only counted in regions that aren't (OCR reads noise like "a" off a black box, D-015).
- **(b)** No removed value is still extractable (compared in worker memory, normalized). A value is only required to be gone if no unselected or unredactable finding also carries it (D-015).
- **(c)** Info and XMP metadata are empty.
- **(d)** The file has one revision.
- **(e)** There are no annotations, embedded files or JavaScript.
- **(f)** Images have no EXIF.

**If any check fails, no file is released.** The UI shows which check failed.

### 3.8 Audit (`audit/`)
- **Storage:** IndexedDB store `audit` (append-only from the API; the library has no update or delete).
- **Row fields:** `{seq, ts, origin, action, fileSha256, fileType, domain?, itemType?, page?, valueHmac?, verdict?, detail, prevHash, rowHash}`, where `rowHash = SHA-256(prevHash || canonicalJSON)`.
- **HMAC key:** created with `crypto.subtle.generateKey({name:'HMAC',hash:'SHA-256'}, extractable=false)` and stored as a `CryptoKey` in IndexedDB, so code can use it but never read it out.
  - Plain hashes of Aadhaar numbers could be brute-forced; this keyed HMAC can't.
- **Actions logged:** scan, redact, verify, override (with the user's reason), trust_site, ai_call (line count and placeholder types only).
- **Signed head (D-043):** every append also stores `{seq, rowHash, mac}` (mac = HMAC of `seq:rowHash`) in the same transaction, apart from the rows. Without it, a log missing its newest rows, or all of them, looks like a valid shorter log.
- **Chain check:** `verifyChain(rows, {head, key})` recomputes the chain and checks the rows still reach the signed head. The UI shows "Chain intact ✓" or the first broken row.
- **Export:** the log can be exported as JSON for proof.

### 3.9 Extension (MV3)
- **Manifest:**
  - `permissions: ["storage","sidePanel","offscreen"]`
  - `optional_host_permissions: ["https://api.anthropic.com/*"]`, requested only when the user enables AI
  - Content script on `<all_urls>`, with `run_at: document_start` and `all_frames: true`
  - `content_security_policy.extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'"`
  - No remote code. Tesseract and MuPDF files are bundled under `web_accessible_resources: []`, because only extension pages need them.
- **content/:**
  - **Interception:** listen in the capture phase. Skip files in the `approved` WeakSet. Otherwise call `stopImmediatePropagation()` and `preventDefault()`, stash the File, and clear `input.value`.
  - **Context:** collect hostname, title and the field's label (`label[for]`, `aria-*`, nearby text up to 120 characters). Read nothing from other fields.
  - **Hand-off:** base64-encode the file, send it to the background, and show the shadow-DOM card ("Scanning…" with progress).
  - **Messaging:** never use `window.postMessage`.
- **background/:**
  - Routes messages: it validates `sender.id`/`sender.tab` and makes sure the offscreen document exists.
  - Holds one pending upload per tab with a 10-minute TTL.
  - Calls `sidePanel.open({tabId})` from the card's "Review details" click.
- **offscreen/:** hosts the core Web Worker and an IndexedDB audit adapter. When AI is on, it also does the fetch to Anthropic, using the key from `chrome.storage.local`.
- **Card and side panel actions:**
  - **Upload safe version:** call `redact()`; if verification passes, build `new File([bytes], originalName, {type, lastModified})` and add it to `approved`. Then set `input.files` via `DataTransfer` and dispatch `input` and `change` with `bubbles: true`.
  - **Upload anyway:** requires a reason, writes an audit row, then re-attaches the original the same way.
  - **Trust site:** saves the domain in `storage.local.trusted` and writes an audit row.
  - **Open in Lab:** opens `lab.html`. The file is passed in memory through the offscreen session id; nothing is written to disk.
- **Settings:** mode (Ask me / Auto-clean), AI toggle and key (with a warning that it's stored locally), trusted sites, OCR on/off.

### 3.10 Ask me vs Auto-clean
- **Auto-cleanable findings** (`autoCleanable=true`): EXIF/GPS, document metadata, text under black boxes, unapplied annotations, old revisions, comments.
- **Auto-clean mode:** applies when every finding is auto-cleanable or expected on the page.
  - **Steps:** redact, verify, swap the file in, then show a toast ("Uploaded cleaned copy: GPS removed, 1 hidden item removed").
  - **Anything else:** the card or panel opens as in Ask me.
  - **Verify fails, Office file, or drop:** the upload is blocked. The original is never uploaded silently.
- **Ask me:** every `warn` or `block` asks the user. `allow` still strips metadata automatically and shows a toast.

### 3.11 Web Lab (static site)
- **Pages:** the same Scan → Redact → Verify → Download flow, plus Audit and Settings. Downloads use a Blob URL that is revoked after use.
- **Hosting:** Netlify, Vercel or GitHub Pages, with these headers:
  - `Content-Security-Policy: default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self' https://api.anthropic.com; img-src 'self' data: blob: https://tile.openstreetmap.org; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`
  - `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, `Permissions-Policy`
- **Caching:** the MuPDF and Tesseract files are self-hosted and cached by a service worker, so the Lab works offline after the first visit.
- **AI key:** kept in `sessionStorage` by default. "Remember on this device" moves it to `localStorage`, with a warning.

---

## 4. Security controls
1. **No backend.** There is no server-side attack surface and no data at rest beyond the user's own browser storage.
2. **Network:** blocked by CSP. Core has no network access, and the only outbound host is Anthropic, opt-in, with the permission requested at runtime in the extension.
3. **Untrusted inputs:**
   - File types are sniffed, and limits plus zip-bomb guards apply.
   - XML with a DOCTYPE is rejected. PDF JavaScript never runs.
   - Each scan runs in a Web Worker with a timeout and is killed by terminating the worker.
4. **Hostile page:** the content script runs in an isolated world and never uses `window.postMessage`. The verdict card is a closed shadow root. Page text is never trusted for verdict downgrades.
5. **AI:**
   - Off by default; the user's own key.
   - Minimal payloads with placeholders, shown to the user in full.
   - Prompts are built to resist injection, and replies are schema-validated.
   - The AI can never lower a deterministic severity.
6. **Audit:** hash-chained, values protected with a non-extractable HMAC key, overrides logged with their reason, verifiable and exportable.
7. **Raw values:** kept in worker memory only. Logs (`console`) are stripped in production builds.
8. **Supply chain:**
   - Pinned lockfile; `pnpm audit` in CI. Minimal dependencies, with WASM files vendored and SRI on Lab assets.
   - **MuPDF.js is AGPL:** fine for an open-source hackathon. Note it for any commercial release.

---

## 5. Build plan (4 people, ~30h)
| Hours | Core/PDF lead | Detection/OCR lead | Extension lead | Web Lab + demo |
|---|---|---|---|---|
| 0–2 | **Spike:** MuPDF.js `fillPath` + `applyRedactions` in a browser worker; `schemas.ts` | **Spike:** Tesseract in an offscreen doc from bundled files; validators + tests | **Spike:** intercept, card, `sidePanel.open` from a click | pnpm monorepo, Vite apps, sample generators |
| 2–10 | extract/pdf, fills, forensic, redact/pdf, verify | patterns, localNer, masking, ocr.ts, score | background router, offscreen host, card + panel (mock) | Scan page, X-Ray, FindingList |
| 10–14 | **E2E #1**: demo portal → intercept → core scan → card shows real findings (AI off) | | | |
| 14–22 | revisions, image redact, office scan + meta strip, audit chain | policy, AI module + payload viewer | safe swap, Ask me/Auto-clean, override, trust, Open in Lab | Redact/Verify/Audit/Settings, GPS map, watermark, deploy site |
| 22–26 | security tests, limits | OCR tuning on samples, AI failure paths | drop-block, edge cases | demo sites, DevTools "zero requests" demo |
| 26–30 | **Freeze.** All samples with AI off and on; 3 rehearsals; backup video | | | |

---

## 6. Verification
- **Unit tests (Vitest, in Node):**
  - Verhoeff/Luhn test vectors and every regex.
  - Address and name rules.
  - Scoring.
  - Policy truth table, including "a trusted site can't unblock a hidden leak".
  - Hash-chain tamper detection.
- **Golden tests (Vitest, in Node, same core):**
  - Every file in `samples/` is checked against its expected-findings JSON.
  - Every redaction must pass `verify` with 0 recoverable items.
  - Outputs are cross-checked with `pdftotext`, `exiftool` and `tesseract` (CLI) to confirm the values are gone.
- **Security tests:**
  - A zip bomb, a pixel bomb, a 300-page PDF, a PDF renamed `.png`, XML with a DOCTYPE, and an encrypted PDF are all rejected.
  - A scan longer than 60s times out.
  - With AI on, the captured payload contains no raw Aadhaar, PAN, phone or name from the sample.
  - A prompt-injection sample leaves the deterministic findings intact.
- **E2E (Playwright with the unpacked extension, plus a manual pass):**
  1. A bank statement on the job portal is blocked. "Upload safe version" sends a file that, run through `pdftotext`, shows no account number.
  2. An Aadhaar PNG on the KYC page is allowed and arrives with GPS stripped.
  3. A photographed ID card: OCR finds the Aadhaar and the region is painted out.
  4. Auto-clean on a GPS photo shows a toast and uploads the cleaned file.
  5. "Upload anyway" writes an audit row.
  6. Drop gets blocked with guidance to use the file picker.
- **Web Lab:**
  - An incrementally saved PDF shows the old text recovered.
  - A scanned PDF gets OCR'd.
  - DevTools Network shows 0 requests while scanning with AI off.
  - Wi-Fi off: everything except AI still works.
