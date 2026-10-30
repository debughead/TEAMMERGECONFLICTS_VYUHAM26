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
