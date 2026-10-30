// PDF scan: Layer 1 (forensic, metadata, revisions) + Layer 2 (IDs) + local NER, plus OCR for
// scanned pages when an OCR engine is supplied.
import * as mupdf from "mupdf";
import { hiddenRuns, hiddenChars } from "../detect/forensic.ts";
import { findIds, maskForDisplay } from "../detect/patterns.ts";
import { extractPdf, openPdf, type PdfExtract, type PdfPage } from "../extract/pdf.ts";
import { earlierRevisions, removedText } from "../extract/pdfRevisions.ts";
import { layerFromOcrWords, rectsForRange, type TextLayer } from "../extract/textLayer.ts";
import type { OcrEngine } from "../ocr/engine.ts";
import type { Rect } from "../schemas.ts";
import { collectTextFindings, FindingCollector, LABEL, REASON_TEXT } from "./findings.ts";

export interface PdfScanOutput {
  collector: FindingCollector;
  /** Text layers (PDF text and OCR) for the optional AI pass. Worker-internal. */
  layers: TextLayer[];
  pageCount: number;
  warnings: string[];
  ocr: { pagesDone: number; pagesTotal: number };
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
    if (page.isScanned) {
      if (ocr.engine && ocrDone < ocr.pageCap) {
        layers.push(await ocrPage(doc, page, ocr.engine, out));
        ocrDone++;
      } else {
        warnings.push(`Page ${page.index + 1} is a scanned image and wasn't read with OCR${ocr.engine ? " (page limit reached)" : ""}`);
      }
      continue;
    }
    scanPageText(page, out);
    layers.push(page);
  }
  scanDocumentLevel(ex, out);
  scanRevisions(bytes, ex, out);

  return {
    collector: out, layers, pageCount: ex.pages.length, warnings,
    ocr: { pagesDone: ocrDone, pagesTotal: scanned.length },
  };
}

function scanPageText(page: PdfPage, out: FindingCollector): void {
  const hidden = hiddenChars(page);
  const { claimed } = collectTextFindings(page, out, { baseSource: "text", hidden });

  // Hidden text that isn't a recognised ID or entity is still a leak: report the run itself.
  for (const run of hiddenRuns(page, hidden)) {
    const unclaimed = page.text.slice(run.start, run.end).trim();
    if (!unclaimed || claimed.some(([s, e]) => s <= run.start && run.end <= e)) continue;
    out.add({
      type: "hidden_content", source: run.reason, page: page.index, rects: rectsForRange(page, run.start, run.end),
      masked: `[${unclaimed.replace(/\s/g, "").length} hidden characters]`, reason: `Text ${REASON_TEXT[run.reason]}`,
      confidence: 0.95, redactable: true, detector: "forensic",
    }, [unclaimed]);
  }
}

async function ocrPage(doc: mupdf.PDFDocument, page: PdfPage, engine: OcrEngine, out: FindingCollector): Promise<TextLayer> {
  const pix = doc.loadPage(page.index).toPixmap(mupdf.Matrix.scale(OCR_SCALE, OCR_SCALE), mupdf.ColorSpace.DeviceGray, false);
  const words = await engine.recognize(pix.asPNG());
  // Pixmap pixels → page points; MuPDF page space and the rendered image share the top-left origin.
  const layer = layerFromOcrWords(words, page.index, 1 / OCR_SCALE);
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
