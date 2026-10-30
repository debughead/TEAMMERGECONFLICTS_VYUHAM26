// PP-OCR (PaddleOCR's detection + recognition models, exported to ONNX) as an OcrEngine (D-038).
// Built for text in photos: patterned card backgrounds, uneven light, slight tilt, where Tesseract
// reads nothing (spike S7). The core only does the maths around the models; the host creates the
// ONNX sessions from bundled files, so the core still never loads files or touches the network.
import * as mupdf from "mupdf";
import type { OcrWord } from "../extract/textLayer.ts";
import type { OcrEngine } from "./engine.ts";

/** The slice of an onnxruntime InferenceSession the engine needs (structural; no import of the runtime). */
export interface OnnxSessionLike {
  readonly inputNames: readonly string[];
  readonly outputNames: readonly string[];
  run(feeds: Record<string, never>): Promise<Record<string, { data: unknown; dims: readonly number[] }>>;
}

export interface PaddleModels {
  /** Text detection (DB); PP-OCRv4 mobile. */
  det: OnnxSessionLike;
  /** Text-line recognition (CTC); PP-OCRv5 English. */
  rec: OnnxSessionLike;
  /** Recognition alphabet, one entry per line of the model's dict file. */
  dict: string[];
  /** Wraps data in the runtime's tensor type: (data, dims) => new ort.Tensor("float32", data, dims). */
  tensor: (data: Float32Array, dims: number[]) => unknown;
}

/** Longest side the detector sees; cards and full scanned pages both resolve text at this size. */
const DET_MAX_SIDE = 1536;
/** DB post-processing, PaddleOCR's defaults except a slightly larger unclip for tight card fonts. */
const DET_THRESH = 0.3;
const BOX_THRESH = 0.6;
const UNCLIP = 1.6;
const MIN_BOX_PIXELS = 12;
const REC_HEIGHT = 48;
const REC_MAX_WIDTH = 2560;
/** Words read with less confidence than this are background noise far more often than text. */
const MIN_WORD_CONFIDENCE = 0.5;
/** ImageNet statistics in the BGR channel order the models were trained with. */
const DET_MEAN = [0.406, 0.456, 0.485];
const DET_STD = [0.225, 0.224, 0.229];

interface Rgb { px: Uint8Array; w: number; h: number; stride: number }

export function paddleEngine(models: PaddleModels): OcrEngine {
  return {
    // The models handle uneven light themselves; Tesseract's threshold pass would only cost time.
    binarize: false,
    async recognize(png) {
      const img = decode(png);
      const boxes = await detect(models, img);
      const lines: { text: string; conf: number; box: Box }[] = [];
      for (const box of boxes) {
        const r = await recognizeLine(models, img, box);
        if (r.text.trim()) lines.push({ ...r, box });
      }
      return toWords(lines);
    },
  };
}

type Box = [number, number, number, number];

function decode(png: Uint8Array): Rgb {
  const image = new mupdf.Image(png);
  const pix = image.toPixmap().convertToColorSpace(mupdf.ColorSpace.DeviceRGB, false);
  const out = { px: new Uint8Array(pix.getPixels()), w: pix.getWidth(), h: pix.getHeight(), stride: pix.getStride() };
  pix.destroy();
  image.destroy();
  return out;
}

/** Bilinear resample of a source region into a CHW float tensor in BGR order, normalised by `norm`. */
function sample(img: Rgb, sx: number, sy: number, sw: number, sh: number, tw: number, th: number, norm: (v: number, c: number) => number): Float32Array {
  const { px, w, h, stride } = img;
  const at = (x: number, y: number, c: number) => px[Math.min(h - 1, Math.max(0, y)) * stride + Math.min(w - 1, Math.max(0, x)) * 3 + c]!;
  const out = new Float32Array(3 * tw * th);
  for (let y = 0; y < th; y++) {
    const fy = sy + ((y + 0.5) * sh) / th - 0.5;
    const y0 = Math.floor(fy), ay = fy - y0;
    for (let x = 0; x < tw; x++) {
      const fx = sx + ((x + 0.5) * sw) / tw - 0.5;
      const x0 = Math.floor(fx), ax = fx - x0;
      for (let c = 0; c < 3; c++) {
        const v = (1 - ax) * (1 - ay) * at(x0, y0, c) + ax * (1 - ay) * at(x0 + 1, y0, c) + (1 - ax) * ay * at(x0, y0 + 1, c) + ax * ay * at(x0 + 1, y0 + 1, c);
        out[(2 - c) * tw * th + y * tw + x] = norm(v / 255, 2 - c);
      }
    }
  }
  return out;
}

async function detect(m: PaddleModels, img: Rgb): Promise<Box[]> {
  const s = Math.min(1, DET_MAX_SIDE / Math.max(img.w, img.h));
  const dw = Math.max(32, Math.round((img.w * s) / 32) * 32);
  const dh = Math.max(32, Math.round((img.h * s) / 32) * 32);
  const input = m.tensor(sample(img, 0, 0, img.w, img.h, dw, dh, (v, c) => (v - DET_MEAN[c]!) / DET_STD[c]!), [1, 3, dh, dw]);
  const out = (await m.det.run({ [m.det.inputNames[0]!]: input as never }))[m.det.outputNames[0]!]!;
  const prob = out.data as Float32Array;

  // Text pixels → connected regions → boxes, grown by DB's "unclip" (area × ratio / perimeter).
  const seen = new Uint8Array(dw * dh);
  const boxes: Box[] = [];
  const stack: number[] = [];
  for (let i = 0; i < dw * dh; i++) {
    if (seen[i] || prob[i]! < DET_THRESH) continue;
    let minx = dw, miny = dh, maxx = 0, maxy = 0, sum = 0, n = 0;
    stack.push(i);
    seen[i] = 1;
    while (stack.length) {
      const j = stack.pop()!;
      const x = j % dw, y = (j / dw) | 0;
      if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y;
      sum += prob[j]!; n++;
      if (x > 0 && !seen[j - 1] && prob[j - 1]! >= DET_THRESH) { seen[j - 1] = 1; stack.push(j - 1); }
      if (x < dw - 1 && !seen[j + 1] && prob[j + 1]! >= DET_THRESH) { seen[j + 1] = 1; stack.push(j + 1); }
      if (y > 0 && !seen[j - dw] && prob[j - dw]! >= DET_THRESH) { seen[j - dw] = 1; stack.push(j - dw); }
      if (y < dh - 1 && !seen[j + dw] && prob[j + dw]! >= DET_THRESH) { seen[j + dw] = 1; stack.push(j + dw); }
    }
    if (n < MIN_BOX_PIXELS || sum / n < BOX_THRESH) continue;
    const bw = maxx - minx + 1, bh = maxy - miny + 1;
    const d = (bw * bh * UNCLIP) / (2 * (bw + bh));
    const sx = img.w / dw, sy = img.h / dh;
    boxes.push([
      Math.max(0, (minx - d) * sx), Math.max(0, (miny - d) * sy),
      Math.min(img.w, (maxx + 1 + d) * sx), Math.min(img.h, (maxy + 1 + d) * sy),
    ]);
  }
  return boxes;
}

async function recognizeLine(m: PaddleModels, img: Rgb, [x0, y0, x1, y1]: Box): Promise<{ text: string; conf: number }> {
  const bw = x1 - x0, bh = y1 - y0;
  if (bw < 4 || bh < 4) return { text: "", conf: 0 };
  const tw = Math.min(REC_MAX_WIDTH, Math.max(16, Math.round((REC_HEIGHT * bw) / bh / 8) * 8));
  const input = m.tensor(sample(img, x0, y0, bw, bh, tw, REC_HEIGHT, (v) => (v - 0.5) / 0.5), [1, 3, REC_HEIGHT, tw]);
  const out = (await m.rec.run({ [m.rec.inputNames[0]!]: input as never }))[m.rec.outputNames[0]!]!;
  const [, steps = 0, classes = 0] = out.dims;
  const p = out.data as Float32Array;
  // Greedy CTC: best class per step; 0 is "blank", repeats collapse; the class after the dict is a space.
  let text = "", last = 0, conf = 0, n = 0;
  for (let t = 0; t < steps; t++) {
    let best = 0, bv = -1;
    for (let c = 0; c < classes; c++) if (p[t * classes + c]! > bv) { bv = p[t * classes + c]!; best = c; }
    if (best !== 0 && best !== last) {
      text += best - 1 < m.dict.length ? m.dict[best - 1] : " ";
      conf += bv; n++;
    }
    last = best;
  }
  return { text, conf: n ? conf / n : 0 };
}

/** Lines → words with proportional boxes; boxes whose vertical centres line up share a line number. */
function toWords(lines: { text: string; conf: number; box: Box }[]): OcrWord[] {
  const sorted = [...lines].sort((a, b) => (a.box[1] + a.box[3]) / 2 - (b.box[1] + b.box[3]) / 2);
  const words: OcrWord[] = [];
  let lineNo = -1;
  let lineMid = -Infinity, lineH = 0;
  for (const l of sorted) {
    if (l.conf < MIN_WORD_CONFIDENCE) continue;
    const mid = (l.box[1] + l.box[3]) / 2, h = l.box[3] - l.box[1];
    if (Math.abs(mid - lineMid) > Math.max(h, lineH) * 0.5) { lineNo++; lineMid = mid; lineH = h; }
    const text = l.text.replace(/\s+/g, " ").trim();
    const total = text.length;
    let offset = 0;
    for (const part of text.split(" ")) {
      const a = l.box[0] + ((l.box[2] - l.box[0]) * offset) / total;
      const b = l.box[0] + ((l.box[2] - l.box[0]) * (offset + part.length)) / total;
      words.push({ text: part, bbox: [a, l.box[1], b, l.box[3]], confidence: l.conf, line: lineNo });
      offset += part.length + 1;
    }
  }
  return words;
}

/** Uses `primary`, and `fallback` if the primary can't load or fails on an image. */
export function withFallback(primary: () => Promise<OcrEngine>, fallback: () => Promise<OcrEngine>): OcrEngine {
  let chosen: Promise<OcrEngine> | null = null;
  let loaded: OcrEngine | null = null;
  const pick = () => (chosen ??= primary().catch(() => fallback()).then((e) => (loaded = e)));
  return {
    // Known once the first image has been read (recognizeBest checks it after that first read).
    get binarize() { return loaded?.binarize; },
    async recognize(png) {
      const engine = await pick();
      try {
        return await engine.recognize(png);
      } catch {
        return (await fallback()).recognize(png);
      }
    },
  };
}
