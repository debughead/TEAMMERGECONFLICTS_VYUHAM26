# RedactGuard progress

Claude Code keeps this file current. Humans can edit it too; Claude reads it at the start of every task and on `/status`.

**Last updated:** 2026-10-30 · **Overall:** core complete (165 tests); Web Lab and extension both work end to end in headless Brave; all 6 spikes passed

## Spikes (hours 0–2): must pass before building on them

| # | Spike | Owner | Status | Result / link to decision |
| --- | --- | --- | --- | --- |
| 1 | Side panel opens from the card's click | Extension lead | passed (user-confirmed in Brave) | DECISIONS: Spike S1 passed |
| 2 | MuPDF.js finds filled black shapes in a worker | Core/PDF lead | passed in Node; browser worker check pending | D-011, `test/spikes/mupdf.spike.test.ts` |
| 3 | Tesseract.js runs in the offscreen doc from bundled files | Detection/OCR lead | passed | Spike results (DECISIONS) |
| 4 | Re-attached file isn't re-intercepted (WeakSet) | Extension lead | passed | Spike results (DECISIONS) |
| 5 | EXIF orientation: OCR boxes and paint line up | Detection/OCR lead | passed (solved in core) | D-018 |
| 6 | 15 MB file survives base64 messaging | Extension lead | passed (13.9 MB) | Spike results (DECISIONS) |

## Milestones

- [ ] Hour 2: all spikes passed or fallback chosen
- [ ] Hours 10–14: E2E #1, demo portal → intercept → scan → card shows real findings (AI off)
- [ ] Hour 26: feature freeze
- [ ] Hours 26–30: all samples pass with AI off and on, 3 rehearsals, backup video

## In progress

- (none)

## Done

- 2026-10-30: photo forensics (D-030): bar check (opaque / see-through / too thin), ID card recognition, QR locator (real photo only, see blockers), rotation-aware mapping for image-only PDF pages, stronger verify; 180/183 tests
- 2026-10-30: RedactGuard icon (shield + page + redaction bar): extension icons 16/32/48/128 + toolbar, card and side-panel headers, Web Lab favicon/logo; generator `packages/core/scripts/makeIcons.ts`
- 2026-10-30: real-world PDF fixes (D-028): weak signals → AI-only candidates; remove every copy; metadata vs body text. 168 tests
- 2026-10-30: extension redesign + selectable redaction (D-029): new card and side panel, checkboxes, "Redact selected and upload"; e2e regression green
- 2026-10-30: Chrome extension (`apps/extension`): manifest (storage, sidePanel, offscreen; Anthropic optional), service worker router, offscreen host for the shared engine worker, content-script interception + closed-shadow verdict card + safe swap + override with reason + trust site + drop block, side panel (details + settings). Headless Brave e2e: GPS photo on job portal → cleaned copy received with no EXIF; bank statement on job portal → blocked, nothing received; Aadhaar on bank KYC → allowed; 13.9 MB file → scanned
- 2026-10-30: demo sites (`demo-sites/`: job portal, bank KYC, `pnpm demo` on :8080)
- 2026-10-30: browser self-test (headless Brave, production build with strict CSP): bank statement, incremental PDF, scanned PDF (OCR), Aadhaar image (OCR), rotated GPS photo and DOCX all scan, redact and verify; 0 raw values in results; 0 external requests; 16 ms to 1.4 s per file
- 2026-10-30: Web Lab app (worker + Comlink client, IndexedDB audit in the worker, Drop/Scan/Review/Redact/Verify/Download, X-Ray, GPS map, AI toggle + payload viewer, audit view); `pnpm --filter weblab build` succeeds; browser self-test harness (`selftest.html`, opt-in build with `RG_SELFTEST=1`)
- 2026-10-30: `redact()` can write per-item audit rows (keyed HMAC only) + a verify row; 1 test
- 2026-10-30: F9 `policy.ts` (rule expectations, trusted sites, hidden-data floor, block rule D-020), 11 tests
- 2026-10-30: F11 `audit/chain.ts` (hash chain, non-extractable HMAC key, serialized appends, tamper detection), 7 tests
- 2026-10-30: purpose watermark (`watermark.ts`, stamped before redaction, D-020), 3 tests + visual check
- 2026-10-30: F12 AI (`ai/schema.ts`, `minimise.ts`, `prompt.ts`, `run.ts`): Claude Opus 5.5 (D-019), masked line selection, structured output, add-only, payload viewer (`getAiPayload`), 10 tests with a fake client
- 2026-10-30: F7 local NER (`detect/localNer.ts`: labelled and lexicon names, Indian address blocks, salary, medical) + identity-kit combination rule
- 2026-10-30: shared text-layer pipeline (`extract/textLayer.ts`, `pipeline/findings.ts`) used by PDF text, scanned-PDF OCR and image OCR
- 2026-10-30: OCR (`ocr/engine.ts`, injected; D-016); scanned PDFs OCR'd and redacted through image pixels
- 2026-10-30: images: EXIF/GPS/camera metadata (`extract/image.ts`), upright decode (D-018), pixel redaction + re-encode (`redact/image.ts`), image verify
- 2026-10-30: F13 Office: DOCX tracked deletions/hidden text/black highlight/comments, XLSX hidden sheets/rows/columns/comments, metadata; clean = metadata + comments (`redact/officeMeta.ts`, D-017)
- 2026-10-30: 5 new samples (scanned KYC PDF, dark image over text, prompt injection, DOCX, XLSX); golden suite covers all 10 samples with pdftotext/pdfinfo/exiftool/tesseract/unzip cross-checks
- 2026-10-30: PDF scan pipeline: `extract/pdf.ts`, `extract/pdfFills.ts` (paint-order draws), `detect/forensic.ts` (box over text, black-on-black, unapplied/dark annots), `extract/pdfRevisions.ts`, labelled account numbers, `score.ts`, `session.ts`
- 2026-10-30: `redact/pdf.ts` + `verify.ts` (all six checks; bytes withheld on failure); `scan()`/`redact()` in `index.ts`
- 2026-10-30: golden tests on both PDF samples incl. pdftotext/pdfinfo cross-check; `verify` shown to fail on unredacted input. Totals: 65 passed, 3 todo
- 2026-10-30: pnpm monorepo scaffold (core with Vitest/TS strict; ui, weblab and extension placeholders)
- 2026-10-30: `schemas.ts` shared contract (strictObject everywhere)
- 2026-10-30: `filetype.ts` sniffing and limits (zip bomb, pixel bomb, page limit, encrypted PDF), 12 tests
- 2026-10-30: `detect/validators.ts` + `detect/patterns.ts` (Verhoeff, Luhn, PAN, IFSC, UPI, phone, email, vehicle, OCR slack, display masking), 21 tests
- 2026-10-30: sample generator (`pnpm samples`): 5 self-checked fake samples, cross-checked with pdftotext/exiftool/tesseract
- 2026-10-30: project docs and Claude setup: CLAUDE.md, .claude/ rules and skills, docs/HLD.md, docs/GUIDE.md, DECISIONS D-001 to D-010, README, .gitignore

## Next up

1. Manual click-through in a visible browser: card buttons (safe version, upload anyway, trust site), side panel from the card (S1), Web Lab X-Ray and map
2. Decide whether to add `connect-src 'self' https://api.anthropic.com` to the extension CSP (needs approval)
3. Pitch polish: demo script rehearsal, backup video
3. Spikes 1, 3, 4, 5, 6 need the extension/browser (Phase 3)

## Blockers / waiting on a human
- **OCR on unredacted ID-card photos (D-032), 2026-10-30.** The fixes (D-031 cover 15%, D-032 local threshold) make the user's PAN photo come out as "PAN card" (high, warn), but the PAN number, name and date of birth are not extracted. Two attempts made. Options for the user: (A) add a sparse-text Tesseract pass (`psm 11`, needs the tesseract.js parameter API verified first); (B) when an ID card is recognised but no ID number is read, raise it to critical and pre-select the whole card area for removal.
- **`samples/bank-statement-fake-redaction.pdf` was renamed to `weak-redaction.pdf`** (by the user, 21:40). The golden, ai, audit and watermark tests load the old name, so 4 tests fail until the name is restored or the tests are updated.

- 2026-10-30: hand-written QR locator (`detect/imageForensics.ts` `findQrCodes`) finds the QR on the user's real PAN photo but fails on synthetic QR images (3 tests in `test/imageForensics.test.ts`). Tried: (1) merge overlapping candidates + trim to dense texture, (2) standard finder tolerance (broke the real photo, reverted). Stopped per the two-attempt rule. Options: add jsQR (proper locator + decoder, previously declined) or keep iterating on the hand-written locator.

## Open questions

- App dependencies (react, vite, pdfjs-dist, idb, leaflet, tailwind, @crxjs) are approved but not installed yet; they get installed in Phase 3
- Team should review `schemas.ts` before it is treated as frozen
