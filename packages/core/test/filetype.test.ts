import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import * as mupdf from "mupdf";
import { checkPdfLimits, LIMITS, LimitError, sniffAndCheck } from "../src/filetype.ts";

function pdfWithPages(n: number, saveOptions = ""): Uint8Array {
  const doc = new mupdf.PDFDocument();
  for (let i = 0; i < n; i++) doc.insertPage(-1, doc.addPage([0, 0, 200, 200], 0, {}, ""));
  return doc.saveToBuffer(saveOptions).asUint8Array().slice();
}

function pixmapBytes(w: number, h: number, kind: "png" | "jpeg"): Uint8Array {
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, w, h], false);
  pix.clear(255);
  return (kind === "png" ? pix.asPNG() : pix.asJPEG(80)).slice();
}

async function zipOf(files: Record<string, string | Uint8Array>): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const [name, data] of Object.entries(files)) zip.file(name, data);
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 9 } });
}

function expectLimit(fn: () => unknown, code: LimitError["code"]): void {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(LimitError);
    expect((e as LimitError).code).toBe(code);
    return;
  }
  throw new Error(`expected LimitError ${code}`);
}

describe("sniffAndCheck", () => {
  it("identifies PDF, PNG and JPEG from bytes, with image sizes", () => {
    expect(sniffAndCheck(pdfWithPages(1), "lab").fileType).toBe("pdf");
    expect(sniffAndCheck(pixmapBytes(30, 20, "png"), "lab")).toEqual({ fileType: "png", image: { width: 30, height: 20 } });
    expect(sniffAndCheck(pixmapBytes(30, 20, "jpeg"), "lab")).toEqual({ fileType: "jpeg", image: { width: 30, height: 20 } });
  });

  it("ignores the file name: a PDF renamed .png is still a PDF", () => {
    // Callers never pass names; the point is that only bytes decide.
    expect(sniffAndCheck(pdfWithPages(1), "extension").fileType).toBe("pdf");
  });

  it("rejects unknown bytes", () => {
    expectLimit(() => sniffAndCheck(new TextEncoder().encode("hello, not a document"), "lab"), "unsupported_type");
  });

  it("enforces the per-profile size limit", () => {
    const big = new Uint8Array(LIMITS.maxBytes.extension + 1);
    big.set([0x25, 0x50, 0x44, 0x46, 0x2d]);
    expectLimit(() => sniffAndCheck(big, "extension"), "too_large");
    expect(sniffAndCheck(big, "lab").fileType).toBe("pdf");
  });

  it("rejects a pixel bomb from the PNG header alone", () => {
    const png = pixmapBytes(10, 10, "png");
    const view = new DataView(png.buffer, png.byteOffset);
    view.setUint32(16, 20_000); // width
    view.setUint32(20, 20_000); // height
    expectLimit(() => sniffAndCheck(png, "lab"), "too_many_pixels");
  });

  it("identifies DOCX and XLSX by their parts", async () => {
    const docx = await zipOf({ "[Content_Types].xml": "<Types/>", "word/document.xml": "<w:document/>" });
    const xlsx = await zipOf({ "[Content_Types].xml": "<Types/>", "xl/workbook.xml": "<workbook/>" });
    expect(sniffAndCheck(docx, "lab").fileType).toBe("docx");
    expect(sniffAndCheck(xlsx, "lab").fileType).toBe("xlsx");
  });

  it("rejects a plain zip that isn't Office", async () => {
    expectLimit(() => sniffAndCheck(new Uint8Array(0), "lab"), "unsupported_type");
    const zip = await zipOf({ "notes.txt": "hi" });
    expectLimit(() => sniffAndCheck(zip, "lab"), "unsupported_type");
  });

  it("rejects a zip bomb by compression ratio before inflating", async () => {
    const bomb = await zipOf({ "word/document.xml": new Uint8Array(20 * 1024 * 1024) });
    expectLimit(() => sniffAndCheck(bomb, "lab"), "zip_ratio");
  });

  it("rejects archives with too many entries", async () => {
    const files: Record<string, string> = { "word/document.xml": "<w:document/>" };
    for (let i = 0; i < LIMITS.maxZipEntries; i++) files[`x/${i}.xml`] = `<a>${i}</a>`;
    const many = await zipOf(files);
    expectLimit(() => sniffAndCheck(many, "lab"), "zip_too_many_entries");
  });
});

describe("checkPdfLimits", () => {
  it("rejects PDFs over the page limit", () => {
    const doc = mupdf.Document.openDocument(pdfWithPages(LIMITS.maxPdfPages + 1), "application/pdf");
    expectLimit(() => checkPdfLimits({ needsPassword: doc.needsPassword(), pageCount: doc.countPages() }), "too_many_pages");
  });

  it("rejects password-protected PDFs", () => {
    const bytes = pdfWithPages(1, "encrypt=aes-256,user-password=fake-pw,owner-password=fake-owner");
    const doc = mupdf.Document.openDocument(bytes, "application/pdf");
    expect(doc.needsPassword()).toBe(true);
    expectLimit(() => checkPdfLimits({ needsPassword: doc.needsPassword(), pageCount: 1 }), "encrypted_pdf");
  });

  it("accepts a normal PDF", () => {
    const doc = mupdf.Document.openDocument(pdfWithPages(3), "application/pdf");
    expect(() => checkPdfLimits({ needsPassword: doc.needsPassword(), pageCount: doc.countPages() })).not.toThrow();
  });
});
