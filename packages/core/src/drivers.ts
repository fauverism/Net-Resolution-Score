import { z } from 'zod';
import { round1, sampleSizeWarning, LOW_CONFIDENCE } from './report.ts';
import { CHANNELS, ChannelSchema, type Channel, type Resolved } from './schemas.ts';

// ───────────── inputs ─────────────

/** One final-category detractor that has a scorer output to cluster on. */
export interface DriverInput {
  interactionId: string;
  channel: Channel;
  businessLine: string;
  customerGoal: string;
  /** Customer quote from the scorer (already redacted). */
  evidence: string;
  /** The quote was found in a customer turn of the transcript. */
  evidenceVerified: boolean;
  resolved: Resolved;
  abandoned: boolean;
  falseResolution: boolean;
}

export type Severity = 1 | 2 | 3;

/**
 * unresolved/abandoned (3) > false resolution (2) > high effort (1).
 * Every other detractor (escalated after a resolution, high effort) weighs 1, so it still counts.
 */
export function detractorSeverity(
  d: Pick<DriverInput, 'resolved' | 'abandoned' | 'falseResolution'>,
): Severity {
  if (d.resolved === 'no' || d.abandoned) return 3;
  if (d.falseResolution) return 2;
  return 1;
}

/** Case- and space-insensitive key, so identical goals are clustered once. */
export function normalizeGoal(goal: string): string {
  return goal.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Distinct goals in first-seen order, in batches of at most `size`. */
export function batchGoals(goals: readonly string[], size = 50): string[][] {
  if (size < 1) throw new Error('batch size must be at least 1');
  const firstSeen = new Map<string, string>();
  for (const g of goals)
    if (!firstSeen.has(normalizeGoal(g))) firstSeen.set(normalizeGoal(g), g.trim());
  const distinct = [...firstSeen.values()];
  const batches: string[][] = [];
  for (let i = 0; i < distinct.length; i += size) batches.push(distinct.slice(i, i + size));
  return batches;
}

// ───────────── ranking ─────────────

export const ChannelShareSchema = z.object({
  n: z.number().int().nonnegative(),
  pct: z.number().min(0).max(100),
});

export const RankedClusterSchema = z.object({
  label: z.string(),
  volume: z.number().int().positive(),
  /** volume × mean severity (= sum of member severities). */
  score: z.number().nonnegative(),
  meanSeverity: z.number().min(1).max(3),
  /** Share of all detractors in the period, 1 decimal. */
  pctOfDetractors: z.number().min(0).max(100),
  severityMix: z.object({
    unresolvedOrAbandoned: z.number().int(),
    falseResolution: z.number().int(),
    highEffort: z.number().int(),
  }),
  channelMix: z.record(ChannelSchema, ChannelShareSchema),
  businessLines: z.record(z.string(), z.number().int()),
  representative: z.object({ interactionId: z.string(), quote: z.string() }).nullable(),
  warning: z.literal(LOW_CONFIDENCE).nullable(),
  interactionIds: z.array(z.string()),
});
export type RankedCluster = z.infer<typeof RankedClusterSchema>;

/**
 * The most telling quote: one verified in a customer turn first (never a quote the scorer
 * may have invented), then from the most severe member, then the earliest interaction.
 */
export function pickRepresentative(
  members: readonly DriverInput[],
): RankedCluster['representative'] {
  const best = [...members].sort(
    (a, b) =>
      Number(b.evidenceVerified) - Number(a.evidenceVerified) ||
      detractorSeverity(b) - detractorSeverity(a) ||
      a.interactionId.localeCompare(b.interactionId),
  )[0];
  return best ? { interactionId: best.interactionId, quote: best.evidence } : null;
}

/**
 * Groups detractors by their goal's cluster label and ranks by volume × severity
 * (ties: volume, then label). `totalDetractors` includes detractors that couldn't be
 * clustered, so percentages are of all detractors in the period.
 */
export function rankClusters(
  detractors: readonly DriverInput[],
  labelForGoal: (goal: string) => string,
  totalDetractors: number,
): RankedCluster[] {
  const groups = Map.groupBy(detractors, (d) => labelForGoal(d.customerGoal));
  const clusters = [...groups].map(([label, members]): RankedCluster => {
    const severities = members.map(detractorSeverity);
    const score = severities.reduce<number>((s, v) => s + v, 0);
    const channelMix = Object.fromEntries(
      CHANNELS.map((c) => {
        const n = members.filter((m) => m.channel === c).length;
        return [c, { n, pct: round1((n / members.length) * 100) }];
      }),
    ) as Record<Channel, { n: number; pct: number }>;
    const businessLines: Record<string, number> = {};
    for (const m of members)
      businessLines[m.businessLine] = (businessLines[m.businessLine] ?? 0) + 1;
    return {
      label,
      volume: members.length,
      score,
      meanSeverity: round1(score / members.length),
      pctOfDetractors: totalDetractors === 0 ? 0 : round1((members.length / totalDetractors) * 100),
      severityMix: {
        unresolvedOrAbandoned: severities.filter((s) => s === 3).length,
        falseResolution: severities.filter((s) => s === 2).length,
        highEffort: severities.filter((s) => s === 1).length,
      },
      channelMix,
      businessLines,
      representative: pickRepresentative(members),
      warning: sampleSizeWarning(members.length),
      interactionIds: members.map((m) => m.interactionId).sort(),
    };
  });
  return clusters.sort(
    (a, b) => b.score - a.score || b.volume - a.volume || a.label.localeCompare(b.label),
  );
}

// ───────────── report ─────────────

export const AI_SUGGESTED = 'AI-suggested';

const AiSuggested = <T extends z.ZodType>(value: T) =>
  z.object({
    value,
    /** Always "AI-suggested": a starting point for a human, not a decision. */
    source: z.literal(AI_SUGGESTED),
  });

/** Keeps interactionIds so the dashboard can drill into a driver's conversations. */
export const DriverSchema = RankedClusterSchema.extend({
  rank: z.number().int().positive(),
  /** Plain-language description of what is driving these detractors. */
  driver: z.string(),
  /** Null when the suggestion call failed; the driver itself still stands. */
  suggestedFix: AiSuggested(z.string()).nullable(),
  suggestedOwner: AiSuggested(z.string()).nullable(),
});
export type Driver = z.infer<typeof DriverSchema>;

export const DriversReportSchema = z.object({
  version: z.literal(1),
  periodStart: z.iso.datetime({ offset: true }),
  periodEnd: z.iso.datetime({ offset: true }),
  source: z.object({
    model: z.string(),
    scorerPromptVersion: z.string(),
    clusterPromptVersion: z.string(),
    suggestPromptVersion: z.string(),
  }),
  counts: z.object({
    /** Final-category detractors in the period (after reclassifications). */
    detractors: z.number().int().nonnegative(),
    clustered: z.number().int().nonnegative(),
    /** Failed scores counted as detractors: no goal to cluster on. */
    unclusterable: z.number().int().nonnegative(),
    /** Detractors whose goals couldn't be labeled (the clustering call failed twice). */
    labelingFailed: z.number().int().nonnegative(),
    clusters: z.number().int().nonnegative(),
  }),
  top: z.array(DriverSchema).max(3),
  /** Every other cluster, ranked, for transparency. */
  others: z.array(
    RankedClusterSchema.pick({ label: true, volume: true, score: true, pctOfDetractors: true }),
  ),
});
export type DriversReport = z.infer<typeof DriversReportSchema>;
