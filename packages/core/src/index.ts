// Public entry points. Runs unchanged in a Web Worker, Node (Vitest) and the extension's offscreen
// document: no DOM, no network, no chrome.* (rules/core.md).
import { runAiFindings, runPageFit, type AiLogEntry } from "./ai/run.ts";
import { appendAudit, type AuditStore } from "./audit/chain.ts";
import type { AiClient, AiRequest } from "./ai/schema.ts";
import { sniffAndCheck } from "./filetype.ts";
import type { TextLayer } from "./extract/textLayer.ts";
import type { OcrEngine } from "./ocr/engine.ts";
import { normalizeForCompare, type FindingCollector } from "./pipeline/findings.ts";
import { scanImage } from "./pipeline/scanImage.ts";
import { scanOffice } from "./pipeline/scanOffice.ts";
import { openZip } from "./extract/office.ts";
import { cleanOffice } from "./redact/officeMeta.ts";
import { scanPdf } from "./pipeline/scanPdf.ts";
import { decideVerdict, needsPageFitTieBreak } from "./policy.ts";
import { redactImage } from "./redact/image.ts";
import { redactPdf } from "./redact/pdf.ts";
import { RedactOptions, ScanOptions, type GpsSummary, type Rect, type RedactResult, type ScanResult } from "./schemas.ts";
import { exposureScore } from "./score.ts";
import { dropSession, getSession, putSession } from "./session.ts";
import { sha256Hex } from "./util/hash.ts";
import { verifyImage, verifyOffice, verifyPdf } from "./verify.ts";

export * from "./schemas.ts";
export { LIMITS, LimitError } from "./filetype.ts";
export { dropSession } from "./session.ts";
export { tesseractEngine, type OcrEngine, type TesseractWorkerLike } from "./ocr/engine.ts";
export { AI_MODEL, type AiClient, type AiRequest } from "./ai/schema.ts";
export { appendAudit, generateAuditKey, verifyChain, memoryAuditStore, type AuditStore, type AuditInput, type ChainCheck } from "./audit/chain.ts";

/** Host-supplied capabilities; functions can't live in the zod-validated options. */
export interface CoreDeps {
  ocr?: OcrEngine | null;
  /** Present only when the user turned AI on and supplied a key (off by default). */
  ai?: AiClient | null;
  /** When given, redact() writes one row per removed item (value as keyed HMAC only) plus a verify row. */
  audit?: { store: AuditStore; key: CryptoKey; origin: "weblab" | "extension"; domain?: string | null } | null;
}

export async function scan(bytes: Uint8Array, options: ScanOptions, deps: CoreDeps = {}): Promise<ScanResult> {
  const opts = ScanOptions.parse(options);
  const { fileType } = sniffAndCheck(bytes, opts.profile);
  const ocr = opts.ocrPageCap > 0 ? deps.ocr ?? null : null;

  let collector: FindingCollector;
  let layers: TextLayer[] = [];
  let pageCount = 1;
  let gps: GpsSummary | null = null;
  let orientation = 1;
  let warnings: string[];
  let ocrStatus: ScanResult["ocr"];

  if (fileType === "pdf") {
    const out = await scanPdf(bytes, { engine: ocr, pageCap: opts.ocrPageCap });
    ({ collector, layers, pageCount, warnings } = out);
    ocrStatus = out.ocr;
  } else if (fileType === "jpeg" || fileType === "png" || fileType === "webp") {
    const out = await scanImage(bytes, ocr);
    ({ collector, layers, gps, orientation, warnings } = out);
    ocrStatus = out.ocr;
  } else {
    const out = await scanOffice(bytes, fileType);
    ({ collector, warnings } = out);
    ocrStatus = { pagesDone: 0, pagesTotal: 0 };
  }

  // Optional AI: only adds findings, after every deterministic detector has run (rules/core.md).
  const aiLog: AiLogEntry[] = [];
  let aiUsed = false;
  if (deps.ai && layers.length) {
    const r = await runAiFindings(layers, collector, deps.ai, aiLog);
    aiUsed = r.used;
    warnings.push(...r.errors);
  }
  collector.addCombinationRisks();
  const findings = collector.findings;

  const aiAnswer = deps.ai && needsPageFitTieBreak(opts.context)
    ? await runPageFit(opts.context!, findings.map((f) => f.type), deps.ai, aiLog)
    : null;
  if (aiAnswer) aiUsed = true;
  const { verdict, context } = decideVerdict({ findings, context: opts.context, trustedSite: opts.trustedSite, aiAnswer });

  const scanId = crypto.randomUUID();
  putSession({ scanId, bytes, fileType, findings, secrets: collector.secrets, raws: collector.raws, orientation, aiLog, createdAt: Date.now() });
  return {
    scanId,
    fileSha256: await sha256Hex(bytes),
    fileType,
    pageCount,
    verdict,
    exposureScore: exposureScore(findings),
    findings,
    gps,
    ocr: ocrStatus,
    context,
    ai: { enabled: Boolean(deps.ai), used: aiUsed, payloadIds: aiLog.map((e) => e.id) },
    warnings,
  };
}

/** The exact masked request sent to AI, for the "What was sent" viewer. Contains placeholders only. */
export function getAiPayload(scanId: string, payloadId: string): AiRequest | null {
  return getSession(scanId)?.aiLog.find((e) => e.id === payloadId)?.request ?? null;
}

/**
 * Redacts the selected findings of an open scan session (D-012) and verifies the result.
 * Bytes are returned only when every verification check passes; there is no override.
 */
export async function redact(scanId: string, options: RedactOptions, deps: CoreDeps = {}): Promise<RedactResult> {
  const opts = RedactOptions.parse(options);
  const session = getSession(scanId);
  if (!session) throw new Error("Scan session expired; scan the file again");
  if (opts.watermark && session.fileType !== "pdf") throw new Error("Purpose watermarks are supported for PDFs only");

  const unknown = opts.selectedIds.filter((id) => !session.findings.some((f) => f.id === id));
  if (unknown.length) throw new Error(`Unknown finding id(s): ${unknown.join(", ")}`);
  const selected = new Set(opts.selectedIds);

  const rectsByPage = new Map<number, Rect[]>();
  const unredacted: string[] = [];
  for (const f of session.findings) {
    if (!selected.has(f.id)) continue;
    if (!f.redactable) { unredacted.push(f.id); continue; }
    if (f.rects.length) {
      const page = f.page ?? 0;
      rectsByPage.set(page, [...(rectsByPage.get(page) ?? []), ...f.rects]);
    }
  }
  // A value must be gone only if every finding carrying it will actually be removed. Occurrences that
  // are unselected (user's choice) or unredactable (e.g. Office body text, D-003) legitimately stay.
  const keptValues = new Set(
    session.findings.filter((f) => !selected.has(f.id) || !f.redactable).flatMap((f) => session.secrets.get(f.id) ?? []),
  );
  // Metadata findings remove a property, not body text (the title is often also the visible heading);
  // their removal is proven by the metadata checks instead.
  const removedValues = [...new Set(
    session.findings.filter((f) => selected.has(f.id) && f.redactable && f.source !== "metadata").flatMap((f) => session.secrets.get(f.id) ?? []),
  )].filter((v) => ![...keptValues].some((k) => k.includes(v)));

  const ocr = deps.ocr ?? null;
  let result: RedactResult;
  if (session.fileType === "pdf") {
    // Every copy of each selected value goes, unless the user kept some copy of it (an unselected finding).
    const everyCopyOf = session.findings
      .filter((f) => selected.has(f.id) && f.redactable && f.page !== null && f.source !== "old_version")
      .flatMap((f) => session.raws.get(f.id) ?? [])
      .filter((v) => !keptValues.has(normalizeForCompare(v)));
    const out = redactPdf(session.bytes, rectsByPage, opts.watermark, everyCopyOf);
    const verify = await verifyPdf(out.bytes, { redactedRects: out.rectsByPage, removedValues }, ocr);
    result = { bytes: verify.passed ? out.bytes : null, mime: "application/pdf", filename: "redacted.pdf", verify, unredacted };
  } else if (session.fileType === "docx" || session.fileType === "xlsx") {
    const output = await cleanOffice(await openZip(session.bytes));
    const verify = await verifyOffice(output, session.fileType, { redactedRects: rectsByPage, removedValues });
    const mime = session.fileType === "docx"
      ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    result = { bytes: verify.passed ? output : null, mime, filename: `cleaned.${session.fileType}`, verify, unredacted };
  } else {
    const out = redactImage(session.bytes, session.fileType, session.orientation, rectsByPage.get(0) ?? []);
    const verify = await verifyImage(out.bytes, { redactedRects: rectsByPage, removedValues }, ocr);
    result = { bytes: verify.passed ? out.bytes : null, mime: out.mime, filename: `redacted.${out.ext}`, verify, unredacted };
  }
  if (deps.audit) {
    const { store, key, origin, domain = null } = deps.audit;
    const fileSha256 = await sha256Hex(session.bytes);
    for (const f of session.findings) {
      if (!selected.has(f.id) || !f.redactable) continue;
      await appendAudit(store, key, {
        origin, action: "redact", fileSha256, fileType: session.fileType, domain, itemType: f.type, page: f.page,
        value: session.secrets.get(f.id)?.[0] ?? null, detail: `source: ${f.source}`,
      });
    }
    await appendAudit(store, key, {
      origin, action: "verify", fileSha256, fileType: session.fileType, domain,
      detail: `${result.verify.passed ? "passed" : "failed"}; ${result.verify.recoverableItems} recoverable item(s); output ${result.verify.outputSha256.slice(0, 16)}`,
    });
  }
  dropSession(scanId);
  return result;
}
