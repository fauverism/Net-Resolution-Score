/** Maps an NRS value (−100..100) to a y pixel, top = +100. */
export function yFor(value: number, top: number, bottom: number): number {
  const clamped = Math.max(-100, Math.min(100, value));
  return top + ((100 - clamped) / 200) * (bottom - top);
}

/** Evenly spaced x positions for `count` points between `left` and `right`. */
export function xFor(index: number, count: number, left: number, right: number): number {
  return count <= 1 ? (left + right) / 2 : left + (index / (count - 1)) * (right - left);
}

/**
 * Direct line labels: keeps each label near its line's last point but at least `gap`
 * pixels apart, within [top, bottom]. Order by y is preserved, so labels never cross.
 */
export function spreadLabels<K extends string>(
  labels: readonly { key: K; y: number }[],
  gap: number,
  top: number,
  bottom: number,
): { key: K; y: number }[] {
  const sorted = [...labels].sort((a, b) => a.y - b.y).map((l) => ({ ...l }));
  for (let i = 1; i < sorted.length; i++) {
    sorted[i]!.y = Math.max(sorted[i]!.y, sorted[i - 1]!.y + gap);
  }
  const overflow = (sorted.at(-1)?.y ?? bottom) - bottom;
  if (overflow > 0) {
    sorted[sorted.length - 1]!.y -= overflow;
    for (let i = sorted.length - 2; i >= 0; i--) {
      sorted[i]!.y = Math.min(sorted[i]!.y, sorted[i + 1]!.y - gap);
    }
  }
  for (const l of sorted) l.y = Math.max(top, l.y);
  return sorted;
}

/** An SVG path through the points, broken where a value is missing (no data that week). */
export function linePath(points: readonly ({ x: number; y: number } | null)[]): string {
  let d = '';
  let pen = false;
  for (const p of points) {
    if (!p) {
      pen = false;
      continue;
    }
    d += `${pen ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`;
    pen = true;
  }
  return d;
}
