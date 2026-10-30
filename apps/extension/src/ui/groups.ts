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

/**
 * Label and value as a row shows them. File properties arrive as "Author: A***r"; the property name is
 * the label ("Author"), not the generic "File property".
 */
export function displayOf(f: Finding): { label: string; value: string } {
  const m = f.type === "metadata" || f.type === "other" ? /^([^:]{1,40}): (.+)$/.exec(f.masked) : null;
  return m ? { label: m[1]!, value: m[2]! } : { label: labelOf(f), value: f.masked };
}
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

/**
 * One row per distinct value: a statement prints the same UPI ID, card or phone number in several
 * places, and each is its own finding (so each copy can be kept or removed). The list shows the value
 * once; ticking the row selects every copy.
 */
export interface Row {
  key: string;
  ids: string[];
  /** Representative finding (all share type, source and masked value). */
  f: Finding;
  pages: number[];
}

export function rowsOf(r: ScanResult, group: GroupId): Row[] {
  const rows = new Map<string, Row>();
  for (const f of listable(r)) {
    if (groupOf(f) !== group) continue;
    const key = `${f.type}|${f.source}|${f.masked}|${f.redactable}`;
    const row = rows.get(key);
    if (!row) rows.set(key, { key, ids: [f.id], f, pages: f.page === null ? [] : [f.page] });
    else {
      row.ids.push(f.id);
      if (f.page !== null && !row.pages.includes(f.page)) row.pages.push(f.page);
    }
  }
  return [...rows.values()];
}

export const allRows = (r: ScanResult): Row[] => GROUPS.flatMap((g) => rowsOf(r, g.id));

export function rowState(row: Row, selected: Set<string>): "on" | "off" | "mixed" {
  const n = row.ids.filter((id) => selected.has(id)).length;
  return n === 0 ? "off" : n === row.ids.length ? "on" : "mixed";
}

/** Selects or clears every copy in the row; returns a new set. */
export function toggleRow(row: Row, selected: Set<string>): Set<string> {
  const next = new Set(selected);
  const on = rowState(row, selected) !== "on";
  for (const id of row.ids) on ? next.add(id) : next.delete(id);
  return next;
}

/** Reasons that only restate the row's label; only real explanations are shown. */
const BOILERPLATE = /(is visible in the document|is readable in the image|is stored in the file's metadata|tag is stored in its metadata)$/;

/** The row's second line: only what helps the decision (why it's risky, where, whether the page needs it). */
export function rowNote(r: ScanResult, row: Row): string | null {
  // Whether the page needs it is said once, in the verdict ("left unticked"), not on every row.
  const bits: string[] = [];
  const reason = row.f.reason.replace(/ \(\d+ places on this page\)$/, "");
  if (!BOILERPLATE.test(reason)) bits.push(reason);
  if (row.ids.length > 1) bits.push(`appears ${row.ids.length} times`);
  if (r.pageCount > 1 && row.pages.length) bits.push(`page${row.pages.length > 1 ? "s" : ""} ${row.pages.map((p) => p + 1).join(", ")}`);
  if (!row.f.redactable) bits.push("can't be removed from this file type here");
  if (!bits.length) return null;
  const text = bits.join("; ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The receipt line: what the site will get after the selected rows are removed, and how many rows go. */
export function receipt(r: ScanResult, selected: Set<string>): { keeps: string[]; removed: number } {
  const rows = allRows(r);
  const keeps = [...new Set(rows.filter((row) => rowState(row, selected) !== "on" && groupOf(row.f) !== "file").map((row) => inSentence(labelOf(row.f))))];
  return { keeps, removed: rows.filter((row) => rowState(row, selected) === "on").length };
}

/** The one name for the main action, everywhere it appears. */
export const actionLabel = (removed: number) => `Remove ${removed} and upload`;

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
