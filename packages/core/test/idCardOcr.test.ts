// ID cards photographed and read by OCR (D-038): PAN repair, card-layout names, dates of birth, and
// the PP-OCR engine itself on the fake PAN-card photo. Fake data only.
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findBirthDates } from "../src/detect/idCards.ts";
import { findLocalEntities } from "../src/detect/localNer.ts";
import { findIds, fixPanReading } from "../src/detect/patterns.ts";
import { redact, scan } from "../src/index.ts";
import { FAKE } from "../scripts/sampleData.ts";
import { hasPaddle, nodePaddle } from "./helpers/ocr.ts";

describe("PAN numbers misread by OCR", () => {
  it.each([
    ["ABCPE1Z34F", "digit 2 read as Z"],
    ["A8CPE1234F", "letter B read as 8"],
    ["ABCPEI234F", "digit 1 read as I"],
    ["ABCPE12B4F", "digit 8... read as B"],
  ])("%s (%s) is repaired to a valid PAN (positive)", (reading) => {
    const m = findIds(`Permanent Account Number ${reading}`, { ocr: true }).filter((x) => x.type === "pan");
    expect(m.length).toBe(1);
    expect(m[0]!.normalized).toBe(fixPanReading(reading));
  });

  it("a correct PAN is reported once, at full confidence", () => {
    const m = findIds(`PAN ${FAKE.pan}`, { ocr: true }).filter((x) => x.type === "pan");
    expect(m).toHaveLength(1);
    expect(m[0]!.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it("repair only applies to OCR text, and never to tokens that can't be a PAN (negative)", () => {
    expect(findIds("Ref ABCPE1Z34F", {}).filter((x) => x.type === "pan")).toEqual([]);
    for (const t of ["9876543210", "STATEMENTS", "REFERENCES", "ABCDE12345"]) {
      expect(findIds(`code ${t}`, { ocr: true }).filter((x) => x.type === "pan")).toEqual([]);
    }
  });
});

describe("names printed under their label (card layout)", () => {
  it("finds the holder's and the father's name on the line below the label (positive)", () => {
    const text = "INCOME TAX DEPARTMENT\nName\nARJUN TESTKUMAR\nFather's Name\nRAVI TESTKUMAR\nDate of Birth\n05/12/1990";
    const names = findLocalEntities(text).filter((e) => e.type === "name" && !e.candidate).map((e) => e.raw);
    expect(names).toEqual(expect.arrayContaining(["ARJUN TESTKUMAR", "RAVI TESTKUMAR"]));
  });

  it("a bilingual label whose Hindi half OCR misread as Latin letters still works", () => {
    const names = findLocalEntities("pita ka nam / Father's Name\nRAVI TESTKUMAR").filter((e) => e.type === "name" && !e.candidate).map((e) => e.raw);
    expect(names).toContain("RAVI TESTKUMAR");
  });

  it("a bilingual label works too", () => {
    const names = findLocalEntities("नाम / Name\nSACHIN T S").filter((e) => e.type === "name").map((e) => e.raw);
    expect(names).toContain("SACHIN T S");
  });

  it("a heading that contains 'Name' with no value below isn't a name (negative)", () => {
    expect(findLocalEntities("Name\n12345\nField Name Reference").filter((e) => e.type === "name" && !e.candidate)).toEqual([]);
  });
});

describe("dates of birth", () => {
  it("next to a birth label: same line or the line below (positive)", () => {
    expect(findBirthDates("Date of Birth: 05/12/1990").map((d) => d.raw)).toEqual(["05/12/1990"]);
    expect(findBirthDates("जन्म की तारीख / Date of Birth\n05/12/1990").map((d) => d.raw)).toEqual(["05/12/1990"]);
    expect(findBirthDates("DOB 1-1-2001").map((d) => d.raw)).toEqual(["1-1-2001"]);
  });

  it("on a PAN card an unlabelled date is the date of birth (the label is often under a hologram)", () => {
    expect(findBirthDates("INCOME TAX DEPARTMENT\nPermanent Account Number Card\n05/12/1990").map((d) => d.raw)).toEqual(["05/12/1990"]);
  });

  it("dates without a birth label aren't reported (negative)", () => {
    expect(findBirthDates("01-07-2026 SALARY CREDIT\n05-08-2026 LIC PREMIUM")).toEqual([]);
    expect(findBirthDates("Date of issue 05/12/1990")).toEqual([]);
  });
});

describe.skipIf(!hasPaddle)("PP-OCR on the fake PAN-card photo", () => {
  const bytes = new Uint8Array(readFileSync(new URL("../../../samples/pan-card-photo.jpg", import.meta.url)));
  const OPTS = { profile: "lab", context: null, ocrPageCap: 1, trustedSite: false } as const;

  it("reads the PAN, both names and the date of birth", async () => {
    const r = await scan(bytes, OPTS, { ocr: await nodePaddle() });
    expect(r.findings.some((f) => f.type === "pan" && f.masked.endsWith("34F"))).toBe(true);
    expect(r.findings.filter((f) => f.type === "name").length).toBeGreaterThanOrEqual(2);
    expect(r.findings.some((f) => f.masked.startsWith("Date of birth"))).toBe(true);
    expect(r.findings.some((f) => f.masked === "PAN card")).toBe(true);
  });

  it("after redaction neither PP-OCR nor the Tesseract CLI can read the PAN, name or date", async () => {
    const ocr = await nodePaddle();
    const r = await scan(bytes, OPTS, { ocr });
    const out = await redact(r.scanId, { selectedIds: r.findings.filter((f) => f.redactable).map((f) => f.id), watermark: null }, { ocr });
    expect(out.verify.passed).toBe(true);
    const words = (await ocr.recognize(out.bytes!)).map((w) => w.text).join(" ");
    for (const v of [FAKE.pan, "TESTKUMAR", "05/12/1990"]) expect(words).not.toContain(v);
    const file = join(mkdtempSync(join(tmpdir(), "rg-card-")), "out.jpg");
    writeFileSync(file, out.bytes!);
    const cli = execFileSync("tesseract", [file, "-"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    for (const v of [FAKE.pan, "TESTKUMAR", "05/12/1990"]) expect(cli).not.toContain(v);
    expect(cli + words).toMatch(/INCOME|DEPARTMENT/); // the rest of the card is still there
  });
});
