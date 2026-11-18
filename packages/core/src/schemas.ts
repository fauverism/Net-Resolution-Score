import { z } from 'zod';

/** Who handled the interaction. Every metric must be reportable per channel. */
export const ChannelSchema = z.enum(['ai_agent', 'human', 'hybrid']);
export type Channel = z.infer<typeof ChannelSchema>;
export const CHANNELS = ChannelSchema.options;

/** Ordered lowest → highest. When uncertain, the scorer picks the lower one. */
export const CategorySchema = z.enum(['detractor', 'passive', 'promoter']);
export type Category = z.infer<typeof CategorySchema>;

/** Customer effort: 1 = effortless, 3 = high effort. */
export const EffortSchema = z.union([z.literal(1), z.literal(2), z.literal(3)]);
export type Effort = z.infer<typeof EffortSchema>;

const IsoDateTime = z.iso.datetime({ offset: true });

export const CustomerSchema = z.object({
  id: z.string().min(1),
  createdAt: IsoDateTime,
});
export type Customer = z.infer<typeof CustomerSchema>;

export const InteractionSchema = z.object({
  id: z.string().min(1),
  customerId: z.string().min(1),
  channel: ChannelSchema,
  startedAt: IsoDateTime,
  /** Must be PII-redacted before it leaves the process. */
  transcript: z.string(),
  businessLine: z.string().min(1),
});
export type Interaction = z.infer<typeof InteractionSchema>;

/** The scorer's judgement of a single interaction (validated LLM output). */
export const InteractionJudgementSchema = z.object({
  resolved: z.boolean(),
  firstContact: z.boolean(),
  effort: EffortSchema,
  escalated: z.boolean(),
  abandoned: z.boolean(),
  /** Short summary of the customer's goal, used to link return contacts. */
  goal: z.string(),
  confidence: z.number().min(0).max(1),
  rationale: z.string(),
});
export type InteractionJudgement = z.infer<typeof InteractionJudgementSchema>;

export const ScoredInteractionSchema = z.object({
  interactionId: z.string().min(1),
  channel: ChannelSchema,
  businessLine: z.string().min(1),
  judgement: InteractionJudgementSchema,
  /** Set by the link stage; null until linked. */
  returnedWithinWindow: z.boolean().nullable(),
  category: CategorySchema,
  model: z.string().min(1),
  promptVersion: z.string().min(1),
  scoredAt: IsoDateTime,
});
export type ScoredInteraction = z.infer<typeof ScoredInteractionSchema>;

export const SurveyResponseSchema = z.object({
  customerId: z.string().min(1),
  npsScore: z.number().int().min(0).max(10),
  respondedAt: IsoDateTime,
});
export type SurveyResponse = z.infer<typeof SurveyResponseSchema>;

/** Counts and score for one slice (overall, one channel, one business line). */
export const ScoreBreakdownSchema = z.object({
  total: z.number().int().nonnegative(),
  promoters: z.number().int().nonnegative(),
  passives: z.number().int().nonnegative(),
  detractors: z.number().int().nonnegative(),
  /** −100 to +100; null when total is 0. */
  nrs: z.number().min(-100).max(100).nullable(),
});
export type ScoreBreakdown = z.infer<typeof ScoreBreakdownSchema>;

export const PeriodReportSchema = z.object({
  periodStart: IsoDateTime,
  periodEnd: IsoDateTime,
  returnWindowDays: z.number().int().positive(),
  overall: ScoreBreakdownSchema,
  byChannel: z.record(ChannelSchema, ScoreBreakdownSchema),
  byBusinessLine: z.record(z.string(), ScoreBreakdownSchema),
  /** NPS for the same period, for side-by-side comparison; null if no surveys. */
  nps: z.number().min(-100).max(100).nullable(),
});
export type PeriodReport = z.infer<typeof PeriodReportSchema>;
