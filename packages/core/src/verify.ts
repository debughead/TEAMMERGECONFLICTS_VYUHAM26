// Proof of removal (docs/HLD.md §3.7). Always re-opens the output bytes as a fresh document;
// never reuses objects from the redaction step (rules/core.md).
import * as mupdf from "mupdf";
import { hiddenChars } from "./detect/forensic.ts";
import { findIds } from "./detect/patterns.ts";
import { decodeUpright, readImageMeta } from "./extract/image.ts";
import { extractDocx, extractXlsx, openZip } from "./extract/office.ts";
import { extractPdf, openPdf } from "./extract/pdf.ts";
import type { OcrWord } from "./extract/textLayer.ts";
import type { OcrEngine } from "./ocr/engine.ts";
import { normalizeForCompare } from "./pipeline/findings.ts";
import { OCR_SCALE } from "./pipeline/scanPdf.ts";
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
  let allText = ex.pages.map((p) => p.text).join("\n");
  let ocrPages = 0;
  for (const page of ex.pages) {
    const rects = exp.redactedRects.get(page.index) ?? [];
    for (const ch of page.chars) {
      if (ch.c.trim() && rects.some((r) => containsPoint(r, center(ch.rect)))) inRedacted++;
    }
    stillHidden += hiddenChars(page).filter((h) => h !== null).length;
    if (page.isScanned && ocr) {
      const pix = doc.loadPage(page.index).toPixmap(mupdf.Matrix.scale(OCR_SCALE, OCR_SCALE), mupdf.ColorSpace.DeviceGray, false);
      const words = await ocr.recognize(pix.asPNG());
      inRedacted += wordsInUnclearedRegions(pix, rects.map((r) => r.map((v) => v * OCR_SCALE) as Rect), words);
      allText += "\n" + ocrText(words);
      ocrPages++;
    }
  }
  const remaining = remainingValues(allText, exp.removedValues);
  const annotCount = ex.pages.reduce((s, p) => s + p.annots.length, 0);
  const metaKeys = Object.keys(ex.info);
  const scannedUnread = ex.pages.filter((p) => p.isScanned).length - ocrPages;

  const checks: VerifyCheck[] = [
    {
      name: "no_text_in_redacted_areas",
      passed: inRedacted === 0 && stillHidden === 0,
      detail: `${inRedacted} character(s)/word(s) inside redacted areas; ${stillHidden} character(s) still hidden under boxes` +
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
      passed: annotCount === 0 && !ex.hasEmbeddedFiles && !ex.hasJavaScript,
      detail: `${annotCount} annotation(s); embedded files: ${ex.hasEmbeddedFiles ? "yes" : "no"}; scripts/actions: ${ex.hasJavaScript ? "yes" : "no"}`,
    },
    NA("no_image_metadata", "PDF output"),
  ];
  return report(checks, inRedacted + stillHidden + remaining, output);
}

export async function verifyImage(output: Uint8Array, exp: VerifyExpectations, ocr: OcrEngine | null = null): Promise<VerifyReport> {
  const meta = await readImageMeta(output);
  const rects = exp.redactedRects.get(0) ?? [];
  // Output is written upright without EXIF, so orientation 1 is correct; meta.orientation would be 1 too.
  const pix = decodeUpright(output, 1);
  const black = rects.every((r) => regionIsBlack(pix, r));

  let wordsInRects = 0;
  let remaining = 0;
  if (ocr) {
    const words = await ocr.recognize(pix.asPNG());
    wordsInRects = wordsInUnclearedRegions(pix, rects, words);
    remaining = remainingValues(ocrText(words), exp.removedValues);
  }
  const tagKeys = Object.keys(meta.tags);
  const metaClean = tagKeys.length === 0 && meta.gps === null;

  const checks: VerifyCheck[] = [
    {
      name: "no_text_in_redacted_areas",
      passed: black && wordsInRects === 0,
      detail: `Redacted regions ${black ? "are solid black" : "still contain image content"}; ${ocr ? `${wordsInRects} word(s) read inside them` : "OCR re-read skipped (OCR off)"}`,
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
  return report(checks, (black ? 0 : 1) + wordsInRects + remaining + (metaClean ? 0 : 1), output);
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
