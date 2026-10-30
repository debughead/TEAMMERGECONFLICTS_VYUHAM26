// PDF extraction: page text with per-character rectangles, paint-order draw events, annotations
// and metadata. Coordinates are MuPDF page space (points, top-left origin).
import * as mupdf from "mupdf";
import { checkPdfLimits } from "../filetype.ts";
import type { Rect } from "../schemas.ts";
import { quadBounds } from "../util/geom.ts";
import { inkVisibility, textFreeCopy } from "./pageInk.ts";
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
  /** Text drawn outside the page box: no viewer shows it, but it can be extracted. */
  offPage: TextLayer;
  /** Text inside optional-content layers that are switched off. */
  hiddenLayer: TextLayer;
  /** Filled-in form field values (not part of the page's text layer). */
  formValues: { rect: Rect; value: string }[];
  /** Comment-style annotations with text (sticky notes, markup comments). Raw text: worker-internal. */
  comments: { type: string; rect: Rect; author: string; contents: string }[];
  /** Fraction of a char box's glyph ink visible on the rendered page (null: no ink); renders lazily. */
  inkVisible: (r: Rect) => number | null;
}

export interface PdfExtract {
  pages: PdfPage[];
  /** Optional-content layers currently switched off. */
  hiddenLayerCount: number;
  /** Non-empty Info dictionary entries. Raw values: worker-internal only. */
  info: Record<string, string>;
  hasXmp: boolean;
  versions: number;
  hasEmbeddedFiles: boolean;
  hasJavaScript: boolean;
}

export const INFO_KEYS = ["Title", "Author", "Subject", "Keywords", "Creator", "Producer", "CreationDate", "ModDate"] as const;
const SCANNED_MAX_CHARS = 20;
/**
 * A photo saved as PDF often sits unscaled on the page: macOS Preview puts a landscape card photo on
 * portrait A4 at ~40% cover. Any sizeable image on a page without text gets OCR (D-031).
 */
const SCANNED_MIN_IMAGE_COVER = 0.15;

export function openPdf(bytes: Uint8Array): mupdf.PDFDocument {
  const doc = new mupdf.PDFDocument(bytes);
  checkPdfLimits({ needsPassword: doc.needsPassword(), pageCount: doc.countPages() });
  return doc;
}

export function extractPdf(doc: mupdf.PDFDocument): PdfExtract {
  const pages: PdfPage[] = [];
  // One text-free copy serves every page, made only if some page needs a pixel check.
  let bareDoc: mupdf.PDFDocument | null | undefined;
  const textless = (i: number) => () => {
    if (bareDoc === undefined) {
      try { bareDoc = textFreeCopy(doc); } catch { bareDoc = null; }
    }
    return bareDoc ? bareDoc.loadPage(i) : null;
  };
  for (let i = 0; i < doc.countPages(); i++) pages.push(extractPage(doc.loadPage(i), i, textless(i)));
  const hiddenLayerCount = collectHiddenLayerText(doc, pages);

  const info: Record<string, string> = {};
  for (const key of INFO_KEYS) {
    const v = doc.getMetaData(`info:${key}`);
    if (v && v.trim()) info[key] = v;
  }
  const root = doc.getTrailer().get("Root");
  const names = root.get("Names");
  return {
    pages,
    hiddenLayerCount,
    info,
    hasXmp: !root.get("Metadata").isNull(),
    versions: doc.countVersions(),
    hasEmbeddedFiles: !names.isNull() && !names.get("EmbeddedFiles").isNull(),
    hasJavaScript: (!names.isNull() && !names.get("JavaScript").isNull()) || !root.get("OpenAction").isNull() || !root.get("AA").isNull(),
  };
}

export function extractPage(page: mupdf.PDFPage, index: number, textless: () => mupdf.PDFPage | null = () => null): PdfPage {
  const bounds = page.getBounds();
  const main = new LayerBuilder(index);
  const offPage = new LayerBuilder(index);
  // Unclipped, so text placed outside the page box is seen too; it goes to its own layer.
  walkChars(page, (c, rect, color) => (insidePage(rect, bounds) ? main : offPage).add(c, rect, color), () => { main.endLine(); offPage.endLine(); });
  const { text, textToChar, chars } = main.build();
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
    offPage: offPage.build(),
    hiddenLayer: new LayerBuilder(index).build(),
    formValues: page.getWidgets()
      .map((w) => ({ rect: w.getRect(), value: w.getValue() ?? "" }))
      .filter((w) => w.value.trim().length > 0),
    comments: page.getAnnotations()
      .filter((a) => !NOT_COMMENTS.has(a.getType()))
      .map((a) => ({ type: a.getType(), rect: a.getRect(), author: a.getAuthor() ?? "", contents: a.getContents() ?? "" }))
      .filter((a) => a.contents.trim().length > 0 || a.author.trim().length > 0),
    inkVisible: inkVisibility(page, textless),
  };
}

/** Annotation types that don't carry free-text comments (links, form widgets, popups mirror their parent). */
const NOT_COMMENTS = new Set(["Link", "Widget", "Popup", "Redact"]);

const STEXT_OPTIONS = "preserve-whitespace,mediabox-clip=no";

function walkChars(page: mupdf.PDFPage, onChar: (c: string, rect: Rect, color: number[]) => void, endLine: () => void): void {
  page.toStructuredText(STEXT_OPTIONS).walk({
    onChar(c, _origin, _font, _size, quad, color) {
      onChar(c, quadBounds(quad), [...color]);
    },
    endLine,
  });
}

/** A character counts as on the page when its centre is inside the page box. */
function insidePage(r: Rect, b: Rect): boolean {
  const cx = (r[0] + r[2]) / 2, cy = (r[1] + r[3]) / 2;
  return cx >= b[0] && cx <= b[2] && cy >= b[1] && cy <= b[3];
}

/** Builds a TextLayer one character at a time; lines are separated by "\n". */
class LayerBuilder {
  private text = "";
  private readonly textToChar: number[] = [];
  private readonly chars: PageChar[] = [];
  private lineHasChars = false;
  constructor(private readonly index: number) {}
  add(c: string, rect: Rect, color: number[]): void {
    this.chars.push({ c, rect, color });
    for (let k = 0; k < c.length; k++) this.textToChar.push(this.chars.length - 1);
    this.text += c;
    this.lineHasChars = true;
  }
  endLine(): void {
    if (this.lineHasChars) {
      this.text += "\n";
      this.textToChar.push(-1);
    }
    this.lineHasChars = false;
  }
  build(): TextLayer & { chars: PageChar[] } {
    return { index: this.index, text: this.text, textToChar: this.textToChar, chars: this.chars };
  }
}

/**
 * Fills each page's `hiddenLayer` with text that only appears once every optional-content layer is
 * switched on. Visibility is restored afterwards, so later rendering sees the document as authored.
 * Returns the number of layers that were off.
 */
function collectHiddenLayerText(doc: mupdf.PDFDocument, pages: PdfPage[]): number {
  const off: number[] = [];
  for (let i = 0; i < doc.countLayers(); i++) if (!doc.isLayerVisible(i)) off.push(i);
  if (off.length === 0) return 0;
  const key = (c: string, r: Rect) => `${c}|${Math.round(r[0] * 4)}|${Math.round(r[1] * 4)}`;
  try {
    for (const i of off) doc.setLayerVisible(i, true);
    for (const page of pages) {
      // Multiset of what was already visible on the page (on-page and off-page layers alike).
      const seen = new Map<string, number>();
      for (const ch of [...page.chars, ...page.offPage.chars]) seen.set(key(ch.c, ch.rect), (seen.get(key(ch.c, ch.rect)) ?? 0) + 1);
      const hidden = new LayerBuilder(page.index);
      walkChars(doc.loadPage(page.index), (c, rect, color) => {
        const k = key(c, rect);
        const n = seen.get(k) ?? 0;
        if (n > 0) { seen.set(k, n - 1); return; }
        // Includes hidden-layer text placed off the page: the off-page pass ran with the layer off.
        hidden.add(c, rect, color);
      }, () => hidden.endLine());
      page.hiddenLayer = hidden.build();
    }
  } finally {
    for (const i of off) doc.setLayerVisible(i, false);
  }
  return off.length;
}
