// Turns detector matches on a text layer into display-safe Findings, keeping raw values aside
// for verify(). Shared by PDF text, scanned-PDF OCR and image OCR.
import { HIDDEN_SOURCE, HIDDEN_TEXT, type HiddenReason } from "../detect/forensic.ts";
import { findLocalEntities, maskEntity, type NerType } from "../detect/localNer.ts";
import { findIds, maskForDisplay, type IdType } from "../detect/patterns.ts";
import { charIndicesForRange, rectsForRange, type TextLayer } from "../extract/textLayer.ts";
import type { Finding, FindingSource, Rect } from "../schemas.ts";
import { findBars, findQrCodes, lumPlane } from "../detect/imageForensics.ts";
import { findBirthDates, recogniseIdCard } from "../detect/idCards.ts";
import { isAutoCleanable, severityFor } from "../score.ts";

export type NewFinding = Omit<Finding, "id" | "severity" | "autoCleanable">;

/** ~11 km: enough for a region-level map pin without revealing the exact spot. */
export const coarseCoord = (v: number) => Math.round(v * 10) / 10;

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
  /** `severity` overrides the type's default when a rule knows better (e.g. a QR code on an ID card). */
  add(f: NewFinding, values: string[], severity?: Finding["severity"]): Finding {
    const finding: Finding = { ...f, id: `f${++this.n}`, severity: severity ?? severityFor(f.type, f.source), autoCleanable: isAutoCleanable(f.type, f.source) };
    this.findings.push(finding);
    this.secrets.set(finding.id, [...new Set(values.map(normalizeForCompare).filter((v) => v.length >= MIN_COMPARE_LENGTH))]);
    this.raws.set(finding.id, [...new Set(values.map((v) => v.trim()).filter(Boolean))]);
    return finding;
  }

  /** Adds the "identity kit" combination finding (HLD §3.5.6). Call once after all other findings. */
  addCombinationRisks(): void {
    const has = (...types: Finding["type"][]) => this.findings.some((f) => types.includes(f.type));
    const dob = this.findings.some(isBirthDate);
    // A name and an ID number plus any one way to reach or verify the person (address, phone, email,
    // date of birth): enough for a SIM swap, a loan or KYC in their name.
    if (has("name") && has("aadhaar", "pan") && (has("address", "phone", "email") || dob)) {
      const third = has("address") ? "address" : has("phone") ? "phone" : has("email") ? "email" : "date of birth";
      const parts = ["name", has("aadhaar") ? "Aadhaar" : "PAN", third];
      this.add({
        type: "identity_kit", source: "combination", page: null, rects: [], masked: parts.join(" + "),
        reason: "Together these are enough to attempt identity fraud (SIM swap, loan or KYC in your name)",
        confidence: 1, redactable: true, detector: "rules",
      }, []);
    }
  }
}

/** Dates of birth have no type of their own in the shared contract ("other"); this mask marks them. */
export const BIRTH_DATE_MASK = "Date of birth: XX/XX/XXXX";
const isBirthDate = (f: Finding) => f.type === "other" && f.masked.startsWith("Date of birth");

/**
 * Runs Layer 2 (IDs) and local NER over a text layer. `hidden` (PDF text only) marks chars that are
 * visually hidden; matches touching a hidden char take that source instead of `baseSource`.
 */
export function collectTextFindings(
  layer: TextLayer,
  out: FindingCollector,
  opts: {
    baseSource: "text" | "ocr" | "hidden_office";
    hidden?: (HiddenReason | null)[];
    /** Overrides the wording after the label (e.g. "is in a comment on the page"). */
    reasonText?: string;
    /** For text that isn't drawn on the page (comments): removal is structural, so no page areas. */
    noRects?: boolean;
  },
): { claimed: [number, number][] } {
  const claimed: [number, number][] = [];
  const hiddenAt = (start: number, end: number): HiddenReason | null => {
    if (opts.hidden) {
      for (const ci of charIndicesForRange(layer, start, end)) {
        const r = opts.hidden[ci];
        if (r) return r;
      }
    }
    return null;
  };
  const sourceFor = (start: number, end: number): FindingSource => {
    const h = hiddenAt(start, end);
    return h ? HIDDEN_SOURCE[h] : opts.baseSource;
  };
  const whyFor = (start: number, end: number, source: FindingSource): string => {
    const h = hiddenAt(start, end);
    return h ? HIDDEN_TEXT[h] : opts.reasonText ?? REASON_TEXT[source];
  };
  const rectsFor = (start: number, end: number) => (opts.noRects ? [] : rectsForRange(layer, start, end));
  const detectorFor = (source: FindingSource, fallback: Finding["detector"]): Finding["detector"] =>
    source === "text" ? fallback : source === "ocr" ? "ocr" : "forensic";

  for (const m of findIds(layer.text, { ocr: opts.baseSource === "ocr" })) {
    const source = sourceFor(m.start, m.end);
    claimed.push([m.start, m.end]);
    out.add({
      type: m.type, source, page: layer.index, rects: rectsFor(m.start, m.end),
      masked: maskForDisplay(m.type, m.normalized),
      reason: `${LABEL[m.type]} ${whyFor(m.start, m.end, source)}${m.checksumFailed ? " (read by OCR; check digit didn't match, so it may be misread)" : ""}`,
      confidence: m.confidence, redactable: true, detector: detectorFor(source, "regex"),
    }, [m.normalized, m.raw]);
  }

  for (const e of findLocalEntities(layer.text)) {
    if (e.candidate) continue; // weak signal: only steers the optional AI pass
    if (claimed.some(([s, en]) => e.start < en && s < e.end)) continue;
    const source = sourceFor(e.start, e.end);
    claimed.push([e.start, e.end]);
    out.add({
      type: e.type, source, page: layer.index, rects: rectsFor(e.start, e.end),
      masked: maskEntity(e.type, e.raw), reason: `${LABEL[e.type]} ${whyFor(e.start, e.end, source)}`,
      confidence: e.confidence, redactable: true, detector: detectorFor(source, "local_ner"),
    }, [e.raw]);
  }

  // Dates of birth (next to a birth label only). "other" type: the shared contract has no date type.
  for (const d of findBirthDates(layer.text)) {
    if (claimed.some(([s, en]) => d.start < en && s < d.end)) continue;
    const source = sourceFor(d.start, d.end);
    claimed.push([d.start, d.end]);
    out.add({
      type: "other", source, page: layer.index, rects: rectsFor(d.start, d.end),
      masked: BIRTH_DATE_MASK, reason: `Date of birth ${whyFor(d.start, d.end, source)}`,
      confidence: 0.9, redactable: true, detector: detectorFor(source, "local_ner"),
    }, [d.raw], "medium");
  }
  return { claimed };
}

/**
 * Photo forensics for one image (a photo, or an image-only PDF page): redaction bars that leak
 * (translucent, or too thin), QR codes, and ID-card recognition from the OCR text (D-030).
 * `toPage` maps image pixels to the page's coordinate space.
 */
export function collectImageForensics(
  rgb: { pixels: Uint8Array | Uint8ClampedArray; width: number; height: number; stride: number; channels: number },
  ocrText: string,
  page: number,
  toPage: (r: Rect) => Rect,
  out: FindingCollector,
): { barsChecked: number; barsSound: number } {
  const plane = lumPlane(rgb.pixels, rgb.width, rgb.height, rgb.stride, rgb.channels);
  const bars = findBars(plane);
  for (const b of bars) {
    if (b.translucent) {
      out.add({
        type: "hidden_content", source: "under_black_box", page, rects: [toPage(b.rect)], masked: "See-through redaction bar",
        reason: "This bar isn't fully opaque: boosting the contrast can reveal what's under it", confidence: 0.85, redactable: true, detector: "forensic",
      }, []);
    } else if (b.partial) {
      out.add({
        type: "hidden_content", source: "under_black_box", page, rects: [toPage(b.coverRect)], masked: "Redaction bar too thin",
        reason: "The bar doesn't fully cover the text: the edges of the letters underneath are still visible", confidence: 0.85, redactable: true, detector: "forensic",
      }, []);
    }
  }
  const card = recogniseIdCard(ocrText);
  for (const q of findQrCodes(plane)) {
    out.add({
      type: "other", source: "ocr", page, rects: [toPage(q.rect)], masked: "QR code",
      reason: card
        ? `The QR code on a ${card.kind} encodes the holder's details, so anyone with a phone camera can read what the black bars hide`
        : "QR codes can encode personal details; anyone with a phone camera can read it",
      confidence: 0.8, redactable: true, detector: "forensic",
    }, [], card ? "critical" : "high");
  }
  if (card) {
    out.add({
      type: "other", source: "ocr", page, rects: [], masked: card.kind,
      reason: `This is a photo of a ${card.kind}. Even with the numbers hidden, its ${card.extras} can still identify you`,
      confidence: 0.9, redactable: false, detector: "rules",
    }, [], "high");
  }
  return { barsChecked: bars.length, barsSound: bars.filter((b) => !b.partial && !b.translucent).length };
}
