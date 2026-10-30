// Layer 3 (local, offline): names, addresses, salary amounts, medical details (docs/HLD.md §3.5.3, D-008).
// Rule-first; compromise.js adds unlabelled person names. Claude (opt-in) fills the remaining gaps.
import nlp from "compromise";
import { INDIAN_NAME_TOKENS } from "./lexicons/indianNames.ts";

export type NerType = "name" | "address" | "salary" | "medical";

export interface NerMatch {
  type: NerType;
  start: number;
  end: number;
  /** Worker-internal only. */
  raw: string;
  confidence: number;
  /** Worth sending to AI (if enabled) for a second opinion. */
  needsContext: boolean;
  /**
   * Too weak to report on its own (e.g. an unknown capitalised pair, a "Condition:" label with no
   * medical term). Used only to pick lines for the optional AI pass; never becomes a finding locally.
   */
  candidate?: boolean;
}

// Labels are matched case-insensitively; the value after them is matched separately so that
// name capitalisation still counts.
const NAME_LABEL = /\b(?:name|account holder|holder|patient(?: name)?|employee(?: name)?|customer(?: name)?|applicant|beneficiary|father'?s name|mother'?s name|spouse|nominee|s\/o|d\/o|w\/o|c\/o)\s*[:.-]?[ \t]*/gi;
const NAME_VALUE = /[A-Z][A-Za-z'.-]*(?:[ \t]+[A-Z][A-Za-z'.-]*){0,3}/y;
const NAME_STOPWORDS = new Set(["No", "Number", "Date", "Of", "The", "Bank", "Account", "Address", "Details", "ID", "Type"]);

const PIN = /\b[1-9]\d{2}[ ]?\d{3}\b/g;
const ADDRESS_LABEL = /\b(?:address|addr|residence|resident of|permanent address|correspondence address)\s*[:.-]?[ \t]*/i;
const ADDRESS_CUE = /\b(?:house|flat|door|plot|h\.?\s?no|road|rd\.?|street|st\.?|lane|nagar|colony|layout|sector|block|apartment|apt|floor|near|opp\.?|post|p\.?o\.?|dist(?:rict)?|taluk|tehsil|village|city|pin(?:code)?|s\/o|d\/o|w\/o|c\/o|andhra pradesh|arunachal pradesh|assam|bihar|chhattisgarh|goa|gujarat|haryana|himachal pradesh|jharkhand|karnataka|kerala|madhya pradesh|maharashtra|manipur|meghalaya|mizoram|nagaland|odisha|punjab|rajasthan|sikkim|tamil nadu|telangana|tripura|uttar pradesh|uttarakhand|west bengal|delhi|chandigarh|puducherry|ladakh|jammu|kashmir)\b/i;
const MAX_ADDRESS_LINES = 4;

const SALARY_LABEL = /\b(?:salary|net pay|gross pay|gross salary|take[- ]home|ctc|basic pay|monthly income|annual income|income)\b/gi;
const AMOUNT = /(?:₹|rs\.?|inr)?\s?\d{1,3}(?:,\d{2,3})+(?:\.\d{1,2})?|(?:₹|rs\.?|inr)\s?\d+(?:\.\d{1,2})?/iy;
const SALARY_WINDOW = 60;

const MEDICAL_LABEL = /\b(?:diagnosis|diagnosed with|condition|prescription|rx|medical history|chief complaint|impression|findings)\s*[:.-]?[ \t]*/gi;
const MEDICAL_TERMS = /\b(?:diabetes|hypertension|hiv|hepatitis|tuberculosis|cancer|tumou?r|asthma|depression|anxiety|bipolar|schizophrenia|pregnan(?:t|cy)|thyroid|epilepsy|covid|dialysis|chemotherapy|insulin|mg\b)/i;

export function findLocalEntities(text: string): NerMatch[] {
  const out: NerMatch[] = [...labelledNames(text), ...lexiconPeople(text), ...addresses(text), ...salaries(text), ...medical(text)];
  return dedupe(out);
}

function labelledNames(text: string): NerMatch[] {
  const out: NerMatch[] = [];
  for (const m of text.matchAll(NAME_LABEL)) {
    NAME_VALUE.lastIndex = m.index! + m[0].length;
    const v = NAME_VALUE.exec(text);
    if (!v) continue;
    const tokens = v[0].split(/[ \t]+/).filter((t) => !NAME_STOPWORDS.has(t));
    if (tokens.length === 0 || tokens.join("").length < 3) continue;
    // "Employee Record" is a heading, "Employee: Arjun" is a value: one word needs an explicit separator.
    if (tokens.length === 1 && !/[:-]/.test(m[0])) continue;
    const raw = v[0].trim();
    out.push({ type: "name", start: v.index, end: v.index + raw.length, raw, confidence: 0.85, needsContext: false });
  }
  return out;
}

function lexiconPeople(text: string): NerMatch[] {
  const out: NerMatch[] = [];
  const people = nlp(text).people().json({ offset: true }) as { text: string; offset: { start: number; length: number } }[];
  for (const p of people) {
    const raw = p.text.replace(/[.,;:]+$/, "");
    if (/\d/.test(raw)) continue;
    const tokens = raw.split(/\s+/).filter((t) => !/^(?:dr|mr|mrs|ms|shri|smt)\.?$/i.test(t));
    const known = tokens.some((t) => INDIAN_NAME_TOKENS.has(t.toLowerCase()));
    // A single unknown token is too often a place or a common word.
    if (tokens.length < 2 && !known) continue;
    out.push({
      type: "name", start: p.offset.start, end: p.offset.start + raw.length, raw,
      confidence: known ? 0.75 : 0.55, needsContext: !known, candidate: !known,
    });
  }
  return out;
}

function addresses(text: string): NerMatch[] {
  const out: NerMatch[] = [];
  const lines = splitLines(text);
  for (const m of text.matchAll(PIN)) {
    const li = lines.findIndex((l) => m.index! >= l.start && m.index! < l.end);
    if (li < 0) continue;
    let start = lines[li]!.start;
    let labelled = false;
    // Walk back while lines look like the same address block.
    for (let k = li; k >= Math.max(0, li - MAX_ADDRESS_LINES + 1); k--) {
      const line = text.slice(lines[k]!.start, lines[k]!.end);
      const label = ADDRESS_LABEL.exec(line);
      if (label) {
        start = lines[k]!.start + label.index + label[0].length;
        labelled = true;
        break;
      }
      if (k < li && !(ADDRESS_CUE.test(line) || /,\s*$/.test(line))) break;
      start = lines[k]!.start;
    }
    const end = m.index! + m[0].length;
    const raw = text.slice(start, end).trim();
    const hasCue = ADDRESS_CUE.test(raw);
    if (!labelled && !hasCue) continue;
    const s = text.indexOf(raw, start);
    out.push({ type: "address", start: s, end: s + raw.length, raw, confidence: labelled ? 0.9 : 0.75, needsContext: false });
  }
  return out;
}

function salaries(text: string): NerMatch[] {
  const out: NerMatch[] = [];
  for (const m of text.matchAll(SALARY_LABEL)) {
    const from = m.index! + m[0].length;
    const span = text.slice(from, from + SALARY_WINDOW);
    for (let i = 0; i < span.length; i++) {
      AMOUNT.lastIndex = from + i;
      const a = AMOUNT.exec(text);
      if (a && a.index < from + SALARY_WINDOW) {
        const raw = a[0].trim();
        const s = text.indexOf(raw, a.index);
        out.push({ type: "salary", start: s, end: s + raw.length, raw, confidence: 0.8, needsContext: false });
        break;
      }
    }
  }
  return out;
}

function medical(text: string): NerMatch[] {
  const out: NerMatch[] = [];
  for (const m of text.matchAll(MEDICAL_LABEL)) {
    const from = m.index! + m[0].length;
    const lineEnd = text.indexOf("\n", from);
    const raw = text.slice(from, lineEnd < 0 ? undefined : lineEnd).trim();
    if (raw.length < 3) continue;
    const s = text.indexOf(raw, from);
    const strong = MEDICAL_TERMS.test(raw);
    out.push({ type: "medical", start: s, end: s + raw.length, raw, confidence: strong ? 0.8 : 0.5, needsContext: !strong, candidate: !strong });
  }
  return out;
}

function splitLines(text: string): { start: number; end: number }[] {
  const lines: { start: number; end: number }[] = [];
  let s = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i === text.length || text[i] === "\n") {
      lines.push({ start: s, end: i });
      s = i + 1;
    }
  }
  return lines;
}

/** Same type overlapping: keep the higher-confidence, longer span. */
function dedupe(matches: NerMatch[]): NerMatch[] {
  const sorted = [...matches].sort((a, b) => b.confidence - a.confidence || (b.end - b.start) - (a.end - a.start));
  const kept: NerMatch[] = [];
  for (const m of sorted) {
    if (!kept.some((k) => k.type === m.type && m.start < k.end && k.start < m.end)) kept.push(m);
  }
  return kept.sort((a, b) => a.start - b.start);
}

/** Display-safe forms. */
export function maskEntity(type: NerType, raw: string): string {
  switch (type) {
    // Fixed-length mask: star counts would reveal name lengths.
    case "name": return raw.split(/\s+/).map((t) => `${t[0] ?? ""}***`).join(" ");
    case "address": {
      const pin = /[1-9]\d{2}\s?\d{3}\s*$/.exec(raw)?.[0].replace(/\s/g, "");
      return pin ? `[address, PIN ${pin.slice(0, 2)}XXXX]` : "[address]";
    }
    case "salary": return "[amount]";
    case "medical": return "[medical detail]";
  }
}
