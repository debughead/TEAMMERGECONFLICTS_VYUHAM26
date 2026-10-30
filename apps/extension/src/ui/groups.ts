// How findings are grouped and pre-selected, shared by the in-page card and the side panel.
import type { Finding, ScanResult } from "@redactguard/core/schemas";

export type GroupId = "hidden" | "ids" | "personal" | "file";

export const GROUPS: { id: GroupId; title: string; why: string }[] = [
  { id: "hidden", title: "Hidden data", why: "Looks removed or invisible, but anyone can copy it out" },
  { id: "ids", title: "ID numbers", why: "Can be used to open accounts or verify as you" },
  { id: "personal", title: "Personal details", why: "Identifies you or reveals private information" },
  { id: "file", title: "Location and file details", why: "Where the file was made, by whom, and with what" },
];

const HIDDEN_SOURCES = new Set(["under_black_box", "black_highlight", "unapplied_annot", "old_version", "hidden_office"]);
const ID_TYPES = new Set(["aadhaar", "pan", "card", "account", "ifsc", "upi", "vehicle"]);

export function groupOf(f: Finding): GroupId {
  if (HIDDEN_SOURCES.has(f.source) || f.type === "hidden_content" || f.type === "old_version") return "hidden";
  if (f.type === "gps" || f.type === "metadata") return "file";
  if (ID_TYPES.has(f.type)) return "ids";
  return "personal";
}

const LABEL: Record<string, string> = {
  aadhaar: "Aadhaar number", pan: "PAN", card: "Card number", account: "Bank account", ifsc: "IFSC code", upi: "UPI ID",
  vehicle: "Vehicle number", phone: "Phone number", email: "Email", name: "Name", address: "Address", medical: "Medical detail",
  salary: "Salary", gps: "GPS location", metadata: "File property", hidden_content: "Hidden text", old_version: "Earlier version", other: "Detail",
};
export const labelOf = (f: Finding) => LABEL[f.type] ?? f.type;
/** Mid-sentence form: lower-case except proper nouns and acronyms ("Aadhaar", "PAN", "IFSC", "UPI"). */
export const inSentence = (label: string) => (/^(Aadhaar|PAN|IFSC|UPI|GPS)/.test(label) ? label : label.charAt(0).toLowerCase() + label.slice(1));

/** Items the checklist shows: the identity-kit summary is a warning, not something to tick. */
export const listable = (r: ScanResult) => r.findings.filter((f) => f.type !== "identity_kit");

/** Pre-selection: everything the page doesn't need, plus anything never legitimate to share. */
export function defaultSelection(r: ScanResult): Set<string> {
  const needed = new Set(r.context?.neededTypes ?? []);
  return new Set(listable(r).filter((f) => f.redactable && (f.autoCleanable || !needed.has(f.type))).map((f) => f.id));
}

export const isNeeded = (r: ScanResult, f: Finding) => (r.context?.neededTypes ?? []).includes(f.type) && !f.autoCleanable;

/** The receipt line: what the site will get after the selected items are removed. */
export function receipt(r: ScanResult, selected: Set<string>): { keeps: string[]; removed: number } {
  const keeps = [...new Set(listable(r).filter((f) => !selected.has(f.id) && groupOf(f) !== "file").map((f) => inSentence(labelOf(f))))];
  return { keeps, removed: [...selected].length };
}

export const identityKit = (r: ScanResult) => r.findings.find((f) => f.type === "identity_kit") ?? null;
/** "name + Aadhaar + address" → "Your name, Aadhaar and address are". */
export function kitSentence(masked: string): string {
  const parts = masked.split(" + ").map(inSentence);
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0] ?? "";
  return `Together, your ${list} are enough to attempt identity fraud.`;
}

export const VERDICT_COPY = {
  block: { title: "Don't upload this file as it is", tone: "stop" },
  warn: { title: "This file shares more than this page needs", tone: "caution" },
  allow: { title: "Safe to upload", tone: "clear" },
} as const;
