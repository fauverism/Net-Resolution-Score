import {
  enforceCategory,
  evalMetrics,
  EvalExpectedSchema,
  EvalMetricsSchema,
  TokenUsageSchema,
  type EvalExpected,
  type EvalMetrics,
  type EvalObservation,
  type TokenUsage,
} from '@nrs/core';
import {
  addUsage,
  cacheKey,
  estimateCostUsd,
  getCached,
  mapWithConcurrency,
  putCached,
  scoreInteraction,
  ZERO_USAGE,
  type Db,
  type LlmClient,
  type ScorerPrompt,
  type ScorerSettings,
} from '@nrs/pipeline';
import { z } from 'zod';
import type { EvalCase } from './cases.ts';

export interface EvalRunOptions {
  /** From ANTHROPIC_MODEL. */
  model: string;
  prompts: ScorerPrompt[];
  concurrency: number;
  threshold: number;
  effort?: ScorerSettings['effort'];
  backoff?: ScorerSettings['backoff'];
  /** Score cache shared with the pipeline: re-running an eval costs nothing. */
  db?: Db;
}

export const PromptResultSchema = z.object({
  prompt: z.string(),
  promptSha256: z.string(),
  passed: z.boolean(),
  metrics: EvalMetricsSchema,
  usage: TokenUsageSchema,
  estCostUsd: z.number().nullable(),
  /** One row per case: ids and labels only, never transcripts. */
  cases: z.array(
    z.object({
      id: z.string(),
      source: z.enum(['seed', 'golden']),
      channel: z.string(),
      expected: EvalExpectedSchema,
      actual: EvalExpectedSchema.nullable(),
      failure: z.string().nullable(),
    }),
  ),
});
export type PromptResult = z.infer<typeof PromptResultSchema>;

/** Scores every case with one prompt; the scorer's category goes through the same enforcement as the pipeline. */
async function evalPrompt(
  client: LlmClient,
  cases: readonly EvalCase[],
  prompt: ScorerPrompt,
  o: EvalRunOptions,
): Promise<PromptResult> {
  let usage: TokenUsage = ZERO_USAGE;
  const settings: ScorerSettings = {
    model: o.model,
    prompt,
    effort: o.effort,
    ...(o.backoff ? { backoff: o.backoff } : {}),
  };

  const rows = await mapWithConcurrency(cases, o.concurrency, async (c) => {
    const key = cacheKey(c.transcript, prompt, o.model);
    let output = o.db ? getCached(o.db, key) : null;
    let failure: string | null = null;
    if (!output) {
      const r = await scoreInteraction(
        client,
        {
          interactionId: c.id,
          channel: c.channel,
          businessLine: 'eval',
          startedAt: '',
          transcript: c.transcript,
        },
        settings,
      );
      usage = addUsage(usage, r.usage);
      if (r.ok) {
        output = r.output;
        if (o.db) putCached(o.db, key, output, prompt, o.model, new Date());
      } else {
        failure = `${r.reason}: ${r.detail}`;
      }
    }
    const actual: EvalExpected | null = output
      ? {
          category: enforceCategory(output).category,
          resolved: output.resolved,
          effort: output.effort,
          asked_for_human: output.asked_for_human,
          abandoned: output.abandoned,
        }
      : null;
    return {
      id: c.id,
      source: c.source,
      channel: c.channel,
      expected: c.expected,
      actual,
      failure,
    };
  });

  const metrics: EvalMetrics = evalMetrics(rows as EvalObservation[]);
  return {
    prompt: prompt.version,
    promptSha256: prompt.sha256,
    passed: metrics.categoryAccuracy !== null && metrics.categoryAccuracy >= o.threshold,
    metrics,
    usage,
    estCostUsd: estimateCostUsd(o.model, usage),
    cases: rows,
  };
}

export const EvalResultsSchema = z.object({
  version: z.literal(1),
  createdAt: z.iso.datetime(),
  model: z.string(),
  threshold: z.number(),
  cases: z.object({
    total: z.number().int(),
    seed: z.number().int(),
    golden: z.number().int(),
  }),
  /** True only if every compared prompt meets the threshold. */
  passed: z.boolean(),
  prompts: z.array(PromptResultSchema),
});
export type EvalResults = z.infer<typeof EvalResultsSchema>;

/** Runs each prompt over the same cases, one prompt at a time, for a side-by-side comparison. */
export async function runEval(
  client: LlmClient,
  cases: readonly EvalCase[],
  o: EvalRunOptions,
  now = new Date(),
): Promise<EvalResults> {
  if (cases.length === 0)
    throw new Error('No eval cases. Run `npm run seed`, or add golden cases.');
  const prompts: PromptResult[] = [];
  for (const p of o.prompts) prompts.push(await evalPrompt(client, cases, p, o));
  return EvalResultsSchema.parse({
    version: 1,
    createdAt: now.toISOString(),
    model: o.model,
    threshold: o.threshold,
    cases: {
      total: cases.length,
      seed: cases.filter((c) => c.source === 'seed').length,
      golden: cases.filter((c) => c.source === 'golden').length,
    },
    passed: prompts.every((p) => p.passed),
    prompts,
  });
}
