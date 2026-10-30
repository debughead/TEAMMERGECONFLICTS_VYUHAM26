// Recognises Indian ID documents from their printed wording (OCR or text layer), so a photo of a card
// is high-risk even when its numbers were blacked out: the photo, signature and QR code remain.
export interface IdCardMatch { kind: string; extras: string }

const CARDS: { kind: string; pattern: RegExp; extras: string }[] = [
  { kind: "PAN card", pattern: /income\s*tax\s*department|permanent\s*account\s*number|आयकर\s*विभाग/i, extras: "photo, signature and QR code (which encodes the name, father's name, date of birth and PAN)" },
  // Forms often mention "Aadhaar"; the card itself names the issuer or pairs Aadhaar with "Government of India".
  { kind: "Aadhaar card", pattern: /unique\s*identification\s*authority|(aadhaa?r|आधार)[\s\S]{0,200}(government\s*of\s*india|भारत\s*सरकार)|(government\s*of\s*india|भारत\s*सरकार)[\s\S]{0,200}(aadhaa?r|आधार)/i, extras: "photo and QR code (which encodes the holder's details)" },
  { kind: "Passport", pattern: /republic\s*of\s*india[\s\S]{0,40}passport|P<IND/i, extras: "photo, signature and machine-readable zone" },
  { kind: "Driving licence", pattern: /driving\s*licen[cs]e|transport\s*department/i, extras: "photo, signature and address" },
  { kind: "Voter ID", pattern: /election\s*commission\s*of\s*india|elector'?s?\s*photo\s*identity/i, extras: "photo and address" },
];

export function recogniseIdCard(text: string): IdCardMatch | null {
  const hit = CARDS.find((c) => c.pattern.test(text));
  return hit ? { kind: hit.kind, extras: hit.extras } : null;
}

/** "Date of Birth", "DOB", "Year of Birth" (Hindi "जन्म" too), with the date on the same or the next line. */
const BIRTH_LABEL = /(date\s*of\s*birth|\bd\.?\s*o\.?\s*b\b|(year\s*of\s*birth|\by\.?\s*o\.?\s*b\b)|birth\s*date|जन्म)/i;
const MONTHS = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
/** 12/05/1990 (also . and -): the form ID cards print. */
const NUMERIC_DATE = /\b(0?[1-9]|[12]\d|3[01])[/.-](0?[1-9]|1[0-2])[/.-]((?:19|20)\d{2})\b/;
/** Every way a date of birth is written next to its label: also 12/05/90, 1990-05-12 and 12 May 1990. */
const DATE = new RegExp([
  NUMERIC_DATE.source,
  "\\b(?:0?[1-9]|[12]\\d|3[01])[/.-](?:0?[1-9]|1[0-2])[/.-]\\d{2}\\b(?![/.-]\\d)",
  "\\b(?:19|20)\\d{2}-(?:0?[1-9]|1[0-2])-(?:0?[1-9]|[12]\\d|3[01])\\b",
  `\\b(?:0?[1-9]|[12]\\d|3[01])(?:st|nd|rd|th)?[ -](?:${MONTHS})\\.?,?[ -](?:19|20)\\d{2}\\b`,
  `\\b(?:${MONTHS})\\.? (?:0?[1-9]|[12]\\d|3[01])(?:st|nd|rd|th)?,? (?:19|20)\\d{2}\\b`,
].join("|"), "i");
const YEAR = /\b(?:19|20)\d{2}\b/;
/** Lines whose date is something else that ID cards print: when it was issued, downloaded or printed. */
const OTHER_DATE_LINE = /issue|download|print|generat|valid|expir|enrol/i;

export interface BirthDateMatch { start: number; end: number; raw: string }

/**
 * Dates of birth: a date counts only next to a birth label, so the dozens of dates on a statement
 * aren't reported. Offsets index into `text`.
 */
export function findBirthDates(text: string): BirthDateMatch[] {
  const out: BirthDateMatch[] = [];
  let offset = 0;
  const lines = text.split("\n").map((l) => { const at = offset; offset += l.length + 1; return { l, at }; });
  lines.forEach((line, k) => {
    const label = BIRTH_LABEL.exec(line.l);
    if (!label) return;
    // Older Aadhaar cards print only the year of birth.
    const date = label[2] ? new RegExp(`${DATE.source}|${YEAR.source}`, "i") : DATE;
    // Same line after the label first, then the line below (cards print the value under the label).
    const after = line.l.slice(label.index + label[0].length);
    const same = date.exec(after);
    if (same) {
      const start = line.at + label.index + label[0].length + same.index;
      out.push({ start, end: start + same[0].length, raw: same[0] });
      return;
    }
    const next = lines[k + 1];
    const below = next ? date.exec(next.l) : null;
    if (next && below) out.push({ start: next.at + below.index, end: next.at + below.index + below[0].length, raw: below[0] });
  });
  if (out.length) return out;
  // PAN and Aadhaar cards print one date of birth; on a photo of one, the label is often unreadable
  // (holograms, glare), so the date alone is enough, except on lines that say it's an issue or download date.
  const card = recogniseIdCard(text)?.kind;
  if (card === "PAN card" || card === "Aadhaar card") {
    for (const line of lines) {
      if (OTHER_DATE_LINE.test(line.l)) continue;
      for (const m of line.l.matchAll(new RegExp(NUMERIC_DATE.source, "g"))) {
        out.push({ start: line.at + m.index!, end: line.at + m.index! + m[0].length, raw: m[0] });
      }
    }
  }
  return out;
}
