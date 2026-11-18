import { readFileSync } from 'node:fs';
import { DecisionReadyCriteriaSchema } from '@nrs/core';
import { z } from 'zod';

export const EvalConfigSchema = z
  .object({
    /** The command fails if any compared prompt scores below this category accuracy. */
    categoryAccuracyThreshold: z.number().min(0).max(1),
    /** How many seed cases to score (stratified); null for all of them. */
    seedSampleSize: z.number().int().positive().nullable(),
    groundTruthPath: z.string(),
    goldenDir: z.string(),
    resultsDir: z.string(),
    /** What the dashboard's "Decision-ready" badge requires, besides the accuracy threshold. */
    decisionReady: DecisionReadyCriteriaSchema.omit({ minCategoryAccuracy: true }),
  })
  .strict();
export type EvalConfig = z.infer<typeof EvalConfigSchema>;

export function loadEvalConfig(file: string): EvalConfig {
  const parsed = EvalConfigSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
  if (!parsed.success) throw new Error(`Invalid ${file}:\n${z.prettifyError(parsed.error)}`);
  return parsed.data;
}
