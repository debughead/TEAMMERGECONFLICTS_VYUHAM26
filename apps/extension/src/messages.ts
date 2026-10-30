// Every message crossing an extension boundary is validated with these schemas (rules/extension.md).
// Chrome serializes messages as JSON (max 64 MiB), so file bytes travel as base64 strings.
import { z } from "zod";
// The schemas-only entry: importing the main entry would pull MuPDF/WASM into every web page.
import { ScanContext, ScanResult, VerifyReport } from "@redactguard/core/schemas";
import { ComplianceReport, Destination, MAX_POLICY_BYTES } from "@redactguard/core/compliance";

/** 15 MB file cap (LIMITS.maxBytes.extension) → ~20 MB of base64, well under Chrome's 64 MiB message limit. */
const B64 = z.string().max(21 * 1024 * 1024);

export const ToBackground = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("scan"), b64: B64, fileName: z.string().max(255), context: ScanContext }),
  z.strictObject({ type: z.literal("redact"), scanId: z.string(), selectedIds: z.array(z.string()), domain: z.string().max(253) }),
  z.strictObject({ type: z.literal("override"), reason: z.string().min(3).max(200), domain: z.string().max(253), fileSha256: z.string() }),
  z.strictObject({ type: z.literal("trust"), domain: z.string().max(253) }),
  z.strictObject({ type: z.literal("open-panel") }),
  z.strictObject({ type: z.literal("tab-state"), tabId: z.int() }),
  /** Sent once by the offscreen document after its listener is registered (D-025). */
  z.strictObject({ type: z.literal("offscreen-ready") }),
  /** From the side panel: redact the chosen items and hand the verified file to the page. */
  z.strictObject({ type: z.literal("panel-redact"), tabId: z.int(), scanId: z.string(), selectedIds: z.array(z.string()) }),
  /** From the card: the user finished with this file (status shown in the side panel). */
  z.strictObject({ type: z.literal("status"), scanId: z.string(), status: z.enum(["safe-uploaded", "original-uploaded", "cancelled"]) }),
  /** From the side panel: a company policy was turned on or off (written to the audit log, D-039). */
  z.strictObject({ type: z.literal("policy-change"), detail: z.string().max(300) }),
]);

/** Background → content script. */
export const ToContent = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("attach-safe"), scanId: z.string(), b64: B64, mime: z.string(), removed: z.int() }),
]);
export type ToContent = z.infer<typeof ToContent>;

export const TabStatus = z.enum(["pending", "safe-uploaded", "original-uploaded", "cancelled"]);
export type TabStatus = z.infer<typeof TabStatus>;
export type ToBackground = z.infer<typeof ToBackground>;

export const Settings = z.strictObject({
  mode: z.enum(["ask", "auto"]),
  aiOn: z.boolean(),
  aiKey: z.string(),
  trusted: z.array(z.string()),
});
export type Settings = z.infer<typeof Settings>;
export const DEFAULT_SETTINGS: Settings = { mode: "ask", aiOn: false, aiKey: "", trusted: [] };

/** The company policy in chrome.storage.local ("policy"): the exact JSON plus what lists show (D-039). */
export const StoredPolicy = z.strictObject({
  text: z.string().max(MAX_POLICY_BYTES),
  name: z.string(),
  version: z.string(),
  sha256: z.string(),
  internalDomains: z.array(z.string()),
  rules: z.array(z.strictObject({ id: z.string(), title: z.string(), clause: z.string(), outside: z.string(), inside: z.string() })),
});
export type StoredPolicy = z.infer<typeof StoredPolicy>;

/** "inside" when the site's host is one of the company's domains or a subdomain of one. */
export function destinationOf(p: StoredPolicy | null, host: string): Destination {
  const h = host.toLowerCase().replace(/\.$/, "");
  return p && p.internalDomains.some((d) => h === d || h.endsWith(`.${d}`)) ? "inside" : "outside";
}

/** Background → offscreen. The offscreen document only has chrome.runtime, so settings travel along. */
export const ToOffscreen = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("offscreen-scan"), b64: B64, context: ScanContext, trustedSite: z.boolean(), aiKey: z.string().optional(),
    policyText: z.string().max(MAX_POLICY_BYTES).optional(), destination: Destination.optional(),
  }),
  z.strictObject({ type: z.literal("offscreen-redact"), scanId: z.string(), selectedIds: z.array(z.string()), domain: z.string() }),
  z.strictObject({ type: z.literal("offscreen-audit"), action: z.enum(["override", "trust_site", "policy_change"]), domain: z.string(), detail: z.string().max(500), fileSha256: z.string().nullable() }),
]);
export type ToOffscreen = z.infer<typeof ToOffscreen>;

export const ScanReply = z.union([
  z.strictObject({ ok: z.literal(true), result: ScanResult, compliance: ComplianceReport.nullable() }),
  z.strictObject({ ok: z.literal(false), error: z.string() }),
]);
export type ScanReply = z.infer<typeof ScanReply>;

export const RedactReply = z.union([
  z.strictObject({ ok: z.literal(true), verify: VerifyReport, b64: z.string().nullable(), mime: z.string(), unredacted: z.array(z.string()) }),
  z.strictObject({ ok: z.literal(false), error: z.string() }),
]);
export type RedactReply = z.infer<typeof RedactReply>;

export function toB64(bytes: Uint8Array): string {
  let s = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(s);
}

export function fromB64(b64: string): Uint8Array<ArrayBuffer> {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
