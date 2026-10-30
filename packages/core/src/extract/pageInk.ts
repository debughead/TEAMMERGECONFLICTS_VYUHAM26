// Ground truth for "is this text visible?": render the page, render a copy with all text removed, and
// see how much of each glyph's own ink actually changes the picture. Shape-based rules work on
// bounding boxes, which over-cover (rounded badges, gradients); pixels don't (D-037).
import * as mupdf from "mupdf";
import type { Rect } from "../schemas.ts";

/** 144 dpi: enough to resolve 6 pt glyphs; pages are rendered only when a rule flags something. */
const SCALE = 2;
/** Grey-level change that counts as "this pixel shows the glyph". */
const DIFF = 40;
/** Pixels darker than this in the text-only render are the glyph's ink. */
const INK = 128;

interface Renders { full: Uint8Array; bare: Uint8Array; ink: Uint8Array; x0: number; y0: number; w: number; h: number; stride: number }

/**
 * For a page, a function giving the fraction (0..1) of a character box's glyph ink that is visible in
 * the rendered page, or null when it can't be judged (no ink in the box, e.g. invisible render mode, or
 * rendering failed). `textless` returns the same page from a copy with every glyph removed. Renders
 * lazily, once, on first use.
 */
export function inkVisibility(page: mupdf.PDFPage, textless: () => mupdf.PDFPage | null): (r: Rect) => number | null {
  let renders: Renders | null | undefined;
  return (r) => {
    if (renders === undefined) {
      try {
        const bare = textless();
        renders = bare ? renderAll(page, bare) : null;
      } catch {
        renders = null; // can't judge by pixels: the shape rules' answer stands
      }
    }
    if (!renders) return null;
    const { full, bare, ink, x0, y0, w, h, stride } = renders;
    const px0 = Math.max(0, Math.floor(r[0] * SCALE) - x0), px1 = Math.min(w, Math.ceil(r[2] * SCALE) - x0);
    const py0 = Math.max(0, Math.floor(r[1] * SCALE) - y0), py1 = Math.min(h, Math.ceil(r[3] * SCALE) - y0);
    let inkPx = 0, shown = 0;
    for (let y = py0; y < py1; y++) {
      for (let x = px0; x < px1; x++) {
        const i = y * stride + x;
        if (ink[i]! >= INK) continue;
        inkPx++;
        if (Math.abs(full[i]! - bare[i]!) > DIFF) shown++;
      }
    }
    return inkPx === 0 ? null : shown / inkPx;
  };
}

/** A copy of the document with every glyph removed (images and vector art untouched, no boxes drawn). */
export function textFreeCopy(doc: mupdf.PDFDocument): mupdf.PDFDocument {
  const copy = new mupdf.PDFDocument(doc.saveToBuffer("").asUint8Array().slice());
  for (let i = 0; i < copy.countPages(); i++) {
    const p = copy.loadPage(i);
    p.createAnnotation("Redact").setRect([-1e5, -1e5, 1e5, 1e5]);
    p.applyRedactions(false, mupdf.PDFPage.REDACT_IMAGE_NONE, mupdf.PDFPage.REDACT_LINE_ART_NONE, mupdf.PDFPage.REDACT_TEXT_REMOVE);
  }
  return copy;
}

function renderAll(page: mupdf.PDFPage, bare: mupdf.PDFPage): Renders {
  const m = mupdf.Matrix.scale(SCALE, SCALE);
  const b = mupdf.Rect.transform(page.getBounds(), m);
  const bbox: Rect = [Math.floor(b[0]), Math.floor(b[1]), Math.ceil(b[2]), Math.ceil(b[3])];
  const draw = (p: mupdf.PDFPage, textOnly: boolean): { px: Uint8Array; stride: number } => {
    const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, bbox, false);
    pix.clear(255);
    const target = new mupdf.DrawDevice(mupdf.Matrix.identity, pix);
    // Text-only: just the glyphs, in black, unclipped and uncovered (the ink each character would show
    // if nothing hid it). Deliberately no fillShade callback: MuPDF.js 1.28.1 hands device callbacks a
    // Shade it never retained, and its finalizer then frees it twice (crash under GC, D-037).
    const gray = mupdf.ColorSpace.DeviceGray;
    const dev = textOnly
      ? new mupdf.Device({
        fillText: (text, ctm) => target.fillText(text, ctm, gray, [0], 1),
        strokeText: (text, _s, ctm) => target.fillText(text, ctm, gray, [0], 1),
      })
      : null;
    try {
      p.runPageContents(dev ?? target, m);
    } finally {
      // Free now rather than in garbage-collection finalizers.
      dev?.close();
      target.close();
      dev?.destroy();
      target.destroy();
    }
    const px = new Uint8Array(pix.getPixels());
    const stride = pix.getStride();
    pix.destroy();
    return { px, stride };
  };
  const full = draw(page, false);
  const bareR = draw(bare, false);
  const ink = draw(page, true);
  return { full: full.px, bare: bareR.px, ink: ink.px, x0: bbox[0], y0: bbox[1], w: bbox[2] - bbox[0], h: bbox[3] - bbox[1], stride: full.stride };
}
