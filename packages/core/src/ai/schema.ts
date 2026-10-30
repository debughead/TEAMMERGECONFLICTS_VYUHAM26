// AI request/reply contract (docs/HLD.md §3.5.5, D-019). The core builds requests and validates
// replies; the host performs the call (Anthropic SDK, user's own key) and returns the parsed JSON.
import { z } from "zod";
import { FindingType } from "../schemas.ts";

export const AI_MODEL = "claude-opus-5-5";

/** What the host must send. `outputFormat` goes into `output_config.format`, `effort` into `output_config.effort`. */
export interface AiRequest {
  kind: "findings" | "page_fit";
  model: typeof AI_MODEL;
  effort: "low" | "medium";
  maxTokens: number;
  system: string;
  /** Placeholder-masked text only. This exact string is what "What was sent to AI" shows. */
  user: string;
  outputFormat: { type: "json_schema"; schema: Record<string, unknown> };
}

/** Host-supplied transport. Must return the parsed JSON object (or throw). */
export type AiClient = (request: AiRequest) => Promise<unknown>;

export const AI_FINDING_TYPES = ["name", "address", "medical", "salary", "account", "other"] as const;

export const FindingsReply = z.strictObject({
  findings: z.array(z.strictObject({
    text: z.string().min(1).max(300),
    type: z.enum(AI_FINDING_TYPES),
    severity: z.enum(["critical", "high", "medium", "low"]),
    reason: z.string().max(300),
  })).max(100),
});
export type FindingsReply = z.infer<typeof FindingsReply>;

export const PageFitReply = z.strictObject({
  expected: z.boolean(),
  neededTypes: z.array(FindingType).max(20),
});
export type PageFitReply = z.infer<typeof PageFitReply>;

// Hand-written JSON Schemas (structured outputs need additionalProperties:false + required).
export const FINDINGS_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["findings"],
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["text", "type", "severity", "reason"],
        properties: {
          text: { type: "string", description: "Exact text copied from the document, without placeholders" },
          type: { type: "string", enum: [...AI_FINDING_TYPES] },
          severity: { type: "string", enum: ["critical", "high", "medium", "low"] },
          reason: { type: "string" },
        },
      },
    },
  },
};

export const PAGE_FIT_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["expected", "neededTypes"],
  properties: {
    expected: { type: "boolean" },
    neededTypes: { type: "array", items: { type: "string", enum: [...FindingType.options] } },
  },
};
