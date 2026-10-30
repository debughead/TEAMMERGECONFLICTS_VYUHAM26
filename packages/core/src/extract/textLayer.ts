// A page's text with a rectangle per character: the common shape for PDF text layers and OCR output,
// so every detector maps matches back to page rectangles the same way.
import type { Rect } from "../schemas.ts";

export interface LayerChar {
  c: string;
  rect: Rect;
}

export interface TextLayer {
  index: number;
  /** Lines separated by "\n". */
  text: string;
  /** For each index in `text`, the index into `chars`, or -1 for synthetic separators. */
  textToChar: number[];
  chars: LayerChar[];
  /**
   * Set for text that isn't drawn on the page (comments, Office document text): findings in it have
   * no page area, so redaction never paints over the page. `removable` says whether the clean step
   * removes it anyway (comments yes, Office body text no, D-003); `page` is null for Office.
   */
  structural?: { removable: boolean; page: number | null };
}

export interface OcrWord {
  text: string;
  /** In the coordinate space of the rendered image (pixels). */
  bbox: Rect;
  confidence: number;
  /** Words sharing a line number are joined with spaces; lines with "\n". */
  line: number;
}

/** Rectangles for text[start, end): one merged rect per line. */
export function rectsForRange(layer: TextLayer, start: number, end: number): Rect[] {
  const rects: Rect[] = [];
  let cur: Rect | null = null;
  for (let i = start; i < end; i++) {
    const ci = layer.textToChar[i];
    if (ci === undefined || ci < 0 || layer.text[i] === "\n") {
      if (cur && layer.text[i] === "\n") { rects.push(cur); cur = null; }
      continue;
    }
    const r = layer.chars[ci]!.rect;
    cur = cur ? [Math.min(cur[0], r[0]), Math.min(cur[1], r[1]), Math.max(cur[2], r[2]), Math.max(cur[3], r[3])] : [...r];
  }
  if (cur) rects.push(cur);
  return rects;
}

export function charIndicesForRange(layer: TextLayer, start: number, end: number): number[] {
  const out: number[] = [];
  for (let i = start; i < end; i++) {
    const ci = layer.textToChar[i];
    if (ci !== undefined && ci >= 0) out.push(ci);
  }
  return out;
}

/**
 * Builds a text layer from OCR words. Each character gets an equal horizontal slice of its word's box,
 * scaled by `scale` (e.g. pixels → PDF points). Spaces between words get no rectangle.
 */
export function layerFromOcrWords(words: OcrWord[], index: number, scale: number | ((r: Rect) => Rect) = 1): TextLayer {
  const map = typeof scale === "function" ? scale : (r: Rect) => r.map((v) => v * scale) as unknown as Rect;
  const layer: TextLayer = { index, text: "", textToChar: [], chars: [] };
  const sorted = [...words].sort((a, b) => a.line - b.line || a.bbox[0] - b.bbox[0]);
  let line: number | null = null;
  for (const w of sorted) {
    if (line !== null) {
      layer.text += w.line === line ? " " : "\n";
      layer.textToChar.push(-1);
    }
    line = w.line;
    const [x0, y0, x1, y1] = map(w.bbox);
    const step = (x1 - x0) / Math.max(1, w.text.length);
    [...w.text].forEach((c, k) => {
      layer.chars.push({ c, rect: [x0 + k * step, y0, x0 + (k + 1) * step, y1] });
      layer.textToChar.push(layer.chars.length - 1);
      layer.text += c;
    });
  }
  return layer;
}
