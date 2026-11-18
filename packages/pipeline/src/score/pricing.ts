import type { TokenUsage } from '@nrs/core';

/**
 * USD per million tokens, first-party Claude API list prices (snapshot 2026-11-03).
 * Estimates only: check current pricing before relying on these for billing.
 */
interface Price {
  input: number;
  output: number;
  /** Cache read price; defaults to 10% of input when not listed. */
  cacheRead?: number;
}

const PRICES: Record<string, Price> = {
  'claude-fable-5-2': { input: 8, output: 40, cacheRead: 0.2 },
  'claude-mythos-5-2': { input: 8, output: 40, cacheRead: 0.2 },
  'claude-fable-5-1': { input: 10, output: 50 },
  'claude-mythos-5-1': { input: 10, output: 50 },
  'claude-fable-5': { input: 10, output: 50 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
  'claude-haiku-4-5': { input: 1, output: 5 },
};

/** 5-minute cache writes cost 1.25× base input. */
const CACHE_WRITE_MULTIPLIER = 1.25;

/** Estimated USD cost, or null when the model isn't in the price table. */
export function estimateCostUsd(model: string, u: TokenUsage): number | null {
  const p = PRICES[model];
  if (!p) return null;
  const cacheRead = p.cacheRead ?? p.input * 0.1;
  return (
    (u.inputTokens * p.input +
      u.cacheWriteTokens * p.input * CACHE_WRITE_MULTIPLIER +
      u.cacheReadTokens * cacheRead +
      u.outputTokens * p.output) /
    1_000_000
  );
}

export const ZERO_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}
