// Picks only the lines that need context and replaces every known value with a typed placeholder
// (docs/HLD.md §3.5.4–5). Anything that still looks like an identifier is masked too, so a value
// the local detectors missed doesn't reach the API in clear.
import { findLocalEntities } from "../detect/localNer.ts";
import { findIds } from "../detect/patterns.ts";
import type { TextLayer } from "../extract/textLayer.ts";

export interface SelectedLine {
  layer: number;
  /** Offset of the line within its layer's text. */
  start: number;
  /** Raw line, worker-internal only. */
  original: string;
  masked: string;
}

const CONTEXT_KEYWORDS = /diagnos|prescri|medical|patient|treatment|condition|illness|disease|hospital|clinic|doctor|dr\.|salary|ctc|net pay|gross|income|compensation|bonus|account|a\/c|balance|loan|emi|insurance|policy|beneficiary|nominee|guardian|father|mother|spouse/i;
/** Digit runs that survive masking (unknown IDs, reference numbers) are masked as numbers. */
const LONG_NUMBER = /\d[\d ./-]{4,}\d/g;
const MAX_LINES = 200;
const MAX_CHUNK_CHARS = 8000;

export class Placeholders {
  private byValue = new Map<string, string>();
  private counts = new Map<string, number>();
  for(type: string, value: string): string {
    const key = `${type}\u0000${value}`;
    let p = this.byValue.get(key);
    if (!p) {
      const n = (this.counts.get(type) ?? 0) + 1;
      this.counts.set(type, n);
      p = `[${type.toUpperCase()}_${n}]`;
      this.byValue.set(key, p);
    }
    return p;
  }
}

export function maskLine(line: string, ph: Placeholders): string {
  const spans = [
    ...findIds(line).map((m) => ({ start: m.start, end: m.end, type: m.type, value: m.normalized })),
    ...findLocalEntities(line).filter((e) => e.type === "name" || e.type === "address")
      .map((e) => ({ start: e.start, end: e.end, type: e.type, value: e.raw })),
  ].sort((a, b) => a.start - b.start || b.end - a.end);
  let out = "";
  let pos = 0;
  for (const s of spans) {
    if (s.start < pos) continue; // overlapping span already masked
    out += line.slice(pos, s.start) + ph.for(s.type, s.value);
    pos = s.end;
  }
  out += line.slice(pos);
  return out.replace(LONG_NUMBER, (m) => ph.for("number", m));
}

export function selectLines(layers: TextLayer[], ph: Placeholders): SelectedLine[] {
  const out: SelectedLine[] = [];
  for (const layer of layers) {
    let start = 0;
    for (const line of layer.text.split("\n")) {
      const lineStart = start;
      start += line.length + 1;
      if (!line.trim()) continue;
      const lowConfidence = findLocalEntities(line).some((e) => e.needsContext);
      if (!lowConfidence && !CONTEXT_KEYWORDS.test(line)) continue;
      out.push({ layer: layer.index, start: lineStart, original: line, masked: maskLine(line, ph) });
      if (out.length >= MAX_LINES) return out;
    }
  }
  return out;
}

/** Groups lines into chunks that fit one request. Line numbers are global so replies map back. */
export function chunkLines(lines: SelectedLine[]): { from: number; lines: SelectedLine[] }[] {
  const chunks: { from: number; lines: SelectedLine[] }[] = [];
  let cur: SelectedLine[] = [];
  let size = 0;
  let from = 0;
  lines.forEach((l, i) => {
    if (cur.length && size + l.masked.length > MAX_CHUNK_CHARS) {
      chunks.push({ from, lines: cur });
      cur = [];
      size = 0;
      from = i;
    }
    cur.push(l);
    size += l.masked.length + 8;
  });
  if (cur.length) chunks.push({ from, lines: cur });
  return chunks;
}
