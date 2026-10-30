// Records page drawing operations in paint order, so the forensic detector can tell
// "box drawn over text" (hidden) from "text drawn on a dark bar" (visible). Spike S2 / D-011.
import * as mupdf from "mupdf";
import type { Rect } from "../schemas.ts";
import { luminance } from "../util/geom.ts";

export interface DrawEvent {
  kind: "fill" | "image" | "text";
  /** Paint order within the page content. */
  seq: number;
  rect: Rect;
  /** 0 black .. 1 white; images use their mean luminance. */
  luminance: number;
  alpha: number;
}

const NO_STROKE: mupdf.StrokeStateData = { lineCap: "Butt", lineJoin: "Miter", lineWidth: 0, miterLimit: 10 };
/** Images bigger than this are sampled rather than fully read when computing mean luminance. */
const IMAGE_SAMPLE_TARGET = 10_000;

export function collectDraws(page: mupdf.Page): DrawEvent[] {
  const events: DrawEvent[] = [];
  const stroke = new mupdf.StrokeState(NO_STROKE);
  let seq = 0;
  const device = new mupdf.Device({
    fillPath(path, _evenOdd, ctm, _cs, color, alpha) {
      events.push({ kind: "fill", seq: seq++, rect: path.getBounds(stroke, ctm), luminance: luminance(color), alpha });
    },
    fillText(text, ctm, _cs, color, alpha) {
      events.push({ kind: "text", seq: seq++, rect: text.getBounds(stroke, ctm), luminance: luminance(color), alpha });
    },
    fillImage(image, ctm, alpha) {
      events.push({ kind: "image", seq: seq++, rect: mupdf.Rect.transform([0, 0, 1, 1], ctm), luminance: imageLuminance(image), alpha });
    },
    fillImageMask(_image, ctm, _cs, color, alpha) {
      // A stencil mask painted in a solid colour behaves like a filled shape.
      events.push({ kind: "fill", seq: seq++, rect: mupdf.Rect.transform([0, 0, 1, 1], ctm), luminance: luminance(color), alpha });
    },
  });
  try {
    page.runPageContents(device, mupdf.Matrix.identity);
  } finally {
    device.close();
  }
  return events;
}

function imageLuminance(image: mupdf.Image): number {
  try {
    const pix = image.toPixmap().convertToColorSpace(mupdf.ColorSpace.DeviceRGB, false);
    const px = pix.getPixels();
    const n = pix.getNumberOfComponents() + (pix.getAlpha() ? 1 : 0);
    const count = px.length / n;
    const step = Math.max(1, Math.floor(count / IMAGE_SAMPLE_TARGET));
    let sum = 0;
    let samples = 0;
    for (let i = 0; i < count; i += step) {
      const o = i * n;
      sum += luminance([px[o]! / 255, px[o + 1]! / 255, px[o + 2]! / 255]);
      samples++;
    }
    return samples ? sum / samples : 1;
  } catch {
    // Unreadable image: treat as not dark rather than inventing a finding.
    return 1;
  }
}

/**
 * The largest image painted on a page and a mapper from its pixel rects to page space. Uses the full
 * placement transform, so rotated placements (e.g. a landscape photo put on a portrait page) map
 * correctly. Image pixel (x, y) sits at unit-square point (x/w, y/h) (top row = 0, checked on a
 * rotated sample).
 */
export function largestImage(page: mupdf.Page): { image: mupdf.Image; toPage: (r: Rect) => Rect } | null {
  let best: { image: mupdf.Image; ctm: mupdf.Matrix; area: number } | null = null as { image: mupdf.Image; ctm: mupdf.Matrix; area: number } | null;
  const device = new mupdf.Device({
    fillImage(image, ctm) {
      const r = mupdf.Rect.transform([0, 0, 1, 1], ctm);
      const area = (r[2] - r[0]) * (r[3] - r[1]);
      if (!best || area > best.area) best = { image, ctm, area };
    },
  });
  try {
    page.runPageContents(device, mupdf.Matrix.identity);
  } finally {
    device.close();
  }
  if (!best) return null;
  const { image, ctm } = best;
  const [a, b, c, d, e, f] = ctm;
  const w = image.getWidth(), h = image.getHeight();
  const pt = (x: number, y: number): [number, number] => { const u = x / w, v = y / h; return [a * u + c * v + e, b * u + d * v + f]; };
  return {
    image,
    toPage: (r) => {
      const ps = [pt(r[0], r[1]), pt(r[2], r[1]), pt(r[0], r[3]), pt(r[2], r[3])];
      return [Math.min(...ps.map((q) => q[0])), Math.min(...ps.map((q) => q[1])), Math.max(...ps.map((q) => q[0])), Math.max(...ps.map((q) => q[1]))];
    },
  };
}
