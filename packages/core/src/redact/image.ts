// Image redaction: paint the regions on upright pixels and re-encode from raw pixels, which drops
// EXIF, XMP, IPTC, ICC text and thumbnails (docs/HLD.md §3.6). WebP is re-encoded as PNG.
import * as mupdf from "mupdf";
import { decodeUpright } from "../extract/image.ts";
import type { FileType, Rect } from "../schemas.ts";

const PAD = 2;
const JPEG_QUALITY = 90;

export function redactImage(bytes: Uint8Array, fileType: FileType, orientation: number, rects: Rect[]): { bytes: Uint8Array<ArrayBuffer>; mime: string; ext: string } {
  const pix = decodeUpright(bytes, orientation);
  paintBlack(pix, rects);
  if (fileType === "jpeg") return { bytes: new Uint8Array(pix.asJPEG(JPEG_QUALITY)), mime: "image/jpeg", ext: "jpg" };
  return { bytes: new Uint8Array(pix.asPNG()), mime: "image/png", ext: "png" };
}

export function paintBlack(pix: mupdf.Pixmap, rects: Rect[]): void {
  const W = pix.getWidth();
  const H = pix.getHeight();
  const stride = pix.getStride();
  const n = pix.getNumberOfComponents();
  const px = pix.getPixels();
  for (const r of rects) {
    const x0 = Math.max(0, Math.floor(r[0] - PAD));
    const y0 = Math.max(0, Math.floor(r[1] - PAD));
    const x1 = Math.min(W, Math.ceil(r[2] + PAD));
    const y1 = Math.min(H, Math.ceil(r[3] + PAD));
    for (let y = y0; y < y1; y++) px.fill(0, y * stride + x0 * n, y * stride + x1 * n);
  }
}

/** True when every pixel inside `r` is black: proof the region is gone, not covered. Works for gray and RGB. */
export function regionIsBlack(pix: mupdf.Pixmap, r: Rect, tolerance = 24): boolean {
  const W = pix.getWidth();
  const H = pix.getHeight();
  const stride = pix.getStride();
  const n = pix.getNumberOfComponents();
  const colour = Math.min(n, 3);
  const px = pix.getPixels();
  // Check the unpadded core: JPEG ringing can lighten the padded edge slightly.
  for (let y = Math.max(0, Math.ceil(r[1])); y < Math.min(H, Math.floor(r[3])); y++) {
    for (let x = Math.max(0, Math.ceil(r[0])); x < Math.min(W, Math.floor(r[2])); x++) {
      const i = y * stride + x * n;
      for (let k = 0; k < colour; k++) if (px[i + k]! > tolerance) return false;
    }
  }
  return true;
}
