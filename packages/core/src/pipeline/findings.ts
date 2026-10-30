// Turns detector matches on a text layer into display-safe Findings, keeping raw values aside
// for verify(). Shared by PDF text, scanned-PDF OCR and image OCR.
import type { HiddenReason } from "../detect/forensic.ts";
import { findLocalEntities, maskEntity, type NerType } from "../detect/localNer.ts";
import { findIds, maskForDisplay, type IdType } from "../detect/patterns.ts";
import { charIndicesForRange, rectsForRange, type TextLayer } from "../extract/textLayer.ts";
import type { Finding, FindingSource } from "../schemas.ts";
import { isAutoCleanable, severityFor } from "../score.ts";

export type NewFinding = Omit<Finding, "id" | "severity" | "autoCleanable">;

/** Comparable form for verify(): no whitespace/separators, upper-case. */
export const normalizeForCompare = (s: string) => s.replace(/[\s\-_.,:;/]/g, "").toUpperCase();
/** Shorter values match too much unrelated text to be a meaningful removal check. */
const MIN_COMPARE_LENGTH = 4;

export const REASON_TEXT: Record<FindingSource, string> = {
  under_black_box: "is hidden under a black box but can still be copied out",
  black_highlight: "is blacked out by highlighting but can still be copied out",
  unapplied_annot: "is marked for redaction, but the redaction was never applied",
  old_version: "was removed in an edit, but an earlier version inside the file still contains it",
  text: "is visible in the document",
  ocr: "is readable in the image",
  metadata: "is stored in the file's metadata",
  hidden_office: "is hidden in the document",
  claude: "was flagged by AI review",
  combination: "combines with other findings",
};

export const LABEL: Record<IdType | NerType, string> = {
  aadhaar: "Aadhaar number", pan: "PAN", card: "Card number", ifsc: "IFSC code", upi: "UPI ID",
  phone: "Phone number", email: "Email address", vehicle: "Vehicle number", account: "Bank account number",
  name: "Person's name", address: "Address", salary: "Salary amount", medical: "Medical detail",
};

export class FindingCollector {
  readonly findings: Finding[] = [];
  readonly secrets = new Map<string, string[]>();
  /** Finding id → value as it appears in the document, used to remove every copy. Worker-internal. */
  readonly raws = new Map<string, string[]>();
  private n = 0;

  add(f: NewFinding, values: string[]): Finding {
    const finding: Finding = { ...f, id: `f${++this.n}`, severity: severityFor(f.type, f.source), autoCleanable: isAutoCleanable(f.type, f.source) };
    this.findings.push(finding);
    this.secrets.set(finding.id, [...new Set(values.map(normalizeForCompare).filter((v) => v.length >= MIN_COMPARE_LENGTH))]);
    this.raws.set(finding.id, [...new Set(values.map((v) => v.trim()).filter(Boolean))]);
    return finding;
  }

  /** Adds the "identity kit" combination finding (HLD §3.5.6). Call once after all other findings. */
  addCombinationRisks(): void {
    const has = (...types: Finding["type"][]) => this.findings.some((f) => types.includes(f.type));
    if (has("name") && has("aadhaar", "pan") && has("address", "phone")) {
      const parts = ["name", has("aadhaar") ? "Aadhaar" : "PAN", has("address") ? "address" : "phone"];
      this.add({
        type: "identity_kit", source: "combination", page: null, rects: [], masked: parts.join(" + "),
        reason: "Together these are enough to attempt identity fraud (SIM swap, loan or KYC in your name)",
        confidence: 1, redactable: true, detector: "rules",
      }, []);
    }
  }
}

/**
 * Runs Layer 2 (IDs) and local NER over a text layer. `hidden` (PDF text only) marks chars that are
 * visually hidden; matches touching a hidden char take that source instead of `baseSource`.
 */
export function collectTextFindings(
  layer: TextLayer,
  out: FindingCollector,
  opts: { baseSource: "text" | "ocr"; hidden?: (HiddenReason | null)[] },
): { claimed: [number, number][] } {
  const claimed: [number, number][] = [];
  const sourceFor = (start: number, end: number): FindingSource => {
    if (opts.hidden) {
      for (const ci of charIndicesForRange(layer, start, end)) {
        const r = opts.hidden[ci];
        if (r) return r;
      }
    }
    return opts.baseSource;
  };
  const detectorFor = (source: FindingSource, fallback: Finding["detector"]): Finding["detector"] =>
    source === "text" ? fallback : source === "ocr" ? "ocr" : "forensic";

  for (const m of findIds(layer.text, { ocr: opts.baseSource === "ocr" })) {
    const source = sourceFor(m.start, m.end);
    claimed.push([m.start, m.end]);
    out.add({
      type: m.type, source, page: layer.index, rects: rectsForRange(layer, m.start, m.end),
      masked: maskForDisplay(m.type, m.normalized),
      reason: `${LABEL[m.type]} ${REASON_TEXT[source]}${m.checksumFailed ? " (read by OCR; check digit didn't match, so it may be misread)" : ""}`,
      confidence: m.confidence, redactable: true, detector: detectorFor(source, "regex"),
    }, [m.normalized, m.raw]);
  }

  for (const e of findLocalEntities(layer.text)) {
    if (e.candidate) continue; // weak signal: only steers the optional AI pass
    if (claimed.some(([s, en]) => e.start < en && s < e.end)) continue;
    const source = sourceFor(e.start, e.end);
    claimed.push([e.start, e.end]);
    out.add({
      type: e.type, source, page: layer.index, rects: rectsForRange(layer, e.start, e.end),
      masked: maskEntity(e.type, e.raw), reason: `${LABEL[e.type]} ${REASON_TEXT[source]}`,
      confidence: e.confidence, redactable: true, detector: detectorFor(source, "local_ner"),
    }, [e.raw]);
  }
  return { claimed };
}
