// Image scan: privacy metadata (GPS, camera, timestamps) + OCR text through the shared detectors.
import { decodeUpright, readImageMeta } from "../extract/image.ts";
import { layerFromOcrWords, type TextLayer } from "../extract/textLayer.ts";
import type { OcrEngine } from "../ocr/engine.ts";
import type { GpsSummary } from "../schemas.ts";
import { collectTextFindings, FindingCollector } from "./findings.ts";
import { maskMeta } from "./scanPdf.ts";

export interface ImageScanOutput {
  collector: FindingCollector;
  layers: TextLayer[];
  gps: GpsSummary | null;
  orientation: number;
  warnings: string[];
  ocr: { pagesDone: number; pagesTotal: number };
}

/** ~11 km: enough for a region-level map pin without revealing the exact spot. */
const coarse = (v: number) => Math.round(v * 10) / 10;

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
  if (ocr) {
    const pix = decodeUpright(bytes, meta.orientation);
    const layer = layerFromOcrWords(await ocr.recognize(pix.asPNG()), 0);
    collectTextFindings(layer, out, { baseSource: "ocr" });
    layers.push(layer);
    pagesDone = 1;
  } else {
    warnings.push("Text in the image wasn't read because OCR is off");
  }

  return {
    collector: out, layers, orientation: meta.orientation, warnings,
    gps: meta.gps ? { coarseLat: coarse(meta.gps.lat), coarseLon: coarse(meta.gps.lon) } : null,
    ocr: { pagesDone, pagesTotal: 1 },
  };
}
