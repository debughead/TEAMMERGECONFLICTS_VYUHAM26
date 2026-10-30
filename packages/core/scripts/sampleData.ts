// Single source of the FAKE values baked into samples/. Golden tests import these instead of
// hard-coding values in expected JSON. Everything here is invented; IDs are generated to pass
// checksums so the detectors exercise their real paths.
import { verhoeffCheckDigit } from "../src/detect/validators.ts";

const aadhaar = (first11: string) => first11 + String(verhoeffCheckDigit(first11));

export const FAKE = {
  name: "Arjun Testkumar",
  address: "House No 12, Test Nagar, Kochi, Kerala 682001",
  accountNo: "000011112222",
  ifsc: "TEST0001234",
  aadhaar: aadhaar("49871234567"),
  phone: "9876543210",
  pan: "ABCPE1234F",
  upi: "test.user@okaxis",
  author: "HR-Dept-Fake",
  /** A public landmark area, not a home: Kochi city centre. */
  gps: { lat: 9.9312, lon: 76.2673 },
  camera: { make: "FakeCam", model: "Test-1" },
} as const;

/** Formats a 12-digit Aadhaar as it is printed on the card. */
export const aadhaarSpaced = (a: string) => `${a.slice(0, 4)} ${a.slice(4, 8)} ${a.slice(8)}`;
