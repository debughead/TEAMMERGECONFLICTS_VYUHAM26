import { describe, expect, it } from "vitest";
import { appendAudit, generateAuditKey, hmacHex, memoryAuditStore, verifyChain } from "../src/audit/chain.ts";
import { fakeAadhaar } from "./helpers/fakeIds.ts";

describe("audit chain", () => {
  it("appends linked rows and verifies intact", async () => {
    const store = memoryAuditStore();
    const key = await generateAuditKey();
    await appendAudit(store, key, { origin: "weblab", action: "scan", verdict: "block", detail: "3 findings" });
    await appendAudit(store, key, { origin: "weblab", action: "redact", itemType: "aadhaar", page: 0, value: fakeAadhaar("23456789012") });
    await appendAudit(store, key, { origin: "weblab", action: "verify", detail: "passed" });
    expect(store.rows.map((r) => r.seq)).toEqual([0, 1, 2]);
    expect(store.rows[1]!.prevHash).toBe(store.rows[0]!.rowHash);
    expect(await verifyChain(store.rows)).toEqual({ ok: true, count: 3, firstBroken: null });
  });

  it("never stores the raw value, only an HMAC that matches under the same key", async () => {
    const store = memoryAuditStore();
    const key = await generateAuditKey();
    const value = fakeAadhaar("49871234567");
    const e = await appendAudit(store, key, { origin: "extension", action: "redact", itemType: "aadhaar", value });
    expect(JSON.stringify(store.rows)).not.toContain(value);
    expect(e.valueHmac).toBe(await hmacHex(key, value));
    // A different install's key gives a different HMAC: no cross-device correlation.
    expect(e.valueHmac).not.toBe(await hmacHex(await generateAuditKey(), value));
  });

  it("the key can't be exported", async () => {
    const key = await generateAuditKey();
    await expect(crypto.subtle.exportKey("raw", key)).rejects.toThrow();
  });

  it("detects an edited row and points at it", async () => {
    const store = memoryAuditStore();
    const key = await generateAuditKey();
    for (const action of ["scan", "redact", "verify"] as const) await appendAudit(store, key, { origin: "weblab", action });
    store.rows[1] = { ...store.rows[1]!, detail: "edited later" };
    expect(await verifyChain(store.rows)).toMatchObject({ ok: false, firstBroken: 1 });
  });

  it("detects a deleted row", async () => {
    const store = memoryAuditStore();
    const key = await generateAuditKey();
    for (const action of ["scan", "redact", "verify"] as const) await appendAudit(store, key, { origin: "weblab", action });
    store.rows.splice(1, 1);
    expect((await verifyChain(store.rows)).ok).toBe(false);
  });

  it("concurrent appends don't fork the chain", async () => {
    const store = memoryAuditStore();
    const key = await generateAuditKey();
    await Promise.all(Array.from({ length: 10 }, (_, i) => appendAudit(store, key, { origin: "weblab", action: "scan", detail: String(i) })));
    expect(store.rows.map((r) => r.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect((await verifyChain(store.rows)).ok).toBe(true);
  });

  it("override reasons are capped in length", async () => {
    const store = memoryAuditStore();
    const e = await appendAudit(store, await generateAuditKey(), { origin: "extension", action: "override", detail: "x".repeat(2000) });
    expect(e.detail.length).toBe(500);
  });
});

describe("redact() writes audit rows", async () => {
  const { readFileSync } = await import("node:fs");
  const { scan, redact } = await import("../src/index.ts");
  const { FAKE } = await import("../scripts/sampleData.ts");
  it("one row per removed item with an HMAC (never the value), plus a verify row", async () => {
    const bytes = new Uint8Array(readFileSync(new URL("../../../samples/bank-statement-fake-redaction.pdf", import.meta.url)));
    const result = await scan(bytes, { profile: "lab", context: null, ocrPageCap: 0, trustedSite: false });
    const store = memoryAuditStore();
    const key = await generateAuditKey();
    await redact(result.scanId, { selectedIds: result.findings.map((f) => f.id), watermark: null }, { audit: { store, key, origin: "weblab" } });
    const redactRows = store.rows.filter((r) => r.action === "redact");
    expect(redactRows.length).toBe(result.findings.filter((f) => f.redactable).length);
    expect(redactRows.find((r) => r.itemType === "aadhaar")?.valueHmac).toBe(await hmacHex(key, FAKE.aadhaar));
    expect(store.rows.at(-1)?.action).toBe("verify");
    const json = JSON.stringify(store.rows);
    for (const v of [FAKE.aadhaar, FAKE.accountNo, FAKE.phone, FAKE.name]) expect(json).not.toContain(v);
    expect((await verifyChain(store.rows)).ok).toBe(true);
  });
});
