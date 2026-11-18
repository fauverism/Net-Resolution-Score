import Anthropic from '@anthropic-ai/sdk';

export interface BackoffOptions {
  maxAttempts: number;
  baseMs: number;
  maxMs: number;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
  onRetry?: (info: { attempt: number; delayMs: number; status: number | undefined }) => void;
}

export const DEFAULT_BACKOFF: BackoffOptions = {
  maxAttempts: 6,
  baseMs: 1000,
  maxMs: 60_000,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  random: Math.random,
};

/** 429 rate limit, 529 overloaded, other 5xx, and dropped connections. */
export function isRetryable(err: unknown): boolean {
  if (err instanceof Anthropic.APIConnectionError) return true;
  if (!(err instanceof Anthropic.APIError)) return false;
  const status = err.status ?? 0;
  return status === 429 || status === 529 || status >= 500;
}

function retryAfterMs(err: unknown): number | null {
  if (!(err instanceof Anthropic.APIError)) return null;
  const header = err.headers?.get('retry-after');
  const seconds = header ? Number(header) : NaN;
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
}

/**
 * Exponential backoff with jitter on retryable API errors, honoring `retry-after`.
 * Non-retryable errors (400, 401, 403, 404…) are rethrown immediately.
 */
export async function withBackoff<T>(
  fn: () => Promise<T>,
  opts: BackoffOptions = DEFAULT_BACKOFF,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isRetryable(err) || attempt >= opts.maxAttempts) throw err;
      const exp = Math.min(opts.maxMs, opts.baseMs * 2 ** (attempt - 1));
      const delayMs = Math.min(opts.maxMs, retryAfterMs(err) ?? exp * (0.5 + opts.random() / 2));
      opts.onRetry?.({
        attempt,
        delayMs,
        status: (err as InstanceType<typeof Anthropic.APIError>).status,
      });
      await opts.sleep(delayMs);
    }
  }
}
