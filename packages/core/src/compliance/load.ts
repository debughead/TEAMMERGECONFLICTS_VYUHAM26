// Turns uploaded policy JSON into a LoadedPolicy, or into readable errors a compliance team can fix.
import { sha256Hex } from "../util/hash.ts";
import { compileSafe } from "./safeRegex.ts";
import { CompliancePolicy, MAX_POLICY_BYTES, type Destination, type LoadedPolicy } from "./schema.ts";

export type PolicyLoad = { ok: true; loaded: LoadedPolicy } | { ok: false; errors: string[] };

export async function parsePolicy(text: string): Promise<PolicyLoad> {
  if (new TextEncoder().encode(text).length > MAX_POLICY_BYTES) return { ok: false, errors: [`Policy file is larger than ${MAX_POLICY_BYTES / 1024} KB`] };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    return { ok: false, errors: [`Not valid JSON: ${e instanceof Error ? e.message : "parse error"}`] };
  }
  const parsed = CompliancePolicy.safeParse(json);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.slice(0, 20).map((i) => `${i.path.join(".") || "(top level)"}: ${i.message}`) };
  }
  const policy = parsed.data;
  const errors: string[] = [];
  const ids = new Set<string>();
  policy.rules.forEach((rule, r) => {
    if (ids.has(rule.id)) errors.push(`rules.${r}.id: "${rule.id}" is used twice`);
    ids.add(rule.id);
    const signals = rule.when === "always" ? [] : rule.when.anyOf;
    [...signals, ...rule.remove].forEach((item) => {
      if ("dictionary" in item && !policy.dictionaries[item.dictionary]) errors.push(`rules.${r} (${rule.id}): dictionary "${item.dictionary}" isn't defined`);
      if ("pattern" in item) {
        const c = compileSafe(item.pattern);
        if (!c.ok) errors.push(`rules.${r} (${rule.id}): pattern ${JSON.stringify(item.pattern)}: ${c.reason}`);
      }
    });
  });
  if (errors.length) return { ok: false, errors };
  // The fingerprint covers the policy as understood (defaults filled in), so it's stable across formatting.
  return { ok: true, loaded: { policy, sha256: await sha256Hex(new TextEncoder().encode(JSON.stringify(policy))) } };
}

/** "inside" when the site's host is one of the company's domains or a subdomain of one. */
export function destinationFor(policy: LoadedPolicy["policy"], host: string): Destination {
  const h = host.toLowerCase().replace(/\.$/, "");
  return policy.internalDomains.some((d) => h === d || h.endsWith(`.${d}`)) ? "inside" : "outside";
}
