import { describe, expect, it } from "vitest";
import { findIds, maskForDisplay, type IdType } from "../src/detect/patterns.ts";
import {
  isValidAadhaar, isValidCard, isValidPan, luhnValid, verhoeffCheckDigit, verhoeffValid,
} from "../src/detect/validators.ts";
import { fakeAadhaar, fakeAadhaarInvalid } from "./helpers/fakeIds.ts";

const types = (text: string, ocr = false): IdType[] => findIds(text, { ocr }).map((m) => m.type);

describe("validators", () => {
  it("Verhoeff: published example 236 → check digit 3", () => {
    expect(verhoeffCheckDigit("236")).toBe(3);
    expect(verhoeffValid("2363")).toBe(true);
    expect(verhoeffValid("2364")).toBe(false);
  });

  it("Aadhaar: generated fake passes, one-digit change and leading 0/1 fail", () => {
    const a = fakeAadhaar("23456789012");
    expect(isValidAadhaar(a)).toBe(true);
    expect(isValidAadhaar(fakeAadhaarInvalid("23456789012"))).toBe(false);
    expect(isValidAadhaar("1" + a.slice(1))).toBe(false);
  });

  it("Luhn and card networks: standard test card numbers", () => {
    expect(luhnValid("4111111111111111")).toBe(true);
    expect(luhnValid("4111111111111112")).toBe(false);
    expect(isValidCard("5555555555554444")).toBe(true);
    expect(isValidCard("378282246310005")).toBe(true);
    // Luhn-valid but not a card network prefix.
    expect(isValidCard("0000000000000000")).toBe(false);
  });

  it("PAN holder-type letter", () => {
    expect(isValidPan("ABCPE1234F")).toBe(true);
    expect(isValidPan("ABCXE1234F")).toBe(false);
  });
});

describe("findIds: positives", () => {
  const a = fakeAadhaar("49871234567");

  it("Aadhaar in 4-4-4, hyphenated and compact forms", () => {
    for (const s of [`${a.slice(0, 4)} ${a.slice(4, 8)} ${a.slice(8)}`, `${a.slice(0, 4)}-${a.slice(4, 8)}-${a.slice(8)}`, a]) {
      const [m] = findIds(`Aadhaar No: ${s}`);
      expect(m?.type).toBe("aadhaar");
      expect(m?.normalized).toBe(a);
      expect(m?.confidence).toBeGreaterThan(0.9); // keyword boost
    }
  });

  it("each ID type in a realistic line", () => {
    expect(types("Card: 4111 1111 1111 1111")).toEqual(["card"]);
    expect(types("PAN ABCPE1234F")).toEqual(["pan"]);
    expect(types("IFSC: SBIN0001234")).toEqual(["ifsc"]);
    expect(types("Pay to test.user@okaxis now")).toEqual(["upi"]);
    expect(types("Mobile: +91 98765 43210")).toEqual(["phone"]);
    expect(types("Mobile: 9876543210")).toEqual(["phone"]);
    expect(types("mail test.user@example.com")).toEqual(["email"]);
    expect(types("Vehicle KL 07 AB 1234")).toEqual(["vehicle"]);
    expect(types("Account No: 000011112222")).toEqual(["account"]);
    expect(types("A/c No. 1234 5678 9012 34")).toEqual(["account"]);
  });

  it("account offsets cover only the digits, not the label", () => {
    const text = "Account No: 000011112222";
    const [m] = findIds(text);
    expect(text.slice(m!.start, m!.end)).toBe("000011112222");
    expect(maskForDisplay("account", m!.normalized)).toBe("XXXXXXXX2222");
  });

  it("offsets point at the raw text", () => {
    const text = "PAN ABCPE1234F here";
    const [m] = findIds(text);
    expect(text.slice(m!.start, m!.end)).toBe("ABCPE1234F");
  });
});

describe("findIds: near-misses must NOT match", () => {
  it("12 digits failing Verhoeff are not Aadhaar", () => {
    expect(types(`Ref ${fakeAadhaarInvalid("23456789012")}`)).toEqual([]);
  });

  it("an Aadhaar-like prefix inside a 16-digit card is not reported as Aadhaar", () => {
    expect(types("4111 1111 1111 1111")).toEqual(["card"]);
  });

  it("16 digits failing Luhn are not a card", () => {
    expect(types("Order 4111 1111 1111 1112")).toEqual([]);
  });

  it("PAN with an invalid holder letter, IFSC without the 0, unknown UPI handle", () => {
    expect(types("ABCXE1234F")).toEqual([]);
    expect(types("SBIN1001234")).toEqual([]);
    expect(types("someone@randomhandle")).toEqual([]);
  });

  it("phone numbers starting 0–5, and digits inside longer runs", () => {
    expect(types("Call 5876543210")).toEqual([]);
    expect(types("Txn 98765432101234")).toEqual([]);
  });

  it("an unlabelled long number is not an account", () => {
    expect(types("Invoice 000011112222")).toEqual([]);
  });

  it("vehicle number with an unknown state code", () => {
    expect(types("ZZ 07 AB 1234")).toEqual([]);
  });

  it("an email is not also reported as UPI", () => {
    expect(types("test.user@okaxis.com")).toEqual(["email"]);
  });
});

describe("OCR slack", () => {
  const bad = fakeAadhaarInvalid("23456789012");

  it("checksum-failing Aadhaar next to the keyword is a medium-confidence finding only in OCR mode", () => {
    expect(types(`Aadhaar ${bad}`)).toEqual([]);
    const [m] = findIds(`Aadhaar ${bad}`, { ocr: true });
    expect(m?.type).toBe("aadhaar");
    expect(m?.checksumFailed).toBe(true);
    expect(m?.confidence).toBe(0.5);
  });

  it("without the keyword, OCR mode still rejects it", () => {
    expect(types(`Ref ${bad}`, true)).toEqual([]);
  });
});

describe("maskForDisplay never reveals more than the last few characters", () => {
  const a = fakeAadhaar("23456789012");
  it.each([
    ["aadhaar", a, `XXXX XXXX ${a.slice(-4)}`],
    ["card", "4111111111111111", "XXXX XXXX XXXX 1111"],
    ["phone", "9876543210", "XXXXXX3210"],
    ["email", "test.user@example.com", "t***@example.com"],
  ] as const)("%s", (type, value, expected) => {
    const masked = maskForDisplay(type, value);
    expect(masked).toBe(expected);
    expect(masked).not.toContain(value);
  });

  it("PAN keeps only the last two digits and the final letter", () => {
    expect(maskForDisplay("pan", "ABCPE1234F")).toBe("XXXXXXX34F");
  });
});
