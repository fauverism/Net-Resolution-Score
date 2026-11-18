import { createHash } from 'node:crypto';
import type Anthropic from '@anthropic-ai/sdk';
import type { RankedCluster, TokenUsage } from '@nrs/core';
import { z } from 'zod';
import type { Db } from '../db.ts';
import type { BackoffOptions } from '../score/backoff.ts';
import {
  requestValidated,
  retryMessages,
  type Attempt,
  type Effort,
  type LlmClient,
  type RetryContext,
} from '../score/llm.ts';
import { ZERO_USAGE } from '../score/pricing.ts';
import type { ScorerPrompt } from '../score/prompt.ts';

export const DEFAULT_CLUSTER_PROMPT_VERSION = 'drivers.v1';
export const DEFAULT_SUGGEST_PROMPT_VERSION = 'driver-fixes.v1';

export interface DriverLlmSettings {
  /** From ANTHROPIC_MODEL. Never hardcoded. */
  model: string;
  effort?: Effort | undefined;
  backoff?: BackoffOptions;
}

export type CachedAttempt<T> = Attempt<T> & { cached: boolean };

/** One validated call (retry once on invalid output), served from llm_cache when possible. */
async function cachedRequest<T>(
  db: Db,
  client: LlmClient,
  s: DriverLlmSettings,
  purpose: string,
  prompt: ScorerPrompt,
  content: string,
  outputSchema: object,
  validator: z.ZodType<T>,
): Promise<CachedAttempt<T>> {
  const key = createHash('sha256')
    .update(JSON.stringify([purpose, prompt.version, prompt.sha256, s.model, content]))
    .digest('hex');
  const hit = db
    .prepare('SELECT output_json FROM llm_cache WHERE cache_key = ?')
    .pluck()
    .get(key) as string | undefined;
  if (hit) {
    const parsed = validator.safeParse(JSON.parse(hit));
    if (parsed.success) {
      return {
        ok: true,
        output: parsed.data,
        attempts: 0,
        retried: false,
        usage: ZERO_USAGE,
        cached: true,
      };
    }
  }
  const build = (retry?: RetryContext): Anthropic.MessageCreateParamsNonStreaming => ({
    model: s.model,
    max_tokens: 16000,
    system: [{ type: 'text', text: prompt.text, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content }, ...(retry ? retryMessages(retry) : [])],
    output_config: {
      format: { type: 'json_schema', schema: outputSchema as Record<string, unknown> },
      ...(s.effort ? { effort: s.effort } : {}),
    },
  });
  const result = await requestValidated(client, build, validator, s.backoff);
  if (result.ok) {
    db.prepare(
      `INSERT OR REPLACE INTO llm_cache (cache_key, purpose, model, prompt_version, output_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      key,
      purpose,
      s.model,
      prompt.version,
      JSON.stringify(result.output),
      new Date().toISOString(),
    );
  }
  return { ...result, cached: false };
}

// ───────────── clustering ─────────────

const CLUSTER_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['assignments'],
  properties: {
    assignments: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'label'],
        properties: { id: { type: 'string' }, label: { type: 'string' } },
      },
    },
  },
};

/** Zod for one batch: every id given, exactly once, with a short label. */
export function clusterSchema(ids: readonly string[]) {
  return z
    .object({
      assignments: z.array(
        z.object({ id: z.string(), label: z.string().trim().min(3).max(80) }).strict(),
      ),
    })
    .strict()
    .superRefine((o, ctx) => {
      const got = o.assignments.map((a) => a.id);
      const missing = ids.filter((id) => !got.includes(id));
      const unknown = got.filter((id) => !ids.includes(id));
      const dupes = got.filter((id, i) => got.indexOf(id) !== i);
      if (missing.length)
        ctx.addIssue({ code: 'custom', message: `missing ids: ${missing.join(', ')}` });
      if (unknown.length)
        ctx.addIssue({ code: 'custom', message: `unknown ids: ${unknown.join(', ')}` });
      if (dupes.length)
        ctx.addIssue({ code: 'custom', message: `duplicate ids: ${dupes.join(', ')}` });
    });
}

export function clusterContent(
  goals: readonly string[],
  existingLabels: readonly string[],
): string {
  return [
    'Labels already in use (reuse one, copied exactly, when it fits):',
    existingLabels.length ? existingLabels.map((l) => `- ${l}`).join('\n') : '(none yet)',
    '',
    'Goals to label:',
    '<goals>',
    ...goals.map((g, i) => `g${i + 1}: ${g}`),
    '</goals>',
  ].join('\n');
}

/**
 * Labels one batch of goals. Returns goal → label, with labels that differ only by case
 * folded onto an existing label. Null when the call failed (invalid twice, refusal, or
 * API errors after backoff).
 */
export async function labelBatch(
  db: Db,
  client: LlmClient,
  s: DriverLlmSettings,
  prompt: ScorerPrompt,
  goals: readonly string[],
  existingLabels: readonly string[],
): Promise<{
  labels: Map<string, string> | null;
  usage: TokenUsage;
  calls: number;
  cached: boolean;
}> {
  const ids = goals.map((_, i) => `g${i + 1}`);
  const r = await cachedRequest(
    db,
    client,
    s,
    'cluster',
    prompt,
    clusterContent(goals, existingLabels),
    CLUSTER_JSON_SCHEMA,
    clusterSchema(ids),
  );
  if (!r.ok) return { labels: null, usage: r.usage, calls: r.attempts, cached: false };
  const canonical = new Map(existingLabels.map((l) => [l.toLowerCase(), l]));
  const labels = new Map<string, string>();
  for (const { id, label } of r.output.assignments) {
    const clean = label.trim();
    const existing = canonical.get(clean.toLowerCase());
    if (!existing) canonical.set(clean.toLowerCase(), clean);
    labels.set(goals[ids.indexOf(id)]!, existing ?? clean);
  }
  return { labels, usage: r.usage, calls: r.attempts, cached: r.cached };
}

// ───────────── suggestions ─────────────

const SUGGEST_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['drivers'],
  properties: {
    drivers: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'driver', 'suggested_fix', 'suggested_owner'],
        properties: {
          id: { type: 'string' },
          driver: { type: 'string' },
          suggested_fix: { type: 'string' },
          suggested_owner: { type: 'string' },
        },
      },
    },
  },
};

const SuggestionSchema = z
  .object({
    id: z.string(),
    driver: z.string().trim().min(10).max(300),
    suggested_fix: z.string().trim().min(10).max(600),
    suggested_owner: z.string().trim().min(2).max(60),
  })
  .strict();
export type Suggestion = z.infer<typeof SuggestionSchema>;

export function suggestSchema(ids: readonly string[]) {
  return z
    .object({ drivers: z.array(SuggestionSchema) })
    .strict()
    .superRefine((o, ctx) => {
      const got = o.drivers.map((d) => d.id).sort();
      if (JSON.stringify(got) !== JSON.stringify([...ids].sort())) {
        ctx.addIssue({
          code: 'custom',
          message: `expected exactly one entry for each of: ${ids.join(', ')}`,
        });
      }
    });
}

export interface SuggestInput {
  cluster: RankedCluster;
  /** Distinct example goals (redacted). */
  goals: string[];
  /** Example quotes (redacted), verified ones first. */
  quotes: string[];
}

export function suggestContent(inputs: readonly SuggestInput[]): string {
  const pct = (x: number) => `${x.toFixed(1)}%`;
  return inputs
    .map(({ cluster: c, goals, quotes }, i) =>
      [
        `<driver id="d${i + 1}">`,
        `Cluster: ${c.label}`,
        `Detractors: ${c.volume} (${pct(c.pctOfDetractors)} of all detractors this period)`,
        `Severity: ${c.severityMix.unresolvedOrAbandoned} unresolved or abandoned, ` +
          `${c.severityMix.falseResolution} false resolutions, ${c.severityMix.highEffort} high effort or other`,
        `Channels: ${Object.entries(c.channelMix)
          .map(([ch, m]) => `${ch} ${pct(m.pct)}`)
          .join(', ')}`,
        `Business lines: ${Object.entries(c.businessLines)
          .map(([l, n]) => `${l} ${n}`)
          .join(', ')}`,
        'Example customer goals:',
        ...goals.map((g) => `- ${g}`),
        'Example customer quotes:',
        ...quotes.map((q) => `- "${q}"`),
        '</driver>',
      ].join('\n'),
    )
    .join('\n\n');
}

/** Driver sentence, fix and owner for each top cluster, or null if the call failed. */
export async function suggestFixes(
  db: Db,
  client: LlmClient,
  s: DriverLlmSettings,
  prompt: ScorerPrompt,
  inputs: readonly SuggestInput[],
): Promise<{
  suggestions: Suggestion[] | null;
  usage: TokenUsage;
  calls: number;
  cached: boolean;
}> {
  const ids = inputs.map((_, i) => `d${i + 1}`);
  const r = await cachedRequest(
    db,
    client,
    s,
    'suggest',
    prompt,
    suggestContent(inputs),
    SUGGEST_JSON_SCHEMA,
    suggestSchema(ids),
  );
  if (!r.ok) return { suggestions: null, usage: r.usage, calls: r.attempts, cached: false };
  const byId = new Map(r.output.drivers.map((d) => [d.id, d]));
  return {
    suggestions: ids.map((id) => byId.get(id)!),
    usage: r.usage,
    calls: r.attempts,
    cached: r.cached,
  };
}
