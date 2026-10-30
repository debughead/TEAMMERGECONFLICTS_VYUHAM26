// Secure PDF redaction (docs/HLD.md §3.6): true removal under the selected rects, then strip
// everything that can carry hidden data, then a full rewrite (no incremental save).
import * as mupdf from "mupdf";
import { forEachImageStream, isPlainJpeg } from "../extract/pdfImages.ts";
import type { Rect, Watermark } from "../schemas.ts";
import { stampWatermark } from "../watermark.ts";
import { stripJpegMetadata } from "./jpegMeta.ts";

/** Grow each rect slightly so glyph edges and anti-aliasing are removed too. */
const PAD = 0.75;

/** Catalog entries that can carry hidden content or auto-run behaviour. */
const ROOT_KEYS_TO_DROP = [
  "Names", "OpenAction", "AA", "AcroForm", "Metadata", "Outlines", "PieceInfo", "StructTreeRoot", "MarkInfo", "SpiderInfo", "Threads",
  // Layer settings: without them every layer shows, so content that was switched off and not removed
  // becomes visible instead of staying hidden in the file.
  "OCProperties",
];
/** Keys that carry private data on any object: XMP packets (images, forms) and app-private data (Illustrator keeps whole drafts here). */
const ANY_OBJECT_KEYS_TO_DROP = ["Metadata", "PieceInfo"];
/** Far outside any page; used to cover everything beyond the page box. */
const FAR = 1e5;
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
  // Form values become ordinary page content, so the selected ones are removed by area like any text
  // and the rest stay visible (the form itself is dropped below).
  if (!doc.getTrailer().get("Root").get("AcroForm").isNull()) doc.bake(false, true);
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
    // Text outside the page box is never shown to anyone, so it is never legitimate: always remove it.
    if (hasOffPageText(page)) rects.push(...outsideOf(page.getBounds()));
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
  scrubObjects(doc);
  // Copy into a plain ArrayBuffer-backed array: detached from WASM memory and transferable.
  return { bytes: new Uint8Array(doc.saveToBuffer("garbage=4,compress,clean,sanitize").asUint8Array()), rectsByPage: removed };
}

function quadsBounds(quads: mupdf.Quad[]): Rect {
  const xs = quads.flatMap((q) => [q[0], q[2], q[4], q[6]]);
  const ys = quads.flatMap((q) => [q[1], q[3], q[5], q[7]]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function hasOffPageText(page: mupdf.PDFPage): boolean {
  const b = page.getBounds();
  let found = false;
  page.toStructuredText("clip=no").walk({
    onChar(_c, _o, _f, _s, quad) {
      const cx = (quad[0] + quad[6]) / 2, cy = (quad[1] + quad[7]) / 2;
      if (cx < b[0] || cx > b[2] || cy < b[1] || cy > b[3]) found = true;
    },
  });
  return found;
}

/** Four rects that together cover everything outside `b`. */
function outsideOf(b: Rect): Rect[] {
  return [
    [-FAR, -FAR, b[0], FAR], [b[2], -FAR, FAR, FAR],
    [b[0], -FAR, b[2], b[1]], [b[0], b[3], b[2], FAR],
  ];
}

/** Removes per-object private data everywhere, and camera metadata from embedded JPEGs (losslessly). */
function scrubObjects(doc: mupdf.PDFDocument): void {
  const n = doc.countObjects();
  for (let num = 1; num < n; num++) {
    const obj = doc.newIndirect(num).resolve();
    if (obj.isDictionary()) for (const k of ANY_OBJECT_KEYS_TO_DROP) obj.delete(k);
  }
  forEachImageStream(doc, (ref) => {
    if (!isPlainJpeg(ref)) return;
    const raw = ref.readRawStream().asUint8Array();
    const clean = stripJpegMetadata(raw);
    // Unparseable JPEGs are left alone; verify() re-reads every image and refuses release if metadata remains.
    if (clean && clean.length !== raw.length) ref.writeRawStream(clean);
  });
}
