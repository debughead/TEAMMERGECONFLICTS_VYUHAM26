// Company-policy edge cases (D-039 follow-up): wrapped terms, multi-page documents, comments, forms,
// off-page text, metadata markings, OCR, empty labels, masked secrets, email domains, wildcard domains,
// conflicting rules, large dictionaries, Word files and repeats. Each check is a soft assertion so one
// run reports every failure. Fake data only.
import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as mupdf from "mupdf";
import { findAmounts, findInternalLinks, findLabelValues, findSecrets, findTerms } from "../src/compliance/detect.ts";
import { parsePolicy, destinationFor } from "../src/compliance/load.ts";
import { GENERAL_COMPANY_POLICY } from "../src/compliance/packs.ts";
import type { LoadedPolicy } from "../src/compliance/schema.ts";
import { complianceReport, redact, scan } from "../src/index.ts";
import { pdfFromContent, textOp } from "./helpers/pdf.ts";
import { nodeOcr } from "./helpers/ocr.ts";

const OPTS = { profile: "lab", context: null, ocrPageCap: 5, trustedSite: false } as const;
const results: string[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  expect.soft(ok, `${name}${detail ? ` (${detail})` : ""}`).toBe(true);
};
const raw = (b: Uint8Array) => Buffer.from(new mupdf.PDFDocument(b).saveToBuffer("decompress").asUint8Array()).toString("latin1");
async function loaded(over: object = {}): Promise<LoadedPolicy> {
  const r = await parsePolicy(JSON.stringify({ ...GENERAL_COMPANY_POLICY, ...over }));
  if (!r.ok) throw new Error(r.errors.join("; "));
  return r.loaded;
}
const scanWith = async (bytes: Uint8Array, destination: "inside" | "outside" = "inside", over: object = {}, deps: object = {}) => {
  const r = await scan(bytes, OPTS, { ...deps, policy: { loaded: await loaded(over), destination } });
  return { r, rep: complianceReport(r.scanId)! };
};
const policyFinds = (r: Awaited<ReturnType<typeof scan>>, label: string) => r.findings.filter((f) => f.masked.startsWith(label));

it("company policies handle edge cases", async () => {
  // 1. Codename wrapped across two lines
  {
    const { r } = await scanWith(pdfFromContent(textOp(72, 700, 12, "Status of Project") + textOp(72, 684, 12, "Falcon for Q4")));
    check("codename wrapped across a line break is found", policyFinds(r, "Codename").length > 0);
  }
  // 2. Multi-page: marking on page 3 only, codename on page 2
  {
    const doc = new mupdf.PDFDocument();
    const res = doc.addObject({ Font: { F1: doc.addSimpleFont(new mupdf.Font("Helvetica")) } });
    for (const t of ["Overview page", "We discuss Project Falcon here", "CONFIDENTIAL footer"]) doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, res, textOp(72, 700, 12, t)));
    const bytes = doc.saveToBuffer("").asUint8Array().slice();
    const { r, rep } = await scanWith(bytes, "outside");
    check("multi-page: marking on page 3 classifies the whole document", rep.blockedBy?.ruleId === "confidential-projects");
    check("multi-page: codename on page 2 found with page index 1", policyFinds(r, "Codename").some((f) => f.page === 1));
  }
  // 3. Uppercase + punctuation-adjacent terms; Hindi term
  {
    const { r } = await scanWith(pdfFromContent(textOp(72, 700, 12, "UPDATE: PROJECT FALCON, (Globex Ltd).")));
    check("uppercase codename and parenthesised client found", policyFinds(r, "Codename").length === 1 && policyFinds(r, "Client").length === 1);
    check("Hindi dictionary term matched whole-word", findTerms("परियोजना बाज़ और बाज़ार", ["बाज़"]).length === 1);
    check("'Falcon' term doesn't match 'Falconry'", findTerms("Falconry club", ["Falcon"]).length === 0);
  }
  // 4. Codename inside a comment: must not paint a box over the page under the comment icon
  {
    const bytes = pdfFromContent(textOp(72, 700, 12, "Visible paragraph under the note icon"), (doc) => {
      const a = doc.loadPage(0).createAnnotation("Text"); a.setRect([72, 85, 92, 105]); a.setContents("Remember Project Falcon pricing"); a.update();
    });
    const { r } = await scanWith(bytes);
    const f = policyFinds(r, "Codename")[0];
    check("codename in a comment is found", Boolean(f));
    check("codename in a comment has no page area (comments are removed structurally)", f?.rects.length === 0, `rects=${JSON.stringify(f?.rects)}`);
    const out = await redact(r.scanId, { selectedIds: r.findings.filter((x) => x.redactable).map((x) => x.id), watermark: null });
    const txt = mupdf.Document.openDocument(out.bytes!, "application/pdf").loadPage(0).toStructuredText("preserve-whitespace").asText();
    check("redacting it keeps the visible text under the comment icon", out.verify.passed && txt.includes("Visible paragraph"), txt.slice(0, 40));
  }
  // 5. Codename in a form field value and in off-page text
  {
    const bytes = pdfFromContent(textOp(72, 740, 12, "Form") + textOp(-300, 700, 12, "Project Falcon"), (doc) => {
      const page = doc.findPage(0);
      const w = doc.addObject({ FT: "Tx", Subtype: "Widget", Type: "Annot", Rect: [72, 600, 300, 620], DA: "/Helv 11 Tf 0 g" });
      w.put("T", doc.newString("project")); w.put("V", doc.newString("Northwind deal")); w.put("P", page);
      const arr = doc.newArray(); arr.push(w); page.put("Annots", arr);
      const af = doc.newDictionary(); const fl = doc.newArray(); fl.push(w); af.put("Fields", fl); doc.getTrailer().get("Root").put("AcroForm", af);
    });
    const { r } = await scanWith(bytes);
    check("codename in a form field value found", policyFinds(r, "Codename").some((f) => f.rects.length > 0));
    const offPage = r.findings.find((f) => f.type === "hidden_content" && /outside the visible page/.test(f.reason));
    check("codename in off-page text is covered by a policy item", Boolean(offPage && complianceReport(r.scanId)!.items.some((i) => i.findingId === offPage.id)));
    const out = await redact(r.scanId, { selectedIds: r.findings.filter((x) => x.redactable).map((x) => x.id), watermark: null });
    check("form + off-page codenames gone after redaction", out.verify.passed && !raw(out.bytes!).includes("Falcon") && !raw(out.bytes!).includes("Northwind"));
  }
  // 6. Marking only in metadata title / file name
  {
    const bytes = pdfFromContent(textOp(72, 700, 12, "Quarterly numbers"), (doc) => doc.setMetaData("info:Title", "STRICTLY CONFIDENTIAL board pack"));
    const { rep } = await scanWith(bytes, "outside");
    check("a CONFIDENTIAL marking only in the PDF title still classifies the document", rep.blockedBy !== null);
  }
  // 7. OCR: a photographed card with a keyword rule
  {
    const { engine } = await nodeOcr();
    const bytes = new Uint8Array(readFileSync(new URL("../../../samples/pan-card-photo.jpg", import.meta.url)));
    const r = await scan(bytes, OPTS, { ocr: engine, policy: { loaded: await loaded({ rules: [{ id: "cards", title: "ID cards", clause: "x", when: { anyOf: [{ keywords: ["income tax department"] }] }, remove: [{ types: ["pan", "name"] }], outside: "block", inside: "remove" }] }), destination: "outside" } });
    check("OCR text of a photo triggers a keyword rule", complianceReport(r.scanId)?.blockedBy?.ruleId === "cards");
  }
  // 8. Label followed by another label on the next line
  {
    const hits = findLabelValues("Employee ID:\nDesignation: Analyst", ["Employee ID"]);
    check("empty label doesn't swallow the next line's label", hits.length === 0, JSON.stringify(hits.map((h) => h.raw)));
    check("label at the very end of the text yields nothing", findLabelValues("Employee ID:", ["Employee ID"]).length === 0);
  }
  // 9. Amounts
  {
    const a = findAmounts("Fee Rs. 50,000/- ; INR 1.2 crore ; dated 01.07.2026 ; qty 1,234 ; v2.10 ; 12/10/2026 ; ₹0.50").map((h) => h.raw);
    check("amount formats found (Rs. 50,000, INR 1.2 crore, ₹0.50)", a.includes("Rs. 50,000") && a.some((x) => x.startsWith("INR 1.2")) && a.includes("₹0.50"), JSON.stringify(a));
    check("dates, versions and plain quantities aren't money", !a.some((x) => /01\.07|1,234$|2\.10|12\/10/.test(x)), JSON.stringify(a));
  }
  // 10. Secrets: already-masked values aren't secrets
  {
    const s = findSecrets("password: ********\napi_key = xxxxxxxxxxxx\ntoken: [REDACTED]").map((h) => h.raw);
    check("masked password/key placeholders aren't reported as secrets", s.length === 0, JSON.stringify(s));
  }
  // 11. Internal links vs emails
  {
    const l = findInternalLinks("Mail meera@example.com or open https://wiki.example.com/x. Public: https://example.org", ["example.com"]).map((h) => h.raw);
    check("the domain inside an email address isn't an 'internal link'", !l.includes("example.com"), JSON.stringify(l));
    check("intranet URL still found", l.includes("https://wiki.example.com/x"), JSON.stringify(l));
  }
  // 12. Policy authoring mistakes
  {
    const r = await parsePolicy(JSON.stringify({ ...GENERAL_COMPANY_POLICY, internalDomains: ["*.acme.com", "HR.Acme.com"] }));
    check("'*.acme.com' wildcard is accepted and means acme.com and subdomains", r.ok && destinationFor(r.loaded.policy, "portal.acme.com") === "inside", r.ok ? "" : r.errors[0]);
    const extra = await parsePolicy(JSON.stringify({ ...GENERAL_COMPANY_POLICY, extraField: 1 }));
    check("unknown top-level field gives a readable error", !extra.ok && /extraField|Unrecognized/i.test(extra.errors.join(" ")), extra.ok ? "" : extra.errors[0]);
  }
  // 13. Conflicting rules: keep + remove on the same finding -> remove wins
  {
    const bytes = pdfFromContent(textOp(72, 700, 12, "Payslip for Arjun Testkumar, PAN ABCPE1234F"));
    const { r, rep } = await scanWith(bytes, "inside", { rules: [
      { id: "a", title: "A", clause: "a", when: "always", remove: [{ types: ["pan"] }], outside: "keep", inside: "keep" },
      { id: "b", title: "B", clause: "b", when: "always", remove: [{ types: ["pan"] }], outside: "remove", inside: "remove" },
    ] });
    const pan = r.findings.find((f) => f.type === "pan")!;
    check("when two rules disagree, the stricter action wins", rep.items.find((i) => i.findingId === pan.id)?.action === "remove");
  }
  // 14. Big dictionary + long document: time
  {
    const terms = Array.from({ length: 2000 }, (_, i) => `Codename${i} Term`);
    const text = Array.from({ length: 4000 }, (_, i) => `Line ${i} mentions nothing special and Codename1999 Term here.`).join("\n");
    const t0 = performance.now();
    const n = findTerms(text, terms).length;
    const ms = performance.now() - t0;
    check("2,000-term dictionary over 4,000 lines in under 1 s", ms < 1000 && n === 4000, `${Math.round(ms)} ms, ${n} hits`);
  }
  // 15. Office files: text rules
  {
    const bytes = new Uint8Array(readFileSync(new URL("../../../samples/tracked-changes.docx", import.meta.url)));
    const { rep } = await scanWith(bytes, "outside", { rules: [{ id: "k", title: "K", clause: "k", when: { anyOf: [{ keywords: ["offer letter"] }] }, remove: [{ types: ["name"] }], outside: "block", inside: "block" }] });
    check("Word file text can trigger a keyword rule", rep.matchedRules.length > 0);
  }
  // 16. The same codename 30 times -> 30 findings (Web Lab lists each)
  {
    const content = Array.from({ length: 30 }, (_, i) => textOp(72, 760 - i * 22, 10, `Row ${i}: Project Falcon`)).join("");
    const { r } = await scanWith(pdfFromContent(content));
    check("30 repeats of a codename are all found", policyFinds(r, "Codename").length === 30, `${policyFinds(r, "Codename").length}`);
  }
  expect(results.length).toBe(27); // every case ran
}, 300000);
