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
/** Did the customer get what they came for? "partial": the agent claimed it, the customer didn't confirm. */
export const ResolvedSchema = z.enum(['no', 'partial', 'yes']);
export type Resolved = z.infer<typeof ResolvedSchema>;

const Sentiment = z.number().int().min(-2).max(2);

/** What the LLM scorer returns for one interaction (validated before use). */
export const ScorerOutputSchema = z
  .object({
    channel: ChannelSchema,
    customer_goal: z.string().trim().min(1).max(300),
    resolved: ResolvedSchema,
    effort: z.number().int().min(1).max(3),
    sentiment_start: Sentiment,
    sentiment_end: Sentiment,
    asked_for_human: z.boolean(),
    abandoned: z.boolean(),
    category: CategorySchema,
    /** A single verbatim customer quote supporting the category. */
    evidence: z.string().trim().min(1).max(500),
  })
  .strict();
export type ScorerOutput = z.infer<typeof ScorerOutputSchema>;

export const ScoreFlagSchema = z.enum([
  /** The evidence quote couldn't be found in the transcript. */
  'evidence_unverified',
  /** The quote was found, but only in agent turns. */
  'evidence_not_from_customer',
  /** The scorer's channel differs from the recorded channel. */
  'channel_mismatch',
  /** Code lowered the scorer's category to match its own facts. */
  'category_lowered',
  /** First response failed validation; the retry succeeded. */
  'retried',
]);
export type ScoreFlag = z.infer<typeof ScoreFlagSchema>;

export const CategoryOverrideSchema = z.object({
  from: CategorySchema,
  to: CategorySchema,
  reasons: z.array(z.string()),
});
export type CategoryOverride = z.infer<typeof CategoryOverrideSchema>;

export const TokenUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
});
export type TokenUsage = z.infer<typeof TokenUsageSchema>;

const ScoreMeta = {
  interactionId: z.string().min(1),
  channel: ChannelSchema,
  businessLine: z.string().min(1),
  model: z.string().min(1),
  promptVersion: z.string().min(1),
  scoredAt: IsoDateTime,
  /** API calls made for this score (0 when served from cache). */
  attempts: z.number().int().nonnegative(),
};

export const ScoredInteractionSchema = z.object({
  ...ScoreMeta,
  status: z.literal('scored'),
  output: ScorerOutputSchema,
  /** Final category: the scorer's, lowered when its own facts don't support it. Never raised. */
  category: CategorySchema,
  override: CategoryOverrideSchema.nullable(),
  flags: z.array(ScoreFlagSchema),
  cacheKey: z.string(),
  cached: z.boolean(),
  usage: TokenUsageSchema,
});
export type ScoredInteraction = z.infer<typeof ScoredInteractionSchema>;

export const ScoreFailureSchema = z.object({
  ...ScoreMeta,
  status: z.literal('score_failed'),
  reason: z.enum(['invalid_output', 'refusal', 'api_error']),
  /** Validation or API error text. Never transcript content. */
  detail: z.string(),
  usage: TokenUsageSchema,
});
export type ScoreFailure = z.infer<typeof ScoreFailureSchema>;

export const ScoreRecordSchema = z.discriminatedUnion('status', [
  ScoredInteractionSchema,
  ScoreFailureSchema,
]);
export type ScoreRecord = z.infer<typeof ScoreRecordSchema>;

/** What the LLM linker returns for one candidate pair (validated before use). */
export const LinkerOutputSchema = z
  .object({
    same_goal: z.boolean(),
    confidence: z.number().min(0).max(1),
    why: z.string().trim().min(1).max(500),
  })
  .strict();
export type LinkerOutput = z.infer<typeof LinkerOutputSchema>;

export const LinkStatusSchema = z.enum([
  /** Same goal at or above the confidence threshold: A gets reclassified. */
  'confirmed',
  /** Same goal, but below the threshold: kept for review, no reclassification. */
  'unconfirmed',
  /** Different goal. */
  'rejected',
  /** Invalid output twice, a refusal, or API errors after backoff. Retried next run. */
  'link_failed',
]);
export type LinkStatus = z.infer<typeof LinkStatusSchema>;

export const LinkFlagSchema = z.enum(['ai_resolved_human_finished']);
export type LinkFlag = z.infer<typeof LinkFlagSchema>;

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
