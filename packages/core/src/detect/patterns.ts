// Layer 2: regex candidates kept only after checksum/format validation (docs/HLD.md §3.5).
// Returns raw values with offsets; callers keep them inside the worker session and expose only masked forms.
import type { FindingType } from "../schemas.ts";
import {
  isValidAadhaar, isValidCard, isValidIfsc, isValidIndianMobile, isValidPan, UPI_HANDLES, VEHICLE_STATE_CODES,
} from "./validators.ts";

export type IdType = Extract<FindingType, "aadhaar" | "pan" | "card" | "ifsc" | "upi" | "phone" | "email" | "vehicle" | "account">;

export interface IdMatch {
  type: IdType;
  /** Offsets into the input text, end exclusive. */
  start: number;
  end: number;
  /** Raw matched text as it appears. Worker-internal only. */
  raw: string;
  /** Canonical form (separators removed, upper-cased where relevant). Worker-internal only. */
  normalized: string;
  confidence: number;
  /** True when the checksum failed but strong context suggests the ID (OCR slack, D-005). */
  checksumFailed: boolean;
}

export interface FindIdsOptions {
  /** Text came from OCR: allow near-miss Aadhaar numbers next to an Aadhaar keyword. */
  ocr?: boolean;
}

const KEYWORDS: Record<IdType, RegExp> = {
  aadhaar: /aadhaa?r|uidai|आधार|enrolment|enrollment|\bvid\b/i,
  pan: /\bpan\b|permanent account|income tax/i,
  card: /card|visa|master|rupay|credit|debit/i,
  ifsc: /ifsc|branch|bank/i,
  upi: /upi|vpa|pay/i,
  phone: /mobile|phone|\bmob\b|\btel\b|contact|whatsapp/i,
  email: /e-?mail/i,
  vehicle: /vehicle|registration|\breg\b|rc\b/i,
  account: /a\/c|account|acct/i,
};
const KEYWORD_WINDOW = 40;

// Separators inside numbers: one space, hyphen or dot, used consistently, for documents and OCR.
const AADHAAR_RE = /(?<![\d])(?<![\d][ .-])[2-9]\d{3}([ .-]?)\d{4}\1\d{4}(?![ .-]?\d)/g;
// Mixed or doubled separators, or the number wrapped onto the next line: real documents and OCR produce
// these, but so do columns of unrelated numbers, so this shape needs an Aadhaar keyword nearby.
const AADHAAR_LOOSE_RE = /(?<![\d])(?<![\d][ .-])[2-9]\d{3}(?:[ \t.-]{1,3}|[ \t]*\r?\n[ \t]*)\d{4}(?:[ \t.-]{1,3}|[ \t]*\r?\n[ \t]*)\d{4}(?![ .-]?\d)/g;
/** The 16-digit Aadhaar Virtual ID stands in for the Aadhaar number; it's only taken after its label. */
const VID_RE = /\bvid\b\.?\s*(?:no|number)?\.?\s*[:#-]?\s*(\d{4}([ -]?)\d{4}\2\d{4}\2\d{4})(?![ -]?\d)/dgi;
const CARD_RE = /(?<![\d])(?<![\d][ -])\d(?:[ -]?\d){12,18}(?![ -]?\d)/g;
const CARD_DOTS_RE = /(?<![\d.])\d{4}\.\d{4}\.\d{4}\.\d{4}(?!\.?\d)/g;
// Upper case as printed (OCR may space the groups: "ABCPE 1234 F"), or all lower case as typed into forms.
// Mixed case is left out: it's how ordinary words and codes look.
const PAN_RE = /\b(?:[A-Z]{5} ?\d{4} ?[A-Z]|[a-z]{5}\d{4}[a-z])\b/g;
/** Ten letters/digits: a PAN as OCR may misread it. */
const PAN_OCR_RE = /\b[A-Za-z0-9]{10}\b/g;
const AS_LETTER: Record<string, string> = { "0": "O", "1": "I", "2": "Z", "5": "S", "6": "G", "8": "B" };
const AS_DIGIT: Record<string, string> = { O: "0", Q: "0", D: "0", I: "1", L: "1", Z: "2", S: "5", G: "6", B: "8", T: "7" };

/** Positions 1–5 and 10 must be letters, 6–9 digits: map look-alikes to what the position needs. */
export function fixPanReading(t: string): string {
  return [...t].map((c, i) => (i >= 5 && i <= 8 ? AS_DIGIT[c] ?? c : AS_LETTER[c] ?? c)).join("");
}
const IFSC_RE = /\b[A-Z]{4}0[A-Z0-9]{6}\b/g;
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g;
const UPI_RE = /\b[A-Za-z0-9][A-Za-z0-9._-]{1,255}@([A-Za-z]{2,64})\b(?![.@-]?[A-Za-z0-9])/g;
const PHONE_RE = /(?<![\d+])(?:\+?91[ -]?|0)?([6-9]\d{4})[ -]?(\d{5})(?![ -]?\d)/g;
/** Also written 4-3-3 ("9876 543 210") and 3-3-4 ("987 654 3210"). */
const PHONE_GROUPED_RE = /(?<![\d+])(?:\+?91[ -]?|0)?(?:([6-9]\d{3})[ -](\d{3})[ -](\d{3})|([6-9]\d{2})[ -](\d{3})[ -](\d{4}))(?![ -]?\d)/g;
// Bank account numbers have no checksum, so they are only taken right after an explicit label.
// "AC"/"Acc" alone is how statements abbreviate it ("LOAN AC 7781200045"); without it that reads as a phone
// number. Those short labels must be on the number's own line: "3-tier AC" ends many unrelated lines.
const ACCOUNT_RE = /\b(a\/c|account|acct|acc|ac)\.?\s*(?:no|number|num)?\.?\s*[:#-]?\s*(\d(?:[ -]?\d){8,17})(?![ -]?\d)/dgi;
const VEHICLE_RE = /\b([A-Z]{2})[ -]?(\d{1,2})[ -]?([A-Z]{1,3})[ -]?(\d{4})\b/g;
/** Bharat series: year of registration, "BH", four digits, one or two letters ("22 BH 1234 AB"). */
const VEHICLE_BH_RE = /\b(\d{2})[ -]?BH[ -]?(\d{4})[ -]?([A-Z]{1,2})\b/g;

export function findIds(text: string, opts: FindIdsOptions = {}): IdMatch[] {
  const out: IdMatch[] = [];
  const near = (type: IdType, start: number, end: number) =>
    KEYWORDS[type].test(text.slice(Math.max(0, start - KEYWORD_WINDOW), Math.min(text.length, end + KEYWORD_WINDOW)));
  const push = (type: IdType, m: RegExpMatchArray, normalized: string, base: number, checksumFailed = false) => {
    const start = m.index!;
    const end = start + m[0].length;
    const conf = checksumFailed ? 0.5 : Math.min(1, base + (near(type, start, end) ? 0.15 : 0));
    out.push({ type, start, end, raw: m[0], normalized, confidence: conf, checksumFailed });
  };

  for (const m of text.matchAll(AADHAAR_RE)) {
    const digits = m[0].replace(/[ -]/g, "");
    if (isValidAadhaar(digits)) push("aadhaar", m, digits, 0.85);
    else if (opts.ocr && near("aadhaar", m.index!, m.index! + m[0].length)) push("aadhaar", m, digits, 0.5, true);
  }
  for (const m of text.matchAll(AADHAAR_LOOSE_RE)) {
    if (!near("aadhaar", m.index!, m.index! + m[0].length)) continue;
    const digits = m[0].replace(/\D/g, "");
    if (isValidAadhaar(digits)) push("aadhaar", m, digits, 0.8);
    else if (opts.ocr) push("aadhaar", m, digits, 0.5, true);
  }
  for (const m of text.matchAll(VID_RE)) {
    const [start, end] = m.indices![1]!;
    out.push({ type: "aadhaar", start, end, raw: m[1]!, normalized: m[1]!.replace(/\D/g, ""), confidence: 0.85, checksumFailed: false });
  }
  for (const m of text.matchAll(CARD_RE)) {
    const digits = m[0].replace(/[ -]/g, "");
    if (isValidCard(digits)) push("card", m, digits, 0.8);
  }
  for (const m of text.matchAll(CARD_DOTS_RE)) {
    const digits = m[0].replace(/\./g, "");
    if (isValidCard(digits)) push("card", m, digits, 0.8);
  }
  for (const m of text.matchAll(PAN_RE)) {
    const pan = m[0].replace(/ /g, "").toUpperCase();
    if (isValidPan(pan)) push("pan", m, pan, 0.8);
  }
  if (opts.ocr) {
    // OCR swaps look-alike characters (0/O, 1/I, 5/S, 8/B) on card photos. A PAN is five letters, four
    // digits, one letter, so each position says which reading is right; accept only a valid result.
    for (const m of text.matchAll(PAN_OCR_RE)) {
      // A misread loses a digit or two, not all four: "capability" would otherwise "repair" to CAPAB1117Y.
      if ((m[0].slice(5, 9).match(/\d/g)?.length ?? 0) < 2) continue;
      const fixed = fixPanReading(m[0].toUpperCase());
      if (fixed !== m[0] && isValidPan(fixed)) push("pan", m, fixed, 0.65);
    }
  }
  for (const m of text.matchAll(IFSC_RE)) if (isValidIfsc(m[0])) push("ifsc", m, m[0], 0.75);
  for (const m of text.matchAll(EMAIL_RE)) push("email", m, m[0].toLowerCase(), 0.9);
  for (const m of text.matchAll(UPI_RE)) {
    if (UPI_HANDLES.has(m[1]!.toLowerCase())) push("upi", m, m[0].toLowerCase(), 0.85);
  }
  for (const m of text.matchAll(PHONE_RE)) {
    const digits = m[1]! + m[2]!;
    if (isValidIndianMobile(digits)) push("phone", m, digits, 0.7);
  }
  for (const m of text.matchAll(PHONE_GROUPED_RE)) {
    const digits = m.slice(1).filter(Boolean).join("");
    if (isValidIndianMobile(digits)) push("phone", m, digits, 0.7);
  }
  for (const m of text.matchAll(ACCOUNT_RE)) {
    const [start, end] = m.indices![2]!;
    if (/^ac{1,2}$/i.test(m[1]!) && text.slice(m.index!, start).includes("\n")) continue;
    const digits = m[2]!.replace(/[ -]/g, "");
    out.push({ type: "account", start, end, raw: m[2]!, normalized: digits, confidence: 0.9, checksumFailed: false });
  }
  for (const m of text.matchAll(VEHICLE_RE)) {
    if (VEHICLE_STATE_CODES.has(m[1]!)) push("vehicle", m, `${m[1]}${m[2]!.padStart(2, "0")}${m[3]}${m[4]}`, 0.7);
  }
  for (const m of text.matchAll(VEHICLE_BH_RE)) push("vehicle", m, `${m[1]}BH${m[2]}${m[3]}`, 0.7);
  return dropOverlaps(out);
}

// Lower number wins when two matches overlap (e.g. an Aadhaar also looks like a phone substring).
// A labelled account number wins over an Aadhaar/card that happens to pass its checksum.
const PRIORITY: Record<IdType, number> = { account: 0, aadhaar: 1, card: 2, pan: 3, email: 4, upi: 5, ifsc: 6, vehicle: 7, phone: 8 };

function dropOverlaps(matches: IdMatch[]): IdMatch[] {
  const sorted = [...matches].sort((a, b) => PRIORITY[a.type] - PRIORITY[b.type] || b.confidence - a.confidence);
  const kept: IdMatch[] = [];
  for (const m of sorted) {
    if (!kept.some((k) => m.start < k.end && k.start < m.end)) kept.push(m);
  }
  return kept.sort((a, b) => a.start - b.start);
}

/** Display-safe form of a value; the only representation allowed outside the worker. */
export function maskForDisplay(type: IdType, normalized: string): string {
  const last = (n: number) => normalized.slice(-n);
  switch (type) {
    case "aadhaar": return `XXXX XXXX ${last(4)}`;
    case "card": return `XXXX XXXX XXXX ${last(4)}`;
    case "pan": return `XXXXX${normalized.slice(5, 9).replace(/\d(?=\d{2})/g, "X")}${last(1)}`;
    case "phone": return `XXXXXX${last(4)}`;
    case "account": return `${"X".repeat(Math.max(0, normalized.length - 4))}${last(4)}`;
    case "ifsc": return `${normalized.slice(0, 4)}0XXXXXX`;
    case "vehicle": return `${normalized.slice(0, 2)} XX XX ${last(2).padStart(4, "X")}`;
    case "email":
    case "upi": {
      const [user = "", domain = ""] = normalized.split("@");
      // A one-letter user name would be shown whole.
      return `${user.length > 1 ? user.slice(0, 1) : ""}***@${domain}`;
    }
  }
}
