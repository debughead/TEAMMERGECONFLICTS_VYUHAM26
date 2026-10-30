// Lossless removal of privacy metadata from a JPEG byte stream: the compressed image data is copied
// untouched, so pixels are identical. Used for JPEGs embedded in PDFs, which keep the camera's EXIF
// (GPS, device, time) and are extractable with any PDF tool.

/** APP2 segments that carry an ICC colour profile start with this identifier; other APP2 data (MPF) goes. */
const ICC_ID = [0x49, 0x43, 0x43, 0x5f, 0x50, 0x52, 0x4f, 0x46, 0x49, 0x4c, 0x45, 0x00]; // "ICC_PROFILE\0"

/**
 * Keeps what decoding needs (tables, frame, scans, JFIF, ICC profile, Adobe colour transform) and drops
 * EXIF/XMP (APP1), IPTC (APP13), other APPn, comments, and anything after the end-of-image marker
 * (phone "trailers" and multi-picture secondary images, which carry their own EXIF).
 * Returns null when the bytes aren't a JPEG it can walk safely; callers must treat that as "not cleaned".
 */
export function stripJpegMetadata(b: Uint8Array): Uint8Array | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  const parts: Uint8Array[] = [b.subarray(0, 2)];
  let i = 2;
  for (;;) {
    if (i >= b.length || b[i] !== 0xff) return null;
    let j = i;
    while (j < b.length && b[j] === 0xff) j++; // fill bytes before a marker
    if (j >= b.length) return null;
    const m = b[j]!;
    if (m === 0xd9) { parts.push(b.subarray(j - 1, j + 1)); break; }
    if (m === 0xda) {
      // Start of scan: entropy-coded data follows. Stuffing (FF 00) and restart markers (FF D0-D7) mean
      // the first FF D9 is the true end of image; everything after it is a trailer.
      const eoi = findEoi(b, j + 1);
      if (eoi < 0) return null;
      parts.push(b.subarray(j - 1, eoi + 2));
      break;
    }
    if ((m >= 0xd0 && m <= 0xd7) || m === 0x01) { parts.push(b.subarray(j - 1, j + 1)); i = j + 1; continue; }
    if (j + 2 >= b.length) return null;
    const len = (b[j + 1]! << 8) | b[j + 2]!;
    const end = j + 1 + len;
    if (len < 2 || end > b.length) return null;
    if (keepSegment(m, b.subarray(j + 3, end))) parts.push(b.subarray(j - 1, end));
    i = end;
  }
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function keepSegment(marker: number, payload: Uint8Array): boolean {
  if (marker === 0xfe) return false; // COM: free text
  if (marker < 0xe0 || marker > 0xef) return true; // tables, frame headers, restart interval…
  if (marker === 0xe0 || marker === 0xee) return true; // APP0 JFIF, APP14 Adobe (colour transform)
  if (marker === 0xe2) return ICC_ID.every((v, k) => payload[k] === v);
  return false; // APP1 EXIF/XMP, APP13 IPTC/Photoshop, vendor APPn
}

function findEoi(b: Uint8Array, from: number): number {
  for (let k = from; k + 1 < b.length; k++) {
    if (b[k] === 0xff && b[k + 1] === 0xd9) return k;
  }
  return -1;
}
