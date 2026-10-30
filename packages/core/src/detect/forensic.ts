// Layer 1: text that is extractable but visually hidden (docs/HLD.md §3.5.1).
import type { AnnotInfo, PdfPage } from "../extract/pdf.ts";
import { visibleRect, type DrawEvent } from "../extract/pdfFills.ts";
import type { FindingSource, Rect } from "../schemas.ts";
import { area, center, containsPoint, coverage, luminance } from "../util/geom.ts";

export const DARK_LUMINANCE = 0.25;
export const MIN_OPAQUE_ALPHA = 0.9;
/** Fraction of a character's box a dark shape must cover for the character to count as hidden. */
export const MIN_COVERAGE = 0.6;
/** Text this dark on a dark shape is unreadable even when the shape is underneath it. */
const DARK_TEXT_LUMINANCE = 0.35;
/**
 * Near-white text on a near-white backdrop. Strict on purpose: light-grey watermarks (~0.85) and
 * faint form hints must not count, only text painted to disappear.
 */
const CAMOUFLAGE_MIN_LUMINANCE = 0.95;
/** Glyphs shorter than this (points) can't be seen at any normal zoom. Real superscripts are ~4 pt. */
const TINY_TEXT_HEIGHT = 1;
/** A glyph counts as clipped away when less than this fraction of it is inside its clipping area. */
const CLIP_VISIBLE_MIN = 0.4;

/** Why a character is extractable but not visible. */
export type HiddenReason =
  | "under_black_box" | "black_highlight" | "unapplied_annot" | "same_colour" | "tiny_text"
  | "covered" | "clipped" | "invisible_text";

/** The Finding source each reason is reported as (the shared contract has no finer-grained sources). */
export const HIDDEN_SOURCE: Record<HiddenReason, FindingSource> = {
  under_black_box: "under_black_box",
  black_highlight: "black_highlight",
  unapplied_annot: "unapplied_annot",
  same_colour: "hidden_office",
  tiny_text: "hidden_office",
  covered: "hidden_office",
  clipped: "hidden_office",
  invisible_text: "hidden_office",
};

/** Completes "<what> …" in finding reasons. */
export const HIDDEN_TEXT: Record<HiddenReason, string> = {
  under_black_box: "is hidden under a black box but can still be copied out",
  black_highlight: "is blacked out by highlighting but can still be copied out",
  unapplied_annot: "is marked for redaction, but the redaction was never applied",
  same_colour: "is the same colour as its background, so it's invisible but can still be copied out",
  tiny_text: "is printed too small to see but can still be copied out",
  covered: "is covered by a shape or picture drawn on top of it, but can still be copied out",
  clipped: "is cut out of view by a clipping area, but can still be copied out",
  invisible_text: "is set to invisible, so it can't be seen but can still be copied out",
};

/** For each char in `page.chars`, why it is hidden, or null if visible. */
export function hiddenChars(page: PdfPage): (HiddenReason | null)[] {
  // Anything opaque that paints: a later one covers earlier text, whatever its colour (whiteout boxes
  // and pasted pictures hide text as well as black boxes do).
  const covers = page.draws.filter((d) => (d.kind === "fill" || d.kind === "image") && d.alpha >= MIN_OPAQUE_ALPHA && area(visibleRect(d) ?? [0, 0, 0, 0]) > 0);
  const textDraws = page.draws.filter((d) => d.kind === "text" || d.kind === "invisible_text");
  const redactAnnots = page.annots.filter((a) => a.type === "Redact");
  const darkAnnots = page.annots.filter(isDarkCoveringAnnot);

  return page.chars.map((ch) => {
    if (!ch.c.trim()) return null;
    if (redactAnnots.some((a) => coverage(ch.rect, a.rect) >= MIN_COVERAGE)) return "unapplied_annot";
    // Annotations paint above page content, so a dark one always covers.
    if (darkAnnots.some((a) => coverage(ch.rect, a.rect) >= MIN_COVERAGE)) return "under_black_box";
    const reason = paintReason(ch);
    // Shape rules see bounding boxes; pixels settle it. Text whose ink mostly shows isn't hidden.
    if (reason && PAINT_REASONS.has(reason)) {
      const shown = page.inkVisible(ch.rect);
      if (shown !== null && shown >= MIN_VISIBLE_INK) return null;
    }
    return reason;
  });

  function paintReason(ch: PdfPage["chars"][number]): HiddenReason | null {

    const owner = owningTextDraw(ch.rect, textDraws);
    const textSeq = owner?.seq ?? -1;
    if (owner?.clip && coverage(ch.rect, owner.clip) < CLIP_VISIBLE_MIN) return "clipped";

    const over = covers.filter((d) => coverage(ch.rect, visibleRect(d)!) >= MIN_COVERAGE);
    if (owner?.kind === "invisible_text") {
      // An invisible text layer over a picture is how searchable scans work: the words mirror what the
      // picture shows. Invisible text with no picture behind or over it is hidden text.
      return over.some((d) => d.kind === "image") ? null : "invisible_text";
    }
    const above = over.filter((d) => d.seq > textSeq);
    if (above.some((d) => d.luminance < DARK_LUMINANCE)) return "under_black_box";
    if (above.length) return "covered";
    // Dark shape underneath: hidden only if the text is dark too (black-on-black "highlight"), and only
    // if nothing light was painted between that shape and the text (dark logo letter on a light
    // badge that sits on a dark header band).
    const backdrop = backdropUnder(ch.rect, textSeq, page.draws);
    if (backdrop && backdrop.luminance < DARK_LUMINANCE) return luminance(ch.color) < DARK_TEXT_LUMINANCE ? "black_highlight" : null;
    return invisibleOnPage(ch, backdrop);
  }
}

/** Reasons decided from painted geometry, so the rendered pixels get the final say. */
const PAINT_REASONS: ReadonlySet<HiddenReason> = new Set(["under_black_box", "black_highlight", "covered", "same_colour", "clipped"]);
/** A glyph with at least this share of its ink visible on the rendered page is readable. */
const MIN_VISIBLE_INK = 0.5;

/** Hidden without anything on top: too small to see, or painted in the colour of what's under it. */
function invisibleOnPage(ch: PdfPage["chars"][number], backdrop: DrawEvent | undefined): HiddenReason | null {
  const h = ch.rect[3] - ch.rect[1];
  if (h > 0 && h < TINY_TEXT_HEIGHT) return "tiny_text";
  // Patterns/unknown colour spaces report no components (luminance() treats them as white): skip.
  if (![1, 3, 4].includes(ch.color.length) || luminance(ch.color) < CAMOUFLAGE_MIN_LUMINANCE) return null;
  // Nothing painted underneath means the white page. Over an image we can't judge the local colour.
  if (!backdrop) return "same_colour";
  return backdrop.kind === "fill" && backdrop.luminance >= CAMOUFLAGE_MIN_LUMINANCE ? "same_colour" : null;
}

/** The topmost opaque shape painted before `textSeq` that covers the char: what the text sits on. */
function backdropUnder(rect: Rect, textSeq: number, draws: DrawEvent[]): DrawEvent | undefined {
  let top: DrawEvent | undefined;
  for (const d of draws) {
    if ((d.kind !== "fill" && d.kind !== "image") || d.seq >= textSeq || d.alpha < MIN_OPAQUE_ALPHA) continue;
    const v = visibleRect(d);
    if (v && coverage(rect, v) >= MIN_COVERAGE && (!top || d.seq > top.seq)) top = d;
  }
  return top;
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
