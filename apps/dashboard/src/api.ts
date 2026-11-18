import { useEffect, useState } from 'react';
import type { z } from 'zod';

export type Load<T> =
  { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; data: T };

/**
 * Fetches `url` and validates the JSON with `schema` (the API boundary is checked on both
 * sides). Shows "loading" whenever the URL changes; stale responses are dropped.
 */
export function useApi<T>(url: string, schema: z.ZodType<T>): Load<T> {
  const [result, setResult] = useState<{ url: string; load: Load<T> } | null>(null);
  useEffect(() => {
    const ctrl = new AbortController();
    fetch(url, { signal: ctrl.signal })
      .then(async (res) => {
        const body: unknown = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(
            (body as { error?: string }).error ?? `The server answered ${res.status}.`,
          );
        }
        const parsed = schema.safeParse(body);
        if (!parsed.success) throw new Error('The server sent data in an unexpected shape.');
        setResult({ url, load: { state: 'ready', data: parsed.data } });
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        setResult({
          url,
          load: { state: 'error', message: err instanceof Error ? err.message : String(err) },
        });
      });
    return () => ctrl.abort();
  }, [url, schema]);
  return result?.url === url ? result.load : { state: 'loading' };
}

export function apiUrl(path: string, params: Record<string, string | number | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) p.set(k, String(v));
  return `/api/${path}?${p}`;
}
