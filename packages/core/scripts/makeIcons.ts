// Renders the RedactGuard icon (navy shield, white page, one line blacked out) to PNG sizes for the
// extension and an SVG for the Web Lab. Drawn as PDF vector operators because this MuPDF build has
// no SVG input. Run: node --experimental-strip-types scripts/makeIcons.ts
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as mupdf from "mupdf";

const NAVY = "#163A5F", PAGE = "#FFFFFF", LINE = "#9AA7B6", BAR = "#1B2A3A";
// Shapes in a 128×128 box, y pointing down (SVG convention); converted to PDF space below.
const SHIELD = "M64 8 L112 24 L112 60 C112 92 92 112 64 122 C36 112 16 92 16 60 L16 24 Z";
const shapes = (detail: boolean) => [
  { d: SHIELD, fill: NAVY },
  { rect: [38, 32, 52, 64, 7] as const, fill: PAGE },
  ...(detail ? [{ rect: [46, 44, 36, 6, 3] as const, fill: LINE }, { rect: [46, 78, 28, 6, 3] as const, fill: LINE }] : []),
  // The redaction bar: the one thing that must read even at 16 px.
  { rect: (detail ? [46, 57, 36, 12, 2] : [44, 52, 40, 22, 3]) as readonly [number, number, number, number, number], fill: BAR },
];

const rgb = (hex: string) => [1, 3, 5].map((i) => (parseInt(hex.slice(i, i + 2), 16) / 255).toFixed(4)).join(" ");
const flip = (y: number) => 128 - y;

function roundedRect([x, y, w, h, r]: readonly [number, number, number, number, number]): string {
  // Bézier circle constant for quarter arcs.
  const k = r * 0.5523, x1 = x + w, y1 = y + h;
  const p = (px: number, py: number) => `${px} ${flip(py)}`;
  return [`${p(x + r, y)} m`, `${p(x1 - r, y)} l`, `${p(x1 - r + k, y)} ${p(x1, y + r - k)} ${p(x1, y + r)} c`, `${p(x1, y1 - r)} l`,
    `${p(x1, y1 - r + k)} ${p(x1 - r + k, y1)} ${p(x1 - r, y1)} c`, `${p(x + r, y1)} l`, `${p(x + r - k, y1)} ${p(x, y1 - r + k)} ${p(x, y1 - r)} c`,
    `${p(x, y + r)} l`, `${p(x, y + r - k)} ${p(x + r - k, y)} ${p(x + r, y)} c`, "h"].join(" ");
}

function svgPathToPdf(d: string): string {
  const tokens = d.match(/[MLCZ]|-?\d+(\.\d+)?/g) ?? [];
  const out: string[] = [];
  for (let i = 0; i < tokens.length; ) {
    const t = tokens[i++]!;
    const num = () => Number(tokens[i++]);
    if (t === "M") { const x = num(), y = num(); out.push(`${x} ${flip(y)} m`); }
    else if (t === "L") { const x = num(), y = num(); out.push(`${x} ${flip(y)} l`); }
    else if (t === "C") { const v = [num(), num(), num(), num(), num(), num()]; out.push(`${v[0]} ${flip(v[1]!)} ${v[2]} ${flip(v[3]!)} ${v[4]} ${flip(v[5]!)} c`); }
    else if (t === "Z") out.push("h");
  }
  return out.join(" ");
}

function render(size: number): Uint8Array {
  const ops = shapes(size >= 32).map((s) => `${rgb(s.fill)} rg ${"d" in s ? svgPathToPdf(s.d!) : roundedRect(s.rect)} f`).join("\n");
  const doc = new mupdf.PDFDocument();
  doc.insertPage(-1, doc.addPage([0, 0, 128, 128], 0, {}, ops));
  return doc.loadPage(0).toPixmap(mupdf.Matrix.scale(size / 128, size / 128), mupdf.ColorSpace.DeviceRGB, true).asPNG();
}

function svg(): string {
  const body = shapes(true).map((s) => ("d" in s ? `<path d="${s.d}" fill="${s.fill}"/>` : `<rect x="${s.rect[0]}" y="${s.rect[1]}" width="${s.rect[2]}" height="${s.rect[3]}" rx="${s.rect[4]}" fill="${s.fill}"/>`)).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" role="img" aria-label="RedactGuard">${body}</svg>\n`;
}

const root = fileURLToPath(new URL("../../../", import.meta.url));
const extDir = `${root}apps/extension/public/icons/`;
mkdirSync(extDir, { recursive: true });
for (const size of [16, 32, 48, 128]) writeFileSync(`${extDir}icon${size}.png`, render(size));
writeFileSync(`${root}apps/weblab/public/logo.svg`, svg());
console.log("icons written: apps/extension/public/icons/icon{16,32,48,128}.png, apps/weblab/public/logo.svg");
