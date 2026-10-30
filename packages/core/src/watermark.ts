// Purpose watermark ("Shared with X for Y, date"). Stamped BEFORE redactions are applied, so any
// watermark glyph that crosses a redacted area is removed with it and verify() never sees text
// inside a redacted rect.
import * as mupdf from "mupdf";
import type { Watermark } from "./schemas.ts";

const FONT_RES = "RGWM";
const GS_RES = "RGGS";
const OPACITY = 0.15;
const GRAY = 0.5;

export function watermarkText(w: Watermark): string {
  return `Shared with ${w.domain} for ${w.purpose}, ${w.date}`;
}

/** The base-14 font only covers Latin-1; anything else becomes "?" rather than garbage glyphs. */
const toPdfLiteral = (s: string) =>
  `(${[...s].map((c) => (c.charCodeAt(0) >= 32 && c.charCodeAt(0) <= 126 ? c : "?")).join("").replace(/[\\()]/g, (c) => `\\${c}`)})`;

export function stampWatermark(doc: mupdf.PDFDocument, w: Watermark): void {
  const text = watermarkText(w);
  const font = doc.addSimpleFont(new mupdf.Font("Helvetica"));
  const gs = doc.addObject({ Type: "ExtGState", ca: OPACITY, CA: OPACITY });

  for (let i = 0; i < doc.countPages(); i++) {
    const page = doc.loadPage(i);
    const obj = page.getObject();
    let res = obj.get("Resources");
    if (res.isNull()) {
      // Inherited resources: give the page its own copy-by-reference so we can add entries.
      const inherited = obj.getInheritable("Resources");
      res = inherited.isNull() ? doc.newDictionary() : inherited;
      obj.put("Resources", res);
    }
    for (const [kind, name, value] of [["Font", FONT_RES, font], ["ExtGState", GS_RES, gs]] as const) {
      if (res.get(kind).isNull()) res.put(kind, doc.newDictionary());
      res.get(kind).put(name, value);
    }

    const [x0, y0, x1, y1] = page.getBounds();
    const width = x1 - x0;
    const height = y1 - y0;
    const angle = Math.atan2(height, width);
    const diagonal = Math.hypot(width, height);
    // Helvetica averages ~0.5em per char; size the line to ~70% of the diagonal.
    const size = Math.max(8, Math.min(36, (diagonal * 0.7) / (text.length * 0.5)));
    const halfLen = (text.length * size * 0.5) / 2;
    const [c, s] = [Math.cos(angle), Math.sin(angle)];
    // PDF user space has a bottom-left origin; start so the line is centred on the page.
    const tx = width / 2 - c * halfLen;
    const ty = height / 2 - s * halfLen;
    const ops = `q /${GS_RES} gs ${GRAY} g BT /${FONT_RES} ${size.toFixed(2)} Tf ${c.toFixed(5)} ${s.toFixed(5)} ${(-s).toFixed(5)} ${c.toFixed(5)} ${tx.toFixed(2)} ${ty.toFixed(2)} Tm ${toPdfLiteral(text)} Tj ET Q\n`;
    const stream = doc.addStream(ops, {});

    const contents = obj.get("Contents");
    if (contents.isArray()) {
      contents.push(stream);
    } else {
      const arr = doc.newArray();
      if (!contents.isNull()) arr.push(contents);
      arr.push(stream);
      obj.put("Contents", arr);
    }
  }
}
