import { z } from 'zod';
import type { GroundTruthLabel } from './groundTruth.ts';
import { enforceCategory } from './scorerRules.ts';
import {
  CategorySchema,
  ChannelSchema,
  CHANNELS,
  ResolvedSchema,
  type Category,
  type Channel,
  type Resolved,
} from './schemas.ts';

/** The fields an eval checks: what the scorer should conclude from one transcript. */
export const EvalExpectedSchema = z
  .object({
    category: CategorySchema,
    resolved: ResolvedSchema,
    /** 1–3; separates passive from promoter, so a category miss can be traced to it. */
    effort: z.number().int().min(1).max(3),
    asked_for_human: z.boolean(),
    abandoned: z.boolean(),
  })
  .strict();
export type EvalExpected = z.infer<typeof EvalExpectedSchema>;

/** One line of a hand-labeled golden set (evals/golden/*.jsonl). */
export const GoldenCaseSchema = z
  .object({
    id: z.string().min(1),
    channel: ChannelSchema,
    /** Raw transcript; redacted before it is ever sent anywhere. */
    transcript: z.string().min(1),
    expected: EvalExpectedSchema,
    notes: z.string().optional(),
  })
  .strict();
export type GoldenCase = z.infer<typeof GoldenCaseSchema>;

/**
 * What a scorer following the prompt should output for a seeded transcript. The scorer
 * sees one transcript, so this is judged on what that transcript shows, not on what
 * happened later: an agent's claim the customer only acknowledged ("ok thanks") is
 * "partial", and the category is the highest the facts allow (categoryCap, via
 * enforceCategory), so a return contact can still be a promoter here (linking caps it).
 */
export function expectedFromGroundTruth(l: GroundTruthLabel): EvalExpected {
  const resolved: Resolved = l.falseResolution ? 'partial' : l.resolved ? 'yes' : 'no';
  const facts = {
    resolved,
    effort: l.effort,
    asked_for_human: l.escalated,
    abandoned: l.abandoned,
  };
  const { category } = enforceCategory({
    ...facts,
    category: 'promoter',
    channel: l.channel,
    customer_goal: l.goal,
    sentiment_start: 0,
    sentiment_end: 0,
    evidence: 'n/a',
  });
  return {
    category,
    resolved,
    effort: l.effort,
    asked_for_human: l.escalated,
    abandoned: l.abandoned,
  };
}

export interface EvalObservation {
  id: string;
  channel: Channel;
  expected: EvalExpected;
  /** Null when scoring failed (invalid output twice, refusal, API errors). */
  actual: EvalExpected | null;
}

const RANK: Record<Category, number> = { detractor: 0, passive: 1, promoter: 2 };

/** Fraction correct, 3 decimals; null for no cases. A failed score counts as wrong. */
function accuracy(
  obs: readonly EvalObservation[],
  right: (o: EvalObservation) => boolean,
): number | null {
  if (obs.length === 0) return null;
  return (
    Math.round((obs.filter((o) => o.actual !== null && right(o)).length / obs.length) * 1000) / 1000
  );
}

export type ConfusionMatrix = Record<Category, Record<Category | 'failed', number>>;

/** Rows: expected category. Columns: the scorer's category, or "failed". */
export function confusionMatrix(obs: readonly EvalObservation[]): ConfusionMatrix {
  const cats = CategorySchema.options;
  const m = Object.fromEntries(
    cats.map((e) => [e, Object.fromEntries([...cats, 'failed'].map((a) => [a, 0]))]),
  ) as ConfusionMatrix;
  for (const o of obs) m[o.expected.category][o.actual?.category ?? 'failed']++;
  return m;
}

export const EvalMetricsSchema = z.object({
  n: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  categoryAccuracy: z.number().nullable(),
  fieldAccuracy: z.object({
    resolved: z.number().nullable(),
    effort: z.number().nullable(),
    asked_for_human: z.number().nullable(),
    abandoned: z.number().nullable(),
  }),
  /** Share scored HIGHER than expected: the error CLAUDE.md cares about most. */
  inflationRate: z.number().nullable(),
  byChannel: z.record(
    ChannelSchema,
    z.object({ n: z.number().int().nonnegative(), categoryAccuracy: z.number().nullable() }),
  ),
  confusion: z.record(CategorySchema, z.record(z.string(), z.number().int())),
});
export type EvalMetrics = z.infer<typeof EvalMetricsSchema>;

export function evalMetrics(obs: readonly EvalObservation[]): EvalMetrics {
  const inflated = obs.filter(
    (o) => o.actual && RANK[o.actual.category] > RANK[o.expected.category],
  );
  return {
    n: obs.length,
    failed: obs.filter((o) => o.actual === null).length,
    categoryAccuracy: accuracy(obs, (o) => o.actual!.category === o.expected.category),
    fieldAccuracy: {
      resolved: accuracy(obs, (o) => o.actual!.resolved === o.expected.resolved),
      effort: accuracy(obs, (o) => o.actual!.effort === o.expected.effort),
      asked_for_human: accuracy(
        obs,
        (o) => o.actual!.asked_for_human === o.expected.asked_for_human,
      ),
      abandoned: accuracy(obs, (o) => o.actual!.abandoned === o.expected.abandoned),
    },
    inflationRate: obs.length ? Math.round((inflated.length / obs.length) * 1000) / 1000 : null,
    byChannel: Object.fromEntries(
      CHANNELS.map((c) => {
        const mine = obs.filter((o) => o.channel === c);
        return [
          c,
          {
            n: mine.length,
            categoryAccuracy: accuracy(mine, (o) => o.actual!.category === o.expected.category),
          },
        ];
      }),
    ) as EvalMetrics['byChannel'],
    confusion: confusionMatrix(obs),
  };
}

/** FNV-1a: a small, stable string hash for deterministic sampling. */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/**
 * Deterministic stratified sample of `size` items: proportional per stratum (e.g.
 * channel × expected category), but at least `minPerStratum` (or the whole stratum) so
 * rare classes are always tested. Same items for the same inputs and salt.
 */
export function stratifiedSample<T>(
  items: readonly T[],
  size: number,
  stratum: (t: T) => string,
  id: (t: T) => string,
  { salt = 'nrs-eval', minPerStratum = 5 } = {},
): T[] {
  if (size >= items.length) return [...items];
  const strata = [...Map.groupBy(items, stratum)].sort(([a], [b]) => a.localeCompare(b));
  const picked: T[] = [];
  for (const [, group] of strata) {
    const ordered = [...group].sort((a, b) => fnv1a(salt + id(a)) - fnv1a(salt + id(b)));
    const share = Math.round((group.length / items.length) * size);
    picked.push(...ordered.slice(0, Math.max(share, Math.min(minPerStratum, group.length))));
  }
  return picked.sort((a, b) => id(a).localeCompare(id(b)));
}
