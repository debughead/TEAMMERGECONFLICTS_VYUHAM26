// Proof of removal (docs/HLD.md §3.7). Always re-opens the output bytes as a fresh document;
// never reuses objects from the redaction step (rules/core.md).
import * as mupdf from "mupdf";
import { hiddenChars } from "./detect/forensic.ts";
import { lumPlane, pixelLeaks } from "./detect/imageForensics.ts";
import { findIds } from "./detect/patterns.ts";
import { decodeUpright, readImageMeta } from "./extract/image.ts";
import { extractDocx, extractXlsx, openZip } from "./extract/office.ts";
import { extractPdf, openPdf } from "./extract/pdf.ts";
import { embeddedImageMetadata } from "./extract/pdfImages.ts";
import type { OcrWord } from "./extract/textLayer.ts";
import type { OcrEngine } from "./ocr/engine.ts";
import { recognizeBest } from "./ocr/preprocess.ts";
import { normalizeForCompare } from "./pipeline/findings.ts";
import { OCR_SCALE, scannedPageImage } from "./pipeline/scanPdf.ts";
import { regionIsBlack } from "./redact/image.ts";
import type { FileType, Rect, VerifyCheck, VerifyReport } from "./schemas.ts";
import { center, containsPoint } from "./util/geom.ts";
import { sha256Hex } from "./util/hash.ts";

export interface VerifyExpectations {
  /** Rects that were redacted, by page index (images use page 0, pixel space). */
  redactedRects: Map<number, Rect[]>;
  /** Normalized raw values that must no longer be extractable. Worker-internal only. */
  removedValues: string[];
}

/**
 * OCR words inside redacted regions, ignoring regions whose pixels are proven solid black: OCR reads
 * noise (e.g. "a") off a black box, but a solid black region cannot contain readable text.
 */
function wordsInUnclearedRegions(pix: mupdf.Pixmap, rects: Rect[], words: OcrWord[]): number {
  const uncleared = rects.filter((r) => !regionIsBlack(pix, r));
  return words.filter((w) => uncleared.some((r) => containsPoint(r, center(w.bbox)))).length;
}

const overlaps = (a: Rect, b: Rect) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];

const NA = (name: VerifyCheck["name"], why: string): VerifyCheck => ({ name, passed: true, detail: `Not applicable: ${why}` });

/** Counts removed values still present in `text`, matching both the flat text and re-detected IDs. */
function remainingValues(text: string, removed: string[]): number {
  const flat = normalizeForCompare(text);
  const ids = new Set(findIds(text, { ocr: true }).map((m) => normalizeForCompare(m.normalized)));
  return removed.filter((v) => flat.includes(v) || ids.has(v)).length;
}

const ocrText = (words: OcrWord[]) => {
  let line = -1;
  return words.map((w) => { const sep = line === -1 ? "" : w.line === line ? " " : "\n"; line = w.line; return sep + w.text; }).join("");
};

export async function verifyPdf(output: Uint8Array, exp: VerifyExpectations, ocr: OcrEngine | null = null): Promise<VerifyReport> {
  const doc = openPdf(output);
  const ex = extractPdf(doc);

  let inRedacted = 0;
  let stillHidden = 0;
  // Everything extractable counts, not just what a viewer shows: off-page and hidden-layer text,
  // form values and comment text are all places a removed value could survive.
  let allText = ex.pages.flatMap((p) => [
    p.text, p.offPage.text, p.hiddenLayer.text, ...p.formValues.map((f) => f.value), ...p.comments.map((c) => c.contents),
  ]).join("\n");
  const visible = (t: { chars: { c: string }[] }) => t.chars.filter((c) => c.c.trim()).length;
  const offPageChars = ex.pages.reduce((n, p) => n + visible(p.offPage), 0);
  const hiddenLayerChars = ex.pages.reduce((n, p) => n + visible(p.hiddenLayer), 0);
  const formFields = ex.pages.reduce((n, p) => n + p.formValues.length, 0);
  let ocrPages = 0;
  let pixelLeakCount = 0;
  const pixelLeakDetail: string[] = [];
  for (const page of ex.pages) {
    const rects = exp.redactedRects.get(page.index) ?? [];
    for (const ch of page.chars) {
      if (ch.c.trim() && rects.some((r) => containsPoint(r, center(ch.rect)))) inRedacted++;
    }
    stillHidden += hiddenChars(page).filter((h) => h !== null).length;
    if (page.isScanned) {
      // The pixels themselves must not still show a QR code or a leaking bar (D-030).
      // Only areas the user chose to remove must be clean; a QR code they kept is their choice.
      const { pix: img, toPage } = scannedPageImage(doc, page.index);
      const leaks = pixelLeaks(lumPlane(img.getPixels(), img.getWidth(), img.getHeight(), img.getStride(), img.getNumberOfComponents()))
        .map(toPage).filter((l) => rects.some((r) => overlaps(l, r)));
      pixelLeakCount += leaks.length;
      if (leaks.length) pixelLeakDetail.push(`page ${page.index + 1}: ${leaks.length} QR code(s) or leaking bar(s) still visible where removal was requested`);
    }
    if (page.isScanned && ocr) {
      const pix = doc.loadPage(page.index).toPixmap(mupdf.Matrix.scale(OCR_SCALE, OCR_SCALE), mupdf.ColorSpace.DeviceGray, false);
      const words = await recognizeBest(ocr, pix);
      inRedacted += wordsInUnclearedRegions(pix, rects.map((r) => r.map((v) => v * OCR_SCALE) as Rect), words);
      allText += "\n" + ocrText(words);
      ocrPages++;
    }
  }
  stillHidden += offPageChars + hiddenLayerChars;
  const remaining = remainingValues(allText, exp.removedValues);
  const annotCount = ex.pages.reduce((s, p) => s + p.annots.length, 0);
  const metaKeys = Object.keys(ex.info);
  const scannedUnread = ex.pages.filter((p) => p.isScanned).length - ocrPages;
  const imageMeta = await embeddedImageMetadata(doc);
  const imagesWithGps = imageMeta.filter((m) => m.meta.gps).length;

  const checks: VerifyCheck[] = [
    {
      name: "no_text_in_redacted_areas",
      passed: inRedacted === 0 && stillHidden === 0 && pixelLeakCount === 0 && ex.hiddenLayerCount === 0,
      detail: `${inRedacted} character(s)/word(s) inside redacted areas; ${stillHidden} character(s) still hidden` +
        (offPageChars || hiddenLayerChars ? ` (${offPageChars} off the page, ${hiddenLayerChars} in switched-off layers)` : "") +
        (ex.hiddenLayerCount ? `; ${ex.hiddenLayerCount} layer(s) still switched off` : "") +
        (pixelLeakDetail.length ? `; ${pixelLeakDetail.join("; ")}` : "") +
        (scannedUnread > 0 ? `; ${scannedUnread} scanned page(s) not re-read (OCR off)` : ""),
    },
    { name: "no_removed_values_remain", passed: remaining === 0, detail: `${remaining} of ${exp.removedValues.length} removed value(s) still extractable` },
    {
      name: "metadata_empty",
      passed: metaKeys.length === 0 && !ex.hasXmp,
      detail: metaKeys.length || ex.hasXmp ? `Remaining: ${[...metaKeys, ...(ex.hasXmp ? ["XMP"] : [])].join(", ")}` : "No document metadata",
    },
    { name: "single_revision", passed: ex.versions === 1, detail: `${ex.versions} revision(s) in the file` },
    {
      name: "no_annots_embeds_js",
      passed: annotCount === 0 && formFields === 0 && !ex.hasEmbeddedFiles && !ex.hasJavaScript,
      detail: `${annotCount} annotation(s); ${formFields} form field value(s); embedded files: ${ex.hasEmbeddedFiles ? "yes" : "no"}; scripts/actions: ${ex.hasJavaScript ? "yes" : "no"}`,
    },
    {
      name: "no_image_metadata",
      passed: imageMeta.length === 0,
      detail: imageMeta.length
        ? `${imageMeta.length} embedded image(s) still carry metadata${imagesWithGps ? `, ${imagesWithGps} with GPS` : ""}`
        : "No EXIF/XMP/IPTC tags or GPS in embedded images",
    },
  ];
  return report(checks, inRedacted + stillHidden + remaining + pixelLeakCount + imageMeta.length, output);
}

export async function verifyImage(output: Uint8Array, exp: VerifyExpectations, ocr: OcrEngine | null = null): Promise<VerifyReport> {
  const meta = await readImageMeta(output);
  const rects = exp.redactedRects.get(0) ?? [];
  // Output is written upright without EXIF, so orientation 1 is correct; meta.orientation would be 1 too.
  const pix = decodeUpright(output, 1);
  const black = rects.every((r) => regionIsBlack(pix, r));
  // Areas the user chose to remove must not still show a QR code or a leaking bar (D-030).
  const leaks = pixelLeaks(lumPlane(pix.getPixels(), pix.getWidth(), pix.getHeight(), pix.getStride(), pix.getNumberOfComponents()))
    .filter((l) => rects.some((r) => overlaps(l, r)));

  let wordsInRects = 0;
  let remaining = 0;
  if (ocr) {
    const words = await recognizeBest(ocr, pix);
    wordsInRects = wordsInUnclearedRegions(pix, rects, words);
    remaining = remainingValues(ocrText(words), exp.removedValues);
  }
  const tagKeys = Object.keys(meta.tags);
  const metaClean = tagKeys.length === 0 && meta.gps === null;

  const checks: VerifyCheck[] = [
    {
      name: "no_text_in_redacted_areas",
      passed: black && wordsInRects === 0 && leaks.length === 0,
      detail: `Redacted regions ${black ? "are solid black" : "still contain image content"}; ${ocr ? `${wordsInRects} word(s) read inside them` : "OCR re-read skipped (OCR off)"}; ${leaks.length} QR code(s) or leaking bar(s) still visible where removal was requested`,
    },
    {
      name: "no_removed_values_remain",
      passed: remaining === 0,
      detail: ocr ? `${remaining} of ${exp.removedValues.length} removed value(s) still readable` : "Checked by pixels only (OCR off)",
    },
    { name: "metadata_empty", passed: metaClean, detail: metaClean ? "No metadata" : `Remaining: ${[...tagKeys, ...(meta.gps ? ["GPS"] : [])].join(", ")}` },
    NA("single_revision", "image output"),
    NA("no_annots_embeds_js", "image output"),
    { name: "no_image_metadata", passed: metaClean, detail: metaClean ? "No EXIF/XMP/IPTC tags or GPS" : "Image metadata remains" },
  ];
  return report(checks, (black ? 0 : 1) + wordsInRects + remaining + (metaClean ? 0 : 1) + leaks.length, output);
}

export async function verifyOffice(output: Uint8Array, fileType: Extract<FileType, "docx" | "xlsx">, exp: VerifyExpectations): Promise<VerifyReport> {
  const zip = await openZip(output);
  const ex = fileType === "docx" ? await extractDocx(zip) : await extractXlsx(zip);
  const allText = [...ex.segments.map((s) => s.text), ...Object.values(ex.meta)].join("\n");
  const remaining = remainingValues(allText, exp.removedValues);
  const comments = ex.segments.filter((s) => s.kind === "comment").length;
  const macros = Object.keys(zip.files).some((n) => /vbaProject\.bin$/i.test(n));
  const metaKeys = Object.keys(ex.meta);
  const checks: VerifyCheck[] = [
    NA("no_text_in_redacted_areas", "Word/Excel text is not redacted in place (export to PDF)"),
    { name: "no_removed_values_remain", passed: remaining === 0, detail: `${remaining} of ${exp.removedValues.length} removed value(s) still present` },
    { name: "metadata_empty", passed: metaKeys.length === 0, detail: metaKeys.length ? `Remaining: ${metaKeys.join(", ")}` : "No document properties" },
    NA("single_revision", "Office file"),
    { name: "no_annots_embeds_js", passed: comments === 0 && !macros, detail: `${comments} comment part(s); macros: ${macros ? "yes" : "no"}` },
    NA("no_image_metadata", "Office file"),
  ];
  return report(checks, remaining + comments, output);
}

async function report(checks: VerifyCheck[], recoverable: number, output: Uint8Array): Promise<VerifyReport> {
  return { passed: checks.every((c) => c.passed), recoverableItems: recoverable, checks, outputSha256: await sha256Hex(output) };
}
