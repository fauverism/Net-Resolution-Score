import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { DEFAULT_BACKOFF, isRetryable, withBackoff, type BackoffOptions } from './backoff.ts';
import { mapWithConcurrency } from './pool.ts';

const headers = (h: Record<string, string> = {}) => new Headers(h);
const rateLimited = (retryAfter?: string) =>
  new Anthropic.RateLimitError(
    429,
    undefined,
    'rate limited',
    headers(retryAfter ? { 'retry-after': retryAfter } : {}),
  );
const overloaded = () => new Anthropic.InternalServerError(529, undefined, 'overloaded', headers());
const badRequest = () => new Anthropic.BadRequestError(400, undefined, 'bad', headers());

function opts(over: Partial<BackoffOptions> = {}) {
  const sleeps: number[] = [];
  return {
    sleeps,
    o: {
      ...DEFAULT_BACKOFF,
      random: () => 1,
      sleep: async (ms: number) => void sleeps.push(ms),
      ...over,
    },
  };
}

describe('isRetryable', () => {
  it('retries 429, 529, 5xx and connection errors only', () => {
    expect(isRetryable(rateLimited())).toBe(true);
    expect(isRetryable(overloaded())).toBe(true);
    expect(isRetryable(new Anthropic.APIConnectionError({ message: 'reset' }))).toBe(true);
    expect(isRetryable(badRequest())).toBe(false);
    expect(isRetryable(new Error('bug'))).toBe(false);
  });
});

describe('withBackoff', () => {
  it('backs off exponentially on 429/529 and then succeeds', async () => {
    const { o, sleeps } = opts();
    const errors = [rateLimited(), overloaded(), overloaded()];
    let calls = 0;
    const result = await withBackoff(async () => {
      calls++;
      const e = errors.shift();
      if (e) throw e;
      return 'ok';
    }, o);
    expect(result).toBe('ok');
    expect(calls).toBe(4);
    expect(sleeps).toEqual([1000, 2000, 4000]);
  });

  it('honors retry-after', async () => {
    const { o, sleeps } = opts();
    let first = true;
    await withBackoff(async () => {
      if (first) {
        first = false;
        throw rateLimited('7');
      }
      return 'ok';
    }, o);
    expect(sleeps).toEqual([7000]);
  });

  it('caps the delay', async () => {
    const { o, sleeps } = opts({ maxAttempts: 10, maxMs: 5000 });
    let n = 0;
    await withBackoff(async () => {
      if (n++ < 6) throw overloaded();
      return 'ok';
    }, o);
    expect(Math.max(...sleeps)).toBe(5000);
  });

  it('gives up after maxAttempts', async () => {
    const { o } = opts({ maxAttempts: 3 });
    let calls = 0;
    await expect(
      withBackoff(async () => {
        calls++;
        throw rateLimited();
      }, o),
    ).rejects.toBeInstanceOf(Anthropic.RateLimitError);
    expect(calls).toBe(3);
  });

  it('does not retry a bad request', async () => {
    const { o, sleeps } = opts();
    await expect(withBackoff(async () => Promise.reject(badRequest()), o)).rejects.toBeInstanceOf(
      Anthropic.BadRequestError,
    );
    expect(sleeps).toEqual([]);
  });
});

describe('mapWithConcurrency', () => {
  it('never exceeds the limit and keeps order', async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7], 3, async (x) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return x * 2;
    });
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14]);
    expect(peak).toBe(3);
  });

  it('stops starting new work after a failure and rethrows it', async () => {
    const started: number[] = [];
    await expect(
      mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async (x) => {
        started.push(x);
        if (x === 2) throw new Error('boom');
        await new Promise((r) => setTimeout(r, 5));
      }),
    ).rejects.toThrow('boom');
    expect(started.length).toBeLessThan(6);
  });
});
