// Applies a company policy to a scanned document (D-039). Pure apart from adding findings to the
// collector: decides which rules apply ("when"), finds what they remove (adding findings for things only
// the policy knows, like codenames), and returns an action per finding. A policy can only make the
// result stricter: it never removes a finding or lowers a severity, and its verdict is a floor.
import { rectsForRange, type TextLayer } from "../extract/textLayer.ts";
import type { FindingCollector } from "../pipeline/findings.ts";
import type { Finding, Rect, Severity, Verdict } from "../schemas.ts";
import { findAmounts, findInternalLinks, findLabelValues, findPattern, findSecrets, findTerms, hasLabel, type TextHit } from "./detect.ts";
import { compileSafe } from "./safeRegex.ts";
import type { ComplianceItem, ComplianceReport, Destination, LoadedPolicy, PolicyAction, PolicyRule, Signal, Target } from "./schema.ts";

const RANK: Record<PolicyAction, number> = { keep: 1, review: 2, remove: 3, block: 4 };
const SEVERITY: Record<PolicyAction, Severity> = { keep: "low", review: "medium", remove: "high", block: "critical" };
/** Built-in findings that are never something a rule "keeps" away from the user's attention. */
const NOT_LISTABLE = new Set<Finding["type"]>(["identity_kit"]);

export interface PolicyRun {
  loaded: LoadedPolicy;
  destination: Destination;
}

export function applyPolicy(run: PolicyRun, layers: TextLayer[], out: FindingCollector): ComplianceReport {
  const { policy, sha256 } = run.loaded;
  // What a document *is* can also show in its properties ("STRICTLY CONFIDENTIAL board pack" as the
  // title), so metadata values count for "when" signals. Targets are still found in the text only.
  const metadataText = out.findings.filter((f) => f.type === "metadata").flatMap((f) => out.raws.get(f.id) ?? []);
  const fullText = [...layers.map((l) => l.text), ...metadataText].join("\n");
  const present = new Set(out.findings.map((f) => f.type));
  const best = new Map<string, ComplianceItem>();
  const matchedRules: ComplianceReport["matchedRules"] = [];
  let blockedBy: ComplianceReport["blockedBy"] = null;

  let touchedNow: Set<string> = new Set();
  const assign = (f: Finding, rule: PolicyRule, action: PolicyAction) => {
    touchedNow.add(f.id);
    const prev = best.get(f.id);
    if (!prev || RANK[action] > RANK[prev.action]) best.set(f.id, { findingId: f.id, ruleId: rule.id, title: rule.title, clause: rule.clause, action });
  };

  for (const rule of policy.rules) {
    const always = rule.when === "always";
    const because = always ? "applies to every document" : firstSignal((rule.when as Exclude<PolicyRule["when"], "always">).anyOf, fullText, present, policy.dictionaries);
    if (because === null) continue;
    const action = rule[run.destination];
    const touched = new Set<string>();

    touchedNow = touched;
    for (const target of rule.remove) {
      if ("types" in target) {
        for (const f of out.findings) if (target.types.includes(f.type) && !NOT_LISTABLE.has(f.type)) assign(f, rule, action);
        continue;
      }
      // Things only the policy knows about become findings, unless the action is "keep" (nothing to do).
      if (action === "keep") continue;
      for (const layer of layers) {
        for (const hit of targetHits(target, layer.text, policy)) {
          // Comments and Office text aren't drawn on a page: no area to paint over (see TextLayer.structural).
          const rects = layer.structural ? [] : rectsForRange(layer, hit.start, hit.end);
          const page = layer.structural ? layer.structural.page : layer.index;
          const existing = page === null ? undefined : sameSpot(out.findings, page, rects);
          if (existing) { assign(existing, rule, action); continue; }
          const f = out.add({
            // Comments are hidden from the page; Office body text is ordinary visible text.
            type: "other", source: layer.structural?.removable ? "hidden_office" : "text", page, rects,
            masked: `${hit.label ?? targetLabel(target)}: ${mask(hit.raw)}`,
            // The rule and its clause are shown from the compliance report; the reason says what this is.
            reason: `Something the company policy asks to look for ("${rule.title}")`,
            confidence: 0.9, redactable: layer.structural ? layer.structural.removable : rects.length > 0, detector: "rules",
          }, [hit.raw], SEVERITY[action]);
          assign(f, rule, action);
        }
      }
    }
    // An always-on rule is only worth listing when it found something; a rule matched by what the document
    // is (keywords, markings…) is listed either way, because that's the classification itself.
    if (always && touched.size === 0) continue;
    matchedRules.push({ id: rule.id, title: rule.title, clause: rule.clause, action, because: always ? `found ${touched.size} item(s) it covers` : because });
    if (action === "block" && !blockedBy) blockedBy = { ruleId: rule.id, title: rule.title, clause: rule.clause };
  }

  const items = [...best.values()];
  const verdictFloor: Verdict = blockedBy ? "block" : items.some((i) => i.action === "remove" || i.action === "review") ? "warn" : "allow";
  return { policy: { name: policy.name, version: policy.version, sha256 }, destination: run.destination, matchedRules, items, verdictFloor, blockedBy };
}

/** Strictest of two verdicts. */
export function stricter(a: Verdict, b: Verdict): Verdict {
  const r: Record<Verdict, number> = { allow: 0, warn: 1, block: 2 };
  return r[a] >= r[b] ? a : b;
}

/** A short, value-free description of why a rule matched, or null if none of its signals did. */
function firstSignal(signals: Signal[], text: string, present: Set<Finding["type"]>, dictionaries: Record<string, string[]>): string | null {
  for (const s of signals) {
    if ("keywords" in s) { const k = s.keywords.find((t) => findTerms(text, [t]).length); if (k) return `mentions "${k}"`; }
    else if ("labels" in s) { const l = s.labels.find((t) => hasLabel(text, t)); if (l) return `has a "${l}" field`; }
    else if ("findings" in s) { const t = s.findings.find((x) => present.has(x)); if (t) return `contains a ${t.replace("_", " ")}`; }
    else if ("dictionary" in s) { if (findTerms(text, dictionaries[s.dictionary] ?? []).length) return `mentions a term from "${s.dictionary}"`; }
    else if ("markings" in s) { const m = s.markings.find((t) => findTerms(text, [t]).length); if (m) return `is marked "${m}"`; }
    else if ("pattern" in s) { const c = compileSafe(s.pattern); if (c.ok && findPattern(text, c.regex).length) return "matches a pattern in the policy"; }
  }
  return null;
}

function targetHits(target: Exclude<Target, { types: unknown }>, text: string, policy: LoadedPolicy["policy"]): TextHit[] {
  if ("dictionary" in target) return findTerms(text, policy.dictionaries[target.dictionary] ?? []);
  if ("labels" in target) return findLabelValues(text, target.labels);
  if ("pattern" in target) { const c = compileSafe(target.pattern); return c.ok ? findPattern(text, c.regex) : []; }
  switch (target.detect) {
    case "amounts": return findAmounts(text);
    case "secrets": return findSecrets(text);
    case "internal_links": return findInternalLinks(text, policy.internalDomains);
  }
}

function targetLabel(target: Exclude<Target, { types: unknown }>): string {
  if ("dictionary" in target) return target.label ?? `From "${target.dictionary}"`;
  if ("labels" in target) return target.labels[0]!;
  if ("pattern" in target) return target.label;
  return { amounts: "Amount", secrets: "Secret", internal_links: "Internal link" }[target.detect];
}

/** Display-safe: first character, then stars (secrets and codenames are never shown). */
function mask(raw: string): string {
  const t = raw.trim();
  return t.length <= 2 ? "**" : `${t[0]}${"*".repeat(Math.min(8, t.length - 1))}`;
}

/** An existing finding on the same page whose area already covers this hit (don't list it twice). */
function sameSpot(findings: Finding[], page: number, rects: Rect[]): Finding | undefined {
  if (!rects.length) return undefined;
  const overlap = (a: Rect, b: Rect) => {
    const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]), h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
    const area = (a[2] - a[0]) * (a[3] - a[1]);
    return w > 0 && h > 0 && area > 0 ? (w * h) / area : 0;
  };
  return findings.find((f) => f.page === page && f.rects.length && rects.every((r) => f.rects.some((q) => overlap(r, q) >= 0.8)));
}
