// PDF scan: Layer 1 (forensic, metadata, revisions) + Layer 2 (IDs) + local NER, plus OCR for
// scanned pages when an OCR engine is supplied.
import * as mupdf from "mupdf";
import { HIDDEN_SOURCE, HIDDEN_TEXT, hiddenRuns, hiddenChars } from "../detect/forensic.ts";
import { findIds, maskForDisplay } from "../detect/patterns.ts";
import { extractPdf, openPdf, type PdfExtract, type PdfPage } from "../extract/pdf.ts";
import { embeddedImageMetadata } from "../extract/pdfImages.ts";
import { largestImage } from "../extract/pdfFills.ts";
import { earlierRevisions, removedText } from "../extract/pdfRevisions.ts";
import { layerFromOcrWords, rectsForRange, type TextLayer } from "../extract/textLayer.ts";
import type { OcrEngine } from "../ocr/engine.ts";
import { recognizeBest } from "../ocr/preprocess.ts";
import type { GpsSummary, Rect } from "../schemas.ts";
import { coarseCoord, collectImageForensics, collectTextFindings, FindingCollector, LABEL, REASON_TEXT } from "./findings.ts";

export interface PdfScanOutput {
  collector: FindingCollector;
  /** Text layers (PDF text and OCR) for the optional AI pass. Worker-internal. */
  layers: TextLayer[];
  pageCount: number;
  warnings: string[];
  ocr: { pagesDone: number; pagesTotal: number };
  /** From the first embedded photo with GPS tags, rounded for the map. */
  gps: GpsSummary | null;
}

/** 300 dpi: Tesseract's preferred resolution. */
export const OCR_SCALE = 300 / 72;

export async function scanPdf(bytes: Uint8Array, ocr: { engine: OcrEngine | null; pageCap: number }): Promise<PdfScanOutput> {
  const doc = openPdf(bytes);
  const ex = extractPdf(doc);
  const out = new FindingCollector();
  const layers: TextLayer[] = [];
  const warnings: string[] = [];
  const scanned = ex.pages.filter((p) => p.isScanned);
  let ocrDone = 0;

  for (const page of ex.pages) {
    // Text the visible-page pass can't see: off the page, in switched-off layers, in forms and comments.
    scanPageStructures(page, out, layers);
    if (page.isScanned) {
      // Analyse the embedded photo at its own pixels (rendering the page would resample and blur
      // bar edges and QR modules), then map results onto the page.
      const { pix, toPage } = scannedPageImage(doc, page.index);
      let ocrText = "";
      if (ocr.engine && ocrDone < ocr.pageCap) {
        const layer = await ocrPage(pix, page.index, ocr.engine, out, toPage);
        layers.push(layer);
        ocrText = layer.text;
        ocrDone++;
      } else {
        warnings.push(`Page ${page.index + 1} is a scanned image and wasn't read with OCR${ocr.engine ? " (page limit reached)" : ""}`);
      }
      const bars = collectImageForensics(
        { pixels: pix.getPixels(), width: pix.getWidth(), height: pix.getHeight(), stride: pix.getStride(), channels: pix.getNumberOfComponents() },
        ocrText, page.index, toPage, out,
      );
      if (bars.barsChecked) warnings.push(`Page ${page.index + 1}: ${bars.barsChecked} black redaction bar(s) checked, ${bars.barsSound} fully cover what's under them`);
      continue;
    }
    scanPageText(page, out);
    layers.push(page);
  }
  scanDocumentLevel(ex, out);
  scanRevisions(bytes, ex, out);
  const gps = await scanEmbeddedImages(doc, out);
  if (ex.hiddenLayerCount) warnings.push(`${ex.hiddenLayerCount} layer(s) are switched off in this PDF; their text was checked too`);

  return {
    collector: out, layers, pageCount: ex.pages.length, warnings,
    ocr: { pagesDone: ocrDone, pagesTotal: scanned.length },
    gps,
  };
}

const STRUCTURE_REASON = {
  off_page: "Text is placed outside the visible page: no viewer shows it, but it can be copied or extracted",
  hidden_layer: "Text is in a layer that is switched off: viewers hide it, but anyone can switch the layer on",
} as const;

function scanPageStructures(page: PdfPage, out: FindingCollector, layers: TextLayer[]): void {
  for (const [kind, layer] of [["off_page", page.offPage], ["hidden_layer", page.hiddenLayer]] as const) {
    const visibleChars = layer.chars.filter((c) => c.c.trim()).length;
    if (!visibleChars) continue;
    const why = kind === "off_page" ? "is placed outside the visible page, so viewers don't show it, but it can be copied out" : "is in a switched-off layer, so viewers hide it, but anyone can turn the layer on";
    collectTextFindings(layer, out, { baseSource: "hidden_office", reasonText: why });
    // Report the whole stretch too: hidden text matters even when no ID pattern is in it.
    const lines = layer.text.split("\n").map((l) => l.trim()).filter(Boolean);
    out.add({
      type: "hidden_content", source: "hidden_office", page: page.index, rects: rectsForRange(layer, 0, layer.text.length),
      masked: `[${visibleChars} hidden characters]`, reason: STRUCTURE_REASON[kind], confidence: 0.95, redactable: true, detector: "forensic",
    }, lines);
    layers.push(layer);
  }

  if (page.formValues.length) {
    // One line per field so detectors never join two fields. Every character gets the whole field box:
    // where the glyphs land inside the field depends on its alignment, so remove the field's area.
    const layer = boxedLayer(page.formValues.map((f) => ({ text: f.value, rect: f.rect })), page.index);
    collectTextFindings(layer, out, { baseSource: "text", reasonText: "is filled into a form field" });
    layers.push(layer);
  }

  page.comments.forEach((c) => {
    const text = c.contents.replace(/\s+/g, " ").trim();
    if (text) {
      const layer = { ...boxedLayer([{ text, rect: c.rect }], page.index), structural: { removable: true, page: page.index } };
      // Comments aren't drawn as page text; they go when annotations are stripped, so no page areas.
      collectTextFindings(layer, out, { baseSource: "hidden_office", reasonText: "is written in a comment on the page", noRects: true });
      out.add({
        type: "hidden_content", source: "hidden_office", page: page.index, rects: [],
        masked: `Comment (${text.length} characters)`,
        reason: "A comment holds text that isn't part of the page; anyone who opens the comments panel can read it",
        confidence: 0.95, redactable: true, detector: "forensic",
      }, [text]);
      layers.push(layer);
    }
    if (c.author.trim()) {
      out.add({
        type: "metadata", source: "metadata", page: page.index, rects: [], masked: `Comment author: ${maskMeta(c.author)}`,
        reason: "The name of whoever wrote a comment is stored with it", confidence: 1, redactable: true, detector: "metadata",
      }, [c.author]);
    }
  });
}

/** A text layer with one line per item, every character mapped to its item's whole box. */
function boxedLayer(items: { text: string; rect: Rect }[], index: number): TextLayer {
  const layer: TextLayer = { index, text: "", textToChar: [], chars: [] };
  items.forEach((it, k) => {
    if (k > 0) { layer.text += "\n"; layer.textToChar.push(-1); }
    for (const c of it.text.replace(/\s+/g, " ").trim()) {
      layer.chars.push({ c, rect: it.rect });
      for (let u = 0; u < c.length; u++) layer.textToChar.push(layer.chars.length - 1);
      layer.text += c;
    }
  });
  return layer;
}

/** GPS and camera details in embedded photos. Returns the first location for the map. */
async function scanEmbeddedImages(doc: mupdf.PDFDocument, out: FindingCollector): Promise<GpsSummary | null> {
  let gps: GpsSummary | null = null;
  const seenTags = new Set<string>();
  let xmpImages = 0;
  for (const img of await embeddedImageMetadata(doc)) {
    if (img.hasXmpStream) xmpImages++;
    const g = img.meta.gps;
    if (g) {
      gps ??= { coarseLat: coarseCoord(g.lat), coarseLon: coarseCoord(g.lon) };
      out.add({
        type: "gps", source: "metadata", page: null, rects: [],
        masked: `Near ${coarseCoord(g.lat).toFixed(1)}, ${coarseCoord(g.lon).toFixed(1)}`,
        reason: "A photo inside this PDF has GPS tags revealing where it was taken (often someone's home)",
        confidence: 1, redactable: true, detector: "metadata",
      }, []);
    }
    for (const [key, value] of Object.entries(img.meta.tags)) {
      if (seenTags.has(`${key}|${value}`)) continue; // same camera on every photo: report once
      seenTags.add(`${key}|${value}`);
      out.add({
        type: "metadata", source: "metadata", page: null, rects: [], masked: `Photo ${key}: ${maskMeta(value)}`,
        reason: `A photo inside this PDF stores its ${key} in its metadata`, confidence: 1, redactable: true, detector: "metadata",
      }, [value]);
    }
  }
  if (xmpImages) {
    out.add({
      type: "metadata", source: "metadata", page: null, rects: [], masked: `XMP metadata on ${xmpImages} image(s)`,
      reason: "Images in this PDF carry their own XMP packet (author, tools, history)", confidence: 1, redactable: true, detector: "metadata",
    }, []);
  }
  return gps;
}

function scanPageText(page: PdfPage, out: FindingCollector): void {
  const hidden = hiddenChars(page);
  const { claimed } = collectTextFindings(page, out, { baseSource: "text", hidden });

  // Hidden text that isn't a recognised ID or entity is still a leak: report the run itself.
  for (const run of hiddenRuns(page, hidden)) {
    const unclaimed = page.text.slice(run.start, run.end).trim();
    if (!unclaimed || claimed.some(([s, e]) => s <= run.start && run.end <= e)) continue;
    out.add({
      type: "hidden_content", source: HIDDEN_SOURCE[run.reason], page: page.index, rects: rectsForRange(page, run.start, run.end),
      masked: `[${unclaimed.replace(/\s/g, "").length} hidden characters]`, reason: `Text ${HIDDEN_TEXT[run.reason]}`,
      confidence: 0.95, redactable: true, detector: "forensic",
    }, [unclaimed]);
  }
}

/**
 * Pixels for an image-only page: the embedded image at native resolution when it fills the page,
 * otherwise a 300 dpi render. `toPage` maps pixel rects to page points (top-left origin).
 */
export function scannedPageImage(doc: mupdf.PDFDocument, pageIndex: number): { pix: mupdf.Pixmap; toPage: (r: Rect) => Rect } {
  const page = doc.loadPage(pageIndex);
  const img = largestImage(page);
  if (img) return { pix: img.image.toPixmap().convertToColorSpace(mupdf.ColorSpace.DeviceRGB, false), toPage: img.toPage };
  const pix = page.toPixmap(mupdf.Matrix.scale(OCR_SCALE, OCR_SCALE), mupdf.ColorSpace.DeviceRGB, false);
  return { pix, toPage: (r) => r.map((v) => v / OCR_SCALE) as unknown as Rect };
}

async function ocrPage(pix: mupdf.Pixmap, pageIndex: number, engine: OcrEngine, out: FindingCollector, toPage: (r: Rect) => Rect): Promise<TextLayer> {
  const words = await recognizeBest(engine, pix);
  const layer = layerFromOcrWords(words, pageIndex, toPage);
  collectTextFindings(layer, out, { baseSource: "ocr" });
  return layer;
}

function scanDocumentLevel(ex: PdfExtract, out: FindingCollector): void {
  const meta = (masked: string, reason: string, values: string[]) =>
    out.add({ type: "metadata", source: "metadata", page: null, rects: [] as Rect[], masked, reason, confidence: 1, redactable: true, detector: "metadata" }, values);

  for (const [key, value] of Object.entries(ex.info)) meta(`${key}: ${maskMeta(value)}`, `Document ${key} is stored in the file's metadata`, [value]);
  if (ex.hasXmp) meta("XMP metadata packet", "The file carries an XMP metadata packet (author, tools, history)", []);
  if (ex.hasEmbeddedFiles) {
    out.add({ type: "hidden_content", source: "hidden_office", page: null, rects: [], masked: "Embedded file attachment(s)",
      reason: "The PDF carries attached files that viewers don't show by default", confidence: 1, redactable: true, detector: "forensic" }, []);
  }
  if (ex.hasJavaScript) {
    out.add({ type: "hidden_content", source: "hidden_office", page: null, rects: [], masked: "Embedded scripts or auto-actions",
      reason: "The PDF contains JavaScript or automatic actions", confidence: 1, redactable: true, detector: "forensic" }, []);
  }
}

/** Metadata values can be names; show only their shape. */
export function maskMeta(v: string): string {
  if (/^D:\d{8}/.test(v)) return `${v.slice(2, 6)}-${v.slice(6, 8)}-${v.slice(8, 10)}`;
  return v.length <= 2 ? "**" : `${v[0]}***${v[v.length - 1]}`;
}

function scanRevisions(bytes: Uint8Array, ex: PdfExtract, out: FindingCollector): void {
  if (ex.versions < 2) return;
  let removedWords = 0;
  for (const rev of earlierRevisions(bytes, ex.versions)) {
    rev.pages.forEach((oldText, pageIndex) => {
      const removed = removedText(oldText, ex.pages[pageIndex]?.text ?? "");
      if (!removed) return;
      removedWords += removed.split(" ").length;
      for (const m of findIds(removed)) {
        out.add({
          type: m.type, source: "old_version", page: pageIndex, rects: [],
          masked: maskForDisplay(m.type, m.normalized), reason: `${LABEL[m.type]} ${REASON_TEXT.old_version}`,
          confidence: m.confidence, redactable: true, detector: "forensic",
        }, [m.normalized, m.raw]);
      }
    });
  }
  if (removedWords > 0) {
    out.add({
      type: "old_version", source: "old_version", page: null, rects: [],
      masked: `${ex.versions - 1} earlier version(s), ${removedWords} removed word(s) recoverable`,
      reason: "The file was edited with incremental saves; earlier versions with removed content are still inside it",
      confidence: 1, redactable: true, detector: "forensic",
    }, []);
  }
}
