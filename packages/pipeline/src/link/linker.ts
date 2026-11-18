import { createHash } from 'node:crypto';
import type Anthropic from '@anthropic-ai/sdk';
import { LinkerOutputSchema, type LinkerOutput, type ReturnCandidate } from '@nrs/core';
import type { RedactedTranscript } from '../redact/redact.ts';
import type { BackoffOptions } from '../score/backoff.ts';
import {
  requestValidated,
  retryMessages,
  type Attempt,
  type Effort,
  type LlmClient,
  type RetryContext,
} from '../score/llm.ts';
import type { ScorerPrompt } from '../score/prompt.ts';

export const DEFAULT_LINKER_PROMPT_VERSION = 'linker.v2';

export interface LinkerSettings {
  /** From ANTHROPIC_MODEL. Never hardcoded. */
  model: string;
  prompt: ScorerPrompt;
  effort?: Effort | undefined;
  backoff?: BackoffOptions;
}

/** A candidate pair plus both transcripts, already redacted. */
export interface LinkPair {
  candidate: ReturnCandidate;
  aTranscript: RedactedTranscript;
  bTranscript: RedactedTranscript;
}

export const LINK_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['same_goal', 'confidence', 'why'],
  properties: {
    same_goal: { type: 'boolean' },
    confidence: { type: 'number' },
    why: { type: 'string' },
  },
} as const;

function pairContent(p: LinkPair): string {
  const { a, b, gapDays } = p.candidate;
  return [
    `Interaction A (earlier): channel ${a.channel}, business line ${a.businessLine}.`,
    `<transcript_a>\n${p.aTranscript}\n</transcript_a>`,
    '',
    `Interaction B: ${gapDays.toFixed(1)} days later, channel ${b.channel}, business line ${b.businessLine}.`,
    `<transcript_b>\n${p.bTranscript}\n</transcript_b>`,
  ].join('\n');
}

/** Only RedactedTranscripts reach this request. */
export function buildLinkRequest(
  p: LinkPair,
  s: LinkerSettings,
  retry?: RetryContext,
): Anthropic.MessageCreateParamsNonStreaming {
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: pairContent(p) }];
  if (retry) messages.push(...retryMessages(retry));
  return {
    model: s.model,
    max_tokens: 16000,
    system: [{ type: 'text', text: s.prompt.text, cache_control: { type: 'ephemeral' } }],
    messages,
    output_config: {
      format: { type: 'json_schema', schema: LINK_JSON_SCHEMA },
      ...(s.effort ? { effort: s.effort } : {}),
    },
  };
}

/** hash(prompt version + prompt content + model + exactly what's sent about the pair). */
export function linkCacheKey(p: LinkPair, s: LinkerSettings): string {
  return createHash('sha256')
    .update(JSON.stringify([s.prompt.version, s.prompt.sha256, s.model, pairContent(p)]))
    .digest('hex');
}

/** Asks the model whether B is about the same goal as A (retries once on invalid output). */
export function judgePair(
  client: LlmClient,
  p: LinkPair,
  s: LinkerSettings,
): Promise<Attempt<LinkerOutput>> {
  return requestValidated(
    client,
    (retry) => buildLinkRequest(p, s, retry),
    LinkerOutputSchema,
    s.backoff,
  );
}
