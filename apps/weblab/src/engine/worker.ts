/// <reference lib="webworker" />
// The core runs here, off the main thread. Raw values never leave this worker: the UI only gets
// ScanResult / RedactResult, which are masked by construction (strict schemas).
import Anthropic from "@anthropic-ai/sdk";
import * as Comlink from "comlink";
import * as ort from "onnxruntime-web/wasm";
import { createWorker } from "tesseract.js";
import {
  complianceReport, GENERAL_COMPANY_POLICY, getAiPayload, paddleEngine, parsePolicy, redact, scan, tesseractEngine, withFallback,
  type AiClient, type AiRequest, type AuditEvent, type AuditInput, type ChainCheck, type ComplianceReport, type Destination,
  type LoadedPolicy, type OcrEngine, type PolicyLoad, type RedactOptions, type RedactResult, type ScanOptions, type ScanResult,
} from "@redactguard/core";
import {
  allAuditEvents, auditKey, auditStore, checkAuditChain, deletePolicy, getActivePolicyId, listPolicies, logAudit, putPolicy, setActivePolicyId,
} from "../audit/idbStore.ts";

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
  /** Where the file is going; applies the active policy's inside/outside rules (D-039). */
  destination?: Destination;
  /** A policy given with the request (the extension keeps its own); otherwise this origin's active one. */
  policyText?: string;
}

// ---------- company policies (D-039) ----------

const BUILTIN_ID = "builtin-general";
const BUILTIN_TEXT = JSON.stringify(GENERAL_COMPANY_POLICY, null, 2);

export type AddPolicyResult = { ok: true; id: string } | { ok: false; errors: string[] };

/** What the Policy tab shows: everything except the raw JSON. */
export interface PolicySummary {
  id: string;
  builtIn: boolean;
  name: string;
  version: string;
  owner: string | null;
  description: string | null;
  sha256: string;
  internalDomains: string[];
  dictionaries: { name: string; terms: number }[];
  rules: { id: string; title: string; clause: string; outside: string; inside: string }[];
}

const parsedCache = new Map<string, LoadedPolicy>();
async function load(text: string): Promise<PolicyLoad> {
  const hit = parsedCache.get(text);
  if (hit) return { ok: true, loaded: hit };
  const r = await parsePolicy(text);
  if (r.ok) parsedCache.set(text, r.loaded);
  return r;
}

function summarize(id: string, { policy, sha256 }: LoadedPolicy): PolicySummary {
  return {
    id, builtIn: id === BUILTIN_ID, name: policy.name, version: policy.version, owner: policy.owner ?? null,
    description: policy.description ?? null, sha256, internalDomains: policy.internalDomains,
    dictionaries: Object.entries(policy.dictionaries).map(([name, terms]) => ({ name, terms: terms.length })),
    rules: policy.rules.map((r) => ({ id: r.id, title: r.title, clause: r.clause, outside: r.outside, inside: r.inside })),
  };
}

async function policyTextById(id: string): Promise<string | null> {
  if (id === BUILTIN_ID) return BUILTIN_TEXT;
  return (await listPolicies()).find((p) => p.id === id)?.text ?? null;
}

async function activeLoaded(): Promise<LoadedPolicy | null> {
  const id = await getActivePolicyId();
  const text = id ? await policyTextById(id) : null;
  if (!text) return null;
  const r = await load(text);
  return r.ok ? r.loaded : null;
}

const api = {
  ping(): string {
    return "pong";
  },
  async scan(bytes: Uint8Array, req: ScanRequest): Promise<ScanResult> {
    let loaded: LoadedPolicy | null = null;
    if (req.policyText) {
      const r = await load(req.policyText);
      if (!r.ok) throw new Error(`The company policy can't be used: ${r.errors[0]}`);
      loaded = r.loaded;
    } else {
      loaded = await activeLoaded();
    }
    const result = await scan(bytes, req.options, {
      ocr: req.options.ocrPageCap > 0 ? lazyOcr : null,
      ai: req.aiKey ? anthropicClient(req.aiKey) : null,
      policy: loaded ? { loaded, destination: req.destination ?? "outside" } : null,
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
  compliance(scanId: string): ComplianceReport | null {
    return complianceReport(scanId);
  },
  async policies(): Promise<{ active: string | null; list: PolicySummary[] }> {
    const list: PolicySummary[] = [];
    const builtin = await load(BUILTIN_TEXT);
    if (builtin.ok) list.push(summarize(BUILTIN_ID, builtin.loaded));
    for (const p of await listPolicies()) {
      const r = await load(p.text);
      if (r.ok) list.push(summarize(p.id, r.loaded));
    }
    const active = await getActivePolicyId();
    return { active: list.some((p) => p.id === active) ? active : null, list };
  },
  /** Validates, stores and activates an uploaded policy. Errors are written so a compliance team can fix them. */
  async addPolicy(text: string): Promise<AddPolicyResult> {
    const r = await load(text);
    if (!r.ok) return r;
    const id = `p-${r.loaded.sha256.slice(0, 16)}`;
    const { name, version } = r.loaded.policy;
    await putPolicy({ id, text, name, version, sha256: r.loaded.sha256, addedAt: new Date().toISOString() });
    await setActivePolicyId(id);
    await logAudit({ origin: ORIGIN, action: "policy_change", detail: `added and turned on "${name}" v${version} (sha256 ${r.loaded.sha256.slice(0, 16)})` });
    return { ok: true, id };
  },
  async activatePolicy(id: string | null): Promise<void> {
    const text = id ? await policyTextById(id) : null;
    if (id && !text) throw new Error("That policy no longer exists");
    await setActivePolicyId(id);
    const r = text ? await load(text) : null;
    await logAudit({
      origin: ORIGIN, action: "policy_change",
      detail: r?.ok ? `turned on "${r.loaded.policy.name}" v${r.loaded.policy.version} (sha256 ${r.loaded.sha256.slice(0, 16)})` : "turned the company policy off",
    });
  },
  async removePolicy(id: string): Promise<void> {
    if (id === BUILTIN_ID) throw new Error("The example policy is built in and can't be removed");
    const text = await policyTextById(id);
    const r = text ? await load(text) : null;
    await deletePolicy(id);
    if ((await getActivePolicyId()) === id) await setActivePolicyId(null);
    await logAudit({ origin: ORIGIN, action: "policy_change", detail: `removed "${r?.ok ? r.loaded.policy.name : id}"` });
  },
  policyText(id: string): Promise<string | null> {
    return policyTextById(id);
  },
};

export type EngineApi = typeof api;
Comlink.expose(api);
// Static imports include MuPDF, whose loader uses top-level await. Messages that arrive before
// this point have no listener and are silently dropped, so the client waits for this signal.
self.postMessage(ENGINE_READY);
