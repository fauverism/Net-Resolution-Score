import type { Category, Effort, ScoreBreakdown } from './schemas.ts';

/** The observable facts that decide an interaction's category. */
export interface OutcomeFacts {
  resolved: boolean;
  /** False when this contact is a repeat about a goal the customer already raised. */
  firstContact: boolean;
  effort: Effort;
  escalated: boolean;
  abandoned: boolean;
  /** Customer came back about the same goal within the return window. */
  returnedWithinWindow: boolean;
}

/**
 * Canonical NRS categorization (see CLAUDE.md).
 * Promoter needs a first-try resolution AND effort 1. A resolved repeat contact is at most
 * passive, never promoter: when the rules don't clearly say promoter, pick the lower category.
 */
export function categorize(f: OutcomeFacts): Category {
  if (!f.resolved || f.escalated || f.abandoned || f.returnedWithinWindow) return 'detractor';
  if (f.firstContact && f.effort === 1) return 'promoter';
  return 'passive';
}

/** True when `later` falls within `windowDays` after `earlier` (inclusive, strictly after). */
export function isWithinReturnWindow(earlier: Date, later: Date, windowDays: number): boolean {
  const deltaMs = later.getTime() - earlier.getTime();
  return deltaMs > 0 && deltaMs <= windowDays * 86_400_000;
}

/** NRS = %promoters − %detractors, from −100 to +100. Null for an empty slice. */
export function breakdown(categories: readonly Category[]): ScoreBreakdown {
  let promoters = 0;
  let passives = 0;
  let detractors = 0;
  for (const c of categories) {
    if (c === 'promoter') promoters++;
    else if (c === 'passive') passives++;
    else detractors++;
  }
  const total = categories.length;
  const nrs = total === 0 ? null : ((promoters - detractors) / total) * 100;
  return { total, promoters, passives, detractors, nrs };
}
