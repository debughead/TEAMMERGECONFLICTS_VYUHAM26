// Builds small synthetic PDFs for detector tests. Content uses PDF user space (bottom-left origin).
import * as mupdf from "mupdf";

export const textOp = (x: number, y: number, size: number, s: string, gray = 0) =>
  `BT ${gray} g /F1 ${size} Tf ${x} ${y} Td (${s.replace(/[\\()]/g, (c) => `\\${c}`)}) Tj ET\n`;
export const box = (x: number, y: number, w: number, h: number, gray = 0) => `q ${gray} g ${x} ${y} ${w} ${h} re f Q\n`;

export function pdfFromContent(content: string, mutate?: (doc: mupdf.PDFDocument) => void): Uint8Array {
  const doc = new mupdf.PDFDocument();
  const font = doc.addSimpleFont(new mupdf.Font("Helvetica"));
  const resources = doc.addObject({ Font: { F1: font } });
  doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, resources, content));
  mutate?.(doc);
  return doc.saveToBuffer("").asUint8Array().slice();
}
