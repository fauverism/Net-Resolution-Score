/** Small seeded PRNG (mulberry32) with helpers. Same seed → same sequence. */
export interface Rng {
  next(): number;
  int(min: number, max: number): number;
  float(min: number, max: number): number;
  chance(p: number): boolean;
  pick<T>(items: readonly T[]): T;
  weighted<K extends string>(weights: Readonly<Record<K, number>>): K;
  normal(mean: number, sd: number): number;
}

export function createRng(seed: number): Rng {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const rng: Rng = {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    float: (min, max) => min + next() * (max - min),
    chance: (p) => next() < p,
    pick(items) {
      if (items.length === 0) throw new Error('pick() from empty list');
      return items[Math.floor(next() * items.length)] as (typeof items)[number];
    },
    weighted(weights) {
      const entries = Object.entries(weights) as [keyof typeof weights, number][];
      const total = entries.reduce((s, [, w]) => s + w, 0);
      let r = next() * total;
      for (const [k, w] of entries) {
        r -= w;
        if (r < 0) return k;
      }
      return entries[entries.length - 1]![0];
    },
    normal(mean, sd) {
      // Box–Muller
      const u = 1 - next();
      const v = next();
      return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    },
  };
  return rng;
}
