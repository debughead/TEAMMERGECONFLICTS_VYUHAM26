// Destination-aware verdicts (docs/HLD.md §3.5.7). Rules first; AI (opt-in) only as a tie-breaker
// when no rule matches. Hard rules: hidden data is never below "warn"; a trusted site never turns
// "block" into "allow"; nothing derived from page or document text can lower a verdict below the
// hidden-data floor.
import type { ContextJudgement, Finding, FindingType, ScanContext, Verdict } from "./schemas.ts";
import { HIDDEN_SOURCES } from "./score.ts";

interface Rule {
  /** Matched against field label + page title (lower-cased). */
  when: RegExp;
  expects: FindingType[];
}

/** What a page legitimately asks for. Order doesn't matter; all matching rules are combined. */
export const EXPECTATION_RULES: readonly Rule[] = [
  { when: /\b(?:aadhaa?r|e-?kyc|kyc|uidai|identity proof|id proof|address proof)\b/, expects: ["aadhaar", "name", "address", "phone"] },
  { when: /\b(?:pan|income tax|itr|tax return|form 16)\b/, expects: ["pan", "name", "salary"] },
  { when: /\b(?:resume|cv|curriculum vitae|job|career|apply|application)\b/, expects: ["name", "phone", "email", "address"] },
  // Not a bare "statement": a job portal's "Statement of Purpose" isn't asking for bank details.
  { when: /\b(?:bank statement|account statement|statement of account|bank account statement|e-?statement)\b/, expects: ["account", "ifsc", "name", "address", "upi"] },
  { when: /\b(?:cancelled cheque|cheque|bank details|bank account|ifsc|payout|salary account)\b/, expects: ["account", "ifsc", "name"] },
  { when: /\b(?:payslip|salary slip|pay slip|income proof|salary)\b/, expects: ["salary", "name", "pan", "account"] },
  { when: /\b(?:medical|prescription|insurance claim|health|hospital|lab report|clinic)\b/, expects: ["medical", "name", "phone", "address"] },
  { when: /\b(?:vehicle|rc book|registration certificate|driving licen[cs]e|insurance)\b/, expects: ["vehicle", "name", "address"] },
];

export interface PageFitAnswer {
  expected: boolean;
  neededTypes: FindingType[];
}

export interface PolicyInput {
  findings: Finding[];
  context: ScanContext | null;
  trustedSite: boolean;
  /** Present only when the user enabled AI and no rule matched (see decidePageFit). */
  aiAnswer?: PageFitAnswer | null;
}

export function ruleExpectations(context: ScanContext): FindingType[] | null {
  // The domain is left out (D-042): anyone can register free-aadhaar-update.xyz, and a word in it would
  // make Aadhaar numbers "expected" there. Real sites name what they want in the field or the title.
  const haystack = `${context.fieldLabel} ${context.pageTitle}`.toLowerCase();
  const hits = EXPECTATION_RULES.filter((r) => r.when.test(haystack));
  return hits.length ? [...new Set(hits.flatMap((r) => r.expects))] : null;
}

/** Types that only ever matter as leaks, never as something a page "needs". */
const NEVER_NEEDED: ReadonlySet<FindingType> = new Set(["gps", "metadata", "hidden_content", "old_version", "identity_kit", "card"]);

export function decideVerdict(input: PolicyInput): { verdict: Verdict; context: ContextJudgement | null } {
  const { findings, context, trustedSite } = input;
  if (!context) return { verdict: baseOnly(findings), context: null };

  const fromRules = ruleExpectations(context);
  const needed = fromRules ?? input.aiAnswer?.neededTypes ?? [];
  const decidedBy: ContextJudgement["decidedBy"] = fromRules ? "rules" : input.aiAnswer ? "claude" : "default";
  const neededSet = new Set(needed.filter((t) => !NEVER_NEEDED.has(t)));
  const expected = fromRules ? true : input.aiAnswer?.expected ?? false;

  const hidden = findings.filter((f) => HIDDEN_SOURCES.has(f.source));
  // Findings the page doesn't need are the risk; needed ones are fine (metadata still gets stripped).
  const unneeded = findings.filter((f) => !HIDDEN_SOURCES.has(f.source) && !neededSet.has(f.type) && f.type !== "metadata" && f.type !== "gps");
  const unneededCritical = unneeded.some((f) => f.severity === "critical");
  const unneededHighMedium = unneeded.some((f) => f.severity === "high" || f.severity === "medium");

  let verdict: Verdict;
  // A critical item the page doesn't need blocks even on pages that expect some upload
  // (a job portal wants a resume, not a bank account number).
  if (unneededCritical) verdict = "block";
  else if (hidden.length > 0 && !trustedSite) verdict = "block";
  else if (unneededHighMedium || hidden.length > 0) verdict = "warn";
  else verdict = "allow";

  // Trusted sites relax a warning, never a block (hard rule).
  if (trustedSite && verdict === "warn" && hidden.length === 0) verdict = "allow";
  // Hidden data floor (hard rule): whatever the context says, hidden leaks are at least a warning.
  if (hidden.length > 0 && verdict === "allow") verdict = "warn";

  return {
    verdict,
    context: { expected, neededTypes: [...neededSet], decidedBy, trustedSite },
  };
}

function baseOnly(findings: Finding[]): Verdict {
  if (findings.some((f) => f.severity === "critical")) return "block";
  if (findings.some((f) => f.severity === "high" || f.severity === "medium")) return "warn";
  return "allow";
}

/** True when the AI tie-breaker may be asked: a context exists and no rule matched. */
export const needsPageFitTieBreak = (context: ScanContext | null) => context !== null && ruleExpectations(context) === null;
