import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { LimitError } from "../src/filetype.ts";
import { extractDocx, openZip, readPart } from "../src/extract/office.ts";

async function docxWith(documentXml: string): Promise<JSZip> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", "<Types/>");
  zip.file("word/document.xml", documentXml);
  return openZip(await zip.generateAsync({ type: "uint8array" }));
}

describe("office extraction security", () => {
  it("rejects a part that declares a DOCTYPE (XXE / entity expansion)", async () => {
    const zip = await docxWith('<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaa">]><w:document><w:t>&a;</w:t></w:document>');
    await expect(extractDocx(zip)).rejects.toBeInstanceOf(LimitError);
  });

  it("stops inflating a part once it passes the byte cap", async () => {
    const zip = await docxWith("<w:document>" + "x".repeat(200_000) + "</w:document>");
    await expect(readPart(zip, "word/document.xml", 50_000)).rejects.toMatchObject({ code: "zip_too_large" });
    await expect(readPart(zip, "word/document.xml", 1_000_000)).resolves.toContain("<w:document>");
  });

  it("decodes only built-in and numeric entities", async () => {
    const zip = await docxWith('<w:document><w:body><w:p><w:r><w:t>A &amp; B &#65; &unknown;</w:t></w:r></w:p></w:body></w:document>');
    const ex = await extractDocx(zip);
    expect(ex.segments.find((s) => s.kind === "body")?.text).toBe("A & B A &unknown;");
  });

  it("a run with w:vanish w:val=\"0\" is visible, not hidden", async () => {
    const zip = await docxWith('<w:document><w:body><w:p><w:r><w:rPr><w:vanish w:val="0"/></w:rPr><w:t>shown</w:t></w:r></w:p></w:body></w:document>');
    const ex = await extractDocx(zip);
    expect(ex.segments.map((s) => s.kind)).toEqual(["body"]);
  });
});
