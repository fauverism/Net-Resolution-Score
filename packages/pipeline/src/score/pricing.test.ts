import { describe, expect, it } from 'vitest';
import { addUsage, estimateCostUsd, ZERO_USAGE } from './pricing.ts';

describe('estimateCostUsd', () => {
  it('prices input, output, cache reads and cache writes', () => {
    const usage = {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
    };
    // Opus 5.5: $4 in, $20 out, $0.20 cache read, 1.25 × $4 cache write
    expect(estimateCostUsd('claude-opus-5-5', usage)).toBeCloseTo(4 + 20 + 0.2 + 5, 6);
  });

  it('defaults cache reads to 10% of input when unlisted', () => {
    const usage = { ...ZERO_USAGE, cacheReadTokens: 1_000_000 };
    expect(estimateCostUsd('claude-opus-4-8', usage)).toBeCloseTo(0.5, 6);
  });

  it('returns null for an unknown model rather than guessing', () => {
    expect(estimateCostUsd('some-new-model', ZERO_USAGE)).toBeNull();
  });
});

describe('addUsage', () => {
  it('adds field by field', () => {
    const u = { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 };
    expect(addUsage(u, u)).toEqual({
      inputTokens: 2,
      outputTokens: 4,
      cacheReadTokens: 6,
      cacheWriteTokens: 8,
    });
  });
});
