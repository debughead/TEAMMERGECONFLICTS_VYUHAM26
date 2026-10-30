# RedactGuard: feature-by-feature build guide

How to use this guide:
- Features are in build order, matching the build plan in `docs/HLD.md` §5.
- Each feature lists its goal, the files involved, the steps, how to verify it, and pitfalls.
- **Code here is a sketch. Verify every API first.** Library names and signatures are hints, not facts. Confirm each call against the installed package's `.d.ts` and record it in `docs/VERIFIED_APIS.md` before relying on it (see `.claude/rules/verify-before-you-use.md`).
- For the full design reasoning, see `docs/HLD.md`. Decisions live in `docs/DECISIONS.md`.

---

## F0. Monorepo scaffold
**Goal:** the workspace builds and tests with empty packages.
**Files:** `pnpm-workspace.yaml`, root `package.json`, `tsconfig.base.json`, `packages/core`, `packages/ui`, `apps/weblab`, `apps/extension`, `demo-sites/`, `samples/`.
**Steps:**
1. Set up the pnpm workspace with packages `@redactguard/core`, `@redactguard/ui`, `weblab` and `extension`.
2. Use TS strict mode everywhere (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`).
3. Set up Vitest in `packages/core` and Vite in both apps (the extension via a CRX/MV3 plugin; confirm the plugin's current API first).
4. Update the **Commands** section of `CLAUDE.md` so it matches the real scripts.

**Verify:** `pnpm install`, `pnpm -r exec tsc --noEmit` and `pnpm test` all pass, with zero tests.
**Pitfalls:** adding dependencies requires asking first (CLAUDE.md, "Stop and ask"). List the full dependency set in one request.

---

## Spikes (hours 0–2). Record each result in `docs/DECISIONS.md` and `docs/PROGRESS.md`

| # | Spike | Pass criteria | Fallback (needs approval) |
|---|---|---|---|
| S1 | Side panel opens from the in-page card click | Clicking "Review details" in the shadow-DOM card opens the side panel for that tab | The card alone carries all actions; the panel opens only from the toolbar icon |
| S2 | MuPDF.js finds filled shapes | On a sample PDF with a black rectangle over text, the device callback reports the rectangle's bounds and fill colour | PDF.js `getOperatorList()`: walk path and fill operations and track the current fill colour |
| S3 | Tesseract.js in the offscreen doc from bundled files | OCR of a sample PNG returns word boxes, with zero network requests in DevTools | Run OCR in the side panel or Lab page instead of offscreen |
| S4 | Re-attach loop guard | After a programmatic `input.files =` plus a `change` dispatch, our listener does not intercept again, and the demo page receives the file | Mark the input with a private symbol for one tick |
| S5 | EXIF orientation | On a rotated JPEG (orientation 6), the OCR boxes and the painted regions line up | Normalize orientation once at decode time and use only those pixels afterwards |
| S6 | 15 MB over messaging | A 15 MB file goes content script → background → offscreen intact (same SHA-256) | Chunked messages (1 MB parts) and reassembly |

---

## F1. Shared contract (`packages/core/src/schemas.ts`)
**Goal:** one set of zod schemas used by the core, the UI and messaging.
**Steps:**
1. Define `Rect`, `Finding`, `ScanResult`, `RedactOptions`, `RedactResult`, `VerifyReport` and `AuditEvent`, as in HLD §3.2.
2. Export the inferred TS types.
3. Write message schemas for the extension (`ScanRequestMsg`, `VerdictMsg`, `ActionMsg`).

**Verify:** unit tests check that a valid sample parses and that a sample containing a raw-value field is rejected.
**Pitfalls:**
- After the team agrees on this file, changing it requires asking first.
- Never add a field that carries a raw value to the UI.

---

## F2. File sniffing and limits (`filetype.ts`)
**Goal:** reject dangerous or unsupported input before any heavy library opens it.
**Steps:**
1. Identify the type from magic bytes:
   - `%PDF-` → PDF
   - `FF D8 FF` → JPEG
   - `89 50 4E 47` → PNG
   - `RIFF....WEBP` → WebP
   - `PK\x03\x04` → a zip; check `[Content_Types].xml` to tell DOCX from XLSX
2. Enforce the limits in HLD §3.3. Read zip limits from the central directory, which lists sizes before anything is extracted.

**Verify:** tests for a PDF renamed `.png`, a zip bomb, a pixel bomb, a 300-page PDF and an encrypted PDF, each expecting rejection with a typed error.
**Pitfalls:** never trust `File.type` or the file extension.

---

## F3. Validators and patterns (`detect/validators.ts`, `detect/patterns.ts`)
**Goal:** structured Indian IDs with few false positives.
**Steps:**
1. Implement Verhoeff (Aadhaar) and Luhn (cards).
2. Write regexes:
   - **Aadhaar:** 12 digits, first digit 2–9, separated by spaces or hyphens in groups of 4.
   - **PAN:** 4th letter in `PCHFATBLJG`.
   - **IFSC:** `^[A-Z]{4}0[A-Z0-9]{6}$`.
   - **UPI:** handle on an allow-list.
   - **Phone:** 6–9 start, optional `+91`.
   - **Vehicle:** state code from a list.
3. Look for nearby keywords that raise confidence.
4. Add the looser OCR variant: a medium-confidence Aadhaar match near the word "Aadhaar" even when Verhoeff fails.

**Verify:** for every type, a positive case, a near-miss negative (12 random digits failing Verhoeff, 16 digits failing Luhn) and a formatting variant.
**Pitfalls:**
- Only fake numbers in tests. Generate valid Verhoeff numbers in test helpers instead of hard-coding real ones.
- Never put raw matches in snapshots.

---

## F4. PDF extraction and fills (`extract/pdf.ts`, `extract/pdfFills.ts`)
**Goal:** words with boxes and colours, filled shapes, annotations and metadata for each page.
**Sketch (verify APIs first):**
```ts
// UNVERIFIED sketch. Confirm against node_modules/mupdf/*.d.ts
const doc = mupdf.Document.openDocument(buf, "application/pdf");
for (let i = 0; i < doc.countPages(); i++) {
  const page = doc.loadPage(i);
  const st = JSON.parse(page.toStructuredText("preserve-whitespace").asJSON());
  // custom device collects fills: fillPath(path, evenOdd, ctm, colorspace, color, alpha)
}
```
**Steps:**
1. Normalize everything into `ExtractResult { pages: [{ words, fills, images, annots, isScanned }], metadata, revisions }`.
2. Store word rects in PDF points, top-left origin. Pick this convention once and document it.

**Verify:** golden test on `samples/bank-statement-fake-redaction.pdf`. The expected words and at least one dark fill are present.
**Pitfalls:** coordinate systems. MuPDF, PDF.js and canvases use different origins and scales; convert in one place only.

---

## F5. Forensic detector (`detect/forensic.ts`)
**Goal:** find text hidden under black boxes, dark highlights and unapplied annotations.
**Steps:**
1. Luminance = 0.2126R + 0.7152G + 0.0722B. A fill counts as dark when luminance < 0.25 and alpha ≥ 0.9.
2. A word is hidden when the area of word ∩ fill divided by the word's area is at least 0.6.
3. Flag text whose colour is close to its background, Redact annotations and dark-filled Square annotations.

**Verify:** golden sample yields `source: "under_black_box"` findings with the expected count and pages. A control PDF with black text on white yields none.
**Pitfalls:** table borders and header bars are dark fills too. The overlap ratio rule matters; test a document with a dark header bar.

---

## F6. Old versions (`extract/pdfRevisions.ts`)
**Goal:** recover text from earlier incremental saves.
**Steps:**
1. Find the last `startxref` and parse the trailer. Follow `/Prev` offsets, handling both xref tables and xref streams.
2. For each revision end offset, slice the buffer, open it with MuPDF and extract the text.
3. Diff tokens against the current revision; removed tokens become findings.

**Verify:** `samples/incremental-edit.pdf` recovers the original text. A linearized PDF with no text changes yields no findings.
**Pitfalls:** never count `%%EOF` markers, because linearized files have two.

---

## F7. Local NER and masking (`detect/localNer.ts`, `detect/masking.ts`)
**Goal:** find names, addresses, medical terms and salary terms offline, and produce placeholder text.
**Steps:**
1. **Addresses:** a PIN code plus an address cue, or a block of lines ending in a PIN.
2. **Names:** the value after a label ("Name:", "Account Holder", …), compromise.js person matches, and the lexicon.
3. **Medical and salary:** lexicon hits are low confidence and set `needsContext`.
4. **Masking:** a stable placeholder per distinct value (`[NAME_1]` is reused for the same name).

**Verify:** unit tests on fake address blocks and labelled names. A masking test asserts the output contains no raw value.
**Pitfalls:** don't over-flag. Common words that are also names ("Rose", "Bank") need a label or the lexicon plus capitalization.

---

## F8. OCR (`extract/ocr.ts`)
**Goal:** word boxes for images and scanned PDF pages.
**Steps:**
1. Render to an `OffscreenCanvas` at 300 dpi, convert to greyscale, apply an Otsu threshold, and upscale small images ×2.
2. Run Tesseract with **bundled** worker, core and language paths, injected by the host. The core must not hard-code `chrome.runtime`.
3. Map boxes back to page coordinates.
4. Respect the page cap passed in the options (extension 3, Lab all pages) and report progress.

**Verify:**
- `samples/aadhaar-mock.png` → Aadhaar finding with a box.
- Rotated JPEG → boxes line up (spike S5).
- DevTools Network shows 0 requests.

**Pitfalls:** Tesseract downloads its language data from a CDN by default. Always set the paths explicitly.

---

## F9. Score and policy (`score.ts`, `policy.ts`)
**Goal:** severity per finding, an exposure score, combination risks, and a verdict.
**Steps:** implement HLD §3.5 items 6–7 exactly. The hard rules:
- Hidden data is at least `warn`.
- A trusted site can never move `block` to `allow`.
- Page text can never downgrade a verdict.
- AI can only add findings.

**Verify:** a policy truth-table test covering every combination of {hidden leak, critical not expected, expected, trusted site, AI said "expected"}.

---

## F10. Redaction and verification (`redact/*`, `watermark.ts`, `verify.ts`)
**Goal:** true removal, and proof of it.
**Sketch (verify APIs first):**
```ts
// UNVERIFIED sketch
const annot = page.createAnnotation("Redact"); annot.setRect(rect);
page.applyRedactions(/* blackBoxes */ true, /* imageMethod */ PIXELS);
const out = doc.saveToBuffer("garbage=4,compress,clean,sanitize");
```
**Steps:**
1. Redact, then strip annotations, embedded files, JavaScript, XFA, XMP and Info.
2. Apply the optional watermark.
3. Save with a full rewrite.
4. Images: paint over the regions and re-encode via canvas.
5. `verify()` reopens the output **as a fresh document** and runs all six checks (HLD §3.7).

**Verify:**
- Every golden sample redacts with `verify.passed === true`.
- Independent CLI cross-check: `pdftotext out.pdf - | grep <fake value>` and `exiftool out.jpg` find nothing.

**Pitfalls:** `verify()` must never reuse objects from the redaction step. If it fails, no bytes are released.

---

## F11. Audit log (`audit/chain.ts`, `audit/hmac.ts` + host IndexedDB adapter)
**Goal:** a record of every action that holds no raw values and shows tampering.
**Steps:**
1. Each row hashes `prevHash` plus the row's canonical JSON. Values are stored as an HMAC made with a non-extractable WebCrypto key.
2. `verifyChain()` and JSON export.
3. The adapter interface keeps the core storage-agnostic.

**Verify:**
- Appending 3 rows and then editing one in the test makes `verifyChain()` report the broken row.
- No audit row contains a raw value; check by asserting that no row string matches a fake value from the sample.

---

## F12. Optional AI (`ai/prompt.ts`, `ai/schema.ts`, `ai/minimise.ts` + host transport)
**Goal:** context findings from masked text, only when the user turns AI on.
**Steps:**
1. Select only lines that need context; chunks are at most 2k tokens.
2. Wrap the text in `<document>` tags, use the system prompt that treats document text as data, and request a strict JSON tool schema.
3. The host performs the fetch: the user's own key, plus the browser-access header (confirm the current header name in Anthropic's docs).
4. Validate the reply with zod. Accept only text present in the source line with no placeholders.
5. Keep the payload log for "What was sent".
6. Timeout 15 s, one retry, and `ai.used=false` on failure.

**Verify:**
- Payload test: no raw value from any sample appears in the captured payload.
- The prompt-injection sample leaves the deterministic findings unchanged.
- AI off means the transport is never called.

**Pitfalls:** this feature adds a network request, which requires asking first (CLAUDE.md, "Stop and ask"). Get approval before wiring the transport.

---

## F13. Office scan and clean (`extract/office.ts`, `redact/officeMeta.ts`)
**Goal:** report hidden content in DOCX/XLSX and strip metadata and comments.
**Steps:**
1. Open with JSZip and parse XML with `DOMParser`. Reject any part containing `<!DOCTYPE`.
2. Detect tracked changes, comments, hidden text, dark highlights, hidden sheets/rows/cols and docProps.
3. Clean: blank the personal fields in docProps, then remove the comments parts and their relationships.

**Verify:**
- `samples/tracked-changes.docx` → tracked-change findings.
- `samples/hidden-sheet.xlsx` → hidden-sheet finding.
- The cleaned file opens without errors (`unzip -t` passes) and has no comments part.

---

## F14. Extension: intercept, card, router, offscreen (`apps/extension`)
**Goal:** the hero flow.
**Steps:**
1. **Content script:**
   - Capture-phase `change` and `drop` listeners on `document`. Skip files in the `approved` WeakSet.
   - Hold the file and clear the input.
   - Collect context: hostname, title and the upload field's label only.
   - Base64-encode the file and message the background.
   - Show the card in a closed shadow root.
2. **Background:** validate the sender, check the payload with zod, ensure the offscreen document exists, and forward. Keep pending uploads per tab with a TTL.
3. **Offscreen:** hosts the core worker (Comlink), the audit adapter, and the AI transport when enabled.
4. **Card:**
   - Shows the verdict, counts and the actions (Upload safe version / Upload anyway / Trust site / Review details).
   - "Review details" opens the side panel (S1).
5. **Drops:** block, with a message to use the file picker.

**Verify:** on `demo-sites/job-portal`, picking the bank statement shows a Block card with real findings. The demo page's own `change` handler did not fire; check its console counter.
**Pitfalls:** manifest changes require asking first. Never test on real sites with real documents.

---

## F15. Safe swap, modes, override, trust
**Goal:** finish the actions.
**Steps:**
1. **Safe version:** redact; if verification passes, build a new `File` with the original name and type, add it to `approved`, set it via `DataTransfer`, and dispatch `input` and `change` with bubbling.
2. **Upload anyway:** a reason is required, then an audit row, then the original is re-attached.
3. **Trust site:** saved to `storage.local`, plus an audit row.
4. **Auto-clean mode:** per HLD §3.10. Verify fails, Office files and drops all mean block; never upload the original silently.

**Verify:**
- The demo portal shows "uploaded: <name>". The received file, run through `pdftotext`, has no account number.
- The override row exists in the audit log.
- In Auto-clean, a GPS photo gets a toast and its EXIF is gone.

---

## F16. Web Lab (`apps/weblab`) and shared UI (`packages/ui`)
**Goal:** a static site with the full Scan → Redact → Verify → Download flow, plus Audit and Settings.
**Steps:**
1. Run the core in a Web Worker via Comlink.
2. **X-Ray:** a PDF.js render plus red rectangles for hidden findings.
3. **GPS map:** coarse by default, exact only on click.
4. **AI toggle:** the key lives in sessionStorage unless the user chooses "remember"; add the "What was sent" viewer.
5. **CSP and headers:** set them through the host's config file (HLD §3.11).
6. **Offline:** a service worker caches the WASM and traineddata.
7. Bundle the same app as the extension's `lab.html`.

**Verify:**
- DevTools Network shows 0 requests during a scan with AI off.
- The CSP header is present on the deployed site.
- With Wi-Fi off, the Lab still works after the first load.

---

## F17. Demo sites and samples
**Demo sites:**
- **`demo-sites/job-portal`:** a "Upload documents" file input, plus a drop zone that logs received files.
- **`demo-sites/bank-kyc`:** an "Upload Aadhaar" input.

**Samples:** generator scripts produce fake-data files, each with an `*.expected.json`:
- a bank statement with fake black boxes
- a PDF with an incremental edit
- an Aadhaar mock PNG
- a GPS-tagged JPEG, plus a rotated one
- a scanned PDF
- a DOCX with tracked changes
- an XLSX with a hidden sheet
- a prompt-injection PDF

**Pitfalls:** fake data only. Changing an expected JSON requires asking first.
