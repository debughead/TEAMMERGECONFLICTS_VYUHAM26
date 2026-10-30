// Image decoding (upright pixels) and privacy-relevant metadata (docs/HLD.md §3.4).
// MuPDF decodes the stored pixels and ignores EXIF orientation, so we rotate once here; OCR boxes,
// painting and the output then all share one upright coordinate space (spike S5).
import exifr from "exifr";
import * as mupdf from "mupdf";

/** Tags that reveal who, where, when or with what. Structural tags (ImageWidth, BitDepth…) are ignored. */
const PRIVACY_TAGS = [
  "Make", "Model", "Software", "Artist", "Copyright", "HostComputer", "OwnerName", "CameraOwnerName",
  "BodySerialNumber", "SerialNumber", "LensSerialNumber", "LensModel", "ImageUniqueID", "UserComment",
  "ImageDescription", "XPAuthor", "XPComment", "XPSubject", "XPTitle", "XPKeywords",
  "DateTimeOriginal", "CreateDate", "DateTimeDigitized", "ModifyDate",
  "creator", "Creator", "By-line", "City", "Country", "Location", "description", "title", "Keywords", "CreatorTool",
] as const;

export interface ImageMeta {
  /** Raw values, worker-internal only. */
  tags: Record<string, string>;
  gps: { lat: number; lon: number } | null;
  orientation: number;
}

export async function readImageMeta(bytes: Uint8Array): Promise<ImageMeta> {
  let raw: Record<string, unknown> | undefined;
  try {
    raw = await exifr.parse(bytes, { tiff: true, exif: true, gps: true, xmp: true, iptc: true, icc: false, translateValues: false });
  } catch {
    raw = undefined; // Corrupt metadata: report nothing rather than guess.
  }
  const tags: Record<string, string> = {};
  for (const k of PRIVACY_TAGS) {
    const v = raw?.[k];
    if (v !== undefined && v !== null && String(v).trim()) tags[k] = v instanceof Date ? v.toISOString() : String(v);
  }
  const lat = raw?.["latitude"];
  const lon = raw?.["longitude"];
  const orientation = Number(raw?.["Orientation"] ?? 1);
  return {
    tags,
    gps: typeof lat === "number" && typeof lon === "number" && Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null,
    orientation: orientation >= 1 && orientation <= 8 ? orientation : 1,
  };
}

/** Decodes to an upright RGB pixmap (no alpha). */
export function decodeUpright(bytes: Uint8Array, orientation: number): mupdf.Pixmap {
  const src = new mupdf.Image(bytes).toPixmap().convertToColorSpace(mupdf.ColorSpace.DeviceRGB, false);
  return orientation === 1 ? src : reorient(src, orientation);
}

function reorient(src: mupdf.Pixmap, o: number): mupdf.Pixmap {
  const W = src.getWidth();
  const H = src.getHeight();
  const swap = o >= 5;
  const dst = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, swap ? H : W, swap ? W : H], false);
  // Copy out first: the WASM heap view can be invalidated by later allocations.
  const s = new Uint8Array(src.getPixels());
  const sStride = src.getStride();
  const d = dst.getPixels();
  const dStride = dst.getStride();
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      // EXIF orientation: where the stored pixel (x, y) lands in the upright image.
      const [dx, dy] =
        o === 2 ? [W - 1 - x, y] :
        o === 3 ? [W - 1 - x, H - 1 - y] :
        o === 4 ? [x, H - 1 - y] :
        o === 5 ? [y, x] :
        o === 6 ? [H - 1 - y, x] :
        o === 7 ? [H - 1 - y, W - 1 - x] :
        [y, W - 1 - x]; // 8
      const si = y * sStride + x * 3;
      const di = dy * dStride + dx * 3;
      d[di] = s[si]!; d[di + 1] = s[si + 1]!; d[di + 2] = s[si + 2]!;
    }
  }
  return dst;
}
