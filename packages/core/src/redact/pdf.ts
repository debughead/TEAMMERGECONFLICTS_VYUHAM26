// Secure PDF redaction (docs/HLD.md §3.6): true removal under the selected rects, then strip
// everything that can carry hidden data, then a full rewrite (no incremental save).
import * as mupdf from "mupdf";
import type { Rect, Watermark } from "../schemas.ts";
import { stampWatermark } from "../watermark.ts";

/** Grow each rect slightly so glyph edges and anti-aliasing are removed too. */
const PAD = 0.75;

/** Catalog entries that can carry hidden content or auto-run behaviour. */
const ROOT_KEYS_TO_DROP = ["Names", "OpenAction", "AA", "AcroForm", "Metadata", "Outlines", "PieceInfo", "StructTreeRoot", "MarkInfo", "SpiderInfo", "Threads"];
const PAGE_KEYS_TO_DROP = ["Annots", "AA", "Metadata", "PieceInfo", "B", "Thumb"];

/** Shorter strings match too much unrelated text to remove "every copy" safely. */
const MIN_SEARCH_LENGTH = 6;

export interface PdfRedaction {
  bytes: Uint8Array<ArrayBuffer>;
  /** Every area removed, including other copies found by search; verify() checks all of them. */
  rectsByPage: Map<number, Rect[]>;
}

/**
 * Removes the given areas and, for each value in `everyCopyOf`, every other place it appears in the
 * text layer, so a value chosen for removal can't survive elsewhere in the file.
 */
export function redactPdf(bytes: Uint8Array, rectsByPage: Map<number, Rect[]>, watermark: Watermark | null = null, everyCopyOf: string[] = []): PdfRedaction {
  const doc = new mupdf.PDFDocument(bytes);
  // Before redaction, so watermark glyphs crossing a redacted area are removed with it.
  if (watermark) stampWatermark(doc, watermark);
  const needles = [...new Set(everyCopyOf.flatMap((v) => v.split("\n")).map((v) => v.trim()).filter((v) => v.length >= MIN_SEARCH_LENGTH))];
  const removed = new Map<number, Rect[]>();
  for (let i = 0; i < doc.countPages(); i++) {
    const page = doc.loadPage(i);
    const rects = [...(rectsByPage.get(i) ?? [])];
    for (const needle of needles) {
      for (const hit of page.search(needle, undefined)) rects.push(quadsBounds(hit));
    }
    removed.set(i, rects);
    for (const r of rects) {
      page.createAnnotation("Redact").setRect([r[0] - PAD, r[1] - PAD, r[2] + PAD, r[3] + PAD]);
    }
    // Pre-existing Redact annotations were meant to be applied; applying them here is the fix.
    if (rects.length > 0 || page.getAnnotations().some((a) => a.getType() === "Redact")) {
      page.applyRedactions(true, mupdf.PDFPage.REDACT_IMAGE_PIXELS, mupdf.PDFPage.REDACT_LINE_ART_NONE, mupdf.PDFPage.REDACT_TEXT_REMOVE);
    }
    const obj = page.getObject();
    for (const k of PAGE_KEYS_TO_DROP) obj.delete(k);
  }
  const trailer = doc.getTrailer();
  const root = trailer.get("Root");
  for (const k of ROOT_KEYS_TO_DROP) root.delete(k);
  trailer.delete("Info");
  // Copy into a plain ArrayBuffer-backed array: detached from WASM memory and transferable.
  return { bytes: new Uint8Array(doc.saveToBuffer("garbage=4,compress,clean,sanitize").asUint8Array()), rectsByPage: removed };
}

function quadsBounds(quads: mupdf.Quad[]): Rect {
  const xs = quads.flatMap((q) => [q[0], q[2], q[4], q[6]]);
  const ys = quads.flatMap((q) => [q[1], q[3], q[5], q[7]]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}
