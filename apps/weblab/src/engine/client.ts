// Main-thread handle to the engine worker. A scan that runs past the limit terminates the worker
// (the only reliable way to stop WASM), and a fresh one is started for the next file.
import * as Comlink from "comlink";
import { LIMITS, type AuditEvent, type AuditInput, type ChainCheck, type ComplianceReport, type RedactOptions, type RedactResult, type ScanResult } from "@redactguard/core";
import type { AddPolicyResult, EngineApi, PolicySummary, ScanRequest } from "./worker.ts";

export type { AddPolicyResult, PolicySummary } from "./worker.ts";

let worker: Worker | null = null;
let remote: Promise<Comlink.Remote<EngineApi>> | null = null;
/** Last load/runtime error from the worker script itself (otherwise these fail silently). */
export let lastWorkerError: string | null = null;
// Kept in sync with ENGINE_READY in worker.ts (a value import would pull the worker's deps in here).
const ENGINE_READY = "rg-engine-ready";

/** Resolves once the worker has finished loading and is listening (see ENGINE_READY in worker.ts). */
function engine(): Promise<Comlink.Remote<EngineApi>> {
  remote ??= new Promise((resolve) => {
    const w = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    worker = w;
    w.addEventListener("error", (e) => { lastWorkerError = e.message || "Worker failed to load"; });
    const onReady = (e: MessageEvent) => {
      if (e.data !== ENGINE_READY) return;
      w.removeEventListener("message", onReady);
      resolve(Comlink.wrap<EngineApi>(w));
    };
    w.addEventListener("message", onReady);
  });
  return remote;
}

function reset(): void {
  worker?.terminate();
  worker = null;
  remote = null;
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { reset(); reject(new Error("Processing took too long and was stopped")); }, ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export function scanFile(bytes: Uint8Array, req: ScanRequest): Promise<ScanResult> {
  // Copy so the caller keeps its bytes for the X-Ray preview; the copy is transferred, not cloned.
  const copy = bytes.slice();
  return withTimeout(engine().then((e) => e.scan(Comlink.transfer(copy, [copy.buffer]), req)), LIMITS.scanTimeoutMs + (req.aiKey ? 60_000 : 0));
}

export function redactScan(scanId: string, options: RedactOptions & { domain?: string }): Promise<RedactResult> {
  return withTimeout(engine().then((e) => e.redact(scanId, options)), LIMITS.scanTimeoutMs);
}

export function aiPayload(scanId: string, payloadId: string) {
  return engine().then((e) => e.aiPayload(scanId, payloadId));
}

export const auditEvents = (): Promise<AuditEvent[]> => engine().then((e) => e.auditEvents());
export const auditCheck = (): Promise<ChainCheck> => engine().then((e) => e.auditCheck());

/** Health check for the self-test: resolves "pong" once the worker is up. */
export const pingEngine = (): Promise<string> => withTimeout(engine().then((e) => e.ping()), 10_000);
export const auditLog = (input: AuditInput): Promise<void> => engine().then((e) => e.audit(input));

// ---------- company policies (D-039) ----------
export const complianceFor = (scanId: string): Promise<ComplianceReport | null> => engine().then((e) => e.compliance(scanId));
export const policies = (): Promise<{ active: string | null; list: PolicySummary[] }> => engine().then((e) => e.policies());
export const addPolicy = (text: string): Promise<AddPolicyResult> => engine().then((e) => e.addPolicy(text) as Promise<AddPolicyResult>);
export const activatePolicy = (id: string | null): Promise<void> => engine().then((e) => e.activatePolicy(id));
export const removePolicy = (id: string): Promise<void> => engine().then((e) => e.removePolicy(id));
export const policyText = (id: string): Promise<string | null> => engine().then((e) => e.policyText(id));
