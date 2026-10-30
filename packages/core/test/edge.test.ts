// Edge cases that real documents, OCR output or hostile pages can produce.
// Each test asserts the behaviour the system *should* have; a failure here is a gap, not a flaky test.
import { existsSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { maskLine, Placeholders, chunkLines, type SelectedLine } from "../src/ai/minimise.ts";
import { appendAudit, canonicalJson, generateAuditKey, memoryAuditStore, verifyChain } from "../src/audit/chain.ts";
import { findLocalEntities, maskEntity } from "../src/detect/localNer.ts";
import { findIds, maskForDisplay, type IdType } from "../src/detect/patterns.ts";
import { isValidCard, luhnValid, verhoeffValid } from "../src/detect/validators.ts";
import { LimitError, sniffAndCheck } from "../src/filetype.ts";
import { decideVerdict } from "../src/policy.ts";
import type { Finding, FindingSource, FindingType, ScanContext } from "../src/schemas.ts";
import { exposureScore, isAutoCleanable, severityFor } from "../src/score.ts";
import { coverage, luminance } from "../src/util/geom.ts";
import { fakeAadhaar } from "./helpers/fakeIds.ts";

const SAMPLES = new URL("../../../samples/", import.meta.url).pathname;
const types = (text: string, ocr = false): IdType[] => findIds(text, { ocr }).map((m) => m.type);
const A = fakeAadhaar("49871234567");
const [a1, a2, a3] = [A.slice(0, 4), A.slice(4, 8), A.slice(8)];

let n = 0;
const f = (type: FindingType, source: FindingSource = "text"): Finding => ({
  id: `e${++n}`, type, source, page: 0, rects: [], masked: "x", reason: "r", confidence: 1,
  redactable: true, detector: "regex", severity: severityFor(type, source), autoCleanable: isAutoCleanable(type, source),
});
const ctx = (fieldLabel: string, domain = "example.test", pageTitle = ""): ScanContext => ({ domain, fieldLabel, pageTitle });

// ---------------------------------------------------------------------------------------------
describe("Aadhaar formatting seen in real documents", () => {
  it("mixed separators (space then hyphen)", () => {
    expect(types(`Aadhaar: ${a1} ${a2}-${a3}`)).toContain("aadhaar");
  });
  it("double spaces from OCR / justified text", () => {
    expect(types(`Aadhaar: ${a1}  ${a2}  ${a3}`)).toContain("aadhaar");
  });
  it("number wrapped onto the next line of a PDF", () => {
    expect(types(`Aadhaar: ${a1} ${a2}\n${a3}`)).toContain("aadhaar");
  });
  it("dot-separated groups", () => {
    expect(types(`Aadhaar: ${a1}.${a2}.${a3}`)).toContain("aadhaar");
  });
  it("16-digit Aadhaar Virtual ID next to the VID keyword", () => {
    expect(types("VID: 9123 4567 8901 2345")).toContain("aadhaar");
  });
  it("12 digits glued to a word (OCR drops the space)", () => {
    expect(types(`AadhaarNo${A}`)).toContain("aadhaar");
  });
});

describe("other IDs in less common but valid shapes", () => {
  it("lower-case PAN (typed into a form)", () => {
    expect(types("pan: abcpe1234f")).toContain("pan");
  });
  it("PAN with OCR spaces", () => {
    expect(types("PAN ABCPE 1234 F")).toContain("pan");
  });
  it("mobile number grouped 4-3-3", () => {
    expect(types("Mobile: 9876 543 210")).toContain("phone");
  });
  it("mobile number with +91 in brackets", () => {
    expect(types("Phone (+91) 98765-43210")).toEqual(["phone"]);
  });
  it("card number with dots", () => {
    expect(types("Card 4111.1111.1111.1111")).toContain("card");
  });
  it("'Acc No.' abbreviation for a bank account", () => {
    expect(types("Acc No.: 123456789012")).toEqual(["account"]);
  });
  it("Bharat-series vehicle number", () => {
    expect(types("Vehicle 22 BH 1234 AB")).toContain("vehicle");
  });
  it("UPI built on a phone number is reported once, as UPI", () => {
    expect(types("Pay 9876543210@ybl")).toEqual(["upi"]);
  });
});

describe("validators: boundaries", () => {
  it("empty / non-digit input never passes a checksum", () => {
    expect(verhoeffValid("")).toBe(false);
    expect(luhnValid("")).toBe(false);
    expect(luhnValid("4111 1111 1111 1111")).toBe(false);
  });
  it("all-zeros passes Luhn but is not a card", () => {
    expect(luhnValid("0000000000000")).toBe(true);
    expect(isValidCard("0000000000000")).toBe(false);
  });
  it("20-digit numbers are not cards", () => {
    expect(isValidCard("41111111111111111113")).toBe(false);
  });
});

describe("display masks never reveal the whole value", () => {
  it("a one-letter email user name is not shown in full", () => {
    expect(maskForDisplay("email", "a@example.com")).not.toMatch(/^a\*\*\*@/);
  });
  it("name masks have a fixed length per word (no length leak)", () => {
    expect(maskEntity("name", "Ravi Kumaraswamy")).toBe("R*** K***");
  });
});

// ---------------------------------------------------------------------------------------------
describe("local NER: real-world casing and formats", () => {
  const typesOf = (t: string) => findLocalEntities(t).filter((e) => !e.candidate).map((e) => e.type);

  it("lower-case name after a Name label", () => {
    expect(typesOf("Name: ravi kumar")).toContain("name");
  });
  it("salary with no currency symbol or commas", () => {
    expect(typesOf("Net Pay: 45000.00")).toContain("salary");
  });
  it("salary written in lakhs", () => {
    expect(typesOf("CTC: 12 LPA")).toContain("salary");
  });
  it("PIN code written with a hyphen", () => {
    expect(typesOf("Address: 12 MG Road, Bengaluru 560-001")).toContain("address");
  });
});

// ---------------------------------------------------------------------------------------------
describe("AI minimiser: nothing identifying leaves in clear", () => {
  it("a lower-case PAN missed by the detector is still masked", () => {
    const out = maskLine("Salary credited, PAN abcpe1234f", new Placeholders());
    expect(out).not.toContain("abcpe1234f");
  });
  it("a lower-case labelled name is masked", () => {
    const out = maskLine("Patient: ravi kumar, diagnosed with diabetes", new Placeholders());
    expect(out).not.toContain("ravi kumar");
  });
  it("an email in a context line is masked", () => {
    const out = maskLine("Salary slip sent to ravi.kumar@example.com", new Placeholders());
    expect(out).not.toContain("ravi.kumar");
  });
  it("a single huge line still produces chunks under the request limit", () => {
    const line: SelectedLine = { layer: 0, start: 0, original: "x", masked: "salary ".repeat(3000) };
    for (const c of chunkLines([line])) {
      expect(c.lines.reduce((s, l) => s + l.masked.length, 0)).toBeLessThanOrEqual(8000);
    }
  });
});

// ---------------------------------------------------------------------------------------------
describe("policy: page text is attacker-controlled", () => {
  it("a lookalike domain containing 'aadhaar' does not make Aadhaar 'expected'", () => {
    const r = decideVerdict({ findings: [f("aadhaar")], context: ctx("Upload file", "free-aadhaar-update.xyz"), trustedSite: false });
    expect(r.verdict).not.toBe("allow");
  });
  it("a job portal 'Statement of Purpose' field doesn't make bank account numbers expected", () => {
    const r = decideVerdict({ findings: [f("account")], context: ctx("Upload Statement of Purpose", "careers.example.test", "Careers") , trustedSite: false });
    expect(r.verdict).not.toBe("allow");
  });
  it("'Japan visa application' is not treated as a PAN page", () => {
    const r = decideVerdict({ findings: [f("pan")], context: ctx("Japan visa documents"), trustedSite: false });
    expect(r.context?.neededTypes ?? []).not.toContain("pan");
  });
  it("a hidden leak on a trusted site is still at least a warning", () => {
    const r = decideVerdict({ findings: [f("aadhaar", "under_black_box")], context: ctx("Upload Aadhaar"), trustedSite: true });
    expect(r.verdict).not.toBe("allow");
  });
  it("an AI reply cannot mark card numbers as needed", () => {
    const r = decideVerdict({ findings: [f("card")], context: ctx("Attach", "x.test", "Untitled"), trustedSite: false, aiAnswer: { expected: true, neededTypes: ["card"] } });
    expect(r.verdict).toBe("block");
  });
});

describe("score", () => {
  it("is capped at 100 and is 0 for nothing", () => {
    expect(exposureScore([])).toBe(0);
    expect(exposureScore(Array.from({ length: 10 }, () => ({ severity: "critical" as const, source: "under_black_box" as const })))).toBe(100);
  });
});

// ---------------------------------------------------------------------------------------------
describe("audit chain tamper evidence", () => {
  const build = async (k: number) => {
    const store = memoryAuditStore();
    const key = await generateAuditKey();
    for (let i = 0; i < k; i++) await appendAudit(store, key, { origin: "weblab", action: "scan", detail: `row ${i}` });
    return store;
  };
  it("deleting the newest row is detected", async () => {
    const store = await build(3);
    expect((await verifyChain(store.rows.slice(0, 2))).ok).toBe(false);
  });
  it("wiping the whole log is detected", async () => {
    expect((await verifyChain([])).ok).toBe(false);
  });
  it("deleting a middle row is detected", async () => {
    const store = await build(3);
    expect((await verifyChain([store.rows[0]!, store.rows[2]!])).ok).toBe(false);
  });
  it("concurrent appends never fork the chain", async () => {
    const store = memoryAuditStore();
    const key = await generateAuditKey();
    await Promise.all(Array.from({ length: 20 }, (_, i) => appendAudit(store, key, { origin: "weblab", action: "scan", detail: String(i) })));
    expect(await verifyChain(store.rows)).toEqual({ ok: true, count: 20, firstBroken: null });
  });
  it("detail longer than the limit is cut without breaking the hash", async () => {
    const store = memoryAuditStore();
    await appendAudit(store, await generateAuditKey(), { origin: "weblab", action: "scan", detail: "😀".repeat(400) });
    expect((await verifyChain(store.rows)).ok).toBe(true);
    expect(store.rows[0]!.detail.length).toBeLessThanOrEqual(500);
  });
  it("canonical JSON is key-order independent", () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }] })).toBe(canonicalJson({ a: [2, { c: 4, d: 3 }], b: 1 }));
  });
});

// ---------------------------------------------------------------------------------------------
describe("file sniffing", () => {
  const bytes = (s: string) => new TextEncoder().encode(s);
  it("a PDF with junk before %PDF- (allowed by readers) is still scanned as PDF", () => {
    expect(sniffAndCheck(bytes("\r\n%PDF-1.7\n%%EOF"), "extension").fileType).toBe("pdf");
  });
  it("a PDF with a UTF-8 BOM is still scanned as PDF", () => {
    expect(sniffAndCheck(new Uint8Array([0xef, 0xbb, 0xbf, ...bytes("%PDF-1.7\n%%EOF")]), "extension").fileType).toBe("pdf");
  });
  it("an empty file is rejected cleanly", () => {
    expect(() => sniffAndCheck(new Uint8Array(), "lab")).toThrow(LimitError);
  });
  it("a truncated JPEG header is rejected as malformed, not crashed on", () => {
    expect(() => sniffAndCheck(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00]), "lab")).toThrow(LimitError);
  });
  it("a PNG claiming 2^32-1 × 2^32-1 pixels is rejected", () => {
    const png = new Uint8Array(33);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
    expect(() => sniffAndCheck(png, "lab")).toThrowError(expect.objectContaining({ code: "too_many_pixels" }));
  });
  it("a zip under 22 bytes is malformed, not an out-of-range read", () => {
    expect(() => sniffAndCheck(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0]), "lab")).toThrowError(expect.objectContaining({ code: "zip_malformed" }));
  });
  it("a file one byte over the extension limit is too_large", () => {
    expect(() => sniffAndCheck(new Uint8Array(15 * 1024 * 1024 + 1), "extension")).toThrowError(expect.objectContaining({ code: "too_large" }));
  });
});

describe("geometry", () => {
  it("zero-area rects have zero coverage", () => {
    expect(coverage([5, 5, 5, 5], [0, 0, 10, 10])).toBe(0);
  });
  it("pure black in gray / RGB / CMYK is dark", () => {
    expect(luminance([0])).toBe(0);
    expect(luminance([0, 0, 0])).toBe(0);
    expect(luminance([0, 0, 0, 1])).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
describe("repo integrity", () => {
  it("every samples/*.expected.json has its sample file", () => {
    const files = readdirSync(SAMPLES);
    const missing = files.filter((x) => x.endsWith(".expected.json"))
      .map((x) => x.replace(".expected.json", ""))
      .filter((base) => !files.some((y) => y.startsWith(base + ".") && !y.endsWith(".expected.json")));
    expect(missing).toEqual([]);
  });
  it("sample files referenced by tests exist", () => {
    expect(existsSync(SAMPLES + "bank-statement-exposed.pdf")).toBe(true);
  });
});

// =============================================================================================
// Added for feat/redaction_based_on_compliance (db490b0): OCR PAN repair, birth dates, card-field
// names, "AC" account label, JPEG metadata stripping, OCR engine fallback.
import { findBirthDates } from "../src/detect/idCards.ts";
import { fixPanReading } from "../src/detect/patterns.ts";
import { stripJpegMetadata } from "../src/redact/jpegMeta.ts";
import { withFallback } from "../src/ocr/paddle.ts";
import type { OcrEngine } from "../src/ocr/engine.ts";

describe("OCR PAN repair must not invent PANs from ordinary words", () => {
  it.each(["capability", "durability", "affability", "apparition"])("'%s' in OCR text is not a PAN", (word) => {
    expect(types(`The ${word} of the system`, true)).not.toContain("pan");
  });
  it("still repairs a real misread PAN (regression)", () => {
    expect(fixPanReading("ABCPEI234F")).toBe("ABCPE1234F");
    expect(types("PAN ABCPEI234F", true)).toContain("pan");
  });
  it("a lower-case PAN is found in typed text, not only in OCR text", () => {
    expect(types("pan abcpe1234f", true)).toContain("pan");
    expect(types("pan abcpe1234f", false)).toContain("pan");
  });
});

describe("dates of birth", () => {
  const aadhaarCard = "Government of India\nAadhaar\n";
  it("Year of Birth only (older Aadhaar cards)", () => {
    expect(findBirthDates("Year of Birth: 1985")).toHaveLength(1);
  });
  it("month written as a word", () => {
    expect(findBirthDates("Date of Birth: 12 May 1990")).toHaveLength(1);
  });
  it("ISO date", () => {
    expect(findBirthDates("DOB: 1990-05-12")).toHaveLength(1);
  });
  it("two-digit year", () => {
    expect(findBirthDates("DOB: 12/05/90")).toHaveLength(1);
  });
  it("on an Aadhaar card, the issue / download date is not a date of birth", () => {
    const text = `${aadhaarCard}DOB: 12/05/1990\nIssue Date: 01/02/2020\nDownload Date: 15/03/2024`;
    expect(findBirthDates(text).map((d) => d.raw)).toEqual(["12/05/1990"]);
  });
  it("a 'DOB' label with no date doesn't pick up an unrelated date two lines down", () => {
    expect(findBirthDates("DOB:\nPlace: Pune\n01/01/2024")).toEqual([]);
  });
});

describe("names printed under a 'Name' label on cards", () => {
  const names = (t: string) => findLocalEntities(t).filter((e) => e.type === "name" && !e.candidate).map((e) => e.raw);
  it("a form heading under 'Name' is not a person's name", () => {
    expect(names("Name\nSignature")).toEqual([]);
    expect(names("Name\nAddress")).toEqual([]);
    expect(names("Name\nDate of Birth")).toEqual([]);
  });
  it("still finds the real name (regression)", () => {
    expect(names("Name\nRavi Kumar")).toEqual(["Ravi Kumar"]);
  });
});

describe("'AC' account label", () => {
  it("a phone number on the line after a line ending in 'AC' stays a phone number", () => {
    expect(types("Coach: 3-tier AC\n98765 43210")).toEqual(["phone"]);
  });
  it("'LOAN AC 7781200045' is an account (regression)", () => {
    expect(types("LOAN AC 7781200045")).toEqual(["account"]);
  });
});

describe("JPEG metadata stripping", () => {
  const seg = (marker: number, payload: number[]) => [0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xff, ...payload];
  const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
  const jpeg = (...segments: number[][]) => new Uint8Array([
    0xff, 0xd8, ...segments.flat(),
    ...seg(0xda, [1, 1, 0, 0, 0x3f, 0]), 0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd9,
  ]);
  const has = (b: Uint8Array, s: string) => Buffer.from(b).includes(Buffer.from(s));

  it("drops a JFXX thumbnail (a copy of the unredacted photo)", () => {
    const out = stripJpegMetadata(jpeg(seg(0xe0, [...ascii("JFXX\0"), 0x10, ...ascii("THUMBNAIL-OF-ORIGINAL")])))!;
    expect(out).not.toBeNull();
    expect(has(out, "THUMBNAIL-OF-ORIGINAL")).toBe(false);
  });
  it("drops the RGB thumbnail inside a JFIF APP0 header", () => {
    const thumb = ascii("RGBTHUMBRGBTHUMB").slice(0, 12); // 2x2 px × 3 bytes
    const jfif = [...ascii("JFIF\0"), 1, 2, 0, 0, 1, 0, 1, 2, 2, ...thumb];
    const out = stripJpegMetadata(jpeg(seg(0xe0, jfif)))!;
    expect(has(out, "RGBTHUMBRGBT")).toBe(false);
  });
  it("drops EXIF, XMP and comments (regression)", () => {
    const out = stripJpegMetadata(jpeg(seg(0xe1, ascii("Exif\0\0GPSDATA")), seg(0xfe, ascii("secret comment"))))!;
    expect(has(out, "GPSDATA")).toBe(false);
    expect(has(out, "secret comment")).toBe(false);
  });
  it("drops data appended after the end-of-image marker", () => {
    const b = jpeg();
    const out = stripJpegMetadata(new Uint8Array([...b, ...ascii("TRAILER")]))!;
    expect(has(out, "TRAILER")).toBe(false);
  });
  it("a segment length running past the end returns null instead of reading out of range", () => {
    expect(stripJpegMetadata(new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff, 0x00]))).toBeNull();
  });
});

describe("OCR engine fallback", () => {
  it("loads the fallback engine once, not once per image", async () => {
    let loads = 0;
    const failing: OcrEngine = { recognize: async () => { throw new Error("onnx failed"); } };
    const ok: OcrEngine = { recognize: async () => [] };
    const engine = withFallback(async () => failing, async () => { loads++; return ok; });
    for (let i = 0; i < 3; i++) await engine.recognize(new Uint8Array());
    expect(loads).toBe(1);
  });
  it("reports the binarize setting of the engine that actually read the image", async () => {
    const failing: OcrEngine = { binarize: false, recognize: async () => { throw new Error("x"); } };
    const tesseract: OcrEngine = { binarize: true, recognize: async () => [] };
    const engine = withFallback(async () => failing, async () => tesseract);
    await engine.recognize(new Uint8Array());
    expect(engine.binarize).toBe(true);
  });
});
