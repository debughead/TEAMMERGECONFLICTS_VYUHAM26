// Spike S2: confirms the MuPDF.js calls the PDF pipeline depends on (see docs/DECISIONS.md).
// Uses only fake text.
import { describe, expect, it } from "vitest";
import * as mupdf from "mupdf";

const FAKE_SECRET = "ACCT 000011112222";
// Fill bounds: a zero-width stroke so the bounds are the path's own geometry.
const NO_STROKE: mupdf.StrokeStateData = { lineCap: "Butt", lineJoin: "Miter", lineWidth: 0, miterLimit: 10 };

/** One-page PDF with visible text, a secret, and a black box drawn over the secret. */
function buildFakeRedactedPdf(): Uint8Array {
  const doc = new mupdf.PDFDocument();
  const font = doc.addSimpleFont(new mupdf.Font("Helvetica"));
  const resources = doc.addObject({ Font: { F1: font } });
  const content =
    "BT /F1 12 Tf 72 720 Td (Statement for Test User) Tj ET\n" +
    `BT /F1 12 Tf 72 690 Td (${FAKE_SECRET}) Tj ET\n` +
    "0 0 0 rg 70 685 130 18 re f\n";
  const page = doc.addPage([0, 0, 612, 792], 0, resources, content);
  doc.insertPage(-1, page);
  return doc.saveToBuffer("").asUint8Array().slice();
}

function pageText(bytes: Uint8Array, pageIndex = 0): string {
  const doc = mupdf.Document.openDocument(bytes, "application/pdf");
  return doc.loadPage(pageIndex).toStructuredText("preserve-whitespace").asText();
}

describe("spike S2: MuPDF.js", () => {
  it("text under a drawn black box is still extractable (the fake-redaction problem)", () => {
    expect(pageText(buildFakeRedactedPdf())).toContain(FAKE_SECRET);
  });

  it("custom Device reports filled paths with bounds and colour", () => {
    const doc = mupdf.Document.openDocument(buildFakeRedactedPdf(), "application/pdf");
    const page = doc.loadPage(0);
    const fills: { rect: mupdf.Rect; color: number[]; alpha: number; cs: string }[] = [];
    const device = new mupdf.Device({
      fillPath(path, _evenOdd, ctm, colorspace, color, alpha) {
        fills.push({
          rect: path.getBounds(new mupdf.StrokeState(NO_STROKE), ctm),
          color: [...color],
          alpha,
          cs: colorspace.getName(),
        });
      },
    });
    page.run(device, mupdf.Matrix.identity);
    device.close();

    expect(fills).toHaveLength(1);
    const [fill] = fills;
    expect(fill?.color).toEqual([0, 0, 0]);
    expect(fill?.alpha).toBe(1);
    // MuPDF page space has a top-left origin: PDF y 685..703 becomes 792-703..792-685.
    // Bounds come back ~1pt larger than the drawn box; the detector uses overlap ratios, so ±1pt is fine.
    const expected = [70, 89, 200, 107];
    fill!.rect.forEach((v, i) => expect(Math.abs(v - expected[i]!)).toBeLessThanOrEqual(1.01));
  });

  it("structured text walk gives per-char quads in the same coordinate space", () => {
    const doc = mupdf.Document.openDocument(buildFakeRedactedPdf(), "application/pdf");
    const chars: { c: string; quad: mupdf.Quad }[] = [];
    doc.loadPage(0).toStructuredText("preserve-whitespace").walk({
      onChar(c, _origin, _font, _size, quad) {
        chars.push({ c, quad });
      },
    });
    const first = chars.find((ch) => ch.c === "A");
    expect(first).toBeDefined();
    // The 'A' of the secret sits inside the black box's y-range.
    const ys = [first!.quad[1], first!.quad[5]];
    expect(Math.min(...ys)).toBeGreaterThan(85);
    expect(Math.max(...ys)).toBeLessThan(110);
  });

  it("Redact annotation + applyRedactions removes the text, and a full rewrite keeps it gone", () => {
    const doc = new mupdf.PDFDocument(buildFakeRedactedPdf());
    const page = doc.loadPage(0);
    const annot = page.createAnnotation("Redact");
    annot.setRect([70, 89, 200, 107]);
    page.applyRedactions(true, mupdf.PDFPage.REDACT_IMAGE_PIXELS);
    const out = doc.saveToBuffer("garbage=4,compress,clean,sanitize").asUint8Array().slice();

    const text = pageText(out);
    expect(text).not.toContain(FAKE_SECRET);
    expect(text).toContain("Statement for Test User");
    const reopened = new mupdf.PDFDocument(out);
    expect(reopened.loadPage(0).getAnnotations()).toHaveLength(0);
    expect(reopened.countVersions()).toBe(1);
    // Raw bytes must not contain the secret either (compressed streams aside, check the plain string).
    expect(Buffer.from(out).toString("latin1")).not.toContain(FAKE_SECRET);
  });

  it("countVersions detects an incremental save", () => {
    const doc = new mupdf.PDFDocument(buildFakeRedactedPdf());
    const page = doc.loadPage(0);
    const annot = page.createAnnotation("Square");
    annot.setRect([10, 10, 50, 50]);
    annot.update();
    const incr = doc.saveToBuffer("incremental").asUint8Array().slice();
    const reopened = new mupdf.PDFDocument(incr);
    expect(reopened.countVersions()).toBe(2);
  });

  it("metadata can be read and the Info dictionary removed", () => {
    const doc = new mupdf.PDFDocument(buildFakeRedactedPdf());
    doc.setMetaData("info:Author", "HR-Dept-Fake");
    const withMeta = doc.saveToBuffer("").asUint8Array().slice();
    const d2 = new mupdf.PDFDocument(withMeta);
    expect(d2.getMetaData("info:Author")).toBe("HR-Dept-Fake");
    d2.getTrailer().delete("Info");
    const cleaned = d2.saveToBuffer("garbage=4,compress").asUint8Array().slice();
    const d3 = mupdf.Document.openDocument(cleaned, "application/pdf");
    expect(d3.getMetaData("info:Author") ?? "").toBe("");
  });
});
