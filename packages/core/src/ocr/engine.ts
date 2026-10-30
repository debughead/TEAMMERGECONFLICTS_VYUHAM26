// OCR is injected by the host (web worker, offscreen document, or Node tests). The core never
// creates a Tesseract worker itself, so it never decides where language data comes from (no network).
import type { OcrWord } from "../extract/textLayer.ts";

export interface OcrEngine {
  /** Recognise a PNG; word boxes are in the PNG's pixel space. */
  recognize(png: Uint8Array): Promise<OcrWord[]>;
}

/** The slice of a tesseract.js 7 Worker the adapter needs (structural, so core doesn't import tesseract.js). */
export interface TesseractWorkerLike {
  recognize(
    image: never,
    options?: Record<string, unknown>,
    output?: { blocks: boolean; text?: boolean },
  ): Promise<{ data: { blocks: TesseractBlock[] | null } }>;
}
interface TesseractBox { x0: number; y0: number; x1: number; y1: number }
interface TesseractBlock { paragraphs: { lines: { words: { text: string; confidence: number; bbox: TesseractBox }[] }[] }[] }

/** Words below this confidence (0–100) are usually noise from backgrounds and photos. */
const MIN_WORD_CONFIDENCE = 30;

/**
 * Wraps a tesseract.js worker. `toImage` converts PNG bytes into whatever the host's tesseract build
 * accepts (a Blob in browsers, a Buffer in Node).
 */
export function tesseractEngine(worker: TesseractWorkerLike, toImage: (png: Uint8Array) => unknown): OcrEngine {
  return {
    async recognize(png) {
      const { data } = await worker.recognize(toImage(png) as never, {}, { blocks: true, text: false });
      const words: OcrWord[] = [];
      let line = 0;
      for (const block of data.blocks ?? []) {
        for (const para of block.paragraphs) {
          for (const l of para.lines) {
            for (const w of l.words) {
              const text = w.text.trim();
              if (!text || w.confidence < MIN_WORD_CONFIDENCE) continue;
              words.push({ text, bbox: [w.bbox.x0, w.bbox.y0, w.bbox.x1, w.bbox.y1], confidence: w.confidence / 100, line });
            }
            line++;
          }
        }
      }
      return words;
    },
  };
}
