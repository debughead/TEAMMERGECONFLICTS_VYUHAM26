// Checksum and format validators for Indian structured IDs. Pure functions over digit/letter strings.

// Verhoeff tables (dihedral group D5): multiplication, permutation, inverse.
const D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 2, 3, 4, 0, 6, 7, 8, 9, 5], [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7], [4, 0, 1, 2, 3, 9, 5, 6, 7, 8], [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2], [7, 6, 5, 9, 8, 2, 1, 0, 4, 3], [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
] as const;
const P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 5, 7, 6, 2, 8, 3, 0, 9, 4], [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7], [9, 4, 5, 3, 1, 2, 6, 8, 7, 0], [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5], [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
] as const;
const INV = [0, 4, 3, 2, 1, 5, 6, 7, 8, 9] as const;

const isDigits = (s: string) => /^\d+$/.test(s);

export function verhoeffValid(digits: string): boolean {
  if (!isDigits(digits)) return false;
  let c = 0;
  const rev = [...digits].reverse();
  for (let i = 0; i < rev.length; i++) c = D[c]![P[i % 8]![Number(rev[i])]!]!;
  return c === 0;
}

/** Check digit to append to `digits` so the result passes Verhoeff. Used to build fake test IDs. */
export function verhoeffCheckDigit(digits: string): number {
  if (!isDigits(digits)) throw new Error("digits only");
  let c = 0;
  const rev = [...digits].reverse();
  for (let i = 0; i < rev.length; i++) c = D[c]![P[(i + 1) % 8]![Number(rev[i])]!]!;
  return INV[c]!;
}

/** Aadhaar: 12 digits, first digit 2–9, last digit is the Verhoeff check digit. */
export function isValidAadhaar(digits: string): boolean {
  return /^[2-9]\d{11}$/.test(digits) && verhoeffValid(digits);
}

export function luhnValid(digits: string): boolean {
  if (!isDigits(digits) || digits.length < 2) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (double) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Payment card: 13–19 digits, a real network prefix (Amex/Visa/Mastercard/RuPay/Discover/Diners/JCB), Luhn. */
export function isValidCard(digits: string): boolean {
  return /^\d{13,19}$/.test(digits) && /^(3[0-9]|4|5[1-5]|2[2-7]|6[0-9])/.test(digits) && luhnValid(digits);
}

/** PAN: AAAAA9999A where the 4th letter is the holder type. */
const PAN_HOLDER_TYPES = "PCHFATBLJG";
export function isValidPan(pan: string): boolean {
  return /^[A-Z]{3}[A-Z][A-Z]\d{4}[A-Z]$/.test(pan) && PAN_HOLDER_TYPES.includes(pan[3]!);
}

export function isValidIfsc(code: string): boolean {
  return /^[A-Z]{4}0[A-Z0-9]{6}$/.test(code);
}

/** Indian mobile: 10 digits starting 6–9 (after stripping +91 / 0). */
export function isValidIndianMobile(digits: string): boolean {
  return /^[6-9]\d{9}$/.test(digits);
}

export const UPI_HANDLES: ReadonlySet<string> = new Set([
  "upi", "ybl", "ibl", "axl", "okaxis", "okhdfcbank", "okicici", "oksbi", "paytm", "ptyes", "ptaxis", "pthdfc", "ptsbi",
  "apl", "yapl", "rapl", "axisbank", "axisb", "icici", "hdfcbank", "sbi", "kotak", "kbl", "pnb", "boi", "barodampay",
  "unionbankofindia", "uboi", "cnrb", "indus", "idfcbank", "idfcfirst", "federal", "fbl", "yesbank", "rbl", "aubank",
  "jupiteraxis", "fam", "freecharge", "ikwik", "jio", "airtel", "dbs", "equitas", "hsbc", "citi", "sc", "abfspay",
  "waicici", "wahdfcbank", "waaxis", "wasbi", "postbank", "naviaxis", "slice", "superyes", "timecosmos", "pingpay",
]);

/** RTO state/UT codes for vehicle registration numbers. */
export const VEHICLE_STATE_CODES: ReadonlySet<string> = new Set([
  "AN", "AP", "AR", "AS", "BR", "CG", "CH", "DD", "DL", "DN", "GA", "GJ", "HP", "HR", "JH", "JK", "KA", "KL", "LA", "LD",
  "MH", "ML", "MN", "MP", "MZ", "NL", "OD", "OR", "PB", "PY", "RJ", "SK", "TN", "TR", "TS", "UK", "UA", "UP", "WB",
]);
