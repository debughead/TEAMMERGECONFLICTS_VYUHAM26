// DOCX/XLSX scan (D-003): hidden content and metadata are reported; only comments and metadata
// are cleanable. Body findings are reported but not redactable here (export to PDF to redact).
import { findLocalEntities, maskEntity } from "../detect/localNer.ts";
import { findIds, maskForDisplay } from "../detect/patterns.ts";
import { extractDocx, extractXlsx, openZip, type OfficeSegment } from "../extract/office.ts";
import type { FileType } from "../schemas.ts";
import { FindingCollector, LABEL } from "./findings.ts";
import { maskMeta } from "./scanPdf.ts";

const SEGMENT_TEXT: Record<OfficeSegment["kind"], string> = {
  body: "is in the document text",
  deleted: "is in a tracked deletion; anyone can show it with Track Changes",
  hidden_text: "is formatted as hidden text",
  comment: "is in a comment",
  black_highlight: "is blacked out with highlighting but is still plain text",
  hidden_sheet: "is on a hidden sheet",
  hidden_row: "is in a hidden row",
  hidden_column: "is in a hidden column",
};
const SEGMENT_LABEL: Record<Exclude<OfficeSegment["kind"], "body">, string> = {
  deleted: "Deleted text kept in tracked changes",
  hidden_text: "Hidden text",
  comment: "Comment text",
  black_highlight: "Black-highlighted text",
  hidden_sheet: "Content on a hidden sheet",
  hidden_row: "Content in hidden rows",
  hidden_column: "Content in hidden columns",
};

export interface OfficeScanOutput { collector: FindingCollector; warnings: string[] }

export async function scanOffice(bytes: Uint8Array, fileType: Extract<FileType, "docx" | "xlsx">): Promise<OfficeScanOutput> {
  const zip = await openZip(bytes);
  const ex = fileType === "docx" ? await extractDocx(zip) : await extractXlsx(zip);
  const out = new FindingCollector();

  for (const seg of ex.segments) {
    const hidden = seg.kind !== "body";
    const source = hidden ? "hidden_office" : "text";
    // Only comments are removed by the Office clean step (D-003).
    const redactable = seg.kind === "comment";
    const why = SEGMENT_TEXT[seg.kind];
    if (seg.kind !== "body") {
      out.add({
        type: "hidden_content", source, page: null, rects: [], redactable, detector: "office", confidence: 1,
        masked: `${SEGMENT_LABEL[seg.kind]} (${seg.text.replace(/\s/g, "").length} characters) in ${seg.where}`,
        reason: `Text ${why}`,
      }, [seg.text]);
    }
    for (const m of findIds(seg.text)) {
      out.add({
        type: m.type, source, page: null, rects: [], redactable, detector: "office", confidence: m.confidence,
        masked: maskForDisplay(m.type, m.normalized), reason: `${LABEL[m.type]} ${why}`,
      }, [m.normalized, m.raw]);
    }
    for (const e of findLocalEntities(seg.text).filter((x) => !x.candidate)) {
      out.add({
        type: e.type, source, page: null, rects: [], redactable, detector: "office", confidence: e.confidence,
        masked: maskEntity(e.type, e.raw), reason: `${LABEL[e.type]} ${why}`,
      }, [e.raw]);
    }
  }
  for (const [key, value] of Object.entries(ex.meta)) {
    out.add({
      type: "metadata", source: "metadata", page: null, rects: [], redactable: true, detector: "metadata", confidence: 1,
      masked: `${key}: ${maskMeta(value)}`, reason: `The document's ${key} property is stored in its metadata`,
    }, [value]);
  }
  if (ex.trackedInsertions > 0) {
    out.add({
      type: "hidden_content", source: "hidden_office", page: null, rects: [], redactable: false, detector: "office", confidence: 1,
      masked: `${ex.trackedInsertions} tracked insertion(s)`, reason: "Tracked changes record who edited what and when",
    }, []);
  }
  // Auto-clean can only act on what the clean step removes.
  for (const f of out.findings) if (!f.redactable) f.autoCleanable = false;
  const unredactable = out.findings.some((f) => !f.redactable);
  return {
    collector: out,
    warnings: unredactable ? ["Word/Excel files can only be cleaned of metadata and comments here. To remove other text, export to PDF and scan that."] : [],
  };
}
