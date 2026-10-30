// IndexedDB-backed audit log (D-010). Used only inside the engine worker, so there is a single
// writer and the hash chain can't fork between contexts. The HMAC key is a non-extractable CryptoKey stored as-is
// (structured clone keeps it unexportable), so this origin can use it but never read it out.
import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import { appendAudit, generateAuditKey, verifyChain, type AuditEvent, type AuditHead, type AuditInput, type AuditStore, type ChainCheck } from "@redactguard/core";

interface Schema extends DBSchema {
  audit: { key: number; value: AuditEvent };
  // "audit-hmac": the key; "audit-head": the signed head of the chain (D-043). Same store, so no DB upgrade.
  keys: { key: string; value: CryptoKey | AuditHead };
}

let db: Promise<IDBPDatabase<Schema>> | null = null;
const open = () =>
  (db ??= openDB<Schema>("redactguard", 1, {
    upgrade(d) {
      d.createObjectStore("audit", { keyPath: "seq" });
      d.createObjectStore("keys");
    },
  }));

export async function auditKey(): Promise<CryptoKey> {
  const d = await open();
  const existing = await d.get("keys", "audit-hmac");
  if (existing instanceof CryptoKey) return existing;
  const key = await generateAuditKey();
  await d.put("keys", key, "audit-hmac");
  return key;
}

export const auditStore: AuditStore = {
  async last() {
    const cursor = await (await open()).transaction("audit").store.openCursor(null, "prev");
    return cursor?.value ?? null;
  },
  // add() (not put) so an existing seq can never be overwritten. Row and head are written together.
  async append(e, head) {
    const tx = (await open()).transaction(["audit", "keys"], "readwrite");
    await Promise.all([tx.objectStore("audit").add(e), tx.objectStore("keys").put(head, "audit-head"), tx.done]);
  },
  async all() { return (await open()).getAll("audit"); },
  async head() {
    const h = await (await open()).get("keys", "audit-head");
    return h && !(h instanceof CryptoKey) ? h : null;
  },
};

export async function logAudit(input: AuditInput): Promise<void> {
  await appendAudit(auditStore, await auditKey(), input);
}

export const allAuditEvents = () => auditStore.all();
export async function checkAuditChain(): Promise<ChainCheck> {
  return verifyChain(await auditStore.all(), { head: await auditStore.head(), key: await auditKey() });
}
