import type Anthropic from '@anthropic-ai/sdk';
import {
  CategorySchema,
  CHANNELS,
  ScorerOutputSchema,
  type ScorerOutput,
  type TokenUsage,
} from '@nrs/core';
import { z } from 'zod';
import { addUsage, ZERO_USAGE } from './pricing.ts';
import type { ScorerPrompt } from './prompt.ts';
import type { ScoringInput } from './inputs.ts';
import { DEFAULT_BACKOFF, isRetryable, withBackoff, type BackoffOptions } from './backoff.ts';

/** The one SDK call the scorer makes. Tests pass a fake. */
export interface ScorerClient {
  create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
}

export function anthropicScorerClient(client: Anthropic): ScorerClient {
  return { create: (params) => client.messages.create(params) };
}

export type Effort = NonNullable<Anthropic.OutputConfig['effort']>;

export interface ScorerSettings {
  /** From ANTHROPIC_MODEL. Never hardcoded. */
  model: string;
  prompt: ScorerPrompt;
  /** Optional; when unset the model's default effort applies. */
  effort?: Effort | undefined;
  backoff?: BackoffOptions;
}

/**
 * JSON schema for structured outputs. Ranges are written as enums because structured
 * outputs drop minimum/maximum; ScorerOutputSchema still validates everything after.
 */
export const OUTPUT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'channel',
    'customer_goal',
    'resolved',
    'effort',
    'sentiment_start',
    'sentiment_end',
    'asked_for_human',
    'abandoned',
    'category',
    'evidence',
  ],
  properties: {
    channel: { type: 'string', enum: [...CHANNELS] },
    customer_goal: { type: 'string' },
    resolved: { type: 'string', enum: ['yes', 'partial', 'no'] },
    effort: { type: 'integer', enum: [1, 2, 3] },
    sentiment_start: { type: 'integer', enum: [-2, -1, 0, 1, 2] },
    sentiment_end: { type: 'integer', enum: [-2, -1, 0, 1, 2] },
    asked_for_human: { type: 'boolean' },
    abandoned: { type: 'boolean' },
    category: { type: 'string', enum: [...CategorySchema.options] },
    evidence: { type: 'string' },
  },
} as const;

/** Builds the API request. The transcript is a RedactedTranscript: nothing else can get here. */
export function buildRequest(
  input: ScoringInput,
  s: ScorerSettings,
  retry?: { previous: Anthropic.Message; error: string },
): Anthropic.MessageCreateParamsNonStreaming {
  const messages: Anthropic.MessageParam[] = [
    {
      role: 'user',
      content: `Recorded channel: ${input.channel}\n\n<transcript>\n${input.transcript}\n</transcript>`,
    },
  ];
  if (retry) {
    messages.push(
      { role: 'assistant', content: retry.previous.content },
      {
        role: 'user',
        content: `Your response failed validation:\n${retry.error}\n\nReturn one corrected JSON object only.`,
      },
    );
  }
  return {
    model: s.model,
    // Room for adaptive thinking plus a small JSON object.
    max_tokens: 16000,
    // The prompt is identical for every interaction, so cache it.
    system: [{ type: 'text', text: s.prompt.text, cache_control: { type: 'ephemeral' } }],
    messages,
    output_config: {
      format: { type: 'json_schema', schema: OUTPUT_JSON_SCHEMA },
      ...(s.effort ? { effort: s.effort } : {}),
    },
  };
}

export function usageOf(m: Anthropic.Message): TokenUsage {
  return {
    inputTokens: m.usage.input_tokens,
    outputTokens: m.usage.output_tokens,
    cacheReadTokens: m.usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: m.usage.cache_creation_input_tokens ?? 0,
  };
}

type Parsed =
  | { ok: true; output: ScorerOutput }
  | { ok: false; reason: 'invalid_output' | 'refusal'; error: string };

/** Validates one response. Error text never includes transcript or output content. */
export function parseResponse(m: Anthropic.Message): Parsed {
  if (m.stop_reason === 'refusal') {
    return {
      ok: false,
      reason: 'refusal',
      error: `refused (${m.stop_details?.category ?? 'no category'})`,
    };
  }
  if (m.stop_reason === 'max_tokens') {
    return { ok: false, reason: 'invalid_output', error: 'Response was cut off at max_tokens.' };
  }
  const text = m.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'invalid_output', error: 'Response was not valid JSON.' };
  }
  const result = ScorerOutputSchema.safeParse(json);
  if (!result.success) {
    // Paths and rule messages only; z.prettifyError doesn't echo input values.
    return { ok: false, reason: 'invalid_output', error: z.prettifyError(result.error) };
  }
  return { ok: true, output: result.data };
}

export type ScoreAttempt =
  | { ok: true; output: ScorerOutput; attempts: number; retried: boolean; usage: TokenUsage }
  | {
      ok: false;
      reason: 'invalid_output' | 'refusal' | 'api_error';
      detail: string;
      attempts: number;
      usage: TokenUsage;
    };

/**
 * Scores one interaction: call, validate, and on invalid output retry once with the
 * validation error included. Retryable API errors back off inside each call.
 * Non-retryable API errors (bad request, auth, unknown model) are thrown: they'd fail
 * every interaction, so the run should stop rather than record thousands of failures.
 */
export async function scoreInteraction(
  client: ScorerClient,
  input: ScoringInput,
  s: ScorerSettings,
): Promise<ScoreAttempt> {
  const call = (params: Anthropic.MessageCreateParamsNonStreaming) =>
    withBackoff(() => client.create(params), s.backoff ?? DEFAULT_BACKOFF);

  let usage = ZERO_USAGE;
  let first: Anthropic.Message;
  try {
    first = await call(buildRequest(input, s));
  } catch (err) {
    return apiFailure(err, 1, usage);
  }
  usage = addUsage(usage, usageOf(first));
  const parsed = parseResponse(first);
  if (parsed.ok) return { ok: true, output: parsed.output, attempts: 1, retried: false, usage };
  if (parsed.reason === 'refusal') {
    return { ok: false, reason: 'refusal', detail: parsed.error, attempts: 1, usage };
  }

  let second: Anthropic.Message;
  try {
    second = await call(buildRequest(input, s, { previous: first, error: parsed.error }));
  } catch (err) {
    return apiFailure(err, 2, usage);
  }
  usage = addUsage(usage, usageOf(second));
  const reparsed = parseResponse(second);
  if (reparsed.ok) return { ok: true, output: reparsed.output, attempts: 2, retried: true, usage };
  return { ok: false, reason: reparsed.reason, detail: reparsed.error, attempts: 2, usage };
}

function apiFailure(err: unknown, attempts: number, usage: TokenUsage): ScoreAttempt {
  // Only retryable errors that exhausted backoff are per-interaction failures. Anything
  // else (400/401/403/404, or a bug) aborts the run.
  if (!isRetryable(err)) throw err;
  const e = err as { status?: number; type?: string | null; name?: string };
  return {
    ok: false,
    reason: 'api_error',
    detail: [e.name ?? 'Error', e.status, e.type].filter(Boolean).join(' '),
    attempts,
    usage,
  };
}
