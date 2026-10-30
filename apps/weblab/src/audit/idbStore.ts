// IndexedDB-backed audit log (D-010). Used only inside the engine worker, so there is a single
// writer and the hash chain can't fork between contexts. The HMAC key is a non-extractable CryptoKey stored as-is
// (structured clone keeps it unexportable), so this origin can use it but never read it out.
import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import { appendAudit, generateAuditKey, verifyChain, type AuditEvent, type AuditInput, type AuditStore, type ChainCheck } from "@redactguard/core";

/** A company policy as uploaded (D-039): the exact JSON text, plus what's shown in lists. */
export interface StoredPolicy { id: string; text: string; name: string; version: string; sha256: string; addedAt: string }

interface Schema extends DBSchema {
  audit: { key: number; value: AuditEvent };
  keys: { key: string; value: CryptoKey };
  policies: { key: string; value: StoredPolicy };
  meta: { key: string; value: string };
}

let db: Promise<IDBPDatabase<Schema>> | null = null;
const open = () =>
  (db ??= openDB<Schema>("redactguard", 2, {
    // Versioned upgrades: an existing audit log is kept when the policy stores are added.
    upgrade(d, oldVersion) {
      if (oldVersion < 1) {
        d.createObjectStore("audit", { keyPath: "seq" });
        d.createObjectStore("keys");
      }
      if (oldVersion < 2) {
        d.createObjectStore("policies", { keyPath: "id" });
        d.createObjectStore("meta");
      }
    },
  }));

export async function auditKey(): Promise<CryptoKey> {
  const d = await open();
  const existing = await d.get("keys", "audit-hmac");
  if (existing) return existing;
  const key = await generateAuditKey();
  await d.put("keys", key, "audit-hmac");
  return key;
}

export const auditStore: AuditStore = {
  async last() {
    const cursor = await (await open()).transaction("audit").store.openCursor(null, "prev");
    return cursor?.value ?? null;
  },
  // add() (not put) so an existing seq can never be overwritten.
  async append(e) { await (await open()).add("audit", e); },
  async all() { return (await open()).getAll("audit"); },
};

export async function logAudit(input: AuditInput): Promise<void> {
  await appendAudit(auditStore, await auditKey(), input);
}

export const allAuditEvents = () => auditStore.all();
export async function checkAuditChain(): Promise<ChainCheck> {
  return verifyChain(await auditStore.all());
}

// ---------- company policies (D-039) ----------

export const listPolicies = async (): Promise<StoredPolicy[]> => (await open()).getAll("policies");
export const putPolicy = async (p: StoredPolicy): Promise<void> => { await (await open()).put("policies", p); };
export const deletePolicy = async (id: string): Promise<void> => { await (await open()).delete("policies", id); };
export const getActivePolicyId = async (): Promise<string | null> => (await (await open()).get("meta", "activePolicy")) ?? null;
export async function setActivePolicyId(id: string | null): Promise<void> {
  const d = await open();
  if (id) await d.put("meta", id, "activePolicy");
  else await d.delete("meta", "activePolicy");
}
