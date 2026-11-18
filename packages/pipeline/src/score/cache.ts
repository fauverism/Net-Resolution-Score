import { createHash } from 'node:crypto';
import { ScorerOutputSchema, type ScorerOutput } from '@nrs/core';
import type { Db } from '../db.ts';
import type { RedactedTranscript } from '../redact/redact.ts';
import type { ScorerPrompt } from './prompt.ts';

/** hash(transcript + prompt version + prompt content + model). */
export function cacheKey(
  transcript: RedactedTranscript,
  prompt: ScorerPrompt,
  model: string,
): string {
  return createHash('sha256')
    .update(JSON.stringify([prompt.version, prompt.sha256, model, transcript]))
    .digest('hex');
}

export function getCached(db: Db, key: string): ScorerOutput | null {
  const json = db
    .prepare('SELECT output_json FROM score_cache WHERE cache_key = ?')
    .pluck()
    .get(key) as string | undefined;
  if (!json) return null;
  // Re-validate: a stale or hand-edited entry is a cache miss, not trusted output.
  const parsed = ScorerOutputSchema.safeParse(JSON.parse(json));
  return parsed.success ? parsed.data : null;
}

export function putCached(
  db: Db,
  key: string,
  output: ScorerOutput,
  prompt: ScorerPrompt,
  model: string,
  now: Date,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO score_cache (cache_key, model, prompt_version, output_json, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(key, model, prompt.version, JSON.stringify(output), now.toISOString());
}
