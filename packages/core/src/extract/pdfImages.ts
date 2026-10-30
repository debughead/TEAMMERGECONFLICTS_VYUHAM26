// Photos embedded in a PDF keep their camera metadata: a JPEG stored with only DCTDecode is the
// original file byte for byte, EXIF and GPS included, and `pdfimages -j` hands it back out.
import * as mupdf from "mupdf";
import { readImageMeta, type ImageMeta } from "./image.ts";

/** EXIF lives at the start of the file; this is plenty and keeps large photos cheap to check. */
const META_SCAN_BYTES = 512 * 1024;

export interface EmbeddedImageReport {
  /** Object number of the image stream. */
  num: number;
  meta: ImageMeta;
  /** The image dictionary carries its own XMP packet (/Metadata). */
  hasXmpStream: boolean;
}

/** Calls `fn` for every image XObject stream in the file, including ones no page uses any more. */
export function forEachImageStream(doc: mupdf.PDFDocument, fn: (ref: mupdf.PDFObject, num: number) => void): void {
  const n = doc.countObjects();
  for (let num = 1; num < n; num++) {
    const ref = doc.newIndirect(num);
    if (!ref.isStream()) continue;
    const sub = ref.resolve().get("Subtype");
    if (sub.isName() && sub.asName() === "Image") fn(ref, num);
  }
}

/** True when the stream's only filter is DCTDecode, i.e. its raw bytes are a complete JPEG file. */
export function isPlainJpeg(ref: mupdf.PDFObject): boolean {
  const f = ref.resolve().get("Filter");
  if (f.isName()) return f.asName() === "DCTDecode";
  return f.isArray() && f.length === 1 && f.get(0).isName() && f.get(0).asName() === "DCTDecode";
}

/** Embedded images that carry privacy metadata (EXIF/XMP/IPTC tags or GPS, or an XMP stream). */
export async function embeddedImageMetadata(doc: mupdf.PDFDocument): Promise<EmbeddedImageReport[]> {
  const found: { ref: mupdf.PDFObject; num: number }[] = [];
  forEachImageStream(doc, (ref, num) => found.push({ ref, num }));
  const reports: EmbeddedImageReport[] = [];
  for (const { ref, num } of found) {
    const hasXmpStream = !ref.resolve().get("Metadata").isNull();
    let meta: ImageMeta = { tags: {}, gps: null, orientation: 1 };
    if (isPlainJpeg(ref)) {
      const raw = ref.readRawStream().asUint8Array();
      meta = await readImageMeta(raw.slice(0, Math.min(raw.length, META_SCAN_BYTES)));
    }
    if (hasXmpStream || meta.gps || Object.keys(meta.tags).length > 0) reports.push({ num, meta, hasXmpStream });
  }
  return reports;
}
