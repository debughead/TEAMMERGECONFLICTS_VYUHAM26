// Company policies (D-039): loading and validation, the regex guard, the policy's own detectors, rule
// matching per destination, and the guarantees: a policy only ever makes results stricter, and with
// no policy nothing changes. Fake data only.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as mupdf from "mupdf";
import { findAmounts, findInternalLinks, findLabelValues, findSecrets, findTerms, hasLabel } from "../src/compliance/detect.ts";
import { destinationFor, parsePolicy } from "../src/compliance/load.ts";
import { GENERAL_COMPANY_POLICY } from "../src/compliance/packs.ts";
import { compileSafe } from "../src/compliance/safeRegex.ts";
import type { LoadedPolicy } from "../src/compliance/schema.ts";
import { complianceReport, redact, scan } from "../src/index.ts";
import { FAKE } from "../scripts/sampleData.ts";

const SAMPLES = new URL("../../../samples/", import.meta.url);
const read = (f: string) => new Uint8Array(readFileSync(new URL(f, SAMPLES)));
const OPTS = { profile: "lab", context: null, ocrPageCap: 0, trustedSite: false } as const;
const rawText = (b: Uint8Array) => Buffer.from(new mupdf.PDFDocument(b).saveToBuffer("decompress").asUint8Array()).toString("latin1");

async function general(): Promise<LoadedPolicy> {
  const r = await parsePolicy(JSON.stringify(GENERAL_COMPANY_POLICY));
  if (!r.ok) throw new Error(r.errors.join("; "));
  return r.loaded;
}

describe("loading a policy", () => {
  it("the built-in example loads and has a stable fingerprint", async () => {
    const a = await general();
    const b = await parsePolicy(JSON.stringify(GENERAL_COMPANY_POLICY, null, 2)); // formatting doesn't matter
    expect(b.ok && b.loaded.sha256).toBe(a.sha256);
    expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    ["not JSON", "{oops", /Not valid JSON/],
    ["wrong schema id", JSON.stringify({ ...GENERAL_COMPANY_POLICY, schema: "other/v9" }), /schema/],
    ["unknown finding type", JSON.stringify({ ...GENERAL_COMPANY_POLICY, rules: [{ ...GENERAL_COMPANY_POLICY.rules[3], remove: [{ types: ["passport"] }] }] }), /rules\.0\.remove/],
    ["undefined dictionary", JSON.stringify({ ...GENERAL_COMPANY_POLICY, dictionaries: {} }), /dictionary "codenames" isn't defined/],
    ["catastrophic pattern", JSON.stringify({ ...GENERAL_COMPANY_POLICY, rules: [{ ...GENERAL_COMPANY_POLICY.rules[3], remove: [{ pattern: "(a+)+$", label: "X" }] }] }), /nested repetition/],
    ["duplicate rule ids", JSON.stringify({ ...GENERAL_COMPANY_POLICY, rules: [GENERAL_COMPANY_POLICY.rules[3], GENERAL_COMPANY_POLICY.rules[3]] }), /used twice/],
    ["too large", JSON.stringify({ ...GENERAL_COMPANY_POLICY, description: "x".repeat(300_000) }), /larger than/],
  ])("rejects %s with a readable reason", async (_n, text, why) => {
    const r = await parsePolicy(text);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join("\n")).toMatch(why);
  });

  it("decides inside/outside from the site's host", async () => {
    const { policy } = await general();
    expect(destinationFor(policy, "intranet.example.com")).toBe("inside");
    expect(destinationFor(policy, "hr.example.com")).toBe("inside");
    expect(destinationFor(policy, "example.com.evil.net")).toBe("outside");
    expect(destinationFor(policy, "notexample.com")).toBe("outside");
  });
});

describe("custom pattern guard", () => {
  it("accepts ordinary patterns", () => expect(compileSafe("\\bEMP[-_ ]?\\d{4,8}\\b").ok).toBe(true));
  it.each([["(a+)+$"], ["(\\w+\\s?)*$"], ["(x)\\1"], ["a*"], ["[unclosed"], ["x".repeat(201)]])("refuses %s", (p) => expect(compileSafe(p).ok).toBe(false));
});

describe("the policy's own detectors", () => {
  it("amounts: currency marks and paise/cents groups (positive)", () => {
    expect(findAmounts("Budget Rs 4,50,00,000 and ₹ 1,200.50; spent 1,12,430.55; $12k").map((h) => h.raw)).toEqual(["Rs 4,50,00,000", "₹ 1,200.50", "1,12,430.55", "$12k"]);
  });
  it("amounts: years, page numbers and phone numbers aren't money (negative)", () => {
    expect(findAmounts("Report 2026, page 1 of 3, call 9876543210, ref 12.5")).toEqual([]);
  });
  it("secrets: keys and labelled passwords (positive)", () => {
    expect(findSecrets("key AKIAIOSFODNN7EXAMPLE\npassword: hunter2024!").map((h) => h.raw)).toEqual(["AKIAIOSFODNN7EXAMPLE", "hunter2024!"]);
  });
  it("secrets: talking about passwords isn't a password (negative)", () => {
    expect(findSecrets("Our password policy requires 12 characters. Tokens expire daily.")).toEqual([]);
  });
  it("internal links: company domains and private networks (positive), public sites (negative)", () => {
    const text = "See https://jira.intranet.example.com/x and http://10.0.0.7/admin, not https://example.org/docs or https://github.com";
    expect(findInternalLinks(text, ["example.com"]).map((h) => h.raw)).toEqual(["https://jira.intranet.example.com/x", "http://10.0.0.7/admin,"].map((s) => s.replace(/,$/, "")));
  });
  it("terms are whole words, case-insensitive (Falconry isn't Falcon)", () => {
    expect(findTerms("project falcon update; Falconry club", ["Project Falcon"]).map((h) => h.raw)).toEqual(["project falcon"]);
    expect(findTerms("Falconry club", ["Falcon"])).toEqual([]);
  });
  it("label values on the same line and on the next line", () => {
    expect(findLabelValues("Employee ID: EMP-0045\nRating\nExceeds", ["Employee ID", "Rating"]).map((h) => h.raw)).toEqual(["EMP-0045", "Exceeds"]);
    expect(hasLabel("Employee Name: A", "Employee Name")).toBe(true);
    expect(hasLabel("the employee named in clause 4", "Employee Name")).toBe(false);
  });
});

describe("applying the example policy", () => {
  it("an HR payslip going outside: pay, IDs and comments are removed, verdict at least warn", async () => {
    const r = await scan(read("hr-payslip.pdf"), OPTS, { policy: { loaded: await general(), destination: "outside" } });
    const report = complianceReport(r.scanId)!;
    expect(report.matchedRules.map((m) => m.id)).toEqual(expect.arrayContaining(["hr-records"]));
    const removed = report.items.filter((i) => i.action === "remove").map((i) => r.findings.find((f) => f.id === i.findingId)!);
    const types = new Set(removed.map((f) => f.type));
    for (const t of ["name", "pan", "account", "salary"] as const) expect(types.has(t)).toBe(true);
    expect(removed.some((f) => f.masked.startsWith("Employee ID"))).toBe(true);
    expect(removed.some((f) => f.masked.startsWith("Performance Rating"))).toBe(true);
    expect(removed.some((f) => f.masked.startsWith("Manager Comments"))).toBe(true);
    expect(["warn", "block"]).toContain(r.verdict);
  });

  it("the same payslip going inside (to HR): the HR rule keeps it, nothing is blocked", async () => {
    const r = await scan(read("hr-payslip.pdf"), OPTS, { policy: { loaded: await general(), destination: "inside" } });
    const report = complianceReport(r.scanId)!;
    expect(report.matchedRules.find((m) => m.id === "hr-records")?.action).toBe("keep");
    expect(report.blockedBy).toBeNull();
  });

  it("a confidential project going outside is blocked, and says which rule", async () => {
    const r = await scan(read("confidential-project.pdf"), OPTS, { policy: { loaded: await general(), destination: "outside" } });
    const report = complianceReport(r.scanId)!;
    expect(r.verdict).toBe("block");
    expect(report.blockedBy?.ruleId).toBe("confidential-projects");
    expect(report.matchedRules.find((m) => m.id === "confidential-projects")?.because).toMatch(/marked "STRICTLY CONFIDENTIAL"|term from "codenames"/);
  });

  it("inside, the project note keeps flowing but codenames, clients, amounts, links and the key are removed", async () => {
    const r = await scan(read("confidential-project.pdf"), OPTS, { policy: { loaded: await general(), destination: "inside" } });
    const report = complianceReport(r.scanId)!;
    const masked = report.items.filter((i) => i.action === "remove").map((i) => r.findings.find((f) => f.id === i.findingId)!.masked);
    for (const label of ["Codename", "Client", "Amount", "Internal link", "Secret"]) expect(masked.some((m) => m.startsWith(label))).toBe(true);
    // Masks never show the value.
    expect(JSON.stringify(r)).not.toMatch(/Falcon|Globex|AKIAIOSFODNN7EXAMPLE|jira\.intranet/);
    // Redacting what the policy selected: verified, and the values are gone from the bytes.
    const out = await redact(r.scanId, { selectedIds: report.items.filter((i) => i.action === "remove").map((i) => i.findingId), watermark: null });
    expect(out.verify.passed).toBe(true);
    const raw = rawText(out.bytes!);
    for (const v of ["Project Falcon", "Globex", "AKIAIOSFODNN7EXAMPLE", "jira.intranet.example.com", "4,50,00,000"]) expect(raw).not.toContain(v);
    expect(raw).toContain("Q4 status");
  });

  it("a policy never lowers a verdict: a trusted site can't relax a policy block", async () => {
    const r = await scan(read("confidential-project.pdf"), { ...OPTS, trustedSite: true, context: { domain: "partner.net", fieldLabel: "Upload", pageTitle: "Partner portal" } },
      { policy: { loaded: await general(), destination: "outside" } });
    expect(r.verdict).toBe("block");
  });

  it("built-in findings are never dropped or downgraded by a policy", async () => {
    const without = await scan(read("weak-redaction.pdf"), OPTS);
    const withP = await scan(read("weak-redaction.pdf"), OPTS, { policy: { loaded: await general(), destination: "inside" } });
    for (const f of without.findings) {
      const same = withP.findings.find((g) => g.type === f.type && g.source === f.source && g.masked === f.masked);
      expect(same, `${f.type}/${f.source} kept`).toBeDefined();
      expect(same!.severity).toBe(f.severity);
    }
  });

  it("without a policy, scans are exactly as before (no report, same findings and verdict)", async () => {
    const a = await scan(read("bank-statement-exposed.pdf"), OPTS);
    const b = await scan(read("bank-statement-exposed.pdf"), OPTS, { policy: null });
    expect(complianceReport(a.scanId)).toBeNull();
    expect(b.findings.map((f) => [f.type, f.masked])).toEqual(a.findings.map((f) => [f.type, f.masked]));
    expect(b.verdict).toBe(a.verdict);
  });

  it("the report carries no raw values", async () => {
    const r = await scan(read("hr-payslip.pdf"), OPTS, { policy: { loaded: await general(), destination: "outside" } });
    const json = JSON.stringify(complianceReport(r.scanId));
    for (const v of [FAKE.pan, FAKE.accountNo, FAKE.name, "EMP-004512", "68,450"]) expect(json).not.toContain(v);
  });
});
