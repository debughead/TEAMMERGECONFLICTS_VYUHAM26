// Records page drawing operations in paint order, so the forensic detector can tell
// "box drawn over text" (hidden) from "text drawn on a dark bar" (visible). Spike S2 / D-011.
import * as mupdf from "mupdf";
import type { Rect } from "../schemas.ts";
import { intersect, luminance } from "../util/geom.ts";

export interface DrawEvent {
  /** "invisible_text" is text drawn in an invisible render mode (e.g. an OCR layer); it paints nothing. */
  kind: "fill" | "image" | "text" | "invisible_text";
  /** Paint order within the page content. */
  seq: number;
  rect: Rect;
  /** Area the active clipping paths let through when this was drawn (null: unclipped). */
  clip: Rect | null;
  /** 0 black .. 1 white; images use their mean luminance. */
  luminance: number;
  /**
   * Effective opacity: the draw's own alpha times its transparency groups'. 0 inside a non-Normal blend
   * group (a multiply highlighter doesn't hide what's under it) and inside soft-masked content.
   */
  alpha: number;
}

const NO_STROKE: mupdf.StrokeStateData = { lineCap: "Butt", lineJoin: "Miter", lineWidth: 0, miterLimit: 10 };
/** Images bigger than this are sampled rather than fully read when computing mean luminance. */
const IMAGE_SAMPLE_TARGET = 10_000;

export function collectDraws(page: mupdf.Page): DrawEvent[] {
  const events: DrawEvent[] = [];
  const stroke = new mupdf.StrokeState(NO_STROKE);
  let seq = 0;
  // Clip stack: each entry is the effective visible area (intersection with its parent) and whether it
  // is a soft mask (content under a mask is partly transparent, so it never counts as covering).
  const clips: { rect: Rect | null; masked: boolean }[] = [];
  const groupAlpha: number[] = [];
  let definingMask = 0;
  let inTile = 0;
  const top = () => clips[clips.length - 1];
  const pushClip = (r: Rect | null, masked = false) => {
    const parent = top();
    const rect = r && parent?.rect ? intersect(r, parent.rect) ?? ([r[0], r[1], r[0], r[1]] as Rect) : r ?? parent?.rect ?? null;
    clips.push({ rect, masked: masked || Boolean(parent?.masked) });
  };
  const alphaNow = (alpha: number) => (top()?.masked ? 0 : alpha * (groupAlpha[groupAlpha.length - 1] ?? 1));
  const record = (kind: DrawEvent["kind"], rect: Rect, luminance: number, alpha: number) => {
    // Shapes that define a soft mask or a pattern cell are never painted on the page as such.
    if (definingMask > 0 || inTile > 0) return;
    events.push({ kind, seq: seq++, rect, clip: top()?.rect ?? null, luminance, alpha: alphaNow(alpha) });
  };
  const device = new mupdf.Device({
    fillPath(path, _evenOdd, ctm, _cs, color, alpha) {
      record("fill", path.getBounds(stroke, ctm), luminance(color), alpha);
    },
    fillText(text, ctm, _cs, color, alpha) {
      record("text", text.getBounds(stroke, ctm), luminance(color), alpha);
    },
    strokeText(text, _stroke, ctm, _cs, color, alpha) {
      record("text", text.getBounds(stroke, ctm), luminance(color), alpha);
    },
    ignoreText(text, ctm) {
      record("invisible_text", text.getBounds(stroke, ctm), 1, 0);
    },
    fillImage(image, ctm, alpha) {
      record("image", mupdf.Rect.transform([0, 0, 1, 1], ctm), imageLuminance(image), alpha);
    },
    fillImageMask(_image, ctm, _cs, color, alpha) {
      // A stencil mask painted in a solid colour behaves like a filled shape.
      record("fill", mupdf.Rect.transform([0, 0, 1, 1], ctm), luminance(color), alpha);
    },
    clipPath(path, _evenOdd, ctm) { pushClip(path.getBounds(stroke, ctm)); },
    clipStrokePath(path, _stroke, ctm) { pushClip(path.getBounds(stroke, ctm)); },
    clipText(text, ctm) { pushClip(text.getBounds(stroke, ctm)); },
    clipStrokeText(text, _stroke, ctm) { pushClip(text.getBounds(stroke, ctm)); },
    clipImageMask(_image, ctm) { pushClip(mupdf.Rect.transform([0, 0, 1, 1], ctm)); },
    popClip() { clips.pop(); },
    beginMask() { definingMask++; },
    // The mask applies to what follows until its popClip.
    endMask() { definingMask = Math.max(0, definingMask - 1); pushClip(null, true); },
    beginGroup(_bbox, _cs, _isolated, _knockout, blendmode, alpha) {
      groupAlpha.push((groupAlpha[groupAlpha.length - 1] ?? 1) * (blendmode === "Normal" ? alpha : 0));
    },
    endGroup() { groupAlpha.pop(); },
    beginTile() { inTile++; return 0; },
    endTile() { inTile = Math.max(0, inTile - 1); },
  });
  try {
    page.runPageContents(device, mupdf.Matrix.identity);
  } finally {
    // Free now rather than in a garbage-collection finalizer (see pageInk.ts).
    device.close();
    device.destroy();
  }
  return events;
}

/** The part of a draw that can actually be seen: its bounds cut to its clip. */
export function visibleRect(d: DrawEvent): Rect | null {
  return d.clip ? intersect(d.rect, d.clip) : d.rect;
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
    // Free now rather than in a garbage-collection finalizer (see pageInk.ts).
    device.close();
    device.destroy();
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
