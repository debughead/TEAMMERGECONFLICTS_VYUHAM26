// Shared contract between core, UI and extension messaging (docs/HLD.md §3.2).
// Every object that can reach the UI is a strictObject: an unexpected key (e.g. a raw value
// added by mistake) fails validation instead of leaking through.
// Changing this file needs approval (CLAUDE.md "Stop and ask" #2).
import { z } from "zod";

/** [x0, y0, x1, y1] in PDF points with a top-left origin (MuPDF page space), or pixels for images. */
export const Rect = z.tuple([z.number(), z.number(), z.number(), z.number()]);
export type Rect = z.infer<typeof Rect>;

export const FileType = z.enum(["pdf", "jpeg", "png", "webp", "docx", "xlsx"]);
export type FileType = z.infer<typeof FileType>;

export const FindingType = z.enum([
  "aadhaar", "pan", "card", "ifsc", "upi", "phone", "email", "vehicle",
  "name", "address", "medical", "salary", "account",
  "gps", "metadata", "hidden_content", "old_version", "identity_kit", "other",
]);
export type FindingType = z.infer<typeof FindingType>;

export const FindingSource = z.enum([
  "text", "ocr", "under_black_box", "black_highlight", "unapplied_annot",
  "old_version", "metadata", "hidden_office", "claude", "combination",
]);
export type FindingSource = z.infer<typeof FindingSource>;

export const Severity = z.enum(["critical", "high", "medium", "low"]);
export type Severity = z.infer<typeof Severity>;

export const Verdict = z.enum(["block", "warn", "allow"]);
export type Verdict = z.infer<typeof Verdict>;

export const Detector = z.enum(["forensic", "regex", "local_ner", "ocr", "metadata", "office", "claude", "rules"]);
export type Detector = z.infer<typeof Detector>;

export const Finding = z.strictObject({
  id: z.string(),
  type: FindingType,
  source: FindingSource,
  /** 0-based page index; null for document-level findings (metadata, hidden sheets). */
  page: z.int().nonnegative().nullable(),
  rects: z.array(Rect),
  /** Display-safe form, e.g. "XXXX XXXX 1234". Never the raw value. */
  masked: z.string(),
  severity: Severity,
  reason: z.string(),
  confidence: z.number().min(0).max(1),
  /** False when the value can't be located precisely enough to remove (e.g. AI text not found on the page). */
  redactable: z.boolean(),
  /** Never legitimate to share (hidden text, metadata, GPS, old versions); Auto-clean may remove it silently. */
  autoCleanable: z.boolean(),
  detector: Detector,
});
export type Finding = z.infer<typeof Finding>;

export const ScanContext = z.strictObject({
  domain: z.string().max(253),
  fieldLabel: z.string().max(200),
  pageTitle: z.string().max(300),
});
export type ScanContext = z.infer<typeof ScanContext>;

export const ContextJudgement = z.strictObject({
  expected: z.boolean(),
  neededTypes: z.array(FindingType),
  decidedBy: z.enum(["rules", "claude", "default"]),
  trustedSite: z.boolean(),
});
export type ContextJudgement = z.infer<typeof ContextJudgement>;

export const GpsSummary = z.strictObject({
  /** Rounded to 1 decimal (~11 km) so the UI can show a coarse map without the exact spot. */
  coarseLat: z.number(),
  coarseLon: z.number(),
});
export type GpsSummary = z.infer<typeof GpsSummary>;

export const ScanResult = z.strictObject({
  scanId: z.string(),
  fileSha256: z.string().regex(/^[0-9a-f]{64}$/),
  fileType: FileType,
  pageCount: z.int().nonnegative(),
  verdict: Verdict,
  exposureScore: z.int().min(0).max(100),
  findings: z.array(Finding),
  gps: GpsSummary.nullable(),
  ocr: z.strictObject({ pagesDone: z.int().nonnegative(), pagesTotal: z.int().nonnegative() }),
  context: ContextJudgement.nullable(),
  ai: z.strictObject({ enabled: z.boolean(), used: z.boolean(), payloadIds: z.array(z.string()) }),
  warnings: z.array(z.string()),
});
export type ScanResult = z.infer<typeof ScanResult>;

export const LimitProfile = z.enum(["extension", "lab"]);
export type LimitProfile = z.infer<typeof LimitProfile>;

export const ScanOptions = z.strictObject({
  profile: LimitProfile,
  context: ScanContext.nullable(),
  /** Max pages to OCR; extension uses 3, Lab uses all (D-005). */
  ocrPageCap: z.int().nonnegative(),
  trustedSite: z.boolean(),
});
export type ScanOptions = z.infer<typeof ScanOptions>;

export const Watermark = z.strictObject({
  domain: z.string().max(253),
  purpose: z.string().max(120),
  date: z.string().max(40),
});
export type Watermark = z.infer<typeof Watermark>;

export const RedactOptions = z.strictObject({
  selectedIds: z.array(z.string()),
  watermark: Watermark.nullable(),
});
export type RedactOptions = z.infer<typeof RedactOptions>;

export const VerifyCheckName = z.enum([
  "no_text_in_redacted_areas",
  "no_removed_values_remain",
  "metadata_empty",
  "single_revision",
  "no_annots_embeds_js",
  "no_image_metadata",
]);
export type VerifyCheckName = z.infer<typeof VerifyCheckName>;

export const VerifyCheck = z.strictObject({
  name: VerifyCheckName,
  passed: z.boolean(),
  /** Counts and locations only; never the leaked value. */
  detail: z.string(),
});
export type VerifyCheck = z.infer<typeof VerifyCheck>;

export const VerifyReport = z.strictObject({
  passed: z.boolean(),
  recoverableItems: z.int().nonnegative(),
  checks: z.array(VerifyCheck),
  outputSha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export type VerifyReport = z.infer<typeof VerifyReport>;

export const RedactResult = z.strictObject({
  /** Present only when verify.passed; there is no override (CLAUDE.md). */
  bytes: z.instanceof(Uint8Array).nullable(),
  mime: z.string(),
  filename: z.string(),
  verify: VerifyReport,
  /** Selected finding ids that could not be removed (e.g. not locatable). */
  unredacted: z.array(z.string()),
});
export type RedactResult = z.infer<typeof RedactResult>;

export const AuditAction = z.enum(["scan", "redact", "verify", "override", "trust_site", "ai_call"]);
export type AuditAction = z.infer<typeof AuditAction>;

export const AuditEvent = z.strictObject({
  seq: z.int().nonnegative(),
  ts: z.string(),
  origin: z.enum(["weblab", "extension"]),
  action: AuditAction,
  fileSha256: z.string().nullable(),
  fileType: FileType.nullable(),
  domain: z.string().nullable(),
  itemType: FindingType.nullable(),
  page: z.int().nonnegative().nullable(),
  /** HMAC-SHA256 under a non-extractable key (D-010); never the value. */
  valueHmac: z.string().nullable(),
  verdict: Verdict.nullable(),
  /** Free text limited to counts/reasons; override reasons are user-typed. */
  detail: z.string().max(500),
  prevHash: z.string(),
  rowHash: z.string(),
});
export type AuditEvent = z.infer<typeof AuditEvent>;
