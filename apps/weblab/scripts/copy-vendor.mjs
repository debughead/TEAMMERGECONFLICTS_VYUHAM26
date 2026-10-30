// Copies Tesseract's worker, LSTM cores and English data, plus the PP-OCR models and the ONNX runtime's
// WASM files, into public/vendor so the app never fetches them from a CDN (D-022, D-038). Runs before
// dev and build.
import { cpSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Target app dir can be passed in (the extension reuses this script); defaults to the Web Lab.
const app = process.argv[2] ? resolve(process.argv[2]) : dirname(dirname(fileURLToPath(import.meta.url)));
const out = join(app, "public", "vendor", "tesseract");
mkdirSync(join(out, "core"), { recursive: true });
mkdirSync(join(out, "lang"), { recursive: true });

const tess = realpathSync(join(app, "node_modules", "tesseract.js"));
const core = join(dirname(tess), "tesseract.js-core");
cpSync(join(tess, "dist", "worker.min.js"), join(out, "worker.min.js"));
// OEM 1 (LSTM only) means tesseract picks one of these three by CPU feature detection.
for (const f of ["tesseract-core-lstm.wasm.js", "tesseract-core-simd-lstm.wasm.js", "tesseract-core-relaxedsimd-lstm.wasm.js"]) {
  cpSync(join(core, f), join(out, "core", f));
}
const lang = realpathSync(join(app, "node_modules", "@tesseract.js-data", "eng"));
cpSync(join(lang, "4.0.0_best_int", "eng.traineddata.gz"), join(out, "lang", "eng.traineddata.gz"));
console.log("vendor assets copied to public/vendor/tesseract");

// PP-OCR: models come from `pnpm models` (pinned + SHA-256 checked); without them the app falls back
// to Tesseract, so a missing download degrades OCR quality but never breaks a build.
const models = join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), "..", "vendor-models", "paddle");
if (existsSync(join(models, "det.onnx"))) {
  const paddleOut = join(app, "public", "vendor", "paddle");
  mkdirSync(paddleOut, { recursive: true });
  for (const f of ["det.onnx", "rec.onnx", "dict.txt"]) cpSync(join(models, f), join(paddleOut, f));
  // The ONNX runtime's WASM is emitted by Vite from the `onnxruntime-web/wasm` import itself.
  console.log("PP-OCR models copied to public/vendor/paddle");
} else {
  console.warn("PP-OCR models not found (run `pnpm models`); OCR will use Tesseract only");
}
