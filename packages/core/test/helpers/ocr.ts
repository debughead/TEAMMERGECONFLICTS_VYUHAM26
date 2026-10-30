// Node OCR for tests, set up like the apps (D-038): PP-OCR first (models from `pnpm models`, run on
// onnxruntime-web's WASM backend), Tesseract as the fallback, with English data read from the local
// Homebrew install. No network: every file is local.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as ort from "onnxruntime-web";
import { createWorker } from "tesseract.js";
import { tesseractEngine, type OcrEngine } from "../../src/ocr/engine.ts";
import { paddleEngine, withFallback } from "../../src/ocr/paddle.ts";

export const TESSDATA = process.env.RG_TESSDATA ?? "/opt/homebrew/share/tessdata";
export const hasTessdata = existsSync(`${TESSDATA}/eng.traineddata`);
export const MODELS = fileURLToPath(new URL("../../../../vendor-models/paddle/", import.meta.url));
export const hasPaddle = existsSync(`${MODELS}det.onnx`) && existsSync(`${MODELS}rec.onnx`);

let tess: Promise<{ engine: OcrEngine; stop: () => Promise<unknown> }> | null = null;

/** Tesseract only (for tests about Tesseract specifically, and as the fallback). */
export function nodeTesseract(): Promise<{ engine: OcrEngine; stop: () => Promise<unknown> }> {
  tess ??= createWorker("eng", 1, { langPath: TESSDATA, gzip: false, cacheMethod: "none" }).then((w) => ({
    engine: tesseractEngine(w as never, (png) => Buffer.from(png)),
    stop: () => w.terminate(),
  }));
  return tess;
}

let paddle: Promise<OcrEngine> | null = null;

/** PP-OCR alone; rejects when the models haven't been fetched. */
export function nodePaddle(): Promise<OcrEngine> {
  paddle ??= (async () => {
    if (!hasPaddle) throw new Error("PP-OCR models missing: run `pnpm models`");
    ort.env.wasm.numThreads = 1;
    const [det, rec] = await Promise.all([
      ort.InferenceSession.create(readFileSync(`${MODELS}det.onnx`)),
      ort.InferenceSession.create(readFileSync(`${MODELS}rec.onnx`)),
    ]);
    const dict = readFileSync(`${MODELS}dict.txt`, "utf8").split(/\r?\n/);
    if (dict[dict.length - 1] === "") dict.pop();
    return paddleEngine({ det: det as never, rec: rec as never, dict, tensor: (data, dims) => new ort.Tensor("float32", data, dims) });
  })();
  return paddle;
}

/** The apps' OCR: PP-OCR when its models are present, Tesseract otherwise or on failure. */
export async function nodeOcr(): Promise<{ engine: OcrEngine; stop: () => Promise<unknown> }> {
  const engine = withFallback(nodePaddle, async () => (await nodeTesseract()).engine);
  return { engine, stop: async () => { if (tess) await (await tess).stop(); } };
}
