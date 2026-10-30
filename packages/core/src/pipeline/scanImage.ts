// Image scan: privacy metadata (GPS, camera, timestamps) + OCR text through the shared detectors.
import { decodeUpright, readImageMeta } from "../extract/image.ts";
import { layerFromOcrWords, type TextLayer } from "../extract/textLayer.ts";
import type { OcrEngine } from "../ocr/engine.ts";
import { recognizeBest } from "../ocr/preprocess.ts";
import type { GpsSummary } from "../schemas.ts";
import { coarseCoord, collectImageForensics, collectTextFindings, FindingCollector } from "./findings.ts";
import { maskMeta } from "./scanPdf.ts";

export interface ImageScanOutput {
  collector: FindingCollector;
  layers: TextLayer[];
  gps: GpsSummary | null;
  orientation: number;
  warnings: string[];
  ocr: { pagesDone: number; pagesTotal: number };
}

const coarse = coarseCoord;

export async function scanImage(bytes: Uint8Array, ocr: OcrEngine | null): Promise<ImageScanOutput> {
  const meta = await readImageMeta(bytes);
  const out = new FindingCollector();
  const warnings: string[] = [];

  if (meta.gps) {
    out.add({
      type: "gps", source: "metadata", page: null, rects: [],
      masked: `Near ${coarse(meta.gps.lat).toFixed(1)}, ${coarse(meta.gps.lon).toFixed(1)}`,
      reason: "The photo's GPS tags reveal where it was taken (often someone's home)",
      confidence: 1, redactable: true, detector: "metadata",
    }, []);
  }
  for (const [key, value] of Object.entries(meta.tags)) {
    out.add({
      type: "metadata", source: "metadata", page: null, rects: [], masked: `${key}: ${maskMeta(value)}`,
      reason: `The image's ${key} tag is stored in its metadata`, confidence: 1, redactable: true, detector: "metadata",
    }, [value]);
  }

  let pagesDone = 0;
  const layers: TextLayer[] = [];
  const pix = decodeUpright(bytes, meta.orientation);
  let ocrText = "";
  if (ocr) {
    const layer = layerFromOcrWords(await recognizeBest(ocr, pix), 0);
    collectTextFindings(layer, out, { baseSource: "ocr" });
    layers.push(layer);
    ocrText = layer.text;
    pagesDone = 1;
  } else {
    warnings.push("Text in the image wasn't read because OCR is off");
  }
  // Pixel forensics run with or without OCR: bars and QR codes don't need text.
  const bars = collectImageForensics(
    { pixels: pix.getPixels(), width: pix.getWidth(), height: pix.getHeight(), stride: pix.getStride(), channels: pix.getNumberOfComponents() },
    ocrText, 0, (r) => r, out,
  );
  if (bars.barsChecked) warnings.push(`${bars.barsChecked} black redaction bar(s) checked: ${bars.barsSound} fully cover what's under them`);

  return {
    collector: out, layers, orientation: meta.orientation, warnings,
    gps: meta.gps ? { coarseLat: coarse(meta.gps.lat), coarseLon: coarse(meta.gps.lon) } : null,
    ocr: { pagesDone, pagesTotal: 1 },
  };
}
