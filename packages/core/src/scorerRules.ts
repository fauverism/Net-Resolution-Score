import type { Category, CategoryOverride, ScorerOutput } from './schemas.ts';

const RANK: Record<Category, number> = { detractor: 0, passive: 1, promoter: 2 };

/** The lower of two categories. */
export function lowerCategory(a: Category, b: Category): Category {
  return RANK[a] <= RANK[b] ? a : b;
}

type CapFacts = Pick<ScorerOutput, 'resolved' | 'effort' | 'asked_for_human' | 'abandoned'>;

/**
 * The highest category the scorer's own facts allow, with the reasons for any cap.
 * - Detractor: not resolved, asked for a human (escalated), or abandoned.
 * - Passive at most: resolution not confirmed ("partial"), or effort 2–3.
 */
export function categoryCap(f: CapFacts): { cap: Category; reasons: string[] } {
  const hard = [
    f.resolved === 'no' && 'resolved=no',
    f.asked_for_human && 'asked_for_human',
    f.abandoned && 'abandoned',
  ].filter((r): r is string => Boolean(r));
  if (hard.length) return { cap: 'detractor', reasons: hard };

  const soft = [
    f.resolved === 'partial' && 'resolved=partial',
    f.effort >= 2 && `effort=${f.effort}`,
  ].filter((r): r is string => Boolean(r));
  if (soft.length) return { cap: 'passive', reasons: soft };
  return { cap: 'promoter', reasons: [] };
}

/**
 * Makes the category consistent with the scorer's own facts. Only ever lowers: a
 * scorer that picked a lower category than its facts allow keeps it (never inflate).
 */
export function enforceCategory(o: ScorerOutput): {
  category: Category;
  override: CategoryOverride | null;
} {
  const { cap, reasons } = categoryCap(o);
  const category = lowerCategory(o.category, cap);
  return {
    category,
    override: category === o.category ? null : { from: o.category, to: category, reasons },
  };
}
