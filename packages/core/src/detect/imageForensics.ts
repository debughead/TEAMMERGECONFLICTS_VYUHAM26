// Photo forensics: the image equivalent of the PDF fake-redaction checks (D-030).
// A painted bar in a flattened photo destroys the pixels under it only if it is fully opaque and
// fully covers the text. This finds drawn bars and checks both, plus QR codes (by their finder
// squares), which on ID cards usually encode the very details that were blacked out.
import type { Rect } from "../schemas.ts";

/** Luminance plane, possibly downsampled; `scale` maps plane coords back to image pixels. */
export interface LumPlane {
  w: number;
  h: number;
  data: Uint8Array;
  scale: number;
}

const MAX_ANALYSIS_SIDE = 1600;

/** RGB pixel buffer → luminance plane, downsampled so huge photos stay fast. */
export function lumPlane(rgb: Uint8Array | Uint8ClampedArray, width: number, height: number, stride: number, channels: number): LumPlane {
  const step = Math.max(1, Math.ceil(Math.max(width, height) / MAX_ANALYSIS_SIDE));
  const w = Math.floor(width / step);
  const h = Math.floor(height / step);
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * step * stride + x * step * channels;
      data[y * w + x] = Math.round(0.2126 * rgb[i]! + 0.7152 * rgb[i + 1]! + 0.0722 * rgb[i + 2]!);
    }
  }
  return { w, h, data, scale: step };
}

export interface BarCheck {
  /** In image pixels. */
  rect: Rect;
  /** Inside variation and brightness say content may be recoverable by boosting contrast. */
  translucent: boolean;
  /** Letter strokes are visible just past the bar's top or bottom edge. */
  partial: boolean;
  /** Area to paint to fully cover (bar grown to take in the leaking strokes). */
  coverRect: Rect;
}

/** Phone editors paint bars at or near pure black; translucent bars still read well below this. */
const BAR_DARK = 60;
/** A bar row is a near-black run at least this long (image pixels). */
const MIN_BAR_RUN = 50;
const MIN_BAR_ROWS = 8;
const MIN_ASPECT = 2.5;
/** Rows of one bar share left/right edges within this many plane pixels. */
const EDGE_JITTER = 4;
/** Opaque bars from phone editors measure ~0 variation; anything noticeably above is suspect. */
const TRANSLUCENT_SD = 4;
/** Lighter than this isn't a redaction bar at all. */
const MAX_BAR_MEAN = 45;
/** Bars over a line of text in a photo are at least this tall (image pixels). */
const MIN_BAR_HEIGHT = 12;
/** Brightness step between the bar and the area just beside it. */
const MIN_EDGE_STEP = 60;
const TRANSLUCENT_MEAN = 20;
/** Ink of cut-off letters (printed text is far darker than card backgrounds). */
const TAIL_DARK = 70;
/** Minimum share of a row that must be ink right at the bar's edge to count as leaking strokes. */
const LEAK_MIN = 0.12;

/**
 * Finds painted bars row by row: a bar is a stack of rows that each contain one long near-black run
 * with the same left and right edges. Letter tails touching the bar don't break this (unlike
 * flood-filling, which merges them into the shape).
 */
export function findBars(p: LumPlane): BarCheck[] {
  const { w, h, data } = p;
  const minRun = Math.max(8, Math.round(MIN_BAR_RUN / p.scale));
  type Open = { x0: number; x1: number; y0: number; y1: number; starts: number[]; ends: number[] };
  let open: Open[] = [];
  const done: Open[] = [];
  for (let y = 0; y < h; y++) {
    const runs: [number, number][] = [];
    let x = 0;
    while (x < w) {
      if (data[y * w + x]! >= BAR_DARK) { x++; continue; }
      const sx = x;
      while (x < w && data[y * w + x]! < BAR_DARK) x++;
      if (x - sx >= minRun) runs.push([sx, x - 1]);
    }
    const next: Open[] = [];
    for (const [a, b] of runs) {
      const hit = open.find((o) => Math.abs(o.x0 - a) <= EDGE_JITTER && Math.abs(o.x1 - b) <= EDGE_JITTER);
      if (hit) { hit.y1 = y; hit.x0 = Math.min(hit.x0, a); hit.x1 = Math.max(hit.x1, b); hit.starts.push(a); hit.ends.push(b); next.push(hit); }
      else next.push({ x0: a, x1: b, y0: y, y1: y, starts: [a], ends: [b] });
    }
    for (const o of open) if (!next.includes(o)) done.push(o);
    open = next;
  }
  done.push(...open);
  // Painted bars have straight vertical edges; skin, hair and shadows don't. Use median edges: a
  // row that merges with something dark beside the bar mustn't widen it.
  const straight = done
    .filter((o) => sd(o.starts) <= STRAIGHT_EDGE_SD && sd(o.ends) <= STRAIGHT_EDGE_SD)
    .map((o) => ({ ...o, x0: median(o.starts), x1: median(o.ends) }));
  // JPEG blur can split one bar into stacked pieces: merge pieces that touch and share their x-extent.
  straight.sort((a, b) => a.y0 - b.y0);
  const merged: Open[] = [];
  for (const o of straight) {
    // Only pieces of about the same width are one bar; a short run at its edge (letter tails, a
    // JPEG-split row) must not shrink it.
    const m = merged.find((k) => o.y0 - k.y1 <= 8 && overlapX(k, o) > 0.8 && similarWidth(k, o));
    if (m) { m.y1 = Math.max(m.y1, o.y1); m.x0 = Math.min(m.x0, o.x0); m.x1 = Math.max(m.x1, o.x1); }
    else merged.push({ ...o });
  }
  return merged
    .filter((o) => o.y1 - o.y0 + 1 >= Math.max(4, Math.round(MIN_BAR_ROWS / p.scale)) && (o.x1 - o.x0 + 1) / (o.y1 - o.y0 + 1) >= MIN_ASPECT)
    .map((o) => inspectBar(p, o.x0, o.y0, o.x1, o.y1))
    .filter((b): b is BarCheck => b !== null);
}

/** Max std-dev (plane px) of a bar's left/right edge positions across its rows. */
const STRAIGHT_EDGE_SD = 1.5;
const median = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)]!;
const sd = (v: number[]) => { const m = v.reduce((a, b) => a + b, 0) / v.length; return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length); };
const similarWidth = (a: { x0: number; x1: number }, b: { x0: number; x1: number }) => {
  const wa = a.x1 - a.x0 + 1, wb = b.x1 - b.x0 + 1;
  return Math.min(wa, wb) / Math.max(wa, wb) > 0.85;
};
const overlapX = (a: { x0: number; x1: number }, b: { x0: number; x1: number }) =>
  Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) + 1) / Math.min(a.x1 - a.x0 + 1, b.x1 - b.x0 + 1);

function inspectBar(p: LumPlane, x0: number, y0: number, x1: number, y1: number): BarCheck | null {
  const { w, h, data } = p;
  const at = (x: number, y: number) => data[y * w + x]!;
  const inset = 2;
  let sum = 0, sq = 0, n = 0;
  for (let y = y0 + inset; y <= y1 - inset; y++) for (let x = x0 + inset; x <= x1 - inset; x++) { const v = at(x, y); sum += v; sq += v * v; n++; }
  if (n === 0) return null;
  const mean = sum / n;
  const sd = Math.sqrt(Math.max(0, sq / n - mean * mean));
  // Shadows and dark backgrounds aren't uniform; a painted bar is (even a translucent one is smooth).
  if (sd > 25 || mean > MAX_BAR_MEAN || y1 - y0 + 1 < Math.round(MIN_BAR_HEIGHT / p.scale)) return null;
  // A painted bar stands out from what's beside it; a shadow or dark background doesn't.
  let ring = 0, rn = 0;
  for (let y = y0; y <= y1; y++) for (const x of [x0 - 4, x0 - 6, x1 + 4, x1 + 6]) if (x >= 0 && x < w) { ring += at(x, y); rn++; }
  if (rn === 0 || ring / rn - mean < MIN_EDGE_STEP) return null;

  // Leak test: letter strokes cut by the bar show up as a spike of very dark pixels right at the
  // edge, compared with the background a little further out (card patterns, shadows and label lines
  // further away don't spike at the edge).
  const width = x1 - x0 + 1;
  const darkFrac = (y: number) => {
    if (y < 0 || y >= h) return 0;
    let d = 0;
    for (let x = x0; x <= x1; x++) if (at(x, y) < TAIL_DARK) d++;
    return d / width;
  };
  const barH = y1 - y0 + 1;
  const edgeLeak = (edge: number, dir: 1 | -1): number => {
    let k = 1;
    while (k <= 2 && darkFrac(edge + dir * k) > 0.6) k++; // the bar's soft JPEG edge
    const near = Math.max(darkFrac(edge + dir * k), darkFrac(edge + dir * (k + 1)), darkFrac(edge + dir * (k + 2)));
    // Background sample starts beyond where cut-off tails can reach (about half a line).
    const farStart = k + Math.max(8, Math.round(barH * 0.5));
    const farRows = Array.from({ length: 6 }, (_, i) => darkFrac(edge + dir * (farStart + i)));
    const bg = farRows.reduce((a, b) => a + b, 0) / farRows.length;
    if (!(near >= LEAK_MIN && near >= bg * 3 + 0.1)) return 0;
    // Extent: rows still clearly above background, capped (tails are short).
    let r = k;
    while (r - k < barH * 0.6 && darkFrac(edge + dir * r) > bg + (near - bg) * 0.3) r++;
    return r + 1;
  };
  const below = edgeLeak(y1, 1), above = edgeLeak(y0, -1);
  const partial = below > 0 || above > 0;
  const translucent = sd > TRANSLUCENT_SD || mean > TRANSLUCENT_MEAN;
  const s = p.scale;
  return {
    rect: [x0 * s, y0 * s, (x1 + 1) * s, (y1 + 1) * s],
    translucent,
    partial,
    coverRect: [x0 * s, Math.max(0, y0 - (above ? above + 1 : 0)) * s, (x1 + 1) * s, Math.min(h, y1 + 1 + (below ? below + 1 : 0)) * s],
  };
}

// ---------- QR codes (finder pattern detection, no decoding) ----------

/** QR finder squares read 1:1:3:1:1 dark/light/dark/light/dark along any line through their centre. */
function finderRunsAt(runs: number[]): number | null {
  const total = runs.reduce((a, b) => a + b, 0);
  if (total < 7) return null;
  const m = total / 7;
  const tol = m * 0.7;
  const ok = Math.abs(runs[0]! - m) < tol && Math.abs(runs[1]! - m) < tol && Math.abs(runs[2]! - 3 * m) < tol * 3 && Math.abs(runs[3]! - m) < tol && Math.abs(runs[4]! - m) < tol;
  return ok ? m : null;
}

export interface QrRegion { rect: Rect; moduleSize: number }

export function findQrCodes(p: LumPlane): QrRegion[] {
  const { w, h, data } = p;
  const threshold = otsu(data);
  const dark = (x: number, y: number) => data[y * w + x]! < threshold;
  const centres: { x: number; y: number; m: number }[] = [];

  for (let y = 0; y < h; y += 1) {
    const runs: number[] = [];
    let cur = dark(0, y), len = 0, startX = 0;
    const starts: number[] = [];
    for (let x = 0; x <= w; x++) {
      const d = x < w ? dark(x, y) : !cur;
      if (d === cur) { len++; continue; }
      runs.push(len); starts.push(startX);
      startX = x; cur = d; len = 1;
      // Check the last five runs when they end on a dark run (dark-light-dark-light-dark).
      if (runs.length >= 5 && !d) {
        const five = runs.slice(-5);
        const m = finderRunsAt(five);
        if (m) {
          const cx = starts[starts.length - 3]! + five[2]! / 2;
          if (verticalFinder(p, Math.round(cx), y, threshold, m)) centres.push({ x: cx, y, m });
        }
      }
    }
  }
  const candidates = groupFinders(clusterCentres(centres), 1);
  return mergeOverlapping(candidates.map((c) => c.rect))
    .map((r) => trimToTexture(p, r, threshold))
    .filter((r): r is Rect => r !== null)
    .map((r) => ({ rect: r.map((v) => v * p.scale) as unknown as Rect, moduleSize: 0 }));
}

function mergeOverlapping(rects: Rect[]): Rect[] {
  const out: Rect[] = [];
  for (const r of rects) {
    const hit = out.findIndex((o) => r[0] < o[2] && o[0] < r[2] && r[1] < o[3] && o[1] < r[3]);
    if (hit >= 0) { const o = out[hit]!; out[hit] = [Math.min(o[0], r[0]), Math.min(o[1], r[1]), Math.max(o[2], r[2]), Math.max(o[3], r[3])]; }
    else out.push([...r]);
  }
  return out;
}

/**
 * QR modules make every row and column inside the code switch between dark and light very often;
 * text beside it switches only on some rows. Keep the longest dense run of columns and of rows.
 */
function trimToTexture(p: LumPlane, r: Rect, threshold: number): Rect | null {
  const { w, h, data } = p;
  const x0 = Math.max(0, Math.floor(r[0])), y0 = Math.max(0, Math.floor(r[1]));
  const x1 = Math.min(w - 1, Math.ceil(r[2])), y1 = Math.min(h - 1, Math.ceil(r[3]));
  if (x1 - x0 < 20 || y1 - y0 < 20) return null;
  const dark = (x: number, y: number) => data[y * w + x]! < threshold;
  const colDensity: number[] = [];
  for (let x = x0; x <= x1; x++) { let sw = 0; for (let y = y0 + 1; y <= y1; y++) if (dark(x, y) !== dark(x, y - 1)) sw++; colDensity.push(sw / (y1 - y0)); }
  const rowDensity: number[] = [];
  for (let y = y0; y <= y1; y++) { let sw = 0; for (let x = x0 + 1; x <= x1; x++) if (dark(x, y) !== dark(x - 1, y)) sw++; rowDensity.push(sw / (x1 - x0)); }
  // Longest dense run, tolerating short gaps (a column of light modules, glare).
  const span = (d: number[]) => {
    const cut = Math.max(...d) * 0.25;
    const GAP = 4;
    let best: [number, number] = [0, -1], start = -1, last = -1;
    d.forEach((v, i) => {
      if (v < cut) return;
      if (start < 0 || i - last > GAP) start = i;
      last = i;
      if (i - start > best[1] - best[0]) best = [start, i];
    });
    return best;
  };
  const [cx0, cx1] = span(colDensity), [cy0, cy1] = span(rowDensity);
  const tw = cx1 - cx0 + 1, th = cy1 - cy0 + 1;
  // A QR code is square; reject long thin texture (a line of text).
  if (tw < 20 || th < 20 || Math.max(tw, th) / Math.min(tw, th) > 1.4) return null;
  // QR codes are square: grow the shorter side (texture at an edge can be faint) to match the longer.
  const side = Math.max(tw, th);
  const gx = (side - tw) / 2, gy = (side - th) / 2;
  // Generous margin: an uncovered edge row of modules can still be enough to decode with error correction.
  const pad = Math.max(3, Math.round(side * 0.05));
  return [x0 + cx0 - gx - pad, y0 + cy0 - gy - pad, x0 + cx1 + 1 + gx + pad, y0 + cy1 + 1 + gy + pad];
}

function verticalFinder(p: LumPlane, x: number, y: number, threshold: number, m: number): boolean {
  const { w, h, data } = p;
  const dark = (yy: number) => data[yy * w + x]! < threshold;
  if (!dark(y)) return false;
  // Walk up/down from the centre collecting the 5 runs.
  const runLen = (start: number, dir: number, want: boolean, limit: number) => {
    let n = 0, yy = start;
    while (yy >= 0 && yy < h && dark(yy) === want && n < limit) { n++; yy += dir; }
    return { n, next: yy };
  };
  const lim = Math.ceil(m * 5);
  const up1 = runLen(y, -1, true, lim), up2 = runLen(up1.next, -1, false, lim), up3 = runLen(up2.next, -1, true, lim);
  const dn1 = runLen(y + 1, 1, true, lim), dn2 = runLen(dn1.next, 1, false, lim), dn3 = runLen(dn2.next, 1, true, lim);
  return finderRunsAt([up3.n, up2.n, up1.n + dn1.n, dn2.n, dn3.n]) !== null;
}

function clusterCentres(cs: { x: number; y: number; m: number }[]): { x: number; y: number; m: number }[] {
  const clusters: { x: number; y: number; m: number; n: number }[] = [];
  for (const c of cs) {
    const hit = clusters.find((k) => Math.abs(k.x - c.x) < k.m * 3 && Math.abs(k.y - c.y) < k.m * 3);
    if (hit) { hit.x = (hit.x * hit.n + c.x) / (hit.n + 1); hit.y = (hit.y * hit.n + c.y) / (hit.n + 1); hit.n++; }
    else clusters.push({ ...c, n: 1 });
  }
  // A real finder is confirmed on several scanlines.
  return clusters.filter((k) => k.n >= 2);
}

/** Three finders of similar size forming a right angle → one QR code. */
function groupFinders(fs: { x: number; y: number; m: number }[], scale: number): QrRegion[] {
  const used = new Set<number>();
  const out: QrRegion[] = [];
  for (let a = 0; a < fs.length; a++) for (let b = a + 1; b < fs.length; b++) for (let c = b + 1; c < fs.length; c++) {
    if (used.has(a) || used.has(b) || used.has(c)) continue;
    const tri = [fs[a]!, fs[b]!, fs[c]!];
    const ms = tri.map((t) => t.m);
    if (Math.max(...ms) / Math.min(...ms) > 1.6) continue;
    const d = (p: typeof tri[0], q: typeof tri[0]) => Math.hypot(p.x - q.x, p.y - q.y);
    const sides = [d(tri[0]!, tri[1]!), d(tri[1]!, tri[2]!), d(tri[0]!, tri[2]!)].sort((x, y) => x - y);
    // Right isosceles: two equal legs, hypotenuse ≈ leg·√2, legs at least ~14 modules apart.
    const m = ms.reduce((s, v) => s + v, 0) / 3;
    if (sides[0]! < m * 14 || Math.abs(sides[0]! - sides[1]!) > sides[1]! * 0.2 || Math.abs(sides[2]! - sides[1]! * Math.SQRT2) > sides[2]! * 0.15) continue;
    used.add(a); used.add(b); used.add(c);
    const xs = tri.map((t) => t.x), ys = tri.map((t) => t.y);
    // Finder centres sit 3.5 modules in from the code's edges; add a 1-module margin.
    const pad = 4.5 * m;
    out.push({
      rect: [(Math.min(...xs) - pad) * scale, (Math.min(...ys) - pad) * scale, (Math.max(...xs) + pad) * scale, (Math.max(...ys) + pad) * scale],
      moduleSize: m * scale,
    });
  }
  return out;
}

function otsu(data: Uint8Array): number {
  const hist = new Array<number>(256).fill(0);
  for (const v of data) hist[v]!++;
  const total = data.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i]!;
  let sumB = 0, wB = 0, best = 0, threshold = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]!;
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t]!;
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) { best = between; threshold = t; }
  }
  return threshold;
}

/** QR codes and leaking bars still visible in pixels (image-pixel rects), for verify(). */
export function pixelLeaks(p: LumPlane): Rect[] {
  return [...findQrCodes(p).map((q) => q.rect), ...findBars(p).filter((b) => b.partial || b.translucent).map((b) => b.rect)];
}
