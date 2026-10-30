// Phase 0: places a PDF keeps text or data that no viewer shows (or that the visible-text pass
// missed): off-page text, switched-off layers, invisible text, form values, comments, and camera
// metadata in embedded photos. Every case is checked independently of our own extraction by
// decompressing the redacted output and searching its raw bytes. Fake data only.
import { describe, expect, it } from "vitest";
import exifr from "exifr";
import * as mupdf from "mupdf";
import piexif from "piexifjs";
import { findIds } from "../src/detect/patterns.ts";
import { extractPdf, openPdf } from "../src/extract/pdf.ts";
import { redact, scan } from "../src/index.ts";
import { stripJpegMetadata } from "../src/redact/jpegMeta.ts";
import { verifyPdf } from "../src/verify.ts";
import { FAKE, aadhaarSpaced } from "../scripts/sampleData.ts";
import { pdfFromContent, textOp } from "./helpers/pdf.ts";

const OPTS = { profile: "lab", context: null, ocrPageCap: 0, trustedSite: false } as const;
const AADHAAR = aadhaarSpaced(FAKE.aadhaar);
const SECRET = "ZQXSECRET7781";

/** Every byte of the file with streams decompressed and whitespace removed: where a leak would show. */
function rawText(bytes: Uint8Array): string {
  const doc = new mupdf.PDFDocument(bytes);
  return Buffer.from(doc.saveToBuffer("decompress").asUint8Array()).toString("latin1").replace(/\s/g, "");
}
const visibleText = (bytes: Uint8Array) => mupdf.Document.openDocument(bytes, "application/pdf").loadPage(0).toStructuredText("preserve-whitespace").asText();

/** A page with an optional-content group OC1; `hidden` switches it off in the default configuration. */
function layeredPdf(content: string, hidden: boolean): Uint8Array {
  const doc = new mupdf.PDFDocument();
  const ocg = doc.addObject({ Type: "OCG", Name: "Notes" });
  const res = doc.addObject({ Font: { F1: doc.addSimpleFont(new mupdf.Font("Helvetica")) }, Properties: { OC1: ocg } });
  doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, res, textOp(72, 740, 12, "Visible heading") + content));
  const ocp = doc.newDictionary();
  const ocgs = doc.newArray(); ocgs.push(ocg); ocp.put("OCGs", ocgs);
  const d = doc.newDictionary();
  const list = doc.newArray(); list.push(ocg); d.put(hidden ? "OFF" : "ON", list);
  ocp.put("D", d);
  doc.getTrailer().get("Root").put("OCProperties", ocp);
  return doc.saveToBuffer("").asUint8Array().slice();
}
const inLayer = (s: string) => `/OC /OC1 BDC ${textOp(72, 700, 12, s)}EMC\n`;

async function redactAll(bytes: Uint8Array) {
  const result = await scan(bytes, OPTS);
  const out = await redact(result.scanId, { selectedIds: result.findings.filter((f) => f.redactable).map((f) => f.id), watermark: null });
  return { result, out };
}

describe("text placed outside the page", () => {
  it("is reported as hidden, and redaction removes it (positive)", async () => {
    const bytes = pdfFromContent(textOp(72, 740, 12, "Visible heading") + textOp(-400, 700, 12, `Aadhaar ${AADHAAR}`));
    const { result, out } = await redactAll(bytes);
    expect(result.findings.some((f) => f.type === "aadhaar" && f.source === "hidden_office")).toBe(true);
    expect(result.findings.some((f) => f.type === "hidden_content" && /outside the visible page/.test(f.reason))).toBe(true);
    expect(out.verify.passed).toBe(true);
    expect(rawText(out.bytes!)).not.toContain(FAKE.aadhaar);
    expect(visibleText(out.bytes!)).toContain("Visible heading");
  });

  it("is removed even when the user unticks it: nobody can legitimately need invisible text", async () => {
    const bytes = pdfFromContent(textOp(72, 740, 12, "Visible heading") + textOp(72, -300, 12, SECRET));
    const result = await scan(bytes, OPTS);
    const out = await redact(result.scanId, { selectedIds: [], watermark: null });
    expect(out.verify.passed).toBe(true);
    expect(rawText(out.bytes!)).not.toContain(SECRET);
  });

  it("text near the edge but on the page is not hidden (negative)", async () => {
    const result = await scan(pdfFromContent(textOp(2, 780, 10, "Edge note") + textOp(560, 4, 10, "p. 1")), OPTS);
    expect(result.findings.filter((f) => f.source === "hidden_office")).toEqual([]);
  });
});

describe("text in a switched-off layer", () => {
  it("is reported, removed when selected, and the scan leaves the layer state untouched", async () => {
    const bytes = layeredPdf(inLayer(`Aadhaar ${AADHAAR}`), true);
    const doc = openPdf(bytes);
    const ex = extractPdf(doc);
    expect(ex.hiddenLayerCount).toBe(1);
    expect(ex.pages[0]!.hiddenLayer.text).toContain(AADHAAR);
    expect(ex.pages[0]!.text).not.toContain(AADHAAR);
    expect(doc.isLayerVisible(0)).toBe(false); // restored after extraction

    const { result, out } = await redactAll(bytes);
    expect(result.findings.some((f) => f.type === "aadhaar" && /switched-off layer/.test(f.reason))).toBe(true);
    expect(out.verify.passed).toBe(true);
    expect(rawText(out.bytes!)).not.toContain(FAKE.aadhaar);
  });

  it("left unselected, it becomes visible in the output instead of staying hidden in the file", async () => {
    const bytes = layeredPdf(inLayer("Internal review notes"), true);
    const result = await scan(bytes, OPTS);
    const out = await redact(result.scanId, { selectedIds: [], watermark: null });
    expect(out.verify.passed).toBe(true);
    expect(visibleText(out.bytes!)).toContain("Internal review notes");
  });

  it("verify refuses a file that still has a switched-off layer with text", async () => {
    const bytes = layeredPdf(inLayer(SECRET), true);
    const report = await verifyPdf(bytes, { redactedRects: new Map(), removedValues: [] });
    expect(report.checks.find((c) => c.name === "no_text_in_redacted_areas")?.passed).toBe(false);
  });

  it("a layer that is switched on is ordinary visible text (negative)", async () => {
    const result = await scan(layeredPdf(inLayer("Shown legend text"), false), OPTS);
    expect(result.findings.filter((f) => f.source === "hidden_office")).toEqual([]);
  });
});

describe("invisible text on the page", () => {
  it("white text on a white page is hidden (positive)", async () => {
    const { result, out } = await redactAll(pdfFromContent(textOp(72, 740, 12, "Visible heading") + textOp(72, 700, 12, SECRET, 1)));
    expect(result.findings.some((f) => f.type === "hidden_content" && /same colour as its background/.test(f.reason))).toBe(true);
    expect(out.verify.passed).toBe(true);
    expect(rawText(out.bytes!)).not.toContain(SECRET);
  });

  it("a light-grey watermark is visible, not hidden (negative)", async () => {
    const result = await scan(pdfFromContent(textOp(72, 400, 48, "DRAFT", 0.85)), OPTS);
    expect(result.findings.filter((f) => f.type === "hidden_content")).toEqual([]);
  });

  it("text under 1 pt tall is hidden (positive); 6 pt footnote text is not (negative)", async () => {
    const tiny = await scan(pdfFromContent(textOp(72, 700, 0.5, SECRET)), OPTS);
    expect(tiny.findings.some((f) => /too small to see/.test(f.reason))).toBe(true);
    const small = await scan(pdfFromContent(textOp(72, 700, 6, "Terms apply")), OPTS);
    expect(small.findings.filter((f) => f.type === "hidden_content")).toEqual([]);
  });
});

/** A text field with a value, as a filled-in form stores it (no appearance stream needed). */
function formPdf(fields: { name: string; value: string; rect: [number, number, number, number] }[]): Uint8Array {
  return pdfFromContent(textOp(72, 740, 12, "Application form"), (doc) => {
    const page = doc.findPage(0);
    const annots = doc.newArray();
    const all = doc.newArray();
    for (const f of fields) {
      const w = doc.addObject({ FT: "Tx", Subtype: "Widget", Type: "Annot", Rect: f.rect, DA: "/Helv 11 Tf 0 g" });
      w.put("T", doc.newString(f.name)); w.put("V", doc.newString(f.value)); w.put("P", page);
      annots.push(w); all.push(w);
    }
    page.put("Annots", annots);
    const af = doc.newDictionary(); af.put("Fields", all);
    doc.getTrailer().get("Root").put("AcroForm", af);
  });
}

describe("form field values", () => {
  it("are scanned like page text; a selected value is removed and the others stay visible", async () => {
    const bytes = formPdf([
      { name: "aadhaar", value: AADHAAR, rect: [72, 600, 320, 620] },
      { name: "city", value: "Kochi", rect: [72, 560, 320, 580] },
    ]);
    const result = await scan(bytes, OPTS);
    const id = result.findings.find((f) => f.type === "aadhaar");
    expect(id).toMatchObject({ source: "text" });
    expect(id!.rects.length).toBe(1);
    const out = await redact(result.scanId, { selectedIds: [id!.id], watermark: null });
    expect(out.verify.passed).toBe(true);
    expect(rawText(out.bytes!)).not.toContain(FAKE.aadhaar);
    expect(visibleText(out.bytes!)).toContain("Kochi");
  });

  it("an empty form produces no form findings (negative)", async () => {
    const result = await scan(formPdf([{ name: "notes", value: "", rect: [72, 600, 320, 620] }]), OPTS);
    expect(result.findings).toEqual([]);
  });
});

describe("comments", () => {
  it("comment text and its author are reported; the output has neither", async () => {
    const bytes = pdfFromContent(textOp(72, 740, 12, "Quarterly report"), (doc) => {
      const a = doc.loadPage(0).createAnnotation("Text");
      a.setRect([72, 600, 90, 618]); a.setContents(`Customer Aadhaar ${AADHAAR}`); a.setAuthor("Fake Reviewer"); a.update();
    });
    const { result, out } = await redactAll(bytes);
    expect(result.findings.some((f) => f.type === "aadhaar" && f.source === "hidden_office" && f.rects.length === 0)).toBe(true);
    expect(result.findings.some((f) => f.type === "hidden_content" && f.masked.startsWith("Comment"))).toBe(true);
    expect(result.findings.some((f) => f.masked.startsWith("Comment author"))).toBe(true);
    expect(out.verify.passed).toBe(true);
    const raw = rawText(out.bytes!);
    expect(raw).not.toContain(FAKE.aadhaar);
    expect(raw).not.toContain("FakeReviewer");
  });

  it("a link annotation is not a comment (negative)", async () => {
    const bytes = pdfFromContent(textOp(72, 740, 12, "See site"), (doc) => {
      doc.loadPage(0).createLink([72, 40, 140, 60], "https://example.com");
    });
    const result = await scan(bytes, OPTS);
    expect(result.findings.filter((f) => f.masked.startsWith("Comment"))).toEqual([]);
  });
});

// ---------- Photos inside PDFs ----------

const toBin = (b: Uint8Array) => Buffer.from(b).toString("latin1");
const fromBin = (s: string) => new Uint8Array(Buffer.from(s, "latin1"));

function photo(withExif: boolean): Uint8Array {
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 64, 48], false);
  pix.clear(200);
  const jpeg = pix.asJPEG(90).slice();
  if (!withExif) return jpeg;
  const exif = piexif.dump({
    "0th": { [piexif.ImageIFD.Make]: FAKE.camera.make, [piexif.ImageIFD.Model]: FAKE.camera.model },
    GPS: {
      [piexif.GPSIFD.GPSLatitudeRef]: "N", [piexif.GPSIFD.GPSLatitude]: piexif.GPSHelper.degToDmsRational(FAKE.gps.lat),
      [piexif.GPSIFD.GPSLongitudeRef]: "E", [piexif.GPSIFD.GPSLongitude]: piexif.GPSHelper.degToDmsRational(FAKE.gps.lon),
    },
  });
  return fromBin(piexif.insert(exif, toBin(jpeg)));
}

function photoPdf(jpeg: Uint8Array): Uint8Array {
  const doc = new mupdf.PDFDocument();
  const img = doc.addImage(new mupdf.Image(jpeg));
  const res = doc.addObject({ XObject: { Im0: img } });
  doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, res, "q 400 0 0 300 100 400 cm /Im0 Do Q\n"));
  return doc.saveToBuffer("compress").asUint8Array().slice();
}

/** The first image stream's raw bytes, read with MuPDF directly (not through our extraction code). */
function firstImageBytes(pdf: Uint8Array): Uint8Array {
  const doc = new mupdf.PDFDocument(pdf);
  for (let n = 1; n < doc.countObjects(); n++) {
    const ref = doc.newIndirect(n);
    if (ref.isStream() && ref.resolve().get("Subtype").asName() === "Image") return ref.readRawStream().asUint8Array().slice();
  }
  throw new Error("no image");
}

describe("GPS and camera details in photos inside a PDF", () => {
  it("are reported with a coarse map location (positive)", async () => {
    const result = await scan(photoPdf(photo(true)), OPTS);
    expect(result.findings.some((f) => f.type === "gps")).toBe(true);
    expect(result.findings.some((f) => f.masked.startsWith("Photo Make"))).toBe(true);
    expect(result.gps).toEqual({ coarseLat: 9.9, coarseLon: 76.3 });
  });

  it("are stripped on redaction without touching the pixels (checked with exifr directly)", async () => {
    const input = photoPdf(photo(true));
    const result = await scan(input, OPTS);
    const out = await redact(result.scanId, { selectedIds: [], watermark: null });
    expect(out.verify.passed).toBe(true);
    expect(out.verify.checks.find((c) => c.name === "no_image_metadata")?.detail).toMatch(/No EXIF/);
    const after = firstImageBytes(out.bytes!);
    expect(await exifr.gps(after).catch(() => undefined)).toBeUndefined();
    const before = new mupdf.Image(firstImageBytes(input)).toPixmap().getPixels().slice();
    expect(new mupdf.Image(after).toPixmap().getPixels().slice()).toEqual(before);
  });

  it("verify refuses a PDF whose photo still has GPS", async () => {
    const report = await verifyPdf(photoPdf(photo(true)), { redactedRects: new Map(), removedValues: [] });
    expect(report.checks.find((c) => c.name === "no_image_metadata")?.passed).toBe(false);
  });

  it("a photo without metadata produces no location finding (negative)", async () => {
    const result = await scan(photoPdf(photo(false)), OPTS);
    expect(result.findings.filter((f) => f.type === "gps" || f.masked.startsWith("Photo"))).toEqual([]);
    expect(result.gps).toBeNull();
  });
});

describe("stripJpegMetadata", () => {
  it("drops EXIF, comments and trailing data but keeps the image decodable and identical", () => {
    const withExif = photo(true);
    // Add a COM segment after SOI and a phone-style trailer after the end-of-image marker.
    const com = new Uint8Array([0xff, 0xfe, 0x00, 0x0a, ...Buffer.from("SECRETCOM")]).subarray(0, 12);
    const tagged = new Uint8Array([...withExif.subarray(0, 2), ...com, ...withExif.subarray(2), ...Buffer.from("TRAILER-SECRET")]);
    const clean = stripJpegMetadata(tagged)!;
    const s = Buffer.from(clean).toString("latin1");
    expect(s).not.toContain("Exif");
    expect(s).not.toContain("SECRETCO");
    expect(s).not.toContain("TRAILER-SECRET");
    expect(new mupdf.Image(clean).toPixmap().getPixels().slice()).toEqual(new mupdf.Image(withExif).toPixmap().getPixels().slice());
  });

  it("returns null for bytes that aren't a JPEG it can walk (never guesses)", () => {
    expect(stripJpegMetadata(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
    expect(stripJpegMetadata(new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff]))).toBeNull(); // segment runs past the end
  });
});

describe("account numbers abbreviated as AC", () => {
  it("'LOAN AC 7781200045' is an account, not a phone number (positive)", () => {
    const m = findIds("HOME LOAN EMI - LOAN AC 7781200045");
    expect(m.map((x) => x.type)).toEqual(["account"]);
  });
  it("a labelled mobile number is still a phone number (negative)", () => {
    expect(findIds("Mobile 9876543210").map((x) => x.type)).toEqual(["phone"]);
  });
});

// ---------- Phase 0b: text hidden by something painted over it, or clipped away ----------

/** Adds a 20x20 light-grey image XObject /Im0 and appends `ops` as a second content stream. */
function withImage(content: string, ops: string, grey = 230): Uint8Array {
  return pdfFromContent(content, (doc) => {
    const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 20, 20], false);
    pix.clear(grey);
    const page = doc.findPage(0);
    const xo = doc.newDictionary();
    xo.put("Im0", doc.addImage(new mupdf.Image(pix)));
    page.get("Resources").put("XObject", xo);
    const parts = doc.newArray();
    parts.push(page.get("Contents"));
    parts.push(doc.addStream(ops, {}));
    page.put("Contents", parts);
  });
}

describe("text covered or clipped", () => {
  const head = textOp(72, 740, 12, "Visible heading");

  it.each([
    ["a white box drawn over it (whiteout)", pdfFromContent(head + textOp(72, 700, 12, SECRET) + "q 1 g 60 690 200 24 re f Q\n"), /covered by a shape or picture/],
    ["a clipping path that excludes it", pdfFromContent(head + `q 0 0 1 1 re W n ${textOp(72, 700, 12, SECRET)}Q\n`), /cut out of view/],
    ["a picture placed over it", withImage(head + textOp(72, 700, 12, SECRET), "q 200 0 0 24 60 690 cm /Im0 Do Q\n"), /covered by a shape or picture/],
    ["invisible render mode on a blank page", pdfFromContent(head + `BT 3 Tr /F1 12 Tf 72 700 Td (${SECRET}) Tj ET\n`), /set to invisible/],
  ])("%s: reported, removed, verified (positive)", async (_name, bytes, reason) => {
    const { result, out } = await redactAll(bytes);
    expect(result.findings.some((f) => f.type === "hidden_content" && reason.test(f.reason))).toBe(true);
    expect(out.verify.passed).toBe(true);
    expect(rawText(out.bytes!)).not.toContain(SECRET);
    expect(visibleText(out.bytes!)).toContain("Visible heading");
  });

  it("verify refuses a file whose text is still under a whiteout box", async () => {
    const bytes = pdfFromContent(head + textOp(72, 700, 12, SECRET) + "q 1 g 60 690 200 24 re f Q\n");
    const report = await verifyPdf(bytes, { redactedRects: new Map(), removedValues: [] });
    expect(report.checks.find((c) => c.name === "no_text_in_redacted_areas")?.passed).toBe(false);
  });

  it("text on a white panel drawn underneath it is visible (negative)", async () => {
    const result = await scan(pdfFromContent("q 1 g 40 680 300 40 re f Q\n" + textOp(72, 700, 12, "Account summary")), OPTS);
    expect(result.findings.filter((f) => f.type === "hidden_content")).toEqual([]);
  });

  it("an invisible OCR layer over a scanned picture is not hidden text (negative)", async () => {
    const bytes = withImage(head, `q 300 0 0 40 60 690 cm /Im0 Do Q\nBT 3 Tr /F1 12 Tf 72 700 Td (Scanned words) Tj ET\n`);
    const result = await scan(bytes, OPTS);
    expect(result.findings.filter((f) => f.type === "hidden_content")).toEqual([]);
  });

  it("a multiply-blend highlighter drawn over text doesn't hide it (negative)", async () => {
    const bytes = pdfFromContent(textOp(72, 700, 12, "Highlighted line") + "q /Mul gs 1 1 0 rg 60 696 160 16 re f Q\n", (doc) => {
      const gs = doc.newDictionary();
      gs.put("Mul", doc.addObject({ Type: "ExtGState", BM: "Multiply" }));
      doc.findPage(0).get("Resources").put("ExtGState", gs);
    });
    expect((await scan(bytes, OPTS)).findings.filter((f) => f.type === "hidden_content")).toEqual([]);
  });

  it("text inside its clipping area is visible (negative)", async () => {
    const result = await scan(pdfFromContent(`q 40 680 400 40 re W n ${textOp(72, 700, 12, "Cell text")}Q\n`), OPTS);
    expect(result.findings.filter((f) => f.type === "hidden_content")).toEqual([]);
  });
});
