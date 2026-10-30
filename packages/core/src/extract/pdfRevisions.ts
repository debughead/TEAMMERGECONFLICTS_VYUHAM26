// Old-version leak: recover text from earlier incremental revisions (docs/HLD.md §3.4, D-011).
// countVersions() says whether earlier revisions exist; to read them we cut the file at each
// earlier %%EOF and open the prefix. Linearized files also have two %%EOF markers, so a revision
// is only reported when its text actually differs.
import * as mupdf from "mupdf";

export interface Revision {
  /** 1 = oldest. */
  number: number;
  /** Text per page index. */
  pages: string[];
}

export function earlierRevisions(bytes: Uint8Array, versions: number): Revision[] {
  if (versions < 2) return [];
  const out: Revision[] = [];
  const ends = eofOffsets(bytes);
  for (const end of ends.slice(0, -1)) {
    let doc: mupdf.Document | null = null;
    try {
      doc = mupdf.Document.openDocument(bytes.subarray(0, end), "application/pdf");
      const pages: string[] = [];
      for (let i = 0; i < doc.countPages(); i++) pages.push(doc.loadPage(i).toStructuredText("preserve-whitespace").asText());
      out.push({ number: out.length + 1, pages });
    } catch {
      // A prefix that doesn't open (e.g. the first half of a linearized file) carries no readable revision.
    }
  }
  return out;
}

/** Byte offsets just past each "%%EOF" marker (and its line ending). */
function eofOffsets(b: Uint8Array): number[] {
  const out: number[] = [];
  const marker = [0x25, 0x25, 0x45, 0x4f, 0x46];
  for (let i = 0; i + marker.length <= b.length; i++) {
    if (marker.every((m, k) => b[i + k] === m)) {
      let end = i + marker.length;
      if (b[end] === 0x0d) end++;
      if (b[end] === 0x0a) end++;
      out.push(end);
    }
  }
  return out;
}

const tokens = (s: string) => s.split(/\s+/).filter(Boolean);

/** Words present in `older` but missing from `current` (multiset difference), in original order. */
export function removedText(older: string, current: string): string {
  const counts = new Map<string, number>();
  for (const t of tokens(current)) counts.set(t, (counts.get(t) ?? 0) + 1);
  const removed: string[] = [];
  for (const t of tokens(older)) {
    const n = counts.get(t) ?? 0;
    if (n > 0) counts.set(t, n - 1);
    else removed.push(t);
  }
  return removed.join(" ");
}
