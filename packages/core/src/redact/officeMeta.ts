// Office "clean" (D-003): blank personal metadata (core, app and custom properties), remove comments and
// the saved preview thumbnail. Body text, tracked changes and hidden sheets are not rewritten; the UI
// advises exporting to PDF for those.
import type JSZip from "jszip";
import { isSensitivityLabel, readPart } from "../extract/office.ts";

const EMPTY_CORE = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"></cp:coreProperties>`;
const APP_FIELDS_TO_DROP = ["Company", "Manager", "Application", "AppVersion", "Template", "HyperlinkBase"];

const isCommentPart = (n: string) =>
  /^word\/(comments[^/]*|people)\.xml$/.test(n) ||
  /^xl\/(comments[^/]*\.xml|threadedComments\/.*|persons\/.*|drawings\/vmlDrawing[^/]*\.vml)$/.test(n);
/** The preview picture saved with the file: an image of the first page as it was before cleaning. */
const isThumbnail = (n: string) => /^docProps\/thumbnail\.[a-z]+$/i.test(n);

export async function cleanOffice(zip: JSZip): Promise<Uint8Array<ArrayBuffer>> {
  if (zip.file("docProps/core.xml")) zip.file("docProps/core.xml", EMPTY_CORE);
  const app = await readPart(zip, "docProps/app.xml");
  if (app) {
    let cleaned = app;
    for (const f of APP_FIELDS_TO_DROP) cleaned = cleaned.replace(new RegExp(`<${f}(?:\\s[^>]*)?>[\\s\\S]*?</${f}>|<${f}(?:\\s[^>]*)?/>`, "g"), "");
    zip.file("docProps/app.xml", cleaned);
  }

  // Custom properties hold whatever the author's systems stored. Sensitivity labels stay (they say how
  // the file must be handled); the part goes if nothing else is left in it.
  const custom = await readPart(zip, "docProps/custom.xml");
  let dropCustom = false;
  if (custom) {
    const kept = custom.replace(/<(?:[A-Za-z_][\w.-]*:)?property\s[^>]*>[\s\S]*?<\/(?:[A-Za-z_][\w.-]*:)?property>/g,
      (p) => (isSensitivityLabel(/\bname="([^"]*)"/.exec(p)?.[1] ?? "") ? p : ""));
    if (/<(?:[A-Za-z_][\w.-]*:)?property\s/.test(kept)) zip.file("docProps/custom.xml", kept);
    else dropCustom = true;
  }

  const removed = Object.keys(zip.files).filter((n) => isCommentPart(n) || isThumbnail(n) || (dropCustom && n === "docProps/custom.xml"));
  for (const n of removed) zip.remove(n);
  const removedTargets = new Set(removed.map((n) => n.split("/").pop()!));

  // Drop relationships and content-type overrides that pointed at removed parts.
  for (const relsName of Object.keys(zip.files).filter((n) => n.endsWith(".rels"))) {
    const rels = (await readPart(zip, relsName)) ?? "";
    const next = rels.replace(/<Relationship\s[^>]*\/>/g, (tag) => {
      const target = /Target="([^"]*)"/.exec(tag)?.[1] ?? "";
      return removedTargets.has(target.split("/").pop() ?? "") ? "" : tag;
    });
    if (next !== rels) zip.file(relsName, next);
  }
  const ct = await readPart(zip, "[Content_Types].xml");
  if (ct) {
    zip.file("[Content_Types].xml", ct.replace(/<Override\s[^>]*\/>/g, (tag) => {
      const part = /PartName="\/?([^"]*)"/.exec(tag)?.[1] ?? "";
      return removed.includes(part) ? "" : tag;
    }));
  }

  // Remove comment anchors from the body/sheets so nothing references the deleted parts.
  const doc = await readPart(zip, "word/document.xml");
  if (doc) {
    zip.file("word/document.xml", doc
      .replace(/<w:commentRange(?:Start|End)\s[^>]*\/>/g, "")
      .replace(/<w:r>(?:(?!<\/w:r>)[\s\S])*?<w:commentReference\s[^>]*\/>(?:(?!<\/w:r>)[\s\S])*?<\/w:r>/g, ""));
  }
  for (const sheet of Object.keys(zip.files).filter((n) => /^xl\/worksheets\/[^/]+\.xml$/.test(n))) {
    const xml = (await readPart(zip, sheet)) ?? "";
    const next = xml.replace(/<legacyDrawing\s[^>]*\/>/g, "");
    if (next !== xml) zip.file(sheet, next);
  }
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" }) as Promise<Uint8Array<ArrayBuffer>>;
}
