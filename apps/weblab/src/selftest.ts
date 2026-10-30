// Runs the real engine worker in a real browser on the fake samples and prints a JSON report.
import { lastWorkerError, pingEngine, redactScan, scanFile } from "./engine/client.ts";

// Vite resolves these to served URLs (dev only; this page isn't in the production build).
const SAMPLE_URLS = import.meta.glob("../../../samples/*.{pdf,png,jpg,docx}", { query: "?url", import: "default", eager: true }) as Record<string, string>;
const urlFor = (name: string) => SAMPLE_URLS[`../../../samples/${name}`]!;
const FILES = ["weak-redaction.pdf", "incremental-edit.pdf", "scanned-kyc.pdf", "aadhaar-mock.png", "gps-photo-rotated.jpg", "tracked-changes.docx"];
// The generator's fake values, as they appear in the samples.
const FAKE = ["000011112222", "9876543210", "ABCPE1234F", "Arjun Testkumar", "test.user@okaxis"];

const out = document.getElementById("out")!;
const steps: string[] = [];
const step = (s: string) => steps.push(`${Math.round(performance.now())}ms ${s}`);
const report: Record<string, unknown> = { ua: navigator.userAgent, steps };
// Stage-by-stage diagnostic first (60 s cap), then the full flow.
const diag: unknown[] = [];
report.diag = diag;
await new Promise<void>((resolve) => {
  const w = new Worker(new URL("./diag.worker.ts", import.meta.url), { type: "module" });
  const timer = setTimeout(() => { diag.push("TIMEOUT: last stage above never finished"); w.terminate(); resolve(); }, 60_000);
  w.onerror = (e) => { diag.push(`worker error event: ${e.message}`); };
  w.onmessage = (m: MessageEvent<{ stage: string }>) => {
    diag.push(m.data);
    if (m.data.stage === "worker-loaded") void fetch(urlFor(FILES[0]!)).then((r) => r.arrayBuffer()).then((b) => w.postMessage(new Uint8Array(b)));
    if (m.data.stage === "all-stages-finished") { clearTimeout(timer); w.terminate(); resolve(); }
  };
});
try {
  step("ping engine");
  step(`ping: ${await pingEngine()}`);
  for (const name of FILES) {
    const t0 = performance.now();
    step(`${name}: fetch`);
    const bytes = new Uint8Array(await (await fetch(urlFor(name))).arrayBuffer());
    step(`${name}: scan (${bytes.length} bytes)`);
    const scan = await scanFile(bytes, { options: { profile: "lab", context: null, ocrPageCap: 5, trustedSite: false } });
    step(`${name}: redact (${scan.findings.length} findings)`);
    const red = await redactScan(scan.scanId, { selectedIds: scan.findings.filter((f) => f.redactable).map((f) => f.id), watermark: null });
    const json = JSON.stringify(scan) + JSON.stringify(red.verify);
    report[name] = {
      verdict: scan.verdict,
      findings: scan.findings.map((f) => `${f.type}/${f.source}`),
      ocr: scan.ocr,
      verifyPassed: red.verify.passed,
      failed: red.verify.checks.filter((c) => !c.passed).map((c) => `${c.name}: ${c.detail}`),
      outputBytes: red.bytes?.length ?? 0,
      rawValueLeaked: FAKE.filter((v) => json.includes(v)),
      ms: Math.round(performance.now() - t0),
    };
  }
} catch (e) {
  report.error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}
report.workerError = lastWorkerError;
// Every resource this page (and its workers) fetched must be same-origin.
report.externalRequests = performance.getEntriesByType("resource").map((r) => r.name).filter((n) => !n.startsWith(location.origin));
out.textContent = "DONE " + JSON.stringify(report, null, 2);
await fetch("/__selftest", { method: "POST", body: JSON.stringify(report, null, 2) });
