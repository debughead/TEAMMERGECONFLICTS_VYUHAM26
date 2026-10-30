/// <reference lib="webworker" />
// The core runs here, off the main thread. Raw values never leave this worker: the UI only gets
// ScanResult / RedactResult, which are masked by construction (strict schemas).
import Anthropic from "@anthropic-ai/sdk";
import * as Comlink from "comlink";
import * as ort from "onnxruntime-web/wasm";
import { createWorker } from "tesseract.js";
import {
  getAiPayload, paddleEngine, redact, scan, tesseractEngine, withFallback,
  type AiClient, type AiRequest, type AuditEvent, type AuditInput, type ChainCheck, type OcrEngine,
  type RedactOptions, type RedactResult, type ScanOptions, type ScanResult,
} from "@redactguard/core";
import { allAuditEvents, auditKey, auditStore, checkAuditChain, logAudit } from "../audit/idbStore.ts";

export const ENGINE_READY = "rg-engine-ready";
/** Same worker serves the Web Lab and the extension's offscreen document. */
const ORIGIN = self.location.protocol === "chrome-extension:" ? "extension" : "weblab";
const VENDOR_ROOT = new URL(`${import.meta.env.BASE_URL}vendor/`, self.location.origin).href;
const VENDOR = `${VENDOR_ROOT}tesseract/`;
const AI_TIMEOUT_MS = 45_000;

let tesseract: Promise<OcrEngine> | null = null;
function getTesseract(): Promise<OcrEngine> {
  // Everything is served from our own origin; no CDN fallback is possible because every path is set.
  tesseract ??= createWorker("eng", 1, {
    workerPath: `${VENDOR}worker.min.js`,
    corePath: `${VENDOR}core`,
    langPath: `${VENDOR}lang`,
    workerBlobURL: false,
    cacheMethod: "none",
  }).then((w) => tesseractEngine(w as never, (png) => new Blob([png as Uint8Array<ArrayBuffer>], { type: "image/png" })));
  return tesseract;
}

/**
 * PP-OCR (D-038): reads card photos and textured scans that Tesseract can't. Models and the ONNX
 * runtime's WASM are bundled under vendor/ (same origin); a build without them falls back to Tesseract.
 */
async function loadPaddle(): Promise<OcrEngine> {
  // Threads need cross-origin isolation, which neither host has. The runtime's WASM file is a Vite
  // asset next to this worker (same origin), found from the bundle's own URL.
  ort.env.wasm.numThreads = 1;
  const bytes = async (f: string) => {
    const res = await fetch(`${VENDOR_ROOT}paddle/${f}`);
    if (!res.ok) throw new Error(`PP-OCR file missing: ${f}`);
    return new Uint8Array(await res.arrayBuffer());
  };
  const [det, rec, dictBytes] = await Promise.all([
    bytes("det.onnx").then((b) => ort.InferenceSession.create(b)),
    bytes("rec.onnx").then((b) => ort.InferenceSession.create(b)),
    bytes("dict.txt"),
  ]);
  const dict = new TextDecoder().decode(dictBytes).split(/\r?\n/);
  if (dict[dict.length - 1] === "") dict.pop();
  return paddleEngine({ det: det as never, rec: rec as never, dict, tensor: (data, dims) => new ort.Tensor("float32", data, dims) });
}

/** OCR boots only when a page actually needs it (scanned PDFs, images). */
const lazyOcr: OcrEngine = withFallback(loadPaddle, getTesseract);

/** The only network code in the app (D-021): called only when the user turned AI on with a key. */
function anthropicClient(apiKey: string): AiClient {
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 1, timeout: AI_TIMEOUT_MS });
  return async (req: AiRequest) => {
    const msg = await client.beta.messages.create({
      model: req.model,
      max_tokens: req.maxTokens,
      system: req.system,
      messages: [{ role: "user", content: req.user }],
      output_config: { effort: req.effort, format: req.outputFormat },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
    if (msg.stop_reason === "refusal") throw new Error("AI declined this request");
    const block = msg.content.find((b) => b.type === "text");
    if (!block || block.type !== "text") throw new Error("AI returned no text");
    return JSON.parse(block.text) as unknown;
  };
}

export interface ScanRequest {
  options: ScanOptions;
  /** Present only when the user turned AI on. Held for this call only. */
  aiKey?: string;
}

const api = {
  ping(): string {
    return "pong";
  },
  async scan(bytes: Uint8Array, req: ScanRequest): Promise<ScanResult> {
    const result = await scan(bytes, req.options, {
      ocr: req.options.ocrPageCap > 0 ? lazyOcr : null,
      ai: req.aiKey ? anthropicClient(req.aiKey) : null,
    });
    await logAudit({
      origin: ORIGIN, action: "scan", fileSha256: result.fileSha256, fileType: result.fileType, verdict: result.verdict,
      detail: `${result.findings.length} finding(s); exposure ${result.exposureScore}`,
    });
    if (result.ai.payloadIds.length) {
      await logAudit({ origin: ORIGIN, action: "ai_call", fileSha256: result.fileSha256, detail: `${result.ai.payloadIds.length} masked request(s)` });
    }
    return result;
  },
  async redact(scanId: string, options: RedactOptions & { domain?: string }): Promise<RedactResult> {
    const { domain: _domain, ...redactOptions } = options;
    const result = await redact(scanId, redactOptions, {
      ocr: lazyOcr,
      audit: { store: auditStore, key: await auditKey(), origin: ORIGIN, domain: options.domain ?? null },
    });
    return result.bytes ? Comlink.transfer(result, [result.bytes.buffer]) : result;
  },
  audit(input: AuditInput): Promise<void> {
    return logAudit(input);
  },
  auditEvents(): Promise<AuditEvent[]> {
    return allAuditEvents();
  },
  auditCheck(): Promise<ChainCheck> {
    return checkAuditChain();
  },
  aiPayload(scanId: string, payloadId: string): AiRequest | null {
    return getAiPayload(scanId, payloadId);
  },
};

export type EngineApi = typeof api;
Comlink.expose(api);
// Static imports include MuPDF, whose loader uses top-level await. Messages that arrive before
// this point have no listener and are silently dropped, so the client waits for this signal.
self.postMessage(ENGINE_READY);
