import type Anthropic from '@anthropic-ai/sdk';
import type { TokenUsage } from '@nrs/core';
import { z } from 'zod';
import { DEFAULT_BACKOFF, isRetryable, withBackoff, type BackoffOptions } from './backoff.ts';
import { addUsage, ZERO_USAGE } from './pricing.ts';

/** The one SDK call the pipeline makes. Tests pass a fake. */
export interface LlmClient {
  create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
}

export function anthropicClient(client: Anthropic): LlmClient {
  return { create: (params) => client.messages.create(params) };
}

export type Effort = NonNullable<Anthropic.OutputConfig['effort']>;

export function usageOf(m: Anthropic.Message): TokenUsage {
  return {
    inputTokens: m.usage.input_tokens,
    outputTokens: m.usage.output_tokens,
    cacheReadTokens: m.usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: m.usage.cache_creation_input_tokens ?? 0,
  };
}

export type Parsed<T> =
  { ok: true; output: T } | { ok: false; reason: 'invalid_output' | 'refusal'; error: string };

/** Validates one JSON response. Error text never includes transcript or output content. */
export function parseJsonResponse<T>(m: Anthropic.Message, schema: z.ZodType<T>): Parsed<T> {
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
  const result = schema.safeParse(json);
  if (!result.success) {
    // Paths and rule messages only; z.prettifyError doesn't echo input values.
    return { ok: false, reason: 'invalid_output', error: z.prettifyError(result.error) };
  }
  return { ok: true, output: result.data };
}

export type Attempt<T> =
  | { ok: true; output: T; attempts: number; retried: boolean; usage: TokenUsage }
  | {
      ok: false;
      reason: 'invalid_output' | 'refusal' | 'api_error';
      detail: string;
      attempts: number;
      usage: TokenUsage;
    };

export type RetryContext = { previous: Anthropic.Message; error: string };

/** The follow-up turns that ask the model to fix an invalid response. */
export function retryMessages(retry: RetryContext): Anthropic.MessageParam[] {
  return [
    { role: 'assistant', content: retry.previous.content },
    {
      role: 'user',
      content: `Your response failed validation:\n${retry.error}\n\nReturn one corrected JSON object only.`,
    },
  ];
}

/**
 * Call, validate with Zod, and on invalid output retry once with the validation error.
 * Retryable API errors back off inside each call. Non-retryable ones (bad request, auth,
 * unknown model, or a bug) are thrown: they'd fail every item, so the run should stop.
 */
export async function requestValidated<T>(
  client: LlmClient,
  build: (retry?: RetryContext) => Anthropic.MessageCreateParamsNonStreaming,
  schema: z.ZodType<T>,
  backoff: BackoffOptions = DEFAULT_BACKOFF,
): Promise<Attempt<T>> {
  const call = (params: Anthropic.MessageCreateParamsNonStreaming) =>
    withBackoff(() => client.create(params), backoff);

  let usage = ZERO_USAGE;
  let first: Anthropic.Message;
  try {
    first = await call(build());
  } catch (err) {
    return apiFailure(err, 1, usage);
  }
  usage = addUsage(usage, usageOf(first));
  const parsed = parseJsonResponse(first, schema);
  if (parsed.ok) return { ok: true, output: parsed.output, attempts: 1, retried: false, usage };
  if (parsed.reason === 'refusal') {
    return { ok: false, reason: 'refusal', detail: parsed.error, attempts: 1, usage };
  }

  let second: Anthropic.Message;
  try {
    second = await call(build({ previous: first, error: parsed.error }));
  } catch (err) {
    return apiFailure(err, 2, usage);
  }
  usage = addUsage(usage, usageOf(second));
  const reparsed = parseJsonResponse(second, schema);
  if (reparsed.ok) return { ok: true, output: reparsed.output, attempts: 2, retried: true, usage };
  return { ok: false, reason: reparsed.reason, detail: reparsed.error, attempts: 2, usage };
}

function apiFailure<T>(err: unknown, attempts: number, usage: TokenUsage): Attempt<T> {
  // Only retryable errors that exhausted backoff are per-item failures.
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
