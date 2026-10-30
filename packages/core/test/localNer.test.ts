import { describe, expect, it } from "vitest";
import { findLocalEntities, maskEntity, type NerType } from "../src/detect/localNer.ts";

const found = (text: string, type?: NerType) =>
  findLocalEntities(text).filter((m) => !type || m.type === type).map((m) => text.slice(m.start, m.end));

describe("names", () => {
  it("labelled names (positive)", () => {
    expect(found("Account Holder: Arjun Testkumar\n", "name")).toEqual(["Arjun Testkumar"]);
    expect(found("Patient Name - Priya Fakename\n", "name")).toEqual(["Priya Fakename"]);
    expect(found("S/O Ramesh Testpillai, House No 4", "name")).toContain("Ramesh Testpillai");
  });

  it("unlabelled two-token person names with a known Indian token", () => {
    expect(found("Prepared for Rahul Testmenon by the clinic.", "name")).toEqual(["Rahul Testmenon"]);
  });

  it("a label followed by a non-name is not a name (negative)", () => {
    expect(found("Name: No\nAccount Number: 1234", "name")).toEqual([]);
    expect(found("Bank Name Details\n", "name")).toEqual([]);
  });

  it("a heading that starts with a label word isn't a name (negative)", () => {
    expect(found("Employee Record (FAKE DATA)\n", "name")).toEqual([]);
    expect(found("Customer Service\n", "name")).toEqual([]);
    expect(found("Name: Rahul\n", "name")).toEqual(["Rahul"]);
  });

  it("ordinary capitalised words aren't names (negative)", () => {
    expect(found("Statement Period October Summary\n", "name")).toEqual([]);
  });
});

describe("addresses", () => {
  it("labelled single-line address ending in a PIN", () => {
    expect(found("Address: House No 12, Test Nagar, Kochi, Kerala 682001\n", "address")).toEqual([
      "House No 12, Test Nagar, Kochi, Kerala 682001",
    ]);
  });

  it("multi-line block with cues, no label", () => {
    const t = "Flat 3B, Testview Apartments,\nMG Road, Fakepur\nKarnataka 560001\nThank you";
    expect(found(t, "address")).toEqual(["Flat 3B, Testview Apartments,\nMG Road, Fakepur\nKarnataka 560001"]);
  });

  it("a 6-digit number with no address cue isn't an address (negative)", () => {
    expect(found("Invoice total 560001 units\n", "address")).toEqual([]);
  });
});

describe("salary and medical", () => {
  it("salary amount after a salary label", () => {
    expect(found("05-10-2026 Salary credit TESTCORP PVT LTD 85,000.00", "salary")).toEqual(["85,000.00"]);
    expect(found("Net Pay: ₹ 52,340", "salary")).toEqual(["₹ 52,340"]);
  });

  it("an amount without a salary label is not salary (negative)", () => {
    expect(found("Grocery purchase 1,500.00", "salary")).toEqual([]);
  });

  it("medical detail after a diagnosis label; strong terms raise confidence", () => {
    const [m] = findLocalEntities("Diagnosis: Type 2 diabetes, on insulin\n").filter((e) => e.type === "medical");
    expect(m?.raw).toBe("Type 2 diabetes, on insulin");
    expect(m?.confidence).toBe(0.8);
    expect(m?.needsContext).toBe(false);
  });

  it("the word 'condition' in an unrelated sentence still needs context (low confidence)", () => {
    const [m] = findLocalEntities("Condition: good, minor scratches\n").filter((e) => e.type === "medical");
    expect(m?.confidence).toBe(0.5);
    expect(m?.needsContext).toBe(true);
  });
});

describe("maskEntity", () => {
  it("never returns the raw value", () => {
    expect(maskEntity("name", "Arjun Testkumar")).toBe("A*** T***");
    expect(maskEntity("address", "House No 12, Test Nagar, Kochi 682001")).toBe("[address, PIN 68XXXX]");
    expect(maskEntity("salary", "85,000.00")).toBe("[amount]");
  });
});
