// DOCX/XLSX extraction (docs/HLD.md §3.4, D-003: scan + clean only).
// No DOMParser (absent in Web Workers and Node): a small tag scanner reads the parts we need.
// It never expands entities beyond the five XML built-ins and numeric refs, and any DOCTYPE is
// rejected, so XXE/billion-laughs cannot apply.
import JSZip from "jszip";
import { LimitError, LIMITS } from "../filetype.ts";

export interface OfficeSegment {
  kind: "body" | "deleted" | "hidden_text" | "comment" | "black_highlight" | "hidden_sheet" | "hidden_row" | "hidden_column";
  /** Where it was found, e.g. "word/document.xml" or "Sheet 'Payroll'". */
  where: string;
  /** Raw text, worker-internal only. */
  text: string;
}

export interface OfficeExtract {
  segments: OfficeSegment[];
  /** Raw metadata values by field name. */
  meta: Record<string, string>;
  trackedInsertions: number;
}

/** Max bytes inflated from any one part; protects against entries that lie about their size. */
const MAX_PART_BYTES = 25 * 1024 * 1024;

// JSZip's per-entry stream is implemented (lib/zipObject.js) but missing from its .d.ts.
interface StreamHelper {
  on(event: "data", cb: (chunk: Uint8Array) => void): StreamHelper;
  on(event: "end", cb: () => void): StreamHelper;
  on(event: "error", cb: (e: Error) => void): StreamHelper;
  resume(): StreamHelper;
  pause(): StreamHelper;
}
interface StreamableEntry { internalStream(type: "uint8array"): StreamHelper }

export async function openZip(bytes: Uint8Array): Promise<JSZip> {
  return JSZip.loadAsync(bytes, { checkCRC32: true });
}

/** Reads a part as UTF-8 text, stopping as soon as it exceeds `cap` bytes. */
export async function readPart(zip: JSZip, name: string, cap = MAX_PART_BYTES): Promise<string | null> {
  const entry = zip.file(name);
  if (!entry) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  await new Promise<void>((resolve, reject) => {
    const stream = (entry as unknown as StreamableEntry).internalStream("uint8array");
    stream
      .on("data", (chunk) => {
        total += chunk.length;
        if (total > cap) {
          stream.pause();
          reject(new LimitError("zip_too_large", `Part ${name} expands beyond ${cap} bytes`));
          return;
        }
        chunks.push(chunk);
      })
      .on("error", reject)
      .on("end", resolve)
      .resume();
  });
  const all = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { all.set(c, o); o += c.length; }
  const xml = new TextDecoder("utf-8").decode(all);
  if (/<!DOCTYPE/i.test(xml)) throw new LimitError("malformed", `Part ${name} declares a DOCTYPE, which is not allowed`);
  return xml;
}

const decodeEntities = (s: string) =>
  s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (_, e: string) => {
    switch (e.toLowerCase()) {
      case "lt": return "<"; case "gt": return ">"; case "amp": return "&"; case "quot": return '"'; case "apos": return "'";
    }
    const code = e[1]?.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
  });

/** Concatenated text of all `<tag>…</tag>` elements (tag may include a prefix, e.g. "w:t"). */
function textOf(xml: string, tag: string): string {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "g");
  return [...xml.matchAll(re)].map((m) => decodeEntities(m[1]!)).join("");
}

/** Every `<tag …>…</tag>` element (non-nested tags only, which holds for w:p, w:r, w:del, row, si…). */
function elements(xml: string, tag: string): { attrs: string; inner: string; outer: string }[] {
  const re = new RegExp(`<${tag}(\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "g");
  return [...xml.matchAll(re)].map((m) => ({ attrs: m[1] ?? "", inner: m[2]!, outer: m[0] }));
}

const attr = (attrs: string, name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1];

// ---------- metadata ----------

const CORE_FIELDS = ["dc:creator", "cp:lastModifiedBy", "dc:title", "dc:subject", "dc:description", "cp:keywords", "cp:category", "dcterms:created", "dcterms:modified"];
const APP_FIELDS = ["Company", "Manager", "Application", "Template"];

async function readMeta(zip: JSZip): Promise<Record<string, string>> {
  const meta: Record<string, string> = {};
  const core = await readPart(zip, "docProps/core.xml");
  if (core) for (const f of CORE_FIELDS) { const v = textOf(core, f).trim(); if (v) meta[f] = v; }
  const app = await readPart(zip, "docProps/app.xml");
  if (app) for (const f of APP_FIELDS) { const v = textOf(app, f).trim(); if (v) meta[f] = v; }
  return meta;
}

// ---------- DOCX ----------

export async function extractDocx(zip: JSZip): Promise<OfficeExtract> {
  const doc = (await readPart(zip, "word/document.xml")) ?? "";
  const segments: OfficeSegment[] = [];
  const where = "word/document.xml";

  const deleted = elements(doc, "w:del").map((d) => textOf(d.inner, "w:delText")).join(" ").trim();
  if (deleted) segments.push({ kind: "deleted", where, text: deleted });

  const hidden: string[] = [];
  const blackHl: string[] = [];
  const body: string[] = [];
  // Strip deletions first so their runs don't count as body text.
  const withoutDel = doc.replace(/<w:del(?:\s[^>]*)?>[\s\S]*?<\/w:del>/g, "");
  for (const p of elements(withoutDel, "w:p")) {
    const para: string[] = [];
    for (const r of elements(p.inner, "w:r")) {
      const t = textOf(r.inner, "w:t");
      if (!t) continue;
      const rPr = /<w:rPr>([\s\S]*?)<\/w:rPr>/.exec(r.inner)?.[1] ?? "";
      if (/<w:vanish(?:\s[^>]*)?\/>/.test(rPr) && !/<w:vanish\s+w:val="(?:0|false)"/.test(rPr)) hidden.push(t);
      else if (/<w:highlight\s+w:val="black"/.test(rPr) || /<w:shd\s[^>]*w:fill="000000"/i.test(rPr)) blackHl.push(t);
      else para.push(t);
    }
    if (para.length) body.push(para.join(""));
  }
  if (hidden.length) segments.push({ kind: "hidden_text", where, text: hidden.join(" ") });
  if (blackHl.length) segments.push({ kind: "black_highlight", where, text: blackHl.join(" ") });
  if (body.length) segments.push({ kind: "body", where, text: body.join("\n") });

  for (const name of Object.keys(zip.files).filter((n) => /^word\/comments[^/]*\.xml$/.test(n))) {
    const xml = (await readPart(zip, name)) ?? "";
    const text = elements(xml, "w:comment").map((c) => textOf(c.inner, "w:t")).join("\n").trim();
    if (text) segments.push({ kind: "comment", where: name, text });
  }
  return { segments, meta: await readMeta(zip), trackedInsertions: elements(doc, "w:ins").length };
}

// ---------- XLSX ----------

export async function extractXlsx(zip: JSZip): Promise<OfficeExtract> {
  const workbook = (await readPart(zip, "xl/workbook.xml")) ?? "";
  const rels = (await readPart(zip, "xl/_rels/workbook.xml.rels")) ?? "";
  const shared = await readPart(zip, "xl/sharedStrings.xml");
  const sharedStrings = shared ? elements(shared, "si").map((si) => textOf(si.inner, "t")) : [];
  const relTarget = (id: string) => {
    const m = new RegExp(`<Relationship\\s[^>]*Id="${id}"[^>]*>`).exec(rels)?.[0];
    const target = m ? attr(m, "Target") : undefined;
    return target ? (target.startsWith("/") ? target.slice(1) : `xl/${target}`) : undefined;
  };

  const segments: OfficeSegment[] = [];
  const sheetTags = [...workbook.matchAll(/<sheet\s[^>]*\/?>/g)].map((m) => m[0]);
  if (sheetTags.length > LIMITS.maxZipEntries) throw new LimitError("zip_too_many_entries", "Too many sheets");
  for (const tag of sheetTags) {
    const name = decodeEntities(attr(tag, "name") ?? "?");
    const state = attr(tag, "state") ?? "visible";
    const path = relTarget(attr(tag, "r:id") ?? "");
    const xml = path ? (await readPart(zip, path)) ?? "" : "";
    const cellText = (cell: { attrs: string; inner: string }) =>
      attr(cell.attrs, "t") === "s" ? sharedStrings[Number(textOf(cell.inner, "v"))] ?? "" :
      attr(cell.attrs, "t") === "inlineStr" ? textOf(cell.inner, "t") : textOf(cell.inner, "v");
    const hiddenCols = [...xml.matchAll(/<col\s[^>]*hidden="(?:1|true)"[^>]*\/?>/g)].map((m) => [Number(attr(m[0], "min")), Number(attr(m[0], "max"))] as const);

    const visible: string[] = [];
    const hiddenRows: string[] = [];
    const hiddenColText: string[] = [];
    for (const row of elements(xml, "row")) {
      const cells = elements(row.inner, "c");
      if (/\bhidden="(?:1|true)"/.test(row.attrs)) { hiddenRows.push(cells.map(cellText).join(" ")); continue; }
      const line: string[] = [];
      for (const c of cells) {
        const col = colIndex(attr(c.attrs, "r") ?? "");
        (hiddenCols.some(([a, b]) => col >= a && col <= b) ? hiddenColText : line).push(cellText(c));
      }
      visible.push(line.join(" "));
    }
    const all = [...visible, ...hiddenRows, ...hiddenColText].join("\n").trim();
    if (state !== "visible") {
      if (all) segments.push({ kind: "hidden_sheet", where: `Sheet '${name}'`, text: all });
      continue;
    }
    if (hiddenRows.join("").trim()) segments.push({ kind: "hidden_row", where: `Sheet '${name}'`, text: hiddenRows.join("\n") });
    if (hiddenColText.join("").trim()) segments.push({ kind: "hidden_column", where: `Sheet '${name}'`, text: hiddenColText.join("\n") });
    if (visible.join("").trim()) segments.push({ kind: "body", where: `Sheet '${name}'`, text: visible.join("\n") });
  }

  for (const name of Object.keys(zip.files).filter((n) => /^xl\/comments[^/]*\.xml$/.test(n) || /^xl\/threadedComments\//.test(n))) {
    const xml = (await readPart(zip, name)) ?? "";
    const text = [...elements(xml, "comment"), ...elements(xml, "threadedComment")].map((c) => textOf(c.inner, "t")).join("\n").trim();
    if (text) segments.push({ kind: "comment", where: name, text });
  }
  return { segments, meta: await readMeta(zip), trackedInsertions: 0 };
}

/** "B12" → 2 (1-based column number). */
function colIndex(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? "";
  return [...letters].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0);
}
