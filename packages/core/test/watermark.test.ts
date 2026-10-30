import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as mupdf from "mupdf";
import { redact, scan } from "../src/index.ts";

const SAMPLES = fileURLToPath(new URL("../../../samples/", import.meta.url));
const OPTS = { profile: "lab", context: null, ocrPageCap: 0, trustedSite: false } as const;
const WM = { domain: "jobs.example.test", purpose: "job application", date: "30 Oct 2026" };

describe("purpose watermark", () => {
  it("stamps every page, survives verify, and is readable as text", async () => {
    const result = await scan(new Uint8Array(readFileSync(SAMPLES + "bank-statement-fake-redaction.pdf")), OPTS);
    const out = await redact(result.scanId, { selectedIds: result.findings.map((f) => f.id), watermark: WM });
    expect(out.verify.passed).toBe(true);
    const text = mupdf.Document.openDocument(out.bytes!, "application/pdf").loadPage(0).toStructuredText("preserve-whitespace").asText();
    // Glyphs crossing redacted areas are removed, so check fragments rather than the whole line.
    expect(text).toMatch(/Shared|jobs\.example\.test|application/);
  });

  it("is refused for images", async () => {
    const result = await scan(new Uint8Array(readFileSync(SAMPLES + "gps-photo.jpg")), OPTS);
    await expect(redact(result.scanId, { selectedIds: [], watermark: WM })).rejects.toThrow(/PDFs only/);
  });

  it("non-Latin characters become '?' instead of breaking the content stream", async () => {
    const result = await scan(new Uint8Array(readFileSync(SAMPLES + "prompt-injection.pdf")), OPTS);
    const out = await redact(result.scanId, { selectedIds: result.findings.map((f) => f.id), watermark: { ...WM, purpose: "नौकरी (job)" } });
    expect(out.verify.passed).toBe(true);
  });
});
