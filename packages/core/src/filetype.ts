// Type sniffing and resource limits, enforced before any heavy library sees the bytes (docs/HLD.md §3.3).
// Never trust File.type or the extension. Never raise a limit without asking (CLAUDE.md).
import type { FileType, LimitProfile } from "./schemas.ts";

export const LIMITS = {
  maxBytes: { extension: 15 * 1024 * 1024, lab: 50 * 1024 * 1024 } satisfies Record<LimitProfile, number>,
  maxPdfPages: 200,
  maxImagePixels: 40_000_000,
  maxZipEntries: 2000,
  maxZipUncompressedBytes: 100 * 1024 * 1024,
  maxZipRatio: 100,
  /** Enforced by the host terminating the worker; exported so hosts share one number. */
  scanTimeoutMs: 60_000,
} as const;

export type LimitCode =
  | "too_large"
  | "unsupported_type"
  | "too_many_pages"
  | "too_many_pixels"
  | "zip_too_many_entries"
  | "zip_too_large"
  | "zip_ratio"
  | "zip_encrypted"
  | "zip_malformed"
  | "encrypted_pdf"
  | "malformed";

export class LimitError extends Error {
  readonly code: LimitCode;
  constructor(code: LimitCode, message: string) {
    super(message);
    this.name = "LimitError";
    this.code = code;
  }
}

export interface SniffResult {
  fileType: FileType;
  /** Present for images. */
  image?: { width: number; height: number };
  /** Present for DOCX/XLSX: entry names from the central directory. */
  zipEntries?: string[];
}

const PDF_HEADER_WINDOW = 1024;

function indexOf(b: Uint8Array, sig: number[]): number {
  for (let i = 0; i + sig.length <= b.length; i++) if (sig.every((v, k) => b[i + k] === v)) return i;
  return -1;
}

/** Sniffs type from magic bytes and enforces every limit that can be checked without parsing. */
export function sniffAndCheck(bytes: Uint8Array, profile: LimitProfile): SniffResult {
  if (bytes.length > LIMITS.maxBytes[profile]) {
    throw new LimitError("too_large", `File is larger than ${LIMITS.maxBytes[profile] / (1024 * 1024)} MB`);
  }
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return { fileType: "pdf" }; // %PDF-
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return checkImage("jpeg", jpegSize(bytes));
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return checkImage("png", pngSize(bytes));
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && ascii(bytes, 8, 4) === "WEBP") {
    return checkImage("webp", webpSize(bytes));
  }
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) return checkOfficeZip(bytes);
  // PDF readers accept a header anywhere in the first 1024 bytes (a BOM, a blank line, mail-gateway junk).
  // Checked last, so a file with a real image or zip signature is never taken for a PDF. The bytes before
  // the header aren't part of the document; redaction writes a fresh file, which leaves them out.
  if (indexOf(bytes.subarray(0, PDF_HEADER_WINDOW), [0x25, 0x50, 0x44, 0x46, 0x2d]) >= 0) return { fileType: "pdf" };
  throw new LimitError("unsupported_type", "Unsupported file type (PDF, JPEG, PNG, WebP, DOCX, XLSX only)");
}

/** Checks a PDF after MuPDF has opened it (opening is lazy; this runs before any page is loaded). */
export function checkPdfLimits(info: { needsPassword: boolean; pageCount: number }): void {
  if (info.needsPassword) throw new LimitError("encrypted_pdf", "Password-protected PDFs can't be scanned");
  if (info.pageCount > LIMITS.maxPdfPages) {
    throw new LimitError("too_many_pages", `PDF has more than ${LIMITS.maxPdfPages} pages`);
  }
}

function checkImage(fileType: FileType, size: { width: number; height: number } | null): SniffResult {
  if (!size || size.width <= 0 || size.height <= 0) throw new LimitError("malformed", "Image header is unreadable");
  if (size.width * size.height > LIMITS.maxImagePixels) {
    throw new LimitError("too_many_pixels", "Image dimensions are too large");
  }
  return { fileType, image: size };
}

function pngSize(b: Uint8Array): { width: number; height: number } | null {
  // IHDR is always the first chunk: length(4) "IHDR"(4) width(4) height(4).
  if (b.length < 24 || ascii(b, 12, 4) !== "IHDR") return null;
  return { width: u32be(b, 16), height: u32be(b, 20) };
}

function jpegSize(b: Uint8Array): { width: number; height: number } | null {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1]!;
    if (marker === 0xff) { i++; continue; } // fill byte
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    const len = u16be(b, i + 2);
    // SOF0..SOF15 except DHT(C4), JPG(C8), DAC(CC) carry the frame size.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: u16be(b, i + 5), width: u16be(b, i + 7) };
    }
    if (len < 2) return null;
    i += 2 + len;
  }
  return null;
}

function webpSize(b: Uint8Array): { width: number; height: number } | null {
  if (b.length < 30) return null;
  const chunk = ascii(b, 12, 4);
  if (chunk === "VP8X") return { width: 1 + u24le(b, 24), height: 1 + u24le(b, 27) };
  if (chunk === "VP8 ") return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
  if (chunk === "VP8L") {
    const bits = u32le(b, 21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  return null;
}

/**
 * Reads the zip central directory (sizes are declared there, so nothing is inflated) and decides
 * DOCX vs XLSX. Declared sizes can lie; the Office extractor must still cap bytes while inflating.
 */
function checkOfficeZip(b: Uint8Array): SniffResult {
  const eocd = findEocd(b);
  if (eocd < 0) throw new LimitError("zip_malformed", "Zip directory not found");
  const total = u16le(b, eocd + 10);
  const cdSize = u32le(b, eocd + 12);
  const cdOffset = u32le(b, eocd + 16);
  if (total === 0xffff || cdOffset === 0xffffffff) throw new LimitError("zip_malformed", "ZIP64 archives aren't supported");
  if (total > LIMITS.maxZipEntries) throw new LimitError("zip_too_many_entries", "Archive has too many entries");
  if (cdOffset + cdSize > b.length) throw new LimitError("zip_malformed", "Zip directory is out of range");

  const names: string[] = [];
  let p = cdOffset;
  let uncompressed = 0;
  let compressed = 0;
  for (let n = 0; n < total; n++) {
    if (p + 46 > b.length || u32le(b, p) !== 0x02014b50) throw new LimitError("zip_malformed", "Zip directory entry is corrupt");
    const flags = u16le(b, p + 8);
    const cSize = u32le(b, p + 20);
    const uSize = u32le(b, p + 24);
    const nameLen = u16le(b, p + 28);
    const extraLen = u16le(b, p + 30);
    const commentLen = u16le(b, p + 32);
    if (flags & 0x1) throw new LimitError("zip_encrypted", "Encrypted Office files can't be scanned");
    if (cSize === 0xffffffff || uSize === 0xffffffff) throw new LimitError("zip_malformed", "ZIP64 entries aren't supported");
    names.push(utf8(b.subarray(p + 46, p + 46 + nameLen)));
    uncompressed += uSize;
    compressed += cSize;
    if (uncompressed > LIMITS.maxZipUncompressedBytes) throw new LimitError("zip_too_large", "Archive expands too large");
    p += 46 + nameLen + extraLen + commentLen;
  }
  if (compressed > 0 && uncompressed / compressed > LIMITS.maxZipRatio) {
    throw new LimitError("zip_ratio", "Archive compression ratio is suspicious");
  }
  if (names.includes("word/document.xml")) return { fileType: "docx", zipEntries: names };
  if (names.includes("xl/workbook.xml")) return { fileType: "xlsx", zipEntries: names };
  throw new LimitError("unsupported_type", "Zip file is not a Word or Excel document");
}

function findEocd(b: Uint8Array): number {
  // EOCD is 22 bytes plus an optional comment of up to 65535 bytes, at the end of the file.
  const stop = Math.max(0, b.length - 22 - 0xffff);
  for (let i = b.length - 22; i >= stop; i--) {
    if (u32le(b, i) === 0x06054b50) return i;
  }
  return -1;
}

function startsWith(b: Uint8Array, sig: number[]): boolean {
  return b.length >= sig.length && sig.every((v, i) => b[i] === v);
}
function ascii(b: Uint8Array, at: number, len: number): string {
  return String.fromCharCode(...b.subarray(at, at + len));
}
function utf8(b: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(b);
}
const u16be = (b: Uint8Array, i: number) => ((b[i] ?? 0) << 8) | (b[i + 1] ?? 0);
const u32be = (b: Uint8Array, i: number) => (u16be(b, i) * 0x10000) + u16be(b, i + 2);
const u16le = (b: Uint8Array, i: number) => (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8);
const u24le = (b: Uint8Array, i: number) => u16le(b, i) | ((b[i + 2] ?? 0) << 16);
const u32le = (b: Uint8Array, i: number) => (u16le(b, i) + u16le(b, i + 2) * 0x10000);
