// A company's data-handling policy as JSON (Phase 1, D-039): "when the document is X, remove Y", with
// a different action for files going outside the company and inside it. Policies are uploaded by
// users, so everything is bounded: sizes, list lengths, and custom regex patterns (see safeRegex.ts).
import { z } from "zod";
import { FindingType, Verdict } from "../schemas.ts";

export const POLICY_SCHEMA_ID = "redactguard.policy/v1";
/** Largest policy file accepted (bytes of JSON). */
export const MAX_POLICY_BYTES = 256 * 1024;

const Term = z.string().trim().min(1).max(200);
const Terms = z.array(Term).min(1).max(500);
const DictName = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,39}$/);
const Pattern = z.string().min(1).max(200);

/** Built-in detectors a rule can call on by name. */
export const PolicyDetector = z.enum(["amounts", "secrets", "internal_links"]);
export type PolicyDetector = z.infer<typeof PolicyDetector>;

/** What makes a rule apply to a document. */
export const Signal = z.union([
  z.strictObject({ keywords: Terms }),
  z.strictObject({ labels: Terms }),
  z.strictObject({ findings: z.array(FindingType).min(1) }),
  z.strictObject({ dictionary: DictName }),
  z.strictObject({ markings: Terms }),
  z.strictObject({ pattern: Pattern }),
]);
export type Signal = z.infer<typeof Signal>;

/** What a matching rule removes. */
export const Target = z.union([
  z.strictObject({ types: z.array(FindingType).min(1) }),
  z.strictObject({ dictionary: DictName, label: Term.optional() }),
  z.strictObject({ pattern: Pattern, label: Term }),
  z.strictObject({ labels: Terms }),
  z.strictObject({ detect: PolicyDetector }),
]);
export type Target = z.infer<typeof Target>;

/** remove: pre-select for removal. block: don't share at all. review: flag for a person. keep: allowed. */
export const PolicyAction = z.enum(["remove", "block", "review", "keep"]);
export type PolicyAction = z.infer<typeof PolicyAction>;

export const PolicyRule = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,59}$/),
  title: z.string().trim().min(1).max(120),
  /** The company's own reference and wording, shown as "Required by: …". */
  clause: z.string().trim().min(1).max(300),
  when: z.union([z.literal("always"), z.strictObject({ anyOf: z.array(Signal).min(1).max(30) })]),
  remove: z.array(Target).min(1).max(30),
  outside: PolicyAction,
  inside: PolicyAction,
});
export type PolicyRule = z.infer<typeof PolicyRule>;

export const CompliancePolicy = z.strictObject({
  schema: z.literal(POLICY_SCHEMA_ID),
  name: z.string().trim().min(1).max(120),
  version: z.string().trim().min(1).max(40),
  owner: z.string().trim().max(200).optional(),
  description: z.string().trim().max(1000).optional(),
  /**
   * Hosts that count as inside the company (exact host or any subdomain of it). "*.acme.com" is accepted
   * and means the same as "acme.com".
   */
  internalDomains: z.array(
    z.string().trim().toLowerCase()
      .regex(/^(?:\*\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.?$/, "must be a host name like acme.com or *.acme.com")
      .transform((d) => d.replace(/^\*\./, "").replace(/\.$/, ""))
      // "com" alone would make every .com site count as inside the company.
      .refine((d) => d.includes("."), "must be the company's own domain like acme.com, not just a top-level domain like com"),
  ).max(200).default([]),
  dictionaries: z.record(DictName, z.array(Term).min(1).max(2000)).default({}),
  rules: z.array(PolicyRule).min(1).max(100),
});
export type CompliancePolicy = z.infer<typeof CompliancePolicy>;

export const Destination = z.enum(["outside", "inside"]);
export type Destination = z.infer<typeof Destination>;

/** What the engine decided for one finding. */
export const ComplianceItem = z.strictObject({
  findingId: z.string(),
  ruleId: z.string(),
  title: z.string(),
  clause: z.string(),
  action: PolicyAction,
});
export type ComplianceItem = z.infer<typeof ComplianceItem>;

/** Returned next to a ScanResult: no raw values, only ids, rule text and actions. */
export const ComplianceReport = z.strictObject({
  policy: z.strictObject({ name: z.string(), version: z.string(), sha256: z.string() }),
  destination: Destination,
  /** Rules whose "when" matched this document, with the action for this destination. */
  matchedRules: z.array(z.strictObject({ id: z.string(), title: z.string(), clause: z.string(), action: PolicyAction, because: z.string() })),
  items: z.array(ComplianceItem),
  /** The lowest verdict the policy allows; the scan's verdict is never below it. */
  verdictFloor: Verdict,
  /** Set when a matched rule forbids sharing the file at all for this destination. */
  blockedBy: z.strictObject({ ruleId: z.string(), title: z.string(), clause: z.string() }).nullable(),
});
export type ComplianceReport = z.infer<typeof ComplianceReport>;

/** A parsed, hashed policy ready to pass to scan(). */
export interface LoadedPolicy {
  policy: CompliancePolicy;
  sha256: string;
}
