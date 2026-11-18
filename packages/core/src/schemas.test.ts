import { describe, expect, it } from 'vitest';
import { CategorySchema, ChannelSchema, InteractionSchema, SurveyResponseSchema } from './index.ts';

describe('core schemas', () => {
  it('accepts exactly the three channels', () => {
    expect(ChannelSchema.options).toEqual(['ai_agent', 'human', 'hybrid']);
    expect(ChannelSchema.safeParse('email').success).toBe(false);
  });

  it('orders categories lowest to highest', () => {
    expect(CategorySchema.options).toEqual(['detractor', 'passive', 'promoter']);
  });

  it('parses a well-formed interaction', () => {
    const parsed = InteractionSchema.parse({
      id: 'i1',
      customerId: 'c1',
      channel: 'ai_agent',
      startedAt: '2026-11-01T10:00:00Z',
      transcript: '',
      businessLine: 'billing',
    });
    expect(parsed.channel).toBe('ai_agent');
  });

  it('rejects an out-of-range NPS score', () => {
    expect(
      SurveyResponseSchema.safeParse({
        customerId: 'c1',
        npsScore: 11,
        respondedAt: '2026-11-01T10:00:00Z',
      }).success,
    ).toBe(false);
  });
});
