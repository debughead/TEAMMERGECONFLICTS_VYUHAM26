import { describe, expect, it } from "vitest";
import * as mupdf from "mupdf";
import { redact, scan } from "../src/index.ts";
import { box, pdfFromContent, textOp } from "./helpers/pdf.ts";

const OPTS = { profile: "lab", context: null, ocrPageCap: 0, trustedSite: false } as const;
const text = (b: Uint8Array) => mupdf.Document.openDocument(b, "application/pdf").loadPage(0).toStructuredText("preserve-whitespace").asText();

describe("removing a value removes every copy", () => {
  it("a secret hidden under a box and repeated in plain text elsewhere is gone everywhere", async () => {
    // Only the boxed copy is detectable (forensic); the plain copy isn't an ID or a name.
    const bytes = pdfFromContent(
      textOp(72, 700, 12, "Ref code: ZQX-7781-KLM") + box(130, 696, 110, 16) +
      textOp(72, 640, 12, "Quote ZQX-7781-KLM when you call") +
      textOp(72, 600, 12, "Unrelated line stays"),
    );
    const result = await scan(bytes, OPTS);
    expect(result.findings.filter((f) => f.source === "under_black_box" || f.type === "hidden_content").length).toBeGreaterThan(0);
    const out = await redact(result.scanId, { selectedIds: result.findings.map((f) => f.id), watermark: null });
    expect(out.verify.passed).toBe(true);
    const after = text(out.bytes!);
    expect(after).not.toContain("ZQX-7781-KLM");
    expect(after).toContain("Unrelated line stays");
    expect(after).toContain("when you call");
  });

  it("an unselected copy of the same value is kept (user's choice)", async () => {
    const bytes = pdfFromContent(textOp(72, 700, 12, "PAN ABCPE1234F") + textOp(72, 660, 12, "PAN again ABCPE1234F"));
    const result = await scan(bytes, OPTS);
    const pans = result.findings.filter((f) => f.type === "pan");
    expect(pans.length).toBe(2);
    const out = await redact(result.scanId, { selectedIds: [pans[0]!.id], watermark: null });
    expect(out.verify.passed).toBe(true);
    expect(text(out.bytes!)).toContain("ABCPE1234F");
  });
});

describe("metadata that repeats visible text", () => {
  it("removing the Title property doesn't require deleting the visible heading", async () => {
    const bytes = pdfFromContent(textOp(72, 740, 14, "Quarterly Plan Overview") + textOp(72, 700, 12, "Body text"), (doc) => {
      doc.setMetaData("info:Title", "Quarterly Plan Overview");
    });
    const result = await scan(bytes, OPTS);
    const out = await redact(result.scanId, { selectedIds: result.findings.map((f) => f.id), watermark: null });
    expect(out.verify.passed).toBe(true);
    expect(text(out.bytes!)).toContain("Quarterly Plan Overview");
    expect(mupdf.Document.openDocument(out.bytes!, "application/pdf").getMetaData("info:Title") ?? "").toBe("");
  });
});
