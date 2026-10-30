// AI pass with a fake client: no network. Checks masking, add-only behaviour and reply validation.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getAiPayload, redact, scan, type AiClient, type AiRequest } from "../src/index.ts";
import { FAKE, aadhaarSpaced } from "../scripts/sampleData.ts";
import { pdfFromContent, textOp } from "./helpers/pdf.ts";

const SAMPLES = fileURLToPath(new URL("../../../samples/", import.meta.url));
const OPTS = { profile: "lab", context: null, ocrPageCap: 0, trustedSite: false } as const;
const RAW = [FAKE.aadhaar, aadhaarSpaced(FAKE.aadhaar), FAKE.pan, FAKE.phone, FAKE.name, FAKE.accountNo, FAKE.upi, "682001"];

const medicalPdf = () => pdfFromContent(
  textOp(72, 740, 12, "Discharge summary (FAKE DATA)") +
  textOp(72, 720, 12, `Patient Name: ${FAKE.name}`) +
  textOp(72, 700, 12, `Mobile ${FAKE.phone}, Aadhaar ${aadhaarSpaced(FAKE.aadhaar)}`) +
  textOp(72, 680, 12, "Condition: stable after surgery, follow-up for Type 2 diabetes") +
  textOp(72, 660, 12, "Treatment: Metformin 500 tablets twice daily"),
);

function recorder(reply: (r: AiRequest) => unknown): { client: AiClient; requests: AiRequest[] } {
  const requests: AiRequest[] = [];
  return { requests, client: async (r) => { requests.push(r); return reply(r); } };
}
const noFindings = () => ({ findings: [] });

describe("AI off by default", () => {
  it("without deps.ai nothing is called and ai.enabled is false", async () => {
    const result = await scan(medicalPdf(), OPTS);
    expect(result.ai).toEqual({ enabled: false, used: false, payloadIds: [] });
  });
});

describe("what is sent", () => {
  it("contains no raw value from the document, only placeholders", async () => {
    for (const bytes of [medicalPdf(), new Uint8Array(readFileSync(SAMPLES + "weak-redaction.pdf"))]) {
      const { client, requests } = recorder(noFindings);
      await scan(bytes, OPTS, { ai: client });
      expect(requests.length).toBeGreaterThan(0);
      const sent = JSON.stringify(requests);
      for (const v of RAW) expect(sent).not.toContain(v);
      expect(sent).toMatch(/\[NAME_1\]|\[PHONE_1\]|\[NUMBER_1\]/);
    }
  });

  it("uses Claude Opus 5.5 with structured output, and the viewer shows the exact request", async () => {
    const { client, requests } = recorder(noFindings);
    const result = await scan(medicalPdf(), OPTS, { ai: client });
    expect(requests[0]!.model).toBe("claude-opus-5-5");
    expect(requests[0]!.outputFormat.type).toBe("json_schema");
    expect(result.ai.payloadIds).toEqual(["ai1"]);
    expect(getAiPayload(result.scanId, "ai1")).toEqual(requests[0]);
  });

  it("page-fit question carries page metadata and finding types, never document text", async () => {
    const { client, requests } = recorder((r) => (r.kind === "page_fit" ? { expected: false, neededTypes: [] } : { findings: [] }));
    await scan(medicalPdf(), { ...OPTS, context: { domain: "files.example.test", fieldLabel: "Attach", pageTitle: "Form" } }, { ai: client });
    const fit = requests.find((r) => r.kind === "page_fit")!;
    expect(fit.user).toContain("files.example.test");
    expect(fit.user).not.toContain("diabetes");
    expect(fit.user).not.toContain("Discharge");
  });
});

describe("AI can only add", () => {
  it("a valid finding the local rules missed is added with rects and becomes redactable", async () => {
    const { client } = recorder(() => ({ findings: [{ text: "Metformin 500 tablets twice daily", type: "medical", severity: "high", reason: "Medication reveals a condition" }] }));
    const result = await scan(medicalPdf(), OPTS, { ai: client });
    const ai = result.findings.find((f) => f.source === "claude");
    expect(ai).toMatchObject({ type: "medical", detector: "claude", severity: "high" });
    expect(ai!.rects.length).toBe(1);
    expect(ai!.masked).not.toContain("Metformin");
    const out = await redact(result.scanId, { selectedIds: result.findings.map((f) => f.id), watermark: null });
    expect(out.verify.passed).toBe(true);
  });

  it("text already covered by a local finding isn't duplicated", async () => {
    // "Condition: …" is already a local medical finding covering this text.
    const { client } = recorder(() => ({ findings: [{ text: "Type 2 diabetes", type: "medical", severity: "high", reason: "x" }] }));
    const result = await scan(medicalPdf(), OPTS, { ai: client });
    expect(result.findings.filter((f) => f.source === "claude")).toEqual([]);
  });

  it("AI can't lower severity below the local default", async () => {
    const { client } = recorder(() => ({ findings: [{ text: "Metformin 500 tablets", type: "medical", severity: "low", reason: "x" }] }));
    const result = await scan(medicalPdf(), OPTS, { ai: client });
    expect(result.findings.find((f) => f.source === "claude")?.severity).toBe("high");
  });

  it("ignores invented text, placeholders and malformed replies; local findings stay", async () => {
    const baseline = await scan(medicalPdf(), OPTS);
    const replies: unknown[] = [
      { findings: [{ text: "Text that is not in the document", type: "medical", severity: "high", reason: "x" }] },
      { findings: [{ text: "[NAME_1]", type: "name", severity: "high", reason: "x" }] },
      { findings: [{ text: "x", type: "medical", severity: "high", reason: "x", extra: "field" }] },
      { delete: ["f1", "f2"] },
      "not json at all",
    ];
    for (const reply of replies) {
      const { client } = recorder(() => reply);
      const result = await scan(medicalPdf(), OPTS, { ai: client });
      expect(result.findings.filter((f) => f.source === "claude")).toEqual([]);
      expect(result.findings.map((f) => [f.type, f.source])).toEqual(baseline.findings.map((f) => [f.type, f.source]));
    }
  });

  it("a failing client degrades to local results with a warning", async () => {
    const result = await scan(medicalPdf(), OPTS, { ai: async () => { throw new Error("network down"); } });
    expect(result.ai.used).toBe(false);
    expect(result.warnings.join(" ")).toMatch(/AI request failed/);
    expect(result.findings.some((f) => f.type === "aadhaar")).toBe(true);
  });

  it("prompt-injection sample: deterministic findings are unaffected by an AI that 'obeys' the injection", async () => {
    const bytes = new Uint8Array(readFileSync(SAMPLES + "prompt-injection.pdf"));
    const { client } = recorder(() => ({ findings: [] }));
    const result = await scan(bytes, OPTS, { ai: client });
    expect(result.findings.map((f) => f.type)).toEqual(expect.arrayContaining(["aadhaar", "pan"]));
    expect(result.verdict).toBe("block");
  });
});
