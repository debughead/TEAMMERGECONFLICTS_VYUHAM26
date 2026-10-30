// Guards for the edge-case fixes (D-041): every widened detector gets a near miss that must NOT match,
// and the fixes with side effects (PDF header search, JPEG thumbnail rewrite, white-text rule, custom
// properties) are checked end to end. The positive cases live in edge.test.ts / edge2.test.ts. Fake data only.
import JSZip from "jszip";
import * as mupdf from "mupdf";
import { describe, expect, it } from "vitest";
import { findBirthDates } from "../src/detect/idCards.ts";
import { findLocalEntities } from "../src/detect/localNer.ts";
import { findIds, type IdType } from "../src/detect/patterns.ts";
import { extractDocx, openZip } from "../src/extract/office.ts";
import { redact, scan } from "../src/index.ts";
import { FindingCollector } from "../src/pipeline/findings.ts";
import { cleanOffice } from "../src/redact/officeMeta.ts";
import { stripJpegMetadata } from "../src/redact/jpegMeta.ts";
import { pdfFromContent, textOp } from "./helpers/pdf.ts";
import { fakeAadhaar } from "./helpers/fakeIds.ts";

const types = (text: string, ocr = false): IdType[] => findIds(text, { ocr }).map((m) => m.type);
const A = fakeAadhaar("49871234567");
const [a1, a2, a3] = [A.slice(0, 4), A.slice(4, 8), A.slice(8)];

describe("widened ID shapes still reject near misses", () => {
  it("loose Aadhaar spacing needs an Aadhaar keyword", () => {
    expect(types(`Ref ${a1}  ${a2}  ${a3}`)).not.toContain("aadhaar");
    expect(types(`Totals ${a1} ${a2}\n${a3}`)).not.toContain("aadhaar");
  });
  it("loose Aadhaar spacing still needs a valid checksum outside OCR", () => {
    const bad = `${a1}  ${a2}  ${a3.slice(0, 3)}${(Number(a3[3]) + 1) % 10}`;
    expect(types(`Aadhaar: ${bad}`)).not.toContain("aadhaar");
  });
  it("16 digits without the VID label are not an Aadhaar VID", () => {
    expect(types("Order 9123 4567 8901 2345")).not.toContain("aadhaar");
  });
  it("mixed-case PAN-shaped words are not PANs", () => {
    expect(types("pan Abcpe1234F")).not.toContain("pan");
    expect(types("ABCPE  1234  F")).not.toContain("pan");
  });
  it("dotted 16 digits failing Luhn are not a card", () => {
    expect(types("Ref 4111.1111.1111.1112")).not.toContain("card");
  });
  it("grouped numbers that can't be an Indian mobile are not phones", () => {
    expect(types("Code 5876 543 210")).not.toContain("phone");
    expect(types("Code 123 456 7890")).not.toContain("phone");
  });
  it("only BH plates match the Bharat series", () => {
    expect(types("Ref 22 BX 1234 AB")).not.toContain("vehicle");
  });
  it("'Acc' inside a word is not an account label", () => {
    expect(types("Accepted 123456789012")).not.toContain("account");
  });
  it("'Acc No.' on the line above the number still counts when written out as 'Account'", () => {
    expect(types("Account Number:\n123456789012")).toEqual(["account"]);
  });
  it("OCR PAN repair still needs two real digits", () => {
    expect(types("REFERENCE ABCPEIZ34F", true)).toContain("pan");
    expect(types("REFERENCE ABCPEIZSAF", true)).not.toContain("pan");
  });
});

describe("local NER near misses", () => {
  const typesOf = (t: string) => findLocalEntities(t).filter((e) => !e.candidate).map((e) => e.type);
  it("a year after a salary label is not the salary", () => {
    const found = findLocalEntities("Salary for May 2026 credited").filter((e) => e.type === "salary");
    expect(found).toEqual([]);
  });
  it("a plain amount is taken only when the window has no currency amount", () => {
    const found = findLocalEntities("Net Pay for 202610: Rs 45,000").filter((e) => e.type === "salary").map((e) => e.raw);
    expect(found).toEqual(["Rs 45,000"]);
  });
  it("a hyphenated six-digit number with no address cue is not an address", () => {
    expect(typesOf("Ref 560-001 approved")).not.toContain("address");
  });
  it("a real name under a card label is still found when it shares words with headings", () => {
    const names = findLocalEntities("Name\nRavi Place").filter((e) => e.type === "name" && !e.candidate).map((e) => e.raw);
    expect(names).toEqual(["Ravi Place"]);
  });
});

describe("dates of birth near misses", () => {
  it("a date without a birth label is not a date of birth", () => {
    expect(findBirthDates("Joined: 12 May 2020")).toEqual([]);
  });
  it("a bare year is only taken after 'Year of Birth'", () => {
    expect(findBirthDates("DOB: 1985")).toEqual([]);
  });
  it("an unlabelled card still yields its one date of birth (OCR'd photo)", () => {
    expect(findBirthDates("INCOME TAX DEPARTMENT\nRAVI KUMAR\n12/05/1990").map((d) => d.raw)).toEqual(["12/05/1990"]);
  });
});

describe("identity kit near misses", () => {
  it("name + email without an ID number is not a kit", () => {
    const c = new FindingCollector();
    for (const t of ["name", "email"] as const) c.add({ type: t, source: "text", page: 0, rects: [], masked: "x", reason: "r", confidence: 1, redactable: true, detector: "regex" }, []);
    c.addCombinationRisks();
    expect(c.findings.some((f) => f.type === "identity_kit")).toBe(false);
  });
});

describe("PDF with bytes before the header", () => {
  it("is scanned, and the cleaned file leaves the leading bytes out and passes verify", async () => {
    const pdf = pdfFromContent(textOp(72, 720, 12, `Aadhaar: ${a1} ${a2} ${a3}`));
    const junk = new TextEncoder().encode("﻿NOTE ZQXJUNK7781\r\n");
    const bytes = new Uint8Array([...junk, ...pdf]);
    const result = await scan(bytes, { profile: "lab", context: null, ocrPageCap: 0, trustedSite: false });
    expect(result.fileType).toBe("pdf");
    expect(result.findings.map((f) => f.type)).toContain("aadhaar");
    const out = await redact(result.scanId, { selectedIds: result.findings.filter((f) => f.redactable).map((f) => f.id), watermark: null });
    expect(out.verify.passed).toBe(true);
    const cleaned = out.bytes!;
    expect(Buffer.from(cleaned).includes(Buffer.from("ZQXJUNK"))).toBe(false);
    expect(Buffer.from(cleaned.subarray(0, 5)).toString("latin1")).toBe("%PDF-");
    expect(mupdf.Document.openDocument(cleaned, "application/pdf").countPages()).toBe(1);
  });
});

describe("JPEG thumbnail removal keeps the picture", () => {
  const seg = (marker: number, payload: number[]) => [0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xff, ...payload];
  const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
  const scanData = [...seg(0xda, [1, 1, 0, 0, 0x3f, 0]), 0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd9];
  it("a JFIF header without a thumbnail is kept byte for byte", () => {
    const jfif = seg(0xe0, [...ascii("JFIF\0"), 1, 2, 0, 0, 1, 0, 1, 0, 0]);
    const input = new Uint8Array([0xff, 0xd8, ...jfif, ...scanData]);
    expect([...stripJpegMetadata(input)!]).toEqual([...input]);
  });
  it("with a thumbnail, only the thumbnail goes: header fields and image data are unchanged", () => {
    const jfif = seg(0xe0, [...ascii("JFIF\0"), 1, 2, 1, 0, 72, 0, 72, 1, 1, 9, 9, 9]);
    const out = stripJpegMetadata(new Uint8Array([0xff, 0xd8, ...jfif, ...scanData]))!;
    const expected = [0xff, 0xd8, ...seg(0xe0, [...ascii("JFIF\0"), 1, 2, 1, 0, 72, 0, 72, 0, 0]), ...scanData];
    expect([...out]).toEqual(expected);
  });
});

describe("Word white-text rule avoids false alarms", () => {
  const PAN = "ABCPE1234F";
  const docx = async (body: string, extra: Record<string, string> = {}) => {
    const z = new JSZip();
    z.file("[Content_Types].xml", "<Types/>");
    z.file("word/document.xml", `<w:document>${body}</w:document>`);
    for (const [n, v] of Object.entries(extra)) z.file(n, v);
    return extractDocx(await openZip(await z.generateAsync({ type: "uint8array" })));
  };
  const white = `<w:r><w:rPr><w:color w:val="FFFFFF"/></w:rPr><w:t>PAN ${PAN}</w:t></w:r>`;
  const kinds = (ex: { segments: { kind: string }[] }) => ex.segments.map((s) => s.kind);
  it("white text in a dark-shaded table cell is visible", async () => {
    const ex = await docx(`<w:body><w:tbl><w:tr><w:tc><w:tcPr><w:shd w:val="clear" w:fill="1F3864"/></w:tcPr><w:p>${white}</w:p></w:tc></w:tr></w:tbl></w:body>`);
    expect(kinds(ex)).toEqual(["body"]);
  });
  it("white text in a text box (usually on a coloured shape) is visible", async () => {
    const ex = await docx(`<w:body><w:p><w:r><w:txbxContent><w:p>${white}</w:p></w:txbxContent></w:r></w:p></w:body>`);
    expect(kinds(ex)).toEqual(["body"]);
  });
  it("white text on a dark page background is visible", async () => {
    const ex = await docx(`<w:background w:color="000000"/><w:body><w:p>${white}</w:p></w:body>`);
    expect(kinds(ex)).toEqual(["body"]);
  });
  it("normal 11 pt text is visible", async () => {
    const ex = await docx(`<w:body><w:p><w:r><w:rPr><w:sz w:val="22"/></w:rPr><w:t>PAN ${PAN}</w:t></w:r></w:p></w:body>`);
    expect(kinds(ex)).toEqual(["body"]);
  });
  it("an empty paragraph (<w:p/>) doesn't swallow the next one", async () => {
    const ex = await docx(`<w:body><w:p/><w:p><w:r><w:t>PAN ${PAN}</w:t></w:r></w:p></w:body>`);
    expect(ex.segments.map((s) => s.text).join("\n")).toContain(PAN);
  });
  it("a text box written twice (shape + VML fallback) is read once", async () => {
    const box = `<w:txbxContent><w:p><w:r><w:t>Boxed note</w:t></w:r></w:txbxContent>`.replace("</w:r></w:txbxContent>", "</w:r></w:p></w:txbxContent>");
    const ex = await docx(`<w:body><w:p><w:r><mc:AlternateContent><mc:Choice>${box}</mc:Choice><mc:Fallback>${box}</mc:Fallback></mc:AlternateContent></w:r></w:p></w:body>`);
    expect(ex.segments.map((s) => s.text).join("\n").match(/Boxed note/g)).toHaveLength(1);
  });
});

describe("Office clean keeps sensitivity labels", () => {
  it("removes personal custom properties but keeps MSIP_Label_* ones, and drops the thumbnail's relationship", async () => {
    const z = new JSZip();
    z.file("[Content_Types].xml", '<Types><Override PartName="/docProps/custom.xml" ContentType="x"/></Types>');
    z.file("_rels/.rels", '<Relationships><Relationship Id="r1" Target="docProps/thumbnail.jpeg"/><Relationship Id="r2" Target="docProps/custom.xml"/></Relationships>');
    z.file("word/document.xml", "<w:document><w:body/></w:document>");
    z.file("docProps/thumbnail.jpeg", "x");
    z.file("docProps/custom.xml", '<Properties><property fmtid="{D5}" pid="2" name="MSIP_Label_abc_Enabled"><vt:lpwstr>true</vt:lpwstr></property><property fmtid="{D5}" pid="3" name="EmployeePAN"><vt:lpwstr>ABCPE1234F</vt:lpwstr></property></Properties>');
    const zip = await openZip(await z.generateAsync({ type: "uint8array" }));
    const meta = (await extractDocx(zip)).meta;
    expect(Object.keys(meta)).toEqual(["EmployeePAN (custom property)"]);
    const out = await openZip(await cleanOffice(zip));
    const custom = await out.file("docProps/custom.xml")!.async("string");
    expect(custom).toContain("MSIP_Label_abc_Enabled");
    expect(custom).not.toContain("ABCPE1234F");
    const rels = await out.file("_rels/.rels")!.async("string");
    expect(rels).not.toContain("thumbnail");
    expect(rels).toContain("custom.xml");
  });
});
