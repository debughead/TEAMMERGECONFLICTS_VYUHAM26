import type { Rect } from "../schemas.ts";

export const area = (r: Rect): number => Math.max(0, r[2] - r[0]) * Math.max(0, r[3] - r[1]);

export function intersect(a: Rect, b: Rect): Rect | null {
  const r: Rect = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
  return r[2] > r[0] && r[3] > r[1] ? r : null;
}

/** Fraction of `inner` covered by `outer` (0..1). */
export function coverage(inner: Rect, outer: Rect): number {
  const a = area(inner);
  if (a === 0) return 0;
  const i = intersect(inner, outer);
  return i ? area(i) / a : 0;
}

export function union(rects: Rect[]): Rect {
  return rects.reduce<Rect>(
    (u, r) => [Math.min(u[0], r[0]), Math.min(u[1], r[1]), Math.max(u[2], r[2]), Math.max(u[3], r[3])],
    [Infinity, Infinity, -Infinity, -Infinity],
  );
}

export const center = (r: Rect): [number, number] => [(r[0] + r[2]) / 2, (r[1] + r[3]) / 2];

export const containsPoint = (r: Rect, [x, y]: [number, number]): boolean => x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3];

/** Axis-aligned bounds of a MuPDF quad (ul, ur, ll, lr as 8 numbers). */
export function quadBounds(q: readonly number[]): Rect {
  const xs = [q[0]!, q[2]!, q[4]!, q[6]!];
  const ys = [q[1]!, q[3]!, q[5]!, q[7]!];
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/**
 * Relative luminance (0 = black, 1 = white) from MuPDF colour components (0..1) by component count:
 * 1 = gray, 3 = RGB, 4 = CMYK. Unknown spaces are treated as not dark.
 */
export function luminance(components: readonly number[]): number {
  const [a = 1, b = 1, c = 1, d = 0] = components;
  switch (components.length) {
    case 1: return a;
    case 3: return 0.2126 * a + 0.7152 * b + 0.0722 * c;
    case 4: {
      const [r, g, bl] = [(1 - a) * (1 - d), (1 - b) * (1 - d), (1 - c) * (1 - d)];
      return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
    }
    default: return 1;
  }
}
