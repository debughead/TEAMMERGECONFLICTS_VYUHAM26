// Finders for what a policy talks about that the built-in detectors don't know: the company's own
// words (keywords, labels, dictionaries, markings, patterns) plus three generic detectors (money
// amounts, secrets, internal links). All work on plain text with offsets into it.

export interface TextHit {
  start: number;
  end: number;
  /** As written in the document. Worker-internal only. */
  raw: string;
  /** For label values: the label it was found under. */
  label?: string;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A word: letters (with combining marks, e.g. Devanagari vowel signs and nukta) and digits. */
const WORD = /[\p{L}\p{M}\p{N}]+/gu;

interface TermShape { words: string[]; seps: string[] }
/** Splits a term into lower-cased words and the separators between them (whitespace collapsed). */
function shape(term: string): TermShape | null {
  const words: string[] = [];
  const seps: string[] = [];
  let last = -1;
  for (const m of term.matchAll(WORD)) {
    if (last >= 0) seps.push(term.slice(last, m.index).replace(/\s+/g, " "));
    words.push(m[0].toLocaleLowerCase());
    last = m.index! + m[0].length;
  }
  return words.length ? { words, seps } : null;
}

/**
 * Whole-word, case-insensitive occurrences of any of `terms`, longest first and without overlaps. Words
 * of a term may be separated by any whitespace in the document, line breaks included ("Project" at the
 * end of one line, "Falcon" on the next). One pass over the document's words, so a 2,000-term
 * dictionary costs about the same as one term.
 */
export function findTerms(text: string, terms: string[]): TextHit[] {
  const byFirst = new Map<string, TermShape[]>();
  for (const t of new Set(terms.map((x) => x.trim()).filter(Boolean))) {
    const s = shape(t);
    if (!s) continue;
    const list = byFirst.get(s.words[0]!) ?? [];
    list.push(s);
    byFirst.set(s.words[0]!, list);
  }
  for (const list of byFirst.values()) list.sort((a, b) => b.words.length - a.words.length);
  const words = [...text.matchAll(WORD)].map((m) => ({ w: m[0].toLocaleLowerCase(), start: m.index!, end: m.index! + m[0].length }));
  const out: TextHit[] = [];
  for (let i = 0; i < words.length; i++) {
    const cands = byFirst.get(words[i]!.w);
    if (!cands) continue;
    const hit = cands.find((c) => c.words.every((w, k) => {
      const at = words[i + k];
      if (!at || at.w !== w) return false;
      if (k === 0) return true;
      const gap = text.slice(words[i + k - 1]!.end, at.start).replace(/\s+/g, " ");
      return gap === c.seps[k - 1];
    }));
    if (!hit) continue;
    const last = words[i + hit.words.length - 1]!;
    out.push({ start: words[i]!.start, end: last.end, raw: text.slice(words[i]!.start, last.end) });
    i += hit.words.length - 1;
  }
  return out;
}

/** True when the label appears as a label: "Label:" / "Label -" / alone on its line. */
export function hasLabel(text: string, label: string): boolean {
  const l = escapeRe(label.trim());
  return new RegExp(`(?:^|\\n)[^\\S\\n]*${l}[^\\S\\n]*(?:[:\\-–][^\\n]*)?(?:\\n|$)|${l}[^\\S\\n]*:`, "iu").test(text);
}

/**
 * Values written next to a label: "Label: value" on one line, or the label alone on a line with the
 * value on the next (forms and cards). The value runs to the end of its line, at most 80 characters.
 */
export function findLabelValues(text: string, labels: string[]): TextHit[] {
  const out: TextHit[] = [];
  let offset = 0;
  const lines = text.split("\n").map((l) => { const at = offset; offset += l.length + 1; return { l, at }; });
  const res = labels.map((label) => [label.trim(), new RegExp(`^[^\\S\\n]*(?:.{0,40}/[^\\S\\n]*)?${escapeRe(label.trim())}[^\\S\\n]*(?:[:\\-–][^\\S\\n]*)?(.*)$`, "iu")] as const);
  lines.forEach((line, k) => {
    for (const [label, re] of res) {
      const m = re.exec(line.l);
      if (!m) continue;
      const inline = m[1]!.trim();
      const target = inline ? { text: inline, at: line.at + line.l.lastIndexOf(inline) } : (() => {
        const next = lines[k + 1];
        const v = next?.l.trim();
        // An empty field followed by another "Label: …" line has no value; don't take the next field's.
        if (!next || !v || /^[^:\n]{1,40}:/.test(v)) return null;
        return { text: v, at: next.at + next.l.indexOf(v) };
      })();
      if (target && /[\p{L}\p{N}]/u.test(target.text)) {
        const raw = target.text.slice(0, 80);
        out.push({ start: target.at, end: target.at + raw.length, raw, label });
      }
      break;
    }
  });
  return out;
}

/** Occurrences of a compiled (already safety-checked) pattern. */
export function findPattern(text: string, regex: RegExp): TextHit[] {
  const out: TextHit[] = [];
  regex.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(text)) !== null) {
    if (m[0].length === 0) { regex.lastIndex++; continue; }
    out.push({ start: m.index, end: m.index + m[0].length, raw: m[0] });
  }
  return out;
}

// ---------- generic detectors ----------

/** Money: a currency mark followed by a number, or a grouped number with paise/cents (1,12,430.55). */
const AMOUNT = /(?:(?:₹|Rs\.?|INR|\$|USD|€|EUR|£|GBP)[^\S\n]?\d[\d,]*(?:\.\d{1,2})?(?:[^\S\n]?(?:lakh|lakhs|crore|cr|k|m|mn|bn))?)|(?<![\d.,])\d{1,3}(?:,\d{2,3})+\.\d{2}(?![\d.])/giu;

export function findAmounts(text: string): TextHit[] {
  return findPattern(text, AMOUNT);
}

/** Credentials with a recognisable shape. Generic "password: …" lines need the label right before the value. */
const SECRET_PATTERNS: RegExp[] = [
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,                                  // AWS access key id
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b/g,                       // OpenAI / Anthropic style
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g,                                  // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,                                // Slack
  /\bAIza[0-9A-Za-z_-]{35}\b/g,                                       // Google API key
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}\b/g, // JSON Web Token
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]{0,4000}?-----END [A-Z ]*PRIVATE KEY-----/g,
  /(?<=\b(?:password|passwd|pwd|passcode|secret|api[ _-]?key|access[ _-]?token|token)[^\S\n]*[:=][^\S\n]*)[^\s"',;]{6,}/gi,
];

/** Values that are already masked or are placeholders: "********", "xxxx", "[REDACTED]", "<hidden>". */
const PLACEHOLDER = /^(?:[*xX•#._-]+|[[<({].*[\]>)}]|redacted|hidden|removed|none|null|n\/?a|changeme|your[_-]?(?:key|token|password)[\w-]*)$/i;

export function findSecrets(text: string): TextHit[] {
  const hits = SECRET_PATTERNS.flatMap((re) => findPattern(text, re)).filter((h) => !PLACEHOLDER.test(h.raw));
  // Keep the longest of overlapping hits (a key inside a "token: …" line is reported once).
  hits.sort((a, b) => a.start - b.start || b.end - a.end);
  return hits.filter((h, i) => !hits.slice(0, i).some((o) => h.start < o.end && o.start < h.end));
}

const URL_RE = /\bhttps?:\/\/[^\s<>"')\]]+/gi;
const HOST_RE = /\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/gi;
const PRIVATE_HOST = /^(?:localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|[a-z0-9.-]+\.(?:internal|intranet|corp|local|lan|localdomain))$/i;

/** Links and host names that point inside the company: its own domains, private networks, intranet names. */
export function findInternalLinks(text: string, internalDomains: string[]): TextHit[] {
  const isInternal = (host: string) => {
    const h = host.toLowerCase().replace(/\.$/, "");
    return PRIVATE_HOST.test(h) || internalDomains.some((d) => h === d || h.endsWith(`.${d}`));
  };
  const out: TextHit[] = [];
  for (const m of text.matchAll(URL_RE)) {
    // Sentence punctuation right after a link belongs to the sentence, not the link.
    const url = m[0].replace(/[.,;:!?]+$/, "");
    let host = "";
    try { host = new URL(url).hostname; } catch { continue; }
    if (isInternal(host)) out.push({ start: m.index!, end: m.index! + url.length, raw: url });
  }
  for (const m of text.matchAll(HOST_RE)) {
    if (out.some((o) => m.index! >= o.start && m.index! < o.end)) continue; // already inside a URL
    if (text[m.index! - 1] === "@") continue; // the domain of an email address: that's an email, not a link
    if (internalDomains.length && isInternal(m[0])) out.push({ start: m.index!, end: m.index! + m[0].length, raw: m[0] });
  }
  return out.sort((a, b) => a.start - b.start);
}
