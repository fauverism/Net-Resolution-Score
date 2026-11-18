import Anthropic from '@anthropic-ai/sdk';
import { ScorerOutputSchema } from '@nrs/core';
import { describe, expect, it } from 'vitest';
import { redact } from '../redact/redact.ts';
import { DEFAULT_BACKOFF } from './backoff.ts';
import type { ScoringInput } from './inputs.ts';
import { loadPrompt } from './prompt.ts';
import {
  buildRequest,
  OUTPUT_JSON_SCHEMA,
  parseResponse,
  scoreInteraction,
  type ScorerSettings,
} from './scorer.ts';
import { fakeClient, fakeMessage, validOutput } from './testUtils.ts';

const input: ScoringInput = {
  interactionId: 'int_00001',
  channel: 'ai_agent',
  businessLine: 'tech_support',
  startedAt: '2026-11-01T10:00:00.000Z',
  transcript: redact('Customer: Hi, I am Maria Garcia. It works now.\nAgent: Great!').text,
};
const settings: ScorerSettings = {
  model: 'test-model',
  prompt: loadPrompt(),
  backoff: { ...DEFAULT_BACKOFF, sleep: async () => {} },
};

describe('prompt', () => {
  it('is versioned and hashed', () => {
    const p = loadPrompt('scorer.v1');
    expect(p.version).toBe('scorer.v1');
    expect(p.text).toContain('You are scoring one customer interaction');
    expect(p.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects path-like versions', () => {
    expect(() => loadPrompt('../secrets')).toThrow(/Invalid prompt version/);
  });

  it('names the missing file for an unknown version', () => {
    expect(() => loadPrompt('scorer.v999')).toThrow(/prompts\/scorer\.v999\.md/);
  });
});

describe('OUTPUT_JSON_SCHEMA', () => {
  it('has exactly the Zod schema fields, all required, no extras allowed', () => {
    const zodKeys = Object.keys(ScorerOutputSchema.shape).sort();
    expect(Object.keys(OUTPUT_JSON_SCHEMA.properties).sort()).toEqual(zodKeys);
    expect([...OUTPUT_JSON_SCHEMA.required].sort()).toEqual(zodKeys);
    expect(OUTPUT_JSON_SCHEMA.additionalProperties).toBe(false);
  });
});

describe('buildRequest', () => {
  const req = buildRequest(input, settings);

  it('uses the configured model and caches the prompt', () => {
    expect(req.model).toBe('test-model');
    expect(req.system).toEqual([
      { type: 'text', text: settings.prompt.text, cache_control: { type: 'ephemeral' } },
    ]);
  });

  it('sends only the redacted transcript, marked as data', () => {
    const body = JSON.stringify(req);
    expect(body).not.toContain('Maria');
    expect(body).toContain('[NAME]');
    expect(body).toContain('<transcript>');
  });

  it('asks for structured JSON output and no sampling parameters', () => {
    expect(req.output_config?.format).toEqual({ type: 'json_schema', schema: OUTPUT_JSON_SCHEMA });
    expect(req).not.toHaveProperty('temperature');
    expect(req.output_config).not.toHaveProperty('effort');
  });

  it('passes effort through only when set', () => {
    expect(buildRequest(input, { ...settings, effort: 'low' }).output_config?.effort).toBe('low');
  });

  it('includes the validation error on a retry', () => {
    const previous = fakeMessage('{"oops": true}');
    const retry = buildRequest(input, settings, { previous, error: 'missing evidence' });
    expect(retry.messages).toHaveLength(3);
    expect(retry.messages[1]).toEqual({ role: 'assistant', content: previous.content });
    expect(JSON.stringify(retry.messages[2])).toContain('missing evidence');
  });
});

describe('parseResponse', () => {
  it('accepts valid output', () => {
    expect(parseResponse(fakeMessage(JSON.stringify(validOutput())))).toEqual({
      ok: true,
      output: validOutput(),
    });
  });

  it.each([
    ['not JSON', 'here you go: {'],
    ['out-of-range effort', JSON.stringify(validOutput({ effort: 4 }))],
    ['unknown category', JSON.stringify({ ...validOutput(), category: 'fan' })],
    ['extra field', JSON.stringify({ ...validOutput(), confidence: 0.9 })],
    ['missing field', JSON.stringify({ ...validOutput(), evidence: undefined })],
  ])('rejects %s', (_, text) => {
    const r = parseResponse(fakeMessage(text));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('invalid_output');
  });

  it('never echoes output content in the error', () => {
    const r = parseResponse(
      fakeMessage(JSON.stringify(validOutput({ evidence: '', customer_goal: 'SECRET-GOAL' }))),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).not.toContain('SECRET-GOAL');
  });

  it('treats truncation as invalid and refusal as refusal', () => {
    expect(parseResponse(fakeMessage('{', { stop_reason: 'max_tokens' }))).toMatchObject({
      reason: 'invalid_output',
    });
    expect(parseResponse(fakeMessage('', { stop_reason: 'refusal' }))).toMatchObject({
      reason: 'refusal',
    });
  });
});

describe('scoreInteraction', () => {
  it('scores in one call when the output is valid', async () => {
    const client = fakeClient(() => fakeMessage(JSON.stringify(validOutput())));
    const r = await scoreInteraction(client, input, settings);
    expect(r).toMatchObject({ ok: true, attempts: 1, retried: false });
    expect(client.calls).toHaveLength(1);
  });

  it('retries once with the validation error, then succeeds', async () => {
    const client = fakeClient((_, n) =>
      fakeMessage(
        n === 1 ? JSON.stringify(validOutput({ effort: 9 })) : JSON.stringify(validOutput()),
      ),
    );
    const r = await scoreInteraction(client, input, settings);
    expect(r).toMatchObject({ ok: true, attempts: 2, retried: true });
    expect(JSON.stringify(client.calls[1]!.messages[2])).toContain('effort');
    expect(r.usage.inputTokens).toBe(2000); // both calls counted
  });

  it('marks score_failed after a second invalid response', async () => {
    const client = fakeClient(() => fakeMessage('nope'));
    const r = await scoreInteraction(client, input, settings);
    expect(r).toMatchObject({ ok: false, reason: 'invalid_output', attempts: 2 });
    expect(client.calls).toHaveLength(2);
  });

  it('does not retry a refusal', async () => {
    const client = fakeClient(() => fakeMessage('', { stop_reason: 'refusal' }));
    expect(await scoreInteraction(client, input, settings)).toMatchObject({
      ok: false,
      reason: 'refusal',
      attempts: 1,
    });
  });

  it('backs off through 429 and 529', async () => {
    const client = fakeClient((_, n) =>
      n === 1
        ? new Anthropic.RateLimitError(429, undefined, 'slow down', new Headers())
        : n === 2
          ? new Anthropic.InternalServerError(529, undefined, 'overloaded', new Headers())
          : fakeMessage(JSON.stringify(validOutput())),
    );
    expect(await scoreInteraction(client, input, settings)).toMatchObject({ ok: true });
    expect(client.calls).toHaveLength(3);
  });

  it('records api_error when backoff is exhausted', async () => {
    const client = fakeClient(
      () => new Anthropic.InternalServerError(529, undefined, 'overloaded', new Headers()),
    );
    const r = await scoreInteraction(client, input, {
      ...settings,
      backoff: { ...settings.backoff!, maxAttempts: 2 },
    });
    expect(r).toMatchObject({ ok: false, reason: 'api_error' });
  });

  it('aborts on a non-retryable error such as a bad request', async () => {
    const client = fakeClient(
      () => new Anthropic.BadRequestError(400, undefined, 'bad model', new Headers()),
    );
    await expect(scoreInteraction(client, input, settings)).rejects.toBeInstanceOf(
      Anthropic.BadRequestError,
    );
  });
});
