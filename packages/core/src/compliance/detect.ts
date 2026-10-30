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
  /** For term hits: the dictionary term, keyword or marking that matched (policy text, not document text). */
  term?: string;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Characters that render as nothing; inserted inside a word they would otherwise split it ("Fal\u200Bcon"). */
const INVISIBLE = "\u00AD\u200B\u200C\u200D\u2060\uFEFF";
const INVISIBLE_RE = new RegExp(`[${INVISIBLE}]`, "gu");
/**
 * A word: letters (with combining marks, e.g. Devanagari vowel signs and nukta) and digits. Invisible
 * characters count as part of the word so they can't split it; they're dropped when comparing.
 */
const WORD = new RegExp(`[\\p{L}\\p{M}\\p{N}${INVISIBLE}]+`, "gu");

/**
 * Cyrillic and Greek letters that look identical to Latin ones. Folded to Latin when comparing, so a
 * codename typed with a look-alike letter (Cyrillic "\u0430" for Latin "a" in "Falcon") still matches.
 */
const LOOKALIKE: Record<string, string> = {
  "\u0430": "a", "\u0432": "b", "\u0435": "e", "\u043A": "k", "\u043C": "m", "\u043D": "h", "\u043E": "o", "\u0440": "p", "\u0441": "c", "\u0442": "t", "\u0443": "y", "\u0445": "x", "\u0456": "i", "\u0458": "j", "\u0455": "s", "\u0501": "d", "\u0261": "g",
  "\u0410": "a", "\u0412": "b", "\u0415": "e", "\u041A": "k", "\u041C": "m", "\u041D": "h", "\u041E": "o", "\u0420": "p", "\u0421": "c", "\u0422": "t", "\u0423": "y", "\u0425": "x", "\u0406": "i", "\u0408": "j", "\u0405": "s",
  "\u03B1": "a", "\u03B5": "e", "\u03B9": "i", "\u03BA": "k", "\u03BD": "v", "\u03BF": "o", "\u03C1": "p", "\u03C4": "t", "\u03C5": "u", "\u03C7": "x",
  "\u0391": "a", "\u0392": "b", "\u0395": "e", "\u0396": "z", "\u0397": "h", "\u0399": "i", "\u039A": "k", "\u039C": "m", "\u039D": "n", "\u039F": "o", "\u03A1": "p", "\u03A4": "t", "\u03A5": "y", "\u03A7": "x",
};

/**
 * Comparison form of a word: invisible characters dropped, Latin accents dropped (only U+0300–U+036F,
 * so Devanagari vowel signs and nukta are kept), look-alike letters folded to Latin, lower-cased.
 */
function fold(word: string): string {
  const plain = word.replace(INVISIBLE_RE, "").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  let out = "";
  for (const c of plain) out += LOOKALIKE[c] ?? c;
  return out.toLocaleLowerCase();
}

/** Whitespace and hyphens between two words are the same separator ("pay slip", "pay-slip", "pay\nslip"). */
const sepOf = (gap: string): string => {
  const g = gap.replace(INVISIBLE_RE, "").replace(/\s+/g, " ").trim();
  return g === "" || /^[-‐‑–—]+$/u.test(g) ? " " : g;
};

interface Word { w: string; start: number; end: number }

/** The document's words, cached for the last few texts: one scan checks many term lists on the same text. */
const WORDS_CACHE = new Map<string, Word[]>();
function wordsOf(text: string): Word[] {
  const hit = WORDS_CACHE.get(text);
  if (hit) return hit;
  const words: Word[] = [];
  for (const m of text.matchAll(WORD)) {
    const w = fold(m[0]);
    if (w) words.push({ w, start: m.index!, end: m.index! + m[0].length });
  }
  if (WORDS_CACHE.size >= 8) WORDS_CACHE.delete(WORDS_CACHE.keys().next().value!);
  WORDS_CACHE.set(text, words);
  return words;
}

interface TermShape { term: string; words: string[]; seps: string[] }
/** Splits a term into comparison-form words and the separators between them. */
function shape(term: string): TermShape | null {
  const words: string[] = [];
  const seps: string[] = [];
  let last = -1;
  for (const m of term.matchAll(WORD)) {
    const w = fold(m[0]);
    if (!w) continue;
    if (last >= 0) seps.push(sepOf(term.slice(last, m.index)));
    words.push(w);
    last = m.index! + m[0].length;
  }
  return words.length ? { term, words, seps } : null;
}

/** The last word of a term may be plural in the document ("payslip" → "payslips", "process" → "processes"). */
const sameWord = (doc: string, term: string, last: boolean) =>
  doc === term || (last && term.length >= 3 && (doc === `${term}s` || doc === `${term}es`));

/**
 * Whole-word, case-insensitive occurrences of any of `terms`, longest first and without overlaps. Words
 * of a term may be separated by any whitespace or a hyphen in the document, line breaks included
 * ("Project" at the end of one line, "Falcon" on the next), and the last word may be plural. Invisible
 * characters, Latin accents and look-alike letters don't hide a term. One pass over the document's words,
 * so a 2,000-term dictionary costs about the same as one term.
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
  const words = wordsOf(text);
  const out: TextHit[] = [];
  for (let i = 0; i < words.length; i++) {
    const w0 = words[i]!.w;
    // A one-word term may appear in the plural, so also look it up without "s" / "es".
    const cands = [
      ...(byFirst.get(w0) ?? []),
      ...(w0.endsWith("s") ? (byFirst.get(w0.slice(0, -1)) ?? []).filter((c) => c.words.length === 1) : []),
      ...(w0.endsWith("es") ? (byFirst.get(w0.slice(0, -2)) ?? []).filter((c) => c.words.length === 1) : []),
    ];
    if (!cands.length) continue;
    cands.sort((a, b) => b.words.length - a.words.length);
    const hit = cands.find((c) => c.words.every((w, k) => {
      const at = words[i + k];
      if (!at || !sameWord(at.w, w, k === c.words.length - 1)) return false;
      if (k === 0) return true;
      return sepOf(text.slice(words[i + k - 1]!.end, at.start)) === c.seps[k - 1];
    }));
    if (!hit) continue;
    const last = words[i + hit.words.length - 1]!;
    out.push({ start: words[i]!.start, end: last.end, raw: text.slice(words[i]!.start, last.end), term: hit.term });
    i += hit.words.length - 1;
  }
  return out;
}

/** "NON-CONFIDENTIAL", "not confidential", "unclassified": a negated marking says the opposite. */
const NEGATED_BEFORE = /(?:\bnon|\bnot|\bun)[^\S\n]*[-‐‑–—]?[^\S\n]*$/iu;
/** Allowed around a marking that starts a line: "Confidential", "Confidential:", "[Confidential] – …". */
const LINE_LEAD = /^[^\S\n]*[[(*#|]*[^\S\n]*$/u;
const LINE_TAIL = /^[^\S\n]*(?:$|[:\-–—|/)\].,;!(])/u;

/**
 * Occurrences of marking terms that are used *as a marking*: written in capitals ("CONFIDENTIAL"), or
 * opening a line on their own ("Confidential – do not forward"). An ordinary sentence that uses the word
 * ("we keep your data confidential") or a negated marking ("NON-CONFIDENTIAL") isn't a marking. Scripts
 * without letter case (Devanagari…) count wherever they appear, as before.
 */
export function findMarkings(text: string, terms: string[]): TextHit[] {
  return findTerms(text, terms).filter((h) => {
    const lineStart = text.lastIndexOf("\n", h.start - 1) + 1;
    const before = text.slice(lineStart, h.start);
    if (NEGATED_BEFORE.test(before)) return false;
    const cased = h.raw !== h.raw.toLowerCase() || h.raw !== h.raw.toUpperCase();
    if (!cased || h.raw === h.raw.toUpperCase()) return true;
    const lineEnd = text.indexOf("\n", h.end);
    return LINE_LEAD.test(before) && LINE_TAIL.test(text.slice(h.end, lineEnd < 0 ? undefined : lineEnd));
  });
}

/** Not part of a longer word on either side: a label "ID" must not match inside "PAID". */
const labelRe = (label: string) => `(?<![\\p{L}\\p{N}])${escapeRe(label.trim())}(?![\\p{L}\\p{N}])`;

/** True when the label appears as a label: "Label:" / "Label -" / alone on its line. */
export function hasLabel(text: string, label: string): boolean {
  const l = labelRe(label);
  return new RegExp(`(?:^|\\n)[^\\S\\n]*${l}[^\\S\\n]*(?:[:\\-–][^\\n]*)?(?:\\n|$)|${l}[^\\S\\n]*:`, "iu").test(text);
}

/** Longest value taken next to a label; keeps a runaway "value" from swallowing a whole page. */
const MAX_VALUE_CHARS = 1000;
/** Most extra lines a value may continue onto. */
const MAX_CONTINUATION_LINES = 5;
/** A line that ends mid-sentence: the value goes on below. */
const ENDS_OPEN = /(?:[,;&]|[^\S\n][-–—]|\b(?:and|or|but|with|to|of|for|the|a|an|in|on|at|by))[^\S\n]*$/iu;
/** Looks like the next field ("Label: …"), not a continuation. */
const LOOKS_LIKE_FIELD = /^[^:\n]{1,40}:/u;

/**
 * Values written next to a label: "Label: value" on one line, or the label alone on a line with the
 * value on the next (forms and cards). The value runs to the end of its line, and on to the following
 * lines while the text clearly continues (the line ends mid-sentence, or the next one starts in lower
 * case), so a long comment is covered in full.
 */
export function findLabelValues(text: string, labels: string[]): TextHit[] {
  const out: TextHit[] = [];
  let offset = 0;
  const lines = text.split("\n").map((l) => { const at = offset; offset += l.length + 1; return { l, at }; });
  const res = labels.map((label) => [label.trim(), new RegExp(`^[^\\S\\n]*(?:.{0,40}/[^\\S\\n]*)?${labelRe(label)}[^\\S\\n]*(?:[:\\-–][^\\S\\n]*)?(.*)$`, "iu")] as const);
  const isLabelLine = (l: string) => LOOKS_LIKE_FIELD.test(l.trim()) || res.some(([, re]) => re.test(l));
  for (let k = 0; k < lines.length; k++) {
    const line = lines[k]!;
    for (const [label, re] of res) {
      const m = re.exec(line.l);
      if (!m) continue;
      const inline = m[1]!.trim();
      let valueLine = k;
      let start: number;
      if (inline) {
        start = line.at + line.l.lastIndexOf(inline);
      } else {
        const next = lines[k + 1];
        const v = next?.l.trim();
        // An empty field followed by another "Label: …" line has no value; don't take the next field's.
        if (!next || !v || LOOKS_LIKE_FIELD.test(v)) break;
        start = next.at + next.l.indexOf(v);
        valueLine = k + 1;
      }
      let end = lines[valueLine]!.at + lines[valueLine]!.l.trimEnd().length;
      for (let extra = 1; extra <= MAX_CONTINUATION_LINES; extra++) {
        const cur = lines[valueLine + extra - 1]!.l;
        const nxt = lines[valueLine + extra];
        const t = nxt?.l.trim();
        if (!nxt || !t || isLabelLine(nxt.l)) break;
        if (!ENDS_OPEN.test(cur) && !/^\p{Ll}/u.test(t)) break;
        end = nxt.at + nxt.l.trimEnd().length;
      }
      const raw = text.slice(start, Math.min(end, start + MAX_VALUE_CHARS));
      if (/[\p{L}\p{N}]/u.test(raw)) out.push({ start, end: start + raw.length, raw, label });
      break;
    }
  }
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

/**
 * Money: a currency mark followed by a number, a number followed by a currency word ("50,000 INR"), or a
 * grouped number with paise/cents (1,12,430.55).
 */
const AMOUNT = /(?:(?:₹|Rs\.?|INR|\$|USD|€|EUR|£|GBP)[^\S\n]?\d[\d,]*(?:\.\d{1,2})?(?:[^\S\n]?(?:lakh|lakhs|crore|cr|k|m|mn|bn))?)|(?<![\d.,])\d+(?:,\d{2,3})*(?:\.\d{1,2})?[^\S\n]?(?:INR|USD|EUR|GBP|rupees|dollars|euros|Rs\.?)(?![\p{L}\p{N}])|(?<![\d.,])\d{1,3}(?:,\d{2,3})+\.\d{2}(?![\d.])/giu;
/**
 * Pay-sheet lines name what an amount is but often leave out the currency ("Basic Salary 45,000"). A
 * comma-grouped number right after one of these words counts as money; "qty 1,234" doesn't.
 */
const PAY_AMOUNT = /\b(?:basic|hra|da|salary|wages?|pay|payable|paid|allowances?|bonus|incentives?|deductions?|total|gross|net|tax|tds|pf|epf|esi|ctc|amount|balance|fees?|price|cost|rent|reimbursements?|arrears|earnings|stipend|commission|loan|emi|advance)\b[^\d\n]{0,25}?(?<![\d.,])(\d{1,3}(?:,\d{2,3})+(?:\.\d{1,2})?)(?![\d.,]*\d)/dgiu;

export function findAmounts(text: string): TextHit[] {
  const hits = findPattern(text, AMOUNT);
  for (const m of text.matchAll(PAY_AMOUNT)) {
    const [start, end] = m.indices![1]!;
    if (!hits.some((h) => start < h.end && h.start < end)) hits.push({ start, end, raw: m[1]! });
  }
  return hits.sort((a, b) => a.start - b.start);
}

/**
 * Names under which a credential is written: "password", "DB_PASSWORD", "client_secret",
 * "aws_secret_access_key", "api-key", "auth_token"… The prefix lets compound names through; the name
 * must not continue into a longer word ("tokenizer" isn't a token).
 */
const SECRET_NAME = String.raw`(?<![A-Za-z0-9])[A-Za-z0-9_.-]*?(?:password|passwd|pwd|passcode|secret|api[_ -]?key|apikey|access[_ -]?(?:token|key)|auth[_ -]?token|private[_ -]?key|accountkey|token)(?![A-Za-z0-9])["']?`;
/** Separator between a credential's name and its value: ":", "=", or a spaced dash ("Password - …"). */
const SECRET_SEP = String.raw`[^\S\n]*(?:[:=]|[^\S\n][-–—](?=[^\S\n]))[^\S\n]*`;

const CONNECTION_PASSWORD = /(?<=\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s:/@]{3,}(?=@)/gi;

/** Credentials with a recognisable shape. Generic "password: …" lines need the label right before the value. */
const SECRET_PATTERNS: RegExp[] = [
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,                                  // AWS access key id
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b/g,                       // OpenAI / Anthropic style
  /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}\b/g,                       // Stripe secret / restricted keys
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g,                                  // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,                                // Slack
  /\bAIza[0-9A-Za-z_-]{35}\b/g,                                       // Google API key
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}\b/g, // JSON Web Token
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]{0,4000}?-----END [A-Z ]*PRIVATE KEY-----/g,
  // The password in a connection string: scheme://user:PASSWORD@host (short ones count here too)
  CONNECTION_PASSWORD,
  // Quoted value after a credential name (JSON, YAML, .env): "client_secret": "…"
  new RegExp(String.raw`(?<=${SECRET_NAME}${SECRET_SEP}["'])[^"'\n]{6,}(?=["'])`, "gi"),
  // Unquoted value: the rest of the line, so a passphrase with spaces is covered in full.
  new RegExp(String.raw`(?<=${SECRET_NAME}${SECRET_SEP})[^\s"',;][^\n"',;]*`, "gi"),
];

/** Values that are already masked or are placeholders: "********", "xxxx", "[REDACTED]", "<hidden>". */
const PLACEHOLDER = /^(?:[*xX•#._-]+|[[<({].*[\]>)}]|redacted|hidden|removed|none|null|n\/?a|changeme|your[_-]?(?:key|token|password)[\w-]*)$/i;

export function findSecrets(text: string): TextHit[] {
  const hits = SECRET_PATTERNS.flatMap((re) => findPattern(text, re).map((h) => {
    const raw = h.raw.trimEnd();
    return { ...h, raw, end: h.start + raw.length, minLength: re === CONNECTION_PASSWORD ? 3 : 6 };
  }))
    .filter((h) => h.raw.length >= h.minLength && !PLACEHOLDER.test(h.raw))
    .map(({ minLength: _, ...h }) => h);
  // Keep the longest of overlapping hits (a key inside a "token: …" line is reported once).
  hits.sort((a, b) => a.start - b.start || b.end - a.end);
  return hits.filter((h, i) => !hits.slice(0, i).some((o) => h.start < o.end && o.start < h.end));
}

/** Links with a host: web, SSH/Git, FTP and SMB shares. */
const URL_RE = /\b(?:https?|ssh|sftp|ftp|git|smb):\/\/[^\s<>"')\]]+/gi;
const HOST_RE = /\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/gi;
const PRIVATE_HOST = /^(?:localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|[a-z0-9.-]+\.(?:internal|intranet|corp|local|lan|localdomain))$/i;
/** A bare IPv4 address (no "http://"); kept only when it's in a private range. */
const IPV4_RE = /(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w]|\.\d)/g;
/** A Windows file-share path (\\server\share\…): always inside a company network. */
const UNC_RE = /\\\\[A-Za-z0-9._$-]+(?:\\[^\s\\"'<>|]+)+\\?/g;

/** Links and host names that point inside the company: its own domains, private networks, intranet names. */
export function findInternalLinks(text: string, internalDomains: string[]): TextHit[] {
  const isInternal = (host: string) => {
    const h = host.toLowerCase().replace(/\.$/, "");
    return PRIVATE_HOST.test(h) || internalDomains.some((d) => h === d || h.endsWith(`.${d}`));
  };
  const out: TextHit[] = [];
  const covered = (i: number) => out.some((o) => i >= o.start && i < o.end);
  for (const m of text.matchAll(URL_RE)) {
    // Sentence punctuation right after a link belongs to the sentence, not the link.
    const url = m[0].replace(/[.,;:!?]+$/, "");
    let host = "";
    try { host = new URL(url).hostname; } catch { continue; }
    if (isInternal(host)) out.push({ start: m.index!, end: m.index! + url.length, raw: url });
  }
  for (const m of text.matchAll(UNC_RE)) {
    if (!covered(m.index!)) out.push({ start: m.index!, end: m.index! + m[0].length, raw: m[0] });
  }
  for (const m of text.matchAll(IPV4_RE)) {
    if (covered(m.index!)) continue;
    const valid = m[0].split(".").every((o) => Number(o) <= 255);
    if (valid && isInternal(m[0])) out.push({ start: m.index!, end: m.index! + m[0].length, raw: m[0] });
  }
  for (const m of text.matchAll(HOST_RE)) {
    if (covered(m.index!)) continue; // already inside a URL
    if (text[m.index! - 1] === "@") continue; // the domain of an email address: that's an email, not a link
    // Intranet names (.corp, .internal…) count even when the policy lists no company domains.
    if (isInternal(m[0])) out.push({ start: m.index!, end: m.index! + m[0].length, raw: m[0] });
  }
  return out.sort((a, b) => a.start - b.start);
}
