// Builds fake-but-valid IDs at test time so no real-looking number is hard-coded in the repo.
import { verhoeffCheckDigit } from "../../src/detect/validators.ts";

/** 11 digits (first 2–9) + Verhoeff check digit. */
export function fakeAadhaar(first11: string): string {
  return first11 + String(verhoeffCheckDigit(first11));
}

/** Same 11 digits with a deliberately wrong check digit. */
export function fakeAadhaarInvalid(first11: string): string {
  return first11 + String((verhoeffCheckDigit(first11) + 1) % 10);
}
