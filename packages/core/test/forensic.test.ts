import { describe, expect, it } from "vitest";
import { hiddenChars, hiddenRuns } from "../src/detect/forensic.ts";
import { extractPdf, openPdf } from "../src/extract/pdf.ts";
import { box, pdfFromContent, textOp } from "./helpers/pdf.ts";

function analyse(bytes: Uint8Array) {
  const page = extractPdf(openPdf(bytes)).pages[0]!;
  const hidden = hiddenChars(page);
  const runs = hiddenRuns(page, hidden).map((r) => ({ text: page.text.slice(r.start, r.end), reason: r.reason }));
  return { page, hidden, runs };
}

describe("forensic: hidden text", () => {
  it("box drawn after the text hides it (positive)", () => {
    const { runs } = analyse(pdfFromContent(textOp(72, 700, 12, "Visible SECRET99") + box(108, 696, 80, 16)));
    expect(runs).toEqual([{ text: "SECRET99", reason: "under_black_box" }]);
  });

  it("white text on a dark header bar is visible (negative control)", () => {
    const { runs } = analyse(pdfFromContent(box(60, 690, 300, 24) + textOp(72, 698, 12, "Account Summary", 1)));
    expect(runs).toEqual([]);
  });

  it("black text on a black bar drawn underneath is a black highlight", () => {
    const { runs } = analyse(pdfFromContent(box(60, 694, 200, 18) + textOp(72, 698, 12, "HIDDEN TEXT", 0)));
    expect(runs).toEqual([{ text: "HIDDEN TEXT", reason: "black_highlight" }]);
  });

  it("dark text on a light badge that sits on a dark band is visible (negative control)", () => {
    // A logo letter: dark band, then a light square, then dark text on the square.
    const { runs } = analyse(pdfFromContent(box(0, 680, 400, 60) + box(60, 690, 40, 40, 0.9) + textOp(70, 702, 20, "T", 0.1)));
    expect(runs).toEqual([]);
  });

  it("black text on a black bar is still a highlight when a light panel lies further below", () => {
    const { runs } = analyse(pdfFromContent(box(40, 670, 400, 60, 0.95) + box(60, 694, 200, 18) + textOp(72, 698, 12, "HIDDEN TEXT", 0)));
    expect(runs).toEqual([{ text: "HIDDEN TEXT", reason: "black_highlight" }]);
  });

  it("an opaque mid-grey box over text hides it, like a black or white one (decided 2026-10-31)", () => {
    const { runs } = analyse(pdfFromContent(textOp(72, 700, 12, "Total 1200") + box(60, 696, 120, 16, 0.6)));
    expect(runs).toEqual([{ text: "Total 1200", reason: "covered" }]);
  });

  it("a see-through grey box over text doesn't hide it (negative control)", () => {
    const bytes = pdfFromContent(textOp(72, 700, 12, "Total 1200") + "q /Half gs 0.6 g 60 696 120 16 re f Q\n", (doc) => {
      const res = doc.findPage(0).get("Resources");
      const gs = doc.newDictionary();
      gs.put("Half", doc.addObject({ Type: "ExtGState", ca: 0.5 }));
      res.put("ExtGState", gs);
    });
    expect(analyse(bytes).runs).toEqual([]);
  });

  it("a box that only grazes text (under 60% coverage) doesn't count", () => {
    // Box covers only the bottom few points of the line.
    const { runs } = analyse(pdfFromContent(textOp(72, 700, 12, "Name line") + box(60, 694, 200, 5)));
    expect(runs).toEqual([]);
  });

  it("an unapplied Redact annotation marks its text", () => {
    const bytes = pdfFromContent(textOp(72, 700, 12, "Mobile 9876543210"), (doc) => {
      const a = doc.loadPage(0).createAnnotation("Redact");
      a.setRect([110, 80, 200, 98]); // page space: PDF y 694..712 → 80..98
      a.update();
    });
    const { runs } = analyse(bytes);
    expect(runs).toEqual([{ text: "9876543210", reason: "unapplied_annot" }]);
  });

  it("a dark Square annotation covering text hides it", () => {
    const bytes = pdfFromContent(textOp(72, 700, 12, "PIN 682001"), (doc) => {
      const a = doc.loadPage(0).createAnnotation("Square");
      a.setRect([90, 80, 150, 98]);
      a.setInteriorColor([0, 0, 0]);
      a.update();
    });
    expect(analyse(bytes).runs).toEqual([{ text: "682001", reason: "under_black_box" }]);
  });
});
