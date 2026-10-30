// Golden tests: every sample scans to its expected findings, redacts/cleans, and verifies.
// Independent CLI tools (pdftotext, pdfinfo, exiftool, tesseract, unzip) cross-check outputs when installed.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import * as mupdf from "mupdf";
import { redact, scan, ScanResult, type FindingType } from "../src/index.ts";
import { verifyPdf } from "../src/verify.ts";
import { aadhaarSpaced, FAKE } from "../scripts/sampleData.ts";
import { hasTessdata, nodeOcr } from "./helpers/ocr.ts";

const SAMPLES = fileURLToPath(new URL("../../../samples/", import.meta.url));
const FAKE_VALUES = [FAKE.aadhaar, aadhaarSpaced(FAKE.aadhaar), FAKE.accountNo, FAKE.phone, FAKE.pan, FAKE.upi, FAKE.author, FAKE.name];

interface Expected { type: FindingType; source: string; page: number | null; min: number }
interface Sample { file: string; kind: "pdf" | "image" | "office"; needsOcr: boolean; hasText?: boolean; hasPhotos?: boolean }

const SAMPLE_LIST: Sample[] = [
  { file: "weak-redaction.pdf", kind: "pdf", needsOcr: false },
  { file: "incremental-edit.pdf", kind: "pdf", needsOcr: false },
  { file: "dark-image-over-text.pdf", kind: "pdf", needsOcr: false },
  { file: "prompt-injection.pdf", kind: "pdf", needsOcr: false },
  { file: "scanned-kyc.pdf", kind: "pdf", needsOcr: true },
  { file: "aadhaar-mock.png", kind: "image", needsOcr: true },
  { file: "gps-photo.jpg", kind: "image", needsOcr: false },
  { file: "gps-photo-rotated.jpg", kind: "image", needsOcr: false },
  { file: "tracked-changes.docx", kind: "office", needsOcr: false },
  { file: "hidden-sheet.xlsx", kind: "office", needsOcr: false },
  { file: "bank-statement-exposed.pdf", kind: "pdf", needsOcr: false },
  { file: "photo-with-gps.pdf", kind: "pdf", needsOcr: false, hasText: false, hasPhotos: true },
  { file: "pan-card-photo.jpg", kind: "image", needsOcr: true },
];

const hasTool = (bin: string) => {
  try { execFileSync("which", [bin], { stdio: "ignore" }); return true; } catch { return false; }
};
const tmpFile = (name: string, bytes: Uint8Array) => {
  const f = join(mkdtempSync(join(tmpdir(), "rg-golden-")), name);
  writeFileSync(f, bytes);
  return f;
};
const OPTS = { profile: "lab", context: null, ocrPageCap: 5, trustedSite: false } as const;
const deps = async (s: Sample) => (s.needsOcr || s.kind !== "office" ? { ocr: hasTessdata ? (await nodeOcr()).engine : null } : {});

afterAll(async () => { if (hasTessdata) await (await nodeOcr()).stop(); });

for (const s of SAMPLE_LIST) {
  describe.skipIf(s.needsOcr && !hasTessdata)(`golden: ${s.file}`, () => {
    const bytes = new Uint8Array(readFileSync(SAMPLES + s.file));
    const spec = JSON.parse(readFileSync(SAMPLES + s.file.replace(/\.[^.]+$/, ".expected.json"), "utf8")) as { expectedFindings: Expected[]; notExpected?: { type: FindingType }[] };
    const expected = spec.expectedFindings;

    it.each(spec.notExpected ?? [{ type: "__none__" as FindingType }])("never reports $type (false-positive guard)", async (n) => {
      const result = await scan(bytes, OPTS, await deps(s));
      expect(result.findings.filter((f) => f.type === n.type)).toEqual([]);
    });

    it.each(expected)("finds $type from $source on page $page", async (e) => {
      const result = await scan(bytes, OPTS, await deps(s));
      const hits = result.findings.filter((f) => f.type === e.type && f.source === e.source && f.page === e.page);
      expect(hits.length).toBeGreaterThanOrEqual(e.min);
    });

    it("scan result matches the strict schema and contains no raw fake value", async () => {
      const result = await scan(bytes, OPTS, await deps(s));
      expect(() => ScanResult.parse(result)).not.toThrow();
      const json = JSON.stringify(result);
      for (const v of FAKE_VALUES) expect(json).not.toContain(v);
    });

    it("redacting everything passes verification", async () => {
      const d = await deps(s);
      const result = await scan(bytes, OPTS, d);
      const out = await redact(result.scanId, { selectedIds: result.findings.map((f) => f.id), watermark: null }, d);
      expect(out.verify.checks.filter((c) => !c.passed)).toEqual([]);
      expect(out.verify.recoverableItems).toBe(0);
      expect(out.bytes).not.toBeNull();
      // Whatever can't be removed (Office body text, D-003; an "ID card" summary on a photo) must be
      // reported back, never silently ignored, and nothing else may be left.
      expect([...out.unredacted].sort()).toEqual(result.findings.filter((f) => !f.redactable).map((f) => f.id).sort());
      // The output must scan clean of everything the clean step owns.
      const rescan = await scan(out.bytes!, OPTS, d);
      expect(rescan.findings.filter((f) => f.autoCleanable)).toEqual([]);
    });

    if (s.kind === "pdf") {
      it.runIf(hasTool("pdftotext") && hasTool("pdfinfo"))("pdftotext/pdfinfo find no fake value, and the page is still readable", async () => {
        const d = await deps(s);
        const result = await scan(bytes, OPTS, d);
        const out = await redact(result.scanId, { selectedIds: result.findings.map((f) => f.id), watermark: null }, d);
        const file = tmpFile("out.pdf", out.bytes!);
        const text = execFileSync("pdftotext", [file, "-"], { encoding: "utf8" });
        for (const v of FAKE_VALUES) expect(text).not.toContain(v);
        if (!s.needsOcr && s.hasText !== false) expect(text).toMatch(/FAKE BANK OF TESTING|Fake Bank of Testing|Employee Record|Payslip|Application/);
        const info = execFileSync("pdfinfo", [file], { encoding: "utf8" });
        expect(info).not.toMatch(/^(Author|Creator):/m);
        expect(Buffer.from(out.bytes!).toString("latin1")).not.toContain(FAKE.pan);
      });
    }

    if (s.hasPhotos) {
      it.runIf(hasTool("pdfimages") && hasTool("exiftool"))("pdfimages + exiftool find no GPS or camera tags in the output's photos", async () => {
        const result = await scan(bytes, OPTS);
        const out = await redact(result.scanId, { selectedIds: result.findings.map((f) => f.id), watermark: null });
        const file = tmpFile("out.pdf", out.bytes!);
        const prefix = file.replace(/out\.pdf$/, "img");
        execFileSync("pdfimages", ["-j", file, prefix]);
        const tags = execFileSync("exiftool", ["-s", "-GPS*", "-Make", "-Model", "-DateTimeOriginal", `${prefix}-000.jpg`], { encoding: "utf8" });
        expect(tags.trim()).toBe("");
      });
    }

    if (s.kind === "image") {
      it.runIf(hasTool("exiftool"))("exiftool finds no GPS or camera tags in the output", async () => {
        const d = await deps(s);
        const result = await scan(bytes, OPTS, d);
        const out = await redact(result.scanId, { selectedIds: result.findings.map((f) => f.id), watermark: null }, d);
        const tags = execFileSync("exiftool", ["-s", "-GPS*", "-Make", "-Model", "-DateTimeOriginal", tmpFile("out", out.bytes!)], { encoding: "utf8" });
        expect(tags.trim()).toBe("");
      });
    }

    if (s.kind === "office") {
      it.runIf(hasTool("unzip"))("unzip shows no author in core.xml and no comment parts", async () => {
        const result = await scan(bytes, OPTS);
        const out = await redact(result.scanId, { selectedIds: result.findings.map((f) => f.id), watermark: null });
        const file = tmpFile(s.file, out.bytes!);
        execFileSync("unzip", ["-t", file], { stdio: "ignore" }); // archive is intact
        const listing = execFileSync("unzip", ["-l", file], { encoding: "utf8" });
        expect(listing).not.toMatch(/comments|threadedComments/);
        const core = execFileSync("unzip", ["-p", file, "docProps/core.xml"], { encoding: "utf8" });
        expect(core).not.toContain(FAKE.author);
        expect(core).not.toContain(FAKE.name);
      });
    }
  });
}

describe.skipIf(!hasTessdata)("OCR-specific", () => {
  it.runIf(hasTool("tesseract"))("independent tesseract CLI can't read the Aadhaar from the redacted card", async () => {
    const d = { ocr: (await nodeOcr()).engine };
    const result = await scan(new Uint8Array(readFileSync(SAMPLES + "aadhaar-mock.png")), OPTS, d);
    const out = await redact(result.scanId, { selectedIds: result.findings.map((f) => f.id), watermark: null }, d);
    const text = execFileSync("tesseract", [tmpFile("out.png", out.bytes!), "-"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    expect(text.replace(/\s/g, "")).not.toContain(FAKE.aadhaar);
    expect(text).toContain("SPECIMEN"); // the rest of the card is still there
  });
});

describe("images: orientation", () => {
  it("rotated photo (Orientation=6) is written upright: 400x300 stored → 300x400 output", async () => {
    const result = await scan(new Uint8Array(readFileSync(SAMPLES + "gps-photo-rotated.jpg")), { ...OPTS, ocrPageCap: 0 });
    const out = await redact(result.scanId, { selectedIds: result.findings.map((f) => f.id), watermark: null });
    const img = new mupdf.Image(out.bytes!);
    expect([img.getWidth(), img.getHeight()]).toEqual([300, 400]);
  });
});

describe("verify can fail", () => {
  it("the unredacted original fails verification", async () => {
    const bytes = new Uint8Array(readFileSync(SAMPLES + "weak-redaction.pdf"));
    const report = await verifyPdf(bytes, { redactedRects: new Map(), removedValues: [FAKE.accountNo] });
    expect(report.passed).toBe(false);
    const failed = report.checks.filter((c) => !c.passed).map((c) => c.name).sort();
    expect(failed).toEqual(["metadata_empty", "no_annots_embeds_js", "no_removed_values_remain", "no_text_in_redacted_areas"]);
  });

  it("the incremental sample fails the single-revision check", async () => {
    const bytes = new Uint8Array(readFileSync(SAMPLES + "incremental-edit.pdf"));
    const report = await verifyPdf(bytes, { redactedRects: new Map(), removedValues: [] });
    expect(report.checks.find((c) => c.name === "single_revision")?.passed).toBe(false);
  });

  it("redact() withholds bytes when verification fails", async () => {
    const bytes = new Uint8Array(readFileSync(SAMPLES + "weak-redaction.pdf"));
    const result = await scan(bytes, OPTS);
    const out = await redact(result.scanId, { selectedIds: [], watermark: null });
    expect(out.verify.passed).toBe(false);
    expect(out.bytes).toBeNull();
  });

  it("partial selection: an unselected occurrence of a value doesn't fail verify", async () => {
    // Redact only metadata on the prompt-injection sample; the visible Aadhaar/PAN stay by choice.
    const bytes = new Uint8Array(readFileSync(SAMPLES + "prompt-injection.pdf"));
    const result = await scan(bytes, OPTS);
    const meta = result.findings.filter((f) => f.source === "metadata").map((f) => f.id);
    const out = await redact(result.scanId, { selectedIds: meta, watermark: null });
    expect(out.verify.passed).toBe(true);
  });
});
