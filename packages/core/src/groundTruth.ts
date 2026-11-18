import { z } from 'zod';
import { CategorySchema, ChannelSchema, EffortSchema } from './schemas.ts';

export const PiiTypeSchema = z.enum([
  'name',
  'email',
  'phone',
  'account_number',
  'card_last4',
  'address',
  'agent_name',
]);
export type PiiType = z.infer<typeof PiiTypeSchema>;

export const PiiMentionSchema = z.object({ type: PiiTypeSchema, value: z.string().min(1) });
export type PiiMention = z.infer<typeof PiiMentionSchema>;

/** Hidden label for one synthetic interaction. Lives in data/fixtures, never in the db. */
export const GroundTruthLabelSchema = z.object({
  interactionId: z.string(),
  customerId: z.string(),
  channel: ChannelSchema,
  businessLine: z.string(),
  goalId: z.string(),
  goal: z.string(),
  startedAt: z.iso.datetime({ offset: true }),
  /** What actually happened. */
  resolved: z.boolean(),
  /** What the transcript appears to show (differs for false resolutions). */
  visiblyResolved: z.boolean(),
  falseResolution: z.boolean(),
  firstContact: z.boolean(),
  effort: EffortSchema,
  escalated: z.boolean(),
  abandoned: z.boolean(),
  /** This interaction is a return about the goal of this earlier interaction. */
  previousInteractionId: z.string().nullable(),
  /** The customer's next contact about the same goal, if it happened inside the data period. */
  returnInteractionId: z.string().nullable(),
  returnAfterDays: z.number().nonnegative().nullable(),
  /** Category a perfect reader of this transcript alone would assign. */
  transcriptCategory: CategorySchema,
  /** Category after linking returns, using the file's returnWindowDays. */
  trueCategory: CategorySchema,
  /** Every piece of fake PII planted in the transcript, as it appears there. */
  pii: z.array(PiiMentionSchema),
});
export type GroundTruthLabel = z.infer<typeof GroundTruthLabelSchema>;

export const GroundTruthFileSchema = z.object({
  version: z.literal(1),
  seed: z.number().int(),
  periodStart: z.iso.datetime({ offset: true }),
  periodEnd: z.iso.datetime({ offset: true }),
  returnWindowDays: z.number().int().positive(),
  labels: z.array(GroundTruthLabelSchema),
});
export type GroundTruthFile = z.infer<typeof GroundTruthFileSchema>;
