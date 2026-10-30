// Layer 1: text that is extractable but visually hidden (docs/HLD.md §3.5.1).
import type { AnnotInfo, PdfPage } from "../extract/pdf.ts";
import type { DrawEvent } from "../extract/pdfFills.ts";
import type { FindingSource, Rect } from "../schemas.ts";
import { area, center, containsPoint, coverage, luminance } from "../util/geom.ts";

export const DARK_LUMINANCE = 0.25;
export const MIN_OPAQUE_ALPHA = 0.9;
/** Fraction of a character's box a dark shape must cover for the character to count as hidden. */
export const MIN_COVERAGE = 0.6;
/** Text this dark on a dark shape is unreadable even when the shape is underneath it. */
const DARK_TEXT_LUMINANCE = 0.35;

export type HiddenReason = Extract<FindingSource, "under_black_box" | "black_highlight" | "unapplied_annot">;

/** For each char in `page.chars`, why it is hidden, or null if visible. */
export function hiddenChars(page: PdfPage): (HiddenReason | null)[] {
  const darkShapes = page.draws.filter(
    (d) => d.kind !== "text" && d.luminance < DARK_LUMINANCE && d.alpha >= MIN_OPAQUE_ALPHA && area(d.rect) > 0,
  );
  const textDraws = page.draws.filter((d) => d.kind === "text");
  const redactAnnots = page.annots.filter((a) => a.type === "Redact");
  const darkAnnots = page.annots.filter(isDarkCoveringAnnot);

  return page.chars.map((ch) => {
    if (!ch.c.trim()) return null;
    if (redactAnnots.some((a) => coverage(ch.rect, a.rect) >= MIN_COVERAGE)) return "unapplied_annot";
    // Annotations paint above page content, so a dark one always covers.
    if (darkAnnots.some((a) => coverage(ch.rect, a.rect) >= MIN_COVERAGE)) return "under_black_box";

    const covering = darkShapes.filter((d) => coverage(ch.rect, d.rect) >= MIN_COVERAGE);
    if (covering.length === 0) return null;
    const textSeq = owningTextDraw(ch.rect, textDraws)?.seq ?? -1;
    if (covering.some((d) => d.seq > textSeq)) return "under_black_box";
    // Shape is underneath: hidden only if the text is dark too (black-on-black "highlight").
    return luminance(ch.color) < DARK_TEXT_LUMINANCE ? "black_highlight" : null;
  });
}

/** Smallest text draw whose bounds contain the char centre (text bounds overlap between lines). */
function owningTextDraw(rect: Rect, texts: DrawEvent[]): DrawEvent | undefined {
  const c = center(rect);
  let best: DrawEvent | undefined;
  for (const t of texts) {
    if (containsPoint(t.rect, c) && (!best || area(t.rect) < area(best.rect))) best = t;
  }
  return best;
}

function isDarkCoveringAnnot(a: AnnotInfo): boolean {
  if (a.type === "Square" && a.interiorColor.length > 0) return luminance(a.interiorColor) < DARK_LUMINANCE;
  if (a.type === "Highlight" && a.color.length > 0) return luminance(a.color) < DARK_LUMINANCE;
  return false;
}

export interface HiddenRun {
  /** Offsets into page.text, end exclusive. */
  start: number;
  end: number;
  reason: HiddenReason;
}

/** Contiguous hidden stretches of page text (whitespace inside a run keeps it going). */
export function hiddenRuns(page: PdfPage, hidden: (HiddenReason | null)[]): HiddenRun[] {
  const runs: HiddenRun[] = [];
  let cur: HiddenRun | null = null;
  for (let i = 0; i < page.text.length; i++) {
    const ci = page.textToChar[i]!;
    const reason = ci >= 0 ? hidden[ci] ?? null : null;
    const isSpace = ci >= 0 && !page.chars[ci]!.c.trim();
    if (reason && (!cur || cur.reason === reason)) {
      if (!cur) cur = { start: i, end: i + 1, reason };
      else cur.end = i + 1;
    } else if (cur && isSpace) {
      continue;
    } else {
      if (cur) runs.push(cur);
      cur = reason ? { start: i, end: i + 1, reason } : null;
    }
  }
  if (cur) runs.push(cur);
  return runs;
}
