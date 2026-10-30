// Custom patterns come from uploaded policy files, so they're checked before use. JavaScript regexes
// can't be interrupted, and a pattern like (a+)+ can take forever on the right input ("ReDoS").
// Two checks: refuse the known catastrophic shapes by reading the pattern (never by running it, since
// running a catastrophic pattern is exactly what can't be stopped), then time the pattern on hostile inputs.

/** Inputs that make backtracking patterns explode, timed once when the policy loads. */
const PROBES = ["a".repeat(3000) + "!", "1".repeat(3000) + "x", "a1".repeat(1500) + "!", " ".repeat(3000) + "x", "aA-_.@".repeat(500) + "\n"];
/** A safe pattern scans 3,000 characters in well under a millisecond; this leaves a wide margin. */
const PROBE_BUDGET_MS = 50;

export type RegexCheck = { ok: true; regex: RegExp } | { ok: false; reason: string };

/**
 * Shapes that backtrack badly, found by walking the pattern:
 * - a repeated group that itself repeats or has alternatives: (x+)+, (a|aa)+, (\w|\d)+ (exponential);
 * - an open-ended repeat of "almost anything" (., [\s\S], [^x], \D, \W): on a long document every start
 *   position scans to the end (quadratic), so a 40-page file stalls. A bounded form (.{0,100}) is fine.
 */
function riskyShape(source: string): string | null {
  interface Group { repeats: boolean; alternates: boolean }
  const stack: Group[] = [{ repeats: false, alternates: false }];
  let last: { broad: boolean; group?: Group } | null = null;
  let i = 0;
  while (i < source.length) {
    const c = source[i]!;
    if (c === "\\") {
      last = { broad: /[DW]/.test(source[i + 1] ?? "") };
      i += 2;
      continue;
    }
    if (c === "[") {
      let j = i + 1;
      if (source[j] === "^") j++;
      if (source[j] === "]") j++;
      while (j < source.length && source[j] !== "]") j += source[j] === "\\" ? 2 : 1;
      const body = source.slice(i + 1, j);
      const negated = body.startsWith("^");
      const everything = /\\s\\S|\\S\\s|\\d\\D|\\D\\d|\\w\\W|\\W\\w/.test(body);
      last = { broad: negated || everything };
      i = j + 1;
      continue;
    }
    if (c === "(") {
      stack.push({ repeats: false, alternates: false });
      i++;
      // Skip the group's prefix: (?: (?= (?! (?<= (?<! (?<name>
      if (source[i] === "?") {
        if (source[i + 1] === "<" && source[i + 2] !== "=" && source[i + 2] !== "!") i = source.indexOf(">", i) + 1;
        else i += source[i + 1] === "<" ? 3 : 2;
      }
      last = null;
      continue;
    }
    if (c === ")") {
      const g = stack.length > 1 ? stack.pop()! : { repeats: false, alternates: false };
      const parent = stack[stack.length - 1]!;
      parent.repeats ||= g.repeats;
      parent.alternates ||= g.alternates;
      last = { broad: false, group: g };
      i++;
      continue;
    }
    if (c === "|") {
      stack[stack.length - 1]!.alternates = true;
      last = null;
      i++;
      continue;
    }
    const q = /^(?:[*+?]|\{(\d+)(,(\d*))?\})/.exec(source.slice(i));
    if (q) {
      const open = q[0] === "*" || q[0] === "+" || (q[2] !== undefined && q[3] === "");
      const repeats = open || (q[0].startsWith("{") && Number(q[3] ?? q[1]) > 1);
      if (repeats && last?.group && (last.group.repeats || last.group.alternates)) {
        return last.group.repeats
          ? "nested repetition like (x+)+ can freeze the scan"
          : "a repeated group with alternatives like (a|b)+ can freeze the scan; use a character class like [ab]+ instead";
      }
      if (open && last?.broad) return "an open-ended wildcard like .* or [^x]+ can stall on long documents; give it a limit, like .{0,100}";
      if (repeats) stack[stack.length - 1]!.repeats = true;
      i += q[0].length;
      if (source[i] === "?" || source[i] === "+") i++; // lazy / possessive marker
      last = null;
      continue;
    }
    last = { broad: c === "." };
    i++;
  }
  return null;
}

/** Checked patterns by source: a policy's patterns are checked once, not again for every page of every scan. */
const CHECKED = new Map<string, RegexCheck>();
const MAX_CHECKED = 500;

export function compileSafe(source: string, caseInsensitive = true): RegexCheck {
  const key = `${caseInsensitive ? "i" : "-"}${source}`;
  const cached = CHECKED.get(key);
  // A fresh RegExp each time: callers move lastIndex.
  if (cached) return cached.ok ? { ok: true, regex: new RegExp(cached.regex) } : cached;
  const result = check(source, caseInsensitive);
  if (CHECKED.size >= MAX_CHECKED) CHECKED.delete(CHECKED.keys().next().value!);
  CHECKED.set(key, result);
  return result.ok ? { ok: true, regex: new RegExp(result.regex) } : result;
}

function check(source: string, caseInsensitive: boolean): RegexCheck {
  if (source.length > 200) return { ok: false, reason: "pattern is longer than 200 characters" };
  if (/\\[1-9]|\\k</.test(source)) return { ok: false, reason: "back-references aren't allowed" };
  const risky = riskyShape(source);
  if (risky) return { ok: false, reason: risky };
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
