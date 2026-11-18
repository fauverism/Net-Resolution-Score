import { z } from 'zod';
import {
  CategorySchema,
  ChannelSchema,
  CHANNELS,
  type Category,
  type Channel,
  type ScoreRecord,
} from './schemas.ts';

// ───────────── schemas ─────────────

export const MIN_SAMPLE = 30;
export const LOW_CONFIDENCE = 'low confidence';
const Warning = z.literal(LOW_CONFIDENCE).nullable();
const IsoDateTime = z.iso.datetime({ offset: true });

/** One row of the reclassifications table (the audit trail; score rows are never edited). */
export const ReclassificationSchema = z.object({
  id: z.number().int(),
  interactionId: z.string(),
  fromCategory: CategorySchema,
  toCategory: CategorySchema,
  reason: z.string(),
  source: z.string(),
  createdAt: IsoDateTime,
});
export type Reclassification = z.infer<typeof ReclassificationSchema>;

export const SegmentSchema = z.object({
  n: z.number().int().nonnegative(),
  promoters: z.number().int().nonnegative(),
  passives: z.number().int().nonnegative(),
  detractors: z.number().int().nonnegative(),
  /** −100..100, 1 decimal; null when n = 0. */
  nrs: z.number().min(-100).max(100).nullable(),
  warning: Warning,
});
export type Segment = z.infer<typeof SegmentSchema>;

export const RateSchema = z.object({
  /** Denominator. */
  n: z.number().int().nonnegative(),
  count: z.number().int().nonnegative(),
  /** Percent, 0..100, 1 decimal; null when n = 0. */
  pct: z.number().min(0).max(100).nullable(),
  warning: Warning,
});
export type Rate = z.infer<typeof RateSchema>;

const Comparison = {
  /** Same figure for the prior period of equal length. */
  prior: z.number().nullable(),
  /** current − prior, in points, 1 decimal; null when either side is null. */
  delta: z.number().nullable(),
};
export const SegmentReportSchema = SegmentSchema.extend(Comparison);
export type SegmentReport = z.infer<typeof SegmentReportSchema>;
export const RateReportSchema = RateSchema.extend(Comparison);
export type RateReport = z.infer<typeof RateReportSchema>;

const ByChannel = <T extends z.ZodType>(t: T) => z.record(ChannelSchema, t);

export const PeriodReportSchema = z.object({
  version: z.literal(1),
  /** Inclusive start, exclusive end (UTC). */
  periodStart: IsoDateTime,
  periodEnd: IsoDateTime,
  priorStart: IsoDateTime,
  priorEnd: IsoDateTime,
  /** Which scores the report is built on. */
  source: z.object({ model: z.string(), promptVersion: z.string() }),
  counts: z.object({
    interactions: z.number().int().nonnegative(),
    scored: z.number().int().nonnegative(),
    /** Counted as detractors (lowest defensible category), left out of rate denominators. */
    scoreFailed: z.number().int().nonnegative(),
    /** No score row yet: left out of the report. */
    unscored: z.number().int().nonnegative(),
  }),
  overall: SegmentReportSchema,
  byChannel: ByChannel(SegmentReportSchema),
  byBusinessLine: z.record(z.string(), SegmentReportSchema),
  rates: z.object({
    /** Share of ai_agent interactions where the customer asked for a human. */
    escape: RateReportSchema,
    /** Share of claimed resolutions (resolved yes or partial) later reclassified as false_resolution. */
    falseResolution: z.object({
      overall: RateReportSchema,
      byChannel: ByChannel(RateReportSchema),
    }),
    abandonment: z.object({ overall: RateReportSchema, byChannel: ByChannel(RateReportSchema) }),
  }),
  /** Survey NPS for the same period, for side-by-side comparison with NRS. */
  nps: z.object({
    n: z.number().int().nonnegative(),
    score: z.number().min(-100).max(100).nullable(),
    warning: Warning,
    ...Comparison,
  }),
});
export type PeriodReport = z.infer<typeof PeriodReportSchema>;

/** One interaction as the report sees it: final category plus the facts the rates need. */
export interface ReportItem {
  interactionId: string;
  channel: Channel;
  businessLine: string;
  category: Category;
  /** Score failed: counted as detractor, excluded from rate denominators. */
  scoreFailed: boolean;
  askedForHuman: boolean;
  abandoned: boolean;
  /** The agent claimed resolution: the scorer said resolved "yes" or "partial" (claimed, unconfirmed). */
  claimedResolved: boolean;
  /** Reclassified with reason false_resolution. */
  falseResolution: boolean;
}

// ───────────── category ─────────────

const RANK: Record<Category, number> = { detractor: 0, passive: 1, promoter: 2 };

/**
 * The category the report counts: the LOWEST of the score's category and every
 * reclassification of this interaction. Taking the lowest (not the latest) means no
 * reclassification, in any order, can ever raise a category (CLAUDE.md #1). A failed score
 * falls back to detractor, the lowest defensible category (CLAUDE.md #4).
 */
export function finalCategory(
  score: ScoreRecord,
  reclassifications: readonly Reclassification[],
): Category {
  let category: Category = score.status === 'scored' ? score.category : 'detractor';
  for (const r of reclassifications) {
    if (r.interactionId === score.interactionId && RANK[r.toCategory] < RANK[category]) {
      category = r.toCategory;
    }
  }
  return category;
}

export function toReportItem(
  score: ScoreRecord,
  reclassifications: readonly Reclassification[],
): ReportItem {
  const mine = reclassifications.filter((r) => r.interactionId === score.interactionId);
  const scored = score.status === 'scored';
  return {
    interactionId: score.interactionId,
    channel: score.channel,
    businessLine: score.businessLine,
    category: finalCategory(score, mine),
    scoreFailed: !scored,
    askedForHuman: scored && score.output.asked_for_human,
    abandoned: scored && score.output.abandoned,
    claimedResolved: scored && score.output.resolved !== 'no',
    falseResolution: mine.some((r) => r.reason === 'false_resolution'),
  };
}

// ───────────── NRS ─────────────

/** Rounds to 1 decimal, half away from zero, and never returns −0. */
export function round1(x: number): number {
  const r = (Math.sign(x) * Math.round(Math.abs(x) * 10)) / 10;
  return r === 0 ? 0 : r;
}

/** "low confidence" for any segment with fewer than 30 interactions. */
export function sampleSizeWarning(n: number): typeof LOW_CONFIDENCE | null {
  return n < MIN_SAMPLE ? LOW_CONFIDENCE : null;
}

/** %promoters − %detractors, 1 decimal, −100..100. Null for an empty set (no data ≠ 0). */
export function nrs(items: readonly Pick<ReportItem, 'category'>[]): number | null {
  if (items.length === 0) return null;
  let net = 0;
  for (const { category } of items)
    net += category === 'promoter' ? 1 : category === 'detractor' ? -1 : 0;
  return round1((net / items.length) * 100);
}

export function segment(items: readonly Pick<ReportItem, 'category'>[]): Segment {
  const count = (c: Category) => items.filter((i) => i.category === c).length;
  return {
    n: items.length,
    promoters: count('promoter'),
    passives: count('passive'),
    detractors: count('detractor'),
    nrs: nrs(items),
    warning: sampleSizeWarning(items.length),
  };
}

/** Every channel is present, even with n = 0, so a missing channel can't go unnoticed. */
export function nrsByChannel(items: readonly ReportItem[]): Record<Channel, Segment> {
  return Object.fromEntries(
    CHANNELS.map((c) => [c, segment(items.filter((i) => i.channel === c))]),
  ) as Record<Channel, Segment>;
}

/** One segment per business line present in the data, sorted by name. */
export function nrsByBusinessLine(items: readonly ReportItem[]): Record<string, Segment> {
  const lines = [...new Set(items.map((i) => i.businessLine))].sort();
  return Object.fromEntries(
    lines.map((l) => [l, segment(items.filter((i) => i.businessLine === l))]),
  );
}

// ───────────── rates ─────────────

function rate(denominator: readonly ReportItem[], hit: (i: ReportItem) => boolean): Rate {
  const count = denominator.filter(hit).length;
  return {
    n: denominator.length,
    count,
    pct: denominator.length === 0 ? null : round1((count / denominator.length) * 100),
    warning: sampleSizeWarning(denominator.length),
  };
}

const known = (items: readonly ReportItem[]) => items.filter((i) => !i.scoreFailed);

/** ai_agent interactions where the customer asked for a human. */
export function escapeRate(items: readonly ReportItem[]): Rate {
  return rate(
    known(items).filter((i) => i.channel === 'ai_agent'),
    (i) => i.askedForHuman,
  );
}

/** Of the interactions the scorer called resolved, the share later found to be false resolutions. */
export function falseResolutionRate(items: readonly ReportItem[]): Rate {
  return rate(
    known(items).filter((i) => i.claimedResolved),
    (i) => i.falseResolution,
  );
}

export function abandonmentRate(items: readonly ReportItem[]): Rate {
  return rate(known(items), (i) => i.abandoned);
}

export function rateByChannel(
  fn: (items: readonly ReportItem[]) => Rate,
  items: readonly ReportItem[],
): Record<Channel, Rate> {
  return Object.fromEntries(
    CHANNELS.map((c) => [c, fn(items.filter((i) => i.channel === c))]),
  ) as Record<Channel, Rate>;
}

// ───────────── comparison ─────────────

/** current − prior in points, 1 decimal. Null when either side has no data. */
export function deltaVsPrior(current: number | null, prior: number | null): number | null {
  return current === null || prior === null ? null : round1(current - prior);
}

/** NPS = %promoters (9–10) − %detractors (0–6) over survey responses. */
export function npsScore(scores: readonly number[]): number | null {
  if (scores.length === 0) return null;
  const net = scores.filter((s) => s >= 9).length - scores.filter((s) => s <= 6).length;
  return round1((net / scores.length) * 100);
}

// ───────────── period ─────────────

const DAY = 86_400_000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Turns inclusive YYYY-MM-DD dates into [start, end) UTC instants, plus the prior
 * period of the same length ending where this one starts.
 */
export function periodFromDates(from: string, to: string) {
  const parse = (d: string, name: string) => {
    const t = DATE.test(d) ? Date.parse(`${d}T00:00:00Z`) : NaN;
    if (Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== d) {
      throw new Error(`--${name} must be a date as YYYY-MM-DD (got "${d}")`);
    }
    return t;
  };
  const start = parse(from, 'from');
  const end = parse(to, 'to') + DAY;
  if (end <= start) throw new Error('--to must be on or after --from');
  const iso = (t: number) => new Date(t).toISOString();
  return {
    periodStart: iso(start),
    periodEnd: iso(end),
    priorStart: iso(2 * start - end),
    priorEnd: iso(start),
  };
}

// ───────────── the report ─────────────

export interface PeriodReportInput {
  period: ReturnType<typeof periodFromDates>;
  source: PeriodReport['source'];
  current: readonly ReportItem[];
  prior: readonly ReportItem[];
  counts: PeriodReport['counts'];
  surveys: { current: readonly number[]; prior: readonly number[] };
}

const compareSegment = (cur: Segment, prior: Segment): SegmentReport => ({
  ...cur,
  prior: prior.nrs,
  delta: deltaVsPrior(cur.nrs, prior.nrs),
});
const compareRate = (cur: Rate, prior: Rate): RateReport => ({
  ...cur,
  prior: prior.pct,
  delta: deltaVsPrior(cur.pct, prior.pct),
});
function compareRecord<K extends string, T, R>(
  cur: Record<K, T>,
  prior: Record<string, T | undefined>,
  empty: T,
  fn: (c: T, p: T) => R,
): Record<K, R> {
  return Object.fromEntries(
    (Object.keys(cur) as K[]).map((k) => [k, fn(cur[k], prior[k] ?? empty)]),
  ) as Record<K, R>;
}

/** Assembles the full report from already-loaded data. Pure. */
export function buildPeriodReport(input: PeriodReportInput): PeriodReport {
  const { current: cur, prior } = input;
  const emptySegment = segment([]);
  const emptyRate = rate([], () => false);
  const npsNow = npsScore(input.surveys.current);
  const npsPrior = npsScore(input.surveys.prior);
  return {
    version: 1,
    ...input.period,
    source: input.source,
    counts: input.counts,
    overall: compareSegment(segment(cur), segment(prior)),
    byChannel: compareRecord(nrsByChannel(cur), nrsByChannel(prior), emptySegment, compareSegment),
    byBusinessLine: compareRecord(
      nrsByBusinessLine(cur),
      nrsByBusinessLine(prior),
      emptySegment,
      compareSegment,
    ),
    rates: {
      escape: compareRate(escapeRate(cur), escapeRate(prior)),
      falseResolution: {
        overall: compareRate(falseResolutionRate(cur), falseResolutionRate(prior)),
        byChannel: compareRecord(
          rateByChannel(falseResolutionRate, cur),
          rateByChannel(falseResolutionRate, prior),
          emptyRate,
          compareRate,
        ),
      },
      abandonment: {
        overall: compareRate(abandonmentRate(cur), abandonmentRate(prior)),
        byChannel: compareRecord(
          rateByChannel(abandonmentRate, cur),
          rateByChannel(abandonmentRate, prior),
          emptyRate,
          compareRate,
        ),
      },
    },
    nps: {
      n: input.surveys.current.length,
      score: npsNow,
      warning: sampleSizeWarning(input.surveys.current.length),
      prior: npsPrior,
      delta: deltaVsPrior(npsNow, npsPrior),
    },
  };
}
