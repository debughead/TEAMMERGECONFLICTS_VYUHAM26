import { describe, expect, it } from "vitest";
import { decideVerdict, needsPageFitTieBreak, ruleExpectations } from "../src/policy.ts";
import type { Finding, FindingSource, FindingType, ScanContext } from "../src/schemas.ts";
import { isAutoCleanable, severityFor } from "../src/score.ts";

let n = 0;
const f = (type: FindingType, source: FindingSource = "text"): Finding => ({
  id: `f${++n}`, type, source, page: 0, rects: [], masked: "x", reason: "r", confidence: 1,
  redactable: true, detector: "regex", severity: severityFor(type, source), autoCleanable: isAutoCleanable(type, source),
});
const ctx = (fieldLabel: string, domain = "example.test", pageTitle = ""): ScanContext => ({ domain, fieldLabel, pageTitle });

describe("rule expectations", () => {
  it("KYC pages expect Aadhaar; job portals don't", () => {
    expect(ruleExpectations(ctx("Upload Aadhaar"))).toContain("aadhaar");
    expect(ruleExpectations(ctx("Upload resume"))).not.toContain("aadhaar");
    expect(ruleExpectations(ctx("Attach file", "files.example.test", "Untitled"))).toBeNull();
  });
});

describe("decideVerdict: spec scenarios", () => {
  it("Aadhaar on a bank KYC page → allow (metadata still stripped)", () => {
    const r = decideVerdict({ findings: [f("aadhaar"), f("name"), f("metadata", "metadata")], context: ctx("Upload Aadhaar for e-KYC"), trustedSite: false });
    expect(r.verdict).toBe("allow");
    expect(r.context?.decidedBy).toBe("rules");
  });

  it("bank statement on a job portal → block", () => {
    const r = decideVerdict({ findings: [f("account"), f("aadhaar"), f("name")], context: ctx("Upload resume"), trustedSite: false });
    expect(r.verdict).toBe("block");
  });

  it("no context (Web Lab) falls back to severity", () => {
    expect(decideVerdict({ findings: [f("phone")], context: null, trustedSite: false }).verdict).toBe("warn");
    expect(decideVerdict({ findings: [f("ifsc")], context: null, trustedSite: false }).verdict).toBe("allow");
  });
});

describe("decideVerdict: hard rules", () => {
  it("hidden data on an untrusted page blocks even where the type is expected", () => {
    const r = decideVerdict({ findings: [f("aadhaar", "under_black_box")], context: ctx("Upload Aadhaar"), trustedSite: false });
    expect(r.verdict).toBe("block");
  });

  it("a trusted site can't turn a block into allow", () => {
    const r = decideVerdict({ findings: [f("account"), f("aadhaar")], context: ctx("Upload resume"), trustedSite: true });
    expect(r.verdict).toBe("block");
  });

  it("hidden data stays at least warn on a trusted, expecting site", () => {
    const r = decideVerdict({ findings: [f("aadhaar", "under_black_box")], context: ctx("Upload Aadhaar"), trustedSite: true });
    expect(r.verdict).toBe("warn");
  });

  it("a trusted site relaxes a plain warning to allow", () => {
    const r = decideVerdict({ findings: [f("phone")], context: ctx("Attach file", "x.test", "Form"), trustedSite: true });
    expect(r.verdict).toBe("allow");
  });

  it("AI saying 'expected, needs everything' can't lift the hidden-data floor", () => {
    const r = decideVerdict({
      findings: [f("pan", "old_version")], context: ctx("Attach file", "x.test", "Form"), trustedSite: true,
      aiAnswer: { expected: true, neededTypes: ["pan", "old_version", "hidden_content"] },
    });
    expect(r.verdict).toBe("warn");
    expect(r.context?.neededTypes).not.toContain("old_version");
  });

  it("page text that looks like a rule can't make leak-only types 'needed'", () => {
    const r = decideVerdict({ findings: [f("card")], context: ctx("Upload Aadhaar card"), trustedSite: false });
    expect(r.context?.neededTypes).not.toContain("card");
    // A card number is critical and never "needed", so it blocks even on an expecting page.
    expect(r.verdict).toBe("block");
  });

  it("the AI tie-breaker is only asked when no rule matched", () => {
    expect(needsPageFitTieBreak(ctx("Upload Aadhaar"))).toBe(false);
    expect(needsPageFitTieBreak(ctx("Attach file", "x.test", "Form"))).toBe(true);
    expect(needsPageFitTieBreak(null)).toBe(false);
  });
});
