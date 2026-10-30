// Runs the opt-in AI pass through the host's AiClient and turns validated replies into findings.
// AI can only ADD findings; it never removes, downgrades or re-scores rule-based ones.
import { rectsForRange, type TextLayer } from "../extract/textLayer.ts";
import { LABEL, REASON_TEXT, type FindingCollector } from "../pipeline/findings.ts";
import type { FindingType, ScanContext, Severity } from "../schemas.ts";
import { severityFor } from "../score.ts";
import { chunkLines, Placeholders, selectLines } from "./minimise.ts";
import { findingsRequest, pageFitRequest } from "./prompt.ts";
import { FindingsReply, PageFitReply, type AiClient, type AiRequest } from "./schema.ts";

export interface AiLogEntry { id: string; request: AiRequest }

const ORDER: Severity[] = ["low", "medium", "high", "critical"];
const atLeast = (a: Severity, b: Severity) => (ORDER.indexOf(a) >= ORDER.indexOf(b) ? a : b);
const PLACEHOLDER = /\[[A-Z]+_\d+\]/;
/**
 * Words too common to be a sensitive detail on their own. Redacting one would black out every
 * occurrence of it, so a reply naming only such a word is ignored.
 */
const COMMON_WORDS = new Set(("a an and are as at be been but by can did do does for from had has have he her his i if in into is it " +
  "its me my no not of on or our she so than that the their them then there these they this to too up us was we were what when where " +
  "which who whom why will with would you your yes all any some very more most much many also only just over under per via mild " +
  "date name page total amount details detail patient report").split(" "));

/** A finding the reply can't support: too short to be a value, or only a common word. */
function implausible(text: string): boolean {
  const t = text.trim();
  if (t.length < 3 || !/[\p{L}\p{N}]/u.test(t)) return true;
  return COMMON_WORDS.has(t.toLowerCase());
}

export async function runAiFindings(
  layers: TextLayer[], out: FindingCollector, client: AiClient, log: AiLogEntry[],
): Promise<{ used: boolean; errors: string[] }> {
  const ph = new Placeholders();
  const lines = selectLines(layers, ph);
  if (lines.length === 0) return { used: false, errors: [] };
  const errors: string[] = [];
  let used = false;

  for (const chunk of chunkLines(lines)) {
    const request = findingsRequest(chunk.lines, chunk.from);
    log.push({ id: `ai${log.length + 1}`, request });
    let reply: FindingsReply;
    try {
      reply = FindingsReply.parse(await client(request));
      used = true;
    } catch (e) {
      errors.push(e instanceof Error && e.name === "ZodError" ? "AI reply didn't match the expected format and was ignored" : "AI request failed; local results are shown");
      continue;
    }
    for (const f of reply.findings) {
      if (PLACEHOLDER.test(f.text) || implausible(f.text)) continue;
      // Accept only text that really is in one of the lines we sent (prevents invented findings).
      const line = chunk.lines.find((l) => l.original.includes(f.text));
      if (!line) continue;
      const layer = layers.find((l) => l.index === line.layer);
      if (!layer) continue;
      const start = line.start + line.original.indexOf(f.text);
      const end = start + f.text.length;
      const alreadyCovered = out.findings.some((x) => x.page === layer.index && x.rects.some((r) =>
        rectsForRange(layer, start, end).some((q) => q[0] < r[2] && r[0] < q[2] && q[1] < r[3] && r[1] < q[3])));
      if (alreadyCovered) continue;
      const type: FindingType = f.type;
      out.add({
        type, source: "claude", page: layer.index, rects: rectsForRange(layer, start, end),
        masked: `[${f.type} detail]`,
        // The model's reason is shown, but severity can only be raised above the local default.
        reason: f.reason || `${LABEL[type as keyof typeof LABEL] ?? "Detail"} ${REASON_TEXT.claude}`,
        confidence: 0.7, redactable: true, detector: "claude",
      }, [f.text]);
      const added = out.findings[out.findings.length - 1]!;
      added.severity = atLeast(f.severity, severityFor(type, "claude"));
    }
  }
  return { used, errors };
}

export async function runPageFit(
  context: ScanContext, foundTypes: FindingType[], client: AiClient, log: AiLogEntry[],
): Promise<PageFitReply | null> {
  const request = pageFitRequest(context, foundTypes);
  log.push({ id: `ai${log.length + 1}`, request });
  try {
    return PageFitReply.parse(await client(request));
  } catch {
    return null;
  }
}
