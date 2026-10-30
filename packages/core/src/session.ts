// In-worker scan sessions. Raw values live here and nowhere else (CLAUDE.md product rules).
import type { AiLogEntry } from "./ai/run.ts";
import type { ComplianceReport } from "./compliance/schema.ts";
import type { FileType, Finding } from "./schemas.ts";

export interface Session {
  scanId: string;
  bytes: Uint8Array;
  fileType: FileType;
  findings: Finding[];
  /** Finding id → normalized raw values, used only by verify() to prove removal. */
  secrets: Map<string, string[]>;
  /** Finding id → values as written in the document, used to find and remove every copy. */
  raws: Map<string, string[]>;
  /** EXIF orientation of image input (1 for everything else). */
  orientation: number;
  /** Masked AI requests made during the scan (placeholders only). */
  aiLog: AiLogEntry[];
  /** What the company policy decided, when one was active (D-039). */
  compliance: ComplianceReport | null;
  createdAt: number;
}

export const SESSION_TTL_MS = 10 * 60 * 1000;
const sessions = new Map<string, Session>();

export function putSession(s: Session): void {
  sweep();
  sessions.set(s.scanId, s);
}

export function getSession(scanId: string): Session | undefined {
  sweep();
  return sessions.get(scanId);
}

export function dropSession(scanId: string): void {
  sessions.delete(scanId);
}

function sweep(now = Date.now()): void {
  for (const [id, s] of sessions) if (now - s.createdAt > SESSION_TTL_MS) sessions.delete(id);
}
