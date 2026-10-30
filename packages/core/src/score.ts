// Severity, exposure score and a context-free base verdict (docs/HLD.md §3.5.6).
// Context-aware verdicts (expected-on-this-page, trusted sites) belong to policy.ts.
import type { Finding, FindingSource, FindingType, Severity, Verdict } from "./schemas.ts";

const TYPE_SEVERITY: Record<FindingType, Severity> = {
  aadhaar: "critical",
  card: "critical",
  old_version: "critical",
  identity_kit: "critical",
  pan: "high",
  account: "high",
  medical: "high",
  salary: "high",
  gps: "high",
  hidden_content: "critical",
  name: "medium",
  address: "medium",
  phone: "medium",
  email: "medium",
  upi: "medium",
  vehicle: "medium",
  ifsc: "low",
  metadata: "low",
  other: "low",
};

/** Sources where the user believes the data is gone or invisible; always critical. */
export const HIDDEN_SOURCES: ReadonlySet<FindingSource> = new Set([
  "under_black_box", "black_highlight", "unapplied_annot", "old_version", "hidden_office",
]);

/** Never legitimate to share, so Auto-clean may remove without asking (D-006). */
const AUTO_CLEAN_SOURCES: ReadonlySet<FindingSource> = new Set([...HIDDEN_SOURCES, "metadata"]);
const AUTO_CLEAN_TYPES: ReadonlySet<FindingType> = new Set(["gps", "metadata", "hidden_content", "old_version"]);

export function severityFor(type: FindingType, source: FindingSource): Severity {
  return HIDDEN_SOURCES.has(source) ? "critical" : TYPE_SEVERITY[type];
}

export function isAutoCleanable(type: FindingType, source: FindingSource): boolean {
  return AUTO_CLEAN_SOURCES.has(source) || AUTO_CLEAN_TYPES.has(type);
}

const WEIGHT: Record<Severity, number> = { critical: 40, high: 20, medium: 8, low: 2 };

export function exposureScore(findings: Pick<Finding, "severity" | "source">[]): number {
  const total = findings.reduce((s, f) => s + WEIGHT[f.severity] * (HIDDEN_SOURCES.has(f.source) ? 1.5 : 1), 0);
  return Math.min(100, Math.round(total));
}

/** Verdict before page context is known: critical → block, high/medium → warn, else allow. */
export function baseVerdict(findings: Pick<Finding, "severity">[]): Verdict {
  if (findings.some((f) => f.severity === "critical")) return "block";
  if (findings.some((f) => f.severity === "high" || f.severity === "medium")) return "warn";
  return "allow";
}
