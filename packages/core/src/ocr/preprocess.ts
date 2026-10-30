// Phone photos of ID cards have patterned, unevenly lit backgrounds (PAN guilloche, glare) that
// defeat Tesseract's single global threshold: it can read nothing at all from a perfectly legible
// card. A local (Bradley) threshold compares each pixel with its own neighbourhood instead (D-032).
import * as mupdf from "mupdf";
import type { OcrWord } from "../extract/textLayer.ts";
import type { OcrEngine } from "./engine.ts";

/**
 * Longest side of the thresholded copy. Larger copies keep camera grain as speckles that break
 * Tesseract's layout analysis (a 2688 px card photo read as noise; at 1344 px it read cleanly).
 * The original-resolution reading is always tried too, so fine print on full-page scans isn't lost.
 */
const MAX_SIDE = 1600;
/** Window ≈ 1/12 of the short side: about two text lines on an ID card, so it works at any scale. */
const WINDOW_FRACTION = 1 / 12;
/** A pixel is ink when it is this much darker than its neighbourhood mean. */
const DARKER_BY = 0.15;
/** Word confidence (0..1) that counts as a real reading when comparing the two passes. */
const CONFIDENT = 0.5;

/** A black-on-white copy of `pix` (downsampled by `scale` when it is very large). */
export function binarize(pix: mupdf.Pixmap): { pix: mupdf.Pixmap; scale: number } {
  const W = pix.getWidth(), H = pix.getHeight();
  const src = pix.getPixels(), stride = pix.getStride(), n = pix.getNumberOfComponents();
  const scale = Math.max(1, Math.ceil(Math.max(W, H) / MAX_SIDE));
  const w = Math.floor(W / scale), h = Math.floor(H / scale);

  const lum = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * scale * stride + x * scale * n;
      lum[y * w + x] = n >= 3 ? Math.round(0.2126 * src[i]! + 0.7152 * src[i + 1]! + 0.0722 * src[i + 2]!) : src[i]!;
    }
  }
  const ii = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += lum[y * w + x]!;
      ii[(y + 1) * (w + 1) + x + 1] = ii[y * (w + 1) + x + 1]! + row;
    }
  }

  const out = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, w, h], false);
  const px = out.getPixels(), os = out.getStride();
  const r = Math.max(7, Math.round(Math.min(w, h) * WINDOW_FRACTION)) >> 1;
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
      const sum = ii[y1 * (w + 1) + x1]! - ii[y0 * (w + 1) + x1]! - ii[y1 * (w + 1) + x0]! + ii[y0 * (w + 1) + x0]!;
      const mean = sum / ((x1 - x0) * (y1 - y0));
      px[y * os + x] = lum[y * w + x]! < mean * (1 - DARKER_BY) ? 0 : 255;
    }
  }
  return { pix: out, scale };
}

/**
 * How much real text a word list holds: characters in confidently read words. Low-confidence words
 * are left out because a noisy photo yields hundreds of them (227 on one card, 2 above 50%).
 */
function textScore(words: OcrWord[]): number {
  let s = 0;
  for (const w of words) {
    const len = w.text.replace(/[^\p{L}\p{N}]/gu, "").length;
    if (len >= 2 && w.confidence >= CONFIDENT) s += len;
  }
  return s;
}

/**
 * OCRs both the original and a locally thresholded copy and keeps the reading with more confident
 * text. Word boxes are always in `pix`'s pixel space.
 */
export async function recognizeBest(engine: OcrEngine, pix: mupdf.Pixmap): Promise<OcrWord[]> {
  const raw = await engine.recognize(pix.asPNG());
  const bin = binarize(pix);
  const thr = (await engine.recognize(bin.pix.asPNG())).map((w) => ({ ...w, bbox: w.bbox.map((v) => v * bin.scale) as OcrWord["bbox"] }));
  return textScore(thr) > textScore(raw) ? thr : raw;
}
