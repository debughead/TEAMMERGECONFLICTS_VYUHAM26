// Tamper-evident, value-free audit log (docs/HLD.md §3.8, D-010). Storage-agnostic: hosts supply an
// AuditStore (IndexedDB in browsers, memory in tests). Each row hashes the previous row's hash, so
// editing or deleting any row breaks every hash after it. A signed head (the newest row's seq and hash)
// is kept apart from the rows, so deleting the newest rows or all of them shows too (D-043).
import { AuditEvent, type AuditAction, type FileType, type FindingType, type Verdict } from "../schemas.ts";

export interface AuditStore {
  last(): Promise<AuditEvent | null>;
  /** Stores the row and, in the same write where the store can, the head that now points at it. */
  append(event: AuditEvent, head: AuditHead): Promise<void>;
  all(): Promise<AuditEvent[]>;
  head(): Promise<AuditHead | null>;
}

/** Where the chain ended at the last append, signed with the install's audit key. */
export interface AuditHead {
  seq: number;
  rowHash: string;
  /** HMAC of `seq:rowHash`: a head can't be rewritten to match a shortened log without the key. */
  mac: string;
}

export interface AuditInput {
  origin: AuditEvent["origin"];
  action: AuditAction;
  fileSha256?: string | null;
  fileType?: FileType | null;
  domain?: string | null;
  itemType?: FindingType | null;
  page?: number | null;
  verdict?: Verdict | null;
  detail?: string;
  /** Raw value to prove later without storing it: only its keyed HMAC is written. */
  value?: string | null;
}

export const GENESIS_HASH = "0".repeat(64);
const MAX_DETAIL = 500;

/** A per-install HMAC key that code can use but never read out (D-010). */
export function generateAuditKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

export async function hmacHex(key: CryptoKey, value: string): Promise<string> {
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return hex(new Uint8Array(sig));
}

const queues = new WeakMap<AuditStore, Promise<unknown>>();

/** Appends one event. Appends to the same store are serialized so the chain can't fork. */
export function appendAudit(store: AuditStore, key: CryptoKey, input: AuditInput, now: Date = new Date()): Promise<AuditEvent> {
  const prev = queues.get(store) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(async () => {
    const last = await store.last();
    const body = {
      seq: last ? last.seq + 1 : 0,
      ts: now.toISOString(),
      origin: input.origin,
      action: input.action,
      fileSha256: input.fileSha256 ?? null,
      fileType: input.fileType ?? null,
      domain: input.domain ?? null,
      itemType: input.itemType ?? null,
      page: input.page ?? null,
      valueHmac: input.value ? await hmacHex(key, input.value) : null,
      verdict: input.verdict ?? null,
      detail: (input.detail ?? "").slice(0, MAX_DETAIL),
      prevHash: last ? last.rowHash : GENESIS_HASH,
    };
    const event = AuditEvent.parse({ ...body, rowHash: await rowHash(body) });
    await store.append(event, { seq: event.seq, rowHash: event.rowHash, mac: await headMac(key, event.seq, event.rowHash) });
    return event;
  });
  queues.set(store, next);
  return next;
}

export interface ChainCheck {
  ok: boolean;
  count: number;
  /** seq of the first row whose hash or link doesn't match; null when intact. */
  firstBroken: number | null;
}

const headMac = (key: CryptoKey, seq: number, hash: string) => hmacHex(key, `${seq}:${hash}`);

/**
 * Checks every row's hash and link. With `anchor`, also checks the rows still reach the signed head:
 * without it, a log missing its newest rows (or all of them) is indistinguishable from a shorter one.
 * A log with rows but no head was written before heads existed and is checked by its rows alone.
 */
export async function verifyChain(events: AuditEvent[], anchor?: { head: AuditHead | null; key?: CryptoKey }): Promise<ChainCheck> {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  const head = anchor?.head;
  if (head) {
    const forged = anchor.key !== undefined && (await headMac(anchor.key, head.seq, head.rowHash)) !== head.mac;
    const reached = sorted.find((e) => e.seq === head.seq)?.rowHash === head.rowHash;
    if (forged || !reached) return { ok: false, count: sorted.length, firstBroken: Math.min(head.seq, sorted.length) };
  }
  let prev = GENESIS_HASH;
  for (let i = 0; i < sorted.length; i++) {
    const e = sorted[i]!;
    const { rowHash: stored, ...body } = e;
    if (e.seq !== i || e.prevHash !== prev || (await rowHash(body)) !== stored) {
      return { ok: false, count: sorted.length, firstBroken: e.seq };
    }
    prev = stored;
  }
  return { ok: true, count: sorted.length, firstBroken: null };
}

/** In-memory store for tests and for hosts that haven't opened IndexedDB yet. */
export function memoryAuditStore(): AuditStore & { rows: AuditEvent[]; lastHead: AuditHead | null } {
  const store = {
    rows: [] as AuditEvent[],
    lastHead: null as AuditHead | null,
    last: async () => store.rows[store.rows.length - 1] ?? null,
    append: async (e: AuditEvent, h: AuditHead) => { store.rows.push(e); store.lastHead = h; },
    all: async () => [...store.rows],
    head: async () => store.lastHead,
  };
  return store;
}

async function rowHash(body: Omit<AuditEvent, "rowHash">): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(body)));
  return hex(new Uint8Array(digest));
}

/** JSON with sorted keys, so the hash doesn't depend on property order. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
}

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
