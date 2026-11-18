import type Anthropic from '@anthropic-ai/sdk';
import { CategorySchema, CHANNELS, ScorerOutputSchema, type ScorerOutput } from '@nrs/core';
import type { BackoffOptions } from './backoff.ts';
import type { ScoringInput } from './inputs.ts';
import {
  anthropicClient,
  parseJsonResponse,
  requestValidated,
  retryMessages,
  type Attempt,
  type Effort,
  type LlmClient,
  type Parsed,
  type RetryContext,
} from './llm.ts';
import type { ScorerPrompt } from './prompt.ts';

export { usageOf, type Effort } from './llm.ts';

/** The one SDK call the scorer makes. Tests pass a fake. */
export type ScorerClient = LlmClient;
export const anthropicScorerClient = anthropicClient;

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
  retry?: RetryContext,
): Anthropic.MessageCreateParamsNonStreaming {
  const messages: Anthropic.MessageParam[] = [
    {
      role: 'user',
      content: `Recorded channel: ${input.channel}\n\n<transcript>\n${input.transcript}\n</transcript>`,
    },
  ];
  if (retry) messages.push(...retryMessages(retry));
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

/** Validates one scorer response. */
export function parseResponse(m: Anthropic.Message): Parsed<ScorerOutput> {
  return parseJsonResponse(m, ScorerOutputSchema);
}

export type ScoreAttempt = Attempt<ScorerOutput>;

/** Scores one interaction, retrying once on invalid output (see requestValidated). */
export function scoreInteraction(
  client: ScorerClient,
  input: ScoringInput,
  s: ScorerSettings,
): Promise<ScoreAttempt> {
  return requestValidated(
    client,
    (retry) => buildRequest(input, s, retry),
    ScorerOutputSchema,
    s.backoff,
  );
}
