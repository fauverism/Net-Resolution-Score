import { z } from 'zod';

/** What "decision-ready" requires of the latest scorer eval (evals/config.json). */
export const DecisionReadyCriteriaSchema = z
  .object({
    minCategoryAccuracy: z.number().min(0).max(1),
    /** Real, hand-labeled conversations checked: templates alone don't prove much. */
    minGoldenCases: z.number().int().nonnegative(),
    /** Share of cases scored higher than they should be. */
    maxInflationRate: z.number().min(0).max(1),
    /** An old check doesn't vouch for today's scorer. */
    maxAgeDays: z.number().int().positive(),
  })
  .strict();
export type DecisionReadyCriteria = z.infer<typeof DecisionReadyCriteriaSchema>;

/** The latest eval's numbers for the prompt + model the dashboard reports on. */
export interface EvalEvidence {
  createdAt: string;
  categoryAccuracy: number | null;
  inflationRate: number | null;
  goldenCases: number;
  seedCases: number;
}

export const CalibrationStatusSchema = z.enum(['decision_ready', 'calibrating']);
export type CalibrationStatus = z.infer<typeof CalibrationStatusSchema>;

export const CalibrationSchema = z.object({
  status: CalibrationStatusSchema,
  /** Plain-language reasons it isn't decision-ready yet (empty when it is). */
  reasons: z.array(z.string()),
  model: z.string(),
  promptVersion: z.string(),
  evalCreatedAt: z.string().nullable(),
  categoryAccuracy: z.number().nullable(),
  inflationRate: z.number().nullable(),
  goldenCases: z.number().int().nonnegative(),
  seedCases: z.number().int().nonnegative(),
  createdAt: z.string(),
});
export type Calibration = z.infer<typeof CalibrationSchema>;

const pct = (x: number) => `${Math.round(x * 100)}%`;

/**
 * Decision-ready only when every check passes; otherwise "calibrating", with each reason
 * in words an executive can act on. Pure: `now` is passed in.
 */
export function calibrationStatus(
  evidence: EvalEvidence | null,
  c: DecisionReadyCriteria,
  now: Date,
): { status: CalibrationStatus; reasons: string[] } {
  if (!evidence) {
    return {
      status: 'calibrating',
      reasons: ["The scoring hasn't been checked against labeled conversations yet."],
    };
  }
  const reasons: string[] = [];
  const acc = evidence.categoryAccuracy;
  if (acc === null || acc < c.minCategoryAccuracy) {
    reasons.push(
      `Scoring agreed with reviewers on ${acc === null ? 'no' : pct(acc)} of conversations; the bar is ${pct(c.minCategoryAccuracy)}.`,
    );
  }
  if (evidence.goldenCases < c.minGoldenCases) {
    reasons.push(
      `Checked against ${evidence.goldenCases} real conversations so far; ${c.minGoldenCases} are needed.`,
    );
  }
  if (evidence.inflationRate === null || evidence.inflationRate > c.maxInflationRate) {
    reasons.push(
      `Scoring was too generous on ${evidence.inflationRate === null ? 'an unknown share' : pct(evidence.inflationRate)} of conversations; the limit is ${pct(c.maxInflationRate)}.`,
    );
  }
  const ageDays = (now.getTime() - Date.parse(evidence.createdAt)) / 86_400_000;
  if (Number.isNaN(ageDays)) {
    reasons.push(
      'The date of the last check is unknown; it must be within the last ' +
        `${c.maxAgeDays} days.`,
    );
  } else if (ageDays > c.maxAgeDays) {
    reasons.push(
      `The last check was ${Math.floor(ageDays)} days ago; it must be within ${c.maxAgeDays} days.`,
    );
  }
  return { status: reasons.length ? 'calibrating' : 'decision_ready', reasons };
}
