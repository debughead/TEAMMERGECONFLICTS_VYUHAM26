// Edge cases, round 3: company compliance policies (Phase 1, D-039). Covers what the project's own
// compliance tests don't: classification mistakes, ways to slip a codename past the dictionary, secret
// formats, how much of a value is removed, slow or freezing patterns, and "remove" items in Word files
// that nothing can remove. Each test asserts what the system *should* do; a failure is a gap.
import { spawnSync } from "node:child_process";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { findAmounts, findInternalLinks, findLabelValues, findSecrets, findTerms, hasLabel } from "../src/compliance/detect.ts";
import { applyPolicy } from "../src/compliance/evaluate.ts";
import { destinationFor, parsePolicy } from "../src/compliance/load.ts";
import { GENERAL_COMPANY_POLICY } from "../src/compliance/packs.ts";
import { compileSafe } from "../src/compliance/safeRegex.ts";
import type { Destination, LoadedPolicy } from "../src/compliance/schema.ts";
import type { TextLayer } from "../src/extract/textLayer.ts";
import { complianceReport, scan } from "../src/index.ts";
import { FindingCollector } from "../src/pipeline/findings.ts";

const CORE_DIR = new URL("..", import.meta.url).pathname;

/** A page-like text layer: one 6×10 box per character, lines stacked. */
function layer(text: string, index = 0): TextLayer {
  const l: TextLayer = { index, text, textToChar: [], chars: [] };
  let x = 0, y = 0;
  for (const c of text) {
    if (c === "\n") { l.textToChar.push(-1); x = 0; y += 12; continue; }
    l.chars.push({ c, rect: [x, y, x + 6, y + 10] });
    l.textToChar.push(l.chars.length - 1);
    x += 6;
  }
  return l;
}
async function load(policy: object): Promise<LoadedPolicy> {
  const r = await parsePolicy(JSON.stringify(policy));
  if (!r.ok) throw new Error(r.errors.join("; "));
  return r.loaded;
}
const general = () => load(GENERAL_COMPANY_POLICY);
const run = async (text: string, destination: Destination, policy?: object) => {
  const out = new FindingCollector();
  const report = applyPolicy({ loaded: policy ? await load(policy) : await general(), destination }, [layer(text)], out);
  return { report, out, rules: report.matchedRules.map((m) => m.id) };
};
const minimal = (rule: object, extra: object = {}) => ({
  schema: "redactguard.policy/v1", name: "Test", version: "1",
  rules: [{ id: "r1", title: "Rule", clause: "Clause 1", outside: "remove", inside: "keep", ...rule }], ...extra,
});

// ---------------------------------------------------------------------------------------------
describe("classification: does the right rule apply to the document?", () => {
  it("'Payslips' (plural) still classifies an HR document", async () => {
    expect((await run("Payslips for October 2026", "outside")).rules).toContain("hr-records");
  });
  it("'Pay-slip' (hyphenated) still classifies an HR document", async () => {
    expect((await run("Pay-slip for October 2026", "outside")).rules).toContain("hr-records");
  });
  it("a document marked NON-CONFIDENTIAL is not blocked as confidential", async () => {
    expect((await run("NON-CONFIDENTIAL: approved for public release", "outside")).report.blockedBy).toBeNull();
  });
  it("a public privacy notice saying 'we keep your data confidential' is not blocked", async () => {
    expect((await run("Privacy notice\nWe keep your information confidential and never sell it.", "outside")).report.blockedBy).toBeNull();
  });
  it("a document really marked CONFIDENTIAL is blocked outside (regression)", async () => {
    expect((await run("CONFIDENTIAL\nQ3 board pack", "outside")).report.blockedBy?.ruleId).toBe("confidential-projects");
  });
  it("hasLabel: 'Rating' is not found inside 'Operating income:'", () => {
    expect(hasLabel("Operating income: 5.2 cr", "Rating")).toBe(false);
  });
  it("hasLabel: 'ID' is not found inside 'PAID:'", () => {
    expect(hasLabel("PAID: yes", "ID")).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
describe("dictionary terms can't be slipped past by invisible or look-alike characters", () => {
  it("zero-width space inside the codename", () => {
    expect(findTerms("Update on Fal\u200Bcon", ["Falcon"])).toHaveLength(1);
  });
  it("soft hyphen inside the codename (common in PDF text)", () => {
    expect(findTerms("Update on Pro\u00ADject Falcon", ["Project Falcon"])).toHaveLength(1);
  });
  it("Cyrillic '\u0430' in place of Latin 'a'", () => {
    expect(findTerms("Update on F\u0430lcon", ["Falcon"])).toHaveLength(1);
  });
  it("accents dropped: 'Cafe Nova' for the term 'Café Nova'", () => {
    expect(findTerms("Meeting about Cafe Nova", ["Café Nova"])).toHaveLength(1);
  });
  it("a non-breaking space between words still matches (regression)", () => {
    expect(findTerms("Status of Project\u00A0Falcon", ["Project Falcon"])).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------
describe("label values: the whole value is removed, and only real labels count", () => {
  it("a long manager comment is covered to the end of the line, not cut at 80 characters", () => {
    const comment = "Consistently missed deadlines and was warned twice; recommended for a performance improvement plan in Q1.";
    const [hit] = findLabelValues(`Manager Comments: ${comment}`, ["Manager Comments"]);
    expect(hit?.raw).toBe(comment);
  });
  it("a comment that continues on the next line is covered too", () => {
    const hits = findLabelValues("Manager Comments: Missed deadlines,\nwarned twice in Q3.\nRating: 2", ["Manager Comments"]);
    expect(hits.map((h) => h.raw).join(" ")).toContain("warned twice");
  });
  it("'Ratings were discussed' is not a 'Rating' field", () => {
    expect(findLabelValues("Ratings were discussed in the meeting", ["Rating"])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
describe("amounts", () => {
  it("payslip amounts with no currency sign (Basic 45,000)", () => {
    expect(findAmounts("Basic Salary 45,000\nHRA 18,000").length).toBeGreaterThanOrEqual(2);
  });
  it("currency written after the number (50,000 INR)", () => {
    expect(findAmounts("Bonus: 50,000 INR")).toHaveLength(1);
  });
  it("'Rs 45,000/-' is found (regression)", () => {
    expect(findAmounts("Net Pay: Rs 45,000/-")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------
describe("secrets", () => {
  it("a passphrase with spaces is removed in full, not just its first word", () => {
    const [hit] = findSecrets("password: correct horse battery staple");
    expect(hit?.raw).toBe("correct horse battery staple");
  });
  it("a secret in JSON config (quoted key and value)", () => {
    expect(findSecrets('{ "client_secret": "q9Xr2LmP7vT4wZ8kB3nH" }')).toHaveLength(1);
  });
  it("an AWS secret access key line", () => {
    expect(findSecrets("aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY")).toHaveLength(1);
  });
  it("a Stripe live key (sk_live_…)", () => {
    // Built at test time so the source holds no key-shaped string (GitHub push protection reads it as a real key).
    const fakeKey = ["sk", "live", "51Hq2bCDeFgHiJkLmNoPqRsTuV"].join("_");
    expect(findSecrets(`Stripe: ${fakeKey}`)).toHaveLength(1);
  });
  it("'Password - …' with a dash separator", () => {
    expect(findSecrets("Password - Hunter2024!")).toHaveLength(1);
  });
  it("a database connection string with an embedded password", () => {
    expect(findSecrets("DATABASE_URL=postgres://app:S3cr3tPass@db.acme.example:5432/prod")).toHaveLength(1);
  });
  it("a GitHub token is found (regression)", () => {
    expect(findSecrets(`token ghp_${"a1B2c3D4e5".repeat(4)}`)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------
describe("internal links", () => {
  it("a bare private IP address with no http://", () => {
    expect(findInternalLinks("SSH to 10.12.4.7 for the build box", [])).toHaveLength(1);
  });
  it("a Windows file share path (\\\\fileserver\\hr)", () => {
    expect(findInternalLinks("Salary sheet is on \\\\fileserver\\hr\\2026", ["acme.example"])).toHaveLength(1);
  });
  it("an ssh:// link to an internal host", () => {
    expect(findInternalLinks("Clone ssh://git@git.acme.example/payroll.git", ["acme.example"])).toHaveLength(1);
  });
  it("an intranet host name with no internal domains configured", () => {
    expect(findInternalLinks("Docs at wiki.corp", [])).toHaveLength(1);
  });
  it("an https link to the company domain (regression)", () => {
    expect(findInternalLinks("See https://hr.acme.example/payroll.", ["acme.example"])).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------
describe("loading a policy", () => {
  it("a top-level domain alone ('com') is refused as an internal domain", async () => {
    const r = await parsePolicy(JSON.stringify(minimal({ when: "always", remove: [{ types: ["pan"] }] }, { internalDomains: ["com"] })));
    expect(r.ok).toBe(false);
  });
  it("the fingerprint doesn't change when a rule's keys are written in a different order", async () => {
    const a = minimal({ when: "always", remove: [{ types: ["pan"] }] });
    const rule = a.rules[0]! as Record<string, unknown>;
    const reordered = { ...a, rules: [{ inside: rule.inside, outside: rule.outside, remove: rule.remove, when: rule.when, clause: rule.clause, title: rule.title, id: rule.id }] };
    expect((await load(reordered)).sha256).toBe((await load(a)).sha256);
  });
  it("lookalike host acme.example.evil.test is outside (regression)", async () => {
    expect(destinationFor((await general()).policy, "example.com.evil.test")).toBe("outside");
  });
});

// ---------------------------------------------------------------------------------------------
describe("custom patterns can't freeze a scan", () => {
  it("overlapping alternatives under a repeat ((?:\\s|\\u00a0)+x) are refused when the policy loads", () => {
    expect(compileSafe("(?:\\s|\\u00a0)+x").ok).toBe(false);
  });
  // Either outcome keeps a scan from stalling: the guard refuses the pattern at upload (with a reason),
  // or it accepts it and the pattern stays fast on a long page (approved rewording, D-044).
  it("a pattern that would stall on a long document is refused at upload, or else stays fast", () => {
    const c = compileSafe("[\\s\\S]*CONFIDENTIAL");
    if (!c.ok) {
      expect(c.reason).toMatch(/wildcard|slow/);
      return;
    }
    const text = "a".repeat(40_000);
    const t0 = performance.now();
    c.regex.lastIndex = 0;
    while (c.regex.exec(text)) { /* no match expected */ }
    expect(performance.now() - t0).toBeLessThan(500);
  });
  it("checking an uploaded pattern always returns (run in its own process, killed after 20 s)", () => {
    const r = spawnSync("npx", ["vitest", "run", "--config", "test/probes/probe.config.ts"], {
      cwd: CORE_DIR, timeout: 20_000, encoding: "utf8", env: { ...process.env, PROBE_PATTERN: "(\\w|\\d)+!" },
    });
    expect(r.status, r.status === null ? "compileSafe never returned for (\\w|\\d)+!" : "the dangerous pattern was accepted").toBe(0);
  }, 30_000);
  it("500 keywords over a 200k-character document are checked in under 2 s", async () => {
    const keywords = Array.from({ length: 500 }, (_, i) => `keyword${i}`);
    const policy = minimal({ when: { anyOf: [{ keywords }] }, remove: [{ types: ["pan"] }] });
    const text = "lorem ipsum dolor sit amet ".repeat(7500);
    const t0 = performance.now();
    await run(text, "outside", policy);
    expect(performance.now() - t0).toBeLessThan(2000);
  });
});

// ---------------------------------------------------------------------------------------------
describe("Word files: what the policy says to remove can really be removed", () => {
  const docx = async (paragraphs: string[]) => {
    const z = new JSZip();
    z.file("[Content_Types].xml", "<Types/>");
    z.file("word/document.xml", `<w:document><w:body>${paragraphs.map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join("")}</w:body></w:document>`);
    return z.generateAsync({ type: "uint8array" });
  };
  const OPTS = { profile: "lab", context: null, ocrPageCap: 0, trustedSite: false } as const;

  it("a payslip going outside is either cleaned of what the policy removes, or blocked", async () => {
    const bytes = await docx(["Payslip October 2026", "Employee ID: EMP-204518", "Net Pay: Rs 45,000"]);
    const r = await scan(bytes, OPTS, { policy: { loaded: await general(), destination: "outside" } });
    const rep = complianceReport(r.scanId)!;
    const removable = rep.items.filter((i) => i.action === "remove").every((i) => r.findings.find((f) => f.id === i.findingId)?.redactable);
    expect(removable || r.verdict === "block").toBe(true);
  });
  it("a confidential Word file going outside is blocked (regression)", async () => {
    const r = await scan(await docx(["CONFIDENTIAL", "Status of Project Falcon"]), OPTS, { policy: { loaded: await general(), destination: "outside" } });
    expect(r.verdict).toBe("block");
  });
});

// ---------------------------------------------------------------------------------------------
describe("policy guarantees", () => {
  it("a 'keep' rule never drops an ID number another rule removes", async () => {
    const policy = {
      schema: "redactguard.policy/v1", name: "T", version: "1",
      rules: [
        { id: "keep-all", title: "Keep", clause: "c", when: "always", remove: [{ types: ["pan"] }], outside: "keep", inside: "keep" },
        { id: "remove-pan", title: "Remove", clause: "c", when: "always", remove: [{ types: ["pan"] }], outside: "remove", inside: "remove" },
      ],
    };
    const out = new FindingCollector();
    out.add({ type: "pan", source: "text", page: 0, rects: [[0, 0, 60, 10]], masked: "x", reason: "r", confidence: 1, redactable: true, detector: "regex" }, ["ABCPE1234F"]);
    const rep = applyPolicy({ loaded: await load(policy), destination: "outside" }, [layer("PAN ABCPE1234F")], out);
    expect(rep.items[0]?.action).toBe("remove");
  });
  it("the report never contains the matched text itself", async () => {
    const { report } = await run("CONFIDENTIAL\nProject Falcon budget ₹4,50,000 for Globex Ltd", "inside");
    const json = JSON.stringify(report);
    for (const v of ["Falcon", "Globex", "4,50,000"]) expect(json).not.toContain(v);
  });
});
