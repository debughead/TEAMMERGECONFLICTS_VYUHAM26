// Downloads the PP-OCR models (D-038) once, from pinned model revisions, and checks every file's
// SHA-256 before keeping it. This is a developer step: the apps bundle the files and never fetch them.
// Run: pnpm models   (writes vendor-models/paddle/, which is gitignored)
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const OUT = join(ROOT, "vendor-models", "paddle");
const FILES = [
  { name: "det.onnx", sha256: "d2a7720d45a54257208b1e13e36a8479894cb74155a5efe29462512d42f49da9",
    url: "https://huggingface.co/SWHL/RapidOCR/resolve/1cfba2e90fc938db55889873735088de210cc173/PP-OCRv4/ch_PP-OCRv4_det_infer.onnx" },
  { name: "rec.onnx", sha256: "4e16deb22c4da6468bdca539b2cd3c8687825538b67109177c47d359ab994cd7",
    url: "https://huggingface.co/monkt/paddleocr-onnx/resolve/7b02d0a30a07ba2b92ad1ff5a8941ae2c633de65/languages/english/rec.onnx" },
  { name: "dict.txt", sha256: "e025a66d31f327ba0c232e03f407ae8d105e1e709e7ccb3f408aa778c24e70d6",
    url: "https://huggingface.co/monkt/paddleocr-onnx/resolve/7b02d0a30a07ba2b92ad1ff5a8941ae2c633de65/languages/english/dict.txt" },
];
const sha = (b) => createHash("sha256").update(b).digest("hex");

mkdirSync(OUT, { recursive: true });
for (const f of FILES) {
  const path = join(OUT, f.name);
  if (existsSync(path) && sha(readFileSync(path)) === f.sha256) { console.log(`ok    ${f.name}`); continue; }
  const res = await fetch(f.url);
  if (!res.ok) throw new Error(`${f.name}: HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const got = sha(bytes);
  if (got !== f.sha256) throw new Error(`${f.name}: SHA-256 mismatch (got ${got}); refusing to use it`);
  writeFileSync(path, bytes);
  console.log(`saved ${f.name} (${(bytes.length / 1e6).toFixed(1)} MB, SHA-256 verified)`);
}
