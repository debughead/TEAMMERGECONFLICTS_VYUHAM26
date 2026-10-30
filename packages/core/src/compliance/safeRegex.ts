// Custom patterns come from uploaded policy files, so they're checked before use. JavaScript regexes
// can't be interrupted, and a pattern like (a+)+ can take forever on the right input ("ReDoS").
// Two checks: refuse the known catastrophic shapes, then time the pattern on hostile inputs.

/** Inputs that make backtracking patterns explode, timed once when the policy loads. */
const PROBES = ["a".repeat(3000) + "!", "1".repeat(3000) + "x", "a1".repeat(1500) + "!", " ".repeat(3000) + "x", "aA-_.@".repeat(500) + "\n"];
/** A safe pattern scans 3,000 characters in well under a millisecond; this leaves a wide margin. */
const PROBE_BUDGET_MS = 50;

export type RegexCheck = { ok: true; regex: RegExp } | { ok: false; reason: string };

export function compileSafe(source: string, caseInsensitive = true): RegexCheck {
  if (source.length > 200) return { ok: false, reason: "pattern is longer than 200 characters" };
  if (/\\[1-9]|\\k</.test(source)) return { ok: false, reason: "back-references aren't allowed" };
  // A quantified group that itself contains a quantifier: (x+)+, (x*)*, (x{2,})+ …
  if (/\((?:[^()\\]|\\.)*(?:[+*]|\{\d+,?\d*\})(?:[^()\\]|\\.)*\)\s*(?:[+*]|\{\d+,?\d*\})/.test(source)) {
    return { ok: false, reason: "nested repetition like (x+)+ can freeze the scan" };
  }
  let regex: RegExp;
  try {
    regex = new RegExp(source, caseInsensitive ? "giu" : "gu");
  } catch (e) {
    return { ok: false, reason: `not a valid pattern (${e instanceof Error ? e.message : "syntax error"})` };
  }
  if (regex.test("")) return { ok: false, reason: "pattern matches empty text" };
  for (const probe of PROBES) {
    const t0 = performance.now();
    regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(probe)) !== null) if (m[0].length === 0) regex.lastIndex++; // zero-width: step past it
    if (performance.now() - t0 > PROBE_BUDGET_MS) return { ok: false, reason: "pattern is too slow on long text" };
  }
  regex.lastIndex = 0;
  return { ok: true, regex };
}
