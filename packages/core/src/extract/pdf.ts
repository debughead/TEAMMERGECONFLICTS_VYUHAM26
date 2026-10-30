// PDF extraction: page text with per-character rectangles, paint-order draw events, annotations
// and metadata. Coordinates are MuPDF page space (points, top-left origin).
import * as mupdf from "mupdf";
import { checkPdfLimits } from "../filetype.ts";
import type { Rect } from "../schemas.ts";
import { quadBounds } from "../util/geom.ts";
import { collectDraws, type DrawEvent } from "./pdfFills.ts";
import type { TextLayer } from "./textLayer.ts";

export interface PageChar {
  c: string;
  rect: Rect;
  /** Fill colour components (0..1) as reported by the structured-text walk. */
  color: number[];
}

export interface AnnotInfo {
  type: string;
  rect: Rect;
  color: number[];
  interiorColor: number[];
}

export interface PdfPage extends TextLayer {
  bounds: Rect;
  chars: PageChar[];
  draws: DrawEvent[];
  annots: AnnotInfo[];
  /** No real text layer and dominated by an image: needs OCR. */
  isScanned: boolean;
}

export interface PdfExtract {
  pages: PdfPage[];
  /** Non-empty Info dictionary entries. Raw values: worker-internal only. */
  info: Record<string, string>;
  hasXmp: boolean;
  versions: number;
  hasEmbeddedFiles: boolean;
  hasJavaScript: boolean;
}

export const INFO_KEYS = ["Title", "Author", "Subject", "Keywords", "Creator", "Producer", "CreationDate", "ModDate"] as const;
const SCANNED_MAX_CHARS = 20;
const SCANNED_MIN_IMAGE_COVER = 0.8;

export function openPdf(bytes: Uint8Array): mupdf.PDFDocument {
  const doc = new mupdf.PDFDocument(bytes);
  checkPdfLimits({ needsPassword: doc.needsPassword(), pageCount: doc.countPages() });
  return doc;
}

export function extractPdf(doc: mupdf.PDFDocument): PdfExtract {
  const pages: PdfPage[] = [];
  for (let i = 0; i < doc.countPages(); i++) pages.push(extractPage(doc.loadPage(i), i));

  const info: Record<string, string> = {};
  for (const key of INFO_KEYS) {
    const v = doc.getMetaData(`info:${key}`);
    if (v && v.trim()) info[key] = v;
  }
  const root = doc.getTrailer().get("Root");
  const names = root.get("Names");
  return {
    pages,
    info,
    hasXmp: !root.get("Metadata").isNull(),
    versions: doc.countVersions(),
    hasEmbeddedFiles: !names.isNull() && !names.get("EmbeddedFiles").isNull(),
    hasJavaScript: (!names.isNull() && !names.get("JavaScript").isNull()) || !root.get("OpenAction").isNull() || !root.get("AA").isNull(),
  };
}

export function extractPage(page: mupdf.PDFPage, index: number): PdfPage {
  const chars: PageChar[] = [];
  let text = "";
  const textToChar: number[] = [];
  let lineHasChars = false;
  page.toStructuredText("preserve-whitespace").walk({
    beginLine() {
      lineHasChars = false;
    },
    onChar(c, _origin, _font, _size, quad, color) {
      chars.push({ c, rect: quadBounds(quad), color: [...color] });
      for (let k = 0; k < c.length; k++) textToChar.push(chars.length - 1);
      text += c;
      lineHasChars = true;
    },
    endLine() {
      if (lineHasChars) {
        text += "\n";
        textToChar.push(-1);
      }
    },
  });

  const bounds = page.getBounds();
  const draws = collectDraws(page);
  const pageArea = (bounds[2] - bounds[0]) * (bounds[3] - bounds[1]);
  const bigImage = draws.some(
    (d) => d.kind === "image" && ((d.rect[2] - d.rect[0]) * (d.rect[3] - d.rect[1])) / pageArea >= SCANNED_MIN_IMAGE_COVER,
  );
  const annots = page.getAnnotations().map((a) => ({
    type: a.getType(),
    rect: a.getRect(),
    color: [...a.getColor()],
    interiorColor: a.hasInteriorColor() ? [...a.getInteriorColor()] : [],
  }));
  return {
    index,
    bounds,
    text,
    textToChar,
    chars,
    draws,
    annots,
    isScanned: bigImage && text.replace(/\s/g, "").length < SCANNED_MAX_CHARS,
  };
}
