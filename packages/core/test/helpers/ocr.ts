// Node OCR for tests: tesseract.js with English data read from the local Homebrew install.
// No network: langPath is a local directory and caching is disabled.
import { existsSync } from "node:fs";
import { createWorker } from "tesseract.js";
import { tesseractEngine, type OcrEngine } from "../../src/ocr/engine.ts";

export const TESSDATA = process.env.RG_TESSDATA ?? "/opt/homebrew/share/tessdata";
export const hasTessdata = existsSync(`${TESSDATA}/eng.traineddata`);

let engine: Promise<{ engine: OcrEngine; stop: () => Promise<unknown> }> | null = null;

export function nodeOcr(): Promise<{ engine: OcrEngine; stop: () => Promise<unknown> }> {
  engine ??= createWorker("eng", 1, { langPath: TESSDATA, gzip: false, cacheMethod: "none" }).then((w) => ({
    engine: tesseractEngine(w as never, (png) => Buffer.from(png)),
    stop: () => w.terminate(),
  }));
  return engine;
}
