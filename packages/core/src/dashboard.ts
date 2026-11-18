import { z } from 'zod';
import { CalibrationSchema } from './calibration.ts';
import { DriverSchema } from './drivers.ts';
import {
  ReclassificationSchema,
  PeriodReportSchema,
  SegmentReportSchema,
  SegmentSchema,
} from './report.ts';
import { CategorySchema, ChannelSchema, ScoreRecordSchema } from './schemas.ts';

// ───────────── trend buckets ─────────────

const DAY = 86_400_000;

/**
 * `count` consecutive 7-day buckets [start, end) ending at `endExclusive`, oldest first.
 * Pure: the caller decides where the trend ends.
 */
export function weekBuckets(endExclusive: string, count: number): { start: string; end: string }[] {
  const end = Date.parse(endExclusive);
  if (Number.isNaN(end)) throw new Error(`Invalid date: ${endExclusive}`);
  return Array.from({ length: count }, (_, i) => {
    const bucketEnd = end - (count - 1 - i) * 7 * DAY;
    return {
      start: new Date(bucketEnd - 7 * DAY).toISOString(),
      end: new Date(bucketEnd).toISOString(),
    };
  });
}

// ───────────── API contract (validated on both sides) ─────────────

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

export const PeriodQuerySchema = z.object({
  from: Day,
  to: Day,
  /** Business line filter; omitted for all lines. */
  line: z
    .string()
    .regex(/^[a-z][a-z0-9_]*$/)
    .optional(),
});
export type PeriodQuery = z.infer<typeof PeriodQuerySchema>;

export const MetaResponseSchema = z.object({
  earliestDate: Day.nullable(),
  latestDate: Day.nullable(),
  businessLines: z.array(z.string()),
  model: z.string(),
  promptVersion: z.string(),
  /** Scores come from `seed --demo-scores` (the seed's answer key), not the model. */
  demo: z.boolean(),
});
export type MetaResponse = z.infer<typeof MetaResponseSchema>;

export const TrendPointSchema = z.object({
  start: z.string(),
  end: z.string(),
  overall: SegmentSchema,
  byChannel: z.record(ChannelSchema, SegmentSchema),
});
export type TrendPoint = z.infer<typeof TrendPointSchema>;

export const SummaryResponseSchema = z.object({
  query: PeriodQuerySchema,
  report: PeriodReportSchema,
  aiVsHuman: z.object({
    ai: SegmentReportSchema,
    human: SegmentReportSchema,
    /** AI NRS − human NRS, 1 decimal; null if either side has no data. */
    gap: z.number().nullable(),
    priorGap: z.number().nullable(),
  }),
  calibration: CalibrationSchema.nullable(),
  drivers: z
    .object({
      runId: z.number().int(),
      periodStart: z.string(),
      periodEnd: z.string(),
      /** False when the latest drivers run covers a different period than the one shown. */
      matchesPeriod: z.boolean(),
      top: z.array(DriverSchema),
    })
    .nullable(),
  trend: z.array(TrendPointSchema),
});
export type SummaryResponse = z.infer<typeof SummaryResponseSchema>;

export const DrillMetricSchema = z.enum([
  'all',
  'escape',
  'false_resolution',
  'abandoned',
  'driver',
]);
export type DrillMetric = z.infer<typeof DrillMetricSchema>;

export const DrillQuerySchema = PeriodQuerySchema.extend({
  metric: DrillMetricSchema.default('all'),
  channel: ChannelSchema.optional(),
  category: CategorySchema.optional(),
  /** For metric=driver: which drivers run and rank. */
  driverRun: z.coerce.number().int().positive().optional(),
  driverRank: z.coerce.number().int().positive().optional(),
});
export type DrillQuery = z.infer<typeof DrillQuerySchema>;

export const DrillItemSchema = z.object({
  interactionId: z.string(),
  startedAt: z.string(),
  channel: ChannelSchema,
  businessLine: z.string(),
  /** Final category after reclassifications; null when unscored. */
  category: CategorySchema.nullable(),
  reclassified: z.boolean(),
});
export type DrillItem = z.infer<typeof DrillItemSchema>;

export const DrillResponseSchema = z.object({
  title: z.string(),
  total: z.number().int().nonnegative(),
  items: z.array(DrillItemSchema),
});
export type DrillResponse = z.infer<typeof DrillResponseSchema>;

export const InteractionDetailSchema = z.object({
  interactionId: z.string(),
  startedAt: z.string(),
  channel: ChannelSchema,
  businessLine: z.string(),
  /** Always redacted. */
  transcript: z.string(),
  score: ScoreRecordSchema.nullable(),
  finalCategory: CategorySchema.nullable(),
  reclassifications: z.array(
    ReclassificationSchema.extend({
      /** The return contact that caused it, and the model's reason. */
      link: z
        .object({
          otherInteractionId: z.string(),
          gapDays: z.number(),
          confidence: z.number().nullable(),
          why: z.string().nullable(),
        })
        .nullable(),
    }),
  ),
});
export type InteractionDetail = z.infer<typeof InteractionDetailSchema>;
