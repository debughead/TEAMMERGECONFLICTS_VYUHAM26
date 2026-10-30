// Photo forensics (D-030) on synthetic card images: no real ID documents in the repo.
import { describe, expect, it } from "vitest";
import * as mupdf from "mupdf";
import { findBars, findQrCodes, lumPlane } from "../src/detect/imageForensics.ts";
import { recogniseIdCard } from "../src/detect/idCards.ts";
import { redact, scan } from "../src/index.ts";
import { verifyPdf } from "../src/verify.ts";

const OPTS = { profile: "lab", context: null, ocrPageCap: 0, trustedSite: false } as const;

/** Draws PDF operators on a W×H page (PDF user space, origin bottom-left) and renders it to pixels. */
function render(ops: string, W = 640, H = 400): mupdf.Pixmap {
  const doc = new mupdf.PDFDocument();
  const font = doc.addSimpleFont(new mupdf.Font("Helvetica"));
  const res = doc.addObject({ Font: { F1: font } });
  doc.insertPage(-1, doc.addPage([0, 0, W, H], 0, res, `q 0.75 0.85 0.95 rg 0 0 ${W} ${H} re f Q\n${ops}`));
  return doc.loadPage(0).toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false);
}
const plane = (p: mupdf.Pixmap) => lumPlane(p.getPixels(), p.getWidth(), p.getHeight(), p.getStride(), p.getNumberOfComponents());
const text = (x: number, y: number, size: number, s: string) => `BT 0.1 0.15 0.35 rg /F1 ${size} Tf ${x} ${y} Td (${s}) Tj ET\n`;
const bar = (x: number, y: number, w: number, h: number, gray = 0) => `q ${gray} g ${x} ${y} ${w} ${h} re f Q\n`;

/** A QR-like code: three finder squares plus pseudo-random modules (enough for finder detection). */
function qrOps(x: number, y: number, m: number, n = 25): string {
  let ops = "q 1 g " + `${x - m} ${y - m} ${(n + 2) * m} ${(n + 2) * m} re f Q\nq 0 g\n`;
  const finder = (cx: number, cy: number) => {
    ops += `${x + cx * m} ${y + cy * m} ${7 * m} ${7 * m} re f\n`;
    ops += `1 g ${x + (cx + 1) * m} ${y + (cy + 1) * m} ${5 * m} ${5 * m} re f 0 g\n`;
    ops += `${x + (cx + 2) * m} ${y + (cy + 2) * m} ${3 * m} ${3 * m} re f\n`;
  };
  finder(0, 0); finder(n - 7, 0); finder(0, n - 7);
  let seed = 7;
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    const inFinder = (r < 8 && c < 8) || (r < 8 && c >= n - 8) || (r >= n - 8 && c < 8);
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    if (!inFinder && seed % 2 === 0) ops += `${x + c * m} ${y + r * m} ${m} ${m} re f\n`;
  }
  return ops + "Q\n";
}

describe("redaction bars in photos", () => {
  it("an opaque bar that fully covers its text is sound", () => {
    const [b] = findBars(plane(render(text(40, 300, 22, "Name RAHUL FAKENAME") + bar(110, 292, 260, 30))));
    expect(b).toMatchObject({ partial: false, translucent: false });
  });

  it("a bar that is too thin leaves letter tails visible: partial, and the cover area grows over them", () => {
    // Bar covers the upper part of the line only; the lower ~third of the letters shows below it.
    const [b] = findBars(plane(render(text(40, 300, 26, "SECRETNAME HIDDEN") + bar(35, 307, 300, 24))));
    expect(b?.partial).toBe(true);
    expect(b!.coverRect[3]).toBeGreaterThan(b!.rect[3]);
  });

  it("a see-through dark bar is flagged as translucent", () => {
    const ops = text(40, 300, 22, "SECRET 4987 1234") + `q /G gs 0 g 35 292 260 30 re f Q\n`;
    const doc = new mupdf.PDFDocument();
    const font = doc.addSimpleFont(new mupdf.Font("Helvetica"));
    const res = doc.addObject({ Font: { F1: font }, ExtGState: { G: doc.addObject({ Type: "ExtGState", ca: 0.85 }) } });
    doc.insertPage(-1, doc.addPage([0, 0, 640, 400], 0, res, `q 0.95 0.95 0.95 rg 0 0 640 400 re f Q\n${ops}`));
    const pix = doc.loadPage(0).toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false);
    const [b] = findBars(plane(pix));
    expect(b?.translucent).toBe(true);
  });

  it("a dark shadow without crisp edges is not a redaction bar", () => {
    // Soft vertical gradient band: dark but not a painted rectangle.
    let ops = "";
    for (let i = 0; i < 30; i++) ops += bar(0, 100 + i, 640, 1, 0.12 + i * 0.01);
    expect(findBars(plane(render(ops)))).toEqual([]);
  });
});

describe("QR codes", () => {
  it("finds a QR code and boxes all of it", () => {
    const [q] = findQrCodes(plane(render(qrOps(400, 120, 8))));
    expect(q).toBeDefined();
    // Page is 400 high; QR spans PDF y 120..320 → pixel rows 80..280, x 400..600.
    expect(q!.rect[0]).toBeLessThanOrEqual(400);
    expect(q!.rect[2]).toBeGreaterThanOrEqual(600);
    expect(q!.rect[1]).toBeLessThanOrEqual(80);
    expect(q!.rect[3]).toBeGreaterThanOrEqual(280);
  });

  it("ordinary text is not mistaken for a QR code", () => {
    let ops = "";
    for (let i = 0; i < 10; i++) ops += text(30, 360 - i * 32, 20, "INCOME TAX DEPARTMENT 1234 ABCD");
    expect(findQrCodes(plane(render(ops)))).toEqual([]);
  });
});

describe("ID card recognition", () => {
  it.each([
    ["INCOME TAX DEPARTMENT  GOVT. OF INDIA  Permanent Account Number Card", "PAN card"],
    ["Unique Identification Authority of India", "Aadhaar card"],
    ["ELECTION COMMISSION OF INDIA", "Voter ID"],
  ])("%s → %s", (t, kind) => expect(recogniseIdCard(t)?.kind).toBe(kind));

  it("a bank statement isn't an ID card", () => expect(recogniseIdCard("Statement of account, IFSC TEST0001234")).toBeNull());
  it("a form that merely mentions Aadhaar isn't an Aadhaar card", () => expect(recogniseIdCard("SCANNED KYC FORM\nAadhaar: XXXX")).toBeNull());
  it("an Aadhaar card with the government line is recognised", () => expect(recogniseIdCard("Government of India\nAadhaar")?.kind).toBe("Aadhaar card"));
});

/** A card image placed rotated 90° on a portrait page, like macOS Preview does for landscape photos. */
function rotatedCardPdf(): Uint8Array {
  const card = render(text(30, 330, 20, "Name") + text(30, 300, 26, "SECRETNAME HIDDEN") + bar(25, 307, 300, 24) + qrOps(420, 110, 7));
  const doc = new mupdf.PDFDocument();
  const img = doc.addImage(new mupdf.Image(card));
  const res = doc.addObject({ XObject: { Im0: img } });
  // Unit square rotated 90°: image width runs down the page, height across it.
  doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, res, "q 0 -640 400 0 100 760 cm /Im0 Do Q\n"));
  return doc.saveToBuffer("compress").asUint8Array().slice();
}

describe("image-only PDF with a rotated photo", () => {
  it("finds the leaks and removes them in the right place (verified)", async () => {
    const result = await scan(rotatedCardPdf(), OPTS);
    const qr = result.findings.find((f) => f.masked === "QR code");
    const thin = result.findings.find((f) => f.masked === "Redaction bar too thin");
    expect(qr).toBeDefined();
    expect(thin).toBeDefined();
    const out = await redact(result.scanId, { selectedIds: result.findings.filter((f) => f.redactable).map((f) => f.id), watermark: null });
    expect(out.verify.checks.filter((c) => !c.passed)).toEqual([]);
    // Independent check on the output: no QR code left anywhere on the page.
    const page = mupdf.Document.openDocument(out.bytes!, "application/pdf").loadPage(0);
    expect(findQrCodes(plane(page.toPixmap(mupdf.Matrix.scale(2, 2), mupdf.ColorSpace.DeviceRGB, false)))).toEqual([]);
  });

  it("verify FAILS when a requested QR removal didn't actually remove the QR code", async () => {
    // Claim the QR area was redacted on an untouched file: pixels still show it, so verify must refuse.
    const bytes = rotatedCardPdf();
    const result = await scan(bytes, OPTS);
    const qr = result.findings.find((f) => f.masked === "QR code")!;
    const report = await verifyPdf(bytes, { redactedRects: new Map([[0, qr.rects]]), removedValues: [] });
    expect(report.checks.find((c) => c.name === "no_text_in_redacted_areas")?.passed).toBe(false);
  });

  it("a QR code the user chose to keep doesn't block release", async () => {
    const result = await scan(rotatedCardPdf(), OPTS);
    const keepQr = result.findings.filter((f) => f.redactable && f.masked !== "QR code").map((f) => f.id);
    const out = await redact(result.scanId, { selectedIds: keepQr, watermark: null });
    expect(out.verify.passed).toBe(true);
  });
});
