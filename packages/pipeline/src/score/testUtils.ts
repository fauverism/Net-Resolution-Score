import type Anthropic from '@anthropic-ai/sdk';
import type { ScorerOutput } from '@nrs/core';
import type { ScorerClient } from './scorer.ts';

/** A minimal Message, enough for the scorer. Test-only. */
export function fakeMessage(
  text: string,
  over: Partial<Pick<Anthropic.Message, 'stop_reason' | 'stop_details'>> = {},
): Anthropic.Message {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'test-model',
    content: [{ type: 'text', text, citations: null }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    stop_details: null,
    usage: {
      input_tokens: 1000,
      output_tokens: 200,
      cache_read_input_tokens: 800,
      cache_creation_input_tokens: 0,
    },
    ...over,
  } as unknown as Anthropic.Message;
}

export const validOutput = (over: Partial<ScorerOutput> = {}): ScorerOutput => ({
  channel: 'ai_agent',
  customer_goal: 'reset password',
  resolved: 'yes',
  effort: 1,
  sentiment_start: -1,
  sentiment_end: 1,
  asked_for_human: false,
  abandoned: false,
  category: 'promoter',
  evidence: 'It works now',
  ...over,
});

/** Records every request and answers with `respond`. Tracks peak concurrency. */
export function fakeClient(
  respond: (
    params: Anthropic.MessageCreateParamsNonStreaming,
    call: number,
  ) => Anthropic.Message | Error,
  delayMs = 0,
): ScorerClient & { calls: Anthropic.MessageCreateParamsNonStreaming[]; peak: number } {
  let inFlight = 0;
  const fake = {
    calls: [] as Anthropic.MessageCreateParamsNonStreaming[],
    peak: 0,
    async create(params: Anthropic.MessageCreateParamsNonStreaming) {
      const call = fake.calls.push(params); // this call's 1-based index, fixed before awaiting
      inFlight++;
      fake.peak = Math.max(fake.peak, inFlight);
      try {
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
        const res = respond(params, call);
        if (res instanceof Error) throw res;
        return res;
      } finally {
        inFlight--;
      }
    },
  };
  return fake;
}

/** The transcript as sent in the first user message. */
export function sentTranscript(params: Anthropic.MessageCreateParamsNonStreaming): string {
  const first = params.messages[0]!.content;
  const text = typeof first === 'string' ? first : '';
  return text.split('<transcript>\n')[1]!.split('\n</transcript>')[0]!;
}
