/// <reference lib="webworker" />
// Self-test only: loads each dependency with a dynamic import and reports after every stage, so a
// stage that hangs is visible (static imports would hang the whole worker silently).
const t0 = performance.now();
const say = (stage: string, ok = true, info = "") => postMessage({ stage, ok, info, ms: Math.round(performance.now() - t0) });
const run = async (stage: string, fn: () => Promise<string | void>) => {
  say(`${stage}:start`);
  try { say(`${stage}:done`, true, (await fn()) ?? ""); } catch (e) { say(`${stage}:fail`, false, e instanceof Error ? `${e.name}: ${e.message}` : String(e)); }
};

say("worker-loaded");
self.onmessage = async (e: MessageEvent<Uint8Array>) => {
  await run("import-mupdf", async () => { const m = await import("../../../packages/core/node_modules/mupdf/dist/mupdf.js"); return typeof m.PDFDocument; });
  await run("mupdf-open", async () => { const m = await import("../../../packages/core/node_modules/mupdf/dist/mupdf.js"); return `${new m.PDFDocument(e.data).countPages()} page(s)`; });
  await run("import-core", async () => { await import("@redactguard/core"); });
  await run("core-scan", async () => {
    const core = await import("@redactguard/core");
    const r = await core.scan(e.data, { profile: "lab", context: null, ocrPageCap: 0, trustedSite: false });
    return `${r.findings.length} findings, verdict ${r.verdict}`;
  });
  await run("idb-audit", async () => { const a = await import("./audit/idbStore.ts"); await a.logAudit({ origin: "weblab", action: "scan", detail: "diag" }); return "row written"; });
  await run("import-tesseract", async () => { await import("tesseract.js"); });
  await run("import-anthropic", async () => { await import("@anthropic-ai/sdk"); });
  say("all-stages-finished");
};
